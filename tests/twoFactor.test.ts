import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { signInAttemptsPerIp } from "../src/server/rateLimit.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Two-factor sign-in (WRK-147): an authenticator app and backup codes, through Better Auth's
// twoFactor plugin, with the organization's requirement and an admin's reset.

beforeEach(resetDatabase);

/** RFC 6238 codes, worked out here independently of the app. */
function base32(text: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text.replace(/=+$/, "").toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
}
function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hash = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** A code that is certainly wrong now. */
const wrong = (code: string) => String((Number(code) + 500_000) % 1_000_000).padStart(6, "0");

const PASSWORD = "member-password-1";

async function studio(name = "Studio North", domain = "studio.test") {
  const { organization, user: admin } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  const member = await addUser(organization.id, `ada@${domain}`, PASSWORD, "member");
  return { organization, admin, member, domain };
}

const post = async (path: string, body: unknown, cookie: string) => {
  const res = await request(path, { body, cookie });
  return { status: res.status, body: await res.json().catch(() => null), cookie: cookieFrom(res) };
};

/** Turns two-factor on for someone, returning their secret and backup codes. */
async function setUp(email: string, password: string) {
  const { cookie } = await signIn(email, password);
  const enabled = await post("/api/auth/two-factor/enable", { password, issuer: "Studio North" }, cookie);
  expect(enabled.status).toBe(200);
  const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!;
  const verified = await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, cookie);
  expect(verified.status).toBe(200);
  return { secret, backupCodes: enabled.body.backupCodes as string[], cookie: verified.cookie || cookie, uri: enabled.body.totpURI as string };
}

/** Signs in with the password, then the code; returns the session cookie or the failure. */
async function signInWithCode(email: string, password: string, code: string, path = "/api/auth/two-factor/verify-totp") {
  const first = await signIn(email, password);
  expect((await first.res.json()).twoFactorRedirect).toBe(true);
  return post(path, { code }, first.cookie);
}

describe("setting up two-factor sign-in", () => {
  it("turns on only after a code from the app is confirmed, and keeps the secret encrypted and the backup codes hashed", async () => {
    const s = await studio();
    const { cookie } = await signIn("ada@studio.test", PASSWORD);
    expect((await post("/api/auth/two-factor/enable", { password: "not-it", issuer: "Studio North" }, cookie)).status).toBe(400);
    const enabled = await post("/api/auth/two-factor/enable", { password: PASSWORD, issuer: "Studio North" }, cookie);
    expect(enabled.status).toBe(200);
    expect(enabled.body.totpURI).toMatch(/^otpauth:\/\/totp\/Studio%20North:ada%40studio\.test\?/);
    expect(enabled.body.backupCodes).toHaveLength(10);
    const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.member.id } })).twoFactorEnabled).toBe(false);

    expect((await post("/api/auth/two-factor/verify-totp", { code: wrong(totp(secret)) }, cookie)).status).toBe(401);
    const verified = await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, cookie);
    expect(verified.status).toBe(200);
    const me = await (await request("/api/me", { cookie: verified.cookie })).json();
    expect(me.user.twoFactor).toEqual({ enabled: true, hasPassword: true, viaSso: false, mustSetUp: false });

    const row = await prisma.twoFactor.findUniqueOrThrow({ where: { userId: s.member.id } });
    expect(row.secret).not.toContain(secret);
    const stored = JSON.parse(row.backupCodes) as string[];
    expect(stored).toHaveLength(10);
    expect(stored.every((c) => c.startsWith("h1:"))).toBe(true);
    for (const code of enabled.body.backupCodes) expect(row.backupCodes).not.toContain(code);
  });
});

