import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { requireAdmin, requireManager, readBody, type SignedIn } from "./http.ts";
import { formatInvoiceNumber, readNextNumber } from "../shared/invoiceNumber.ts";
import { readPercent } from "../shared/invoiceMath.ts";
import { REMINDER_DAYS } from "../shared/reminders.ts";

// Manage → Invoices: how new invoices are numbered and what they start with.
// Admins change it; managers read it, since they make invoices too. Each invoice
// keeps its own copy of the tax, terms and notes, so changing these never alters
// an invoice that already exists.

const SELECT = {
  invoicePrefix: true,
  invoiceNextNumber: true,
  invoiceNumberDigits: true,
  invoiceDueDays: true,
  invoiceTaxBasisPoints: true,
  invoiceTaxLabel: true,
  invoiceNotes: true,
  invoiceReminderDays: true,
} as const;
type Row = {
  invoicePrefix: string; invoiceNextNumber: number; invoiceNumberDigits: number; invoiceDueDays: number;
  invoiceTaxBasisPoints: number; invoiceTaxLabel: string; invoiceNotes: string; invoiceReminderDays: number;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

export { readPercent };

/** What the tax is called, like VAT or GST. Empty means "Tax"; null if it's too long. */
export function readTaxLabel(value: unknown): string | null {
  if (value != null && typeof value !== "string") return null;
  const label = (value ?? "").trim();
  if (label.length > 20 || CONTROL.test(label)) return null;
  return label || "Tax";
}

/** The counter, moved past any number an invoice already has (someone may have typed it on a draft). */
async function firstFree(db: OrgDb, row: Row) {
  const used = await db.invoice.findMany({ where: { number: { startsWith: row.invoicePrefix } }, select: { number: true } });
  const taken = new Set(used.map((r) => r.number));
  let n = row.invoiceNextNumber;
  while (taken.has(formatInvoiceNumber(row.invoicePrefix, n, row.invoiceNumberDigits))) n++;
  return n;
}

/** Another invoice took a number, or the settings changed, while this one was being made. Try again. */
export class NumberTaken extends Error {}

/**
 * Takes the next invoice number, inside the transaction that makes the invoice. Numbers already in
 * use are skipped. The counter moves on only if nobody else moved it meanwhile; otherwise this throws
 * NumberTaken and the caller starts again. The unique index on (organizationId, number) is the backstop.
 */
export async function takeInvoiceNumber(t: OrgDb) {
  const row = await t.organization.findFirstOrThrow({ select: SELECT });
  const n = await firstFree(t, row);
  const { count } = await t.organization.updateMany({
    where: { invoicePrefix: row.invoicePrefix, invoiceNextNumber: row.invoiceNextNumber, invoiceNumberDigits: row.invoiceNumberDigits },
    data: { invoiceNextNumber: n + 1 },
  });
  if (count !== 1) throw new NumberTaken();
  return formatInvoiceNumber(row.invoicePrefix, n, row.invoiceNumberDigits);
}

/** The number the next invoice will really get. */
export async function nextInvoiceNumber(db: OrgDb) {
  const row = await db.organization.findFirstOrThrow({ select: SELECT });
  return formatInvoiceNumber(row.invoicePrefix, await firstFree(db, row), row.invoiceNumberDigits);
}

async function present(db: OrgDb, row: Row) {
  return {
    settings: {
      prefix: row.invoicePrefix,
      // As the admin typed it, leading zeros included.
      nextNumber: String(row.invoiceNextNumber).padStart(row.invoiceNumberDigits, "0"),
      dueDays: row.invoiceDueDays,
      taxBasisPoints: row.invoiceTaxBasisPoints,
      taxLabel: row.invoiceTaxLabel,
      notes: row.invoiceNotes,
      // Late-payment reminders: days after the due date, 0 = off.
      reminderDays: row.invoiceReminderDays,
    },
    // The number the next invoice will really get.
    next: formatInvoiceNumber(row.invoicePrefix, await firstFree(db, row), row.invoiceNumberDigits),
  };
}

export const invoiceSettingsRoutes = new Hono<SignedIn>()
  .get("/", requireManager("see invoice settings"), async (c) => {
    const db = c.get("db");
    return c.json(await present(db, await db.organization.findFirstOrThrow({ select: SELECT })));
  })
  // { prefix, nextNumber: "0042", dueDays, taxPercent, taxLabel, notes }
  .put("/", requireAdmin("change invoice settings"), async (c) => {
    const body = await readBody(c);
    const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
    if (prefix.length > 20 || CONTROL.test(prefix)) return c.json({ error: "Keep the prefix to 20 characters." }, 400);
    const next = typeof body.nextNumber === "string" || typeof body.nextNumber === "number" ? readNextNumber(String(body.nextNumber)) : null;
    if (!next) return c.json({ error: "Enter the next number in digits, like 0001 or 1042." }, 400);
    const dueDays = body.dueDays;
    if (!Number.isInteger(dueDays) || (dueDays as number) < 0 || (dueDays as number) > 365) {
      return c.json({ error: "Choose when invoices are due: 0 to 365 days after they're issued." }, 400);
    }
    const taxBasisPoints = readPercent(body.taxPercent);
    if (taxBasisPoints === null) return c.json({ error: "Enter tax as a percentage from 0 to 100, like 8.25." }, 400);
    const taxLabel = readTaxLabel(body.taxLabel);
    if (taxLabel === null) return c.json({ error: "Keep the tax name to 20 characters, like VAT or GST." }, 400);
    if (body.notes != null && (typeof body.notes !== "string" || body.notes.length > 2000)) return c.json({ error: "Notes can be up to 2,000 characters." }, 400);
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    // Left out means unchanged.
    if (body.reminderDays !== undefined && !(REMINDER_DAYS as readonly unknown[]).includes(body.reminderDays)) {
      return c.json({ error: "Choose when to remind clients: off, or 3, 7 or 14 days after the due date." }, 400);
    }

    const db = c.get("db");
    const row = await db.organization.update({
      where: { id: c.get("user").organizationId },
      data: {
        invoicePrefix: prefix,
        invoiceNextNumber: next.n,
        invoiceNumberDigits: next.digits,
        invoiceDueDays: dueDays as number,
        invoiceTaxBasisPoints: taxBasisPoints,
        invoiceTaxLabel: taxLabel,
        invoiceNotes: notes,
        ...(body.reminderDays !== undefined ? { invoiceReminderDays: body.reminderDays as number } : {}),
      },
      select: SELECT,
    });
    return c.json(await present(db, row));
  });
