import { Hono } from "hono";
import { requireAdmin, readBody, type SignedIn } from "./http.ts";
import { isDemoMode } from "./env.ts";
import { sendMail } from "./mail.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { recordAudit } from "./audit.ts";
import { isHeaderSafeEmail } from "../shared/email.ts";

const describe = (s: { fromEmail: string; smtpHost: string | null; smtpPort: number | null }) => `SMTP ${s.smtpHost}:${s.smtpPort}, from ${s.fromEmail}`;

// Manage → Email (admins): how the app sends email. The SMTP password is
// encrypted when saved and is never sent back; the screen only learns that one is saved.

// Any email service that offers SMTP works: Resend, Postmark, Amazon SES, Gmail and Microsoft 365 all do.
const PROVIDERS = ["smtp"] as const;
type Provider = (typeof PROVIDERS)[number];
const HOST = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/;

type Row = {
  provider: Provider;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  secret: string;
  lastTestAt: Date | null;
  lastError: string | null;
};

function present(row: Row) {
  const readable = !row.secret || decryptSecret(row.secret) !== null;
  return {
    provider: row.provider,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    smtpUser: row.smtpUser,
    hasSecret: !!row.secret && readable,
    // Saved, but made with another BETTER_AUTH_SECRET: the screen asks for it again.
    secretUnreadable: !!row.secret && !readable,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

const demoRefusal = { error: "Email can't be set up in the demo." };

export const emailSettingsRoutes = new Hono<SignedIn>()
  .get("/", requireAdmin("see email settings"), async (c) => {
    if (isDemoMode()) return c.json({ demo: true });
    const row = await c.get("db").emailSettings.findFirst();
    return c.json({ settings: row ? present(row) : null });
  })
  .put("/", requireAdmin("change email settings"), async (c) => {
    if (isDemoMode()) return c.json(demoRefusal, 403);

    const body = await readBody(c);
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const provider = body.provider as Provider;
    if (!PROVIDERS.includes(provider)) return c.json({ error: "Choose SMTP server." }, 400);
    const fromName = text(body.fromName);
    const fromEmail = text(body.fromEmail);
    if (fromName.length > 100 || /[<>"\r\n]/.test(fromName)) return c.json({ error: "Use up to 100 characters for the sender name, without < > or quotes." }, 400);
    if (!isHeaderSafeEmail(fromEmail) || fromEmail.length > 200) return c.json({ error: "Enter the address the emails come from, like billing@yourcompany.com." }, 400);

    let smtpHost = "";
    let smtpPort = 587;
    let smtpSecure = false;
    let smtpUser = "";
    if (provider === "smtp") {
      smtpHost = text(body.smtpHost);
      if (!smtpHost || smtpHost.length > 200 || !HOST.test(smtpHost)) return c.json({ error: "Enter the SMTP server's host name, like smtp.example.com." }, 400);
      smtpPort = Number(body.smtpPort);
      if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) return c.json({ error: "Enter the port as a number from 1 to 65535." }, 400);
      smtpSecure = body.smtpSecure === true;
      smtpUser = text(body.smtpUser);
      if (smtpUser.length > 200) return c.json({ error: "Keep the username to 200 characters." }, 400);
    }

    const db = c.get("db");
    const existing = await db.emailSettings.findFirst();
    // A new password replaces the saved one; leaving it out keeps it.
    const given = typeof body.secret === "string" ? body.secret : "";
    if (given.length > 500) return c.json({ error: "That password or key is too long." }, 400);
    let secret: string;
    if (given) secret = encryptSecret(given);
    else if (existing && existing.provider === provider && decryptSecret(existing.secret) !== null) secret = existing.secret;
    else secret = "";
    if (provider === "smtp" && smtpUser && !secret) return c.json({ error: "Enter the password for that username." }, 400);
    if (provider === "smtp" && !smtpUser) secret = ""; // no username means no login

    const data = { provider, fromName, fromEmail, smtpHost, smtpPort, smtpSecure, smtpUser, secret, lastTestAt: null, lastError: null };
    const row = await db.emailSettings.upsert({
      where: { organizationId: c.get("user").organizationId },
      create: data as typeof data & { organizationId: string }, // orgDb fills in organizationId
      update: data,
    });
    // Where the app's email goes out from is on record (never the password or key).
    await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Email", changes: [{ field: "email", from: existing ? describe(existing) : null, to: describe(row) }] });
    return c.json({ settings: present(row) });
  })
  .delete("/", requireAdmin("change email settings"), async (c) => {
    if (isDemoMode()) return c.json(demoRefusal, 403);
    const db = c.get("db");
    const existing = await db.emailSettings.findFirst();
    await db.emailSettings.deleteMany();
    if (existing) await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Email", changes: [{ field: "email", from: describe(existing), to: null }] });
    return c.json({ settings: null });
  })
  .post("/test", requireAdmin("send a test email"), async (c) => {
    if (isDemoMode()) return c.json(demoRefusal, 403);
    const db = c.get("db");
    if (!(await db.emailSettings.findFirst())) return c.json({ error: "Save your email settings first." }, 400);

    const user = c.get("user");
    const result = await sendMail(db, {
      to: user.email,
      subject: "Test email",
      text: "This is a test email. If you can read it, your app can send email.",
      html: "<p>This is a test email. If you can read it, your app can send email.</p>",
    });
    await db.emailSettings.updateMany({ data: { lastTestAt: new Date() } });
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 502);
  });
