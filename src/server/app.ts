import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createMiddleware } from "hono/factory";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { auth, type SessionUser } from "./auth.ts";
import { orgDb, prisma } from "./db.ts";
import { setupRoutes } from "./setup.ts";
import { appearanceRoutes, companyRoutes, logoRoutes, publicBrandingRoutes } from "./branding.ts";
import { env, isDemoMode } from "./env.ts";
import { DEMO_BLOCKED_AUTH_PATHS, demoRoutes } from "./demo.ts";
import type { SignedIn } from "./http.ts";
import { canManageWork } from "../shared/roles.ts";
import { clientRoutes } from "./clients.ts";
import { projectRoutes } from "./projects.ts";
import { timeEntryRoutes, timerRoutes } from "./time.ts";
import { inviteRoutes, peopleRoutes } from "./people.ts";
import { taskRoutes } from "./tasks.ts";
import { expenseRoutes } from "./expenses.ts";
import { reportRoutes } from "./reports.ts";
import { invoiceRoutes } from "./invoices.ts";
import { importExportRoutes } from "./importExport.ts";
import { securityRoutes } from "./security.ts";
import { ssoSettingsRoutes } from "./ssoSettings.ts";
import { timeOffRoutes, timeOffSettingsRoutes } from "./timeOff.ts";
import { clientIp, headersWithClientIp, limitKey } from "./clientIp.ts";
import { changePasswordAttemptsPerIp, signInAttemptsPerIp, signInFailuresPerEmail, TOO_MANY_ATTEMPTS_1_MIN, TOO_MANY_FOR_ACCOUNT, TOO_MANY_SIGN_INS } from "./rateLimit.ts";
import { passwordResetRoutes } from "./passwordReset.ts";
import { emailSettingsRoutes } from "./emailSettings.ts";
import { invoiceSettingsRoutes } from "./invoiceSettings.ts";
import { historyRoutes } from "./audit.ts";
import { timesheetRoutes, timesheetSettingsRoutes } from "./timesheets.ts";
import { teamRoutes } from "./team.ts";
import { scheduleRoutes } from "./schedule.ts";
import { commonTaskRoutes } from "./commonTasks.ts";
import { projectTemplateRoutes } from "./projectTemplates.ts";
import { calendarRoutes } from "./calendarImport.ts";
import { twoFactorRoutes } from "./twoFactor.ts";
import { customFieldRoutes } from "./customFields.ts";
import { groupRoutes } from "./groups.ts";
import { maxReceiptBytes, RECEIPT_PATH, receiptRoutes, receiptTooLarge } from "./receipts.ts";
import { backupRoutes } from "./backup.ts";
import { aboutRoutes } from "./about.ts";
import { paymentSettingsRoutes, paymentWebhookRoutes, payRoutes } from "./payments.ts";
import { describeError } from "./logging.ts";

// Auth requests that are slowed down per address, before Better Auth sees them.
const THROTTLED_AUTH_PATHS: Record<string, { limiter: typeof signInAttemptsPerIp; message: string }> = {
  "/api/auth/sign-in/email": { limiter: signInAttemptsPerIp, message: TOO_MANY_SIGN_INS },
  "/api/auth/change-password": { limiter: changePasswordAttemptsPerIp, message: TOO_MANY_ATTEMPTS_1_MIN },
  // Two-factor codes (WRK-147) are limited like passwords.
  "/api/auth/two-factor/verify-totp": { limiter: signInAttemptsPerIp, message: TOO_MANY_SIGN_INS },
  "/api/auth/two-factor/verify-backup-code": { limiter: signInAttemptsPerIp, message: TOO_MANY_SIGN_INS },
  "/api/auth/two-factor/enable": { limiter: changePasswordAttemptsPerIp, message: TOO_MANY_ATTEMPTS_1_MIN },
  "/api/auth/two-factor/disable": { limiter: changePasswordAttemptsPerIp, message: TOO_MANY_ATTEMPTS_1_MIN },
  "/api/auth/two-factor/generate-backup-codes": { limiter: changePasswordAttemptsPerIp, message: TOO_MANY_ATTEMPTS_1_MIN },
};

/**
 * The email a password sign-in is for, as Better Auth will read it: from a JSON body or a form
 * (it accepts both). Null when there's none, and then the sign-in is refused before it runs,
 * so no try escapes the per-account count.
 */
async function signInEmail(request: Request): Promise<string | null> {
  try {
    const type = request.headers.get("content-type") ?? "";
    const email = type.includes("application/json")
      ? ((await request.clone().json()) as { email?: unknown }).email
      : type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")
        ? (await request.clone().formData()).get("email")
        : null;
    return typeof email === "string" && email.trim() ? email.trim().toLowerCase().slice(0, 254) : null;
  } catch {
    return null;
  }
}

export const TWO_FACTOR_REQUIRED = "Set up two-factor sign-in first. Your organization requires it.";

