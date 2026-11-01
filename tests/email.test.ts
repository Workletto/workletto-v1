import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgDb, prisma } from "../src/server/db.ts";
import { isEmailConfigured, sendMail } from "../src/server/mail.ts";
import { decryptSecret, encryptSecret } from "../src/server/secrets.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn, validSetup } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);
afterEach(() => {
  delete process.env.DEMO_MODE;
  vi.restoreAllMocks();
});

const PASSWORD = "smtp-password-that-must-stay-secret";
const smtp = (port: number, extra: Record<string, unknown> = {}) => ({
  provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "", ...extra,
});
const put = (cookie: string, body: unknown) => request("/api/settings/email", { method: "PUT", body, cookie });
const adminCookie = async () => cookieFrom(await request("/api/setup", { body: validSetup }));
const mail = { to: "client@example.com", subject: "Hello", text: "Plain words", html: "<p>Plain words</p>" };

describe("secrets", () => {
  it("round-trips and gives a different value each time", () => {
    const a = encryptSecret("hunter2");
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
    expect(a).not.toContain("hunter2");
    expect(decryptSecret(a)).toBe("hunter2");
    expect(encryptSecret("hunter2")).not.toBe(a);
  });

  it("is unreadable with another BETTER_AUTH_SECRET, or when damaged", () => {
    const stored = encryptSecret("hunter2", "one-secret-one-secret-one-secret-0123");
    expect(decryptSecret(stored, "one-secret-one-secret-one-secret-0123")).toBe("hunter2");
    expect(decryptSecret(stored, "two-secret-two-secret-two-secret-0123")).toBeNull();
    // Damaged: one character of the authentication tag changed (always a different character).
    const [version, iv, tag, data] = stored.split(".");
    const damaged = [version, iv, (tag![0] === "A" ? "B" : "A") + tag!.slice(1), data].join(".");
    expect(decryptSecret(damaged, "one-secret-one-secret-one-secret-0123")).toBeNull();
    expect(decryptSecret("nonsense")).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });
});

