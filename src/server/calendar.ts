// Calendar import (WRK-105): reads an iCalendar file (.ics, or what a private iCal link returns)
// and lists one week's events as the person would track them. Parsing, repeating events and
// exceptions come from ical.js (Mozilla's parser, used by Thunderbird); the times are worked out
// here, so a calendar's own time zones are honoured without changing anything global.

import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { addDays, MAX_ENTRY_SECONDS } from "../shared/time.ts";

export type CalendarEvent = {
  /** Stable for an event or one occurrence of a repeating event: a hash of its UID and occurrence. */
  id: string;
  title: string;
  /** The person's own day and times. */
  date: string;
  start: string; // "09:30"
  end: string;
  seconds: number;
};
export type Skipped = { allDay: number; declined: number };

/** Largest calendar read, as text. */
export const MAX_CALENDAR_BYTES = 5 * 1024 * 1024;
/** Occurrences looked at per repeating event, so a calendar can't keep the server busy. */
const MAX_OCCURRENCES = 20_000;
/** Occurrences looked at in one import, across all events: a busy calendar of daily series stays well under it. The time budget is the real guard. */
const MAX_TOTAL_OCCURRENCES = 500_000;
/** Time one import may take before it is stopped. */
const TIME_BUDGET_MS = 2000;
export const TOO_MANY_REPEATS = "This calendar has too many repeating events to import.";

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The UTC offset of an IANA time zone at an instant, in milliseconds. */
function offsetAt(timeZone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - at;
}

/** The instant a wall-clock time in an IANA time zone stands for. */
export function wallToInstant(w: Wall, timeZone: string) {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - offsetAt(timeZone, guess);
  return guess - offsetAt(timeZone, first);
}

