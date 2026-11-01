import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeOidc, type FakeProfile } from "./fakeOidc.ts";
import { profileToUser } from "../src/server/sso.ts";

// Single sign-on (WRK-136), through a real OpenID Connect sign-in against a fake provider.

const CLIENT_ID = "workletto-test";
const CLIENT_SECRET = "s3cret-from-the-provider";
let fake: Awaited<ReturnType<typeof startFakeOidc>>;
beforeAll(async () => {
  fake = await startFakeOidc(CLIENT_ID, CLIENT_SECRET);
});
afterAll(() => fake.close());
beforeEach(resetDatabase);

async function studio(settings: { allowJoin?: boolean; requireSso?: boolean } = {}) {
  const { organization, user: admin } = await createOrgWithUser("Studio", "ada@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "mo@studio.test", "member-password-1");
  const adminCookie = (await signIn("ada@studio.test", "admin-password-1")).cookie;
  const save = (body: Record<string, unknown> = {}) =>
    request("/api/settings/sso", {
      method: "PUT",
      cookie: adminCookie,
      body: { providerName: "Google Workspace", issuer: fake.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, domain: "studio.test", allowJoin: false, requireSso: false, ...settings, ...body },
    });
  return { organization, admin, member, adminCookie, save };
}

/** Signs in through the provider as `profile`, the way a browser would: start, approve, come back. */
async function viaProvider(profile: FakeProfile) {
  const start = await request("/api/auth/sign-in/social", { body: { provider: "sso", callbackURL: "/", errorCallbackURL: "/sign-in" } });
  if (!start.ok) return { status: start.status, location: null, cookie: "" };
  const { url } = await start.json();
  const { code, state } = fake.approve(url, profile);
  const back = await request(`/api/auth/callback/sso?code=${code}&state=${encodeURIComponent(state)}`, { cookie: cookieFrom(start) });
  return { status: back.status, location: back.headers.get("location"), cookie: cookieFrom(back) };
}

const me = async (cookie: string) => {
  const res = await request("/api/me", { cookie });
  return res.ok ? (await res.json()).user : null;
};
const errorOf = (location: string | null) => (location ? new URL(location, "http://x").searchParams.get("error") : null);

describe("single sign-on settings", () => {
  it("are for admins, check the provider, and never show the secret", async () => {
    const s = await studio();
    const managerCookie = (await (async () => {
      await addUser(s.organization.id, "max@studio.test", "manager-password-1", "manager");
      return (await signIn("max@studio.test", "manager-password-1")).cookie;
    })());
    expect((await request("/api/settings/sso", { cookie: managerCookie })).status).toBe(403);

    expect((await (await s.save({ issuer: "http://idp.example.com" })).json()).error).toBe("Enter the provider's issuer address, starting with https://.");
    expect((await (await s.save({ domain: "not a domain" })).json()).error).toBe("Enter your email domain, like yourstudio.com.");
    expect((await (await s.save({ issuer: `${fake.issuer}/wrong` })).json()).error).toMatch(/^The provider didn't answer at|^Couldn't read the provider's settings at/);
    expect((await s.save()).status).toBe(200);

    const { settings, callbackUrl } = await (await request("/api/settings/sso", { cookie: s.adminCookie })).json();
    expect(settings).toMatchObject({ providerName: "Google Workspace", issuer: fake.issuer, clientId: CLIENT_ID, domain: "studio.test", hasSecret: true, secretUnreadable: false });
    expect(JSON.stringify(settings)).not.toContain(CLIENT_SECRET);
    expect(callbackUrl).toMatch(/\/api\/auth\/callback\/sso$/);
    // Saved again without a new secret, it keeps the one it has.
    expect((await s.save({ clientSecret: "" })).status).toBe(200);
  });

  it("switch sign-in through a provider on and off without a restart", async () => {
    const s = await studio();
    expect((await viaProvider({ sub: "1", email: "mo@studio.test" })).status).toBe(404);
    await s.save();
    const signedIn = await viaProvider({ sub: "1", email: "mo@studio.test" });
    expect(signedIn.location).toBe("/");
    expect((await request("/api/settings/sso", { method: "DELETE", cookie: s.adminCookie })).status).toBe(200);
    expect((await viaProvider({ sub: "1", email: "mo@studio.test" })).status).toBe(404);
  });
});

describe("signing in through the provider", () => {
  it("signs in someone already in the organization, by their email", async () => {
    const s = await studio();
    await s.save();
    const { location, cookie } = await viaProvider({ sub: "google-mo", email: "Mo@Studio.test", name: "Mo" });
    expect(location).toBe("/");
    expect(await me(cookie)).toMatchObject({ id: s.member.id, email: "mo@studio.test", role: "member" });
    // The next time, the linked account is used.
    expect((await viaProvider({ sub: "google-mo", email: "mo@studio.test" })).location).toBe("/");
  });

  it("brings in an invited person with their invitation's role, and uses the invitation up", async () => {
    const s = await studio();
    await s.save();
    await request("/api/people/invites", { body: { name: "Ines", email: "ines@studio.test", role: "manager" }, cookie: s.adminCookie });
    const { location, cookie } = await viaProvider({ sub: "google-ines", email: "ines@studio.test", name: "Ines Ortiz" });
    expect(location).toBe("/");
    expect(await me(cookie)).toMatchObject({ email: "ines@studio.test", role: "manager", name: "Ines Ortiz" });
    expect(await prisma.user.findUniqueOrThrow({ where: { email: "ines@studio.test" }, select: { organizationId: true } })).toEqual({ organizationId: s.organization.id });
    expect(await prisma.invite.count({ where: { email: "ines@studio.test" } })).toBe(0);
  });

  it("turns away people who weren't invited, unless anyone at the domain may join", async () => {
    const s = await studio();
    await s.save();
    const stranger = await viaProvider({ sub: "google-sam", email: "sam@studio.test" });
    expect(stranger.location).toMatch(/^\/sign-in\?/);
    expect(errorOf(stranger.location)).toBe("not_invited");
    expect(await prisma.user.count({ where: { email: "sam@studio.test" } })).toBe(0);

    await s.save({ allowJoin: true });
    const { cookie } = await viaProvider({ sub: "google-sam", email: "sam@studio.test" });
    expect(await me(cookie)).toMatchObject({ email: "sam@studio.test", role: "member" });
  });

  it("only lets in emails at the domain, that the provider has verified", async () => {
    const s = await studio({ allowJoin: true });
    await s.save();
    expect(errorOf((await viaProvider({ sub: "x", email: "someone@gmail.com" })).location)).toBe("wrong_domain");
    const unverified = await viaProvider({ sub: "y", email: "new@studio.test", email_verified: false });
    expect(errorOf(unverified.location)).toBe("email_not_verified");
    expect(await prisma.user.count({ where: { email: "new@studio.test" } })).toBe(0);
    // Nor can an unverified email reach someone already here.
    const existing = await viaProvider({ sub: "z", email: "mo@studio.test", email_verified: false });
    expect(existing.location).toMatch(/^\/sign-in\?error=/);
    expect(await me(existing.cookie)).toBeNull();
  });

  it("counts an email the provider doesn't call verified as unverified, except from Microsoft Entra", () => {
    const entra = "https://login.microsoftonline.com/0c4b1b7e-tenant/v2.0";
    const other = "https://idp.example.test";
    expect(profileToUser({ email: "mo@studio.test" }, entra).emailVerified).toBe(true);
    expect(profileToUser({ email: "mo@studio.test" }, other).emailVerified).toBe(false);
    expect(profileToUser({ email: "mo@studio.test", email_verified: true }, other).emailVerified).toBe(true);
    expect(profileToUser({ email: "mo@studio.test", email_verified: "true" }, other).emailVerified).toBe(true);
    expect(profileToUser({ email: "mo@studio.test", email_verified: false }, entra).emailVerified).toBe(false);
    for (const issuer of ["https://login.microsoftonline.us/t/v2.0", "https://login.partner.microsoftonline.cn/t/v2.0", "https://sts.windows.net/t/"]) {
      expect(profileToUser({ email: "mo@studio.test" }, issuer).emailVerified).toBe(true);
    }
    expect(profileToUser({ email: "mo@studio.test" }, "https://login.microsoftonline.com.evil.test/").emailVerified).toBe(false);
  });

  it("never reaches another organization's people, or people who are turned off", async () => {
    const s = await studio();
    await s.save();
    const other = await createOrgWithUser("Other", "olga@studio.test", "other-password-1", "admin");
    const elsewhere = await viaProvider({ sub: "google-olga", email: "olga@studio.test" });
    expect(errorOf(elsewhere.location)).toBe("not_invited");
    expect(await prisma.account.count({ where: { userId: other.user.id, providerId: "sso" } })).toBe(0);

    await prisma.user.update({ where: { id: s.member.id }, data: { deactivatedAt: new Date() } });
    const off = await viaProvider({ sub: "google-mo", email: "mo@studio.test" });
    expect(off.location).toMatch(/^\/sign-in\?error=/);
    expect(await me(off.cookie)).toBeNull();
  });
});

describe("requiring single sign-on", () => {
  it("lets only admins use a password, without saying who has an account", async () => {
    const s = await studio({ requireSso: true });
    await s.save();
    const member = await signIn("mo@studio.test", "member-password-1");
    expect(member.res.status).toBe(403);
    expect((await member.res.json()).message).toBe("Your organization signs in with Google Workspace. Use “Sign in with Google Workspace” instead.");
    // A wrong password gets the usual answer, so nobody learns who's a member.
    expect((await signIn("mo@studio.test", "wrong-password-1")).res.status).toBe(401);
    expect((await signIn("ada@studio.test", "admin-password-1")).res.status).toBe(200);
    expect((await viaProvider({ sub: "google-mo", email: "mo@studio.test" })).location).toBe("/");
  });

  it("asks invited people to join through the provider instead of choosing a password", async () => {
    const s = await studio({ requireSso: true });
    await s.save();
    const { token } = await (await request("/api/people/invites", { body: { name: "Ines", email: "ines@studio.test", role: "member" }, cookie: s.adminCookie })).json();
    expect((await (await request(`/api/invites/${token}`)).json()).sso).toEqual({ name: "Google Workspace", required: true });
    const accept = await request("/api/invites/accept", { body: { token, name: "Ines", password: "a-long-password-1" } });
    expect(accept.status).toBe(409);
  });
});

describe("passwords for people who joined through the provider", () => {
  it("can be set with an admin's reset link, unless single sign-on is required for them", async () => {
    const s = await studio({ allowJoin: true });
    await s.save();
    await viaProvider({ sub: "google-sam", email: "sam@studio.test", name: "Sam" });
    const sam = await prisma.user.findUniqueOrThrow({ where: { email: "sam@studio.test" } });
    const link = async () => (await (await request(`/api/people/${sam.id}/reset-link`, { body: {}, cookie: s.adminCookie })).json()).token;

    const reset = await request("/api/password-reset", { body: { token: await link(), password: "sams-first-password" } });
    expect(reset.status).toBe(200);
    expect((await signIn("sam@studio.test", "sams-first-password")).res.status).toBe(200);

    await s.save({ allowJoin: true, requireSso: true });
    const refused = await request("/api/password-reset", { body: { token: await link(), password: "another-password-1" } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("Your organization signs in with Google Workspace, so you don't need a password. Use “Sign in with Google Workspace” instead.");
  });
});
