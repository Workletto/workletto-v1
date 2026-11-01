import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { weekEvents } from "../src/server/calendar.ts";
import { isPrivateAddress, readCalendarUrl } from "../src/server/calendarFetch.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Calendar import (WRK-105): a week of events from an .ics file or a private iCal link, turned
// into the person's own time entries, each event once.

beforeEach(resetDatabase);

const NEW_YORK = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

// Outlook names zones the Windows way and describes them itself.
const PACIFIC_WINDOWS = `BEGIN:VTIMEZONE
TZID:Pacific Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE`;

const event = (lines: string) => `BEGIN:VEVENT\n${lines.trim()}\nEND:VEVENT`;
const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", "X-WR-CALNAME:ada@calendar.test", NEW_YORK, PACIFIC_WINDOWS, ...events, "END:VCALENDAR"].join("\n");

// The week of Monday, November 2, 2026: New York is back on standard time (UTC-5) since Nov 1.
const WEEK = "2026-11-02";
const ICS = calendar(
  event(`UID:kickoff@test
SUMMARY:Client kickoff
DTSTART;TZID=America/New_York:20261103T090000
DTEND;TZID=America/New_York:20261103T103000`),
  event(`UID:west@test
SUMMARY:West coast review
DTSTART;TZID=Pacific Standard Time:20261104T100000
DTEND;TZID=Pacific Standard Time:20261104T110000`),
  event(`UID:utc@test
SUMMARY:Call with London
DTSTART:20261105T150000Z
DURATION:PT45M`),
  event(`UID:floating@test
SUMMARY:Focus time
DTSTART:20261106T130000
DTEND:20261106T150000`),
  // Every Monday and Wednesday at 10:00 since October (daylight time then), with Wednesday the
  // 4th taken out and Monday the 2nd moved to 11:00.
  event(`UID:standup@test
SUMMARY:Standup
DTSTART;TZID=America/New_York:20261005T100000
DURATION:PT15M
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=America/New_York:20261104T100000`),
  event(`UID:standup@test
RECURRENCE-ID;TZID=America/New_York:20261102T100000
SUMMARY:Standup (moved)
DTSTART;TZID=America/New_York:20261102T110000
DTEND;TZID=America/New_York:20261102T113000`),
  event(`UID:holiday@test
SUMMARY:Office closed
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106`),
  event(`UID:declined@test
SUMMARY:Optional lunch talk
DTSTART:20261104T170000Z
DTEND:20261104T180000Z
ATTENDEE;PARTSTAT=DECLINED:mailto:ada@calendar.test`),
  event(`UID:cancelled@test
SUMMARY:Cancelled meeting
STATUS:CANCELLED
DTSTART:20261104T190000Z
DTEND:20261104T200000Z`),
  event(`UID:next-week@test
SUMMARY:Next week
DTSTART:20261109T150000Z
DTEND:20261109T160000Z`),
);

