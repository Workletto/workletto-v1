import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// User groups (WRK-149): teams or departments that filter Reports, Team, Schedule and Approvals,
// add their people to a project in one step and show in exports, without changing anyone's role.

beforeEach(resetDatabase);

const WEEK = "2026-10-12";

async function studio(name = "Studio", domain = "studio.test") {
  const { organization } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  const manager = await addUser(organization.id, `max@${domain}`, "manager-password-1", "manager");
  const ada = await addUser(organization.id, `ada@${domain}`, "member-password-1", "member");
  const ben = await addUser(organization.id, `ben@${domain}`, "member-password-1", "member");
  const cookies = {
    admin: (await signIn(`admin@${domain}`, "admin-password-1")).cookie,
    manager: (await signIn(`max@${domain}`, "manager-password-1")).cookie,
    ada: (await signIn(`ada@${domain}`, "member-password-1")).cookie,
    ben: (await signIn(`ben@${domain}`, "member-password-1")).cookie,
  };
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: cookies.admin, ...init });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const project = (await json("/api/projects", { body: { name: "Brand", hourlyRate: 10_000 } })).body.project;
  return { organization, manager, ada, ben, cookies, json, project };
}

describe("making groups", () => {
  it("is for admins; managers can see them; a person can be in several", async () => {
    const s = await studio();
    const design = await s.json("/api/groups", { body: { name: "Design", memberIds: [s.ada.id, s.ben.id] } });
    expect(design.status).toBe(201);
    expect(design.body.group).toMatchObject({ name: "Design", memberIds: expect.arrayContaining([s.ada.id, s.ben.id]) });
    expect((await s.json("/api/groups", { body: { name: "Studio B", memberIds: [s.ada.id] } })).status).toBe(201);
    expect((await s.json("/api/groups", { body: { name: "design" } })).status).toBe(409);
    expect((await s.json("/api/groups", { body: { name: "Ops" }, cookie: s.cookies.manager })).status).toBe(403);
    expect((await s.json("/api/groups", { cookie: s.cookies.ada })).status).toBe(403);
    const listed = (await s.json("/api/groups", { cookie: s.cookies.manager })).body.groups;
    expect(listed.map((g: { name: string }) => g.name)).toEqual(["Design", "Studio B"]);

    const renamed = await s.json(`/api/groups/${design.body.group.id}`, { method: "PATCH", body: { name: "Designers", memberIds: [s.ben.id] } });
    expect(renamed.body.group).toEqual({ id: design.body.group.id, name: "Designers", memberIds: [s.ben.id] });
    expect((await s.json(`/api/groups/${design.body.group.id}`, { method: "DELETE" })).status).toBe(200);
    // Deleting a group keeps its people.
    expect(await prisma.user.count({ where: { organizationId: s.organization.id } })).toBe(4);
    expect(await prisma.auditEvent.count({ where: { label: { startsWith: "Group " } } })).toBe(4);
  });
});

// Many requests across four screens: slower than the 5 s default on a busy machine.
describe("filtering by group", { timeout: 20_000 }, () => {
  it("narrows Reports, the Team page, the Schedule and Approvals to the group's people", async () => {
    const s = await studio();
    await s.json("/api/settings/timesheets", { method: "PUT", body: { approvals: true } });
    const group = (await s.json("/api/groups", { body: { name: "Design", memberIds: [s.ada.id] } })).body.group;
    for (const [cookie, seconds] of [[s.cookies.ada, 3600], [s.cookies.ben, 7200]] as const) {
      expect((await s.json("/api/time-entries", { body: { projectId: s.project.id, date: WEEK, seconds }, cookie })).status).toBe(201);
      expect((await s.json(`/api/timesheets/mine/${WEEK}/submit`, { body: {}, cookie })).status).toBe(200);
    }
    const q = `groupId=${group.id}`;
    const report = (await s.json(`/api/reports/summary?from=${WEEK}&to=${WEEK}&groupBy=person&${q}`, { cookie: s.cookies.manager })).body;
    expect(report.rows.map((r: { label: string }) => r.label)).toEqual(["ada"]);
    expect(report.totals.seconds).toBe(3600);
    const team = (await s.json(`/api/team?week=${WEEK}&${q}`, { cookie: s.cookies.manager })).body;
    expect(team.people.map((p: { name: string }) => p.name)).toEqual(["ada"]);
    const schedule = (await s.json(`/api/schedule?from=${WEEK}&${q}`, { cookie: s.cookies.manager })).body;
    expect(schedule.people.map((p: { name: string }) => p.name)).toEqual(["ada"]);
    const approvals = (await s.json(`/api/timesheets?status=submitted&${q}`, { cookie: s.cookies.manager })).body;
    expect(approvals.weeks.map((w: { person: { name: string } }) => w.person.name)).toEqual(["ada"]);
    // Without a group, everyone.
    expect((await s.json(`/api/team?week=${WEEK}`, { cookie: s.cookies.manager })).body.people).toHaveLength(4);
  });

  it("doesn't change what anyone can see: a member's report stays their own", async () => {
    const s = await studio();
    const group = (await s.json("/api/groups", { body: { name: "Design", memberIds: [s.ada.id, s.ben.id] } })).body.group;
    await s.json("/api/time-entries", { body: { projectId: s.project.id, date: WEEK, seconds: 3600 }, cookie: s.cookies.ada });
    await s.json("/api/time-entries", { body: { projectId: s.project.id, date: WEEK, seconds: 7200 }, cookie: s.cookies.ben });
    const asAda = (await s.json(`/api/reports/summary?from=${WEEK}&to=${WEEK}&groupId=${group.id}`, { cookie: s.cookies.ada })).body;
    expect(asAda.totals.seconds).toBe(3600);
    expect((await s.json(`/api/team?week=${WEEK}&groupId=${group.id}`, { cookie: s.cookies.ada })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.ada.id } })).role).toBe("member");
  });
});