// Every route after this gets the signed-in person and a database client that
// can only reach their organization's rows.
const requireSession = createMiddleware<SignedIn>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session || session.user.deactivatedAt) return c.json({ error: "Sign in first." }, 401);
  const user = session.user as SessionUser;
  // An organization that requires two-factor sign-in (WRK-147): someone who signed in with a
  // password and hasn't set it up can only see who they are until they do. Single sign-on's
  // provider handles its own second step.
  if (!session.user.twoFactorEnabled && !session.session.viaSso && c.req.path !== "/api/me") {
    const org = await prisma.organization.findUnique({ where: { id: user.organizationId }, select: { requireTwoFactor: true } });
    if (org?.requireTwoFactor) return c.json({ error: TWO_FACTOR_REQUIRED, code: "two-factor-required" }, 403);
  }
  c.set("user", user);
  c.set("db", orgDb(user.organizationId));
  await next();
});

const api = new Hono<SignedIn>()
  // For the host's health check: the app is up and can reach its database.
  .get("/health", async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "The database can't be reached." }, 503);
    }
  })
  .on(["GET", "POST"], "/auth/*", async (c) => {
    if (isDemoMode() && DEMO_BLOCKED_AUTH_PATHS.includes(c.req.path)) {
      return c.json({ error: "This isn't available in the demo." }, 403);
    }
    const throttle = THROTTLED_AUTH_PATHS[c.req.path];
    const ip = limitKey(clientIp(c));
    // Every try is counted before it runs, so many at once can't slip past the limit; one that
    // succeeds is taken back, so only failed tries use up an address's allowance.
    if (throttle && !throttle.limiter.hit(ip)) return c.json({ error: throttle.message }, 429);
    // Password guesses are counted per account too, so changing addresses doesn't help.
    const passwordSignIn = c.req.path === "/api/auth/sign-in/email" && c.req.method === "POST";
    const account = passwordSignIn ? await signInEmail(c.req.raw) : null;
    if (passwordSignIn && !account) {
      throttle?.limiter.refund(ip);
      return c.json({ error: "Enter your email address." }, 400);
    }
    if (account && !signInFailuresPerEmail.hit(account)) {
      throttle?.limiter.refund(ip);
      return c.json({ error: TOO_MANY_FOR_ACCOUNT }, 429);
    }
    const response = await auth.handler(new Request(c.req.raw, { headers: headersWithClientIp(c) }));
    if (throttle && response.ok) throttle.limiter.refund(ip);
    if (account && response.ok) signInFailuresPerEmail.refund(account);
    return response;
  })
  .route("/demo", demoRoutes)
  .route("/setup", setupRoutes)
  .route("/branding", publicBrandingRoutes)
  .route("/invites", inviteRoutes)
  .route("/password-reset", passwordResetRoutes)
  // Stripe's notifications: checked by signature, then they only prompt a check with Stripe.
  .route("/payments", paymentWebhookRoutes)
  // Everything below needs a signed-in person. A new route is private by default; to make
  // one public, list it above this line (and in tests/routeAccess.test.ts).
  .use("*", requireSession)
  .get("/me", async (c) => {
    const user = c.get("user");
    const { logo, ...organization } = await c.get("db").organization.findFirstOrThrow({
      select: {
        id: true,
        name: true,
        appName: true,
        currency: true,
        address: true,
        accentColor: true,
        colorMode: true,
        demoExpiresAt: true,
        timesheetApprovals: true,
        requireTwoFactor: true,
        logo: { select: { updatedAt: true } },
      },
    });
    // The week's expected hours, shown against the person's own timesheet.
    const { weeklyCapacity, twoFactorEnabled, accounts } = await c.get("db").user.findUniqueOrThrow({
      where: { id: user.id },
      select: { weeklyCapacity: true, twoFactorEnabled: true, accounts: { where: { providerId: "credential" }, select: { id: true }, take: 1 } },
    });
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const viaSso = session?.session.viaSso === true;
    return c.json({
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role, weeklyCapacity,
        // Two-factor sign-in (WRK-147). Someone who signs in through single sign-on isn't asked.
        twoFactor: { enabled: twoFactorEnabled, hasPassword: accounts.length > 0, viaSso, mustSetUp: organization.requireTwoFactor && !twoFactorEnabled && !viaSso },
      },
      organization: { ...organization, logoVersion: logo?.updatedAt.getTime() ?? null },
    });
  })
  .get("/members", async (c) => {
    const rows = await c.get("db").user.findMany({
      select: { id: true, name: true, email: true, role: true, deactivatedAt: true },
      orderBy: { createdAt: "asc" },
    });
    const members = rows.map(({ deactivatedAt, ...m }) => ({ ...m, active: deactivatedAt === null }));
    // Members see their colleagues' names, not their email addresses or roles.
    if (!canManageWork(c.get("user").role)) return c.json({ members: members.map(({ id, name, active }) => ({ id, name, active })) });
    return c.json({ members });
  })
  .route("/logo", logoRoutes)
  .route("/settings/appearance", appearanceRoutes)
  .route("/settings/company", companyRoutes)
  .route("/settings/security", securityRoutes)
  .route("/settings/email", emailSettingsRoutes)
  .route("/settings/invoices", invoiceSettingsRoutes)
  .route("/settings/timesheets", timesheetSettingsRoutes)
  .route("/settings/backup", backupRoutes)
  .route("/settings/payments", paymentSettingsRoutes)
  .route("/settings/sso", ssoSettingsRoutes)
  .route("/settings/time-off", timeOffSettingsRoutes)
  .route("/settings/about", aboutRoutes)
  .route("/clients", clientRoutes)
  .route("/projects", projectRoutes)
  .route("/time-entries", timeEntryRoutes)
  .route("/timer", timerRoutes)
  .route("/data", importExportRoutes)
  .route("/invoices", invoiceRoutes)
  .route("/reports", reportRoutes)
  .route("/expenses", expenseRoutes)
  .route("/expenses", receiptRoutes)
  .route("/tasks", taskRoutes)
  .route("/common-tasks", commonTaskRoutes)
  .route("/project-templates", projectTemplateRoutes)
  .route("/calendar", calendarRoutes)
  .route("/two-factor", twoFactorRoutes)
  .route("/custom-fields", customFieldRoutes)
  .route("/groups", groupRoutes)
  .route("/people", peopleRoutes)
  .route("/timesheets", timesheetRoutes)
  .route("/team", teamRoutes)
  .route("/schedule", scheduleRoutes)
  .route("/time-off", timeOffRoutes)
  .route("/history", historyRoutes)
  .all("*", (c) => c.json({ error: "Not found." }, 404));

