// Repeating invoices (WRK-42): on each date a schedule makes a new draft from its invoice.
// Drafts are never sent by themselves; someone checks and sends each one.
//
// What a draft copies: the client, currency, tax, discount, notes, PO number, subject and the
// payment terms (the days between issue and due date), and the invoice's own lines. Fixed fee
// lines are copied within what's left of the fee. Time and expense lines aren't: they belong to
// the time and expenses they billed, so new ones are added to each draft.

import type { OrgDb } from "./db.ts";
import { orgDb, prisma } from "./db.ts";
import { recordAudit, snapshot } from "./audit.ts";
import { holdFee } from "./fees.ts";
import { NumberTaken, takeInvoiceNumber } from "./invoiceSettings.ts";
import { isUniqueViolation } from "./http.ts";
import { describeError } from "./logging.ts";
import { localNow } from "./timesheets.ts";
import { formatMoney } from "../shared/money.ts";
import { addDays, asDate, dayOrNull, daysBetween } from "../shared/time.ts";
import { occurrence, REPEAT_EVERY, type RepeatEvery } from "../shared/repeat.ts";

export { occurrence, REPEAT_EVERY, type RepeatEvery };

/** Who the History says made a draft. */
export const REPEATING = { id: null, name: "Repeating invoice" };

/** At most this many drafts for one schedule in one go, if the server was off for a long time. */
const CATCH_UP = 12;

type ScheduleRow = { id: string; invoiceId: string; every: RepeatEvery; startDate: Date; made: number; endDate: Date | null; pausedAt: Date | null };
export const SCHEDULE_SELECT = { id: true, invoiceId: true, every: true, startDate: true, made: true, endDate: true, pausedAt: true } as const;

/** The next date a draft is due, or null when the end date has passed. */
export function nextDate(row: ScheduleRow): string | null {
  const next = occurrence(dayOrNull(row.startDate)!, row.every, row.made);
  const end = dayOrNull(row.endDate);
  return end && next > end ? null : next;
}

/** A schedule as the app shows it. */
export function toSchedule(row: ScheduleRow) {
  return { every: row.every, nextDate: nextDate(row), endDate: dayOrNull(row.endDate), paused: row.pausedAt !== null, made: row.made };
}

class Claimed extends Error {}

/**
 * Makes the drafts that are due by `today` (the organization's own date): for one schedule, or
 * for all of them. Each draft first claims its turn (made goes from n to n + 1), so two sweeps at
 * once, or a sweep that runs twice, make it only once. Returns the new invoices' ids.
 */
export async function makeDueInvoices(db: OrgDb, today: string, scheduleId?: string): Promise<string[]> {
  const schedules = await db.invoiceSchedule.findMany({ where: { pausedAt: null, ...(scheduleId ? { id: scheduleId } : {}) }, select: SCHEDULE_SELECT });
  const made: string[] = [];
  for (const schedule of schedules) {
    for (let n = schedule.made; n < schedule.made + CATCH_UP; n++) {
      const due = nextDate({ ...schedule, made: n });
      if (!due || due > today) break;
      const id = await makeDraft(db, schedule.id, schedule.invoiceId, n, due);
      if (!id) break;
      made.push(id);
    }
  }
  return made;
}

/** The n-th draft of a schedule, dated `issueDate`, or null when another sweep made it first. */
async function makeDraft(db: OrgDb, scheduleId: string, sourceId: string, n: number, issueDate: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const t = tx as OrgDb;
        const { count } = await t.invoiceSchedule.updateMany({ where: { id: scheduleId, made: n, pausedAt: null }, data: { made: n + 1 } });
        if (count !== 1) throw new Claimed();
        const source = await t.invoice.findFirstOrThrow({
          where: { id: sourceId },
          select: {
            clientId: true, currency: true, issueDate: true, dueDate: true, taxBasisPoints: true, taxLabel: true, discountBasisPoints: true,
            discountAmount: true, notes: true, poNumber: true, subject: true, number: true,
            lines: { select: { kind: true, description: true, quantity: true, unitPrice: true, amount: true, projectId: true, taskId: true }, orderBy: { position: "asc" } },
          },
        });
        const terms = daysBetween(dayOrNull(source.issueDate)!, dayOrNull(source.dueDate)!);
        const data = {
          clientId: source.clientId,
          number: await takeInvoiceNumber(t),
          issueDate: asDate(issueDate),
          dueDate: asDate(addDays(issueDate, terms)),
          currency: source.currency,
          taxBasisPoints: source.taxBasisPoints,
          taxLabel: source.taxLabel,
          discountBasisPoints: source.discountBasisPoints,
          discountAmount: source.discountAmount,
          notes: source.notes,
          poNumber: source.poNumber,
          subject: source.subject,
        };
        const invoice = await t.invoice.create({ data: data as typeof data & { organizationId: string }, select: { id: true, number: true, client: { select: { name: true } } } });
        let position = 0;
        let subtotal = 0;
        const leftOut: string[] = [];
        for (const line of source.lines) {
          if (line.kind === "time" || line.kind === "expense") continue;
          if (line.kind === "fee") {
            // Within what's left of the project's fixed fee (or of its phase, WRK-151), counted while the project is held.
            const held = line.projectId ? await holdFee(t, line.projectId, source.clientId, line.taskId) : null;
            if (!held || line.amount > held.left) {
              leftOut.push(`${line.description} (${formatMoney(line.amount, source.currency)}): ${held ? "the fixed fee is used up" : "the project's fixed fee changed"}`);
              continue;
            }
          }
          const copy = { invoiceId: invoice.id, position: position++, kind: line.kind, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, amount: line.amount, projectId: line.projectId, taskId: line.taskId };
          subtotal += line.amount;
          await t.invoiceLine.create({ data: copy as typeof copy & { organizationId: string }, select: { id: true } });
        }
        const changes = [
          ...snapshot({ client: invoice.client.name, issueDate: data.issueDate, dueDate: data.dueDate, subtotal }, ["client", "issueDate", "dueDate", "subtotal"]),
          { field: "note", from: null, to: `A repeat of invoice ${source.number}.` },
          ...leftOut.map((text) => ({ field: "note", from: null, to: `Left out: ${text}.` })),
        ];
        await recordAudit(t, REPEATING, { kind: "invoice", action: "created", subjectId: invoice.id, label: `Invoice ${invoice.number} · ${invoice.client.name}`, currency: source.currency, changes });
        return invoice.id;
      });
    } catch (error) {
      if (error instanceof Claimed) return null;
      // Another invoice took the same number at once: try again with the next one.
      if ((error instanceof NumberTaken || isUniqueViolation(error)) && attempt < 5) continue;
      throw error;
    }
  }
}

/** Every organization's due drafts, on its own date. Runs every few minutes. Returns how many it made. */
export async function sweepRecurringInvoices(now = new Date()): Promise<number> {
  const orgs = await prisma.organization.findMany({ where: { invoiceSchedules: { some: { pausedAt: null } } }, select: { id: true, timeZone: true } });
  let made = 0;
  for (const org of orgs) {
    try {
      made += (await makeDueInvoices(orgDb(org.id), localNow(org.timeZone, now).date)).length;
    } catch (error) {
      console.error("Making repeating invoices failed for one organization", describeError(error));
    }
  }
  return made;
}

/** Today in the signed-in organization's time zone. */
export async function orgToday(db: OrgDb, now = new Date()): Promise<string> {
  const { timeZone } = await db.organization.findFirstOrThrow({ select: { timeZone: true } });
  return localNow(timeZone, now).date;
}
