import { createApp } from "../src/server/app.ts";
import { prisma } from "../src/server/db.ts";
import { forgetInstalledCache } from "../src/server/setup.ts";
import { auth, reloadAuth } from "../src/server/auth.ts";
import {
  acceptAttemptsPerIp, changePasswordAttemptsPerIp, resetAttemptsPerIp, resetRequestsPerEmail, resetRequestsPerIp, setupAttemptsPerIp, setupAttemptsTotal, signInAttemptsPerIp, signInFailuresPerEmail,
} from "../src/server/rateLimit.ts";

export const app = createApp();
export const ORIGIN = "http://localhost:3000";
export const SETUP_CODE = "test-setup-code-0123456789";

export async function resetDatabase() {
  // Only ever empties a database whose name ends in _test.
  if (!new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test")) throw new Error("Not a test database.");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "installation", "organization", "user", "session", "account", "verification" CASCADE',
  );
  forgetInstalledCache();
  // No organization, so no single sign-on: sign-in is built again without it.
  await reloadAuth();
  setupAttemptsPerIp.reset();
  setupAttemptsTotal.reset();
  acceptAttemptsPerIp.reset();
  signInAttemptsPerIp.reset();
  signInFailuresPerEmail.reset();
  changePasswordAttemptsPerIp.reset();
  resetAttemptsPerIp.reset();
  resetRequestsPerIp.reset();
  resetRequestsPerEmail.reset();
}

export function request(path: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "x-forwarded-for": init.ip ?? "203.0.113.1" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  return app.request(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** A form post, the way a script (not the app) might send one. */
export function requestForm(path: string, fields: Record<string, string>, ip = "203.0.113.1") {
  return app.request(path, {
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": ip, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

// Turns Set-Cookie response headers into a Cookie request header.
export function cookieFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export const validSetup = {
  setupCode: SETUP_CODE,
  organizationName: "Studio North",
  name: "Ada Admin",
  email: "Ada@Example.com",
  password: "correct horse battery",
};

export async function signIn(email: string, password: string) {
  const res = await request("/api/auth/sign-in/email", { body: { email, password } });
  return { res, cookie: cookieFrom(res) };
}

// Creates an organization with one member directly in the database, the way the
// demo will create a workspace per visitor.
export async function createOrgWithUser(orgName: string, email: string, password: string, role: "admin" | "manager" | "member" = "member") {
  const organization = await prisma.organization.create({ data: { name: orgName } });
  const user = await addUser(organization.id, email, password, role);
  return { organization, user };
}

export async function addUser(organizationId: string, email: string, password: string, role: "admin" | "manager" | "member" = "member") {
  const ctx = await auth.$context;
  const user = await prisma.user.create({ data: { name: email.split("@")[0]!, email, organizationId, role } });
  await prisma.account.create({
    data: { userId: user.id, accountId: user.id, providerId: "credential", password: await ctx.password.hash(password) },
  });
  return user;
}
