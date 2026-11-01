// Late-payment reminders (WRK-146): the timing, shared by the server's sweep and the invoice page.
import { addDays } from "./time.ts";

/** Days after the due date the first reminder can go out. 0 = off. */
export const REMINDER_DAYS = [0, 3, 7, 14] as const;
export const REMINDER_EVERY = 7;
export const MAX_REMINDERS = 3;

/** The date reminder n (0 = the first) is due, for an invoice due on `dueDate`. */
export function reminderDate(dueDate: string, days: number, n: number) {
  return addDays(dueDate, days + REMINDER_EVERY * n);
}

/** The latest reminder (0-based) due by `today` that hasn't gone out, or null. Missed ones aren't caught up one by one. */
export function dueReminder(dueDate: string, days: number, sent: number, today: string): number | null {
  if (days <= 0) return null;
  let due: number | null = null;
  for (let n = sent; n < MAX_REMINDERS && reminderDate(dueDate, days, n) <= today; n++) due = n;
  return due;
}
