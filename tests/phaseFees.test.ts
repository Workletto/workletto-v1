import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { sweepRecurringInvoices } from "../src/server/recurring.ts";
import { createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Fixed fees per phase (WRK-151): a fixed fee project bills a fee on each task (phase) instead of
// one fee. Each phase is billed within its own fee, to the cent, with the project's fee their sum.

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio(name = "Studio", domain = "studio.test") {
  const { organization } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  const admin = (await signIn(`admin@${domain}`, "admin-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const client = (await json("/api/clients", { body: { name: "City Library" } })).body.client;
  const project = (await json("/api/projects", { body: { name: "Library", clientId: client.id, fixedFee: 900_000 } })).body.project;
  const phase = async (title: string) => (await json("/api/tasks", { body: { projectId: project.id, title } })).body.task.id as string;
  const sd = await phase("Schematic Design");
  const dd = await phase("Design Development");
  const invoice = (fees: { projectId: string; taskId?: string; amount: number }[]) => json("/api/invoices", { body: { clientId: client.id, issueDate: TODAY, fees } });
  const perPhase = async (fees: Record<string, number | null>) => {
    expect((await json(`/api/projects/${project.id}`, { method: "PATCH", body: { feeByPhase: true } })).status).toBe(200);
    const set = await json(`/api/projects/${project.id}/phase-fees`, { method: "PUT", body: { fees } });
    expect(set.status).toBe(200);
    return set.body;
  };
  return { organization, admin, json, client, project, sd, dd, invoice, perPhase };
}

describe("choosing a fee per phase", () => {
  it("makes the project's fee the sum of its phases, to the cent", async () => {
    const s = await studio();
    const set = await s.perPhase({ [s.sd]: 1_250_050, [s.dd]: 2_000_025 });
    expect(set.project).toMatchObject({ feeByPhase: true, fixedFee: 3_250_075 });
    expect(set.phases).toEqual([
      { taskId: s.sd, title: "Schematic Design", fee: 1_250_050, invoiced: 0, left: 1_250_050 },
      { taskId: s.dd, title: "Design Development", fee: 2_000_025, invoiced: 0, left: 2_000_025 },
    ]);
    // While it's per phase, the fee isn't set by hand.
    expect((await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { fixedFee: 100_000 } })).status).toBe(400);
    expect((await s.json(`/api/projects/${s.project.id}/phase-fees`, { method: "PUT", body: { fees: { [s.sd]: 0 } } })).status).toBe(400);
    expect((await s.json(`/api/projects/${s.project.id}/phase-fees`, { method: "PUT", body: { fees: { [s.sd]: 12.5 } } })).status).toBe(400);
    // An hourly project can't.
    const hourly = (await s.json("/api/projects", { body: { name: "Hourly", clientId: s.client.id, hourlyRate: 10_000 } })).body.project;
    expect((await s.json(`/api/projects/${hourly.id}`, { method: "PATCH", body: { feeByPhase: true } })).status).toBe(400);
  });
});

describe("billing a phase", () => {
  it("bills each phase within its own fee, on a line of its own", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_250_050, [s.dd]: 2_000_025 });
    const made = await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 625_025 }, { projectId: s.project.id, taskId: s.dd, amount: 2_000_025 }]);
    expect(made.status).toBe(201);
    const full = (await s.json(`/api/invoices/${made.body.invoice.id}`)).body.invoice;
    expect(full.lines.map((l: { description: string; amount: number }) => [l.description, l.amount])).toEqual([
      ["Library – Schematic Design – fixed fee", 625_025],
      ["Library – Design Development – fixed fee", 2_000_025],
    ]);
    // What's left, per phase.
    const left = (await s.json(`/api/invoices/preview?clientId=${s.client.id}`)).body.fixedFees;
    expect(left).toEqual([expect.objectContaining({ projectId: s.project.id, fee: 3_250_075, invoiced: 2_625_050, left: 625_025, phases: [expect.objectContaining({ taskId: s.sd, left: 625_025 })] })]);

    // Never more than a phase's own fee, and never the project's fee as a whole.
    expect(await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 625_026 }])).toMatchObject({ status: 409, body: { error: expect.stringContaining("Library – Schematic Design") } });
    expect((await s.invoice([{ projectId: s.project.id, taskId: s.dd, amount: 1 }])).status).toBe(409);
    expect((await s.invoice([{ projectId: s.project.id, amount: 100 }])).status).toBe(409);
    expect((await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 625_025 }])).status).toBe(201);
    const page = (await s.json(`/api/projects/${s.project.id}`)).body;
    expect(page.phases.map((p: { title: string; invoiced: number; left: number }) => [p.title, p.invoiced, p.left])).toEqual([["Schematic Design", 1_250_050, 0], ["Design Development", 2_000_025, 0]]);
  });

  it("lets only one of two invoices made at once bill the same part of a phase", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_000_000 });
    const results = await Promise.all([
      s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 700_000 }]),
      s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 700_000 }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const billed = await prisma.invoiceLine.aggregate({ where: { kind: "fee", taskId: s.sd }, _sum: { amount: true } });
    expect(billed._sum.amount).toBe(700_000);
  });

  it("keeps a changed draft line within what's left of its phase", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_000_000, [s.dd]: 500_000 });
    const made = (await s.json(`/api/invoices/${(await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 400_000 }])).body.invoice.id}`)).body.invoice;
    const line = made.lines[0];
    expect((await s.json(`/api/invoices/${made.id}/lines/${line.id}`, { method: "PATCH", body: { unitPrice: 1_000_001 } })).status).toBe(400);
    expect((await s.json(`/api/invoices/${made.id}/lines/${line.id}`, { method: "PATCH", body: { unitPrice: 1_000_000 } })).status).toBe(200);
  });

  it("repeats a phase's line within what's left of it, then leaves it out", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_000_000 });
    const source = (await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 400_000 }])).body.invoice;
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "PUT", body: { every: "month", nextDate: "2026-11-15" } })).status).toBe(200);
    await sweepRecurringInvoices(new Date("2026-11-15T12:00:00Z"));
    await sweepRecurringInvoices(new Date("2026-12-15T12:00:00Z"));
    const lines = await prisma.invoiceLine.findMany({ where: { kind: "fee", taskId: s.sd }, orderBy: { invoice: { issueDate: "asc" } }, select: { amount: true } });
    // 400,000 + 400,000, then only 200,000 is left, so the third isn't repeated.
    expect(lines.map((l) => l.amount)).toEqual([400_000, 400_000]);
    const third = await prisma.auditEvent.findFirst({ where: { actorName: "Repeating invoice", action: "created" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(third?.changes)).toContain("Left out: Library – Schematic Design – fixed fee");
  });

  it("counts each phase's invoiced fee as the project's revenue", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_000_000, [s.dd]: 500_000 });
    await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 300_000 }, { projectId: s.project.id, taskId: s.dd, amount: 150_050 }]);
    const report = (await s.json(`/api/reports/profitability?from=${TODAY}&to=${TODAY}`)).body;
    expect(report.projects).toMatchObject([{ label: "Library", revenue: 450_050 }]);
  });
});

