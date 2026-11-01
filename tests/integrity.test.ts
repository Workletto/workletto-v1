import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Fixes from the pre-release audit (WRK-94): money that mustn't be lost or mixed up, and
// changes that must be on record.

beforeEach(resetDatabase);

const DAY = "2026-10-12";

async function studio() {
  const { organization } = await createOrgWithUser("Studio North", "admin@studio.test", "admin-password-1", "admin");
  const manager = await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1", "member");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const managerCookie = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const client = (await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: admin })).json()).client;
  const project = (await (await request("/api/projects", { body: { name: "Website", clientId: client.id, hourlyRate: 12000, everyone: true }, cookie: admin })).json()).project;
  await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 3600 }, cookie: admin });
  const invoice = async () => (await (await request("/api/invoices", { body: { clientId: client.id, issueDate: "2026-10-15" }, cookie: admin })).json()).invoice;
  const history = async (kind: string) => (await (await request(`/api/history?kind=${kind}`, { cookie: admin })).json()).events;
  return { organization, admin, managerCookie, memberCookie, manager, member, client, project, invoice, history };
}

const payment = (s: { organization: { id: string } }, invoiceId: string, status: "open" | "processing" | "paid" | "expired", ref: string) =>
  prisma.payment.create({ data: { organizationId: s.organization.id, invoiceId, provider: "stripe", providerRef: ref, amount: 12000, amountCents: 12000, currency: "USD", status } });

