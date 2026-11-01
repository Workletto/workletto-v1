import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isUniqueViolation, readBody, readRange, type SignedIn } from "./http.ts";
import { projectsFor } from "./billing.ts";
import { asDate, dayOf, isIsoDate, MAX_ENTRY_SECONDS } from "../shared/time.ts";
import { diff, projectLabel, recordAudit, snapshot, type Actor } from "./audit.ts";
import { checkBudgets } from "./budget.ts";
import { assertWeeksOpen, lockedOr, WeekLocked } from "./timesheets.ts";
import { readCustomFields, saveCustomFields } from "./customFields.ts";

// Everyone tracks their own time: a running timer or entries typed in by hand.
// Every query here is limited to the signed-in person's own entries.

const SELECT = {
  id: true,
  date: true,
  seconds: true,
  startedAt: true,
  notes: true,
  billable: true,
  project: { select: { id: true, name: true, archived: true, client: { select: { id: true, name: true } } } },
  task: { select: { id: true, title: true } },
  invoiceLine: { select: { invoice: { select: { id: true, number: true } } } },
  // Custom fields in use (WRK-148).
  customValues: { where: { field: { archivedAt: null } }, select: { fieldId: true, value: true } },
} as const;

type Row = { date: Date; startedAt: Date | null; invoiceLine: { invoice: { id: string; number: string } } | null; customValues: { fieldId: string; value: string }[] };
// Dates are stored as Postgres DATE, which arrives as midnight UTC.
const toEntry = <T extends Row>({ invoiceLine, customValues, ...row }: T) => ({
  ...row,
  customFields: Object.fromEntries(customValues.map((v) => [v.fieldId, v.value])),
  date: dayOf(row.date),
  startedAt: row.startedAt?.toISOString() ?? null,
  invoice: invoiceLine?.invoice ?? null,
});
// What the history records about an entry.
const AUDITED = ["project", "task", "date", "seconds", "notes", "billable"] as const;
const audited = (row: { project: { name: string; client: { name: string } | null }; task: { title: string } | null; date: Date; seconds: number; notes: string; billable: boolean }) => ({
  project: projectLabel(row.project), task: row.task?.title ?? null, date: row.date, seconds: row.seconds, notes: row.notes, billable: row.billable,
});
const auditEvent = (row: Parameters<typeof audited>[0] & { id: string }) => ({ kind: "time" as const, subjectId: row.id, label: projectLabel(row.project), entryDate: row.date });

const invoicedError = (number: string) => ({ error: `This time is on invoice ${number}. Take it off the invoice to change it.` });
/** Put on an invoice between reading the entry and changing it. */
class Invoiced extends Error {}
const JUST_INVOICED = { error: "This time was just put on an invoice. Take it off the invoice to change it." };
const invoicedOr = (error: unknown) => {
  if (error instanceof Invoiced) return error;
  return lockedOr(error);
};

const MAX_RANGE_DAYS = 62;
const DATE_ERROR = "Choose a valid date.";
const SECONDS_ERROR = "Enter a duration between 0:00 and 24:00.";
const NOTES_ERROR = "Notes can be up to 2,000 characters.";
const PROJECT_ERROR = "Choose an active project.";

const isSeconds = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_ENTRY_SECONDS;
const isNotes = (v: unknown): v is string => typeof v === "string" && v.length <= 2000;

/** A project the person may track time on right now: active, and open to them. */
async function activeProject(db: OrgDb, user: { id: string; role: string }, id: unknown) {
  if (typeof id !== "string") return null;
  return db.project.findFirst({ where: { AND: [{ id, archived: false }, projectsFor(user)] }, select: { id: true, billable: true } });
}

/** The task id to store for an entry on this project: null for none, or an error. */
async function readTaskId(db: OrgDb, projectId: string, value: unknown): Promise<string | null | { error: string }> {
  if (value === undefined || value === null || value === "") return null;
  const task = typeof value === "string" ? await db.task.findFirst({ where: { id: value, projectId }, select: { id: true } }) : null;
  return task ? task.id : { error: "Choose a task on this project, or no task." };
}

export type NewEntry = { projectId: unknown; taskId: unknown; date: unknown; seconds: unknown; notes: unknown; calendarEventId: string };

/**
 * Calendar import (WRK-105): adds the signed-in person's entries, all or none, each checked like
 * one added by hand. Events already imported are left out. Returns how many were added.
 */
