import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Team page, cost rates and profitability, company-wide tasks, and bulk approval.

beforeEach(resetDatabase);

const WEEK = "2026-10-05"; // a Monday in the past
const DAY = "2026-10-07";

async function studio() {
  const { organization, user: adminUser } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const managerUser = await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const memberUser = await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const post = async (path: string, body: unknown, cookie = admin) => (await request(path, { body, cookie })).json();
  // $100 an hour, billed by project.
  const project = (await post("/api/projects", { name: "Website", hourlyRate: 10000 })).project;
  const track = (cookie: string, body: Record<string, unknown> = {}) =>
    request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 3600, ...body }, cookie });
  return { organization, adminUser, managerUser, memberUser, admin, manager, member, project, post, track };
}

describe("cost rates and weekly capacity", () => {
  it("admins set them; they're checked and recorded in the history", async () => {
    const s = await studio();
    const patch = (body: unknown, cookie = s.admin) => request(`/api/people/${s.memberUser.id}`, { method: "PATCH", body, cookie });
    expect((await patch({ costRate: 5000 }, s.manager)).status).toBe(403);
    expect((await patch({ costRate: -1 })).status).toBe(400);
    expect((await patch({ costRate: 12.5 })).status).toBe(400);
    expect((await patch({ weeklyCapacity: 7 * 24 * 3600 + 1 })).status).toBe(400);
    expect((await patch({ weeklyCapacity: "35" })).status).toBe(400);
    const res = await patch({ costRate: 5000, weeklyCapacity: 32 * 3600 });
    expect(res.status).toBe(200);
    expect((await res.json()).person).toMatchObject({ costRate: 5000, weeklyCapacity: 32 * 3600 });
    expect((await patch({ costRate: null })).status).toBe(200);
    const events = await prisma.auditEvent.findMany({ where: { kind: "person", subjectId: s.memberUser.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.changes)).toEqual([
      [{ field: "costRate", from: null, to: 5000 }, { field: "weeklyCapacity", from: 144000, to: 115200 }],
      [{ field: "costRate", from: 5000, to: null }],
    ]);
  });

  it("new people start at 40 hours a week with no cost rate", async () => {
    const s = await studio();
    const { people } = await (await request("/api/people", { cookie: s.admin })).json();
    expect(people.find((p: { id: string }) => p.id === s.memberUser.id)).toMatchObject({ costRate: null, weeklyCapacity: 40 * 3600 });
  });
});

describe("the Team page", () => {
  it("shows each person's hours for the week against their capacity, for admins and managers only", async () => {
    const s = await studio();
    await s.track(s.member, { seconds: 7200 });
    await s.track(s.member, { seconds: 1800, billable: false });
    await s.track(s.manager, { seconds: 3600, date: "2026-10-12" }); // the next week
    await request(`/api/people/${s.memberUser.id}`, { method: "PATCH", body: { weeklyCapacity: 20 * 3600 }, cookie: s.admin });

    expect((await request(`/api/team?week=${WEEK}`, { cookie: s.member })).status).toBe(403);
    expect((await request("/api/team?week=2026-10-06", { cookie: s.manager })).status).toBe(400);
    const res = await request(`/api/team?week=${WEEK}`, { cookie: s.manager });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ week: WEEK, approvals: false });
    const byName = Object.fromEntries(body.people.map((p: { name: string }) => [p.name, p]));
    expect(byName["member@studio.test"] ?? body.people.find((p: { id: string }) => p.id === s.memberUser.id)).toMatchObject({
      seconds: 9000, billableSeconds: 7200, weeklyCapacity: 72000, timesheet: null, active: true,
    });
    expect(body.people.find((p: { id: string }) => p.id === s.managerUser.id)).toMatchObject({ seconds: 0, billableSeconds: 0 });
    // Nothing here that members can't see elsewhere: no rates.
    expect(JSON.stringify(body)).not.toMatch(/Rate/);
  });

  it("leaves out people turned off, unless they tracked time that week; shows timesheet status when approvals are on", async () => {
    const s = await studio();
    const other = await addUser(s.organization.id, "gone@studio.test", "gone-password-1");
    await prisma.user.update({ where: { id: other.id }, data: { deactivatedAt: new Date() } });
    await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "UTC" }, cookie: s.admin });
    await s.track(s.member);
    await request(`/api/timesheets/mine/${WEEK}/submit`, { body: {}, cookie: s.member });
    const ids = async () => (await (await request(`/api/team?week=${WEEK}`, { cookie: s.admin })).json()).people;
    let people = await ids();
    expect(people.map((p: { id: string }) => p.id)).not.toContain(other.id);
    expect(people.find((p: { id: string }) => p.id === s.memberUser.id).timesheet).toBe("submitted");
    expect(people.find((p: { id: string }) => p.id === s.managerUser.id).timesheet).toBe("open");

    await prisma.timeEntry.create({ data: { organizationId: s.organization.id, userId: other.id, projectId: s.project.id, date: new Date(`${DAY}T00:00:00Z`), seconds: 600, billable: true } });
    people = await ids();
    expect(people.find((p: { id: string }) => p.id === other.id)).toMatchObject({ active: false, seconds: 600 });
  });

  it("never shows another organization's people", async () => {
    const s = await studio();
    await createOrgWithUser("Elsewhere", "else@else.test", "else-password-1", "admin");
    const { people } = await (await request(`/api/team?week=${WEEK}`, { cookie: s.admin })).json();
    expect(people).toHaveLength(3);
  });
});

