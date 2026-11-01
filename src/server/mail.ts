import nodemailer from "nodemailer";
import type { OrgDb } from "./db.ts";
import { decryptSecret } from "./secrets.ts";

// Sends the app's email through the server the organization chose in Manage → Email.
// Nothing is sent, and no connection is opened, until an admin turns email on.

export type Mail = { to: string; subject: string; text: string; html: string };
export type SendResult = { ok: true } | { ok: false; error: string };

const TIMEOUT_MS = 15_000;

/** True when an admin has saved email settings that the app can use. */
export async function isEmailConfigured(db: OrgDb): Promise<boolean> {
  const row = await db.emailSettings.findFirst();
  if (!row) return false;
  return !!row.smtpHost && (!row.secret || decryptSecret(row.secret) !== null);
}

/** Sends one email and never throws. A failure comes back as one readable sentence and is saved as the last error. */
export async function sendMail(db: OrgDb, mail: Mail): Promise<SendResult> {
  const settings = await db.emailSettings.findFirst();
  if (!settings) return { ok: false, error: "Email isn't turned on. An admin can set it up in Manage → Email." };

  let result: SendResult;
  const secret = settings.secret ? decryptSecret(settings.secret) : "";
  if (secret === null) {
    result = { ok: false, error: "Enter the password again." };
  } else {
    try {
      await sendWithSmtp(settings, secret, mail);
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: error instanceof MailError ? error.message : "The email couldn't be sent. Check your email settings." };
    }
  }

  await db.emailSettings.updateMany({ data: { lastError: result.ok ? null : result.error } });
  return result;
}

type Settings = NonNullable<Awaited<ReturnType<OrgDb["emailSettings"]["findFirst"]>>>;

class MailError extends Error {}

async function sendWithSmtp(s: Settings, password: string, mail: Mail) {
  const transport = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    // On a plain connection, use STARTTLS when the server offers it.
    requireTLS: false,
    auth: s.smtpUser ? { user: s.smtpUser, pass: password } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: { name: s.fromName, address: s.fromEmail },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (error) {
    throw new MailError(describeSmtpError(error, s));
  } finally {
    transport.close();
  }
}

function describeSmtpError(error: unknown, s: Settings): string {
  const { code, message, response, command, errors } = (error ?? {}) as { code?: string; message?: string; response?: string; command?: string; errors?: { code?: string }[] };
  const where = `${s.smtpHost}:${s.smtpPort}`;
  if (code === "EAUTH") return "The email server refused the username or password.";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return `The email server at ${where} didn't answer in time.`;
  if (code === "ESOCKET" && /wrong version number|ssl|tls/i.test(message ?? "")) {
    return `The email server at ${where} didn't accept the secure connection. Try turning "Secure connection" ${s.smtpSecure ? "off" : "on"}, or another port.`;
  }
  // Never reached the server: nothing listening on that port, or no such host. A name that resolves to
  // several addresses (localhost) fails with a bundle of errors and an empty message, so their codes count too.
  const codes = [code, ...(errors ?? []).map((e) => e.code)];
  const notReached = codes.some((c) => c && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EDNS", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ECONNECTION"].includes(c));
  if (notReached || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(message ?? "") || (command === "CONN" && !response)) {
    return `Couldn't connect to the email server at ${where}. Check the host, the port and the secure-connection setting.`;
  }
  const said = (response ?? message ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return said ? `The email server said: ${said}` : "The email server refused the message.";
}

/** Text made safe to put inside HTML. */
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