export async function addEntries(db: OrgDb, user: Actor & { id: string; role: string }, rows: NewEntry[]): Promise<{ added: number; alreadyImported: number } | { error: string; status: 400 | 409 }> {
  const already = new Set(
    (await db.timeEntry.findMany({ where: { userId: user.id, calendarEventId: { in: rows.map((r) => r.calendarEventId) } }, select: { calendarEventId: true } })).map((r) => r.calendarEventId),
  );
  const data: { userId: string; projectId: string; taskId: string | null; date: Date; seconds: number; notes: string; billable: boolean; calendarEventId: string }[] = [];
  for (const row of rows.filter((r) => !already.has(r.calendarEventId))) {
    const project = await activeProject(db, user, row.projectId);
    if (!project) return { error: PROJECT_ERROR, status: 400 };
    if (!isIsoDate(row.date)) return { error: DATE_ERROR, status: 400 };
    if (!isSeconds(row.seconds)) return { error: SECONDS_ERROR, status: 400 };
    if (!isNotes(row.notes)) return { error: NOTES_ERROR, status: 400 };
    const taskId = await readTaskId(db, project.id, row.taskId);
    if (typeof taskId === "object" && taskId) return { ...taskId, status: 400 };
    data.push({ userId: user.id, projectId: project.id, taskId, date: asDate(row.date), seconds: row.seconds, notes: row.notes.trim(), billable: project.billable, calendarEventId: row.calendarEventId });
  }
  const outcome = await db.$transaction(async (tx) => {
    await assertWeeksOpen(tx as OrgDb, user.id, data.map((d) => d.date));
    for (const entry of data) {
      const created = await tx.timeEntry.create({ data: entry as typeof entry & { organizationId: string }, select: SELECT });
      await recordAudit(tx as OrgDb, user, { ...auditEvent(created), action: "created", changes: [...snapshot(audited(created), AUDITED), { field: "note", from: null, to: "Imported from a calendar." }] });
    }
    return data.length;
  }).catch((error: unknown) => (isUniqueViolation(error) ? ("taken" as const) : lockedOr(error)));
  if (outcome === "taken") return { error: "Some of these events were just imported. Load the week again.", status: 409 };
  if (outcome instanceof WeekLocked) return { error: outcome.message, status: 409 };
  await checkBudgets(db, [...new Set(data.map((d) => d.projectId))], true);
  return { added: outcome, alreadyImported: rows.length - data.length };
}

/** Stops the person's running timer, if any, adding the time it ran. */
export async function stopRunning(db: OrgDb, userId: string, now = new Date()) {
  const running = await db.timeEntry.findFirst({ where: { userId, startedAt: { not: null } } });
  if (!running?.startedAt) return null;
  const ran = Math.max(0, Math.round((now.getTime() - running.startedAt.getTime()) / 1000));
  // Only if it's still the same run, so two stops at once can't both add time. A timer
  // forgotten over a weekend stops at a day's worth, the most one entry can hold.
  await db.timeEntry.updateMany({
    where: { id: running.id, startedAt: running.startedAt },
    data: { seconds: Math.min(running.seconds + ran, MAX_ENTRY_SECONDS), startedAt: null },
  });
  return { id: running.id, projectId: running.projectId };
}

