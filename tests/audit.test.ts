import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const DAY = "2026-10-12";

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const manager = await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const managerCookie = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const client = (await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: adminCookie })).json()).client;
  const project = (await (await request("/api/projects", { body: { name: "Website", clientId: client.id, hourlyRate: 12000 }, cookie: managerCookie })).json()).project;
  return { organization, admin, manager, member, adminCookie, managerCookie, memberCookie, client, project };
}

const history = async (cookie: string, query = "") => (await request(`/api/history${query}`, { cookie })).json();

describe("audit history", () => {
  it("records who typed in, changed and deleted time, with old and new values", async () => {
    const s = await studio();
    const { entry } = await (await request("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds: 3600, notes: "Wireframes" }, cookie: s.memberCookie })).json();
    await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 5400 }, cookie: s.memberCookie });
    await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 5400 }, cookie: s.memberCookie }); // no change, no record
    await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie: s.memberCookie });

    const { events } = await history(s.adminCookie, "?kind=time");
    expect(events.map((e: { action: string }) => e.action)).toEqual(["deleted", "changed", "created"]);
    const [deleted, changed, created] = events;
    expect(changed).toMatchObject({
      actorId: s.member.id, actorName: "member", kind: "time", subjectId: entry.id,
      label: "Website · Acme Ltd", entryDate: DAY, changes: [{ field: "seconds", from: 3600, to: 5400 }],
    });
    expect(created.changes).toEqual(expect.arrayContaining([{ field: "seconds", from: null, to: 3600 }, { field: "notes", from: null, to: "Wireframes" }, { field: "date", from: null, to: DAY }]));
    expect(deleted.changes).toEqual(expect.arrayContaining([{ field: "seconds", from: 5400, to: null }]));
    expect(Date.parse(changed.createdAt)).toBeGreaterThan(0);
  });

  it("doesn't record time a timer measures", async () => {
    const s = await studio();
    await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.memberCookie });
    await request("/api/timer/stop", { body: {}, cookie: s.memberCookie });
    expect((await history(s.adminCookie, "?kind=time")).events).toEqual([]);
  });

  it("records rates, budgets, roles and accounts", async () => {
    const s = await studio();
    await request(`/api/projects/${s.project.id}`, { method: "PATCH", body: { hourlyRate: 15000, budgetBy: "hours", budgetSeconds: 36000 }, cookie: s.managerCookie });
    await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { hourlyRate: 9500, role: "manager" }, cookie: s.adminCookie });
    await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { active: false }, cookie: s.adminCookie });

    const projects = (await history(s.adminCookie, "?kind=project")).events;
    expect(projects[0]).toMatchObject({ action: "changed", actorId: s.manager.id, label: "Website · Acme Ltd" });
    expect(projects[0].changes).toEqual([
      { field: "hourlyRate", from: 12000, to: 15000 },
      { field: "budgetBy", from: "none", to: "hours" },
      { field: "budgetSeconds", from: null, to: 36000 },
    ]);
    expect(projects[1]).toMatchObject({ action: "created" });
    expect(projects[1].changes).toEqual(expect.arrayContaining([{ field: "hourlyRate", from: null, to: 12000 }, { field: "client", from: null, to: "Acme Ltd" }]));

    const people = (await history(s.adminCookie, "?kind=person")).events;
    expect(people.map((e: { changes: unknown }) => e.changes)).toEqual([
      [{ field: "active", from: true, to: false }],
      [{ field: "hourlyRate", from: null, to: 9500 }, { field: "role", from: "member", to: "manager" }],
    ]);
    expect(people[0]).toMatchObject({ label: "member", subjectId: s.member.id, actorId: s.admin.id });
  });

  it("records invoices: created, lines, status, email-free changes and deletion", async () => {
    const s = await studio();
    await request("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds: 7200 }, cookie: s.memberCookie });
    const { invoice } = await (await request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-10-15" }, cookie: s.managerCookie })).json();
    const { line } = await (await request(`/api/invoices/${invoice.id}/lines`, { body: { description: "Fixed fee", quantity: 1000, unitPrice: 50000 }, cookie: s.managerCookie })).json();
    await request(`/api/invoices/${invoice.id}/lines/${line.id}`, { method: "PATCH", body: { unitPrice: 45000 }, cookie: s.managerCookie });
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { discountPercent: "10" }, cookie: s.managerCookie });
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "sent" }, cookie: s.managerCookie });
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "paid" }, cookie: s.managerCookie });

    const events = (await history(s.adminCookie, "?kind=invoice")).events;
    const label = "Invoice 0001 · Acme Ltd";
    expect(events.every((e: { label: string }) => e.label === label)).toBe(true);
    expect(events.map((e: { changes: unknown }) => e.changes)).toEqual([
      [{ field: "status", from: "sent", to: "paid" }],
      [{ field: "status", from: "draft", to: "sent" }],
      [{ field: "discountBasisPoints", from: 0, to: 1000 }],
      [{ field: "line", from: "Fixed fee ($500.00)", to: "Fixed fee ($450.00)" }],
      [{ field: "line", from: null, to: "Fixed fee ($500.00)" }],
      expect.arrayContaining([{ field: "subtotal", from: null, to: 24000 }, { field: "client", from: null, to: "Acme Ltd" }]),
    ]);

    // Back to draft, then delete: the deletion is recorded with what the invoice was.
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "draft" }, cookie: s.managerCookie });
    await request(`/api/invoices/${invoice.id}`, { method: "DELETE", cookie: s.managerCookie });
    const [deleted] = (await history(s.adminCookie, "?kind=invoice")).events;
    expect(deleted).toMatchObject({ action: "deleted", label });
    expect(deleted.changes).toEqual(expect.arrayContaining([{ field: "subtotal", from: 69000, to: null }]));
  });

  it("records expenses and imports", async () => {
    const s = await studio();
    const { expense } = await (await request("/api/expenses", { body: { projectId: s.project.id, date: DAY, category: "Travel", amount: 4250 }, cookie: s.memberCookie })).json();
    await request(`/api/expenses/${expense.id}`, { method: "PATCH", body: { amount: 5000 }, cookie: s.memberCookie });
    const [changed] = (await history(s.adminCookie, "?kind=expense")).events;
    expect(changed).toMatchObject({ label: "Travel · Website · Acme Ltd", entryDate: DAY, changes: [{ field: "amount", from: 4250, to: 5000 }] });

    const rows = [{ date: DAY, project: "Imported", hours: "1" }, { date: DAY, project: "Imported", hours: "2" }];
    await request("/api/data/import/time", { body: { rows, dryRun: true }, cookie: s.managerCookie });
    expect((await history(s.adminCookie, "?kind=import")).events).toEqual([]);
    await request("/api/data/import/time", { body: { rows, dryRun: false }, cookie: s.managerCookie });
    expect((await history(s.adminCookie, "?kind=import")).events).toMatchObject([{ action: "created", label: "Imported 2 time entries", actorId: s.manager.id }]);
  });

  it("is for admins only, and only shows their own organization", async () => {
    const s = await studio();
    await request(`/api/projects/${s.project.id}`, { method: "PATCH", body: { hourlyRate: 13000 }, cookie: s.managerCookie });
    expect((await request("/api/history", { cookie: s.managerCookie })).status).toBe(403);
    expect((await request("/api/history", { cookie: s.memberCookie })).status).toBe(403);
    expect((await request("/api/history/export", { cookie: s.managerCookie })).status).toBe(403);
    expect((await request("/api/history")).status).toBe(401);

    await createOrgWithUser("Other", "other@else.test", "other-password-1", "admin");
    const other = (await signIn("other@else.test", "other-password-1")).cookie;
    expect((await history(other)).events).toEqual([]);
    expect((await history(s.adminCookie)).events.length).toBeGreaterThan(0);
  });

  it("filters by person, kind and time, and pages without gaps", async () => {
    const s = await studio();
    for (let i = 1; i <= 60; i++) {
      await request(`/api/projects/${s.project.id}`, { method: "PATCH", body: { hourlyRate: 12000 + i }, cookie: s.managerCookie });
    }
    await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { hourlyRate: 9000 }, cookie: s.adminCookie });

    const first = await history(s.adminCookie, `?actorId=${s.manager.id}`);
    expect(first.events).toHaveLength(50);
    const second = await history(s.adminCookie, `?actorId=${s.manager.id}&before=${encodeURIComponent(first.next)}`);
    expect(second.next).toBeNull();
    const all = [...first.events, ...second.events];
    expect(all).toHaveLength(61); // 60 changes and the project's creation
    expect(new Set(all.map((e: { id: string }) => e.id)).size).toBe(61);
    expect(all.every((e: { actorId: string }) => e.actorId === s.manager.id)).toBe(true);

    expect((await history(s.adminCookie, `?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).events).toEqual([]);
    expect((await history(s.adminCookie, "?until=2000-01-01T00:00:00Z")).events).toEqual([]);
    expect((await request("/api/history?kind=nope", { cookie: s.adminCookie })).status).toBe(400);
    expect((await request("/api/history?since=soon", { cookie: s.adminCookie })).status).toBe(400);
  });

  it("downloads as a spreadsheet, one row per changed field", async () => {
    const s = await studio();
    await request(`/api/projects/${s.project.id}`, { method: "PATCH", body: { hourlyRate: 15000, name: "=Website" }, cookie: s.managerCookie });
    const res = await request("/api/history/export?kind=project", { cookie: s.adminCookie });
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("Time (UTC),Person,Kind,Action,What,Date,Field,From,To,Currency");
    expect(text).toContain(",manager,project,changed,'=Website · Acme Ltd,,hourlyRate,12000,15000");
    expect(text).toContain(",name,Website,'=Website");
  });

  it("goes when the organization goes", async () => {
    const s = await studio();
    expect(await prisma.auditEvent.count({ where: { organizationId: s.organization.id } })).toBeGreaterThan(0);
    await prisma.organization.delete({ where: { id: s.organization.id } });
    expect(await prisma.auditEvent.count()).toBe(0);
  });
});