describe("reading a calendar", () => {
  it("lists the week's timed events in the person's time zone, with repeats, moves and removals", () => {
    const result = weekEvents(ICS, WEEK, "America/New_York", []);
    if ("error" in result) throw new Error(result.error);
    expect(result.events.map((e) => [e.title, e.date, e.start, e.end, e.seconds])).toEqual([
      ["Standup (moved)", "2026-11-02", "11:00", "11:30", 1800],
      ["Client kickoff", "2026-11-03", "09:00", "10:30", 5400],
      ["West coast review", "2026-11-04", "13:00", "14:00", 3600],
      ["Call with London", "2026-11-05", "10:00", "10:45", 2700],
      ["Focus time", "2026-11-06", "13:00", "15:00", 7200],
    ]);
    // The all-day event and the one declined by the calendar's owner are counted, not listed.
    expect(result.skipped).toEqual({ allDay: 1, declined: 1 });
    // The ids are stable and differ for each occurrence.
    const again = weekEvents(ICS, WEEK, "America/New_York", []);
    expect("events" in again && again.events.map((e) => e.id)).toEqual(result.events.map((e) => e.id));
    expect(new Set(result.events.map((e) => e.id)).size).toBe(5);
  });

  it("moves times to another person's zone, and keeps floating times on their own clock", () => {
    const result = weekEvents(ICS, WEEK, "Europe/London", []);
    if ("error" in result) throw new Error(result.error);
    const at = Object.fromEntries(result.events.map((e) => [e.title, `${e.date} ${e.start}`]));
    expect(at["Client kickoff"]).toBe("2026-11-03 14:00");
    expect(at["West coast review"]).toBe("2026-11-04 18:00");
    expect(at["Call with London"]).toBe("2026-11-05 15:00");
    expect(at["Focus time"]).toBe("2026-11-06 13:00");
  });

  it("repeats a weekly event on later weeks, and says when a file isn't a calendar", () => {
    const later = weekEvents(ICS, "2026-11-16", "America/New_York", []);
    if ("error" in later) throw new Error(later.error);
    expect(later.events.map((e) => [e.title, e.date, e.start])).toEqual([["Standup", "2026-11-16", "10:00"], ["Standup", "2026-11-18", "10:00"]]);
    expect(weekEvents("hello", WEEK, "UTC", [])).toEqual({ error: expect.stringContaining("isn't a calendar file") });
  });

  it("knows a decline by the person's own address too", () => {
    const ics = calendar(event(`UID:x@test\nSUMMARY:Board\nDTSTART:20261103T150000Z\nDTEND:20261103T160000Z\nATTENDEE;PARTSTAT=DECLINED:mailto:Ada@Studio.test`));
    expect(weekEvents(ics, WEEK, "UTC", ["ada@studio.test"])).toMatchObject({ events: [], skipped: { declined: 1 } });
    expect(weekEvents(ics, WEEK, "UTC", ["ben@studio.test"])).toMatchObject({ events: [{ title: "Board" }] });
  });
});

describe("repeating events that would keep the server busy", () => {
  it("skips every-second rules from 1970 quickly, and still reads a normal weekly event", () => {
    const busy = Array.from({ length: 50 }, (_, i) => event(`UID:busy${i}@test\nSUMMARY:Busy\nDTSTART:19700101T000000Z\nDTEND:19700101T000001Z\nRRULE:FREQ=${i % 2 ? "SECONDLY" : "MINUTELY"}`));
    const weekly = event(`UID:weekly@test\nSUMMARY:Weekly\nDTSTART:20261005T150000Z\nDURATION:PT30M\nRRULE:FREQ=WEEKLY;BYDAY=TU`);
    const started = Date.now();
    const result = weekEvents(calendar(...busy, weekly), WEEK, "UTC", []);
    expect(Date.now() - started).toBeLessThan(1000);
    if ("error" in result) throw new Error(result.error);
    expect(result.events.map((e) => [e.title, e.date])).toEqual([["Weekly", "2026-11-03"]]);
  });

  it("stops with a clear error when the repeats add up to too many", () => {
    const daily = Array.from({ length: 50 }, (_, i) => event(`UID:daily${i}@test\nSUMMARY:Daily\nDTSTART:19700101T000000Z\nDTEND:19700101T010000Z\nRRULE:FREQ=HOURLY`));
    const started = Date.now();
    expect(weekEvents(calendar(...daily), WEEK, "UTC", [])).toEqual({ error: "This calendar has too many repeating events to import." });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reads a busy calendar of daily meetings that have run for years", () => {
    // Twelve open-ended daily series since 2020: about 30,000 occurrences to walk past.
    const daily = Array.from({ length: 12 }, (_, i) => event(`UID:standup${i}@test\nSUMMARY:Standup ${i}\nDTSTART:20200106T${String(9 + (i % 8)).padStart(2, "0")}0000Z\nDTEND:20200106T${String(9 + (i % 8)).padStart(2, "0")}1500Z\nRRULE:FREQ=DAILY`));
    const result = weekEvents(calendar(...daily), WEEK, "UTC", []);
    expect("events" in result && result.events.length).toBe(12 * 7);
  });
});

