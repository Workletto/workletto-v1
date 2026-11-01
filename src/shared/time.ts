// Dates and durations, shared by the server (validation) and the interface.
// A date is a plain "YYYY-MM-DD" calendar day with no time zone.

export const MAX_ENTRY_SECONDS = 24 * 60 * 60;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The Monday on or before the date. Weeks run Monday to Sunday. */
export function startOfWeek(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** 5400 → "1:30". Minutes are rounded down, so a running timer never shows time it hasn't reached. */
export function formatDuration(seconds: number, withSeconds = false): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const base = `${h}:${String(m).padStart(2, "0")}`;
  return withSeconds ? `${base}:${String(s % 60).padStart(2, "0")}` : base;
}

/**
 * A budget in hours as typed, in seconds: "40", "40.5", "40,5" or "40:30". Unlike a time entry it has
 * no 24-hour cap (up to 100,000 hours). Null for an empty box, NaN for anything unreadable.
 */
export function parseBudgetHours(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  let seconds = Number.NaN;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,6}):([0-5]?\d)$/.exec(t))) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60;
  else if (/^(\d{1,6}([.,]\d{0,4})?|[.,]\d{1,4})$/.test(t)) seconds = Math.round(Number(t.replace(",", ".")) * 3600);
  return Number.isFinite(seconds) && seconds <= 100_000 * 3600 ? seconds : Number.NaN;
}

/** A single entry's duration as a row shows it: like formatDuration, but time under a minute says so instead of "0:00". */
export function formatEntryDuration(seconds: number, withSeconds = false): string {
  const s = Math.floor(seconds);
  return !withSeconds && s > 0 && s < 60 ? "under a minute" : formatDuration(seconds, withSeconds);
}

/**
 * A week (given by its Monday) written the same way everywhere: "Oct 19 – 25, 2026",
 * "Oct 26 – Nov 1, 2026", "Dec 28, 2026 – Jan 3, 2027". The locale is the browser's own unless one is given.
 */
export function formatWeekRange(monday: string, locale?: string): string {
  const format = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  // Newer Intl data puts thin spaces around the dash; ordinary spaces read and match better.
  return format.formatRange(asDate(monday), asDate(addDays(monday, 6))).replace(/[\u2009\u202f\u00a0]/g, " ");
}

/**
 * What someone typed as a duration, in seconds: "1:30", "1.5", "1,5" or "2" (hours).
 * Null for an empty box, NaN for anything unreadable or over 24 hours.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  let seconds = Number.NaN;
  const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(t);
  if (clock) seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60;
  else if (/^\d{0,2}([.,]\d+)?$/.test(t)) seconds = Math.round(Number(t.replace(",", ".")) * 3600);
  return seconds >= 0 && seconds <= MAX_ENTRY_SECONDS ? seconds : Number.NaN;
}

/**
 * What someone typed in a duration box, in seconds. More forgiving than parseDuration,
 * which stays strict for files: a whole number up to 24 is hours ("8" is 8:00), 25 and
 * above is minutes ("90" is 1:30). Also "1:30", "1.5", "90m", "1h30", "1h 30m", "1.5h".
 * Null for an empty box, NaN for anything unreadable or over 24 hours.
 */
export function parseTypedDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  let seconds = Number.NaN;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):([0-5]?\d)$/.exec(t))) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60;
  else if ((m = /^(\d+)$/.exec(t))) seconds = Number(m[1]) <= 24 ? Number(m[1]) * 3600 : Number(m[1]) * 60;
  else if ((m = /^(\d*[.,]?\d+) ?h(?:ours?|rs?)?$/.exec(t))) seconds = Math.round(Number(m[1]!.replace(",", ".")) * 3600);
  else if ((m = /^(\d+) ?m(?:in(?:ute)?s?)?$/.exec(t))) seconds = Number(m[1]) * 60;
  else if ((m = /^(\d+) ?h(?:ours?|rs?)? ?(\d+) ?m?(?:in(?:ute)?s?)?$/.exec(t))) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60;
  else if (/^\d*[.,]\d+$/.test(t)) seconds = Math.round(Number(t.replace(",", ".")) * 3600);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_ENTRY_SECONDS ? seconds : Number.NaN;
}

/** A "YYYY-MM-DD" calendar day as the UTC midnight Date the database stores. */
export const asDate = (date: string) => new Date(`${date}T00:00:00Z`);

/** A Date as its "YYYY-MM-DD" calendar day. */
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** Like dayOf, but a missing date stays null. */
export const dayOrNull = (d: Date | null) => (d ? dayOf(d) : null);
/** Like dayOf, but a missing date becomes an empty string (for CSV cells). */
export const dayOrEmpty = (d: Date | null) => (d ? dayOf(d) : "");

/** "March 5, 2026". The locale is the server's own unless one is given. */
export const longDay = (date: string, locale?: string) =>
  asDate(date).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
