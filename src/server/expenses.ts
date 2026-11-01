import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { readBody, readRange, type SignedIn } from "./http.ts";
import { projectsFor } from "./billing.ts";
import { asDate, dayOf, isIsoDate } from "../shared/time.ts";
import { isCents } from "../shared/money.ts";
import { diff, projectLabel, recordAudit, snapshot } from "./audit.ts";
import { currencies } from "./currency.ts";

// Expenses: money someone spent on a project (travel, stock photos, printing).
// Like time, each person sees and changes only their own. Billable expenses
// can go on an invoice.

const SELECT = {
  id: true,
  date: true,
  category: true,
  amount: true,
  notes: true,
  billable: true,
  reimbursable: true,
  // An expense is in its project's currency: its client's, or the home currency (currency.ts).
  project: { select: { id: true, name: true, client: { select: { id: true, name: true, currency: true } } } },
  invoiceLine: { select: { invoice: { select: { id: true, number: true } } } },
  receipt: { select: { fileName: true, contentType: true, size: true } },
} as const;

const toExpense = <T extends { date: Date; invoiceLine: { invoice: { id: string; number: string } } | null }>({ invoiceLine, ...row }: T) => ({
  ...row,
  date: dayOf(row.date),
  invoice: invoiceLine?.invoice ?? null,
});
// What the history records about an expense.
const AUDITED = ["project", "date", "category", "amount", "notes", "billable", "reimbursable"] as const;
type Audited = { id: string; project: { name: string; client: { name: string; currency: string } | null }; date: Date; category: string; amount: number; notes: string; billable: boolean; reimbursable: boolean };
const audited = (row: Audited) => ({ project: projectLabel(row.project), date: row.date, category: row.category, amount: row.amount, notes: row.notes, billable: row.billable, reimbursable: row.reimbursable });
const auditEvent = (row: Audited) => ({ kind: "expense" as const, subjectId: row.id, label: `${row.category} · ${projectLabel(row.project)}`, entryDate: row.date, currency: row.project.client?.currency });

const invoicedError = (number: string) => ({ error: `This expense is on invoice ${number}. Take it off the invoice to change it.` });
/** Put on an invoice between reading the expense and changing it. */
class Invoiced extends Error {}
const JUST_INVOICED = { error: "This expense was just put on an invoice. Take it off the invoice to change it." };
const MAX_RANGE_DAYS = 400;

type ExpenseData = { projectId?: string; date?: Date; category?: string; amount?: number; notes?: string; billable?: boolean; reimbursable?: boolean };

async function readExpense(db: OrgDb, user: { id: string; role: string }, body: Record<string, unknown>, creating: boolean) {
  const data: ExpenseData = {};
  const fail = (error: string) => ({ error });
  if (creating || "projectId" in body) {
    const project = typeof body.projectId === "string"
      ? await db.project.findFirst({ where: { AND: [{ id: body.projectId, archived: false }, projectsFor(user)] }, select: { id: true, billable: true } })
      : null;
    if (!project) return fail("Choose an active project.");
    data.projectId = project.id;
    if (creating) data.billable = project.billable; // the project's default, unless chosen below
  }
  if (creating || "date" in body) {
    if (!isIsoDate(body.date)) return fail("Choose a valid date.");
    data.date = asDate(body.date);
  }
  if (creating || "category" in body) {
    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (!category || category.length > 60) return fail("Enter a category, like Travel or Printing (up to 60 characters).");
    data.category = category;
  }
  if (creating || "amount" in body) {
    if (!isCents(body.amount) || body.amount === 0) return fail("Enter an amount like 42.50.");
    data.amount = body.amount;
  }
  if ("notes" in body) {
    if (typeof body.notes !== "string" || body.notes.length > 2000) return fail("Notes can be up to 2,000 characters.");
    data.notes = body.notes.trim();
  }
  if ("billable" in body) {
    if (typeof body.billable !== "boolean") return fail("Billable must be true or false.");
    data.billable = body.billable;
  }
  if ("reimbursable" in body) {
    if (typeof body.reimbursable !== "boolean") return fail("Reimbursable must be true or false.");
    data.reimbursable = body.reimbursable;
  }
  return { data };
}

