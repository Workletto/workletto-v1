import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isDemoMode } from "./env.ts";
import { readBody, type SignedIn } from "./http.ts";
import { createLimiter } from "./rateLimit.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { isTimeZone, MAX_CALENDAR_BYTES, weekEvents } from "./calendar.ts";
import { fetchCalendar, readCalendarUrl } from "./calendarFetch.ts";
import { addEntries } from "./time.ts";
import { isIsoDate, startOfWeek } from "../shared/time.ts";

// Calendar import (WRK-105): everyone turns their own calendar's events into their own time
// entries, from a private iCal link or an uploaded .ics file. The link is stored encrypted and
// fetched only when the person loads a week. Each event is imported once.

type Choice = { projectId: string; taskId: string | null };
/** Event titles remembered per person, the latest kept. */
const MAX_CHOICES = 500;
const MAX_IMPORT = 200;
/** Loading a week from the link, per person. */
const fetchesPerUser = createLimiter(20, 10 * 60 * 1000);

/** Uploading a file to read, per person. */
const uploadsPerUser = createLimiter(30, 10 * 60 * 1000);

const readChoices = (value: unknown): Record<string, Choice> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Choice>) : {});

async function settingsOf(db: OrgDb, userId: string) {
  return db.calendarSettings.findFirst({ where: { userId }, select: { url: true, choices: true } });
}

/** The host of a stored address, to show which calendar is connected without showing its secret. */
function hostOf(stored: string | null | undefined) {
  const url = stored ? decryptSecret(stored) : null;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function saveSettings(db: OrgDb, userId: string, data: { url?: string | null; choices?: Record<string, Choice> }) {
  const { count } = await db.calendarSettings.updateMany({ where: { userId }, data });
  if (!count) {
    const row = { userId, ...data };
    await db.calendarSettings.create({ data: row as typeof row & { organizationId: string }, select: { id: true } });
  }
}

export const calendarRoutes = new Hono<SignedIn>()
  .get("/", async (c) => {
    const row = await settingsOf(c.get("db"), c.get("user").id);
    return c.json({ link: hostOf(row?.url) ? { host: hostOf(row?.url) } : null, linksAllowed: !isDemoMode() });
  })
  // { url }: the calendar's private iCal address.
  .put("/link", async (c) => {
    if (isDemoMode()) return c.json({ error: "Calendar links aren't available in the demo. Upload an .ics file instead." }, 403);
    const read = readCalendarUrl((await readBody(c)).url);
    if ("error" in read) return c.json(read, 400);
    await saveSettings(c.get("db"), c.get("user").id, { url: encryptSecret(read.url) });
    return c.json({ link: { host: new URL(read.url).hostname } });
  })
  .delete("/link", async (c) => {
    await c.get("db").calendarSettings.updateMany({ where: { userId: c.get("user").id }, data: { url: null } });
    return c.json({ ok: true });
  })
  // { week, timeZone, ics? }: the week's events, from the uploaded file or else the saved link,
  // with the project and task last chosen for each title. Events already imported are counted, not listed.
  .post("/events", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const user = c.get("user");
    if (!isIsoDate(body.week)) return c.json({ error: "Choose a week." }, 400);
    if (!isTimeZone(body.timeZone)) return c.json({ error: "Your browser didn't say its time zone. Reload the page and try again." }, 400);
    const settings = await settingsOf(db, user.id);
    let text: string;
    if (body.ics !== undefined) {
      if (typeof body.ics !== "string" || body.ics.length > MAX_CALENDAR_BYTES) return c.json({ error: "Choose an .ics file of up to 5 MB." }, 400);
      if (!uploadsPerUser.hit(user.id)) return c.json({ error: "Too many calendar uploads. Wait 10 minutes and try again." }, 429);
      text = body.ics;
    } else {
      const url = settings?.url ? decryptSecret(settings.url) : null;
      if (!url || isDemoMode()) return c.json({ error: "Add your calendar's iCal address, or upload an .ics file." }, 400);
      if (!fetchesPerUser.hit(user.id)) return c.json({ error: "Too many calendar loads. Wait 10 minutes and try again." }, 429);
      const fetched = await fetchCalendar(url);
      if ("error" in fetched) return c.json(fetched, 502);
      text = fetched.text;
    }
    const me = await db.user.findFirstOrThrow({ where: { id: user.id }, select: { email: true } });
    const result = weekEvents(text, startOfWeek(body.week), body.timeZone, [me.email]);
    if ("error" in result) return c.json(result, 400);
    const imported = new Set(
      (await db.timeEntry.findMany({ where: { userId: user.id, calendarEventId: { in: result.events.map((e) => e.id) } }, select: { calendarEventId: true } })).map((e) => e.calendarEventId),
    );
    const choices = readChoices(settings?.choices);
    const events = result.events.filter((e) => !imported.has(e.id)).map((e) => ({ ...e, choice: choices[e.title] ?? null }));
    return c.json({ events, skipped: { ...result.skipped, imported: result.events.length - events.length } });
  })
  // { entries: [{ eventId, title, date, seconds, projectId, taskId }] }: the ticked events become entries,
  // with the title as the notes, and each title's project and task are remembered.
  .post("/import", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const user = c.get("user");
    const list = body.entries;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IMPORT) return c.json({ error: `Tick the events to import, up to ${MAX_IMPORT} at a time.` }, 400);
    const rows = [];
    for (const item of list as Record<string, unknown>[]) {
      if (!item || typeof item.eventId !== "string" || !/^[0-9a-f]{64}$/.test(item.eventId) || typeof item.title !== "string" || item.title.length > 500) {
        return c.json({ error: "Load the week again and try once more." }, 400);
      }
      rows.push({ projectId: item.projectId, taskId: item.taskId ?? null, date: item.date, seconds: item.seconds, notes: item.title, calendarEventId: item.eventId });
    }
    const result = await addEntries(db, user, rows);
    if ("error" in result) return c.json({ error: result.error }, result.status);

    const choices = readChoices((await settingsOf(db, user.id))?.choices);
    for (const item of list as { title: string; projectId: string; taskId?: string | null }[]) {
      delete choices[item.title];
      choices[item.title] = { projectId: item.projectId, taskId: item.taskId ?? null };
    }
    const kept = Object.fromEntries(Object.entries(choices).slice(-MAX_CHOICES));
    await saveSettings(db, user.id, { choices: kept });
    return c.json(result);
  });