describe("email settings routes", () => {
  it("saves, reads back without the secret, replaces and turns off", async () => {
    const cookie = await adminCookie();
    const get = async () => (await request("/api/settings/email", { cookie })).json();
    expect(await get()).toEqual({ settings: null });

    const saved = await put(cookie, smtp(2525, { smtpUser: "mailer", secret: PASSWORD }));
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text).settings).toMatchObject({ provider: "smtp", smtpHost: "127.0.0.1", smtpPort: 2525, smtpUser: "mailer", hasSecret: true, lastTestAt: null, lastError: null });

    // The database holds it encrypted.
    const row = await prisma.emailSettings.findFirstOrThrow();
    expect(row.secret).not.toContain(PASSWORD);
    expect(decryptSecret(row.secret)).toBe(PASSWORD);

    const read = await request("/api/settings/email", { cookie });
    const readText = await read.text();
    expect(readText).not.toContain(PASSWORD);
    expect(readText).not.toContain(row.secret);
    expect(JSON.parse(readText).settings.hasSecret).toBe(true);

    // Leaving the secret out keeps it; sending a new one replaces it.
    await put(cookie, smtp(2526, { smtpUser: "mailer" }));
    expect(decryptSecret((await prisma.emailSettings.findFirstOrThrow()).secret)).toBe(PASSWORD);
    await put(cookie, smtp(2526, { smtpUser: "mailer", secret: "another-password" }));
    expect(decryptSecret((await prisma.emailSettings.findFirstOrThrow()).secret)).toBe("another-password");
    expect(await prisma.emailSettings.count()).toBe(1);

    // SMTP is the only way to send.
    expect((await put(cookie, { provider: "resend", fromEmail: "billing@studio.test", secret: "re_test_key" })).status).toBe(400);

    expect(await (await request("/api/settings/email", { method: "DELETE", cookie })).json()).toEqual({ settings: null });
    expect(await get()).toEqual({ settings: null });
    expect(await prisma.emailSettings.count()).toBe(0);
  });

  it("checks what it's given", async () => {
    const cookie = await adminCookie();
    expect((await put(cookie, { ...smtp(25), provider: "carrier-pigeon" })).status).toBe(400);
    expect((await put(cookie, smtp(25, { fromEmail: "not an address" }))).status).toBe(400);
    expect((await put(cookie, smtp(25, { fromName: 'Evil" <x@y.z>' }))).status).toBe(400);
    expect((await put(cookie, smtp(25, { smtpHost: "" }))).status).toBe(400);
    expect((await put(cookie, smtp(25, { smtpHost: "bad host;rm" }))).status).toBe(400);
    expect((await put(cookie, smtp(70000))).status).toBe(400);
    expect((await put(cookie, smtp(25, { smtpUser: "mailer" }))).status).toBe(400); // a username needs its password
    expect(await prisma.emailSettings.count()).toBe(0);
  });

  it("is for admins only and keeps organizations apart", async () => {
    const a = await createOrgWithUser("Org A", "a@a.test", "admin-password-1", "admin");
    await addUser(a.organization.id, "m@a.test", "manager-password-1", "manager");
    await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const manager = (await signIn("m@a.test", "manager-password-1")).cookie;
    expect((await request("/api/settings/email", { cookie: manager })).status).toBe(403);
    expect((await put(manager, smtp(25))).status).toBe(403);
    expect((await request("/api/settings/email", { method: "DELETE", cookie: manager })).status).toBe(403);
    expect((await request("/api/settings/email/test", { method: "POST", body: {}, cookie: manager })).status).toBe(403);
    expect((await request("/api/settings/email")).status).toBe(401);

    const aAdmin = (await signIn("a@a.test", "admin-password-1")).cookie;
    expect((await put(aAdmin, smtp(25))).status).toBe(200);
    const bAdmin = (await signIn("b@b.test", "admin-password-1")).cookie;
    expect(await (await request("/api/settings/email", { cookie: bAdmin })).json()).toEqual({ settings: null });
    expect(await isEmailConfigured(orgDb(a.organization.id))).toBe(true);
  });

  it("asks for the secret again when BETTER_AUTH_SECRET changed, without crashing", async () => {
    const cookie = await adminCookie();
    await put(cookie, smtp(25, { smtpUser: "mailer", secret: PASSWORD }));
    const org = await prisma.organization.findFirstOrThrow();
    await prisma.emailSettings.updateMany({ data: { secret: encryptSecret(PASSWORD, "an-older-secret-an-older-secret-0123") } });

    const { settings } = await (await request("/api/settings/email", { cookie })).json();
    expect(settings).toMatchObject({ hasSecret: false, secretUnreadable: true });
    expect(await isEmailConfigured(orgDb(org.id))).toBe(false);
    const sent = await sendMail(orgDb(org.id), mail);
    expect(sent).toEqual({ ok: false, error: "Enter the password again." });
    const test = await request("/api/settings/email/test", { method: "POST", body: {}, cookie });
    expect(test.status).toBe(502);
    expect((await test.json()).error).toBe("Enter the password again.");
    // Saving without a new password doesn't pretend the old one works.
    expect((await put(cookie, smtp(25, { smtpUser: "mailer" }))).status).toBe(400);
  });

  it("is read-only in the demo", async () => {
    const cookie = await adminCookie();
    process.env.DEMO_MODE = "true";
    expect(await (await request("/api/settings/email", { cookie })).json()).toEqual({ demo: true });
    expect((await put(cookie, smtp(25))).status).toBe(403);
    expect((await request("/api/settings/email", { method: "DELETE", cookie })).status).toBe(403);
    expect((await request("/api/settings/email/test", { method: "POST", body: {}, cookie })).status).toBe(403);
    expect(await prisma.emailSettings.count()).toBe(0);
  });
});