describe("audit fixes", () => {
  it("never loses an online payment by moving its invoice back to draft or deleting it", async () => {
    const s = await studio();
    const invoice = await s.invoice();
    const patch = (body: unknown) => request(`/api/invoices/${invoice.id}`, { method: "PATCH", body, cookie: s.admin });
    await patch({ status: "sent" });
    const sentAt = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).sentAt;
    await payment(s, invoice.id, "paid", "cs_paid");
    await patch({ status: "paid" });
    // Marked unpaid again (a refund), it keeps the date it was first sent.
    await patch({ status: "sent" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).sentAt).toEqual(sentAt);
    const back = await patch({ status: "draft" });
    expect(back.status).toBe(409);
    expect((await back.json()).error).toContain("paid online");

    // A draft whose checkouts all ended unpaid can be deleted; one with a payment can't.
    const other = await s.invoice();
    await payment(s, other.id, "expired", "cs_expired");
    expect((await request(`/api/invoices/${other.id}`, { method: "DELETE", cookie: s.admin })).status).toBe(200);
    expect(await prisma.payment.count({ where: { providerRef: "cs_expired" } })).toBe(0);
    await prisma.invoice.updateMany({ where: { id: invoice.id }, data: { status: "draft" } }); // as if a payment arrived after it went back to draft
    expect((await request(`/api/invoices/${invoice.id}`, { method: "DELETE", cookie: s.admin })).status).toBe(409);
    await expect(prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toThrow(); // the database refuses too
  });

  it("keeps the currency once there are invoices or expenses, and records company changes", async () => {
    const s = await studio();
    const save = (currency: string) => request("/api/settings/company", { method: "PUT", body: { name: "Studio North", currency, address: "" }, cookie: s.admin });
    expect((await save("EUR")).status).toBe(200); // nothing in dollars yet: a setup choice
    expect((await save("USD")).status).toBe(200);
    expect((await s.history("settings"))[0].changes).toEqual([{ field: "currency", from: "EUR", to: "USD" }]);
    const company = async () => (await request("/api/settings/company", { cookie: s.admin })).json();
    expect((await company()).currencyLocked).toBe(false);
    await s.invoice();
    // The settings screen disables the currency list from this, instead of refusing after Save.
    expect(await company()).toMatchObject({ currencyLocked: true, organization: { currency: "USD" } });
    const refused = await save("EUR");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("their amounts are in USD");
  });

  it("refuses invoice lines larger than the database holds", async () => {
    const s = await studio();
    const invoice = await s.invoice();
    const add = (quantity: number, unitPrice: number) => request(`/api/invoices/${invoice.id}/lines`, { body: { description: "Retainer", quantity, unitPrice }, cookie: s.admin });
    expect((await add(10_000_000, 1_000_000)).status).toBe(400); // 10,000 × 10,000.00
    expect((await add(1000, 2_147_483_648)).status).toBe(400);
    expect((await add(1000, 500_000)).status).toBe(201);
  });

  it("stops a person's running timer when their account is turned off", async () => {
    const s = await studio();
    await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.memberCookie });
    await prisma.timeEntry.updateMany({ where: { userId: s.member.id }, data: { startedAt: new Date(Date.now() - 600_000) } });
    expect((await request(`/api/people/${s.member.id}`, { method: "PATCH", body: { active: false }, cookie: s.admin })).status).toBe(200);
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { userId: s.member.id } });
    expect(entry.startedAt).toBeNull();
    expect(entry.seconds).toBeGreaterThanOrEqual(600);
  });

  it("stops a timer forgotten for days at a day's worth of time", async () => {
    const s = await studio();
    await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.memberCookie });
    await prisma.timeEntry.updateMany({ where: { userId: s.member.id }, data: { startedAt: new Date(Date.now() - 60 * 3_600_000) } });
    await request("/api/timer/stop", { body: {}, cookie: s.memberCookie });
    expect((await prisma.timeEntry.findFirstOrThrow({ where: { userId: s.member.id } })).seconds).toBe(24 * 3600);
  });

  it("lets only admins and managers delete a task that has time, and records it", async () => {
    const s = await studio();
    const task = (await (await request("/api/tasks", { body: { title: "Wireframes", projectId: s.project.id }, cookie: s.admin })).json()).task;
    await request("/api/time-entries", { body: { projectId: s.project.id, taskId: task.id, date: DAY, seconds: 1800 }, cookie: s.memberCookie });
    expect((await request(`/api/tasks/${task.id}`, { method: "DELETE", cookie: s.memberCookie })).status).toBe(403);
    expect((await request(`/api/tasks/${task.id}`, { method: "DELETE", cookie: s.managerCookie })).status).toBe(200);
    expect(await prisma.timeEntry.count({ where: { userId: s.member.id, taskId: null } })).toBe(1);
    expect((await s.history("project"))[0].changes[0]).toMatchObject({ field: "task", from: expect.stringContaining("Wireframes (deleted, 1 time entry kept") });
  });

  it("keeps a sent invoice's client and company details, while a draft follows the current ones", async () => {
    const s = await studio();
    const invoice = await s.invoice();
    const get = async () => (await (await request(`/api/invoices/${invoice.id}`, { cookie: s.admin })).json()) as { invoice: { client: { name: string; address: string } }; from: { name: string } };
    const rename = async (client: string, company: string) => {
      await request(`/api/clients/${s.client.id}`, { method: "PATCH", body: { name: client, address: `${client} HQ` }, cookie: s.admin });
      await request("/api/settings/company", { method: "PUT", body: { name: company, currency: "USD", address: "" }, cookie: s.admin });
    };
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    await rename("Acme Group", "North Studio Ltd");
    const sent = await get();
    expect(sent.invoice.client).toMatchObject({ name: "Acme Ltd" });
    expect(sent.from.name).toBe("Studio North");
    // Back to draft, it shows today's details; sent again, it keeps those.
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "draft" }, cookie: s.admin });
    expect((await get()).invoice.client).toMatchObject({ name: "Acme Group", address: "Acme Group HQ" });
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    await rename("Acme Holdings", "Studio North");
    expect((await get()).invoice.client.name).toBe("Acme Group");
    expect((await get()).from.name).toBe("North Studio Ltd");
  });

  it("counts a project's budget the same way on the project page and in the budgets report", async () => {
    const s = await studio();
    await request(`/api/projects/${s.project.id}`, { method: "PATCH", body: { budgetBy: "hours", budgetSeconds: 36000 }, cookie: s.admin });
    await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.memberCookie });
    await prisma.timeEntry.updateMany({ where: { userId: s.member.id }, data: { startedAt: new Date(Date.now() - 3_600_000) } });
    const page = (await (await request(`/api/projects/${s.project.id}`, { cookie: s.admin })).json()).stats.seconds;
    const report = (await (await request("/api/reports/budgets", { cookie: s.admin })).json()).budgets.find((b: { id: string }) => b.id === s.project.id).used;
    expect(page).toBeGreaterThanOrEqual(3600 + 3600); // an hour saved, an hour running
    expect(Math.abs(page - report)).toBeLessThanOrEqual(1);
  });

  it("records who made a password reset link", async () => {
    const s = await studio();
    expect((await request(`/api/people/${s.manager.id}/reset-link`, { body: {}, cookie: s.admin })).status).toBe(201);
    const [event] = await s.history("person");
    expect(event).toMatchObject({ actorName: expect.any(String), label: expect.any(String), changes: [{ field: "resetLink", from: null, to: "created" }] });
  });
});