describe("signing in with two-factor", () => {
  it("asks for a code after the password, and signs in with the app's code", async () => {
    await studio();
    const { secret } = await setUp("ada@studio.test", PASSWORD);
    const first = await signIn("ada@studio.test", PASSWORD);
    expect(await first.res.json()).toMatchObject({ twoFactorRedirect: true });
    // The password alone isn't a session.
    expect((await request("/api/me", { cookie: first.cookie })).status).toBe(401);
    const done = await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, first.cookie);
    expect(done.status).toBe(200);
    expect((await request("/api/me", { cookie: done.cookie })).status).toBe(200);
    // "Trust this device" is ignored: the next sign-in asks again.
    const trusted = await signInWithCode("ada@studio.test", PASSWORD, totp(secret));
    const next = await request("/api/auth/sign-in/email", { body: { email: "ada@studio.test", password: PASSWORD }, cookie: trusted.cookie });
    expect(await next.json()).toMatchObject({ twoFactorRedirect: true });
  });

  it("takes each backup code once", async () => {
    await studio();
    const { backupCodes } = await setUp("ada@studio.test", PASSWORD);
    const used = await signInWithCode("ada@studio.test", PASSWORD, backupCodes[0]!, "/api/auth/two-factor/verify-backup-code");
    expect(used.status).toBe(200);
    expect((await request("/api/me", { cookie: used.cookie })).status).toBe(200);
    expect((await signInWithCode("ada@studio.test", PASSWORD, backupCodes[0]!, "/api/auth/two-factor/verify-backup-code")).status).toBe(401);
    expect((await signInWithCode("ada@studio.test", PASSWORD, backupCodes[1]!, "/api/auth/two-factor/verify-backup-code")).status).toBe(200);
    expect((await signInWithCode("ada@studio.test", PASSWORD, "nope-nope", "/api/auth/two-factor/verify-backup-code")).status).toBe(401);
  });

  it("ends a sign-in after 5 wrong codes, and limits tries per address like passwords", async () => {
    await studio();
    const { secret } = await setUp("ada@studio.test", PASSWORD);
    signInAttemptsPerIp.reset();
    const first = await signIn("ada@studio.test", PASSWORD);
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/two-factor/verify-totp", { code: wrong(totp(secret)) }, first.cookie)).status).toBe(401);
    // The right code no longer helps: the attempt is over and starts again with the password.
    expect((await post("/api/auth/two-factor/verify-totp", { code: totp(secret) }, first.cookie)).status).not.toBe(200);
    // Ten failed tries a minute from one address, codes and passwords together.
    for (let i = 0; i < 10; i++) await request("/api/auth/two-factor/verify-totp", { body: { code: "000000" }, ip: "198.51.100.7" });
    expect((await request("/api/auth/two-factor/verify-totp", { body: { code: "000000" }, ip: "198.51.100.7" })).status).toBe(429);
  });
});

describe("other ways in", () => {
  it("a password reset link doesn't skip the code", async () => {
    const s = await studio();
    const { secret } = await setUp("ada@studio.test", PASSWORD);
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    const { token } = await (await request(`/api/people/${s.member.id}/reset-link`, { body: {}, cookie: admin })).json();
    const used = await request("/api/password-reset", { body: { token, password: "a-brand-new-password" } });
    expect(used.status).toBe(200);
    expect((await request("/api/me", { cookie: cookieFrom(used) })).status).toBe(401);
    expect((await signInWithCode("ada@studio.test", "a-brand-new-password", totp(secret))).status).toBe(200);
  });
});

describe("turning two-factor off", () => {
  it("takes the password and a current code", async () => {
    const s = await studio();
    const { secret, cookie } = await setUp("ada@studio.test", PASSWORD);
    expect((await post("/api/auth/two-factor/disable", { password: PASSWORD }, cookie)).status).toBe(400);
    expect((await post("/api/auth/two-factor/disable", { password: PASSWORD, code: wrong(totp(secret)) }, cookie)).status).toBe(401);
    expect((await post("/api/auth/two-factor/disable", { password: "not-it", code: totp(secret) }, cookie)).status).toBe(400);
    expect((await post("/api/auth/two-factor/disable", { password: PASSWORD, code: totp(secret) }, cookie)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.member.id } })).twoFactorEnabled).toBe(false);
    expect(await prisma.twoFactor.count()).toBe(0);
    expect(await (await signIn("ada@studio.test", PASSWORD)).res.json()).not.toHaveProperty("twoFactorRedirect");
  });

  it("takes a backup code instead of the app's code", async () => {
    await studio();
    const { backupCodes, cookie } = await setUp("ada@studio.test", PASSWORD);
    expect((await post("/api/auth/two-factor/disable", { password: PASSWORD, code: backupCodes[3] }, cookie)).status).toBe(200);
  });
});