export const expenseRoutes = new Hono<SignedIn>()
  // Your expenses from one date to another, both included.
  .get("/", async (c) => {
    const range = readRange(c, MAX_RANGE_DAYS, "Choose a date range of up to a year.");
    if (range instanceof Response) return range;
    const { from, to } = range;
    const rows = await c.get("db").expense.findMany({
      where: { userId: c.get("user").id, date: { gte: asDate(from), lte: asDate(to) } },
      select: SELECT,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    return c.json({ expenses: rows.map(toExpense) });
  })
  // Categories anyone in the organization has used, to suggest while typing.
  .get("/categories", async (c) => {
    const rows = await c.get("db").expense.findMany({ distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 200 });
    return c.json({ categories: rows.map((r) => r.category) });
  })
  .post("/", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const input = await readExpense(db, user, await readBody(c), true);
    if ("error" in input) return c.json(input, 400);
    const data = { ...input.data, userId: user.id };
    const row = await db.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: data as Required<ExpenseData> & { userId: string; organizationId: string }, // orgDb fills in organizationId
        select: SELECT,
      });
      await recordAudit(tx as OrgDb, user, { ...auditEvent(created), action: "created", changes: snapshot(audited(created), AUDITED) });
      return created;
    });
    return c.json({ expense: toExpense(row) }, 201);
  })
  .patch("/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const existing = await db.expense.findFirst({ where: { id: c.req.param("id"), userId: user.id }, select: SELECT });
    if (!existing) return c.json({ error: "Expense not found." }, 404);
    if (existing.invoiceLine) return c.json(invoicedError(existing.invoiceLine.invoice.number), 409);
    const input = await readExpense(db, user, await readBody(c), false);
    if ("error" in input) return c.json(input, 400);
    // Its amount is in its project's currency, so it can only move to a project in the same one.
    if (input.data.projectId && input.data.projectId !== existing.project.id) {
      const { home } = await currencies(db);
      const to = await db.project.findFirstOrThrow({ where: { id: input.data.projectId }, select: { client: { select: { currency: true } } } });
      const [from, into] = [existing.project.client?.currency ?? home, to.client?.currency ?? home];
      if (from !== into) return c.json({ error: `This expense is in ${from} and that project is billed in ${into}. Add it again on that project instead.` }, 400);
    }
    const row = await db.$transaction(async (tx) => {
      const { count } = await tx.expense.updateMany({ where: { id: existing.id, invoiceLineId: null }, data: input.data });
      if (!count) throw new Invoiced();
      const updated = await tx.expense.findFirstOrThrow({ where: { id: existing.id }, select: SELECT });
      await recordAudit(tx as OrgDb, user, { ...auditEvent(updated), action: "changed", changes: diff(audited(existing), audited(updated), AUDITED) });
      return updated;
    }).catch((error) => {
      if (error instanceof Invoiced) return null;
      throw error;
    });
    if (!row) return c.json(JUST_INVOICED, 409);
    return c.json({ expense: toExpense(row) });
  })
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const existing = await db.expense.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id }, select: SELECT });
    if (!existing) return c.json({ error: "Expense not found." }, 404);
    if (existing.invoiceLine) return c.json(invoicedError(existing.invoiceLine.invoice.number), 409);
    const invoiced = await db.$transaction(async (tx) => {
      const { count } = await tx.expense.deleteMany({ where: { id: existing.id, invoiceLineId: null } });
      if (count) await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(existing), action: "deleted", changes: snapshot(audited(existing), AUDITED, true) });
      return !count && (await tx.expense.count({ where: { id: existing.id } })) > 0;
    });
    if (invoiced) return c.json(JUST_INVOICED, 409);
    return c.json({ ok: true });
  });
