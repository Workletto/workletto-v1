import { beforeEach, describe, expect, it } from "vitest";
import { orgDb, OrgScopeError, prisma } from "../src/server/db.ts";
import { createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

// The demo runs many organizations in one database, so one organization must
// never see or change another's rows on any route.
describe("organization isolation", () => {
  it("shows each person only their own organization's members", async () => {
    await createOrgWithUser("Org A", "a@example.com", "password-for-a");
    await createOrgWithUser("Org B", "b@example.com", "password-for-b");

    const { cookie } = await signIn("a@example.com", "password-for-a");
    const me = await (await request("/api/me", { cookie })).json();
    expect(me.organization.name).toBe("Org A");
    const { members } = await (await request("/api/members", { cookie })).json();
    expect(members.map((m: { name: string }) => m.name)).toEqual(["a"]);
  });

  it("cannot change organization or role through the profile endpoint", async () => {
    const a = await createOrgWithUser("Org A", "a@example.com", "password-for-a");
    const b = await createOrgWithUser("Org B", "b@example.com", "password-for-b");
    const { cookie } = await signIn("a@example.com", "password-for-a");

    await request("/api/auth/update-user", { body: { organizationId: b.organization.id, role: "admin" }, cookie });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
    expect(user.organizationId).toBe(a.organization.id);
    expect(user.role).toBe("member");
  });

  it("orgDb only reads and writes its own organization's rows", async () => {
    const a = await createOrgWithUser("Org A", "a@example.com", "password-for-a");
    const b = await createOrgWithUser("Org B", "b@example.com", "password-for-b");
    const db = orgDb(a.organization.id);

    expect(await db.user.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: b.user.id } })).toBeNull();
    expect(await db.user.findFirst({ where: { email: "b@example.com" } })).toBeNull();
    expect((await db.user.updateMany({ data: { name: "renamed" } })).count).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })).name).not.toBe("renamed");
    expect((await db.user.deleteMany({ where: { id: b.user.id } })).count).toBe(0);
    await expect(db.user.update({ where: { id: b.user.id }, data: { name: "x" } })).rejects.toThrow();

    const org = await db.organization.findFirstOrThrow();
    expect(org.id).toBe(a.organization.id);
    expect(await db.organization.findMany()).toHaveLength(1);
  });

  it("orgDb stamps new rows with its organization and refuses to move them", async () => {
    const a = await createOrgWithUser("Org A", "a@example.com", "password-for-a");
    const b = await createOrgWithUser("Org B", "b@example.com", "password-for-b");
    const db = orgDb(a.organization.id);

    const created = await db.user.create({ data: { name: "New", email: "new@example.com" } as never });
    expect(created.organizationId).toBe(a.organization.id);

    await expect(
      db.user.create({ data: { name: "Sneaky", email: "s@example.com", organizationId: b.organization.id } }),
    ).rejects.toBeInstanceOf(OrgScopeError);
    await expect(
      db.user.updateMany({ data: { organizationId: b.organization.id } }),
    ).rejects.toBeInstanceOf(OrgScopeError);
    await expect(db.organization.create({ data: { name: "Another" } })).rejects.toBeInstanceOf(OrgScopeError);
    await expect(db.session.findMany()).rejects.toBeInstanceOf(OrgScopeError);
  });
});
