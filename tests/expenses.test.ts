import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  let count = 0;
  const newProject = async (body: Record<string, unknown>) =>
    (await (await request("/api/projects", { body: { name: `P${++count}`, ...body }, cookie: adminCookie })).json()).project;
  return { organization, admin, member, adminCookie, memberCookie, newProject };
}

const add = (cookie: string, body: Record<string, unknown>) =>
  request("/api/expenses", { body: { date: TODAY, category: "Travel", amount: 4250, ...body }, cookie });

describe("expenses", () => {
  it("adds an expense whose billable setting follows the project", async () => {
    const s = await studio();
    const billable = await s.newProject({ name: "Client work" });
    const internal = await s.newProject({ name: "Admin", billable: false });
    const res = await add(s.memberCookie, { projectId: billable.id, category: " Printing ", notes: "Posters" });
    expect(res.status).toBe(201);
    expect((await res.json()).expense).toMatchObject({ date: TODAY, category: "Printing", amount: 4250, notes: "Posters", billable: true, project: { id: billable.id } });
    expect((await (await add(s.memberCookie, { projectId: internal.id })).json()).expense.billable).toBe(false);
    expect((await (await add(s.memberCookie, { projectId: billable.id, billable: false })).json()).expense.billable).toBe(false);

    const { expenses } = await (await request(`/api/expenses?from=${TODAY}&to=${TODAY}`, { cookie: s.memberCookie })).json();
    expect(expenses).toHaveLength(3);
    expect((await (await request("/api/expenses/categories", { cookie: s.adminCookie })).json()).categories).toEqual(["Printing", "Travel"]);
  });

  it("checks what it's given", async () => {
    const s = await studio();
    const p = await s.newProject({});
    expect((await add(s.memberCookie, { projectId: p.id, amount: 0 })).status).toBe(400);
    expect((await add(s.memberCookie, { projectId: p.id, amount: 12.5 })).status).toBe(400);
    expect((await add(s.memberCookie, { projectId: p.id, category: "" })).status).toBe(400);
    expect((await add(s.memberCookie, { projectId: p.id, date: "yesterday" })).status).toBe(400);
    expect((await add(s.memberCookie, { projectId: "nope" })).status).toBe(400);
    const closed = await s.newProject({ everyone: false, memberIds: [] });
    expect((await add(s.memberCookie, { projectId: closed.id })).status).toBe(400);
  });

  it("lets people change and delete only their own", async () => {
    const s = await studio();
    const p = await s.newProject({});
    const { expense } = await (await add(s.memberCookie, { projectId: p.id })).json();
    const changed = await request(`/api/expenses/${expense.id}`, { method: "PATCH", body: { amount: 9900, category: "Software" }, cookie: s.memberCookie });
    expect((await changed.json()).expense).toMatchObject({ amount: 9900, category: "Software" });

    expect((await (await request(`/api/expenses?from=${TODAY}&to=${TODAY}`, { cookie: s.adminCookie })).json()).expenses).toEqual([]);
    expect((await request(`/api/expenses/${expense.id}`, { method: "PATCH", body: { amount: 1 }, cookie: s.adminCookie })).status).toBe(404);
    expect((await request(`/api/expenses/${expense.id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(404);
    expect((await request(`/api/expenses/${expense.id}`, { method: "DELETE", cookie: s.memberCookie })).status).toBe(200);
  });

  it("keeps a project with expenses from being deleted", async () => {
    const s = await studio();
    const p = await s.newProject({});
    await add(s.memberCookie, { projectId: p.id });
    expect((await request(`/api/projects/${p.id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(409);
  });
});

describe("reimbursable expenses (WRK-111)", () => {
  it("marks an expense someone paid themselves, changes it, and records it", async () => {
    const s = await studio();
    const project = await s.newProject({ everyone: true });
    const created = await (await add(s.memberCookie, { projectId: project.id, reimbursable: true })).json();
    expect(created.expense.reimbursable).toBe(true);
    expect((await (await add(s.memberCookie, { projectId: project.id })).json()).expense.reimbursable).toBe(false);
    expect((await add(s.memberCookie, { projectId: project.id, reimbursable: "yes" })).status).toBe(400);

    const changed = await request(`/api/expenses/${created.expense.id}`, { method: "PATCH", body: { reimbursable: false }, cookie: s.memberCookie });
    expect((await changed.json()).expense.reimbursable).toBe(false);
    const [event] = (await (await request("/api/history?kind=expense", { cookie: s.adminCookie })).json()).events;
    expect(event.changes).toEqual([{ field: "reimbursable", from: true, to: false }]);
  });
});

describe("organization isolation for expenses", () => {
  it("never shows or links across organizations", async () => {
    const a = await studio();
    const p = await a.newProject({});
    const { expense } = await (await add(a.memberCookie, { projectId: p.id })).json();
    const b = await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const bCookie = (await signIn("b@b.test", "admin-password-1")).cookie;

    expect((await add(bCookie, { projectId: p.id })).status).toBe(400);
    expect((await request(`/api/expenses/${expense.id}`, { method: "PATCH", body: { amount: 1 }, cookie: bCookie })).status).toBe(404);
    expect((await (await request("/api/expenses/categories", { cookie: bCookie })).json()).categories).toEqual([]);
    await expect(
      prisma.expense.create({ data: { organizationId: b.organization.id, userId: b.user.id, projectId: p.id, date: new Date(TODAY), category: "x", amount: 1, billable: true } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
