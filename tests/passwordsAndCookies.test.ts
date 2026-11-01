import { scrypt } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { env } from "../src/server/env.ts";
import { reloadAuth } from "../src/server/auth.ts";
import { app, createOrgWithUser, request, resetDatabase, validSetup } from "./helpers.ts";

// WRK-78: passwords are stored as salted scrypt hashes, never as typed, and the sign-in cookie
// can't be read by the page's scripts, isn't sent along from other sites, and on a real install
// (an https address) only travels over HTTPS.

// Better Auth's scrypt settings: N 16384, r 16, p 1, a 64-byte key, the salt as hex text.
const scryptKey = (password: string, salt: string) =>
  new Promise<string>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (err, key) =>
      err ? reject(err) : resolve(key.toString("hex")),
    ),
  );

const storedPassword = async (email: string) =>
  (await prisma.account.findFirstOrThrow({ where: { providerId: "credential", user: { email } } })).password!;

const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => /session_token=/.test(c)) ?? "";

describe("stored passwords", () => {
  beforeEach(resetDatabase);

  it("are salted scrypt hashes, never the password itself", async () => {
    expect((await request("/api/setup", { body: validSetup })).status).toBe(201);
    const stored = await storedPassword(validSetup.email.toLowerCase());
    expect(stored).not.toContain(validSetup.password);
    const [salt, key] = stored.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{128}$/);
    expect(await scryptKey(validSetup.password, salt!)).toBe(key);
  });

  it("get a different salt each time, so the same password never looks the same", async () => {
    await createOrgWithUser("Studio A", "a@studio.test", validSetup.password);
    await createOrgWithUser("Studio B", "b@studio.test", validSetup.password);
    const [a, b] = [await storedPassword("a@studio.test"), await storedPassword("b@studio.test")];
    expect(a.split(":")[0]).not.toBe(b.split(":")[0]);
    expect(a).not.toBe(b);
  });
});

describe("the sign-in cookie", () => {
  beforeEach(async () => {
    await resetDatabase();
    await request("/api/setup", { body: validSetup });
  });

  it("can't be read by the page's scripts and isn't sent along from other sites", async () => {
    const res = await request("/api/auth/sign-in/email", { body: { email: validSetup.email, password: validSetup.password } });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
  });

  describe("on an install with an https address", () => {
    const address = "https://time.studio.test";
    const original = env.baseUrl;
    beforeEach(async () => {
      env.baseUrl = address;
      await reloadAuth();
    });
    afterEach(async () => {
      env.baseUrl = original;
      await reloadAuth();
    });

    it("only travels over HTTPS", async () => {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: address, "content-type": "application/json", "x-forwarded-for": "203.0.113.1" },
        body: JSON.stringify({ email: validSetup.email, password: validSetup.password }),
      });
      expect(res.status).toBe(200);
      const cookie = sessionCookie(res);
      expect(cookie).toMatch(/^__Secure-/);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    });
  });
});
