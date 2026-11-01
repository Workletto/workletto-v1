import { Hono } from "hono";
import { groupWhere } from "./groups.ts";
import { orgDb, prisma, type OrgDb } from "./db.ts";
import { requireAdmin, requireManager, readBody, type SignedIn } from "./http.ts";
import { recordAudit, type Actor } from "./audit.ts";
import { env } from "./env.ts";
import { escapeHtml, isEmailConfigured, sendMail } from "./mail.ts";
import { PLACEHOLDER_DOMAIN } from "./people.ts";
import { addDays, asDate, dayOf, isIsoDate, longDay, startOfWeek } from "../shared/time.ts";
import { describeError } from "./logging.ts";

// Timesheet approvals, when an admin turns them on (Manage → Timesheets).
// Each week (Monday to Sunday) is open until its person submits it. A manager
// or admin then approves or rejects it; nobody decides on their own week.
// Submitted and approved weeks are locked; reopening one makes it open again.
// Every Monday from 9:00 in the organization's time zone, people whose last
// week is still open (or rejected) get a reminder by email, if email is on,
// and see one on the Time screen.

const isMonday = (date: unknown): date is string => isIsoDate(date) && startOfWeek(date) === date;

const WEEK = {
  weekStart: true, status: true, submittedAt: true, decidedAt: true, decidedByName: true, note: true,
} as const;
type WeekRow = { weekStart: Date; status: string; submittedAt: Date; decidedAt: Date | null; decidedByName: string | null; note: string };
const toWeek = (w: WeekRow) => ({ ...w, weekStart: dayOf(w.weekStart), submittedAt: w.submittedAt.toISOString(), decidedAt: w.decidedAt?.toISOString() ?? null });

export async function approvalsOn(db: OrgDb) {
  return (await db.organization.findFirstOrThrow({ select: { timesheetApprovals: true } })).timesheetApprovals;
}

/**
 * Why time on these dates can't change right now, or null if it can: the week is
 * submitted or approved while approvals are on.
 */
export async function lockedWeekError(db: OrgDb, userId: string, dates: (Date | string)[]) {
  const weeks = [...new Set(dates.map((d) => startOfWeek(typeof d === "string" ? d : dayOf(d))))];
  if (!weeks.length || !(await approvalsOn(db))) return null;
  const locked = await db.timesheetWeek.findFirst({
    where: { userId, weekStart: { in: weeks.map(asDate) }, status: { in: ["submitted", "approved"] } },
    select: { status: true },
  });
  if (!locked) return null;
  return locked.status === "approved"
    ? "This week is approved. Ask a manager to reopen it to make changes."
    : "This week is submitted for approval. Withdraw it to make changes.";
}

export class WeekLocked extends Error {}

/**
 * Inside a transaction that changes someone's time: waits for any submit of their weeks
 * to finish (and holds off new ones until this commits), then throws WeekLocked if any of
 * these dates is in a locked week. Without the wait, an edit checked just before a submit
 * could still land in the submitted week.
 */
export async function assertWeeksOpen(tx: OrgDb, userId: string, dates: (Date | string)[]) {
  await holdPerson(tx, userId);
  const error = await lockedWeekError(tx, userId, dates);
  if (error) throw new WeekLocked(error);
}

/** For `.catch()` on a transaction: a WeekLocked comes back as a value, anything else is thrown on. */
export function lockedOr(error: unknown): WeekLocked {
  if (error instanceof WeekLocked) return error;
  throw error;
}

