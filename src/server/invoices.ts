import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isDemoMode } from "./env.ts";
import { isUniqueViolation, requireManager, readBody, type SignedIn } from "./http.ts";
import { GROUPINGS, hoursQuantity, timeLineAmount, timeLines, type Grouping } from "./billing.ts";
import { escapeHtml, isEmailConfigured, sendMail, type Mail } from "./mail.ts";
import { nextInvoiceNumber, NumberTaken, readPercent, readTaxLabel, takeInvoiceNumber } from "./invoiceSettings.ts";
import { formatMoney, formatQuantity, isCents, MAX_CENTS } from "../shared/money.ts";
import { addDays, asDate, dayOrNull, isIsoDate, longDay } from "../shared/time.ts";
import { diff, recordAudit, snapshot, type Actor } from "./audit.ts";
import { closeInvoiceCheckouts, endCheckoutsFirst, payLinkFor } from "./payments.ts";
import { isEmail } from "../shared/email.ts";
import { HEX_COLOR } from "../shared/color.ts";
import { displayAppName } from "../shared/product.ts";
import { feeLineDescription, invoiceTotals, lineAmount } from "../shared/invoiceMath.ts";
import { feesLeft, holdFee } from "./fees.ts";
import { QUICKBOOKS_HEADERS, quickbooksCsvRows, XERO_HEADERS, xeroCsvRows } from "./accountingExport.ts";
import { toCsv } from "../shared/csv.ts";
import { makeDueInvoices, nextDate, orgToday, REPEAT_EVERY, SCHEDULE_SELECT, toSchedule, type RepeatEvery } from "./recurring.ts";

// Invoices for a client, made from their billable time and expenses that
// aren't on an invoice yet, and parts of their fixed fee projects' fees (fees.ts).
// Lines keep their own amounts, and every entry and expense on an invoice is
// marked with its line so it's never billed twice.
// New invoices are numbered, and start with the tax, terms and notes, from the
// invoice settings (invoiceSettings.ts). Admins and managers only.


type Period = { from?: string; to?: string };

class Conflict extends Error {}
class NotDraft extends Error {}
class TooLarge extends Error {}
class FeeProblem extends Error {}
const DEMO_EMAIL_REFUSAL = "Email isn't available in the demo. In your own copy, an admin turns it on under Manage → Email, and this sends the invoice straight to your client.";
const NOT_DRAFT = "Move this invoice back to draft to change it.";
const TOO_LARGE = `That's more than one invoice line can hold (${formatMoney(MAX_CENTS, "USD").replace("$", "")}). Split it over more lines or invoices.`;

function periodWhere({ from, to }: Period) {
  if (!from && !to) return {};
  return { date: { ...(from ? { gte: asDate(from) } : {}), ...(to ? { lte: asDate(to) } : {}) } };
}

/**
 * Billable time and expenses for a client (or every client) that aren't on an invoice yet. Running
 * timers wait. Time on fixed fee projects never is: their fee is billed instead.
 */
