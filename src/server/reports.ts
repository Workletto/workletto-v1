import { Hono, type Context } from "hono";
import { readRange, requireManager, type SignedIn } from "./http.ts";
import { rateFor, valueOf } from "./billing.ts";
import { budgetUse, projectTotals } from "./budget.ts";
import { addDays, asDate, dayOf, daysBetween, startOfWeek } from "../shared/time.ts";
import { currencies, currencyOf, toHome } from "./currency.ts";
import { invoiceTotals } from "../shared/invoiceMath.ts";
import type { OrgDb } from "./db.ts";
import { canManageOrganization, canManageWork } from "../shared/roles.ts";
import { customValues, FIELD_SELECT, type FieldKind } from "./customFields.ts";

// Reports add up time and expenses for a period, grouped by client, project,
// person or task. Admins and managers see everyone's, with money; members see
// only their own hours and expenses. Money from clients billed in other
// currencies is converted to the home currency at the exchange rates (currency.ts).

const MAX_RANGE_DAYS = 3700;
const GROUPS = ["client", "project", "person", "task"] as const;
type Group = (typeof GROUPS)[number];

type Filters = { from: string; to: string; where: Record<string, unknown>; expenseWhere: Record<string, unknown>; full: boolean };

/** Reads the period and filters shared by every report, or returns an error response. */
function readFilters(c: Context<SignedIn>): Filters | Response {
  const range = readRange(c, MAX_RANGE_DAYS, "Choose a start and end date, up to ten years apart.");
  if (range instanceof Response) return range;
  const { from, to } = range;
  const user = c.get("user");
  const full = canManageWork(user.role);
  const where: Record<string, unknown> = { date: { gte: asDate(from), lte: asDate(to) } };
  const project: Record<string, unknown> = {};
  const clientId = c.req.query("clientId");
  const projectId = c.req.query("projectId");
  const userId = full ? c.req.query("userId") : user.id; // members only ever see their own
  if (clientId) project.clientId = clientId === "none" ? null : clientId;
  if (projectId) where.projectId = projectId;
  if (userId) where.userId = userId;
  if (Object.keys(project).length) where.project = project;
  // A user group (WRK-149): its members' time and expenses.
  const groupId = full ? c.req.query("groupId") : undefined;
  if (groupId) where.user = { groups: { some: { groupId } } };
  const expenseWhere = { ...where };
  const billable = c.req.query("billable");
  if (billable === "true" || billable === "false") {
    where.billable = billable === "true";
    expenseWhere.billable = billable === "true";
  }
  return { from, to, where, expenseWhere, full };
}

/** The chart's buckets: days for up to six weeks, weeks for up to about seven months, months beyond. */
export function seriesStep(from: string, to: string): "day" | "week" | "month" {
  const days = daysBetween(from, to) + 1;
  return days <= 42 ? "day" : days <= 210 ? "week" : "month";
}
const bucketOf = (date: string, step: "day" | "week" | "month") => (step === "day" ? date : step === "week" ? startOfWeek(date) : `${date.slice(0, 7)}-01`);

/** Every bucket from `from` to `to`, empty ones included, so the chart has no gaps. */
function emptySeries(from: string, to: string, step: "day" | "week" | "month") {
  const out = new Map<string, { start: string; seconds: number; billableSeconds: number }>();
  for (let d = bucketOf(from, step); d <= to; ) {
    out.set(d, { start: d, seconds: 0, billableSeconds: 0 });
    if (step === "day") d = addDays(d, 1);
    else if (step === "week") d = addDays(d, 7);
    else {
      const [y, m] = d.split("-").map(Number) as [number, number];
      d = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    }
  }
  return out;
}