describe("sending through SMTP", () => {
  it("delivers to a real local mail server, with the right from, to and subject", async () => {
    const server = await startFakeSmtp({ user: "mailer", password: PASSWORD });
    try {
      const cookie = await adminCookie();
      await put(cookie, smtp(server.port, { smtpUser: "mailer", secret: PASSWORD }));
      expect(await isEmailConfigured(orgDb((await prisma.organization.findFirstOrThrow()).id))).toBe(true);

      const res = await request("/api/settings/email/test", { method: "POST", body: {}, cookie });
      expect(await res.json()).toEqual({ ok: true });
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toMatchObject({ from: "billing@studio.test", to: ["ada@example.com"], subject: "Test email" });

      const { settings } = await (await request("/api/settings/email", { cookie })).json();
      expect(settings.lastTestAt).toEqual(expect.any(String));
      expect(settings.lastError).toBeNull();

      // Both a plain-text and an HTML version are sent.
      const org = await prisma.organization.findFirstOrThrow();
      expect(await sendMail(orgDb(org.id), mail)).toEqual({ ok: true });
      const body = server.received[1]!.body;
      expect(server.received[1]).toMatchObject({ to: ["client@example.com"], subject: "Hello" });
      expect(body).toContain("text/plain");
      expect(body).toContain("text/html");
      expect(body).toContain("From: Studio North <billing@studio.test>");
    } finally {
      await server.close();
    }
  });

  it("saves a readable error when the server refuses the login or can't be reached", async () => {
    const server = await startFakeSmtp({ user: "mailer", password: PASSWORD });
    try {
      const cookie = await adminCookie();
      await put(cookie, smtp(server.port, { smtpUser: "mailer", secret: "wrong-password" }));
      const res = await request("/api/settings/email/test", { method: "POST", body: {}, cookie });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("The email server refused the username or password.");
      const { settings } = await (await request("/api/settings/email", { cookie })).json();
      expect(settings.lastError).toBe("The email server refused the username or password.");
      expect(settings.lastTestAt).toEqual(expect.any(String));
      expect(server.received).toHaveLength(0);

      // Nobody is listening here.
      const closed = await startFakeSmtp();
      const deadPort = closed.port;
      await closed.close();
      await put(cookie, smtp(deadPort));
      const dead = await (await request("/api/settings/email/test", { method: "POST", body: {}, cookie })).json();
      expect(dead.error).toBe(`Couldn't connect to the email server at 127.0.0.1:${deadPort}. Check the host, the port and the secure-connection setting.`);

      // The same for a name that resolves to more than one address (localhost: IPv4 and IPv6 both refuse), and for a host that doesn't exist.
      await put(cookie, smtp(deadPort, { smtpHost: "localhost" }));
      const localhost = await (await request("/api/settings/email/test", { method: "POST", body: {}, cookie })).json();
      expect(localhost.error).toBe(`Couldn't connect to the email server at localhost:${deadPort}. Check the host, the port and the secure-connection setting.`);
      await put(cookie, smtp(deadPort, { smtpHost: "no-such-host.invalid" }));
      const unknown = await (await request("/api/settings/email/test", { method: "POST", body: {}, cookie })).json();
      expect(unknown.error).toBe(`Couldn't connect to the email server at no-such-host.invalid:${deadPort}. Check the host, the port and the secure-connection setting.`);

      // A good send clears the error.
      await put(cookie, smtp(server.port, { smtpUser: "mailer", secret: PASSWORD }));
      expect((await request("/api/settings/email/test", { method: "POST", body: {}, cookie })).status).toBe(200);
      expect((await (await request("/api/settings/email", { cookie })).json()).settings.lastError).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("says so when email isn't turned on", async () => {
    await adminCookie();
    const org = await prisma.organization.findFirstOrThrow();
    expect(await isEmailConfigured(orgDb(org.id))).toBe(false);
    expect((await sendMail(orgDb(org.id), mail)).ok).toBe(false);
  });
});