describe("calendar addresses", () => {
  it("accept only public https addresses", () => {
    expect(readCalendarUrl("webcal://calendar.example.com/private/basic.ics")).toEqual({ url: "https://calendar.example.com/private/basic.ics" });
    expect(readCalendarUrl("https://calendar.google.com/calendar/ical/x/private-abc/basic.ics")).toHaveProperty("url");
    for (const bad of ["http://calendar.example.com/a.ics", "https://localhost/a.ics", "https://127.0.0.1/a.ics", "https://10.0.0.5/a.ics", "https://169.254.169.254/latest", "https://[::1]/a.ics", "https://intranet/a.ics", "https://host.internal/a.ics", "https://user:pw@calendar.example.com/a.ics", "https://calendar.example.com:8443/a.ics", "ftp://x.test/a", 42]) {
      expect(readCalendarUrl(bad), String(bad)).toHaveProperty("error");
    }
  });

  it("refuse private network addresses after a name is looked up", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::7f00:1", "::a00:1", "2002:7f00:1::", "2002:c0a8:101::1"]) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["142.250.80.46", "52.96.0.1", "2607:f8b0:4006:80f::200e"]) expect(isPrivateAddress(address), address).toBe(false);
  });
});

async function studio(name = "Studio", domain = "studio.test") {
  const { organization, user } = await createOrgWithUser(name, `ada@${domain}`, "member-password-1", "member");
  const cookie = (await signIn(`ada@${domain}`, "member-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie, ...init });
    return { status: res.status, body: await res.json() };
  };
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: "Brand", billable: true } });
  const task = await prisma.task.create({ data: { organizationId: organization.id, projectId: project.id, title: "Meetings" } });
  return { organization, user, cookie, json, project, task };
}

const load = (s: Awaited<ReturnType<typeof studio>>, body: Record<string, unknown> = {}) =>
  s.json("/api/calendar/events", { body: { week: WEEK, timeZone: "America/New_York", ics: ICS, ...body } });