/** Every entry in the period, with what's needed to group and value it. */
async function loadEntries(c: Context<SignedIn>, where: Record<string, unknown>) {
  return c.get("db").timeEntry.findMany({
    where,
    select: {
      id: true,
      date: true,
      seconds: true,
      startedAt: true,
      notes: true,
      billable: true,
      invoiceLineId: true,
      user: { select: { id: true, name: true, hourlyRate: true, costRate: true, groups: { select: { group: { select: { name: true } } } } } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true, billBy: true, hourlyRate: true, fixedFee: true, client: { select: { id: true, name: true, currency: true } } } },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * The fixed fee lines invoiced in the period (by the invoice's issue date), filtered like the
 * time: by client or project. A fee is nobody's time, so a filter by person or group, or by
 * non-billable work, leaves fees out.
 */
async function loadFees(c: Context<SignedIn>, where: Record<string, unknown>) {
  if ("userId" in where || "user" in where || where.billable === false) return [];
  return c.get("db").invoiceLine.findMany({
    where: {
      kind: "fee",
      invoice: { issueDate: where.date as object },
      ...(where.projectId ? { projectId: where.projectId as string } : {}),
      ...(where.project ? { project: where.project as object } : {}),
    },
    select: { amount: true, invoice: { select: { id: true, issueDate: true, currency: true } }, project: { select: { id: true, name: true, client: { select: { id: true, name: true } } } } },
  });
}

/**
 * What invoices billed for the time, expenses and fees in a report, so revenue that's on an invoice
 * is what the invoice says, after its discount, whatever the rates are now. A line's amount is
 * shared among the entries on it by their seconds (expenses by their amounts), and an invoice's
 * discount comes off each of its lines in proportion. Amounts are in the invoice's currency.
 */
async function invoiceBilled(db: OrgDb, lineIds: string[], feeInvoiceIds: string[]) {
  const lines = lineIds.length ? await db.invoiceLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, amount: true, invoiceId: true } }) : [];
  const invoiceIds = [...new Set([...lines.map((l) => l.invoiceId), ...feeInvoiceIds])];
  const [invoices, onLines, expensesOnLines] = await Promise.all([
    invoiceIds.length
      ? db.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, currency: true, discountBasisPoints: true, discountAmount: true, taxBasisPoints: true, lines: { select: { amount: true } } } })
      : [],
    lineIds.length ? db.timeEntry.findMany({ where: { invoiceLineId: { in: lineIds } }, select: { invoiceLineId: true, seconds: true } }) : [],
    lineIds.length ? db.expense.findMany({ where: { invoiceLineId: { in: lineIds } }, select: { invoiceLineId: true, amount: true } }) : [],
  ]);
  const net = new Map(invoices.map((i) => {
    const { subtotal, discount } = invoiceTotals(i.lines.map((l) => l.amount), i);
    return [i.id, { currency: i.currency, factor: subtotal > 0 ? (subtotal - discount) / subtotal : 1 }];
  }));
  const whole = new Map<string, number>();
  for (const x of onLines) whole.set(x.invoiceLineId!, (whole.get(x.invoiceLineId!) ?? 0) + x.seconds);
  for (const x of expensesOnLines) whole.set(x.invoiceLineId!, (whole.get(x.invoiceLineId!) ?? 0) + x.amount);
  const byLine = new Map(lines.map((l) => [l.id, l]));
  return {
    /** The part of a line's amount for one entry (its seconds) or expense (its amount), after the discount. */
    share(lineId: string, part: number): { amount: number; currency: string } | null {
      const line = byLine.get(lineId);
      const invoice = line && net.get(line.invoiceId);
      if (!line || !invoice) return null;
      const total = whole.get(lineId) ?? 0;
      return { amount: (total > 0 ? (line.amount * part) / total : 0) * invoice.factor, currency: invoice.currency };
    },
    /** A fee line's amount after its invoice's discount. */
    fee(invoiceId: string, amount: number) {
      return amount * (net.get(invoiceId)?.factor ?? 1);
    },
  };
}

type Entry = Awaited<ReturnType<typeof loadEntries>>[number];
const secondsOf = (e: Entry, now: number) => e.seconds + (e.startedAt ? Math.max(0, Math.floor((now - e.startedAt.getTime()) / 1000)) : 0);

