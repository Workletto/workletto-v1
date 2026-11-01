import type { Context } from "hono";
import { auth, type SessionUser } from "./auth.ts";
import { headersWithClientIp } from "./clientIp.ts";
import type { OrgDb } from "./db.ts";
import { createMiddleware } from "hono/factory";
import { canManageOrganization, canManageWork } from "../shared/roles.ts";
import { daysBetween, isIsoDate } from "../shared/time.ts";

// Small helpers shared by the signed-in routes.

export type SignedIn = { Variables: { user: SessionUser; db: OrgDb } };

export async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The ?from= and ?to= dates, both included and at most maxDays apart, or a 400 response with the given message. */
export function readRange(c: Context, maxDays: number, message: string): { from: string; to: string } | Response {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isIsoDate(from) || !isIsoDate(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > maxDays) return c.json({ error: message }, 400);
  return { from, to };
}

/** Middleware that answers 403 to everyone but admins. Use it on a route that has no other rule for who sees what. */
export const requireAdmin = (what: string) =>
  createMiddleware<SignedIn>(async (c, next) => {
    if (!canManageOrganization(c.get("user").role)) return c.json({ error: `Only admins can ${what}.` }, 403);
    await next();
  });

/** Middleware that answers 403 to members, letting admins and managers through. */
export const requireManager = (what: string) =>
  createMiddleware<SignedIn>(async (c, next) => {
    if (!canManageWork(c.get("user").role)) return c.json({ error: `Only admins and managers can ${what}.` }, 403);
    await next();
  });

/** Signs the person in and copies the session cookies onto the response, so a new account is signed in straight away. */
export async function signInAs(c: Context, email: string, password: string) {
  const signIn = await auth.api.signInEmail({ body: { email, password }, headers: headersWithClientIp(c), returnHeaders: true });
  for (const cookie of signIn.headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
}

/** A trimmed name of 1 to 200 characters, or null. */
export function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 200 ? name : null;
}

const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;
export const isUniqueViolation = (error: unknown) => errorCode(error) === "P2002";
/** A row is still linked from another table (for example a project that still has time entries). */
export const isStillReferenced = (error: unknown) => errorCode(error) === "P2003";
