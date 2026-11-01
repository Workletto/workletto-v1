import { Hono } from "hono";
import { groupWhere } from "./groups.ts";
import type { OrgDb } from "./db.ts";
import { isUniqueViolation, readBody, requireManager, type SignedIn } from "./http.ts";
import { addDays, asDate, dayOf, formatDuration, isIsoDate, startOfWeek } from "../shared/time.ts";
import { capacityOff } from "./timeOff.ts";
import { recordAudit } from "./audit.ts";

// Scheduling (WRK-139): hours planned for each person on each project, a week at a time, set by
// admins and managers on the Team page's Schedule. A week's available hours are the person's
// usual hours less approved time off and company holidays (capacityOff). Planned hours are a
// guide: nothing stops anyone tracking more, or tracking on a project they weren't planned on.
// Stored in minutes; sent in seconds, like every other duration.

export const SCHEDULE_WEEKS = 6;
/** "Repeat for the next 3 weeks". */
export const REPEAT_WEEKS = 3;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_ROWS = 50;

const isWeekday = (day: string) => {
  const weekday = asDate(day).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};
const isMonday = (value: unknown): value is string => isIsoDate(value) && startOfWeek(value) === value;
const projectLabel = (p: { name: string; client: { name: string } | null }) => (p.client ? `${p.name} · ${p.client.name}` : p.name);
const PROJECT = { select: { id: true, name: true, client: { select: { name: true } } } } as const;

/** Each person's planned rows for the weeks from `from`, keyed by person, then week. */
async function plannedRows(db: OrgDb, from: string, weeks: number, userIds: string[]) {
  const rows = await db.scheduledWork.findMany({
    where: { userId: { in: userIds }, weekStart: { gte: asDate(from), lte: asDate(addDays(from, 7 * (weeks - 1))) }, minutes: { gt: 0 } },
    select: { userId: true, weekStart: true, minutes: true, project: PROJECT },
    orderBy: [{ project: { name: "asc" } }],
  });
  const byPerson = new Map<string, Map<string, { projectId: string; project: string; seconds: number }[]>>();
  for (const r of rows) {
    const weeksOf = byPerson.get(r.userId) ?? byPerson.set(r.userId, new Map()).get(r.userId)!;
    const week = dayOf(r.weekStart);
    (weeksOf.get(week) ?? weeksOf.set(week, []).get(week)!).push({ projectId: r.project.id, project: projectLabel(r.project), seconds: r.minutes * 60 });
  }
  return byPerson;
}