type ListField = { id: string; name: string; appliesTo: FieldKind; choices: string[] };

/**
 * A list custom field (WRK-148) a report can filter or group by: one in use, and for members only
 * fields on their own time entries (project and client fields belong with the money settings).
 */
async function listField(c: Context<SignedIn>, id: string | undefined): Promise<ListField | null> {
  if (!id) return null;
  const field = await c.get("db").customField.findFirst({ where: { id, type: "choice", archivedAt: null }, select: FIELD_SELECT });
  if (!field || (field.appliesTo !== "time" && !canManageWork(c.get("user").role))) return null;
  return field as ListField;
}

/** Narrows the filters to records with one value of a list field ("" for none). Expenses follow their project. */
function filterByField(filters: Filters, field: ListField, value: string) {
  const match = value === "" ? { none: { fieldId: field.id } } : { some: { fieldId: field.id, value } };
  const where = { ...filters.where };
  let expenseWhere: Record<string, unknown> = { ...filters.expenseWhere };
  const project = { ...((where.project as Record<string, unknown>) ?? {}) };
  if (field.appliesTo === "time") {
    where.customValues = match;
    // Expenses have no time-entry fields, so none match.
    expenseWhere = { id: { in: [] } };
  } else {
    if (field.appliesTo === "project") project.customValues = match;
    else project.client = { customValues: match };
    where.project = project;
    expenseWhere.project = project;
  }
  return { ...filters, where, expenseWhere };
}

/** Each entry's value of a list field, by entry id; null when it has none. */
async function fieldValuesOf(c: Context<SignedIn>, field: ListField, entries: Entry[]) {
  const db = c.get("db");
  const recordOf = (e: Entry) => (field.appliesTo === "time" ? e.id : field.appliesTo === "project" ? e.project.id : e.project.client?.id ?? null);
  const ids = [...new Set(entries.map(recordOf).filter((id): id is string => !!id))];
  const values = await customValues(db, field.appliesTo, ids);
  return new Map(entries.map((e) => {
    const record = recordOf(e);
    return [e.id, (record && values.get(record)?.[field.id]) ?? null];
  }));
}

function keyOf(e: Entry, group: Group): { id: string; label: string; detail: string | null } {
  switch (group) {
    case "client":
      return { id: e.project.client?.id ?? "none", label: e.project.client?.name ?? "No client", detail: null };
    case "project":
      return { id: e.project.id, label: e.project.name, detail: e.project.client?.name ?? null };
    case "person":
      return { id: e.user.id, label: e.user.name, detail: null };
    case "task":
      return e.task
        ? { id: e.task.id, label: e.task.title, detail: e.project.name }
        : { id: `none:${e.project.id}`, label: "No task", detail: e.project.name };
  }
}

type Money = { revenue: number; invoiced: number; timeCost: number; expenseCost: number };
const noMoney = (): Money => ({ revenue: 0, invoiced: 0, timeCost: 0, expenseCost: 0 });
/** Whole cents, with what's left of the revenue after costs. */
function money(m: Money) {
  const revenue = Math.round(m.revenue);
  const invoiced = Math.round(m.invoiced);
  const timeCost = Math.round(m.timeCost);
  const expenseCost = Math.round(m.expenseCost);
  return { revenue, invoiced, uninvoiced: revenue - invoiced, timeCost, expenseCost, cost: timeCost + expenseCost, profit: revenue - timeCost - expenseCost };
}