describe("profitability", () => {
  it("is revenue (billable time and expenses) less cost (all time at cost rates, and every expense)", async () => {
    const s = await studio();
    await request(`/api/people/${s.memberUser.id}`, { method: "PATCH", body: { costRate: 4000 }, cookie: s.admin });
    await request(`/api/people/${s.managerUser.id}`, { method: "PATCH", body: { costRate: 6000 }, cookie: s.admin });
    await s.track(s.member, { seconds: 3 * 3600 }); // $300 revenue, $120 cost
    await s.track(s.member, { seconds: 3600, billable: false }); // $40 cost
    await s.track(s.manager, { seconds: 1800 }); // $50 revenue, $30 cost
    await s.track(s.admin, { seconds: 3600 }); // $100 revenue, no cost rate
    const expense = (body: Record<string, unknown>) =>
      request("/api/expenses", { body: { projectId: s.project.id, date: DAY, category: "Travel", ...body }, cookie: s.member });
    await expense({ amount: 2500, billable: true }); // $25 revenue and $25 cost
    await expense({ amount: 1000, billable: false }); // $10 cost

    expect((await request(`/api/reports/profitability?from=${WEEK}&to=2026-10-11`, { cookie: s.member })).status).toBe(403);
    const res = await request(`/api/reports/profitability?from=${WEEK}&to=2026-10-11`, { cookie: s.admin });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals).toEqual({ revenue: 47500, invoiced: 0, uninvoiced: 47500, timeCost: 19000, expenseCost: 3500, cost: 22500, profit: 25000 });
    expect(body.projects).toEqual([{ id: s.project.id, label: "Website", detail: null, ...body.totals }]);
    expect(body.clients).toEqual([{ id: "none", label: "No client", detail: null, ...body.totals }]);
    const person = (id: string) => body.people.find((p: { id: string }) => p.id === id);
    expect(person(s.memberUser.id)).toMatchObject({ revenue: 32500, cost: 19500, profit: 13000 });
    expect(person(s.adminUser.id)).toMatchObject({ revenue: 10000, cost: 0 });
    expect(body.missingCostRates).toEqual([{ id: s.adminUser.id, name: expect.any(String) }]);
    expect(body.series.step).toBe("day");
    expect(body.series.buckets.find((b: { start: string }) => b.start === DAY)).toMatchObject({ revenue: 47500, cost: 22500 });
    expect(body.series.buckets).toHaveLength(7);
  });

  it("gives managers clients and projects but not what each person costs", async () => {
    const s = await studio();
    await s.track(s.member);
    const body = await (await request(`/api/reports/profitability?from=${WEEK}&to=2026-10-11`, { cookie: s.manager })).json();
    expect(body.projects).toHaveLength(1);
    expect(body).not.toHaveProperty("people");
  });

  it("counts invoiced revenue apart", async () => {
    const s = await studio();
    const client = await s.post("/api/clients", { name: "Acme" });
    const project = (await s.post("/api/projects", { name: "Brand", clientId: client.client.id, hourlyRate: 10000 })).project;
    await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 3600 }, cookie: s.admin });
    await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 1800 }, cookie: s.admin });
    const made = await request("/api/invoices", { body: { clientId: client.client.id, issueDate: "2026-10-10", from: WEEK, to: "2026-10-11" }, cookie: s.admin });
    expect(made.status).toBe(201);
    const body = await (await request(`/api/reports/profitability?from=${WEEK}&to=2026-10-11&clientId=${client.client.id}`, { cookie: s.admin })).json();
    expect(body.totals).toMatchObject({ revenue: 15000, invoiced: 15000, uninvoiced: 0 });
  });

  it("counts invoiced work at what the invoice billed, after its discount, whatever the rate is now", async () => {
    const s = await studio();
    const client = await s.post("/api/clients", { name: "Acme" });
    const project = (await s.post("/api/projects", { name: "Brand", clientId: client.client.id, hourlyRate: 10000 })).project;
    await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 3600 }, cookie: s.admin });
    await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 1800 }, cookie: s.admin });
    const made = await (await request("/api/invoices", { body: { clientId: client.client.id, issueDate: "2026-10-10", from: WEEK, to: "2026-10-11" }, cookie: s.admin })).json();
    expect((await request(`/api/invoices/${made.invoice.id}`, { method: "PATCH", body: { discountPercent: "50" }, cookie: s.admin })).status).toBe(200);
    // The rate goes up after the invoice, and one more hour is tracked, not yet invoiced.
    expect((await request(`/api/projects/${project.id}`, { method: "PATCH", body: { hourlyRate: 20000 }, cookie: s.admin })).status).toBe(200);
    await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 3600 }, cookie: s.admin });

    const body = await (await request(`/api/reports/profitability?from=${WEEK}&to=2026-10-11&clientId=${client.client.id}`, { cookie: s.admin })).json();
    // $150 invoiced less 50% is $75; the new hour counts at today's $200.
    expect(body.totals).toMatchObject({ revenue: 27500, invoiced: 7500, uninvoiced: 20000 });
  });
});