/** True when any text in a parsed JSON value contains a NUL character. */
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => k.includes("\u0000") || hasNul(v));
  return false;
}

export function createApp() {
  const app = new Hono();
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        // The app never sets a <base>, so one injected into a page can't redirect its links.
        baseUri: ["'none'"],
      },
      // Browser features the app never uses stay off for its pages.
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [], serial: [], bluetooth: [] },
    }),
  );
  // Behind a host's HTTPS proxy the server sees http://, so compare against the public address.
  app.use("/api/*", csrf({ origin: new URL(env.baseUrl).origin, secFetchSite: "same-origin" }));
  // Requests are small, except a receipt being uploaded and a backup being restored
  // (which is streamed, never held in memory whole).
  const smallBodies = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "Request too large." }, 413) });
  // A logo may be 1 MB: its upload gets a little room, so one just over the limit gets the logo's own message.
  const logoBodies = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "That file is over 1 MB. Try a smaller or compressed image." }, 413) });
  // An uploaded calendar may be 5 MB of text, a little more once sent as JSON.
  const calendarFiles = bodyLimit({ maxSize: 7 * 1024 * 1024, onError: (c) => c.json({ error: "Choose an .ics file of up to 5 MB." }, 413) });
  const backups = bodyLimit({ maxSize: 4 * 1024 * 1024 * 1024, onError: (c) => c.json({ error: "That backup is over 4 GB." }, 413) });
  app.use("/api/*", (c, next) => {
    if (c.req.method === "POST" && c.req.path === "/api/setup/restore") return backups(c, next);
    if (c.req.method === "PUT" && c.req.path === "/api/settings/appearance/logo") return logoBodies(c, next);
    if (c.req.method === "POST" && c.req.path === "/api/calendar/events") return calendarFiles(c, next);
    if (c.req.method !== "PUT" || !RECEIPT_PATH.test(c.req.path)) return smallBodies(c, next);
    return bodyLimit({ maxSize: maxReceiptBytes(), onError: (c) => c.json({ error: receiptTooLarge() }, 413) })(c, next);
  });
  // A NUL character can't be stored and nobody types one: an address or a JSON body with one
  // is turned away here, before it can reach the database and fail there.
  app.use("/api/*", async (c, next) => {
    if (/%00/.test(new URL(c.req.url).pathname)) return c.json({ error: "Not found." }, 404);
    if (c.req.method !== "GET" && (c.req.header("content-type") ?? "").includes("application/json")) {
      // A backup is sent as a gzip file and may be 4 GB, so a JSON body there is never read.
      if (c.req.path === "/api/setup/restore") return c.json({ error: "Send the backup file itself, not JSON." }, 415);
      const body = await c.req.raw.clone().json().catch(() => null);
      if (hasNul(body)) return c.json({ error: "Remove the unusual characters and try again." }, 400);
    }
    await next();
  });
  // The app is private: search engines are asked to stay out.
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /"));
  app.route("/api", api);
  // Pay now links for clients, outside the signed-in app.
  app.route("/pay", payRoutes);
  // An unexpected error answers with one plain sentence, never a stack trace or a database
  // message. The log gets the error itself, without the request's body or headers.
  app.onError((error, c) => {
    // Hono's own refusals (a cross-site form post, a body over the limit) keep their answer.
    if (error instanceof HTTPException) return error.getResponse();
    console.error(`${c.req.method} ${new URL(c.req.url).pathname} failed:`, describeError(error));
    return c.json({ error: "Something went wrong. Try again, and if it keeps happening, tell your admin." }, 500);
  });
  return app;
}