export const reportRoutes = new Hono<SignedIn>()
  .get("/summary", async (c) => {
    let filters = readFilters(c);
    if (filters instanceof Response) return filters;
    // Group by a list custom field with ?groupBy=field:<id>; filter by one with ?fieldId=&fieldValue=.
    const groupField = await listField(c, /^field:(.+)$/.exec(c.req.query("groupBy") ?? "")?.[1]);
    const filterField = await listField(c, c.req.query("fieldId"));
    if (filterField) filters = filterByField(filters, filterField, c.req.query("fieldValue") ?? "");
    const group = (GROUPS as readonly string[]).includes(c.req.query("groupBy") ?? "") ? (c.req.query("groupBy") as Group) : "project";

    const [entries, expenses, rates] = await Promise.all([
      loadEntries(c, filters.where),
      c.get("db").expense.findMany({ where: filters.expenseWhere, select: { amount: true, billable: true, project: { select: { client: { select: { currency: true } } } } } }),
      currencies(c.get("db")),
    ]);
    const home = toHome(rates);
    // Whether any of it was in another currency, for the note under the totals.
    let converted = false;
    const inHome = (amount: number, project: { client: { currency: string } | null }) => {
      const currency = currencyOf(project, rates.home);
      if (currency !== rates.home && amount) converted = true;
      return home(amount, currency);
    };
    const now = Date.now();
    const rows = new Map<string, { id: string; label: string; detail: string | null; seconds: number; billableSeconds: number; billableAmount: number }>();
    const totals = { seconds: 0, billableSeconds: 0, billableAmount: 0 };
    // Hours over time for the chart, split into billable and not.
    const step = seriesStep(filters.from, filters.to);
    const series = emptySeries(filters.from, filters.to, step);
    const fieldValues = groupField ? await fieldValuesOf(c, groupField, entries) : null;
    for (const e of entries) {
      const value = fieldValues?.get(e.id);
      const key = groupField ? { id: value ? `value:${value}` : "none", label: value ?? `No ${groupField.name}`, detail: null } : keyOf(e, group);
      const row = rows.get(key.id) ?? { ...key, seconds: 0, billableSeconds: 0, billableAmount: 0 };
      const seconds = secondsOf(e, now);
      const bucket = series.get(bucketOf(dayOf(e.date), step));
      if (bucket) {
        bucket.seconds += seconds;
        if (e.billable) bucket.billableSeconds += seconds;
      }
      const amount = e.billable ? inHome(valueOf(seconds, rateFor(e.project, e.user)), e.project) : 0;
      row.seconds += seconds;
      totals.seconds += seconds;
      if (e.billable) {
        row.billableSeconds += seconds;
        totals.billableSeconds += seconds;
        row.billableAmount += amount;
        totals.billableAmount += amount;
      }
      rows.set(key.id, row);
    }
    const expenseTotals = {
      amount: Math.round(expenses.reduce((sum, x) => sum + inHome(x.amount, x.project), 0)),
      billableAmount: Math.round(expenses.filter((x) => x.billable).reduce((sum, x) => sum + inHome(x.amount, x.project), 0)),
    };
    const list = [...rows.values()].sort((a, b) => b.seconds - a.seconds);
    const money = <T extends { billableAmount: number }>(r: T) =>
      filters.full ? { ...r, billableAmount: Math.round(r.billableAmount) } : (({ billableAmount: _, ...rest }) => rest)(r);
    return c.json({
      groupBy: groupField ? `field:${groupField.id}` : group, totals: money(totals), rows: list.map(money), expenses: expenseTotals, series: { step, buckets: [...series.values()] },
      // Money is in the home currency; `converted` says some of it came from another currency.
      currency: rates.home, ...(filters.full ? { converted } : {}),
    });
  })
  // Revenue, cost and profit for the period. Revenue is billable time at its billable rate plus
  // billable expenses, plus fixed fees invoiced in the period (a fixed fee project's time has no
  // hourly value); cost is all time at each person's cost rate plus every expense. Rates are
  // today's, as in the other reports. The split by person is for admins only: it shows what
  // each person costs.
  .get("/profitability", requireManager("see profitability"), async (c) => {
    const filters = readFilters(c);
    if (filters instanceof Response) return filters;
    const byPerson = canManageOrganization(c.get("user").role);
    const [entries, fees, rates, expenses] = await Promise.all([
      loadEntries(c, filters.where),
      loadFees(c, filters.where),
      currencies(c.get("db")),
      c.get("db").expense.findMany({
        where: filters.expenseWhere,
        select: {
          date: true, amount: true, billable: true, invoiceLineId: true,
          user: { select: { id: true, name: true } },
          project: { select: { id: true, name: true, client: { select: { id: true, name: true, currency: true } } } },
        },
      }),
    ]);
    type Row = Money & { id: string; label: string; detail: string | null };
    const groups = { client: new Map<string, Row>(), project: new Map<string, Row>(), person: new Map<string, Row>() };
    const total = noMoney();
    const step = seriesStep(filters.from, filters.to);
    const series = new Map([...emptySeries(filters.from, filters.to, step).keys()].map((start) => [start, { start, ...noMoney() }]));
    const missing = new Map<string, string>();
    const add = (keys: Record<keyof typeof groups, { id: string; label: string; detail: string | null }>, date: Date, m: Money) => {
      const targets: Money[] = [total];
      for (const group of ["client", "project", "person"] as const) {
        const key = keys[group];
        const row = groups[group].get(key.id) ?? groups[group].set(key.id, { ...key, ...noMoney() }).get(key.id)!;
        targets.push(row);
      }
      const bucket = series.get(bucketOf(dayOf(date), step));
      if (bucket) targets.push(bucket);
      for (const t of targets) {
        t.revenue += m.revenue;
        t.invoiced += m.invoiced;
        t.timeCost += m.timeCost;
        t.expenseCost += m.expenseCost;
      }
    };
    // Revenue and expenses in another currency count at the exchange rate; time costs are in the home currency.
    const home = toHome(rates);
    let converted = false;
    const inHome = (amount: number, currency: string) => {
      if (currency !== rates.home && amount) converted = true;
      return home(amount, currency);
    };
    const now = Date.now();
    const billed = await invoiceBilled(
      c.get("db"),
      [...new Set([...entries, ...expenses].flatMap((x) => (x.invoiceLineId ? [x.invoiceLineId] : [])))],
      [...new Set(fees.map((f) => f.invoice.id))],
    );
    for (const e of entries) {
      const seconds = secondsOf(e, now);
      // On an invoice: what the invoice billed for it. Not yet: its value at today's rate.
      const onInvoice = e.billable && e.invoiceLineId ? billed.share(e.invoiceLineId, e.seconds) : null;
      const revenue = onInvoice ? inHome(onInvoice.amount, onInvoice.currency) : e.billable ? inHome(valueOf(seconds, rateFor(e.project, e.user)), currencyOf(e.project, rates.home)) : 0;
      if (e.user.costRate === null && seconds > 0) missing.set(e.user.id, e.user.name);
      const keys = { client: keyOf(e, "client"), project: keyOf(e, "project"), person: keyOf(e, "person") };
      add(keys, e.date, { revenue, invoiced: onInvoice ? revenue : 0, timeCost: valueOf(seconds, e.user.costRate), expenseCost: 0 });
    }
    for (const x of expenses) {
      const amount = inHome(x.amount, currencyOf(x.project, rates.home));
      const onInvoice = x.billable && x.invoiceLineId ? billed.share(x.invoiceLineId, x.amount) : null;
      const revenue = onInvoice ? inHome(onInvoice.amount, onInvoice.currency) : x.billable ? amount : 0;
      const keys = {
        client: { id: x.project.client?.id ?? "none", label: x.project.client?.name ?? "No client", detail: null },
        project: { id: x.project.id, label: x.project.name, detail: x.project.client?.name ?? null },
        person: { id: x.user.id, label: x.user.name, detail: null },
      };
      add(keys, x.date, { revenue, invoiced: onInvoice ? revenue : 0, timeCost: 0, expenseCost: amount });
    }
    for (const f of fees) {
      const project = f.project!;
      const keys = {
        client: { id: project.client?.id ?? "none", label: project.client?.name ?? "No client", detail: null },
        project: { id: project.id, label: project.name, detail: project.client?.name ?? null },
        person: { id: "fixed-fees", label: "Fixed fees", detail: null },
      };
      const revenue = inHome(billed.fee(f.invoice.id, f.amount), f.invoice.currency);
      add(keys, f.invoice.issueDate, { revenue, invoiced: revenue, timeCost: 0, expenseCost: 0 });
    }
    const list = (rows: Map<string, Row>) =>
      [...rows.values()].map(({ id, label, detail, ...m }) => ({ id, label, detail, ...money(m) })).sort((a, b) => b.revenue - a.revenue || b.cost - a.cost);
    return c.json({
      totals: money(total),
      clients: list(groups.client),
      projects: list(groups.project),
      ...(byPerson ? { people: list(groups.person) } : {}),
      // People whose time counts as costing nothing, because they have no cost rate.
      missingCostRates: [...missing].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      series: { step, buckets: [...series.values()].map(({ start, ...m }) => ({ start, ...money(m) })) },
      // Everything is in the home currency; `converted` says some of it came from another currency.
      currency: rates.home,
      converted,
    });
  })
  // Each entry on its own line, for a spreadsheet.
  .get("/entries", async (c) => {
    let filters = readFilters(c);
    if (filters instanceof Response) return filters;
    const filterField = await listField(c, c.req.query("fieldId"));
    if (filterField) filters = filterByField(filters, filterField, c.req.query("fieldValue") ?? "");
    const [entries, { home }, fields] = await Promise.all([
      loadEntries(c, filters.where),
      currencies(c.get("db")),
      c.get("db").customField.findMany({ where: { appliesTo: "time", archivedAt: null }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
    ]);
    // The time-entry custom fields (WRK-148), as columns after the others.
    const values = await customValues(c.get("db"), "time", entries.map((e) => e.id));
    const now = Date.now();
    return c.json({
      fields,
      entries: entries.map((e) => {
        const seconds = secondsOf(e, now);
        const rate = rateFor(e.project, e.user);
        return {
          date: dayOf(e.date),
          person: e.user.name,
          client: e.project.client?.name ?? "",
          project: e.project.name,
          task: e.task?.title ?? "",
          notes: e.notes,
          seconds,
          billable: e.billable,
          customFields: values.get(e.id) ?? {},
          // In the project's own currency, as it would be invoiced: a spreadsheet gets the real amounts.
          ...(filters.full ? { rate, amount: e.billable ? Math.round(valueOf(seconds, rate)) : 0, currency: currencyOf(e.project, home) } : {}),
          // The person's user groups (WRK-149), for admins and managers.
          ...(filters.full ? { groups: e.user.groups.map((g) => g.group.name).sort().join(", ") } : {}),
        };
      }),
    });
  })
  // Every active project with a budget, and how much of it is used (all time).
  .get("/budgets", async (c) => {
    if (!canManageWork(c.get("user").role)) return c.json({ error: "Only admins and managers can see budgets." }, 403);
    const db = c.get("db");
    const projects = await db.project.findMany({
      where: { archived: false, budgetBy: { not: "none" } },
      select: { id: true, name: true, billBy: true, hourlyRate: true, fixedFee: true, budgetBy: true, budgetSeconds: true, budgetAmount: true, client: { select: { name: true, currency: true } } },
      orderBy: { name: "asc" },
    });
    // Counted like the project page: running timers up to now.
    const [totalsOf, { home }] = await Promise.all([projectTotals(db, projects, { running: true }), currencies(db)]);
    return c.json({
      budgets: projects.map((p) => {
        const totals = totalsOf.get(p.id)!;
        const use = budgetUse(p, totals);
        const hours = p.budgetBy === "hours";
        return {
          id: p.id,
          name: p.name,
          client: p.client?.name ?? null,
          budgetBy: p.budgetBy,
          // A money budget is in the project's currency.
          currency: currencyOf(p, home),
          budget: use?.max ?? (hours ? p.budgetSeconds : p.budgetAmount) ?? 0,
          used: use?.used ?? (hours ? totals.seconds : totals.billableAmount),
        };
      }),
    });
  });
