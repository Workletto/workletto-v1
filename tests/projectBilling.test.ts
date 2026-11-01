import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const other = await addUser(organization.id, "other@studio.test", "other-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  return { organization, admin, member, other, adminCookie, memberCookie };
}

const createProject = async (cookie: string, body: Record<string, unknown>) =>
  request("/api/projects", { body: { name: "Website", ...body }, cookie });

describe("project teams", () => {
  it("lets members see and track only projects that are open to everyone or that they're on", async () => {
    const s = await studio();
    const open = (await (await createProject(s.adminCookie, { name: "Open" })).json()).project;
    const mine = (await (await createProject(s.adminCookie, { name: "Mine", everyone: false, memberIds: [s.member.id] })).json()).project;
    const closed = (await (await createProject(s.adminCookie, { name: "Closed", everyone: false, memberIds: [s.other.id] })).json()).project;
    expect(mine).toMatchObject({ everyone: false, memberIds: [s.member.id] });

    const { projects } = await (await request("/api/projects", { cookie: s.memberCookie })).json();
    expect(projects.map((p: { name: string }) => p.name).sort()).toEqual(["Mine", "Open"]);
    // Members don't see rates, budgets or teams.
    expect(projects[0]).not.toHaveProperty("hourlyRate");
    expect(projects[0]).not.toHaveProperty("memberIds");

    const entry = (projectId: string) => request("/api/time-entries", { body: { projectId, date: TODAY, seconds: 60 }, cookie: s.memberCookie });
    expect((await entry(open.id)).status).toBe(201);
    expect((await entry(mine.id)).status).toBe(201);
    expect((await entry(closed.id)).status).toBe(400);
    expect((await request("/api/timer/start", { body: { projectId: closed.id, date: TODAY }, cookie: s.memberCookie })).status).toBe(400);
    expect((await request(`/api/projects/${closed.id}`, { cookie: s.memberCookie })).status).toBe(404);

    // Admins see everything.
    expect((await (await request("/api/projects", { cookie: s.adminCookie })).json()).projects).toHaveLength(3);
  });

  it("changes a project's team", async () => {
    const s = await studio();
    const p = (await (await createProject(s.adminCookie, { everyone: false, memberIds: [s.member.id] })).json()).project;
    const res = await request(`/api/projects/${p.id}`, { method: "PATCH", body: { memberIds: [s.other.id, s.other.id] }, cookie: s.adminCookie });
    expect((await res.json()).project.memberIds).toEqual([s.other.id]);
    expect((await (await request("/api/projects", { cookie: s.memberCookie })).json()).projects).toEqual([]);
    expect((await request(`/api/projects/${p.id}`, { method: "PATCH", body: { memberIds: ["nobody"] }, cookie: s.adminCookie })).status).toBe(400);
  });
});

describe("rates and budgets", () => {
  it("adds up billable amounts at the project's rate or each person's rate", async () => {
    const s = await studio();
    const byProject = (await (await createProject(s.adminCookie, { name: "By project", hourlyRate: 12000, budgetBy: "fees", budgetAmount: 100000 })).json()).project;
    const byPerson = (await (await createProject(s.adminCookie, { name: "By person", billBy: "person", budgetBy: "hours", budgetSeconds: 36000 })).json()).project;
    expect(byProject).toMatchObject({ billBy: "project", hourlyRate: 12000, budgetBy: "fees", budgetAmount: 100000 });

    expect((await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { hourlyRate: 9000 }, cookie: s.adminCookie })).status).toBe(200);
    // Admins may set their own rate, even though they can't change their own role.
    expect((await request(`/api/people/${s.admin.id}`, { method: "PATCH", body: { hourlyRate: 15000 }, cookie: s.adminCookie })).status).toBe(200);

    const add = (cookie: string, projectId: string, seconds: number, billable = true) =>
      request("/api/time-entries", { body: { projectId, date: TODAY, seconds, billable }, cookie });
    await add(s.memberCookie, byProject.id, 5400); // 1.5 h × 120
    await add(s.adminCookie, byProject.id, 3600); // 1 h × 120
    await add(s.adminCookie, byProject.id, 3600, false); // not billable
    await add(s.memberCookie, byPerson.id, 7200); // 2 h × 90
    await add(s.adminCookie, byPerson.id, 1800); // 0.5 h × 150

    const one = await (await request(`/api/projects/${byProject.id}`, { cookie: s.adminCookie })).json();
    expect(one.stats).toEqual({ seconds: 12600, billableSeconds: 9000, billableAmount: 30000 });
    const two = await (await request(`/api/projects/${byPerson.id}`, { cookie: s.adminCookie })).json();
    expect(two.stats).toEqual({ seconds: 9000, billableSeconds: 9000, billableAmount: 25500 });
    expect(two.team.map((p: { name: string }) => p.name).sort()).toEqual(["admin", "member", "other"]);

    // Members see hours but not money.
    const asMember = await (await request(`/api/projects/${byPerson.id}`, { cookie: s.memberCookie })).json();
    expect(asMember.stats).toEqual({ seconds: 9000, billableSeconds: 9000 });
  });

  it("checks rates and budgets", async () => {
    const s = await studio();
    expect((await createProject(s.adminCookie, { hourlyRate: -5 })).status).toBe(400);
    expect((await createProject(s.adminCookie, { hourlyRate: 12.5 })).status).toBe(400);
    expect((await createProject(s.adminCookie, { billBy: "task" })).status).toBe(400);
    expect((await createProject(s.adminCookie, { budgetBy: "points" })).status).toBe(400);
    expect((await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { hourlyRate: "lots" }, cookie: s.adminCookie })).status).toBe(400);
  });
});

