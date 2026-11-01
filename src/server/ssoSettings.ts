import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { readBody, requireAdmin, type SignedIn } from "./http.ts";
import { env, isDemoMode } from "./env.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { diff, recordAudit, snapshot } from "./audit.ts";
import { reloadAuth } from "./auth.ts";
import { discoveryUrl, SSO_PROVIDER } from "./sso.ts";

// Manage → Settings → Single sign-on (admins): the organization's identity provider (sso.ts).
// Saving checks the provider's OpenID settings first, then builds sign-in again (reloadAuth),
// so the button appears on the sign-in page straight away.

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEMO = "Single sign-on isn't available in the demo.";

/** The issuer as an https address (http only for a provider on this same computer, for testing), without a trailing slash. */
function readIssuer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Reads the provider's OpenID Connect settings, to catch a wrong address before anyone tries to
 * sign in. Returns an error message, or null when they look right.
 */
async function checkProvider(issuer: string): Promise<string | null> {
  const where = discoveryUrl(issuer);
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(where, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) return `The provider didn't answer at ${where} (${res.status}). Check the issuer address.`;
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    return `Couldn't read the provider's settings at ${where}. Check the issuer address.`;
  }
  const said = typeof doc.issuer === "string" ? doc.issuer.replace(/\/+$/, "") : "";
  if (said !== issuer) return `That provider calls itself ${said || "nothing"}. Enter exactly that as the issuer.`;
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof doc[key] !== "string") return "That provider doesn't describe a complete OpenID Connect sign-in. Check the issuer address.";
  }
  return null;
}

const SELECT = { providerName: true, issuer: true, clientId: true, secret: true, domain: true, allowJoin: true, requireSso: true } as const;
type Row = { providerName: string; issuer: string; clientId: string; secret: string; domain: string; allowJoin: boolean; requireSso: boolean };
const AUDITED = ["providerName", "issuer", "clientId", "domain", "allowJoin", "requireSso"] as const;
const audited = (row: Row) => ({ providerName: row.providerName, issuer: row.issuer, clientId: row.clientId, domain: row.domain, allowJoin: row.allowJoin, requireSso: row.requireSso });

/** The settings as the screen shows them: never the secret itself. */
const toSettings = (row: Row | null) =>
  row && { ...audited(row), hasSecret: true, secretUnreadable: decryptSecret(row.secret) === null };

export const ssoSettingsRoutes = new Hono<SignedIn>()
  .use(requireAdmin("change single sign-on"))
  .get("/", async (c) => {
    const row = await c.get("db").ssoSettings.findFirst({ select: SELECT });
    // What to enter at the provider: where it sends people back after they sign in.
    return c.json({ settings: toSettings(row), callbackUrl: `${env.baseUrl}/api/auth/callback/${SSO_PROVIDER}`, available: !isDemoMode() });
  })
  .put("/", async (c) => {
    if (isDemoMode()) return c.json({ error: DEMO }, 403);
    const db = c.get("db");
    const body = await readBody(c);
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const providerName = text(body.providerName);
    const issuer = readIssuer(body.issuer);
    const clientId = text(body.clientId);
    const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    const domain = text(body.domain).toLowerCase().replace(/^@/, "");
    if (!providerName || providerName.length > 60) return c.json({ error: "Name the provider for the button, like Google Workspace (up to 60 characters)." }, 400);
    if (!issuer) return c.json({ error: "Enter the provider's issuer address, starting with https://." }, 400);
    if (!clientId || clientId.length > 500) return c.json({ error: "Enter the client ID from your provider." }, 400);
    if (secret.length > 2000) return c.json({ error: "That client secret is too long." }, 400);
    if (!DOMAIN.test(domain)) return c.json({ error: "Enter your email domain, like yourstudio.com." }, 400);
    for (const key of ["allowJoin", "requireSso"] as const) {
      if (typeof body[key] !== "boolean") return c.json({ error: `${key} must be true or false.` }, 400);
    }
    const before = await db.ssoSettings.findFirst({ select: SELECT });
    // The secret is kept unless a new one is typed; the first time, it's needed.
    if (!secret && (!before || decryptSecret(before.secret) === null)) return c.json({ error: "Enter the client secret from your provider." }, 400);
    const problem = await checkProvider(issuer);
    if (problem) return c.json({ error: problem }, 400);

    const data = { providerName, issuer, clientId, domain, allowJoin: body.allowJoin as boolean, requireSso: body.requireSso as boolean, secret: secret ? encryptSecret(secret) : before!.secret };
    const after = await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      const saved = before
        ? (await t.ssoSettings.updateMany({ data }), await t.ssoSettings.findFirstOrThrow({ select: SELECT }))
        : await t.ssoSettings.create({ data: data as typeof data & { organizationId: string }, select: SELECT });
      const changes = before ? diff(audited(before), audited(saved), AUDITED) : snapshot(audited(saved), AUDITED);
      if (secret) changes.push({ field: "clientSecret", from: before ? "set" : null, to: "changed" });
      await recordAudit(t, c.get("user"), { kind: "settings", action: before ? "changed" : "created", label: "Single sign-on", changes });
      return saved;
    });
    await reloadAuth();
    return c.json({ settings: toSettings(after) });
  })
  .delete("/", async (c) => {
    const db = c.get("db");
    const before = await db.ssoSettings.findFirst({ select: SELECT });
    if (!before) return c.json({ ok: true });
    await db.$transaction(async (tx) => {
      await tx.ssoSettings.deleteMany({});
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "deleted", label: "Single sign-on", changes: snapshot(audited(before), AUDITED, true) });
    });
    await reloadAuth();
    return c.json({ ok: true });
  });
