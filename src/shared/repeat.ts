// How often a repeating invoice makes a new draft (WRK-42), shared by the server and the screens.

import { addDays } from "./time.ts";

export const REPEAT_EVERY = ["week", "month", "quarter"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];

export const REPEAT_LABELS: Record<RepeatEvery, string> = { week: "Every week", month: "Every month", quarter: "Every 3 months" };

/**
 * The date of the n-th draft (0 is the first). Months count from the first date's day, so a
 * schedule starting on the 31st makes drafts on the 31st, or the month's last day when it's shorter.
 */
export function occurrence(startDate: string, every: RepeatEvery, n: number): string {
  if (every === "week") return addDays(startDate, 7 * n);
  const [y, m, d] = startDate.split("-").map(Number) as [number, number, number];
  const months = m - 1 + n * (every === "quarter" ? 3 : 1);
  const year = y + Math.floor(months / 12);
  const month = months % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