export const timeEntryRoutes = new Hono<SignedIn>()
  // Your entries from one date to another, both included.
  .get("/", async (c) => {
    const range = readRange(c, MAX_RANGE_DAYS, `Choose a date range of up to ${MAX_RANGE_DAYS} days.`);
    if (range instanceof Response) return range;
    const { from, to } = range;
    const rows = await c.get("db").timeEntry.findMany({
      where: { userId: c.get("user").id, date: { gte: asDate(from), lte: asDate(to) } },
      select: SELECT,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });
    return c.json({ entries: rows.map(toEntry) });
  })
  // A finished entry typed in by hand. Billable follows the project unless chosen.
  .post("/", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const project = await activeProject(db, c.get("user"), body.projectId);
    if (!project) return c.json({ error: PROJECT_ERROR }, 400);
    if (!isIsoDate(body.date)) return c.json({ error: DATE_ERROR }, 400);
    if (!isSeconds(body.seconds)) return c.json({ error: SECONDS_ERROR }, 400);
    const notes = body.notes ?? "";
    if (!isNotes(notes)) return c.json({ error: NOTES_ERROR }, 400);
    if (body.billable !== undefined && typeof body.billable !== "boolean") return c.json({ error: "Billable must be true or false." }, 400);

    const taskId = await readTaskId(db, project.id, body.taskId);
    if (typeof taskId === "object" && taskId) return c.json(taskId, 400);
    const fields = await readCustomFields(db, "time", body, true);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    const data = {
      userId: c.get("user").id,
      projectId: project.id,
      taskId,
      date: asDate(body.date),
      seconds: body.seconds,
      notes: notes.trim(),
      billable: body.billable ?? project.billable,
    };
    const row = await db.$transaction(async (tx) => {
      await assertWeeksOpen(tx as OrgDb, data.userId, [data.date]);
      const created = await tx.timeEntry.create({
        data: data as typeof data & { organizationId: string }, // orgDb fills in organizationId
        select: { id: true },
      });
      await saveCustomFields(tx as OrgDb, "time", created.id, fields);
      const row = await tx.timeEntry.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(row), action: "created", changes: snapshot(audited(row), AUDITED) });
      return row;
    }).catch(lockedOr);
    if (row instanceof WeekLocked) return c.json({ error: row.message }, 409);
    await checkBudgets(db, [row.project.id], true);
    return c.json({ entry: toEntry(row) }, 201);
  })
  .patch("/:id", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const userId = c.get("user").id;
    const entry = await db.timeEntry.findFirst({
      where: { id: c.req.param("id"), userId },
      select: { ...SELECT, projectId: true },
    });
    if (!entry) return c.json({ error: "Entry not found." }, 404);
    if (entry.invoiceLine) return c.json(invoicedError(entry.invoiceLine.invoice.number), 409);

    const data: { projectId?: string; taskId?: string | null; date?: Date; seconds?: number; startedAt?: Date; notes?: string; billable?: boolean } = {};
    if ("projectId" in body && body.projectId !== entry.projectId) {
      const project = await activeProject(db, c.get("user"), body.projectId);
      if (!project) return c.json({ error: PROJECT_ERROR }, 400);
      data.projectId = project.id;
      data.billable = project.billable; // the new project's default, unless chosen below
      data.taskId = null; // tasks belong to one project
    }
    if ("taskId" in body) {
      const taskId = await readTaskId(db, data.projectId ?? entry.projectId, body.taskId);
      if (typeof taskId === "object" && taskId) return c.json(taskId, 400);
      data.taskId = taskId;
    }
    if ("date" in body) {
      if (!isIsoDate(body.date)) return c.json({ error: DATE_ERROR }, 400);
      data.date = asDate(body.date);
    }
    if ("seconds" in body) {
      if (!isSeconds(body.seconds)) return c.json({ error: SECONDS_ERROR }, 400);
      data.seconds = body.seconds;
      // A running timer carries on from the new duration.
      if (entry.startedAt) data.startedAt = new Date();
    }
    if ("notes" in body) {
      if (!isNotes(body.notes)) return c.json({ error: NOTES_ERROR }, 400);
      data.notes = body.notes.trim();
    }
    if ("billable" in body) {
      if (typeof body.billable !== "boolean") return c.json({ error: "Billable must be true or false." }, 400);
      data.billable = body.billable;
    }
    const fields = await readCustomFields(db, "time", body, false);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    const row = await db.$transaction(async (tx) => {
      await assertWeeksOpen(tx as OrgDb, userId, [entry.date, data.date ?? entry.date]);
      const { count } = await tx.timeEntry.updateMany({ where: { id: entry.id, invoiceLineId: null }, data });
      if (!count) throw new Invoiced();
      await saveCustomFields(tx as OrgDb, "time", entry.id, fields);
      const updated = await tx.timeEntry.findFirstOrThrow({ where: { id: entry.id }, select: SELECT });
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(updated), action: "changed", changes: diff(audited(entry), audited(updated), AUDITED) });
      return updated;
    }).catch(invoicedOr);
    if (row instanceof Invoiced) return c.json(JUST_INVOICED, 409);
    if (row instanceof WeekLocked) return c.json({ error: row.message }, 409);
    await checkBudgets(db, [entry.projectId, row.project.id], true);
    return c.json({ entry: toEntry(row) });
  })
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const entry = await db.timeEntry.findFirst({ where: { id: c.req.param("id"), userId: c.get("user").id }, select: SELECT });
    if (!entry) return c.json({ error: "Entry not found." }, 404);
    if (entry.invoiceLine) return c.json(invoicedError(entry.invoiceLine.invoice.number), 409);
    const done = await db.$transaction(async (tx) => {
      await assertWeeksOpen(tx as OrgDb, c.get("user").id, [entry.date]);
      const { count } = await tx.timeEntry.deleteMany({ where: { id: entry.id, invoiceLineId: null } });
      if (count) await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(entry), action: "deleted", changes: snapshot(audited(entry), AUDITED, true) });
      else if (await tx.timeEntry.count({ where: { id: entry.id } })) throw new Invoiced();
    }).catch(invoicedOr);
    if (done instanceof Invoiced) return c.json(JUST_INVOICED, 409);
    if (done instanceof WeekLocked) return c.json({ error: done.message }, 409);
    await checkBudgets(db, [entry.project.id], true);
    return c.json({ ok: true });
  });

