import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);

const OLD = "old-password-1234";
const NEW = "a-brand-new-password";

async function adminOf(orgName: string, email: string) {
  const { organization, user } = await createOrgWithUser(orgName, email, "admin-password-1", "admin");
  const { cookie } = await signIn(email, "admin-password-1");
  return { organization, user, cookie };
}
const makeLink = (cookie: string, id: string) => request(`/api/people/${id}/reset-link`, { body: {}, cookie });
const useLink = (token: unknown, password: unknown = NEW, ip?: string) => request("/api/password-reset", { body: { token, password }, ip });
const whoFor = (token: string) => request(`/api/password-reset/${token}`);

describe("reset links from an admin", () => {
  it("let someone choose a new password, sign them in, and sign them out everywhere else", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const old = await signIn("maya@studio.test", OLD);
    expect(old.res.status).toBe(200);

    const res = await makeLink(cookie, maya.id);
    expect(res.status).toBe(201);
    const { token, expiresAt } = await res.json();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // Only a hash of the token is stored.
    expect(JSON.stringify(await prisma.passwordReset.findMany())).not.toContain(token);
    expect(await (await whoFor(token)).json()).toEqual({ name: "maya", email: "maya@studio.test", organizationName: "Studio North" });

    const used = await useLink(token);
    expect(used.status).toBe(200);
    const me = await (await request("/api/me", { cookie: cookieFrom(used) })).json();
    expect(me.user.email).toBe("maya@studio.test");
    // The old session is gone, the old password no longer works, the new one does.
    expect((await request("/api/me", { cookie: old.cookie })).status).toBe(401);
    expect((await signIn("maya@studio.test", OLD)).res.status).toBe(401);
    expect((await signIn("maya@studio.test", NEW)).res.status).toBe(200);
    // The link worked once.
    expect((await useLink(token)).status).toBe(404);
    expect((await whoFor(token)).status).toBe(404);
  });

  it("replace an older link, and refuse expired, used and made-up ones", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const first = (await (await makeLink(cookie, maya.id)).json()).token;
    const second = (await (await makeLink(cookie, maya.id)).json()).token;
    expect(await prisma.passwordReset.count()).toBe(1);
    expect((await whoFor(first)).status).toBe(404);
    expect((await whoFor(second)).status).toBe(200);

    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await whoFor(second)).status).toBe(404);
    expect((await useLink(second)).status).toBe(404);
    expect((await useLink("made-up-token")).status).toBe(404);
    expect((await useLink(undefined)).status).toBe(404);
    expect((await signIn("maya@studio.test", OLD)).res.status).toBe(200);
  });

  it("check the password, and keep the link for another go", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const { token } = await (await makeLink(cookie, maya.id)).json();
    const short = await useLink(token, "short");
    expect(short.status).toBe(400);
    expect((await short.json()).error).toMatch(/10 to 128 characters/);
    expect((await useLink(token, 12345)).status).toBe(400);
    expect((await useLink(token)).status).toBe(200);
  });

  it("are for admins, about other people who have a login and aren't turned off", async () => {
    const { organization, user: admin, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const off = await addUser(organization.id, "olly@studio.test", OLD);
    await prisma.user.update({ where: { id: off.id }, data: { deactivatedAt: new Date() } });
    const imported = await prisma.user.create({ data: { name: "Imported", email: "imported@no-login.invalid", organizationId: organization.id } });
    const { user: elsewhere } = await createOrgWithUser("Other Studio", "other@elsewhere.test", OLD);

    expect((await makeLink(cookie, admin.id)).status).toBe(400);
    expect((await makeLink(cookie, off.id)).status).toBe(409);
    expect((await makeLink(cookie, imported.id)).status).toBe(409);
    expect((await makeLink(cookie, elsewhere.id)).status).toBe(404);
    expect((await makeLink(cookie, maya.id)).status).toBe(201);

    const member = await signIn("maya@studio.test", OLD);
    expect((await makeLink(member.cookie, admin.id)).status).toBe(403);
    expect((await request(`/api/people/${admin.id}/reset-link`, { body: {} })).status).toBe(401);
  });

  it("stop working for someone who gets turned off meanwhile", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const { token } = await (await makeLink(cookie, maya.id)).json();
    await prisma.user.update({ where: { id: maya.id }, data: { deactivatedAt: new Date() } });
    expect((await whoFor(token)).status).toBe(404);
    expect((await useLink(token)).status).toBe(404);
  });

  it("are slowed down per address", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", OLD);
    const { token } = await (await makeLink(cookie, maya.id)).json();
    for (let i = 0; i < 10; i++) expect((await useLink("guess", NEW, "203.0.113.5")).status).toBe(404);
    expect((await useLink(token, NEW, "203.0.113.5")).status).toBe(429);
    expect((await useLink(token, NEW, "203.0.113.6")).status).toBe(200);
  });
});

