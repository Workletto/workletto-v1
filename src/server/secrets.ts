import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "./env.ts";

// Keeps secrets the app must be able to use again (an SMTP password, a Stripe key)
// unreadable to anyone who only gets a copy of the database, such as a backup.
//
// The key is made from BETTER_AUTH_SECRET, which lives in the host's settings and not in the
// database. If that secret is changed, saved secrets can no longer be read; the app then asks
// for them again instead of failing.
//
// A stored value looks like  v1.<iv>.<tag>.<ciphertext>  (each part base64url).

const VERSION = "v1";

function keyFrom(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "", "email-settings", 32));
}

export function encryptSecret(plain: string, authSecret = env.authSecret): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(authSecret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The original text, or null when the value is damaged or was made with another BETTER_AUTH_SECRET. */
export function decryptSecret(stored: string, authSecret = env.authSecret): string | null {
  const [version, iv, tag, data, ...extra] = stored.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined || extra.length) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(authSecret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
