import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const PASSWORD = "a-long-enough-password";

async function adminOf(orgName: string, email: string) {
  const { organization, user } = await createOrgWithUser(orgName, email, "admin-password-1", "admin");
  const { cookie } = await signIn(email, "admin-password-1");
  return { organization, user, cookie };
}

async function invite(cookie: string, body: Record<string, unknown> = {}) {
  return request("/api/people/invites", { body: { name: "Maya Chen", email: "maya@studio.test", role: "member", ...body }, cookie });
}

async function accept(token: string, body: Record<string, unknown> = {}) {
  return request("/api/invites/accept", { body: { token, name: "Maya Chen", password: PASSWORD, ...body } });
}

describe("invites", () => {
  it("lets an admin invite someone, who then joins with their own password", async () => {
    const { cookie } = await adminOf("Studio North", "admin@studio.test");
    const res = await invite(cookie, { email: "  Maya@Studio.test ", role: "manager" });
    expect(res.status).toBe(201);
    const { invite: created, token } = await res.json();
    expect(created).toMatchObject({ name: "Maya Chen", email: "maya@studio.test", role: "manager" });
    expect(token).toMatch(/^[\w-]{43}$/);
    // Only a hash of the token is stored.
    expect(JSON.stringify(await prisma.invite.findMany())).not.toContain(token);

    expect(await (await request(`/api/invites/${token}`)).json()).toEqual({
      name: "Maya Chen", email: "maya@studio.test", organizationName: "Studio North", sso: null,
    });

    const joined = await accept(token, { name: "Maya C." });
    expect(joined.status).toBe(201);
    const me = await (await request("/api/me", { cookie: cookieFrom(joined) })).json();
    expect(me.user).toMatchObject({ name: "Maya C.", email: "maya@studio.test", role: "manager" });
    expect(me.organization.name).toBe("Studio North");
    expect((await signIn("maya@studio.test", PASSWORD)).res.status).toBe(200);

    // The link works once.
    expect((await accept(token)).status).toBe(404);
    expect((await request(`/api/invites/${token}`)).status).toBe(404);
    const { people, invites } = await (await request("/api/people", { cookie })).json();
    expect(people.map((p: { email: string }) => p.email)).toEqual(["admin@studio.test", "maya@studio.test"]);
    expect(invites).toEqual([]);
  });

  it("refuses expired links and old links after a new one is made", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const { invite: created, token } = await (await invite(cookie)).json();

    const renewed = await (await request(`/api/people/invites/${created.id}/renew`, { body: {}, cookie })).json();
    expect(renewed.token).not.toBe(token);
    expect((await request(`/api/invites/${token}`)).status).toBe(404);
    expect((await accept(token)).status).toBe(404);

    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(`/api/invites/${renewed.token}`)).status).toBe(404);
    expect((await accept(renewed.token)).status).toBe(404);
    expect(await prisma.user.count()).toBe(1);
  });

  it("can be cancelled", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const { invite: created, token } = await (await invite(cookie)).json();
    expect((await request(`/api/people/invites/${created.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await accept(token)).status).toBe(404);
  });

  it("checks names, emails, roles and passwords", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    expect((await invite(cookie, { name: " " })).status).toBe(400);
    expect((await invite(cookie, { email: "not-an-email" })).status).toBe(400);
    expect((await invite(cookie, { role: "owner" })).status).toBe(400);
    expect((await invite(cookie, { email: "admin@studio.test" })).status).toBe(409);
    expect((await invite(cookie)).status).toBe(201);
    expect((await invite(cookie)).status).toBe(409);

    const { token } = await (await request(`/api/people/invites/${(await prisma.invite.findFirstOrThrow()).id}/renew`, { body: {}, cookie })).json();
    expect((await accept(token, { password: "short" })).status).toBe(400);
    expect((await accept(token, { name: "" })).status).toBe(400);
    expect((await accept("made-up-token")).status).toBe(404);
  });

  it("refuses an invite whose email has since got an account", async () => {
    const { organization, cookie } = await adminOf("Studio", "admin@studio.test");
    const { token } = await (await invite(cookie)).json();
    await addUser(organization.id, "maya@studio.test", "some-other-password");
    expect((await accept(token)).status).toBe(409);
  });
});

describe("roles and accounts", () => {
  it("only lets admins manage people", async () => {
    const { organization } = await adminOf("Studio", "admin@studio.test");
    await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
    await addUser(organization.id, "member@studio.test", "member-password-1");
    for (const [email, password] of [["manager@studio.test", "manager-password-1"], ["member@studio.test", "member-password-1"]]) {
      const { cookie } = await signIn(email!, password!);
      expect((await request("/api/people", { cookie })).status).toBe(403);
      expect((await invite(cookie)).status).toBe(403);
    }
  });

  it("lets managers add clients and projects", async () => {
    const { organization } = await adminOf("Studio", "admin@studio.test");
    await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
    const { cookie } = await signIn("manager@studio.test", "manager-password-1");
    const client = await request("/api/clients", { body: { name: "Northwind" }, cookie });
    expect(client.status).toBe(201);
    const project = await request("/api/projects", { body: { name: "Brand refresh", clientId: (await client.json()).client.id }, cookie });
    expect(project.status).toBe(201);
    expect((await request("/api/settings/appearance", { method: "PUT", body: { accentColor: null, colorMode: "dark" }, cookie })).status).toBe(403);
  });

  it("changes someone's role, which applies straight away", async () => {
    const { organization, cookie } = await adminOf("Studio", "admin@studio.test");
    const member = await addUser(organization.id, "member@studio.test", "member-password-1");
    const { cookie: memberCookie } = await signIn("member@studio.test", "member-password-1");
    expect((await request("/api/projects", { body: { name: "P" }, cookie: memberCookie })).status).toBe(403);

    const res = await request(`/api/people/${member.id}`, { method: "PATCH", body: { role: "manager" }, cookie });
    expect((await res.json()).person).toMatchObject({ role: "manager", active: true });
    expect((await request("/api/projects", { body: { name: "P" }, cookie: memberCookie })).status).toBe(201);
    expect((await request(`/api/people/${member.id}`, { method: "PATCH", body: { role: "boss" }, cookie })).status).toBe(400);
  });

  it("never lets admins change themselves, so one admin always remains", async () => {
    const { user, cookie } = await adminOf("Studio", "admin@studio.test");
    expect((await request(`/api/people/${user.id}`, { method: "PATCH", body: { role: "member" }, cookie })).status).toBe(400);
    expect((await request(`/api/people/${user.id}`, { method: "PATCH", body: { active: false }, cookie })).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("admin");
  });

  it("turns an account off and on, keeping its time", async () => {
    const { organization, cookie } = await adminOf("Studio", "admin@studio.test");
    const member = await addUser(organization.id, "member@studio.test", "member-password-1");
    const { cookie: memberCookie } = await signIn("member@studio.test", "member-password-1");
    const project = await prisma.project.create({ data: { organizationId: organization.id, name: "P" } });
    await prisma.timeEntry.create({
      data: { organizationId: organization.id, userId: member.id, projectId: project.id, date: new Date("2026-10-15"), seconds: 60, billable: true },
    });

    const off = await request(`/api/people/${member.id}`, { method: "PATCH", body: { active: false }, cookie });
    expect((await off.json()).person.active).toBe(false);
    expect((await request("/api/me", { cookie: memberCookie })).status).toBe(401);
    const blocked = await signIn("member@studio.test", "member-password-1");
    expect(blocked.res.status).toBe(403);
    expect((await blocked.res.json()).message).toMatch(/turned off/);
    expect(await prisma.timeEntry.count()).toBe(1);

    await request(`/api/people/${member.id}`, { method: "PATCH", body: { active: true }, cookie });
    expect((await signIn("member@studio.test", "member-password-1")).res.status).toBe(200);
  });
});

describe("organization isolation for people and invites", () => {
  it("never shows or changes another organization's people or invites", async () => {
    const a = await adminOf("Org A", "a@a.test");
    const aMember = await addUser(a.organization.id, "member@a.test", "member-password-1");
    const { invite: aInvite, token } = await (await invite(a.cookie, { email: "new@a.test" })).json();
    const b = await adminOf("Org B", "b@b.test");

    const list = await (await request("/api/people", { cookie: b.cookie })).json();
    expect(list.people.map((p: { email: string }) => p.email)).toEqual(["b@b.test"]);
    expect(list.invites).toEqual([]);

    expect((await request(`/api/people/${aMember.id}`, { method: "PATCH", body: { active: false }, cookie: b.cookie })).status).toBe(404);
    expect((await request(`/api/people/${aMember.id}`, { method: "PATCH", body: { role: "admin" }, cookie: b.cookie })).status).toBe(404);
    expect((await request(`/api/people/invites/${aInvite.id}/renew`, { body: {}, cookie: b.cookie })).status).toBe(404);
    expect((await request(`/api/people/invites/${aInvite.id}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: aMember.id } })).toMatchObject({ role: "member", deactivatedAt: null });

    // Accepting A's invite joins A, whoever is signed in.
    const joined = await request("/api/invites/accept", { body: { token, name: "New", password: PASSWORD }, cookie: b.cookie });
    const me = await (await request("/api/me", { cookie: cookieFrom(joined) })).json();
    expect(me.organization.name).toBe("Org A");
  });
});

