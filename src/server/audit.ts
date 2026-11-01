import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { requireAdmin, type SignedIn } from "./http.ts";
import { toCsv } from "../shared/csv.ts";
import { AUDIT_KINDS, type AuditKind, type AuditValue, type Change } from "../shared/audit.ts";
import { dayOf, dayOrNull, dayOrEmpty } from "../shared/time.ts";

// Audit history: who changed time, expenses, rates, budgets, invoices and
// people, and when. Routes record a change in the same transaction as the
// change itself, so a change can't happen without its record. Timers aren't
// recorded: time a timer measures isn't an edit, but typing time in or
// changing it is. Admins read the history in Manage → History.

/** Who made a change: a person, or the app itself (id null), like an online payment. */
export type Actor = { id: string | null; name: string };
type Fields<T> = readonly (keyof T & string)[];

const asValue = (v: unknown): AuditValue => {
  if (v instanceof Date) return dayOf(v);
  if (v === undefined) return null;
  return v as AuditValue;
};

const isEmpty = (v: AuditValue) => v === null || v === "";

/** The fields that differ between two versions of a row. */
export function diff<T extends Record<string, unknown>>(before: T, after: T, fields: Fields<T>): Change[] {
  return fields
    .map((field) => ({ field, from: asValue(before[field]), to: asValue(after[field]) }))
    .filter((c) => c.from !== c.to);
}

/** Every field of a row that was just created (from nothing) or deleted (to nothing). */
export function snapshot<T extends Record<string, unknown>>(row: T, fields: Fields<T>, deleted = false): Change[] {
  return fields
    .map((field) => (deleted ? { field, from: asValue(row[field]), to: null } : { field, from: null, to: asValue(row[field]) }))
    .filter((c) => !isEmpty(c.from) || !isEmpty(c.to));
}

type Event = {
  kind: AuditKind;
  action: "created" | "changed" | "deleted";
  subjectId?: string | null;
  label: string;
  entryDate?: Date | null;
  changes?: Change[];
  /** The currency of amounts in `changes`: a client's own. Left out, the home currency. */
  currency?: string | null;
};

/** Records one change. A "changed" event where nothing changed isn't recorded. */
export async function recordAudit(db: OrgDb, actor: Actor, event: Event) {
  const changes = event.changes ?? [];
  if (event.action === "changed" && !changes.length) return;
  const data = {
    actorId: actor.id,
    actorName: actor.name,
    kind: event.kind,
    action: event.action,
    subjectId: event.subjectId ?? null,
    label: event.label.slice(0, 300),
    entryDate: event.entryDate ?? null,
    changes,
    currency: event.currency ?? null,
  };
  await db.auditEvent.create({ data: data as typeof data & { organizationId: string } }); // orgDb fills in organizationId
}

/** "Website redesign · Acme Ltd", or just the project's name without a client. */
export const projectLabel = (p: { name: string; client: { name: string } | null }) => (p.client ? `${p.name} · ${p.client.name}` : p.name);

const PAGE = 50;
const EXPORT_LIMIT = 50_000;

/** Filters from the query string: ?kind=&actorId=&since=&until= (instants), or an error. */
function readFilters(q: (key: string) => string | undefined) {
  const where: Record<string, unknown> = {};
  const kind = q("kind");
  if (kind) {
    if (!AUDIT_KINDS.includes(kind as AuditKind)) return { error: "Choose a kind of change." };
    where.kind = kind;
  }
  const actorId = q("actorId");
  if (actorId) where.actorId = actorId;
  const createdAt: Record<string, Date> = {};
  for (const [key, op] of [["since", "gte"], ["until", "lt"]] as const) {
    const v = q(key);
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return { error: "Choose valid dates." };
    createdAt[op] = new Date(t);
  }
  if (Object.keys(createdAt).length) where.createdAt = createdAt;
  return { where };
}

const SELECT = {
  id: true, actorId: true, actorName: true, kind: true, action: true, subjectId: true,
  label: true, entryDate: true, changes: true, currency: true, createdAt: true,
} as const;

type Row = { id: string; createdAt: Date; entryDate: Date | null; changes: unknown };
const toEvent = <T extends Row>(row: T) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  entryDate: dayOrNull(row.entryDate),
  changes: row.changes as Change[],
});

// The cursor is the last event's time and id, so pages don't skip or repeat events written meanwhile.
const cursorOf = (row: { createdAt: Date; id: string }) => `${row.createdAt.toISOString()}_${row.id}`;
function readCursor(value: string | undefined) {
  if (!value) return null;
  const [time, id] = value.split("_");
  const t = Date.parse(time ?? "");
  return Number.isNaN(t) || !id ? null : { createdAt: new Date(t), id };
}

export const historyRoutes = new Hono<SignedIn>()
  .use(requireAdmin("see the history"))
  // Newest first, a page at a time (?before=<cursor from the last page>).
  .get("/", async (c) => {
    const filters = readFilters((k) => c.req.query(k));
    if ("error" in filters) return c.json(filters, 400);
    const cursor = readCursor(c.req.query("before"));
    const where = cursor
      ? { AND: [filters.where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] }
      : filters.where;
    const rows = await c.get("db").auditEvent.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
    });
    const page = rows.slice(0, PAGE);
    return c.json({ events: page.map(toEvent), next: rows.length > PAGE ? cursorOf(page[page.length - 1]!) : null });
  })
  // The same filters as a spreadsheet, newest first.
  .get("/export", async (c) => {
    const filters = readFilters((k) => c.req.query(k));
    if ("error" in filters) return c.json(filters, 400);
    const rows = await c.get("db").auditEvent.findMany({
      where: filters.where,
      select: SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EXPORT_LIMIT,
    });
    const lines = rows.flatMap((r) => {
      const changes = (r.changes as Change[]).length ? (r.changes as Change[]) : [null];
      return changes.map((ch) => [
        r.createdAt.toISOString(), r.actorName, r.kind, r.action, r.label,
        dayOrEmpty(r.entryDate), ch?.field ?? "", ch ? String(ch.from ?? "") : "", ch ? String(ch.to ?? "") : "", r.currency ?? "",
      ]);
    });
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="history.csv"');
    return c.body(toCsv([["Time (UTC)", "Person", "Kind", "Action", "What", "Date", "Field", "From", "To", "Currency"], ...lines]));
  });