const holdPerson = (tx: OrgDb, userId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`timesheet:${userId}`}))`;

/** Records a week moving from one status to another (null = open). */
async function recordWeek(db: OrgDb, actor: Actor, person: { id: string; name: string }, weekStart: string, from: string | null, to: string | null, note = "") {
  const changes = [{ field: "status", from, to }, ...(note ? [{ field: "note", from: null, to: note }] : [])];
  await recordAudit(db, actor, { kind: "timesheet", action: "changed", subjectId: person.id, label: person.name, entryDate: asDate(weekStart), changes });
}

/** Total time per person for weeks starting on these Mondays. Keyed by "userId|weekStart". */
async function weekTotals(db: OrgDb, weeks: { userId: string; weekStart: string }[]) {
  const totals = new Map<string, { seconds: number; billableSeconds: number }>();
  if (!weeks.length) return totals;
  const starts = [...new Set(weeks.map((w) => w.weekStart))].sort();
  const rows = await db.timeEntry.findMany({
    where: { userId: { in: [...new Set(weeks.map((w) => w.userId))] }, date: { gte: asDate(starts[0]!), lte: asDate(addDays(starts[starts.length - 1]!, 6)) } },
    select: { userId: true, date: true, seconds: true, billable: true },
  });
  for (const r of rows) {
    const key = `${r.userId}|${startOfWeek(dayOf(r.date))}`;
    const t = totals.get(key) ?? totals.set(key, { seconds: 0, billableSeconds: 0 }).get(key)!;
    t.seconds += r.seconds;
    if (r.billable) t.billableSeconds += r.seconds;
  }
  return totals;
}

export const timesheetRoutes = new Hono<SignedIn>()
  // Your own weeks from one Monday to another: [{ weekStart, status, ... }] for those that aren't open.
  .get("/mine", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!isMonday(from) || !isMonday(to) || to < from) return c.json({ error: "Choose weeks by their Mondays." }, 400);
    const rows = await c.get("db").timesheetWeek.findMany({
      where: { userId: c.get("user").id, weekStart: { gte: asDate(from), lte: asDate(to) } },
      select: WEEK,
      orderBy: { weekStart: "asc" },
    });
    return c.json({ approvals: await approvalsOn(c.get("db")), weeks: rows.map(toWeek) });
  })
  // Submits your week. A rejected week can be submitted again.
  .post("/mine/:weekStart/submit", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const weekStart = c.req.param("weekStart");
    if (!(await approvalsOn(db))) return c.json({ error: "Timesheet approvals are turned off." }, 409);
    if (!isMonday(weekStart)) return c.json({ error: "Choose a week by its Monday." }, 400);
    // A day of leeway for time zones ahead of the server.
    if (weekStart > startOfWeek(addDays(dayOf(new Date()), 1))) return c.json({ error: "You can't submit a week that hasn't started." }, 400);
    const week = await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      await holdPerson(t, user.id);
      const running = await t.timeEntry.findFirst({
        where: { userId: user.id, startedAt: { not: null }, date: { gte: asDate(weekStart), lte: asDate(addDays(weekStart, 6)) } },
        select: { id: true },
      });
      if (running) return "Stop your timer before you submit this week.";
      const current = await t.timesheetWeek.findFirst({ where: { userId: user.id, weekStart: asDate(weekStart) }, select: { id: true, status: true } });
      if (current?.status === "submitted") return "This week is already submitted.";
      if (current?.status === "approved") return "This week is already approved.";
      const data = { status: "submitted" as const, submittedAt: new Date(), decidedAt: null, decidedById: null, decidedByName: null, note: "" };
      const row = current
        ? await t.timesheetWeek.update({ where: { id: current.id }, data, select: WEEK })
        : await t.timesheetWeek.create({ data: { ...data, userId: user.id, weekStart: asDate(weekStart) } as typeof data & { userId: string; weekStart: Date; organizationId: string }, select: WEEK });
      await recordWeek(t, user, user, weekStart, current?.status ?? null, "submitted");
      return row;
    });
    if (typeof week === "string") return c.json({ error: week }, 409);
    return c.json({ week: toWeek(week) });
  })
  // Takes back a week you submitted, before anyone approves it.
  .post("/mine/:weekStart/withdraw", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const weekStart = c.req.param("weekStart");
    if (!isMonday(weekStart)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const done = await db.$transaction(async (tx) => {
      const { count } = await tx.timesheetWeek.deleteMany({ where: { userId: user.id, weekStart: asDate(weekStart), status: "submitted" } });
      if (count) await recordWeek(tx as OrgDb, user, user, weekStart, "submitted", null);
      return count > 0;
    });
    if (!done) return c.json({ error: "Only a submitted week can be withdrawn. Ask a manager to reopen an approved one." }, 409);
    return c.json({ ok: true });
  })
  // For managers: weeks waiting for a decision (?status=submitted, the default), or decided ones;
  // all weeks, or one (?week=Monday).
  .get("/", requireManager("approve timesheets"), async (c) => {
    const db = c.get("db");
    const status = c.req.query("status") ?? "submitted";
    if (status !== "submitted" && status !== "approved" && status !== "rejected") return c.json({ error: "Choose submitted, approved or rejected." }, 400);
    const week = c.req.query("week");
    if (week !== undefined && !isMonday(week)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const rows = await db.timesheetWeek.findMany({
      where: { status, ...(week ? { weekStart: asDate(week) } : {}), ...(c.req.query("groupId") ? { user: groupWhere(c) } : {}) },
      select: { ...WEEK, user: { select: { id: true, name: true } } },
      orderBy: [{ weekStart: status === "submitted" ? "asc" : "desc" }, { user: { name: "asc" } }],
      take: 200,
    });
    const totals = await weekTotals(db, rows.map((r) => ({ userId: r.user.id, weekStart: dayOf(r.weekStart) })));
    return c.json({
      weeks: rows.map((r) => ({ ...toWeek(r), person: r.user, ...(totals.get(`${r.user.id}|${dayOf(r.weekStart)}`) ?? { seconds: 0, billableSeconds: 0 }) })),
    });
  })
  // For managers: one person's week, with its entries.
  .get("/:userId/:weekStart", requireManager("approve timesheets"), async (c) => {
    const db = c.get("db");
    const weekStart = c.req.param("weekStart");
    if (!isMonday(weekStart)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const person = await db.user.findFirst({ where: { id: c.req.param("userId") }, select: { id: true, name: true } });
    if (!person) return c.json({ error: "Person not found." }, 404);
    const [week, entries] = await Promise.all([
      db.timesheetWeek.findFirst({ where: { userId: person.id, weekStart: asDate(weekStart) }, select: WEEK }),
      db.timeEntry.findMany({
        where: { userId: person.id, date: { gte: asDate(weekStart), lte: asDate(addDays(weekStart, 6)) } },
        select: { id: true, date: true, seconds: true, notes: true, billable: true, startedAt: true, project: { select: { id: true, name: true, client: { select: { name: true } } } }, task: { select: { title: true } } },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    return c.json({
      person,
      week: week ? toWeek(week) : null,
      entries: entries.map((e) => ({ ...e, date: dayOf(e.date), startedAt: e.startedAt?.toISOString() ?? null })),
    });
  })
  // Approves many submitted weeks at once: { weeks: [{ userId, weekStart }] }, up to 200.
  // Your own weeks, and weeks no longer waiting for a decision, are skipped.
  .post("/approve", requireManager("approve timesheets"), async (c) => {
    const db = c.get("db");
    const actor = c.get("user");
    const body = await readBody(c);
    if (!Array.isArray(body.weeks) || !body.weeks.length || body.weeks.length > 200) return c.json({ error: "Choose from 1 to 200 weeks to approve." }, 400);
    const wanted = new Map<string, { userId: string; weekStart: string }>();
    for (const w of body.weeks as unknown[]) {
      const { userId, weekStart } = (w ?? {}) as Record<string, unknown>;
      if (typeof userId !== "string" || !isMonday(weekStart)) return c.json({ error: "Choose each week by its person and Monday." }, 400);
      wanted.set(`${userId}|${weekStart}`, { userId, weekStart });
    }
    const approved = await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      const rows = await t.timesheetWeek.findMany({
        where: { status: "submitted", userId: { not: actor.id }, OR: [...wanted.values()].map((w) => ({ userId: w.userId, weekStart: asDate(w.weekStart) })) },
        select: { id: true, weekStart: true, user: { select: { id: true, name: true } } },
      });
      let done = 0;
      for (const r of rows) {
        // Still submitted: the person may have withdrawn it a moment ago.
        const { count } = await t.timesheetWeek.updateMany({
          where: { id: r.id, status: "submitted" },
          data: { status: "approved", decidedAt: new Date(), decidedById: actor.id, decidedByName: actor.name, note: "" },
        });
        if (!count) continue;
        await recordWeek(t, actor, r.user, dayOf(r.weekStart), "submitted", "approved");
        done++;
      }
      return done;
    });
    return c.json({ approved, skipped: wanted.size - approved });
  })
  // Approve, reject ({ note }) or reopen someone else's week.
  .post("/:userId/:weekStart/:decision", requireManager("approve timesheets"), async (c) => {
    const db = c.get("db");
    const actor = c.get("user");
    const decision = c.req.param("decision");
    const weekStart = c.req.param("weekStart");
    if (decision !== "approve" && decision !== "reject" && decision !== "reopen") return c.json({ error: "Not found." }, 404);
    if (!isMonday(weekStart)) return c.json({ error: "Choose a week by its Monday." }, 400);
    const person = await db.user.findFirst({ where: { id: c.req.param("userId") }, select: { id: true, name: true } });
    if (!person) return c.json({ error: "Person not found." }, 404);
    if (person.id === actor.id) return c.json({ error: "Someone else has to approve, reject or reopen your own week." }, 403);
    const body = await readBody(c);
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 500) return c.json({ error: "Keep the note to 500 characters." }, 400);

    // Approve and reject need a submitted week; reopen takes a submitted or approved one.
    const allowed = decision === "reopen" ? ["submitted", "approved"] : ["submitted"];
    const result = await db.$transaction(async (tx) => {
      const t = tx as OrgDb;
      const current = await t.timesheetWeek.findFirst({ where: { userId: person.id, weekStart: asDate(weekStart) }, select: { id: true, status: true } });
      if (!current || !allowed.includes(current.status)) return null;
      if (decision === "reopen") {
        await t.timesheetWeek.deleteMany({ where: { id: current.id } });
        await recordWeek(t, actor, person, weekStart, current.status, null);
        return { week: null };
      }
      const status = decision === "approve" ? ("approved" as const) : ("rejected" as const);
      const row = await t.timesheetWeek.update({
        where: { id: current.id },
        data: { status, decidedAt: new Date(), decidedById: actor.id, decidedByName: actor.name, note: status === "rejected" ? note : "" },
        select: WEEK,
      });
      await recordWeek(t, actor, person, weekStart, current.status, status, status === "rejected" ? note : "");
      return { week: toWeek(row) };
    });
    if (!result) {
      return c.json({ error: decision === "reopen" ? "Only a submitted or approved week can be reopened." : "This week isn't waiting for a decision." }, 409);
    }
    return c.json(result);
  });

// Manage → Timesheets: turn approvals and reminders on or off.
export const timesheetSettingsRoutes = new Hono<SignedIn>()
  .get("/", async (c) => {
    const row = await c.get("db").organization.findFirstOrThrow({ select: { timesheetApprovals: true, timeZone: true } });
    return c.json({ approvals: row.timesheetApprovals, timeZone: row.timeZone });
  })
  .put("/", requireAdmin("change timesheet settings"), async (c) => {
    const body = await readBody(c);
    if (typeof body.approvals !== "boolean") return c.json({ error: "Approvals must be on or off." }, 400);
    const data: { timesheetApprovals: boolean; timeZone?: string; reminderWeek?: Date } = { timesheetApprovals: body.approvals };
    if ("timeZone" in body) {
      if (!isTimeZone(body.timeZone)) return c.json({ error: "Choose a time zone." }, 400);
      data.timeZone = body.timeZone;
    }
    const current = await c.get("db").organization.findFirstOrThrow({ select: { timesheetApprovals: true, timeZone: true } });
    // Turning approvals on starts with the coming Monday's reminder, not one about a week nobody could submit.
    if (body.approvals && !current.timesheetApprovals) {
      data.reminderWeek = asDate(addDays(startOfWeek(localNow(data.timeZone ?? current.timeZone, new Date()).date), -7));
    }
    const row = await c.get("db").organization.update({ where: { id: c.get("user").organizationId }, data, select: { timesheetApprovals: true, timeZone: true } });
    return c.json({ approvals: row.timesheetApprovals, timeZone: row.timeZone });
  });

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day, weekday (0 = Sunday) and hour right now in a time zone. */
export function localNow(timeZone: string, now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, weekday: new Date(`${date}T00:00:00Z`).getUTCDay(), hour: Number(parts.hour) };
}

export const REMINDER_HOUR = 9;

/**
 * Sends Monday's reminders for last week, once per organization and week. Runs every
 * few minutes; does nothing outside Monday from 9:00 local time. Returns how many it sent.
 */
export async function sendTimesheetReminders(now = new Date()) {
  const orgs = await prisma.organization.findMany({ where: { timesheetApprovals: true, demoExpiresAt: null }, select: { id: true, timeZone: true, reminderWeek: true } });
  let sent = 0;
  for (const org of orgs) {
    try {
      sent += await remindOrganization(org, now);
    } catch (error) {
      console.error("Timesheet reminders failed for one organization", describeError(error));
    }
  }
  return sent;
}

async function remindOrganization(org: { id: string; timeZone: string; reminderWeek: Date | null }, now: Date) {
  const local = localNow(org.timeZone, now);
  if (local.weekday !== 1 || local.hour < REMINDER_HOUR) return 0;
  const lastWeek = addDays(startOfWeek(local.date), -7);
  if (org.reminderWeek && dayOf(org.reminderWeek) >= lastWeek) return 0;
  const db = orgDb(org.id);
  // Without email the Time screen shows the reminder. Checking again later on Monday
  // means email turned on that morning still sends it.
  if (!(await isEmailConfigured(db))) return 0;
  // Claim the week first, so two servers (or two runs) can't both send.
  const { count } = await db.organization.updateMany({
    where: { OR: [{ reminderWeek: null }, { reminderWeek: { lt: asDate(lastWeek) } }] },
    data: { reminderWeek: asDate(lastWeek) },
  });
  if (!count) return 0;
  const people = await db.user.findMany({
    where: {
      deactivatedAt: null,
      accounts: { some: {} },
      createdAt: { lt: asDate(addDays(lastWeek, 7)) }, // not people who joined after it
      NOT: { email: { endsWith: PLACEHOLDER_DOMAIN } },
      timesheetWeeks: { none: { weekStart: asDate(lastWeek), status: { in: ["submitted", "approved"] } } },
    },
    select: { name: true, email: true },
  });
  const link = `${env.baseUrl}/time/week/${lastWeek}`;
  let sent = 0;
  for (const p of people) {
    const text = `Hi ${p.name},\n\nYour timesheet for the week of ${longDay(lastWeek, "en-US")} hasn't been submitted yet. Check your time and submit it here:\n\n${link}`;
    const html = `<p>Hi ${escapeHtml(p.name)},</p><p>Your timesheet for the week of ${escapeHtml(longDay(lastWeek, "en-US"))} hasn't been submitted yet. Check your time and submit it here:</p><p><a href="${link}">${link}</a></p>`;
    if ((await sendMail(db, { to: p.email, subject: "Please submit last week's timesheet", text, html })).ok) sent++;
  }
  return sent;
}