describe("editing a person", () => {
  it("lets an admin change someone's name and sign-in email, records it, and signs them out on a new email", async () => {
    const { organization, user: admin, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", PASSWORD, "member");
    const patch = (id: string, body: unknown, as = cookie) => request(`/api/people/${id}`, { method: "PATCH", body, cookie: as });

    // A new name alone keeps them signed in.
    const mayaSession = (await signIn("maya@studio.test", PASSWORD)).cookie;
    const renamed = await patch(maya.id, { name: "Maya Chen" });
    expect((await renamed.json()).person).toMatchObject({ name: "Maya Chen", email: "maya@studio.test" });
    expect((await request("/api/me", { cookie: mayaSession })).status).toBe(200);

    // A new email: stored lowercased, used to sign in from now on, and every old session ends.
    expect((await (await patch(maya.id, { email: "  Maya.Chen@Studio.test " })).json()).person.email).toBe("maya.chen@studio.test");
    expect((await request("/api/me", { cookie: mayaSession })).status).toBe(401);
    expect((await signIn("maya.chen@studio.test", PASSWORD)).res.status).toBe(200);
    expect((await signIn("maya@studio.test", PASSWORD)).res.status).not.toBe(200);

    const [event] = (await (await request("/api/history?kind=person", { cookie })).json()).events;
    expect(event.changes).toEqual([{ field: "email", from: "maya@studio.test", to: "maya.chen@studio.test" }]);

    // Admins can fix their own details too, though not their own role.
    expect((await patch(admin.id, { name: "Ada Admin" })).status).toBe(200);
    expect((await patch(admin.id, { role: "member" })).status).toBe(400);
  });

  it("keeps each sign-in email to one person, ignoring case, including open invites", async () => {
    const { organization, cookie } = await adminOf("Studio North", "admin@studio.test");
    const maya = await addUser(organization.id, "maya@studio.test", PASSWORD, "member");
    const other = await createOrgWithUser("Elsewhere", "sam@elsewhere.test", PASSWORD, "admin");
    const patch = (body: unknown) => request(`/api/people/${maya.id}`, { method: "PATCH", body, cookie });

    for (const email of ["ADMIN@studio.test", "sam@ELSEWHERE.test"]) {
      const res = await patch({ email });
      expect(res.status, email).toBe(409);
      expect((await res.json()).error).toBe("Someone with that email already has an account.");
    }
    expect((await invite(cookie, { name: "Theo", email: "theo@studio.test" })).status).toBe(201);
    expect((await patch({ email: "theo@studio.test" })).status).toBe(409);
    expect((await patch({ email: "not-an-email" })).status).toBe(400);
    expect((await patch({ name: "   " })).status).toBe(400);
    // Saving their own address again changes nothing.
    expect((await patch({ email: "Maya@Studio.test" })).status).toBe(200);
    expect(other.user.email).toBe("sam@elsewhere.test");
  });

  it("is for admins only", async () => {
    const { organization } = await adminOf("Studio North", "admin@studio.test");
    await addUser(organization.id, "maya@studio.test", PASSWORD, "manager");
    const theo = await addUser(organization.id, "theo@studio.test", PASSWORD, "member");
    const { cookie: manager } = await signIn("maya@studio.test", PASSWORD);
    expect((await request(`/api/people/${theo.id}`, { method: "PATCH", body: { name: "T" }, cookie: manager })).status).toBe(403);
  });
});
