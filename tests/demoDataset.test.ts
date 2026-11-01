import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/server/db.ts";
import { DEMO_MONTHS } from "../src/server/demo.ts";
import { demoStartsPerIp } from "../src/server/rateLimit.ts";
import { generateDataset, type DemoDataset } from "../src/server/demoDataset.ts";
import { rateFor, valueOf } from "../src/server/billing.ts";
import { toHome } from "../src/server/currency.ts";
import { addDays } from "../src/shared/time.ts";
import { cookieFrom, request, resetDatabase } from "./helpers.ts";
import { checkLogo } from "../src/server/logo.ts";

vi.setConfig({ testTimeout: 60_000 });

const TODAY = "2026-10-14"; // a Wednesday
const full = generateDataset({ today: TODAY, months: 24 });
function inRange(n: number, low: number, high: number) {
  expect(n).toBeGreaterThanOrEqual(low);
  expect(n).toBeLessThanOrEqual(high);
}

describe("the generated dataset", () => {
  it("is the same every time for the same day, and different on another day", () => {
    expect(generateDataset({ today: TODAY, months: 24 })).toEqual(full);
    expect(generateDataset({ today: "2026-10-21", months: 24 })).not.toEqual(full);
  });

  it("has the size of a small studio's two years", () => {
    inRange(full.people.length, 12, 15);
    inRange(full.clients.length, 18, 22);
    inRange(full.clients.filter((c) => c.archived).length, 2, 3);
    inRange(full.projects.length, 45, 55);
    inRange(full.tasks.length, 250, 350);
    inRange(full.entries.length, 8500, 11500);
    inRange(full.expenses.length, 170, 230);
    inRange(full.invoices.length, 130, 175);
    expect(full.people.filter((p) => p.role === "admin")).toHaveLength(1);
    expect(full.people.filter((p) => p.role === "manager")).toHaveLength(2);
    expect(full.people.filter((p) => p.left)).toHaveLength(1);
    expect(full.people.every((p) => p.hourlyRate >= 8500 && p.hourlyRate <= 17500)).toBe(true);
  });

  it("mixes kinds of project", () => {
    const { projects } = full;
    expect(projects.filter((p) => !p.billable).map((p) => p.name).sort()).toEqual(["New business", "Studio admin", "Training"]);
    expect(projects.filter((p) => p.billable && p.endDate === null)).toHaveLength(3); // monthly retainers
    expect(projects.some((p) => p.billBy === "person")).toBe(true);
    expect(projects.some((p) => p.billBy === "project" && p.billable)).toBe(true);
    expect(projects.some((p) => p.budgetBy === "hours")).toBe(true);
    expect(projects.some((p) => p.budgetBy === "fees")).toBe(true);
    expect(projects.some((p) => p.archived)).toBe(true);
    expect(projects.some((p) => !p.archived && p.billable)).toBe(true);
    // Finished projects come in under budget, a few go 10-30% over.
    const rates = new Map(full.people.map((p) => [p.key, p]));
    const used = new Map<string, { seconds: number; value: number }>();
    for (const e of full.entries) {
      const project = projects.find((p) => p.key === e.projectKey)!;
      const u = used.get(project.key) ?? { seconds: 0, value: 0 };
      u.seconds += e.seconds;
      if (e.billable) u.value += valueOf(e.seconds, rateFor(project, rates.get(e.personKey)!) ?? 0);
      used.set(project.key, u);
    }
    const ratios = projects.filter((p) => p.endDate && p.endDate < TODAY && p.budgetBy !== "none").map((p) =>
      p.budgetBy === "hours" ? used.get(p.key)!.seconds / p.budgetSeconds! : used.get(p.key)!.value / p.budgetAmount!);
    expect(ratios.filter((r) => r > 1.05 && r < 1.35).length).toBeGreaterThanOrEqual(2);
    expect(ratios.filter((r) => r < 1).length).toBeGreaterThanOrEqual(5);
  });

  it("has realistic days of work", () => {
    const people = new Map(full.people.map((p) => [p.key, p]));
    const perDay = new Map<string, number>();
    for (const e of full.entries) {
      expect(e.seconds % 900).toBe(0);
      expect(e.seconds).toBeGreaterThan(0);
      const weekday = new Date(`${e.date}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(weekday);
      expect(e.date.slice(5)).not.toBe("12-25");
      expect(e.date >= people.get(e.personKey)!.joined).toBe(true);
      const left = people.get(e.personKey)!.left;
      if (left) expect(e.date <= left).toBe(true);
      perDay.set(`${e.personKey}|${e.date}`, (perDay.get(`${e.personKey}|${e.date}`) ?? 0) + e.seconds);
    }
    for (const [key, seconds] of perDay) {
      if (key.endsWith(TODAY)) expect(seconds).toBeLessThanOrEqual(14 * 900); // only a morning
      else {
        expect(seconds).toBeGreaterThanOrEqual(6 * 3600);
        expect(seconds).toBeLessThanOrEqual(7.5 * 3600);
      }
    }
    expect([...perDay.keys()].some((k) => k.endsWith(TODAY))).toBe(true);
    const linked = full.entries.filter((e) => e.taskKey).length / full.entries.length;
    inRange(linked, 0.08, 0.2);
    // Projects don't take time outside their dates, and tasks belong to the entry's project.
    const projects = new Map(full.projects.map((p) => [p.key, p]));
    const tasks = new Map(full.tasks.map((t) => [t.key, t]));
    for (const e of full.entries) {
      const p = projects.get(e.projectKey)!;
      if (p.endDate) expect(e.date <= p.endDate).toBe(true);
      if (e.taskKey) expect(tasks.get(e.taskKey)!.projectKey).toBe(e.projectKey);
    }
  });

  it("has done tasks in the past and open ones around today", () => {
    expect(full.tasks.filter((t) => t.status === "done").every((t) => t.completedAt !== null && t.completedAt.slice(0, 10) < TODAY)).toBe(true);
    expect(full.tasks.filter((t) => t.status !== "done").every((t) => t.completedAt === null)).toBe(true);
    const open = full.tasks.filter((t) => t.status !== "done");
    expect(open.length).toBeGreaterThan(10);
    expect(open.some((t) => t.dueDate! < TODAY)).toBe(true);
    expect(open.some((t) => t.dueDate! > TODAY)).toBe(true);
  });

  it("only invoices a client's own work, once, with money worked out by the app's own rules", () => {
    expectInvoicesAreSound(full);
  });

  it("settles invoices the way a real year would", () => {
    const status = (s: string) => full.invoices.filter((i) => i.status === s);
    inRange(status("draft").length, 1, 2);
    inRange(status("sent").length, 3, 20);
    const overdue = status("sent").filter((i) => i.dueDate < TODAY);
    inRange(overdue.length, 2, 3);
    for (const i of status("paid")) expect(i.paidAt!.slice(0, 10) >= i.issueDate).toBe(true);
    for (const i of full.invoices.filter((x) => x.status !== "paid")) expect(i.paidAt).toBeNull();
    for (const i of status("draft")) expect(i.sentAt).toBeNull();
    for (const i of full.invoices) {
      expect(i.issueDate <= TODAY).toBe(true);
      expect(i.dueDate >= i.issueDate).toBe(true);
    }
    // Everything more than two months old has been paid.
    expect(full.invoices.filter((i) => i.periodTo < "2026-08-01").every((i) => i.status === "paid")).toBe(true);
    // Numbered in order of issue date.
    expect(full.invoices.map((i) => i.number)).toEqual(full.invoices.map((_, n) => String(n + 1).padStart(4, "0")));
    const dates = full.invoices.map((i) => i.issueDate);
    expect(dates).toEqual([...dates].sort());
  });

  it("leaves this month's time and expenses unbilled", () => {
    const billed = new Set(full.invoices.flatMap((i) => i.lines.flatMap((l) => [...l.entryKeys, ...l.expenseKeys])));
    const unbilled = [...full.entries, ...full.expenses].filter((x) => x.billable && !billed.has(x.key));
    const projects = new Map(full.projects.map((p) => [p.key, p]));
    const client = unbilled.filter((x) => projects.get(x.projectKey)!.clientKey);
    expect(client.length).toBeGreaterThan(50);
    expect(client.every((x) => x.date.startsWith("2026-10"))).toBe(true);
    // Time on internal projects is not billable at all.
    expect(full.entries.filter((e) => projects.get(e.projectKey)!.billable === false).every((e) => !e.billable)).toBe(true);
  });

  it("shows the newer features: fees, a currency, time off, plans, a repeating invoice, fields and groups", () => {
    const projects = new Map(full.projects.map((p) => [p.key, p]));
    // A fixed fee project with part of its fee invoiced, and one billed per phase.
    const fixed = full.projects.find((p) => p.fixedFee !== null && !p.feeByPhase)!;
    const phased = full.projects.find((p) => p.feeByPhase)!;
    const feeLines = full.invoices.flatMap((i) => i.lines).filter((l) => l.kind === "fee");
    const billed = (key: string) => feeLines.filter((l) => l.projectKey === key).reduce((s, l) => s + l.amount, 0);
    expect(billed(fixed.key)).toBeGreaterThan(0);
    expect(billed(fixed.key)).toBeLessThan(fixed.fixedFee!);
    const phases = full.tasks.filter((t) => t.projectKey === phased.key && t.fee);
    expect(phases.length).toBe(3);
    expect(phased.fixedFee).toBe(phases.reduce((s, t) => s + t.fee!, 0));
    expect(billed(phased.key)).toBeLessThan(phased.fixedFee!);
    // Both have hours this month, taken from other projects: nobody's day gets longer.
    for (const p of [fixed, phased]) expect(full.entries.some((e) => e.projectKey === p.key)).toBe(true);
    // A client billed in euros, at a rate.
    expect(full.clients.filter((c) => c.currency === "EUR")).toHaveLength(1);
    expect(full.exchangeRates).toEqual({ EUR: 1_080_000 });
    // Time off for two people and a studio holiday, all ahead.
    expect(new Set(full.timeOff.map((t) => t.personKey)).size).toBe(2);
    expect(full.timeOff.every((t) => t.date > TODAY)).toBe(true);
    expect(full.holidays).toHaveLength(1);
    expect(full.holidays[0]!.date > TODAY).toBe(true);
    // Four weeks of plans, one person over 40 hours in one week.
    const weeks = new Set(full.schedule.map((p) => p.weekStart));
    expect(weeks.size).toBe(4);
    const perWeek = new Map<string, number>();
    for (const p of full.schedule) perWeek.set(`${p.personKey}|${p.weekStart}`, (perWeek.get(`${p.personKey}|${p.weekStart}`) ?? 0) + p.minutes);
    expect([...perWeek.values()].filter((m) => m > 40 * 60)).toHaveLength(1);
    expect(full.schedule.every((p) => projects.has(p.projectKey))).toBe(true);
    // Nobody is booked on a day off or a studio holiday.
    for (const t of full.timeOff) expect(full.schedule.some((p) => p.personKey === t.personKey && p.weekStart === addDays(t.date, -((new Date(`${t.date}T00:00:00Z`).getUTCDay() + 6) % 7)))).toBe(false);
    for (const h of full.holidays) expect(full.schedule.some((p) => p.weekStart <= h.date && h.date <= addDays(p.weekStart, 6))).toBe(false);
    // A monthly repeating invoice, and a late-payment reminder already sent.
    expect(full.invoices.filter((i) => i.repeat)).toHaveLength(1);
    expect(full.invoiceReminderDays).toBe(7);
    const reminded = full.invoices.filter((i) => i.remindersSent);
    expect(reminded).toHaveLength(1);
    // Every reminder due by today has gone out, so the page never promises one the demo won't send.
    const next = addDays(reminded[0]!.dueDate, 7 * (reminded[0]!.remindersSent! + 1));
    expect(reminded[0]!.remindersSent === 3 || next > TODAY).toBe(true);
    // The project billed per phase suits its client.
    const phasedClient = full.clients.find((c) => c.key === phased.clientKey)!;
    expect(phased.name === "Riverside Library").toBe(phasedClient.name.includes("Architects"));
    // A list field on recent time, user groups and a template.
    expect(full.fields.map((f) => f.name)).toEqual(["Phase", "PO number"]);
    expect(full.fieldValues.filter((v) => v.entryKey).length).toBeGreaterThan(100);
    expect(full.groups.map((g) => g.name)).toEqual(["Strategy", "Design", "Development", "Content"]);
    expect(full.templates).toHaveLength(1);
  });

  it("works for a short window too", () => {
    const six = generateDataset({ today: TODAY, months: 6 });
    expect(six.windowStart).toBe("2026-04-01");
    expect(six.entries.every((e) => e.date >= "2026-04-01")).toBe(true);
    expect(six.people.some((p) => p.left)).toBe(false);
    expectInvoicesAreSound(six);
    const keys = new Set(six.projects.map((p) => p.key));
    expect(six.entries.every((e) => keys.has(e.projectKey))).toBe(true);
    expect(six.tasks.every((t) => keys.has(t.projectKey))).toBe(true);
  });
});

function expectInvoicesAreSound(data: DemoDataset) {
  const entries = new Map(data.entries.map((e) => [e.key, e]));
  const expenses = new Map(data.expenses.map((x) => [x.key, x]));
  const projects = new Map(data.projects.map((p) => [p.key, p]));
  const people = new Map(data.people.map((p) => [p.key, p]));
  const seen = new Set<string>();
  for (const invoice of data.invoices) {
    expect(invoice.lines.length).toBeGreaterThan(0);
    for (const line of invoice.lines) {
      if (line.kind === "time") {
        const rows = line.entryKeys.map((k) => entries.get(k)!);
        const seconds = rows.reduce((s, e) => s + e.seconds, 0);
        expect(line.amount).toBe(Math.round(valueOf(seconds, line.unitPrice)));
        expect(line.quantity).toBe(Math.round(seconds / 3.6));
        for (const e of rows) {
          const project = projects.get(e.projectKey)!;
          expect(e.billable).toBe(true);
          expect(project.clientKey).toBe(invoice.clientKey);
          expect(e.date >= invoice.periodFrom && e.date <= invoice.periodTo).toBe(true);
          expect(rateFor(project, people.get(e.personKey)!)).toBe(line.unitPrice);
        }
      } else if (line.kind === "fee") {
        // A part of a fixed fee (WRK-145): the client's own fixed fee project, within its fee (or its phase's).
        const project = projects.get(line.projectKey!)!;
        expect(project.fixedFee).not.toBeNull();
        expect(project.clientKey).toBe(invoice.clientKey);
        const limit = line.taskKey ? data.tasks.find((t) => t.key === line.taskKey)!.fee! : project.fixedFee!;
        expect(line.amount).toBeGreaterThan(0);
        expect(line.amount).toBeLessThanOrEqual(limit);
      } else if (line.kind === "custom") {
        expect([line.quantity, line.amount]).toEqual([1000, line.unitPrice]);
      } else {
        expect(line.expenseKeys).toHaveLength(1);
        const x = expenses.get(line.expenseKeys[0]!)!;
        expect([line.quantity, line.unitPrice, line.amount]).toEqual([1000, x.amount, x.amount]);
        expect(x.billable).toBe(true);
        expect(projects.get(x.projectKey)!.clientKey).toBe(invoice.clientKey);
        expect(x.date >= invoice.periodFrom && x.date <= invoice.periodTo).toBe(true);
      }
      for (const k of [...line.entryKeys, ...line.expenseKeys]) {
        expect(seen.has(k)).toBe(false); // never billed twice
        seen.add(k);
      }
    }
  }
  // Every billable hour of an invoiced month is on an invoice, except a fixed fee project's, whose fee is billed instead.
  const lastInvoiced = data.invoices.filter((i) => i.lines.some((l) => l.kind === "time")).reduce((m, i) => (i.periodTo > m ? i.periodTo : m), "");
  for (const e of data.entries) {
    const project = projects.get(e.projectKey)!;
    if (e.billable && project.clientKey && project.fixedFee === null && e.date <= lastInvoiced) expect(seen.has(e.key)).toBe(true);
  }
}

describe("a demo workspace", () => {
  beforeAll(() => {
    process.env.DEMO_MODE = "true";
  });
  afterAll(() => {
    delete process.env.DEMO_MODE;
  });
  beforeEach(async () => {
    await resetDatabase();
    demoStartsPerIp.reset();
  });

  it("matches the dataset, and its invoices and reports add up", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const started = performance.now();
    const res = await request("/api/demo/start", { body: { today }, ip: "198.51.100.77" });
    const startMs = performance.now() - started;
    expect(res.status).toBe(201);
    console.log(`POST /api/demo/start took ${Math.round(startMs)} ms (${DEMO_MONTHS} months)`);
    const cookie = cookieFrom(res);
    const data = generateDataset({ today, months: DEMO_MONTHS });
    const organizationId = (await (await request("/api/me", { cookie })).json()).organization.id;

    expect(await prisma.user.count({ where: { organizationId } })).toBe(data.people.length);
    // The demo has a logo, a square PNG that passes the same checks as an uploaded one.
    const logo = await prisma.logo.findUniqueOrThrow({ where: { organizationId } });
    expect(checkLogo(new Uint8Array(logo.data))).toEqual({ contentType: "image/png", width: 256, height: 256 });
    expect(await prisma.client.count({ where: { organizationId } })).toBe(data.clients.length);
    expect(await prisma.project.count({ where: { organizationId } })).toBe(data.projects.length);
    expect(await prisma.task.count({ where: { organizationId } })).toBe(data.tasks.length);
    expect(await prisma.timeEntry.count({ where: { organizationId } })).toBe(data.entries.length);
    expect(await prisma.timeEntry.count({ where: { organizationId, startedAt: { not: null } } })).toBe(0);
    expect(await prisma.expense.count({ where: { organizationId } })).toBe(data.expenses.length);
    expect(await prisma.invoice.count({ where: { organizationId } })).toBe(data.invoices.length);
    // The newer features (WRK-145) are in it too.
    expect(await prisma.client.count({ where: { organizationId, currency: "EUR" } })).toBe(1);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).exchangeRates).toEqual({ EUR: 1_080_000 });
    expect(await prisma.project.count({ where: { organizationId, feeByPhase: true } })).toBe(1);
    expect(await prisma.invoiceLine.count({ where: { organizationId, kind: "fee", taskId: { not: null } } })).toBe(1);
    expect(await prisma.invoiceSchedule.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.timeOff.count({ where: { organizationId } })).toBe(data.timeOff.length);
    expect(await prisma.holiday.count({ where: { organizationId } })).toBe(data.holidays.length);
    expect(await prisma.scheduledWork.count({ where: { organizationId } })).toBe(data.schedule.length);
    expect(await prisma.customFieldValue.count({ where: { organizationId } })).toBe(data.fieldValues.length);
    expect(await prisma.userGroupMember.count({ where: { organizationId } })).toBe(data.groups.reduce((n, g) => n + g.memberKeys.length, 0));
    expect(await prisma.projectTemplate.count({ where: { organizationId } })).toBe(1);
    const you = await prisma.user.findFirstOrThrow({ where: { organizationId, name: "You" } });
    expect(you).toMatchObject({ role: "admin", hourlyRate: data.people[0]!.hourlyRate });
    expect(await prisma.timeEntry.count({ where: { organizationId, userId: you.id } })).toBe(data.entries.filter((e) => e.personKey === "p0").length);

    // Every invoice, through the API: lines match the entries and expenses stored on them.
    const { invoices } = await (await request("/api/invoices", { cookie })).json();
    expect(invoices).toHaveLength(data.invoices.length);
    for (const summary of invoices) {
      const { invoice } = await (await request(`/api/invoices/${summary.id}`, { cookie })).json();
      expect(invoice.subtotal).toBe(invoice.lines.reduce((s: number, l: { amount: number }) => s + l.amount, 0));
      expect(invoice.total).toBe(invoice.subtotal);
      for (const line of invoice.lines) {
        if (line.kind === "fee" || line.kind === "custom") continue; // checked on the dataset above
        if (line.kind === "time") {
          const rows = await prisma.timeEntry.findMany({ where: { invoiceLineId: line.id }, select: { seconds: true, billable: true, project: { select: { clientId: true } } } });
          const seconds = rows.reduce((s, r) => s + r.seconds, 0);
          expect(line.amount).toBe(Math.round(valueOf(seconds, line.unitPrice)));
          expect(rows.every((r) => r.billable && r.project.clientId === invoice.client.id)).toBe(true);
        } else {
          const rows = await prisma.expense.findMany({ where: { invoiceLineId: line.id }, select: { amount: true, project: { select: { clientId: true } } } });
          expect(rows).toHaveLength(1);
          expect([line.quantity, line.unitPrice, line.amount]).toEqual([1000, rows[0]!.amount, rows[0]!.amount]);
          expect(rows[0]!.project.clientId).toBe(invoice.client.id);
        }
      }
    }

    // "Ready to bill" has this month's work in it, and nothing older.
    const { clients: ready } = await (await request("/api/invoices/unbilled", { cookie })).json();
    expect(ready.length).toBeGreaterThan(0);
    const oldUnbilled = await prisma.timeEntry.count({
      where: { organizationId, billable: true, invoiceLineId: null, project: { clientId: { not: null } }, date: { lt: new Date(`${today.slice(0, 7)}-01T00:00:00Z`) } },
    });
    expect(oldUnbilled).toBe(0);

    // Reports for the last twelve months equal the sums over the raw rows.
    const from = addDays(today, -365);
    const query = `from=${from}&to=${today}`;
    const rows = await prisma.timeEntry.findMany({
      where: { organizationId, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${today}T00:00:00Z`) } },
      select: { seconds: true, billable: true, user: { select: { hourlyRate: true } }, project: { select: { billBy: true, hourlyRate: true, fixedFee: true, client: { select: { currency: true } } } } },
    });
    // A client billed in euros counts at the workspace's exchange rate, as Reports do.
    const home = toHome({ home: "USD", rates: { EUR: 1_080_000 } });
    const money = rows.filter((r) => r.billable).reduce((s, r) => s + home(valueOf(r.seconds, rateFor(r.project, r.user)), r.project.client?.currency ?? "USD"), 0);
    for (const groupBy of ["client", "project", "person"]) {
      const report = await (await request(`/api/reports/summary?${query}&groupBy=${groupBy}`, { cookie })).json();
      expect(report.totals.seconds).toBe(rows.reduce((s, r) => s + r.seconds, 0));
      expect(report.totals.billableSeconds).toBe(rows.filter((r) => r.billable).reduce((s, r) => s + r.seconds, 0));
      expect(report.totals.billableAmount).toBe(Math.round(money));
      expect(report.rows.reduce((s: number, r: { seconds: number }) => s + r.seconds, 0)).toBe(report.totals.seconds);
    }
    const spent = await prisma.expense.findMany({ where: { organizationId, date: { gte: new Date(`${from}T00:00:00Z`) } }, select: { amount: true, project: { select: { client: { select: { currency: true } } } } } });
    const report = await (await request(`/api/reports/summary?${query}`, { cookie })).json();
    expect(report.expenses.amount).toBe(Math.round(spent.reduce((sum, x) => sum + home(x.amount, x.project.client?.currency ?? "USD"), 0)));
  });
});