/** The day and "HH:MM" of an instant in a time zone. */
function localParts(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns an ical.js time into an instant. Its zone is, in order: UTC; the calendar's own
 * VTIMEZONE of that name; an IANA zone of that name; otherwise (floating times, or a zone the
 * calendar doesn't describe) the person's own zone.
 */
function toInstant(time: ICAL.Time, tzid: string | null, zones: Map<string, ICAL.Timezone>, personZone: string) {
  const wall: Wall = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
  if (time.zone === ICAL.Timezone.utcTimezone) return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const own = tzid ? zones.get(tzid) : undefined;
  if (own) {
    const local = new ICAL.Time({ ...wall, isDate: false }, own);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - own.utcOffset(local) * 1000;
  }
  return wallToInstant(wall, tzid && isTimeZone(tzid) ? tzid : personZone);
}

const tzidOf = (component: ICAL.Component, name: string) => {
  const tzid = component.getFirstProperty(name)?.getParameter("tzid");
  return typeof tzid === "string" ? tzid : null;
};

/** Whether one of the person's addresses is an attendee who declined. */
function declined(component: ICAL.Component, owners: Set<string>) {
  return component.getAllProperties("attendee").some((p) => {
    const address = String(p.getFirstValue() ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
    return owners.has(address) && String(p.getParameter("partstat") ?? "").toUpperCase() === "DECLINED";
  });
}

const eventId = (uid: string, recurrenceId: string) => createHash("sha256").update(`${uid}|${recurrenceId}`).digest("hex");

/**
 * The events that start in the week from `monday` (the person's own Monday, in `timeZone`),
 * earliest first. All-day and declined events are counted, not listed; so are cancelled ones,
 * which are just left out. `emails` are the person's addresses, for spotting their declines.
 */
export function weekEvents(ics: string, monday: string, timeZone: string, emails: string[]): { events: CalendarEvent[]; skipped: Skipped } | { error: string } {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics) as unknown[]);
  } catch {
    return { error: "That isn't a calendar file. Choose an .ics file, or check the calendar address." };
  }
  if (root.name !== "vcalendar") return { error: "That isn't a calendar file. Choose an .ics file, or check the calendar address." };

  const zones = new Map<string, ICAL.Timezone>();
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tzid = vtz.getFirstPropertyValue("tzid");
    if (typeof tzid === "string") zones.set(tzid, new ICAL.Timezone({ component: vtz, tzid }));
  }
  const owners = new Set(emails.map((e) => e.toLowerCase()));
  // Google names a person's main calendar after their address.
  const calendarName = root.getFirstPropertyValue("x-wr-calname");
  if (typeof calendarName === "string" && calendarName.includes("@")) owners.add(calendarName.trim().toLowerCase());

  const from = wallToInstant({ year: +monday.slice(0, 4), month: +monday.slice(5, 7), day: +monday.slice(8, 10), hour: 0, minute: 0, second: 0 }, timeZone);
  const next = addDays(monday, 7);
  const to = wallToInstant({ year: +next.slice(0, 4), month: +next.slice(5, 7), day: +next.slice(8, 10), hour: 0, minute: 0, second: 0 }, timeZone);
  // Wall times are compared with a day to spare either side, then checked as instants.
  const lastWall = ICAL.Time.fromJSDate(new Date(to + 2 * 86_400_000), true);

  // Moved or changed occurrences of a repeating event belong to it, by UID.
  const vevents = root.getAllSubcomponents("vevent");
  const masters = new Map<string, ICAL.Event>();
  for (const vevent of vevents) if (!vevent.hasProperty("recurrence-id")) masters.set(String(vevent.getFirstPropertyValue("uid") ?? ""), new ICAL.Event(vevent));
  const singles: ICAL.Event[] = [...masters.values()];
  for (const vevent of vevents) {
    if (!vevent.hasProperty("recurrence-id")) continue;
    const master = masters.get(String(vevent.getFirstPropertyValue("uid") ?? ""));
    if (master?.isRecurring()) master.relateException(vevent);
    else singles.push(new ICAL.Event(vevent));
  }

  const events: CalendarEvent[] = [];
  const skipped: Skipped = { allDay: 0, declined: 0 };
  const consider = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId: string) => {
    const component = item.component;
    const startAt = toInstant(start, tzidOf(component, "dtstart"), zones, timeZone);
    if (start.isDate) {
      // All day: counted when its day is in the week.
      const day = `${start.year}-${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`;
      if (day >= monday && day < next) skipped.allDay++;
      return;
    }
    if (startAt < from || startAt >= to) return;
    if (String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    if (declined(component, owners)) {
      skipped.declined++;
      return;
    }
    const endAt = toInstant(end, tzidOf(component, "dtend") ?? tzidOf(component, "dtstart"), zones, timeZone);
    const seconds = Math.min(Math.round((endAt - startAt) / 1000), MAX_ENTRY_SECONDS);
    if (seconds <= 0) return;
    const local = localParts(startAt, timeZone);
    events.push({
      id: eventId(item.uid ?? "", recurrenceId),
      title: (item.summary ?? "").trim().slice(0, 500) || "Untitled event",
      date: local.date,
      start: local.time,
      end: localParts(endAt, timeZone).time,
      seconds,
    });
  };

  const deadline = Date.now() + TIME_BUDGET_MS;
  let total = 0;
  for (const event of singles) {
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      consider(event, event.startDate, event.endDate, event.isRecurrenceException() ? event.recurrenceId.toString() : "");
      continue;
    }
    // Rules that repeat every second or minute are never a meeting; they only keep the server busy.
    const rule = event.component.getFirstPropertyValue("rrule") as ICAL.Recur | null;
    if (rule && (rule.freq === "SECONDLY" || rule.freq === "MINUTELY")) continue;
    // A single rule that ended before the week, with no extra dates, has nothing to show.
    const onlyRule = event.component.getAllProperties("rrule").length === 1 && !event.component.hasProperty("rdate");
    if (onlyRule && rule?.until && rule.until.toUnixTime() * 1000 < from - 2 * 86_400_000) continue;
    const iterator = event.iterator();
    for (let n = 0; n < MAX_OCCURRENCES; n++) {
      if (++total > MAX_TOTAL_OCCURRENCES || Date.now() > deadline) return { error: TOO_MANY_REPEATS };
      const occurrence = iterator.next();
      if (!occurrence || occurrence.compare(lastWall) > 0) break;
      const details = event.getOccurrenceDetails(occurrence);
      consider(details.item, details.startDate, details.endDate, details.recurrenceId.toString());
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return { events, skipped };
}