describe("what can change once a phase is invoiced", () => {
  it("can't switch back, lower a phase below what's billed or delete it, until the invoice goes", async () => {
    const s = await studio();
    await s.perPhase({ [s.sd]: 1_000_000, [s.dd]: 500_000 });
    const draft = (await s.invoice([{ projectId: s.project.id, taskId: s.sd, amount: 600_000 }])).body.invoice;

    expect((await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { feeByPhase: false } })).status).toBe(400);
    expect((await s.json(`/api/projects/${s.project.id}/phase-fees`, { method: "PUT", body: { fees: { [s.sd]: 599_999 } } })).status).toBe(409);
    expect((await s.json(`/api/projects/${s.project.id}/phase-fees`, { method: "PUT", body: { fees: { [s.sd]: null } } })).status).toBe(409);
    expect((await s.json(`/api/tasks/${s.sd}`, { method: "DELETE" })).status).toBe(409);
    // A phase with nothing billed can go; the fee follows.
    expect((await s.json(`/api/tasks/${s.dd}`, { method: "DELETE" })).status).toBe(200);
    expect((await s.json(`/api/projects/${s.project.id}`)).body.project.fixedFee).toBe(1_000_000);

    expect((await s.json(`/api/invoices/${draft.id}`, { method: "DELETE" })).status).toBe(200);
    const back = await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { feeByPhase: false } });
    expect(back.status).toBe(200);
    expect(back.body.project).toMatchObject({ feeByPhase: false, fixedFee: 1_000_000 });
    expect(await prisma.task.count({ where: { projectId: s.project.id, fee: { not: null } } })).toBe(0);
    // Switching to per phase needs nothing invoiced too.
    await s.invoice([{ projectId: s.project.id, amount: 1 }]);
    expect((await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { feeByPhase: true } })).status).toBe(400);
  });

  it("keeps each organization's phases to itself", async () => {
    const north = await studio();
    const south = await studio("South", "south.test");
    await north.perPhase({ [north.sd]: 1_000_000 });
    expect((await south.json(`/api/projects/${north.project.id}/phase-fees`, { method: "PUT", body: { fees: { [north.sd]: 1 } } })).status).toBe(404);
    // Another organization's phase on this organization's project is no phase at all.
    await south.perPhase({ [south.sd]: 1_000_000 });
    expect((await south.invoice([{ projectId: south.project.id, taskId: north.sd, amount: 100 }])).status).toBe(409);
    expect((await south.json(`/api/projects/${south.project.id}/phase-fees`, { method: "PUT", body: { fees: { [north.sd]: 5 } } })).body.project.fixedFee).toBe(1_000_000);
  });
});
