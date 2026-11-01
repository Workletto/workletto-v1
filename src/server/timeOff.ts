import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isUniqueViolation, readBody, requireAdmin, requireManager, type SignedIn } from "./http.ts";
import { addDays, asDate, dayOf, isIsoDate } from "../shared/time.ts";
import { canManageWork } from "../shared/roles.ts";
import { recordAudit } from "./audit.ts";

// Time off and company holidays (WRK-138). A day off is one row per person per weekday, whole or
// half. Everyone adds their own; admins and managers can add anyone's. When the organization
// asks for approval (timeOffApproval), a member's own time off waits for an admin or manager.
// Approved time off and holidays take a day's share of a person's usual hours off their
// capacity (capacityOff, used by the Team page and scheduling).

const KINDS = ["vacation", "sick", "other"] as const;
const MAX_DAYS = 366;

const isWeekday = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

/** Every date from `from` to `to`, both included. */
function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let d = from; d <= to && days.length <= MAX_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

const SELECT = { id: true, userId: true, date: true, half: true, kind: true, note: true, status: true, user: { select: { name: true } } } as const;
type Row = { id: string; userId: string; date: Date; half: boolean; kind: string; note: string; status: string; user: { name: string } };
const toTimeOff = ({ user, date, ...row }: Row) => ({ ...row, date: dayOf(date), name: user.name });

/**
 * How much of each person's usual hours a period's days off take away, in seconds: a weekday off
 * is a fifth of their week, a half day a tenth, and a company holiday counts for everyone.
 * Only approved time off counts; a weekday that's both a holiday and someone's day off counts once.
 */
export async function capacityOff(db: OrgDb, from: string, to: string, people: { id: string; weeklyCapacity: number }[]) {
  const dates = { gte: asDate(from), lte: asDate(to) };
  const [off, holidays] = await Promise.all([
    db.timeOff.findMany({ where: { date: dates, status: "approved", userId: { in: people.map((p) => p.id) } }, select: { userId: true, date: true, half: true } }),
    db.holiday.findMany({ where: { date: dates }, select: { date: true } }),
  ]);
  const holidayDays = new Set(holidays.map((h) => dayOf(h.date)).filter(isWeekday));
  const days = new Map<string, number>(people.map((p) => [p.id, holidayDays.size]));
  for (const o of off) {
    if (holidayDays.has(dayOf(o.date))) continue;
    days.set(o.userId, (days.get(o.userId) ?? 0) + (o.half ? 0.5 : 1));
  }
  return new Map(people.map((p) => [p.id, { days: days.get(p.id) ?? 0, seconds: Math.round(((days.get(p.id) ?? 0) * p.weeklyCapacity) / 5) }]));
}

