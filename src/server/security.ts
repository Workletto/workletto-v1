import { Hono } from "hono";
import { requireAdmin, type SignedIn } from "./http.ts";
import { env, isDemoMode, trustProxy } from "./env.ts";
import { SIGN_IN_ATTEMPTS_PER_MINUTE } from "./rateLimit.ts";
import { isEmailConfigured } from "./mail.ts";

// Manage → Security & data (admins): live facts about where this install keeps
// its data and who can reach it. Every answer is read from the running app.

/** The database's host name from DATABASE_URL. Never the user name or password. */
export function databaseHost(url = env.databaseUrl): string {
  try {
    const parsed = new URL(url);
    // postgresql:///work?host=/var/run/postgresql connects through a local socket.
    return parsed.hostname || (parsed.searchParams.get("host") ? "a local socket on this server" : "this server");
  } catch {
    return "unknown";
  }
}

export const securityRoutes = new Hono<SignedIn>().get("/", requireAdmin("see security details"), async (c) => {
  const db = c.get("db");
  const demo = isDemoMode();

  const [canSignIn, turnedOff, openInvites, emailSettings, paymentSettings, ssoSettings, calendarLinks, twoFactor] = await Promise.all([
    // People with a login (imported people have none until invited) who aren't turned off.
    db.user.findMany({
      where: { deactivatedAt: null, accounts: { some: {} } },
      select: { name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    db.user.count({ where: { deactivatedAt: { not: null } } }),
    db.invite.count({ where: { expiresAt: { gt: new Date() } } }),
    db.emailSettings.findFirst({ select: { provider: true, smtpHost: true, smtpPort: true, lastError: true } }),
    db.paymentSettings.findFirst({ select: { provider: true, mode: true } }),
    db.ssoSettings.findFirst({ select: { providerName: true, issuer: true, requireSso: true } }),
    db.calendarSettings.count({ where: { url: { not: null } } }),
    Promise.all([
      db.organization.findFirstOrThrow({ select: { requireTwoFactor: true } }),
      db.user.count({ where: { twoFactorEnabled: true, deactivatedAt: null } }),
    ]),
  ]);

  return c.json({
    demo,
    // The demo runs on the vendor's server; its database host is not the visitor's business.
    databaseHost: demo ? null : databaseHost(),
    appAddress: new URL(env.baseUrl).host,
    // Where visitor addresses come from: the connection (0) or the proxies in front (TRUST_PROXY).
    trustProxy: trustProxy(),
    // Email, once an admin turns it on, is the one other place the app connects to (Manage → Email).
    email: emailSettings
      ? {
          provider: emailSettings.provider,
          host: `${emailSettings.smtpHost}:${emailSettings.smtpPort}`,
          lastError: emailSettings.lastError,
        }
      : null,
    // Online payments, once an admin connects Stripe (Manage → Payments), are the other.
    payments: paymentSettings ? { provider: paymentSettings.provider, mode: paymentSettings.mode, host: "api.stripe.com" } : null,
    // Single sign-on, once an admin sets it up (Manage → Settings), connects to the chosen provider.
    // Calendar import (WRK-105): people who saved their own calendar's iCal address, fetched when they load a week.
    calendarLinks,
    sso: ssoSettings ? { providerName: ssoSettings.providerName, host: new URL(ssoSettings.issuer).host, required: ssoSettings.requireSso } : null,
    people: {
      canSignIn: canSignIn.length,
      admins: canSignIn.filter((p) => p.role === "admin").map(({ name, email }) => ({ name, email })),
      turnedOff,
      openInvites,
    },
    // Admins can always make reset links; people can ask for one themselves once email is on.
    recovery: { byEmail: await isEmailConfigured(db) },
    signIn: {
      emailAndPassword: true,
      attemptsPerMinute: SIGN_IN_ATTEMPTS_PER_MINUTE,
      // Two-factor sign-in (WRK-147): required for password sign-ins, and how many people use it.
      twoFactor: { required: twoFactor[0].requireTwoFactor, enabled: twoFactor[1] },
    },
  });
});