export const timerRoutes = new Hono<SignedIn>()
  // Your running timer, or null.
  .get("/", async (c) => {
    const row = await c.get("db").timeEntry.findFirst({
      where: { userId: c.get("user").id, startedAt: { not: null } },
      select: SELECT,
    });
    return c.json({ entry: row ? toEntry(row) : null });
  })
  // Starts a timer: on a new entry ({ projectId, date, notes?, billable? }) or by
  // carrying on an existing one ({ entryId }). Any other running timer stops first.
  .post("/start", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const userId = c.get("user").id;

    let existing: { id: string; date: Date } | null = null;
    let fresh: { projectId: string; taskId: string | null; date: Date; notes: string; billable: boolean } | null = null;
    let fields = new Map<string, string | null>();
    if (body.entryId !== undefined) {
      existing = await db.timeEntry.findFirst({
        where: { id: typeof body.entryId === "string" ? body.entryId : "", userId, invoiceLineId: null, project: { archived: false, ...projectsFor(c.get("user")) } },
        select: { id: true, date: true },
      });
      if (!existing) return c.json({ error: "That entry can't be restarted. Its project may be archived, or it's on an invoice." }, 404);
    } else {
      const project = await activeProject(db, c.get("user"), body.projectId);
      if (!project) return c.json({ error: PROJECT_ERROR }, 400);
      if (!isIsoDate(body.date)) return c.json({ error: DATE_ERROR }, 400);
      const notes = body.notes ?? "";
      if (!isNotes(notes)) return c.json({ error: NOTES_ERROR }, 400);
      if (body.billable !== undefined && typeof body.billable !== "boolean") return c.json({ error: "Billable must be true or false." }, 400);
      const taskId = await readTaskId(db, project.id, body.taskId);
      if (typeof taskId === "object" && taskId) return c.json(taskId, 400);
      const read = await readCustomFields(db, "time", body, true);
      if (!(read instanceof Map)) return c.json(read, 400);
      fields = read;
      fresh = { projectId: project.id, taskId, date: asDate(body.date), notes: notes.trim(), billable: body.billable ?? project.billable };
    }

    try {
      let stopped: { projectId: string } | null = null;
      const row = await db.$transaction(async (tx) => {
        await assertWeeksOpen(tx as OrgDb, userId, [(existing ?? fresh)!.date]);
        const now = new Date();
        stopped = await stopRunning(tx as OrgDb, userId, now);
        if (existing) {
          const { count } = await tx.timeEntry.updateMany({ where: { id: existing.id, invoiceLineId: null }, data: { startedAt: now } });
          if (!count) throw new Invoiced();
          return tx.timeEntry.findFirstOrThrow({ where: { id: existing.id }, select: SELECT });
        }
        const data = { ...fresh!, userId, startedAt: now };
        const created = await tx.timeEntry.create({ data: data as typeof data & { organizationId: string }, select: { id: true } });
        await saveCustomFields(tx as OrgDb, "time", created.id, fields);
        return tx.timeEntry.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
      });
      if (stopped) await checkBudgets(db, [(stopped as { projectId: string }).projectId], true);
      return c.json({ entry: toEntry(row) }, 201);
    } catch (error) {
      if (error instanceof WeekLocked) return c.json({ error: error.message }, 409);
      if (error instanceof Invoiced) return c.json(JUST_INVOICED, 409);
      // The database allows one running timer per person; another request won the race.
      if (isUniqueViolation(error)) return c.json({ error: "Another timer just started. Refresh and try again." }, 409);
      throw error;
    }
  })
  .post("/stop", async (c) => {
    const db = c.get("db");
    const stopped = await stopRunning(db, c.get("user").id);
    if (!stopped) return c.json({ entry: null });
    await checkBudgets(db, [stopped.projectId], true);
    return c.json({ entry: toEntry(await db.timeEntry.findFirstOrThrow({ where: { id: stopped.id }, select: SELECT })) });
  });