describe("company-wide tasks", () => {
  it("are listed and changed by admins and managers; names are unique, ignoring capitals", async () => {
    const s = await studio();
    expect((await request("/api/common-tasks", { cookie: s.member })).status).toBe(403);
    expect((await request("/api/common-tasks", { body: { title: "Design" }, cookie: s.member })).status).toBe(403);
    const made = await request("/api/common-tasks", { body: { title: " Design " }, cookie: s.manager });
    expect(made.status).toBe(201);
    const { task } = await made.json();
    expect(task).toMatchObject({ title: "Design", addToNewProjects: true });
    expect((await request("/api/common-tasks", { body: { title: "design" }, cookie: s.admin })).status).toBe(409);
    expect((await request("/api/common-tasks", { body: { title: "" }, cookie: s.admin })).status).toBe(400);
    await request("/api/common-tasks", { body: { title: "Vacation", addToNewProjects: false }, cookie: s.admin });
    const renamed = await request(`/api/common-tasks/${task.id}`, { method: "PATCH", body: { title: "Visual design" }, cookie: s.admin });
    expect((await renamed.json()).task.title).toBe("Visual design");
    expect((await request(`/api/common-tasks/${task.id}`, { method: "PATCH", body: { title: "VACATION" }, cookie: s.admin })).status).toBe(409);
    expect((await request(`/api/common-tasks/${task.id}`, { method: "PATCH", body: { addToNewProjects: "yes" }, cookie: s.admin })).status).toBe(400);
    const { tasks } = await (await request("/api/common-tasks", { cookie: s.admin })).json();
    expect(tasks.map((t: { title: string }) => t.title)).toEqual(["Vacation", "Visual design"]);
    expect((await request(`/api/common-tasks/${task.id}`, { method: "DELETE", cookie: s.admin })).status).toBe(200);
    expect((await request(`/api/common-tasks/${task.id}`, { method: "DELETE", cookie: s.admin })).status).toBe(404);
  });

  it("start on every new project, and can be added to every active project", async () => {
    const s = await studio();
    const design = (await s.post("/api/common-tasks", { title: "Design" })).task;
    await s.post("/api/common-tasks", { title: "Vacation", addToNewProjects: false });
    const fresh = (await s.post("/api/projects", { name: "Fresh" })).project;
    const titles = async (projectId: string) => (await prisma.task.findMany({ where: { projectId }, orderBy: { title: "asc" } })).map((t) => t.title);
    expect(await titles(fresh.id)).toEqual(["Design"]);

    // "Website" was made before the task existed; an archived project is left alone.
    const old = (await s.post("/api/projects", { name: "Old" })).project;
    await prisma.task.deleteMany({ where: { projectId: old.id } });
    await request(`/api/projects/${old.id}`, { method: "PATCH", body: { archived: true }, cookie: s.admin });
    const res = await request(`/api/common-tasks/${design.id}/add-to-projects`, { body: {}, cookie: s.manager });
    expect(await res.json()).toEqual({ added: 1 });
    expect(await titles(s.project.id)).toEqual(["Design"]);
    expect(await titles(old.id)).toEqual([]);
    // Running it again adds nothing: each project has it now.
    expect(await (await request(`/api/common-tasks/${design.id}/add-to-projects`, { body: {}, cookie: s.admin })).json()).toEqual({ added: 0 });
  });

  it("belong to one organization", async () => {
    const s = await studio();
    const design = (await s.post("/api/common-tasks", { title: "Design" })).task;
    await createOrgWithUser("Elsewhere", "else@else.test", "else-password-1", "admin");
    const other = (await signIn("else@else.test", "else-password-1")).cookie;
    expect((await (await request("/api/common-tasks", { cookie: other })).json()).tasks).toEqual([]);
    expect((await request(`/api/common-tasks/${design.id}`, { method: "PATCH", body: { title: "Mine" }, cookie: other })).status).toBe(404);
    expect((await request(`/api/common-tasks/${design.id}/add-to-projects`, { body: {}, cookie: other })).status).toBe(404);
    expect((await request(`/api/common-tasks/${design.id}`, { method: "DELETE", cookie: other })).status).toBe(404);
    // Their new projects don't get our tasks.
    const theirs = (await (await request("/api/projects", { body: { name: "Theirs" }, cookie: other })).json()).project;
    expect(await prisma.task.count({ where: { projectId: theirs.id } })).toBe(0);
  });
});