async function unbilled(db: OrgDb, clientId: string | null, period: Period) {
  const project = clientId ? { clientId } : { clientId: { not: null } };
  const [entries, expenses] = await Promise.all([
    db.timeEntry.findMany({
      where: { billable: true, invoiceLineId: null, startedAt: null, project: { ...project, fixedFee: null }, ...periodWhere(period) },
      select: {
        id: true,
        date: true,
        seconds: true,
        notes: true,
        user: { select: { id: true, name: true, hourlyRate: true } },
        task: { select: { id: true, title: true } },
        project: { select: { id: true, name: true, billBy: true, hourlyRate: true, fixedFee: true, clientId: true } },
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    db.expense.findMany({
      where: { billable: true, invoiceLineId: null, project, ...periodWhere(period) },
      select: { id: true, date: true, category: true, notes: true, amount: true, project: { select: { name: true, clientId: true } } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  return { entries, expenses };
}

/** The lines a new invoice gets, in order, with the time or expense each one bills. */
function planLines({ entries, expenses }: Awaited<ReturnType<typeof unbilled>>, grouping: Grouping, includeExpenses: boolean) {
  const time = timeLines(entries, grouping).map((line) => ({
    kind: "time" as const,
    description: line.description,
    quantity: hoursQuantity(line.seconds),
    unitPrice: line.unitPrice,
    amount: timeLineAmount(line.seconds, line.unitPrice),
    entryIds: line.entryIds,
    expenseId: null,
  }));
  const spent = includeExpenses
    ? expenses.map((x) => ({
        kind: "expense" as const,
        description: `${x.category}${x.notes ? ` – ${x.notes}` : ""} (${x.project.name}, ${dayOrNull(x.date)})`,
        quantity: 1000,
        unitPrice: x.amount,
        amount: x.amount,
        entryIds: [] as string[],
        expenseId: x.id,
      }))
    : [];
  return [...time, ...spent];
}

/**
 * The parts of fixed fees to bill on a new invoice: `fees` is a list of { projectId, taskId?, amount },
 * the amount in cents, with taskId naming the phase on a project billed per phase (WRK-151). Whether
 * each is this client's and within what's left is checked when it's made.
 */
function readFees(value: unknown) {
  if (value == null || value === "") return { fees: [] as { projectId: string; taskId: string | null; amount: number }[] };
  const fail = { error: "Enter each fixed fee to bill as an amount, like 1500 or 750.50." };
  if (!Array.isArray(value) || value.length > 100) return fail;
  const fees: { projectId: string; taskId: string | null; amount: number }[] = [];
  for (const item of value) {
    const { projectId, taskId, amount } = (item ?? {}) as Record<string, unknown>;
    if (typeof projectId !== "string" || !isCents(amount) || (amount as number) <= 0) return fail;
    if (taskId != null && typeof taskId !== "string") return fail;
    const phase = (taskId as string | undefined) ?? null;
    if (fees.some((f) => f.projectId === projectId && f.taskId === phase)) return { error: "Bill each fixed fee, or each phase, once per invoice." };
    fees.push({ projectId, taskId: phase, amount: amount as number });
  }
  return { fees };
}

/** Why a part of a fee can't be billed: more than what's left of it. */
const feeTooLarge = (name: string, left: number, currency: string) =>
  left > 0
    ? `That's more than what's left of the ${name} fee to bill (${formatMoney(left, currency)}).`
    : `The whole ${name} fee is already on invoices.`;

/** The period (from, to) and line grouping of a new invoice, or an error. */
function readMaking(body: Record<string, unknown>) {
  const from = body.from || undefined;
  const to = body.to || undefined;
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return { error: "Choose valid dates for the period." };
  const grouping = (GROUPINGS as readonly unknown[]).includes(body.groupBy) ? (body.groupBy as Grouping) : "project";
  return { period: { from: from as string | undefined, to: to as string | undefined }, grouping, includeExpenses: body.includeExpenses !== false && body.includeExpenses !== "false" };
}

/** A PO number (up to 50 characters) or subject (up to 200), trimmed. Missing is empty. */
function readText(value: unknown, max: number) {
  if (value == null) return "";
  return typeof value === "string" && value.trim().length <= max ? value.trim() : null;
}
const PO_ERROR = "Keep the PO number to 50 characters.";
const SUBJECT_ERROR = "Keep the subject to 200 characters.";

const LINE_SELECT = { id: true, position: true, kind: true, description: true, quantity: true, unitPrice: true, amount: true } as const;
export const INVOICE_SELECT = {
  id: true,
  number: true,
  status: true,
  issueDate: true,
  dueDate: true,
  periodFrom: true,
  periodTo: true,
  currency: true,
  taxBasisPoints: true,
  taxLabel: true,
  discountBasisPoints: true,
  discountAmount: true,
  notes: true,
  poNumber: true,
  subject: true,
  sentAt: true,
  paidAt: true,
  emailedAt: true,
  emailedTo: true,
  remindersSent: true,
  lastReminderAt: true,
  remindersOff: true,
  billToName: true,
  billToAddress: true,
  fromName: true,
  fromAddress: true,
  client: { select: { id: true, name: true, address: true, email: true } },
  lines: { select: LINE_SELECT, orderBy: { position: "asc" } },
  schedule: { select: SCHEDULE_SELECT },
} as const;

type InvoiceRow = {
  issueDate: Date; dueDate: Date; periodFrom: Date | null; periodTo: Date | null; sentAt: Date | null; paidAt: Date | null; emailedAt: Date | null; lastReminderAt: Date | null;
  taxBasisPoints: number; discountBasisPoints: number; discountAmount: number; lines: { amount: number }[];
  billToName: string | null; billToAddress: string | null; fromName: string | null; fromAddress: string | null;
  client: { name: string; address: string };
  schedule?: Parameters<typeof toSchedule>[0] | null;
};
// Subtotal, less the discount, plus tax on what's left.
export function toInvoice<T extends InvoiceRow>(row: T) {
  const totals = invoiceTotals(row.lines.map((l) => l.amount), row);
  const { billToName, billToAddress, fromName, fromAddress, schedule, ...rest } = row;
  return {
    ...rest,
    schedule: schedule ? toSchedule(schedule) : null,
    // A sent invoice names the client as it was when sent; a draft shows the client as it is now.
    client: billToName === null ? row.client : { ...row.client, name: billToName, address: billToAddress ?? "" },
    sentFrom: fromName === null ? null : { name: fromName, address: fromAddress ?? "" },
    issueDate: dayOrNull(row.issueDate)!,
    dueDate: dayOrNull(row.dueDate)!,
    periodFrom: dayOrNull(row.periodFrom),
    periodTo: dayOrNull(row.periodTo),
    sentAt: row.sentAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    emailedAt: row.emailedAt?.toISOString() ?? null,
    lastReminderAt: row.lastReminderAt?.toISOString() ?? null,
    ...totals,
  };
}

/** A discount from `discountPercent` ("10") or `discountAmount` (cents), at most one of them. Missing means none. */
function readDiscount(body: Record<string, unknown>) {
  const discountBasisPoints = readPercent(body.discountPercent);
  if (discountBasisPoints === null) return { error: "Enter the discount as a percentage from 0 to 100, like 10." };
  const discountAmount = body.discountAmount ?? 0;
  if (!isCents(discountAmount)) return { error: "Enter the discount as an amount, like 50 or 49.50." };
  if (discountBasisPoints && discountAmount) return { error: "Give the discount as a percentage or an amount, not both." };
  return { discountBasisPoints, discountAmount };
}

const TAX_ERROR = "Enter tax as a percentage from 0 to 100, like 8.25.";
const TAX_LABEL_ERROR = "Keep the tax name to 20 characters, like VAT or GST.";

function readLine(body: Record<string, unknown>, creating: boolean) {
  const data: { description?: string; quantity?: number; unitPrice?: number } = {};
  if (creating || "description" in body) {
    const d = typeof body.description === "string" ? body.description.trim() : "";
    if (!d || d.length > 500) return { error: "Describe the line (up to 500 characters)." };
    data.description = d;
  }
  if (creating || "quantity" in body) {
    const q = body.quantity;
    if (!Number.isInteger(q) || (q as number) < 0 || (q as number) > 100_000_000) return { error: "Enter a quantity like 1 or 2.5." };
    data.quantity = q as number;
  }
  if (creating || "unitPrice" in body) {
    const p = body.unitPrice;
    if (!Number.isInteger(p) || Math.abs(p as number) > MAX_CENTS) return { error: "Enter a price like 120 or 95.50." };
    data.unitPrice = p as number;
  }
  return { data };
}

// What the history records about an invoice. Lines are recorded as "description (amount)".
const AUDITED = ["status", "number", "poNumber", "subject", "issueDate", "dueDate", "taxBasisPoints", "taxLabel", "discountBasisPoints", "discountAmount", "notes", "emailedTo"] as const;
type Audited = {
  id: string; number: string; status: string; poNumber: string; subject: string; issueDate: Date; dueDate: Date; taxBasisPoints: number; taxLabel: string;
  discountBasisPoints: number; discountAmount: number; notes: string; emailedTo: string | null; currency: string; client: { name: string };
};
const audited = (row: Audited) => ({
  status: row.status, number: row.number, poNumber: row.poNumber, subject: row.subject, issueDate: row.issueDate, dueDate: row.dueDate,
  taxBasisPoints: row.taxBasisPoints, taxLabel: row.taxLabel, discountBasisPoints: row.discountBasisPoints, discountAmount: row.discountAmount,
  notes: row.notes, emailedTo: row.emailedTo,
});
const auditEvent = (row: Audited) => ({ kind: "invoice" as const, subjectId: row.id, label: `Invoice ${row.number} · ${row.client.name}`, currency: row.currency });
const EVERY_TEXT = { week: "Every week", month: "Every month", quarter: "Every 3 months" } as const;
/** A schedule in the History: "Every month, next on 2026-11-01, until 2027-06-30". */
const repeatText = (row: Parameters<typeof toSchedule>[0]) => {
  const s = toSchedule(row);
  return [EVERY_TEXT[s.every], s.nextDate ? `next on ${s.nextDate}` : "ended", s.endDate ? `until ${s.endDate}` : null].filter(Boolean).join(", ");
};
const lineText = (line: { description: string; amount: number }, currency: string) => `${line.description} (${formatMoney(line.amount, currency)})`;
const AUDIT_SELECT = {
  id: true, number: true, status: true, poNumber: true, subject: true, issueDate: true, dueDate: true, taxBasisPoints: true, taxLabel: true,
  discountBasisPoints: true, discountAmount: true, notes: true, emailedTo: true, currency: true, client: { select: { name: true } },
} as const;

/** Records a line added, changed or removed on a draft. */
async function recordLine(db: OrgDb, actor: Actor, invoiceId: string, from: { description: string; amount: number } | null, to: { description: string; amount: number } | null) {
  const invoice = await db.invoice.findFirstOrThrow({ where: { id: invoiceId }, select: AUDIT_SELECT });
  const text = (l: typeof from) => (l ? lineText(l, invoice.currency) : null);
  if (text(from) === text(to)) return;
  await recordAudit(db, actor, { ...auditEvent(invoice), action: "changed", changes: [{ field: "line", from: text(from), to: text(to) }] });
}

/** The invoice if it's a draft; otherwise a reason it can't change. */
async function draft(db: OrgDb, id: string) {
  const invoice = await db.invoice.findFirst({ where: { id }, select: { id: true, status: true } });
  if (!invoice) return { error: "Invoice not found.", status: 404 as const };
  if (invoice.status !== "draft") return { error: NOT_DRAFT, status: 409 as const };
  return { invoice };
}

/**
 * Inside a transaction: keeps the invoice a draft until the transaction ends (it locks the row,
 * so it can't be sent meanwhile), or throws NotDraft.
 */
async function holdDraft(tx: OrgDb, id: string) {
  const { count } = await tx.invoice.updateMany({ where: { id, status: "draft" }, data: { status: "draft" } });
  if (!count) throw new NotDraft();
}

/** The details a sent invoice keeps: the client's and the organization's, as they are now. */
async function detailsWhenSent(db: OrgDb, invoiceId: string) {
  const [invoice, org] = await Promise.all([
    db.invoice.findFirstOrThrow({ where: { id: invoiceId }, select: { client: { select: { name: true, address: true } } } }),
    db.organization.findFirstOrThrow({ select: { name: true, address: true } }),
  ]);
  return { billToName: invoice.client.name, billToAddress: invoice.client.address, fromName: org.name, fromAddress: org.address };
}
const DRAFT_DETAILS = { billToName: null, billToAddress: null, fromName: null, fromAddress: null };

/** For `.catch`: a transaction that found the invoice no longer a draft. */
const notDraft = (error: unknown) => {
  if (error instanceof NotDraft) return NOT_DRAFT;
  throw error;
};

/** Takes time and expenses off these lines, so they can be billed again. */
async function release(db: OrgDb, where: Record<string, unknown>) {
  await db.timeEntry.updateMany({ where: { invoiceLine: where }, data: { invoiceLineId: null } });
  await db.expense.updateMany({ where: { invoiceLine: where }, data: { invoiceLineId: null } });
}


type EmailedInvoice = {
  number: string; currency: string; notes: string; poNumber: string; subject: string; issueDate: string; dueDate: string; periodFrom: string | null; periodTo: string | null;
  taxBasisPoints: number; taxLabel: string; discountBasisPoints: number; subtotal: number; discount: number; tax: number; total: number; client: { name: string };
  lines: { description: string; quantity: number; unitPrice: number; amount: number }[];
};

const discountLabel = (invoice: { discountBasisPoints: number }) =>
  invoice.discountBasisPoints ? `Discount (${invoice.discountBasisPoints / 100}%)` : "Discount";

const EMAIL_FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/** The invoice as a simple table, in plain text and HTML, with the sender's own words on top. */
export function invoiceEmail(to: string, invoice: EmailedInvoice, organizationName: string, reminder: boolean, message: string, payLink: string | null = null, brand: { name: string; accentColor: string | null } = { name: organizationName, accentColor: null }): Mail {
  const money = (cents: number) => formatMoney(cents, invoice.currency);
  const period = invoice.periodFrom || invoice.periodTo
    ? `${invoice.periodFrom ? longDay(invoice.periodFrom) : "Up"} – ${invoice.periodTo ? longDay(invoice.periodTo) : "now"}`
    : null;
  const subject = reminder ? `Reminder: invoice ${invoice.number} from ${organizationName}` : `Invoice ${invoice.number} from ${organizationName}`;
  const totals: [string, string][] = [["Subtotal", money(invoice.subtotal)]];
  if (invoice.discount > 0) totals.push([discountLabel(invoice), money(-invoice.discount)]);
  if (invoice.taxBasisPoints > 0) totals.push([`${invoice.taxLabel} (${invoice.taxBasisPoints / 100}%)`, money(invoice.tax)]);
  totals.push(["Total", money(invoice.total)]);
  const facts: [string, string][] = [["Invoice", invoice.number], ["Issued", longDay(invoice.issueDate)], ["Due", longDay(invoice.dueDate)]];
  if (invoice.poNumber) facts.push(["PO number", invoice.poNumber]);
  if (period) facts.push(["For work", period]);
  if (invoice.subject) facts.push(["For", invoice.subject]);

  const text = [
    message,
    `${reminder ? "A reminder about invoice" : "Invoice"} ${invoice.number} for ${invoice.client.name}, from ${organizationName}.`,
    facts.map(([k, v]) => `${k}: ${v}`).join("\n"),
    invoice.lines.map((l) => `${l.description}\n  ${formatQuantity(l.quantity)} x ${money(l.unitPrice)} = ${money(l.amount)}`).join("\n"),
    totals.map(([k, v]) => `${k}: ${v}`).join("\n"),
    payLink ? `Pay online: ${payLink}` : "",
    invoice.notes,
  ].filter(Boolean).join("\n\n");

  const cell = "padding:6px 12px;border-bottom:1px solid #ddd;";
  const right = `${cell}text-align:right;white-space:nowrap;`;
  const rows = invoice.lines.map((l) =>
    `<tr><td style="${cell}">${escapeHtml(l.description)}</td><td style="${right}">${formatQuantity(l.quantity)}</td><td style="${right}">${money(l.unitPrice)}</td><td style="${right}">${money(l.amount)}</td></tr>`).join("");
  // One font for the whole message, set on the wrapper; a header with the display name and a thin rule in the accent color (no logo image).
  const accent = brand.accentColor && HEX_COLOR.test(brand.accentColor) ? brand.accentColor : "#111827";
  const html = [
    `<div style="font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#111827">`,
    `<div style="font-size:18px;font-weight:bold;padding-bottom:10px;margin-bottom:16px;border-bottom:2px solid ${accent}">${escapeHtml(brand.name)}</div>`,
    message ? `<p style="white-space:pre-line">${escapeHtml(message)}</p>` : "",
    `<p>${reminder ? "A reminder about invoice" : "Invoice"} ${escapeHtml(invoice.number)} for ${escapeHtml(invoice.client.name)}, from ${escapeHtml(organizationName)}.</p>`,
    `<p>${facts.map(([k, v]) => `${k}: <strong>${escapeHtml(v)}</strong>`).join("<br>")}</p>`,
    `<table style="border-collapse:collapse;font-family:${EMAIL_FONT};font-size:14px"><thead><tr><th style="${cell}text-align:left">Description</th><th style="${right}">Qty</th><th style="${right}">Rate</th><th style="${right}">Amount</th></tr></thead><tbody>${rows}</tbody>`
      + `<tfoot>${totals.map(([k, v], i) => `<tr><td colspan="3" style="${right}${i === totals.length - 1 ? "font-weight:bold;" : ""}">${escapeHtml(k)}</td><td style="${right}${i === totals.length - 1 ? "font-weight:bold;" : ""}">${v}</td></tr>`).join("")}</tfoot></table>`,
    payLink ? `<p><a href="${payLink}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#111827;color:#ffffff;text-decoration:none;font-weight:bold">Pay ${money(invoice.total)} online</a></p>` : "",
    invoice.notes ? `<p style="white-space:pre-line">${escapeHtml(invoice.notes)}</p>` : "",
    "</div>",
  ].join("");
  return { to, subject, text, html };
}

export const invoiceRoutes = new Hono<SignedIn>()
  .use(requireManager("work with invoices"))
  .get("/", async (c) => {
    const rows = await c.get("db").invoice.findMany({ select: INVOICE_SELECT, orderBy: [{ issueDate: "desc" }, { number: "desc" }] });
    return c.json({ invoices: rows.map(toInvoice) });
  })
  // What's ready to bill: per client, or for one client and period (?clientId=&from=&to=).
  .get("/unbilled", async (c) => {
    const db = c.get("db");
    const clientId = c.req.query("clientId") || null;
    const from = c.req.query("from");
    const to = c.req.query("to");
    const period = { from: isIsoDate(from) ? from : undefined, to: isIsoDate(to) ? to : undefined };
    const [{ entries, expenses }, clients, fees] = await Promise.all([
      unbilled(db, clientId, period),
      db.client.findMany({ select: { id: true, name: true, currency: true } }),
      feesLeft(db, clientId),
    ]);
    const totals = new Map<string, { seconds: number; amount: number; expenses: number; fees: number }>();
    const of = (id: string) => totals.get(id) ?? totals.set(id, { seconds: 0, amount: 0, expenses: 0, fees: 0 }).get(id)!;
    // The amount is what a new invoice with one line per project would charge.
    const byClient = new Map<string, typeof entries>();
    for (const e of entries) byClient.set(e.project.clientId!, [...(byClient.get(e.project.clientId!) ?? []), e]);
    for (const [id, theirs] of byClient) {
      const t = of(id);
      t.seconds = theirs.reduce((sum, e) => sum + e.seconds, 0);
      t.amount = timeLines(theirs, "project").reduce((sum, l) => sum + timeLineAmount(l.seconds, l.unitPrice), 0);
    }
    for (const x of expenses) of(x.project.clientId!).expenses += x.amount;
    // What's left to bill of fixed fees, whatever the period: a fee isn't tied to dates.
    for (const f of fees) if (f.left > 0) of(f.clientId!).fees += f.left;
    return c.json({
      clients: clients
        .filter((cl) => totals.has(cl.id))
        .map(({ currency, ...cl }) => ({ client: cl, currency, ...totals.get(cl.id)! }))
        .sort((a, b) => b.amount + b.expenses + b.fees - (a.amount + a.expenses + a.fees)),
    });
  })
  // What a new invoice for this client would hold, without making it (?clientId=&from=&to=&groupBy=&includeExpenses=):
  // its lines, the number it would get and who it's from. The screen adds discount and tax itself.
  .get("/preview", async (c) => {
    const db = c.get("db");
    const clientId = c.req.query("clientId");
    const client = clientId ? await db.client.findFirst({ where: { id: clientId }, select: { id: true, currency: true } }) : null;
    if (!client) return c.json({ error: "Choose a client." }, 400);
    const making = readMaking(c.req.query());
    if ("error" in making) return c.json(making, 400);
    const [found, org, number, fees] = await Promise.all([
      unbilled(db, client.id, making.period),
      db.organization.findFirstOrThrow({ select: { name: true, address: true, logo: { select: { updatedAt: true } } } }),
      nextInvoiceNumber(db),
      feesLeft(db, client.id),
    ]);
    const lines = planLines(found, making.grouping, making.includeExpenses).map(({ kind, description, quantity, unitPrice, amount }) => ({ kind, description, quantity, unitPrice, amount }));
    return c.json({
      number,
      // The client's currency: everything on the invoice is in it.
      currency: client.currency,
      lines,
      // The client's fixed fee projects with something left to bill. The screen adds a fee line
      // (feeLineDescription) for each amount chosen, ahead of these lines, as the invoice will.
      // A project billed per phase lists its phases with something left (WRK-151).
      fixedFees: fees.filter((f) => f.left > 0).map(({ projectId, name, fee, invoiced, left, phases }) => ({
        projectId, name, fee, invoiced, left, phases: phases?.filter((p) => p.left > 0) ?? null,
      })),
      // The unbilled hours behind the time lines, for "Includes 4:35 hours".
      seconds: found.entries.reduce((sum, e) => sum + e.seconds, 0),
      from: { name: org.name, address: org.address, logoVersion: org.logo?.updatedAt.getTime() ?? null },
    });
  })
  // Sent and paid invoices issued in a period, as a file QuickBooks Online or Xero imports
  // (accountingExport.ts): /export/quickbooks?from=&to= or /export/xero?from=&to=. Drafts stay out.
  .get("/export/:format", async (c) => {
    const format = c.req.param("format");
    if (format !== "quickbooks" && format !== "xero") return c.json({ error: "Choose QuickBooks or Xero." }, 404);
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) return c.json({ error: "Choose a start and end date for the invoices to export." }, 400);
    const rows = await c.get("db").invoice.findMany({
      where: { status: { in: ["sent", "paid"] }, issueDate: { gte: asDate(from), lte: asDate(to) } },
      select: {
        number: true, issueDate: true, dueDate: true, currency: true, poNumber: true, subject: true, taxBasisPoints: true, taxLabel: true,
        discountBasisPoints: true, discountAmount: true,
        client: { select: { name: true, email: true, address: true } },
        lines: { select: { description: true, quantity: true, unitPrice: true, amount: true }, orderBy: { position: "asc" } },
      },
      orderBy: [{ issueDate: "asc" }, { number: "asc" }],
    });
    const invoices = rows.map((r) => ({ ...r, issueDate: dayOrNull(r.issueDate)!, dueDate: dayOrNull(r.dueDate)! }));
    const [headers, cells] = format === "xero" ? [XERO_HEADERS, xeroCsvRows(invoices)] : [QUICKBOOKS_HEADERS, quickbooksCsvRows(invoices)];
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="invoices-${format}-${from}-to-${to}.csv"`);
    return c.body(toCsv([headers, ...cells]));
  })
  .get("/:id", async (c) => {
    const db = c.get("db");
    const row = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: INVOICE_SELECT });
    if (!row) return c.json({ error: "Invoice not found." }, 404);
    const org = await db.organization.findFirstOrThrow({ select: { name: true, address: true, invoiceReminderDays: true, logo: { select: { updatedAt: true } } } });
    const payments = await db.payment.findMany({
      where: { invoiceId: row.id, status: "paid" },
      select: { amountCents: true, currency: true, paidAt: true },
      orderBy: { paidAt: "desc" },
      take: 20,
    });
    return c.json({
      invoice: toInvoice(row),
      // The Pay now link to give the client, when online payments are connected.
      payLink: row.status === "draft" ? null : await payLinkFor(db, row.id),
      payments,
      // The demo shows the Email button as if email were on; sending is refused there.
      emailConfigured: isDemoMode() || (await isEmailConfigured(db)),
      // Late-payment reminders (reminders.ts): days after the due date, 0 = off for every invoice.
      reminderDays: org.invoiceReminderDays,
      // Who it's from: as it was when sent, or the organization as it is now on a draft.
      from: { name: row.fromName ?? org.name, address: row.fromName === null ? org.address : (row.fromAddress ?? ""), logoVersion: org.logo?.updatedAt.getTime() ?? null },
    });
  })
  // Makes an invoice from a client's unbilled time (and expenses), grouped as chosen.
  .post("/", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const client = typeof body.clientId === "string"
      ? await db.client.findFirst({ where: { id: body.clientId }, select: { id: true, currency: true } })
      : null;
    if (!client) return c.json({ error: "Choose a client." }, 400);
    const making = readMaking(body);
    if ("error" in making) return c.json(making, 400);
    const billing = readFees(body.fees);
    if ("error" in billing) return c.json(billing, 400);
    const { from, to } = making.period;
    // Whatever the request leaves out comes from the invoice settings: due date (from the
    // payment terms), tax and notes.
    const org = await db.organization.findFirstOrThrow({
      select: { invoiceDueDays: true, invoiceTaxBasisPoints: true, invoiceTaxLabel: true, invoiceNotes: true },
    });
    if (!isIsoDate(body.issueDate)) return c.json({ error: "Choose the issue and due dates." }, 400);
    const dueDate = body.dueDate == null || body.dueDate === "" ? addDays(body.issueDate, org.invoiceDueDays) : body.dueDate;
    if (!isIsoDate(dueDate)) return c.json({ error: "Choose the issue and due dates." }, 400);
    if (dueDate < body.issueDate) return c.json({ error: "The due date is before the issue date." }, 400);
    const taxBasisPoints = "taxPercent" in body ? readPercent(body.taxPercent) : org.invoiceTaxBasisPoints;
    if (taxBasisPoints === null) return c.json({ error: TAX_ERROR }, 400);
    const taxLabel = "taxLabel" in body ? readTaxLabel(body.taxLabel) : org.invoiceTaxLabel;
    if (taxLabel === null) return c.json({ error: TAX_LABEL_ERROR }, 400);
    const discount = readDiscount(body);
    if ("error" in discount) return c.json(discount, 400);
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : org.invoiceNotes;
    const poNumber = readText(body.poNumber, 50);
    if (poNumber === null) return c.json({ error: PO_ERROR }, 400);
    const subject = readText(body.subject, 200);
    if (subject === null) return c.json({ error: SUBJECT_ERROR }, 400);
    // In the client's currency, like its projects' rates, fees and expenses (currency.ts).
    const { currency } = client;

    for (let attempt = 0; ; attempt++) {
      try {
        const id = await db.$transaction(async (tx) => {
          const t = tx as OrgDb;
          const found = await unbilled(t, client.id, making.period);
          const data = {
            clientId: client.id,
            number: await takeInvoiceNumber(t),
            issueDate: asDate(body.issueDate as string),
            dueDate: asDate(dueDate),
            periodFrom: from ? asDate(from) : null,
            periodTo: to ? asDate(to) : null,
            currency,
            taxBasisPoints,
            taxLabel,
            ...discount,
            notes,
            poNumber,
            subject,
          };
          const invoice = await t.invoice.create({ data: data as typeof data & { organizationId: string }, select: { id: true } });
          let position = 0;
          let subtotal = 0;
          // Fixed fees first: each within what's left of it, counted while its project is held.
          for (const { projectId, taskId, amount } of billing.fees) {
            const held = await holdFee(t, projectId, client.id, taskId);
            if (!held) throw new FeeProblem(taskId ? "That phase isn't one of this project's, or the project just changed. Reload and try again." : "That fixed fee project isn't this client's, it's billed per phase, or it just changed. Reload and try again.");
            if (amount > held.left) throw new FeeProblem(feeTooLarge(held.name, held.left, currency));
            const line = { invoiceId: invoice.id, position: position++, kind: "fee" as const, description: feeLineDescription(held.projectName, held.phase), quantity: 1000, unitPrice: amount, amount, projectId, taskId };
            subtotal += amount;
            await t.invoiceLine.create({ data: line as typeof line & { organizationId: string }, select: { id: true } });
          }
          const secondsOf = new Map(found.entries.map((e) => [e.id, e.seconds]));
          const amountOf = new Map(found.expenses.map((x) => [x.id, x.amount]));
          for (const planned of planLines(found, making.grouping, making.includeExpenses)) {
            if (Math.abs(planned.amount) > MAX_CENTS) throw new TooLarge();
            const { kind, description, quantity, unitPrice, amount } = planned;
            const line = { invoiceId: invoice.id, position: position++, kind, description, quantity, unitPrice, amount };
            subtotal += amount;
            const lineId = (await t.invoiceLine.create({ data: line as typeof line & { organizationId: string }, select: { id: true } })).id;
            // Only time and expenses nobody else invoiced or changed meanwhile.
            if (planned.expenseId === null) {
              const { count } = await t.timeEntry.updateMany({
                where: { invoiceLineId: null, billable: true, startedAt: null, OR: planned.entryIds.map((id) => ({ id, seconds: secondsOf.get(id) })) },
                data: { invoiceLineId: lineId },
              });
              if (count !== planned.entryIds.length) throw new Conflict();
            } else {
              const { count } = await t.expense.updateMany({ where: { id: planned.expenseId, invoiceLineId: null, amount: amountOf.get(planned.expenseId) }, data: { invoiceLineId: lineId } });
              if (count !== 1) throw new Conflict();
            }
          }
          const created = await t.invoice.findFirstOrThrow({ where: { id: invoice.id }, select: AUDIT_SELECT });
          const changes = [
            ...snapshot({ client: created.client.name, issueDate: created.issueDate, dueDate: created.dueDate, subtotal }, ["client", "issueDate", "dueDate", "subtotal"]),
          ];
          await recordAudit(t, c.get("user"), { ...auditEvent(created), action: "created", changes });
          return invoice.id;
        });
        return c.json({ invoice: { id } }, 201);
      } catch (error) {
        if (error instanceof Conflict) return c.json({ error: "Some of this time or expenses just changed or went on another invoice. Try again." }, 409);
        if (error instanceof TooLarge) return c.json({ error: TOO_LARGE }, 400);
        if (error instanceof FeeProblem) return c.json({ error: error.message }, 409);
        // Two invoices took the same number at once, or the settings changed meanwhile.
        if ((error instanceof NumberTaken || isUniqueViolation(error)) && attempt < 5) continue;
        throw error;
      }
    }
  })
  .patch("/:id", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const current = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: AUDIT_SELECT });
    if (!current) return c.json({ error: "Invoice not found." }, 404);

    const data: {
      status?: "draft" | "sent" | "paid"; sentAt?: Date | null; paidAt?: Date | null;
      number?: string; issueDate?: Date; dueDate?: Date; notes?: string; taxBasisPoints?: number; taxLabel?: string;
      discountBasisPoints?: number; discountAmount?: number; poNumber?: string; subject?: string;
    } = {};
    const editing = ["number", "poNumber", "subject", "issueDate", "dueDate", "notes", "taxPercent", "taxLabel", "discountPercent", "discountAmount"].some((k) => k in body);
    if (editing && current.status !== "draft") return c.json({ error: "Move this invoice back to draft to change it." }, 409);
    if ("status" in body) {
      if (body.status !== "draft" && body.status !== "sent" && body.status !== "paid") return c.json({ error: "Choose draft, sent or paid." }, 400);
      data.status = body.status;
      // The dates say when it was first sent and when it was paid, so they only change with the status.
      data.sentAt = body.status === "draft" ? null : current.status === "draft" ? new Date() : undefined;
      data.paidAt = body.status === "paid" ? (current.status === "paid" ? undefined : new Date()) : null;
      // Paid online (or a bank payment on its way): it stays out of draft, and once paid it stays
      // paid, or its Pay now link would take the same amount again.
      if (body.status !== current.status && (body.status === "draft" || current.status === "paid")) {
        const online = await db.payment.count({ where: { invoiceId: current.id, status: { in: ["paid", "processing"] } } });
        if (online && body.status === "draft") return c.json({ error: "This invoice was paid online, so it can't go back to draft. Make a new invoice for any changes; refunds are made in Stripe." }, 409);
        if (online) return c.json({ error: "This invoice was paid online, so it stays paid. Refunds are made in Stripe." }, 409);
      }
      // Back to draft from sent: its checkouts end first, so nobody can pay while it changes. Ending
      // one can find it was just paid, so payments are checked again after.
      if (body.status === "draft" && current.status === "sent") {
        if (!(await endCheckoutsFirst(db, current.id))) return c.json({ error: "Stripe couldn't be reached to close this invoice's payment link. Try again in a few minutes." }, 503);
        if (await db.payment.count({ where: { invoiceId: current.id, status: { in: ["paid", "processing"] } } })) {
          return c.json({ error: "This invoice was paid online, so it can't go back to draft. Make a new invoice for any changes; refunds are made in Stripe." }, 409);
        }
      }
    }
    if ("number" in body) {
      const number = typeof body.number === "string" ? body.number.trim() : "";
      if (!number || number.length > 30) return c.json({ error: "Enter an invoice number (up to 30 characters)." }, 400);
      data.number = number;
    }
    if ("poNumber" in body) {
      const poNumber = readText(body.poNumber, 50);
      if (poNumber === null) return c.json({ error: PO_ERROR }, 400);
      data.poNumber = poNumber;
    }
    if ("subject" in body) {
      const subject = readText(body.subject, 200);
      if (subject === null) return c.json({ error: SUBJECT_ERROR }, 400);
      data.subject = subject;
    }
    for (const key of ["issueDate", "dueDate"] as const) {
      if (!(key in body)) continue;
      if (!isIsoDate(body[key])) return c.json({ error: "Choose valid dates." }, 400);
      data[key] = asDate(body[key] as string);
    }
    if ((data.dueDate ?? current.dueDate) < (data.issueDate ?? current.issueDate)) return c.json({ error: "The due date is before the issue date." }, 400);
    if ("notes" in body) {
      if (typeof body.notes !== "string" || body.notes.length > 2000) return c.json({ error: "Notes can be up to 2,000 characters." }, 400);
      data.notes = body.notes.trim();
    }
    if ("taxPercent" in body) {
      const bp = readPercent(body.taxPercent);
      if (bp === null) return c.json({ error: TAX_ERROR }, 400);
      data.taxBasisPoints = bp;
    }
    if ("taxLabel" in body) {
      const label = readTaxLabel(body.taxLabel);
      if (label === null) return c.json({ error: TAX_LABEL_ERROR }, 400);
      data.taxLabel = label;
    }
    // Either key replaces the whole discount: a percentage clears an amount, and the other way round.
    if ("discountPercent" in body || "discountAmount" in body) {
      const discount = readDiscount(body);
      if ("error" in discount) return c.json(discount, 400);
      Object.assign(data, discount);
    }
    try {
      const row = await db.$transaction(async (tx) => {
        // Leaving draft fixes who it's for and from; going back to draft lets them follow the current details.
        const details = data.status && data.status !== "draft" && current.status === "draft"
          ? await detailsWhenSent(tx as OrgDb, current.id)
          : data.status === "draft" && current.status !== "draft" ? DRAFT_DETAILS : {};
        const updated = await tx.invoice.update({ where: { id: current.id }, data: { ...data, ...details }, select: INVOICE_SELECT });
        await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(updated), action: "changed", changes: diff(audited(current), audited(updated), AUDITED) });
        return updated;
      });
      // Marked paid another way, or back to draft: the Pay now link mustn't take a payment any more.
      if (current.status === "sent" && row.status !== "sent") await closeInvoiceCheckouts(db, row.id);
      return c.json({ invoice: toInvoice(row) });
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: "Another invoice already has that number." }, 409);
      throw error;
    }
  })
  // Emails the invoice to the client (or another address). A draft becomes sent; a sent invoice gets a
  // reminder; a paid one is left alone. Nothing changes on the invoice unless the email went out.
  // Repeating (WRK-42): every week, month or 3 months a new draft is made from this invoice.
  // Saving a schedule whose next date has come makes that draft right away.
  .put("/:id/schedule", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const invoice = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: AUDIT_SELECT });
    if (!invoice) return c.json({ error: "Invoice not found." }, 404);
    if (!REPEAT_EVERY.includes(body.every as RepeatEvery)) return c.json({ error: "Choose how often it repeats." }, 400);
    const every = body.every as RepeatEvery;
    if (!isIsoDate(body.nextDate)) return c.json({ error: "Choose the date of the next draft." }, 400);
    const next = body.nextDate;
    const end = body.endDate == null || body.endDate === "" ? null : body.endDate;
    if (end !== null && !isIsoDate(end)) return c.json({ error: "Choose an end date, or leave it empty." }, 400);
    if (end !== null && end < next) return c.json({ error: "The end date is before the next draft." }, 400);
    const today = await orgToday(db);
    // A date long past would make a pile of drafts at once.
    if (next < addDays(today, -31)) return c.json({ error: "Choose a next date no earlier than a month ago." }, 400);
    // The schedule and its History entry are saved together; drafts due now are made after.
    const saved = await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      const before = await t.invoiceSchedule.findFirst({ where: { invoiceId: invoice.id }, select: SCHEDULE_SELECT });
      const data = { every, startDate: asDate(next), made: 0, endDate: end === null ? null : asDate(end) };
      if (before) await t.invoiceSchedule.updateMany({ where: { id: before.id }, data });
      else {
        const row = { invoiceId: invoice.id, ...data };
        await t.invoiceSchedule.create({ data: row as typeof row & { organizationId: string }, select: { id: true } });
      }
      const row = await t.invoiceSchedule.findFirstOrThrow({ where: { invoiceId: invoice.id }, select: SCHEDULE_SELECT });
      await recordAudit(t, c.get("user"), { ...auditEvent(invoice), action: "changed", changes: [{ field: "repeat", from: before ? repeatText(before) : null, to: repeatText(row) }] });
      return row;
    });
    const made = saved.pausedAt ? [] : await makeDueInvoices(db, today, saved.id);
    const after = await db.invoiceSchedule.findFirstOrThrow({ where: { id: saved.id }, select: SCHEDULE_SELECT });
    return c.json({ schedule: toSchedule(after), made });
  })
  // Pausing stops the drafts; resuming skips the dates missed meanwhile and carries on.
  .patch("/:id/schedule", async (c) => {
    const body = await readBody(c);
    if (typeof body.paused !== "boolean") return c.json({ error: "Say whether it's paused." }, 400);
    const db = c.get("db");
    const invoice = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: AUDIT_SELECT });
    const schedule = invoice && (await db.invoiceSchedule.findFirst({ where: { invoiceId: invoice.id }, select: SCHEDULE_SELECT }));
    if (!invoice || !schedule) return c.json({ error: "This invoice doesn't repeat." }, 404);
    const today = await orgToday(db);
    let made: string[] = [];
    await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      if (body.paused && !schedule.pausedAt) {
        await t.invoiceSchedule.updateMany({ where: { id: schedule.id }, data: { pausedAt: new Date() } });
      } else if (!body.paused && schedule.pausedAt) {
        let skip = schedule.made;
        while (skip < schedule.made + 10_000 && (nextDate({ ...schedule, made: skip }) ?? "9999") < today) skip++;
        await t.invoiceSchedule.updateMany({ where: { id: schedule.id }, data: { pausedAt: null, made: skip } });
      }
      await recordAudit(t, c.get("user"), { ...auditEvent(invoice), action: "changed", changes: [{ field: "repeat", from: schedule.pausedAt ? "Paused" : "Repeating", to: body.paused ? "Paused" : "Repeating" }] });
    });
    if (!body.paused && schedule.pausedAt) made = await makeDueInvoices(db, today, schedule.id);
    const after = await db.invoiceSchedule.findFirstOrThrow({ where: { id: schedule.id }, select: SCHEDULE_SELECT });
    return c.json({ schedule: toSchedule(after), made });
  })
  .delete("/:id/schedule", async (c) => {
    const db = c.get("db");
    const invoice = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: AUDIT_SELECT });
    const schedule = invoice && (await db.invoiceSchedule.findFirst({ where: { invoiceId: invoice.id }, select: SCHEDULE_SELECT }));
    if (!invoice || !schedule) return c.json({ error: "This invoice doesn't repeat." }, 404);
    await db.$transaction(async (tx) => {
      await tx.invoiceSchedule.deleteMany({ where: { id: schedule.id } });
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(invoice), action: "changed", changes: [{ field: "repeat", from: repeatText(schedule), to: null }] });
    });
    return c.json({ ok: true });
  })
  // Late-payment reminders (reminders.ts): "Don't remind" for this invoice, or remind again.
  .patch("/:id/reminders", async (c) => {
    const body = await readBody(c);
    if (typeof body.off !== "boolean") return c.json({ error: "Say whether to remind the client about this invoice." }, 400);
    const off = body.off;
    const db = c.get("db");
    const invoice = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: { ...AUDIT_SELECT, remindersOff: true } });
    if (!invoice) return c.json({ error: "Invoice not found." }, 404);
    const row = await db.$transaction(async (tx) => {
      await tx.invoice.updateMany({ where: { id: invoice.id }, data: { remindersOff: off } });
      if (invoice.remindersOff !== off) {
        await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(invoice), action: "changed", changes: [{ field: "reminders", from: invoice.remindersOff ? "Off" : "On", to: off ? "Off" : "On" }] });
      }
      return tx.invoice.findFirstOrThrow({ where: { id: invoice.id }, select: INVOICE_SELECT });
    });
    return c.json({ invoice: toInvoice(row) });
  })
  .post("/:id/email", async (c) => {
    if (isDemoMode()) return c.json({ error: DEMO_EMAIL_REFUSAL }, 403);
    const db = c.get("db");
    const body = await readBody(c);
    const row = await db.invoice.findFirst({ where: { id: c.req.param("id") }, select: INVOICE_SELECT });
    if (!row) return c.json({ error: "Invoice not found." }, 404);
    if (row.status === "paid") return c.json({ error: "This invoice is already paid." }, 409);
    if (!(await isEmailConfigured(db))) return c.json({ error: "Email isn't turned on. An admin can set it up in Manage → Email." }, 409);
    const to = (typeof body.to === "string" && body.to.trim() ? body.to : row.client.email).trim();
    if (!to) return c.json({ error: "Enter the address to send it to. This client has no email address." }, 400);
    if (to.length > 254 || !isEmail(to)) return c.json({ error: "Enter a valid email address." }, 400);
    if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 2000)) return c.json({ error: "The message can be up to 2,000 characters." }, 400);
    const message = typeof body.message === "string" ? body.message.trim() : "";

    const { name, appName, accentColor } = await db.organization.findFirstOrThrow({ select: { name: true, appName: true, accentColor: true } });
    const sent = await sendMail(db, invoiceEmail(to, toInvoice(row), row.fromName ?? name, row.status === "sent", message, await payLinkFor(db, row.id), { name: displayAppName({ appName, name }), accentColor }));
    if (!sent.ok) return c.json({ error: sent.error }, 502);

    const now = new Date();
    const updated = await db.$transaction(async (tx) => {
      const after = await tx.invoice.update({
        where: { id: row.id },
        data: { emailedAt: now, emailedTo: to, ...(row.status === "draft" ? { status: "sent" as const, sentAt: now, ...(await detailsWhenSent(tx as OrgDb, row.id)) } : {}) },
        select: INVOICE_SELECT,
      });
      // Every email is recorded, even a second one to the same address.
      const changes = [...diff(audited(row), audited(after), ["status"]), { field: "emailedTo", from: null, to }];
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(after), action: "changed", changes });
      return after;
    });
    return c.json({ invoice: toInvoice(updated) });
  })
  // Only drafts can be deleted. Their time and expenses become billable again.
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const found = await draft(db, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    // Checkouts still open at Stripe end first: a deleted invoice mustn't take a payment.
    await closeInvoiceCheckouts(db, found.invoice.id);
    const outcome = await db.$transaction(async (tx) => {
      await holdDraft(tx as OrgDb, found.invoice.id);
      const payments = await tx.payment.groupBy({ by: ["status"], where: { invoiceId: found.invoice.id }, _count: true });
      if (payments.some((p) => p.status === "paid" || p.status === "processing")) return "paid online" as const;
      if (payments.some((p) => p.status === "open")) return "checkout open" as const;
      await tx.payment.deleteMany({ where: { invoiceId: found.invoice.id } }); // checkouts that ended unpaid
      const invoice = await tx.invoice.findFirstOrThrow({ where: { id: found.invoice.id }, select: { ...AUDIT_SELECT, lines: { select: { amount: true } } } });
      await release(tx as OrgDb, { invoiceId: found.invoice.id });
      await tx.invoice.deleteMany({ where: { id: found.invoice.id } });
      const subtotal = invoice.lines.reduce((sum, l) => sum + l.amount, 0);
      const changes = snapshot({ client: invoice.client.name, issueDate: invoice.issueDate, dueDate: invoice.dueDate, subtotal }, ["client", "issueDate", "dueDate", "subtotal"], true);
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(invoice), action: "deleted", changes });
      return "deleted" as const;
    }).catch(notDraft);
    if (outcome === NOT_DRAFT) return c.json({ error: NOT_DRAFT }, 409);
    if (outcome === "paid online") return c.json({ error: "This invoice was paid online, so it can't be deleted." }, 409);
    if (outcome === "checkout open") return c.json({ error: "A client's online checkout for this invoice is still open. Try again in a few minutes." }, 409);
    return c.json({ ok: true });
  })
  // A line of your own, like a fixed fee or a discount (a negative price).
  .post("/:id/lines", async (c) => {
    const db = c.get("db");
    const found = await draft(db, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const input = readLine(await readBody(c), true);
    if ("error" in input) return c.json(input, 400);
    const d = input.data as { description: string; quantity: number; unitPrice: number };
    const amount = lineAmount(d.quantity, d.unitPrice);
    if (Math.abs(amount) > MAX_CENTS) return c.json({ error: TOO_LARGE }, 400);
    const created = await db.$transaction(async (tx) => {
      await holdDraft(tx as OrgDb, found.invoice.id);
      // Counted while the invoice is held, so two lines added at once get their own places.
      const last = await tx.invoiceLine.findFirst({ where: { invoiceId: found.invoice.id }, orderBy: { position: "desc" }, select: { position: true } });
      const line = { ...d, invoiceId: found.invoice.id, kind: "custom" as const, position: (last?.position ?? -1) + 1, amount };
      const added = await tx.invoiceLine.create({ data: line as typeof line & { organizationId: string }, select: LINE_SELECT });
      await recordLine(tx as OrgDb, c.get("user"), found.invoice.id, null, added);
      return added;
    }).catch(notDraft);
    if (created === NOT_DRAFT) return c.json({ error: NOT_DRAFT }, 409);
    return c.json({ line: created }, 201);
  })
  .patch("/:id/lines/:lineId", async (c) => {
    const db = c.get("db");
    const found = await draft(db, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const line = await db.invoiceLine.findFirst({ where: { id: c.req.param("lineId"), invoiceId: found.invoice.id }, select: { ...LINE_SELECT, projectId: true, taskId: true } });
    if (!line) return c.json({ error: "Line not found." }, 404);
    const input = readLine(await readBody(c), false);
    if ("error" in input) return c.json(input, 400);
    const quantity = input.data.quantity ?? line.quantity;
    const unitPrice = input.data.unitPrice ?? line.unitPrice;
    // Recalculate the amount only when the quantity or rate actually changes, so saving a time line
    // unchanged, or renaming it, keeps the amount it was invoiced at.
    const repriced = quantity !== line.quantity || unitPrice !== line.unitPrice;
    if (repriced && Math.abs(lineAmount(quantity, unitPrice)) > MAX_CENTS) return c.json({ error: TOO_LARGE }, 400);
    const updated = await db.$transaction(async (tx) => {
      await holdDraft(tx as OrgDb, found.invoice.id);
      // A fee line can change to any amount above zero, up to what's left of the fee besides itself.
      if (line.kind === "fee" && repriced && line.projectId) {
        const amount = lineAmount(quantity, unitPrice);
        const held = await holdFee(tx as OrgDb, line.projectId, undefined, line.taskId);
        if (!held) throw new FeeProblem("This project isn't a fixed fee project any more. Remove the line instead.");
        if (amount <= 0) throw new FeeProblem("A fixed fee line needs an amount above zero. To bill none of it, remove the line.");
        if (amount > held.left + line.amount) throw new FeeProblem(feeTooLarge(held.name, held.left + line.amount, (await tx.invoice.findFirstOrThrow({ where: { id: found.invoice.id }, select: { currency: true } })).currency));
      }
      const after = await tx.invoiceLine.update({ where: { id: line.id }, data: { ...input.data, ...(repriced ? { amount: lineAmount(quantity, unitPrice) } : {}) }, select: LINE_SELECT });
      await recordLine(tx as OrgDb, c.get("user"), found.invoice.id, line, after);
      return after;
    }).catch((error: unknown) => (error instanceof FeeProblem ? error : notDraft(error)));
    if (updated === NOT_DRAFT) return c.json({ error: NOT_DRAFT }, 409);
    if (updated instanceof FeeProblem) return c.json({ error: updated.message }, 400);
    return c.json({ line: updated });
  })
  // Removing a line makes its time and expenses billable again.
  .delete("/:id/lines/:lineId", async (c) => {
    const db = c.get("db");
    const found = await draft(db, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const line = await db.invoiceLine.findFirst({ where: { id: c.req.param("lineId"), invoiceId: found.invoice.id }, select: LINE_SELECT });
    if (!line) return c.json({ error: "Line not found." }, 404);
    const done = await db.$transaction(async (tx) => {
      await holdDraft(tx as OrgDb, found.invoice.id);
      await release(tx as OrgDb, { id: line.id });
      await tx.invoiceLine.deleteMany({ where: { id: line.id } });
      await recordLine(tx as OrgDb, c.get("user"), found.invoice.id, line, null);
    }).catch(notDraft);
    if (done === NOT_DRAFT) return c.json({ error: NOT_DRAFT }, 409);
    return c.json({ ok: true });
  });