describe("importing events", () => {
  it("makes the ticked events time entries, remembers each title's project and task, and imports each once", async () => {
    const s = await studio();
    const loaded = await load(s);
    expect(loaded.status).toBe(200);
    expect(loaded.body.events).toHaveLength(5);
    expect(loaded.body.skipped).toEqual({ allDay: 1, declined: 1, imported: 0 });
    const [moved, kickoff] = loaded.body.events;
    const pick = (e: { id: string; title: string; date: string; seconds: number }, taskId: string | null = null) => ({ eventId: e.id, title: e.title, date: e.date, seconds: e.seconds, projectId: s.project.id, taskId });

    const imported = await s.json("/api/calendar/import", { body: { entries: [pick(moved), pick(kickoff, s.task.id)] } });
    expect(imported).toEqual({ status: 200, body: { added: 2, alreadyImported: 0 } });
    const entries = await prisma.timeEntry.findMany({ where: { userId: s.user.id }, orderBy: { date: "asc" }, select: { date: true, seconds: true, notes: true, taskId: true, billable: true } });
    expect(entries).toEqual([
      { date: new Date("2026-11-02T00:00:00Z"), seconds: 1800, notes: "Standup (moved)", taskId: null, billable: true },
      { date: new Date("2026-11-03T00:00:00Z"), seconds: 5400, notes: "Client kickoff", taskId: s.task.id, billable: true },
    ]);
    const history = await prisma.auditEvent.findMany({ where: { kind: "time" } });
    expect(history).toHaveLength(2);

    // Loading the week again leaves them out, and suggests the choices for the other titles' next time.
    const again = await load(s);
    expect(again.body.events.map((e: { title: string }) => e.title)).toEqual(["West coast review", "Call with London", "Focus time"]);
    expect(again.body.skipped.imported).toBe(2);
    const later = await load(s, { week: "2026-11-30" });
    // Only "Standup (moved)" was chosen, so plain "Standup" has no choice yet.
    expect(later.body.events.find((e: { title: string }) => e.title === "Standup").choice).toBeNull();
    // Importing the same event twice adds nothing.
    expect((await s.json("/api/calendar/import", { body: { entries: [pick(kickoff, s.task.id)] } })).body).toEqual({ added: 0, alreadyImported: 1 });
    const kickoffChoice = (await load(s, { ics: calendar(event(`UID:kickoff2@test\nSUMMARY:Client kickoff\nDTSTART:20261103T150000Z\nDTEND:20261103T160000Z`)) })).body.events[0];
    expect(kickoffChoice.choice).toEqual({ projectId: s.project.id, taskId: s.task.id });
  });

  it("checks each event like an entry added by hand, and adds none when one is wrong", async () => {
    const s = await studio();
    const [first, second] = (await load(s)).body.events;
    const ok = { eventId: first.id, title: first.title, date: first.date, seconds: first.seconds, projectId: s.project.id };
    expect((await s.json("/api/calendar/import", { body: { entries: [ok, { ...ok, eventId: second.id, projectId: "nope" }] } })).status).toBe(400);
    expect((await s.json("/api/calendar/import", { body: { entries: [{ ...ok, eventId: "not-a-hash" }] } })).status).toBe(400);
    expect((await s.json("/api/calendar/import", { body: { entries: [] } })).status).toBe(400);
    expect(await prisma.timeEntry.count()).toBe(0);
    expect((await load(s, { timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await load(s, { ics: undefined })).status).toBe(400); // no link saved
  });

  it("stores the link encrypted and shows only its host", async () => {
    const s = await studio();
    expect((await s.json("/api/calendar/link", { method: "PUT", body: { url: "http://calendar.example.com/a.ics" } })).status).toBe(400);
    const saved = await s.json("/api/calendar/link", { method: "PUT", body: { url: "webcal://calendar.example.com/private-secret-123/basic.ics" } });
    expect(saved.body).toEqual({ link: { host: "calendar.example.com" } });
    const row = await prisma.calendarSettings.findFirstOrThrow({ where: { userId: s.user.id } });
    expect(row.url).not.toContain("private-secret-123");
    expect((await s.json("/api/calendar")).body).toEqual({ link: { host: "calendar.example.com" }, linksAllowed: true });
    expect((await s.json("/api/calendar/link", { method: "DELETE" })).status).toBe(200);
    expect((await s.json("/api/calendar")).body.link).toBeNull();
  });

  it("keeps each person's imports and choices to themselves", async () => {
    const north = await studio();
    const south = await studio("South", "south.test");
    const ben = await addUser(north.organization.id, "ben@studio.test", "member-password-1");
    const benCookie = (await signIn("ben@studio.test", "member-password-1")).cookie;
    const [first] = (await load(north)).body.events;
    await north.json("/api/calendar/import", { body: { entries: [{ eventId: first.id, title: first.title, date: first.date, seconds: first.seconds, projectId: north.project.id }] } });

    // Ben and someone in another organization still see the event, with no remembered choice.
    const asBen = await north.json("/api/calendar/events", { cookie: benCookie, body: { week: WEEK, timeZone: "America/New_York", ics: ICS } });
    expect(asBen.body.events).toHaveLength(5);
    expect(asBen.body.events[0].choice).toBeNull();
    expect((await load(south)).body.events).toHaveLength(5);
    // Nobody can import into another organization's project.
    expect((await south.json("/api/calendar/import", { body: { entries: [{ eventId: first.id, title: first.title, date: first.date, seconds: first.seconds, projectId: north.project.id }] } })).status).toBe(400);
    expect(await prisma.timeEntry.count({ where: { userId: ben.id } })).toBe(0);
  });
});

describe("uploads", () => {
  it("are limited per person", async () => {
    const s = await studio();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await load(s)).status;
    expect(last).toBe(429);
  });
});