export const timeOffRoutes = new Hono<SignedIn>()
  // Time off from one date to another: your own, or everyone's for admins and managers, with the
  // company holidays and whether approval is needed.
  .get("/", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) return c.json({ error: "Choose a start and end date." }, 400);
    const dates = { gte: asDate(from), lte: asDate(to) };
    const [rows, holidays, org] = await Promise.all([
      db.timeOff.findMany({ where: { date: dates, ...(canManageWork(user.role) ? {} : { userId: user.id }) }, select: SELECT, orderBy: [{ date: "asc" }] }),
      db.holiday.findMany({ where: { date: dates }, select: { id: true, date: true, name: true }, orderBy: { date: "asc" } }),
      db.organization.findFirstOrThrow({ select: { timeOffApproval: true } }),
    ]);
    return c.json({
      timeOff: rows.map(toTimeOff),
      holidays: holidays.map((h) => ({ ...h, date: dayOf(h.date) })),
      approval: org.timeOffApproval,
    });
  })
  // Adds weekdays off, from one date to another (a half day only for a single day). Weekends,
  // company holidays and days already off are skipped.
  .post("/", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const body = await readBody(c);
    const manager = canManageWork(user.role);
    const userId = typeof body.userId === "string" && body.userId ? body.userId : user.id;
    if (userId !== user.id && !manager) return c.json({ error: "Only admins and managers can add time off for someone else." }, 403);
    const person = await db.user.findFirst({ where: { id: userId, deactivatedAt: null }, select: { id: true, name: true } });
    if (!person) return c.json({ error: "Choose someone on the team." }, 400);
    const { from, to } = body;
    if (!isIsoDate(from) || !isIsoDate(to)) return c.json({ error: "Choose the first and last day off." }, 400);
    if (from > to) return c.json({ error: "The last day off is before the first. Choose the dates again." }, 400);
    if (daysBetween(from, to).length > MAX_DAYS) return c.json({ error: "Add up to a year of time off at once." }, 400);
    const half = body.half === true;
    if (half && from !== to) return c.json({ error: "A half day is one day: choose the same first and last day." }, 400);
    if (!KINDS.includes(body.kind as (typeof KINDS)[number])) return c.json({ error: "Choose vacation, sick or other." }, 400);
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 200) return c.json({ error: "Keep the note to 200 characters." }, 400);

    const [holidays, taken, org] = await Promise.all([
      db.holiday.findMany({ where: { date: { gte: asDate(from), lte: asDate(to) } }, select: { date: true } }),
      db.timeOff.findMany({ where: { userId, date: { gte: asDate(from), lte: asDate(to) } }, select: { date: true } }),
      db.organization.findFirstOrThrow({ select: { timeOffApproval: true } }),
    ]);
    const skip = new Set([...holidays, ...taken].map((r) => dayOf(r.date)));
    const days = daysBetween(from, to).filter((d) => isWeekday(d) && !skip.has(d));
    if (!days.length) return c.json({ error: "Those days are already off, or they're weekends or company holidays." }, 409);
    // A member's own time off waits for approval when the organization asks for it.
    const status = org.timeOffApproval && !manager ? "pending" : "approved";
    try {
      await db.$transaction(async (tx) => {
        await tx.timeOff.createMany({ data: days.map((d) => ({ userId, date: asDate(d), half, kind: body.kind, note, status })) as never }); // orgDb fills in organizationId
        await recordAudit(tx as OrgDb, user, {
          kind: "person", action: "changed", subjectId: person.id, label: person.name,
          changes: [{ field: "timeOff", from: null, to: `${from === to ? from : `${from} to ${to}`} (${days.length === 1 && half ? "half day" : `${days.length} ${days.length === 1 ? "day" : "days"}`}, ${body.kind}${status === "pending" ? ", waiting for approval" : ""})` }],
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: "Some of those days were just added. Look again and try once more." }, 409);
      throw error;
    }
    return c.json({ added: days.length, status }, 201);
  })
  // Takes a day off away: your own, or anyone's for admins and managers.
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const row = await db.timeOff.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
    if (!row || (row.userId !== user.id && !canManageWork(user.role))) return c.json({ error: "Time off not found." }, 404);
    await db.$transaction(async (tx) => {
      await tx.timeOff.deleteMany({ where: { id: row.id } });
      await recordAudit(tx as OrgDb, user, { kind: "person", action: "changed", subjectId: row.userId, label: row.user.name, changes: [{ field: "timeOff", from: `${dayOf(row.date)} (${row.kind})`, to: null }] });
    });
    return c.json({ ok: true });
  })
  // Approves time off waiting for it, or turns it down (which removes it).
  .post("/:id/:decision", requireManager("approve time off"), async (c) => {
    const decision = c.req.param("decision");
    if (decision !== "approve" && decision !== "decline") return c.json({ error: "Approve or decline." }, 404);
    const db = c.get("db");
    const row = await db.timeOff.findFirst({ where: { id: c.req.param("id"), status: "pending" }, select: SELECT });
    if (!row) return c.json({ error: "That time off isn't waiting for approval any more." }, 409);
    await db.$transaction(async (tx) => {
      if (decision === "approve") await tx.timeOff.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "approved" } });
      else await tx.timeOff.deleteMany({ where: { id: row.id, status: "pending" } });
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "person", action: "changed", subjectId: row.userId, label: row.user.name, changes: [{ field: "timeOff", from: `${dayOf(row.date)} (waiting)`, to: decision === "approve" ? `${dayOf(row.date)} (approved)` : null }] });
    });
    return c.json({ ok: true });
  });

// Company holidays and whether members' time off needs approval (admins).
export const timeOffSettingsRoutes = new Hono<SignedIn>()
  .use(requireAdmin("change time off settings"))
  .put("/", async (c) => {
    const body = await readBody(c);
    if (typeof body.approval !== "boolean") return c.json({ error: "approval must be true or false." }, 400);
    const db = c.get("db");
    const before = await db.organization.findFirstOrThrow({ select: { timeOffApproval: true } });
    await db.organization.updateMany({ data: { timeOffApproval: body.approval } });
    if (before.timeOffApproval !== body.approval) {
      await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Time off", changes: [{ field: "timeOffApproval", from: before.timeOffApproval, to: body.approval }] });
    }
    return c.json({ approval: body.approval });
  })
  .post("/holidays", async (c) => {
    const body = await readBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isIsoDate(body.date)) return c.json({ error: "Choose the holiday's date." }, 400);
    if (!name || name.length > 100) return c.json({ error: "Name the holiday, like New Year's Day (up to 100 characters)." }, 400);
    try {
      const holiday = await c.get("db").holiday.create({ data: { date: asDate(body.date), name } as never, select: { id: true, date: true, name: true } });
      await recordAudit(c.get("db"), c.get("user"), { kind: "settings", action: "changed", label: "Company holidays", changes: [{ field: "holiday", from: null, to: `${body.date} ${name}` }] });
      return c.json({ holiday: { ...holiday, date: dayOf(holiday.date) } }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: "There's already a holiday on that day." }, 409);
      throw error;
    }
  })
  .delete("/holidays/:id", async (c) => {
    const db = c.get("db");
    const holiday = await db.holiday.findFirst({ where: { id: c.req.param("id") }, select: { id: true, date: true, name: true } });
    if (!holiday) return c.json({ error: "Holiday not found." }, 404);
    await db.holiday.deleteMany({ where: { id: holiday.id } });
    await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Company holidays", changes: [{ field: "holiday", from: `${dayOf(holiday.date)} ${holiday.name}`, to: null }] });
    return c.json({ ok: true });
  });