describe("requiring two-factor", () => {
  it("lets someone without it see only who they are until they set it up", async () => {
    await studio();
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    // An admin sets up their own first.
    expect((await request("/api/two-factor/settings", { method: "PUT", body: { required: true }, cookie: admin })).status).toBe(409);
    const adminSetup = await setUp("admin@studio.test", "admin-password-1");
    expect((await request("/api/two-factor/settings", { method: "PUT", body: { required: true }, cookie: adminSetup.cookie })).status).toBe(200);
    expect(await prisma.auditEvent.findFirst({ where: { label: "Two-factor sign-in" } })).toBeTruthy();

    const { cookie } = await signIn("ada@studio.test", PASSWORD);
    const me = await (await request("/api/me", { cookie })).json();
    expect(me.user.twoFactor).toMatchObject({ enabled: false, mustSetUp: true });
    const blocked = await request("/api/projects", { cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "two-factor-required" });

    const { cookie: after } = await setUp("ada@studio.test", PASSWORD);
    expect((await request("/api/projects", { cookie: after })).status).toBe(200);
  });

  it("doesn't ask people who signed in through single sign-on", async () => {
    const s = await studio();
    await prisma.organization.update({ where: { id: s.organization.id }, data: { requireTwoFactor: true } });
    const { cookie } = await signIn("ada@studio.test", PASSWORD);
    expect((await request("/api/projects", { cookie })).status).toBe(403);
    // As the session would be when made by the provider's callback (auth.ts marks it).
    await prisma.session.updateMany({ where: { userId: s.member.id }, data: { viaSso: true } });
    expect((await request("/api/projects", { cookie })).status).toBe(200);
    expect((await (await request("/api/me", { cookie })).json()).user.twoFactor).toMatchObject({ viaSso: true, mustSetUp: false });
  });
});

describe("an admin's reset", () => {
  it("removes someone's two-factor in their own organization only, and records it", async () => {
    const s = await studio();
    const other = await studio("Other", "other.test");
    await setUp("ada@studio.test", PASSWORD);
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    const otherAdmin = (await signIn("admin@other.test", "admin-password-1")).cookie;
    const manager = await addUser(s.organization.id, "max@studio.test", "manager-password-1", "manager");
    const managerCookie = (await signIn("max@studio.test", "manager-password-1")).cookie;

    expect((await request(`/api/two-factor/people/${s.member.id}`, { method: "DELETE", cookie: otherAdmin })).status).toBe(404);
    expect((await request(`/api/two-factor/people/${s.member.id}`, { method: "DELETE", cookie: managerCookie })).status).toBe(403);
    expect((await request(`/api/two-factor/people/${s.member.id}`, { method: "DELETE", cookie: admin })).status).toBe(200);
    expect((await request(`/api/two-factor/people/${s.member.id}`, { method: "DELETE", cookie: admin })).status).toBe(409);
    expect(await prisma.twoFactor.count({ where: { userId: s.member.id } })).toBe(0);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { subjectId: s.member.id, kind: "person" } });
    expect(JSON.stringify(event.changes)).toContain("twoFactor");
    expect(await (await signIn("ada@studio.test", PASSWORD)).res.json()).not.toHaveProperty("twoFactorRedirect");
    expect(manager.organizationId).toBe(s.organization.id);
    expect(other.organization.id).not.toBe(s.organization.id);
  });
});
