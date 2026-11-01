import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { occurrence, sweepRecurringInvoices } from "../src/server/recurring.ts";
import { addDays } from "../src/shared/time.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Repeating invoices (WRK-42): on each date a schedule makes one new draft from its invoice,
// never sends it, and stops when paused, ended or stopped.

beforeEach(resetDatabase);

// The organizations here use UTC, so "today" is the UTC date.
const today = () => new Date().toISOString().slice(0, 10);
const at = (date: string) => new Date(`${date}T12:00:00Z`);

async function studio() {
  const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json() };
  };
  const client = (await json("/api/clients", { body: { name: "Acme" } })).body.client;
  return { organization, admin, member, json, client };
}

/** An invoice with a retainer line, a fixed fee line and a line of billed time. */
async function retainer(s: Awaited<ReturnType<typeof studio>>, issueDate: string) {
  const hourly = (await s.json("/api/projects", { body: { name: "Support", clientId: s.client.id, hourlyRate: 10_000 } })).body.project;
  const fixed = (await s.json("/api/projects", { body: { name: "Rebrand", clientId: s.client.id, fixedFee: 100_000 } })).body.project;
  await s.json("/api/time-entries", { body: { projectId: hourly.id, date: issueDate, seconds: 3600, billable: true } });
  const created = await s.json("/api/invoices", { body: { clientId: s.client.id, issueDate, dueDate: addDays(issueDate, 14), fees: [{ projectId: fixed.id, amount: 30_000 }] } });
  expect(created.status).toBe(201);
  const id = created.body.invoice.id as string;
  expect((await s.json(`/api/invoices/${id}/lines`, { body: { description: "Monthly retainer", quantity: 1000, unitPrice: 250_000 } })).status).toBe(201);
  expect((await s.json(`/api/invoices/${id}`, { method: "PATCH", body: { subject: "Retainer", poNumber: "PO-7", notes: "Thank you!", taxPercent: "10", discountPercent: "5" } })).status).toBe(200);
  return { id, fixed };
}

const repeat = (s: Awaited<ReturnType<typeof studio>>, id: string, body: Record<string, unknown>) => s.json(`/api/invoices/${id}/schedule`, { method: "PUT", body });
const invoices = async (s: Awaited<ReturnType<typeof studio>>) => (await s.json("/api/invoices")).body.invoices as { id: string; number: string; status: string; issueDate: string; schedule: unknown }[];