describe("adding a group to a project", () => {
  it("puts its active people on the project's team, once", async () => {
    const s = await studio();
    await prisma.user.update({ where: { id: s.ben.id }, data: { deactivatedAt: new Date() } });
    const group = (await s.json("/api/groups", { body: { name: "Design", memberIds: [s.ada.id, s.ben.id] } })).body.group;
    const added = await s.json(`/api/groups/${group.id}/add-to-project`, { body: { projectId: s.project.id }, cookie: s.cookies.manager });
    expect(added.body).toEqual({ added: 1 });
    const project = (await s.json(`/api/projects/${s.project.id}`)).body.project;
    expect(project).toMatchObject({ everyone: false, memberIds: [s.ada.id] });
    expect((await s.json(`/api/groups/${group.id}/add-to-project`, { body: { projectId: s.project.id } })).body).toEqual({ added: 0 });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { subjectId: s.project.id, kind: "project", action: "changed" } });
    expect(JSON.stringify(event.changes)).toContain("Added group Design (1 person)");
  });
});

describe("exports and isolation", () => {
  it("adds a Groups column, and keeps each organization's groups to itself", async () => {
    const s = await studio();
    const other = await studio("Other", "other.test");
    await s.json("/api/groups", { body: { name: "Design", memberIds: [s.ada.id] } });
    await s.json("/api/groups", { body: { name: "Studio B", memberIds: [s.ada.id] } });
    await s.json("/api/time-entries", { body: { projectId: s.project.id, date: WEEK, seconds: 3600 }, cookie: s.cookies.ada });
    const csv = await (await request(`/api/data/export/time?from=${WEEK}&to=${WEEK}`, { cookie: s.cookies.admin })).text();
    const [header, line] = csv.trim().split(/\r?\n/);
    expect(header!.endsWith(",Invoiced,Groups")).toBe(true);
    expect(line!.endsWith(',"Design, Studio B"')).toBe(true);
    const entries = (await s.json(`/api/reports/entries?from=${WEEK}&to=${WEEK}`)).body.entries;
    expect(entries[0].groups).toBe("Design, Studio B");

    const theirs = (await other.json("/api/groups", { body: { name: "Theirs", memberIds: [other.ada.id] } })).body.group;
    expect((await s.json("/api/groups")).body.groups.map((g: { name: string }) => g.name)).toEqual(["Design", "Studio B"]);
    expect((await s.json(`/api/groups/${theirs.id}`, { method: "PATCH", body: { name: "Mine" } })).status).toBe(404);
    expect((await s.json(`/api/groups/${theirs.id}/add-to-project`, { body: { projectId: s.project.id } })).status).toBe(404);
    expect((await s.json("/api/groups", { body: { name: "Mixed", memberIds: [other.ada.id] } })).status).toBe(400);
    // Another organization's group filters to nobody here.
    expect((await s.json(`/api/team?week=${WEEK}&groupId=${theirs.id}`)).body.people).toEqual([]);
  });
});
