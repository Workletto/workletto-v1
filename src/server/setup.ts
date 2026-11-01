import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { Prisma } from "../generated/prisma/client.ts";
import { auth, MAX_PASSWORD_LENGTH } from "./auth.ts";
import { MIN_PASSWORD_LENGTH } from "../shared/limits.ts";
import { prisma } from "./db.ts";
import { isDemoMode, setupCode, setupCodeSettingsUrl } from "./env.ts";
import { setupAttemptsPerIp, setupAttemptsTotal, TOO_MANY_ATTEMPTS_15_MIN } from "./rateLimit.ts";
import { limitIp } from "./clientIp.ts";
import { passwordResetByEmail } from "./passwordReset.ts";
import { AlreadyInstalled, BadBackup, restoreBackup } from "./backup.ts";
import { isEmail } from "../shared/email.ts";
import { signInAs } from "./http.ts";

// First-run setup. Until an admin exists the app shows only this screen, and it
// asks for the setup code chosen at deploy time. Bots watch certificate logs for
// fresh installs to claim; without the code they cannot.

let installed = false; // Once true it never goes back, so it is safe to cache.

export async function isInstalled(): Promise<boolean> {
  if (installed) return true;
  installed = (await prisma.installation.count()) > 0;
  return installed;
}

export function forgetInstalledCache() {
  installed = false;
}


function sameCode(given: string, expected: string): boolean {
  // Hash first so the comparison takes the same time whatever the lengths.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

type SetupInput = { setupCode: string; organizationName: string; name: string; email: string; password: string };

function readInput(body: unknown): SetupInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof b[key] === "string" ? (b[key] as string).trim() : "");
  const input = {
    setupCode: text("setupCode"),
    organizationName: text("organizationName"),
    name: text("name"),
    email: text("email").toLowerCase(),
    password: typeof b.password === "string" ? b.password : "",
  };
  if (!input.setupCode) return "Enter the setup code.";
  if (!input.organizationName || input.organizationName.length > 100) return "Enter an organization name (up to 100 characters).";
  if (!input.name || input.name.length > 100) return "Enter your name (up to 100 characters).";
  if (input.email.length > 254 || !isEmail(input.email)) return "Enter a valid email address.";
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    return `Choose a password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return input;
}

const ALREADY_DONE = { error: "Setup is already complete. Sign in instead." };

export const setupRoutes = new Hono()
  .get("/status", async (c) => {
    // The demo has no setup: every visitor gets a ready-made workspace.
    if (isDemoMode()) return c.json({ needsSetup: false, setupCodeConfigured: true, setupCodeUrl: null, demo: true, passwordResetByEmail: false });
    const needsSetup = !(await isInstalled());
    return c.json({
      needsSetup,
      setupCodeConfigured: needsSetup ? Boolean(setupCode()) : true,
      // Where the owner copies the code, on hosts that make it (Render). Gone once claimed.
      setupCodeUrl: needsSetup ? setupCodeSettingsUrl(process.env) : null,
      demo: false,
      // The sign-in page offers "Forgot your password?" only when the app can send the link.
      passwordResetByEmail: needsSetup ? false : await passwordResetByEmail(),
    });
  })
  .post("/", async (c) => {
    if (isDemoMode()) return c.json({ error: "Not found." }, 404);
    if (await isInstalled()) return c.json(ALREADY_DONE, 404);

    const expected = setupCode();
    if (!expected) {
      return c.json({ error: "This install has no setup code. Add SETUP_CODE (16+ characters) in your host's settings, then reload." }, 503);
    }

    if (!setupAttemptsPerIp.hit(limitIp(c)) || !setupAttemptsTotal.hit("all")) {
      return c.json({ error: TOO_MANY_ATTEMPTS_15_MIN }, 429);
    }

    const input = readInput(await c.req.json().catch(() => null));
    if (typeof input === "string") return c.json({ error: input }, 400);
    if (!sameCode(input.setupCode, expected)) return c.json({ error: "That setup code is not correct." }, 403);

    const ctx = await auth.$context;
    const passwordHash = await ctx.password.hash(input.password);

    try {
      await prisma.$transaction(async (tx) => {
        // Fails if another request finished setup first: the id can only be 1.
        await tx.installation.create({ data: { id: 1 } });
        const organization = await tx.organization.create({ data: { name: input.organizationName } });
        await tx.installation.update({ where: { id: 1 }, data: { organizationId: organization.id } });
        const user = await tx.user.create({
          data: { name: input.name, email: input.email, role: "admin", organizationId: organization.id },
        });
        // Stored exactly as Better Auth's own sign-up stores an email-and-password login.
        await tx.account.create({
          data: { userId: user.id, accountId: user.id, providerId: "credential", password: passwordHash },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return c.json(ALREADY_DONE, 404);
      }
      throw error;
    }
    installed = true;

    // Sign the new admin straight in.
    await signInAs(c, input.email, input.password);
    return c.json({ ok: true }, 201);
  })
  // Instead of starting fresh: restore a backup downloaded from another install. The body is
  // the backup file; the setup code comes in X-Setup-Code. Afterwards everyone signs in as before.
  .post("/restore", async (c) => {
    if (isDemoMode()) return c.json({ error: "Not found." }, 404);
    if (await isInstalled()) return c.json(ALREADY_DONE, 404);
    const expected = setupCode();
    if (!expected) {
      return c.json({ error: "This install has no setup code. Add SETUP_CODE (16+ characters) in your host's settings, then reload." }, 503);
    }
    if (!setupAttemptsPerIp.hit(limitIp(c)) || !setupAttemptsTotal.hit("all")) {
      return c.json({ error: TOO_MANY_ATTEMPTS_15_MIN }, 429);
    }
    if (!sameCode(c.req.header("x-setup-code")?.trim() ?? "", expected)) return c.json({ error: "That setup code is not correct." }, 403);
    if (!c.req.raw.body) return c.json({ error: "Choose the backup file to restore." }, 400);

    try {
      const { counts } = await restoreBackup(c.req.raw.body);
      installed = true;
      return c.json({ ok: true, counts }, 201);
    } catch (error) {
      if (error instanceof AlreadyInstalled) return c.json(ALREADY_DONE, 404);
      if (error instanceof BadBackup) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
