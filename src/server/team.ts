import { Hono } from "hono";
import { groupWhere } from "./groups.ts";
import { requireManager, type SignedIn } from "./http.ts";
import { approvalsOn } from "./timesheets.ts";
import { addDays, asDate, isIsoDate, startOfWeek } from "../shared/time.ts";
import { capacityOff } from "./timeOff.ts";

// The Team page (admins and managers): for one week, each person's hours against the
// hours they usually work, less approved time off and company holidays (timeOff.ts), how
// many were billable, and where their timesheet stands.

export const teamRoutes = new Hono<SignedIn>().get("/", requireManager("see the team's hours"), async (c) => {
  const db = c.get("db");
  const week = c.req.query("week");
  if (!isIsoDate(week) || startOfWeek(week) !== week) return c.json({ error: "Choose a week by its Monday." }, 400);
  const dates = { gte: asDate(week), lte: asDate(addDays(week, 6)) };
  const [people, entries, sheets, approvals] = await Promise.all([
    // Everyone whose account is on, and anyone turned off who still has time that week.
    db.user.findMany({
      where: { OR: [{ deactivatedAt: null }, { timeEntries: { some: { date: dates } } }], ...groupWhere(c) },
      select: { id: true, name: true, role: true, weeklyCapacity: true, deactivatedAt: true },
      orderBy: { name: "asc" },
    }),
    db.timeEntry.findMany({ where: { date: dates }, select: { userId: true, seconds: true, startedAt: true, billable: true } }),
    db.timesheetWeek.findMany({ where: { weekStart: asDate(week) }, select: { userId: true, status: true } }),
    approvalsOn(db),
  ]);
  const now = Date.now();
  const hours = new Map<string, { seconds: number; billableSeconds: number }>();
  for (const e of entries) {
    // A running timer counts up to now, as on the Time screen.
    const seconds = e.seconds + (e.startedAt ? Math.max(0, Math.floor((now - e.startedAt.getTime()) / 1000)) : 0);
    const h = hours.get(e.userId) ?? hours.set(e.userId, { seconds: 0, billableSeconds: 0 }).get(e.userId)!;
    h.seconds += seconds;
    if (e.billable) h.billableSeconds += seconds;
  }
  const status = new Map(sheets.map((s) => [s.userId, s.status]));
  const off = await capacityOff(db, week, addDays(week, 6), people);
  return c.json({
    week,
    approvals,
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      active: p.deactivatedAt === null,
      weeklyCapacity: p.weeklyCapacity,
      // This week's capacity: their usual hours less the days off (time off and holidays).
      capacity: Math.max(0, p.weeklyCapacity - off.get(p.id)!.seconds),
      daysOff: off.get(p.id)!.days,
      ...(hours.get(p.id) ?? { seconds: 0, billableSeconds: 0 }),
      // "open" when approvals are on and the week hasn't been submitted.
      timesheet: approvals ? (status.get(p.id) ?? "open") : null,
    })),
  });
});