export const scheduleRoutes = new Hono<SignedIn>()
  // The grid: everyone whose account is on, by six weeks from `from` (a Monday). Each week has
  // the hours planned per project, the hours available, days off and holidays.
  .get("/", requireManager("see the schedule"), async (c) => {
    const db = c.get("db");
    const from = c.req.query("from");
    if (!isMonday(from)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const to = addDays(from, 7 * SCHEDULE_WEEKS - 1);
    const [people, holidays, projects] = await Promise.all([
      db.user.findMany({ where: { deactivatedAt: null, ...groupWhere(c) }, select: { id: true, name: true, weeklyCapacity: true }, orderBy: { name: "asc" } }),
      db.holiday.findMany({ where: { date: { gte: asDate(from), lte: asDate(to) } }, select: { date: true, name: true }, orderBy: { date: "asc" } }),
      db.project.findMany({ where: { archived: false }, select: PROJECT.select, orderBy: { name: "asc" } }),
    ]);
    const weeks = Array.from({ length: SCHEDULE_WEEKS }, (_, i) => addDays(from, 7 * i));
    const [planned, ...off] = await Promise.all([
      plannedRows(db, from, SCHEDULE_WEEKS, people.map((p) => p.id)),
      ...weeks.map((w) => capacityOff(db, w, addDays(w, 6), people)),
    ]);
    const weekdayHolidays = holidays.map((h) => ({ date: dayOf(h.date), name: h.name })).filter((h) => isWeekday(h.date));
    return c.json({
      from,
      weeks: weeks.map((week) => ({ week, holidays: weekdayHolidays.filter((h) => h.date >= week && h.date <= addDays(week, 6)) })),
      projects: projects.map((p) => ({ id: p.id, name: projectLabel(p) })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        weeklyCapacity: p.weeklyCapacity,
        weeks: weeks.map((week, i) => {
          const rows = planned.get(p.id)?.get(week) ?? [];
          const holidayDays = weekdayHolidays.filter((h) => h.date >= week && h.date <= addDays(week, 6)).length;
          const { days, seconds } = off[i]!.get(p.id)!;
          return {
            week,
            rows,
            planned: rows.reduce((sum, r) => sum + r.seconds, 0),
            available: Math.max(0, p.weeklyCapacity - seconds),
            // Their own time off, apart from the holidays everyone has.
            daysOff: days - holidayDays,
          };
        }),
      })),
    });
  })
  // Sets one person's plan for a week: the hours per project, replacing what was there. With
  // `repeat`, the next three weeks get the same plan.
  .put("/:userId/:week", requireManager("change the schedule"), async (c) => {
    const db = c.get("db");
    const week = c.req.param("week");
    if (!isMonday(week)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const person = await db.user.findFirst({ where: { id: c.req.param("userId"), deactivatedAt: null }, select: { id: true, name: true } });
    if (!person) return c.json({ error: "Choose someone on the team." }, 404);
    const body = await readBody(c);
    if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) return c.json({ error: `Plan up to ${MAX_ROWS} projects a week.` }, 400);
    const rows: { projectId: string; minutes: number }[] = [];
    for (const r of body.rows as { projectId?: unknown; minutes?: unknown }[]) {
      if (!r || typeof r.projectId !== "string" || !Number.isInteger(r.minutes) || (r.minutes as number) < 0 || (r.minutes as number) > MAX_MINUTES) {
        return c.json({ error: "Enter each project's hours, up to 168 a week." }, 400);
      }
      if (rows.some((x) => x.projectId === r.projectId)) return c.json({ error: "Each project can be in the week once." }, 400);
      if ((r.minutes as number) > 0) rows.push({ projectId: r.projectId, minutes: r.minutes as number });
    }
    const found = await db.project.findMany({ where: { id: { in: rows.map((r) => r.projectId) } }, select: { id: true } });
    if (found.length !== rows.length) return c.json({ error: "Choose a project from the list." }, 400);
    const repeat = body.repeat === true;
    const weeks = Array.from({ length: repeat ? 1 + REPEAT_WEEKS : 1 }, (_, i) => addDays(week, 7 * i));
    const total = rows.reduce((sum, r) => sum + r.minutes, 0);
    try {
      await db.$transaction(async (tx) => {
        await tx.scheduledWork.deleteMany({ where: { userId: person.id, weekStart: { in: weeks.map(asDate) } } });
        if (rows.length) {
          await tx.scheduledWork.createMany({ data: weeks.flatMap((w) => rows.map((r) => ({ userId: person.id, projectId: r.projectId, weekStart: asDate(w), minutes: r.minutes }))) as never }); // orgDb fills in organizationId
        }
        await recordAudit(tx as OrgDb, c.get("user"), {
          kind: "person", action: "changed", subjectId: person.id, label: person.name,
          changes: [{ field: "schedule", from: null, to: `${weeks.length === 1 ? `week of ${week}` : `weeks of ${week} to ${weeks.at(-1)}`}: ${formatDuration(total * 60)} on ${rows.length} ${rows.length === 1 ? "project" : "projects"}` }],
        });
      });
    } catch (error) {
      // Someone else saved the same week at the same moment.
      if (isUniqueViolation(error)) return c.json({ error: "That week was just changed. Look again and try once more." }, 409);
      throw error;
    }
    return c.json({ ok: true, weeks });
  })
  // Your own plan for a week, with what you've tracked on each project so far (the Time page).
  .get("/me", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const week = c.req.query("week");
    if (!isMonday(week)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const [planned, entries] = await Promise.all([
      plannedRows(db, week, 1, [user.id]),
      db.timeEntry.findMany({ where: { userId: user.id, date: { gte: asDate(week), lte: asDate(addDays(week, 6)) } }, select: { projectId: true, seconds: true, startedAt: true } }),
    ]);
    const now = Date.now();
    const tracked = new Map<string, number>();
    for (const e of entries) {
      // A running timer counts up to now, as on the Time screen.
      const seconds = e.seconds + (e.startedAt ? Math.max(0, Math.floor((now - e.startedAt.getTime()) / 1000)) : 0);
      tracked.set(e.projectId, (tracked.get(e.projectId) ?? 0) + seconds);
    }
    const rows = (planned.get(user.id)?.get(week) ?? []).map((r) => ({ ...r, tracked: tracked.get(r.projectId) ?? 0 }));
    return c.json({ week, rows });
  });
