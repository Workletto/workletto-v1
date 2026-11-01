import { beforeEach, describe, expect, it } from "vitest";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Fixed fee projects (WRK-134): their time isn't billed by the hour; the fee is invoiced in full
// or in parts, never more than the fee, and counts as revenue when it's invoiced.

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio() {
  const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json() };
  };
  const client = (await json("/api/clients", { body: { name: "Acme" } })).body.client;
  const other = (await json("/api/clients", { body: { name: "Other" } })).body.client;
  const project = (await json("/api/projects", { body: { name: "Rebrand", clientId: client.id, fixedFee: 1_200_000, hourlyRate: 15_000 } })).body.project;
  const invoice = (fees: { projectId: string; amount: number }[], clientId = client.id) =>
    json("/api/invoices", { body: { clientId, issueDate: TODAY, fees } });
  return { organization, member, admin, memberCookie, json, client, other, project, invoice };
}

describe("fixed fee projects", () => {
  it("are set up with a fee that members never see", async () => {
    const s = await studio();
    expect(s.project).toMatchObject({ fixedFee: 1_200_000 });
    const { body } = await s.json("/api/projects", { cookie: s.memberCookie });
    expect(body.projects[0]).not.toHaveProperty("fixedFee");

    for (const fixedFee of [0, -100, "1200", 12.5]) {
      expect((await s.json("/api/projects", { body: { name: `Bad ${fixedFee}`, fixedFee } })).status).toBe(400);
    }
    // Its time has no hourly value, so a money budget means nothing; hours are fine.
    expect((await s.json("/api/projects", { body: { name: "Money budget", fixedFee: 5000, budgetBy: "fees", budgetAmount: 5000 } })).status).toBe(400);
    expect((await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { budgetBy: "fees", budgetAmount: 5000 } })).status).toBe(400);
    expect((await s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body: { budgetBy: "hours", budgetSeconds: 36_000 } })).status).toBe(200);
  });

  it("never bill their time by the hour, and give it no hourly value in reports", async () => {
    const s = await studio();
    await s.json("/api/time-entries", { body: { projectId: s.project.id, date: TODAY, seconds: 7200, billable: true } });

    const preview = (await s.json(`/api/invoices/preview?clientId=${s.client.id}`)).body;
    expect(preview.lines).toEqual([]);
    expect(preview.seconds).toBe(0);
    expect(preview.fixedFees).toEqual([{ projectId: s.project.id, name: "Rebrand", fee: 1_200_000, invoiced: 0, left: 1_200_000, phases: null }]);

    const summary = (await s.json(`/api/reports/summary?from=${TODAY}&to=${TODAY}`)).body;
    expect(summary.totals).toMatchObject({ seconds: 7200, billableSeconds: 7200, billableAmount: 0 });
    const page = (await s.json(`/api/projects/${s.project.id}`)).body;
    expect(page.stats).toMatchObject({ seconds: 7200, billableAmount: 0, feeInvoiced: 0 });

    const ready = (await s.json("/api/invoices/unbilled")).body.clients;
    expect(ready).toEqual([{ client: { id: s.client.id, name: "Acme" }, currency: "USD", seconds: 0, amount: 0, expenses: 0, fees: 1_200_000 }]);
  });

  it("invoice the fee in parts, never more than what's left", async () => {
    const s = await studio();
    const first = await s.invoice([{ projectId: s.project.id, amount: 400_000 }]);
    expect(first.status).toBe(201);
    const made = (await s.json(`/api/invoices/${first.body.invoice.id}`)).body.invoice;
    expect(made.lines).toMatchObject([{ kind: "fee", description: "Rebrand – fixed fee", quantity: 1000, unitPrice: 400_000, amount: 400_000 }]);
    expect(made.subtotal).toBe(400_000);

    const tooMuch = await s.invoice([{ projectId: s.project.id, amount: 800_001 }]);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toBe("That's more than what's left of the Rebrand fee to bill ($8,000.00).");

    expect((await s.invoice([{ projectId: s.project.id, amount: 800_000 }])).status).toBe(201);
    expect((await s.json(`/api/invoices/preview?clientId=${s.client.id}`)).body.fixedFees).toEqual([]);
    const allDone = await s.invoice([{ projectId: s.project.id, amount: 1 }]);
    expect(allDone.body.error).toBe("The whole Rebrand fee is already on invoices.");
    expect((await s.json(`/api/projects/${s.project.id}`)).body.stats.feeInvoiced).toBe(1_200_000);
  });

  it("only bills a fee for the invoice's own client, once per invoice, as an amount", async () => {
    const s = await studio();
    expect((await s.invoice([{ projectId: s.project.id, amount: 1000 }], s.other.id)).status).toBe(409);
    expect((await s.invoice([{ projectId: s.project.id, amount: 1000 }, { projectId: s.project.id, amount: 1000 }])).status).toBe(400);
    for (const amount of [0, -5, 10.5, "100"]) expect((await s.invoice([{ projectId: s.project.id, amount: amount as number }])).status).toBe(400);
  });

  it("can't bill the same part twice when two invoices are made at once", async () => {
    const s = await studio();
    const both = await Promise.all([s.invoice([{ projectId: s.project.id, amount: 1_200_000 }]), s.invoice([{ projectId: s.project.id, amount: 1_200_000 }])]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("lets a draft's fee line change within what's left, and frees it when removed", async () => {
    const s = await studio();
    await s.invoice([{ projectId: s.project.id, amount: 300_000 }]);
    const id = (await s.invoice([{ projectId: s.project.id, amount: 500_000 }])).body.invoice.id;
    const line = (await s.json(`/api/invoices/${id}`)).body.invoice.lines[0];
    const change = (unitPrice: number) => s.json(`/api/invoices/${id}/lines/${line.id}`, { method: "PATCH", body: { unitPrice } });

    // 300,000 is on the other invoice, so this line can be up to 900,000.
    expect((await change(900_001)).body.error).toBe("That's more than what's left of the Rebrand fee to bill ($9,000.00).");
    expect((await change(0)).status).toBe(400);
    expect((await change(900_000)).body.line).toMatchObject({ amount: 900_000 });
    expect((await s.json(`/api/projects/${s.project.id}`)).body.stats.feeInvoiced).toBe(1_200_000);

    expect((await s.json(`/api/invoices/${id}/lines/${line.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await s.json(`/api/projects/${s.project.id}`)).body.stats.feeInvoiced).toBe(300_000);
  });

  it("keeps a project billed by the hour once any of its time is on an invoice", async () => {
    const s = await studio();
    const hourly = (await s.json("/api/projects", { body: { name: "Retainer", clientId: s.client.id, hourlyRate: 10_000 } })).body.project;
    const patch = (body: Record<string, unknown>) => s.json(`/api/projects/${hourly.id}`, { method: "PATCH", body });
    await s.json("/api/time-entries", { body: { projectId: hourly.id, date: TODAY, seconds: 3600, billable: true } });
    // Nothing invoiced yet: it can still become a fixed fee project, and go back.
    expect((await patch({ fixedFee: 500_000 })).body.project.fixedFee).toBe(500_000);
    expect((await patch({ fixedFee: null })).body.project.fixedFee).toBeNull();

    expect((await s.json("/api/invoices", { body: { clientId: s.client.id, issueDate: TODAY } })).status).toBe(201);
    expect((await patch({ fixedFee: 500_000 })).body.error).toBe("Some of this project's time is already on an invoice at an hourly rate, so it stays billed by the hour.");
  });

  it("keep a fee once any of it is invoiced: no lower than that, and no going back to hourly", async () => {
    const s = await studio();
    // Before anything is invoiced, the project can still go back to billing by the hour.
    const spare = (await s.json("/api/projects", { body: { name: "Spare", clientId: s.client.id, fixedFee: 50_000 } })).body.project;
    expect((await s.json(`/api/projects/${spare.id}`, { method: "PATCH", body: { fixedFee: null } })).body.project.fixedFee).toBeNull();

    await s.invoice([{ projectId: s.project.id, amount: 400_000 }]);
    const patch = (body: Record<string, unknown>) => s.json(`/api/projects/${s.project.id}`, { method: "PATCH", body });
    expect((await patch({ fixedFee: null })).body.error).toBe("Part of this project's fee is already on an invoice, so it stays a fixed fee project.");
    expect((await patch({ fixedFee: 399_999 })).body.error).toBe("$4,000.00 of this fee is already on invoices, so the fee can't be less than that.");
    expect((await patch({ fixedFee: 400_000 })).status).toBe(200);
    expect((await patch({ fixedFee: 1_500_000 })).body.project.fixedFee).toBe(1_500_000);

    // And a project with an invoiced fee can only be archived.
    expect((await s.json(`/api/projects/${s.project.id}`, { method: "DELETE" })).body.error).toBe("This project has time, expenses or an invoiced fee on it. Archive it instead.");
  });

  it("count the invoiced fee as revenue on the invoice's date, against the time's cost", async () => {
    const s = await studio();
    await s.json(`/api/people/${s.member.id}`, { method: "PATCH", body: { costRate: 5000 } });
    await s.json("/api/time-entries", { body: { projectId: s.project.id, date: TODAY, seconds: 36_000 }, cookie: s.memberCookie }); // 10 h × $50
    await s.invoice([{ projectId: s.project.id, amount: 400_000 }]);

    const report = (await s.json(`/api/reports/profitability?from=${TODAY}&to=${TODAY}`)).body;
    expect(report.totals).toMatchObject({ revenue: 400_000, invoiced: 400_000, uninvoiced: 0, timeCost: 50_000, profit: 350_000 });
    expect(report.projects).toMatchObject([{ label: "Rebrand", revenue: 400_000, cost: 50_000 }]);
    expect(report.clients).toMatchObject([{ label: "Acme", revenue: 400_000 }]);
    // A fee is nobody's time: it's a row of its own in the split by person.
    expect(report.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fixed fees", revenue: 400_000, cost: 0 }),
        expect.objectContaining({ id: s.member.id, revenue: 0, cost: 50_000 }),
      ]),
    );
    const byPerson = (await s.json(`/api/reports/profitability?from=${TODAY}&to=${TODAY}&userId=${s.member.id}`)).body;
    expect(byPerson.totals.revenue).toBe(0);
    const otherDay = (await s.json(`/api/reports/profitability?from=2026-10-16&to=2026-10-31`)).body;
    expect(otherDay.totals.revenue).toBe(0);
  });
});