describe("changing your own password", () => {
  const change = (cookie: string, currentPassword: string, newPassword: string, ip?: string) =>
    request("/api/auth/change-password", { body: { currentPassword, newPassword, revokeOtherSessions: true }, cookie, ip });

  it("needs the current password, then signs other sessions out", async () => {
    const { cookie } = await adminOf("Studio North", "admin@studio.test");
    const other = await signIn("admin@studio.test", "admin-password-1");

    expect((await change(cookie, "not-my-password", NEW)).status).toBe(400);
    expect((await change(cookie, "admin-password-1", "short")).status).toBe(400);

    const res = await change(cookie, "admin-password-1", NEW);
    expect(res.status).toBe(200);
    // This browser stays signed in (on a fresh session cookie, if the server sent one); the other one is out.
    const mine = res.headers.getSetCookie().length ? cookieFrom(res) : cookie;
    expect((await request("/api/me", { cookie: mine })).status).toBe(200);
    expect((await request("/api/me", { cookie: other.cookie })).status).toBe(401);
    expect((await signIn("admin@studio.test", "admin-password-1")).res.status).toBe(401);
    expect((await signIn("admin@studio.test", NEW)).res.status).toBe(200);
  });

  it("is slowed down per address", async () => {
    const { cookie } = await adminOf("Studio North", "admin@studio.test");
    for (let i = 0; i < 10; i++) expect((await change(cookie, "not-my-password", NEW)).status).toBe(400);
    expect((await change(cookie, "admin-password-1", NEW)).status).toBe(429);
    expect((await change(cookie, "admin-password-1", NEW, "198.51.100.3")).status).toBe(200);
  });
});

describe("reset links by email", () => {
  const ask = (email: unknown, ip?: string) => request("/api/password-reset/request", { body: { email }, ip });
  const smtpSettings = (port: number) => ({ provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "" });
  const turnOnEmail = (cookie: string, port: number) => request("/api/settings/email", { method: "PUT", body: smtpSettings(port), cookie });
  // Mail bodies arrive quoted-printable: soft line breaks and =XX escapes.
  const plain = (body: string) => body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  it("email a link that works for an hour; the answer never says whether the address exists", async () => {
    const fake = await startFakeSmtp();
    try {
      const { cookie } = await adminOf("Studio North", "admin@studio.test");
      const { organization } = await prisma.user.findFirstOrThrow({ where: { email: "admin@studio.test" }, select: { organization: true } });
      await addUser(organization.id, "maya@studio.test", OLD);
      await prisma.installation.create({ data: { id: 1, organizationId: organization.id } });
      await expect((await request("/api/setup/status")).json()).resolves.toMatchObject({ passwordResetByEmail: false });
      expect((await turnOnEmail(cookie, fake.port)).status).toBe(200);
      await expect((await request("/api/setup/status")).json()).resolves.toMatchObject({ passwordResetByEmail: true });

      expect((await ask("  Maya@Studio.test ")).status).toBe(200);
      expect((await ask("nobody@studio.test")).status).toBe(200);
      // The email goes out after the answer, so the answer takes as long whether or not the address has a login.
      for (let i = 0; i < 50 && fake.received.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
      expect(fake.received).toHaveLength(1);
      const mail = fake.received[0]!;
      expect(mail.to).toEqual(["maya@studio.test"]);
      expect(mail.subject).toBe("Reset your password for Studio North");
      const token = /http:\/\/localhost:3000\/reset\/([\w-]{43})/.exec(plain(mail.body))?.[1];
      expect(token).toBeTruthy();
      const row = await prisma.passwordReset.findFirstOrThrow();
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);

      expect((await useLink(token)).status).toBe(200);
      expect((await signIn("maya@studio.test", NEW)).res.status).toBe(200);
      expect((await signIn("maya@studio.test", OLD)).res.status).toBe(401);
    } finally {
      await fake.close();
    }
  });

  it("send nothing when email is off, for people who are turned off, or for addresses nobody has", async () => {
    const fake = await startFakeSmtp();
    try {
      const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
      const maya = await addUser(organization.id, "maya@studio.test", OLD);
      expect((await ask("maya@studio.test", "203.0.113.21")).status).toBe(200); // email is off
      expect(await prisma.passwordReset.count()).toBe(0);

      expect((await turnOnEmail(cookie, fake.port)).status).toBe(200);
      await prisma.user.update({ where: { id: maya.id }, data: { deactivatedAt: new Date() } });
      expect((await ask("maya@studio.test", "203.0.113.22")).status).toBe(200);
      expect((await ask("nobody@studio.test", "203.0.113.23")).status).toBe(200);
      expect((await ask("", "203.0.113.24")).status).toBe(400);
      expect((await ask(42, "203.0.113.25")).status).toBe(400);
      // Someone added by an import has no login: their first one comes from an invitation.
      const imported = await addUser(organization.id, "alex@alexdesign.test", OLD);
      await prisma.account.deleteMany({ where: { userId: imported.id } });
      expect((await ask("alex@alexdesign.test", "203.0.113.26")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(fake.received).toHaveLength(0);
      expect(await prisma.passwordReset.count()).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("are slowed down per address and per email", async () => {
    for (let i = 0; i < 3; i++) expect((await ask(`p${i}@studio.test`, "203.0.113.9")).status).toBe(200);
    expect((await ask("p9@studio.test", "203.0.113.9")).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await ask("same@studio.test", `198.51.100.${i + 1}`)).status).toBe(200);
    expect((await ask("same@studio.test", "198.51.100.9")).status).toBe(429);
  });
});