describe("organization isolation for project teams", () => {
  it("can't put another organization's people on a project", async () => {
    const s = await studio();
    const b = await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const bCookie = (await signIn("b@b.test", "admin-password-1")).cookie;
    expect((await createProject(bCookie, { everyone: false, memberIds: [s.member.id] })).status).toBe(400);
    const own = (await (await createProject(s.adminCookie, {})).json()).project;
    expect((await request(`/api/projects/${own.id}`, { cookie: bCookie })).status).toBe(404);

    const bProject = await prisma.project.create({ data: { organizationId: b.organization.id, name: "B" } });
    await expect(
      prisma.projectMember.create({ data: { organizationId: b.organization.id, projectId: bProject.id, userId: s.member.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("the project page's people and latest entries (WRK-126)", () => {
  it("shows admins and managers everyone's hours and latest time on the project, and members only their own", async () => {
    const s = await studio();
    const project = (await (await createProject(s.adminCookie, { name: "Launch" })).json()).project;
    const add = (cookie: string, date: string, seconds: number, notes: string) =>
      request("/api/time-entries", { body: { projectId: project.id, date, seconds, notes }, cookie });
    await add(s.adminCookie, "2026-10-12", 3600, "Kickoff");
    await add(s.memberCookie, "2026-10-13", 5400, "Drafts");
    await add(s.memberCookie, "2026-10-14", 1800, "Revisions");
    for (const day of ["2026-10-08", "2026-10-09", "2026-10-10"]) await add(s.adminCookie, day, 600, `Older ${day}`);

    const admin = await (await request(`/api/projects/${project.id}`, { cookie: s.adminCookie })).json();
    // Most hours first.
    expect(admin.hours).toEqual([
      { id: s.member.id, name: s.member.name, seconds: 5400 + 1800 },
      { id: s.admin.id, name: s.admin.name, seconds: 3600 + 3 * 600 },
    ]);
    // The five latest, newest first.
    expect(admin.recent.map((e: { notes: string }) => e.notes)).toEqual(["Revisions", "Drafts", "Kickoff", "Older 2026-10-10", "Older 2026-10-09"]);
    expect(admin.recent[0]).toMatchObject({ date: "2026-10-14", person: { id: s.member.id, name: s.member.name }, task: null, seconds: 1800, running: false });

    const member = await (await request(`/api/projects/${project.id}`, { cookie: s.memberCookie })).json();
    expect(member.hours).toEqual([{ id: s.member.id, name: s.member.name, seconds: 7200 }]);
    expect(member.recent.map((e: { notes: string }) => e.notes)).toEqual(["Revisions", "Drafts"]);
  });

  it("counts a running timer up to now", async () => {
    const s = await studio();
    const project = (await (await createProject(s.adminCookie, { name: "Live" })).json()).project;
    await prisma.timeEntry.create({
      data: { organizationId: s.organization.id, userId: s.member.id, projectId: project.id, date: new Date(`${TODAY}T00:00:00Z`), seconds: 600, startedAt: new Date(Date.now() - 120_000), billable: true },
    });
    const { hours, recent } = await (await request(`/api/projects/${project.id}`, { cookie: s.adminCookie })).json();
    expect(hours[0].seconds).toBeGreaterThanOrEqual(720);
    expect(recent[0]).toMatchObject({ running: true });
    expect(recent[0].seconds).toBeGreaterThanOrEqual(720);
  });
});