describe("occurrence", () => {
  it("counts weeks in days, and months from the first date's day, clamped to short months", () => {
    expect(occurrence("2026-10-23", "week", 2)).toBe("2026-11-06");
    expect(occurrence("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(occurrence("2026-01-31", "month", 2)).toBe("2026-03-31");
    expect(occurrence("2026-12-15", "month", 1)).toBe("2027-01-15");
    expect(occurrence("2027-11-30", "quarter", 1)).toBe("2028-02-29");
    expect(occurrence("2026-11-30", "quarter", 4)).toBe("2027-11-30");
  });
});

describe("repeating an invoice", () => {
  it("makes a draft copy right away when the next date is today, with its own lines but not its time", async () => {
    const s = await studio();
    const source = await retainer(s, addDays(today(), -10));
    const saved = await repeat(s, source.id, { every: "month", nextDate: today() });
    expect(saved.status).toBe(200);
    expect(saved.body.made).toHaveLength(1);
    expect(saved.body.schedule).toEqual({ every: "month", nextDate: occurrence(today(), "month", 1), endDate: null, paused: false, made: 1 });

    const draft = (await s.json(`/api/invoices/${saved.body.made[0]}`)).body.invoice;
    expect(draft).toMatchObject({ status: "draft", issueDate: today(), dueDate: addDays(today(), 14), currency: "USD", subject: "Retainer", poNumber: "PO-7", notes: "Thank you!", taxBasisPoints: 1000, discountBasisPoints: 500 });
    expect(draft.lines.map((l: { kind: string; description: string; amount: number }) => [l.kind, l.description, l.amount])).toEqual([
      ["fee", expect.stringContaining("Rebrand"), 30_000],
      ["custom", "Monthly retainer", 250_000],
    ]);
    expect(draft.client.id).toBe(s.client.id);
    // The History says it was made by the schedule.
    const event = await prisma.auditEvent.findFirst({ where: { subjectId: draft.id, action: "created" } });
    expect(event).toMatchObject({ actorName: "Repeating invoice", actorId: null });

    // The source invoice shows its schedule, in the list too.
    const listed = (await invoices(s)).find((i) => i.id === source.id);
    expect(listed?.schedule).toMatchObject({ every: "month", paused: false });
  });

  it("makes each draft once, on its date, however often the sweep runs", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    expect((await repeat(s, source.id, { every: "week", nextDate: addDays(today(), 7) })).body.made).toEqual([]);
    expect(await sweepRecurringInvoices(at(addDays(today(), 6)))).toBe(0);
    expect(await sweepRecurringInvoices(at(addDays(today(), 7)))).toBe(1);
    expect(await sweepRecurringInvoices(at(addDays(today(), 7)))).toBe(0);
    expect(await Promise.all([sweepRecurringInvoices(at(addDays(today(), 14))), sweepRecurringInvoices(at(addDays(today(), 14)))])).toSatisfy((counts: number[]) => counts[0]! + counts[1]! === 1);
    const drafts = (await invoices(s)).filter((i) => i.id !== source.id);
    expect(drafts.map((d) => d.issueDate).sort()).toEqual([addDays(today(), 7), addDays(today(), 14)]);
    expect(new Set(drafts.map((d) => d.number)).size).toBe(2);
  });

  it("leaves out a fixed fee line once the fee is used up, and says so in the History", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    // 300.00 of the 1,000.00 fee is on the source; two more repeats fit, the third doesn't.
    const saved = await repeat(s, source.id, { every: "week", nextDate: addDays(today(), -14) });
    expect(saved.body.made).toHaveLength(3);
    const third = (await s.json(`/api/invoices/${saved.body.made[2]}`)).body.invoice;
    expect(third.lines.map((l: { kind: string }) => l.kind)).toEqual(["custom"]);
    const notes = await prisma.auditEvent.findFirst({ where: { subjectId: third.id, action: "created" } });
    expect(JSON.stringify(notes?.changes)).toContain("Left out: ");
    const fee = (await s.json(`/api/projects/${source.fixed.id}`)).body.stats;
    expect(fee.feeInvoiced).toBe(90_000);
  });

  it("stops while paused, and on resuming skips the dates it missed", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    await repeat(s, source.id, { every: "week", nextDate: addDays(today(), 7) });
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "PATCH", body: { paused: true } })).body.schedule.paused).toBe(true);
    expect(await sweepRecurringInvoices(at(addDays(today(), 21)))).toBe(0);
    // Resumed today: next week's date hasn't come, so nothing is made and nothing is skipped.
    const resumed = await s.json(`/api/invoices/${source.id}/schedule`, { method: "PATCH", body: { paused: false } });
    expect(resumed.body).toMatchObject({ made: [], schedule: { paused: false, nextDate: addDays(today(), 7) } });
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "PATCH", body: { paused: "yes" } })).status).toBe(400);
  });

  it("ends after its end date", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    const saved = await repeat(s, source.id, { every: "month", nextDate: today(), endDate: addDays(today(), 3) });
    expect(saved.body.made).toHaveLength(1);
    expect(saved.body.schedule.nextDate).toBeNull();
    expect(await sweepRecurringInvoices(at(occurrence(today(), "month", 1)))).toBe(0);
  });

  it("refuses unclear schedules, and stops when the schedule or its invoice is deleted", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    for (const body of [
      { every: "day", nextDate: today() },
      { every: "month", nextDate: "next week" },
      { every: "month", nextDate: today(), endDate: addDays(today(), -1) },
      { every: "month", nextDate: addDays(today(), -40) },
    ]) expect((await repeat(s, source.id, body)).status, JSON.stringify(body)).toBe(400);
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "DELETE" })).status).toBe(404);

    await repeat(s, source.id, { every: "month", nextDate: addDays(today(), 5) });
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "DELETE" })).status).toBe(200);
    expect((await s.json(`/api/invoices/${source.id}`)).body.invoice.schedule).toBeNull();

    // A draft that repeats takes its schedule with it when it's deleted.
    await repeat(s, source.id, { every: "month", nextDate: addDays(today(), 5) });
    expect((await s.json(`/api/invoices/${source.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await prisma.invoiceSchedule.count()).toBe(0);
  });

  it("is for managers, and only on the organization's own invoices", async () => {
    const s = await studio();
    const source = await retainer(s, today());
    expect((await repeat(s, source.id, { every: "month", nextDate: today() })).status).toBe(200);
    expect((await s.json(`/api/invoices/${source.id}/schedule`, { method: "PUT", cookie: s.member, body: { every: "month", nextDate: today() } })).status).toBe(403);

    await createOrgWithUser("Other", "admin@other.test", "admin-password-1", "admin");
    const other = (await signIn("admin@other.test", "admin-password-1")).cookie;
    const res = await request(`/api/invoices/${source.id}/schedule`, { method: "PUT", cookie: other, body: { every: "week", nextDate: today() } });
    expect(res.status).toBe(404);
    expect(await prisma.invoiceSchedule.count()).toBe(1);
  });
});