describe("bulk approval", () => {
  it("approves the submitted weeks shown, skipping your own and any no longer waiting", async () => {
    const s = await studio();
    await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "UTC" }, cookie: s.admin });
    for (const cookie of [s.member, s.manager]) {
      await s.track(cookie);
      expect((await request(`/api/timesheets/mine/${WEEK}/submit`, { body: {}, cookie })).status).toBe(200);
    }
    await s.track(s.member, { date: "2026-10-13" });
    await request("/api/timesheets/mine/2026-10-12/submit", { body: {}, cookie: s.member });

    // One week at a time.
    const list = async (query: string) => (await (await request(`/api/timesheets?${query}`, { cookie: s.manager })).json()).weeks;
    expect((await list(`week=${WEEK}`)).map((w: { person: { id: string } }) => w.person.id).sort()).toEqual([s.managerUser.id, s.memberUser.id].sort());
    expect(await list("week=2026-10-12")).toHaveLength(1);
    expect((await request("/api/timesheets?week=2026-10-13", { cookie: s.manager })).status).toBe(400);

    const weeks = [
      { userId: s.memberUser.id, weekStart: WEEK },
      { userId: s.managerUser.id, weekStart: WEEK }, // the manager's own: skipped
      { userId: s.adminUser.id, weekStart: WEEK }, // never submitted: skipped
    ];
    expect((await request("/api/timesheets/approve", { body: { weeks }, cookie: s.member })).status).toBe(403);
    expect((await request("/api/timesheets/approve", { body: { weeks: [] }, cookie: s.manager })).status).toBe(400);
    expect((await request("/api/timesheets/approve", { body: { weeks: [{ userId: s.memberUser.id, weekStart: "2026-10-06" }] }, cookie: s.manager })).status).toBe(400);
    const res = await request("/api/timesheets/approve", { body: { weeks }, cookie: s.manager });
    expect(await res.json()).toEqual({ approved: 1, skipped: 2 });
    const statuses = await prisma.timesheetWeek.findMany({ select: { userId: true, weekStart: true, status: true, decidedByName: true } });
    expect(statuses.find((w) => w.userId === s.memberUser.id && w.weekStart.toISOString().startsWith(WEEK))).toMatchObject({ status: "approved", decidedByName: s.managerUser.name });
    expect(statuses.find((w) => w.userId === s.managerUser.id)?.status).toBe("submitted");
    expect(statuses.find((w) => w.weekStart.toISOString().startsWith("2026-10-12"))?.status).toBe("submitted");
    const history = await prisma.auditEvent.count({ where: { kind: "timesheet", subjectId: s.memberUser.id } });
    expect(history).toBeGreaterThanOrEqual(1);
  });

  it("can't approve another organization's weeks", async () => {
    const s = await studio();
    await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "UTC" }, cookie: s.admin });
    await s.track(s.member);
    await request(`/api/timesheets/mine/${WEEK}/submit`, { body: {}, cookie: s.member });
    await createOrgWithUser("Elsewhere", "else@else.test", "else-password-1", "admin");
    const other = (await signIn("else@else.test", "else-password-1")).cookie;
    const res = await request("/api/timesheets/approve", { body: { weeks: [{ userId: s.memberUser.id, weekStart: WEEK }] }, cookie: other });
    expect(await res.json()).toEqual({ approved: 0, skipped: 1 });
    expect((await prisma.timesheetWeek.findFirstOrThrow({ where: { userId: s.memberUser.id } })).status).toBe("submitted");
  });
});
