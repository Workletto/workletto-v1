import { describe, expect, it } from "vitest";
import { addDays, formatDuration, formatEntryDuration, formatWeekRange, parseBudgetHours, isIsoDate, parseDuration, parseTypedDuration, startOfWeek } from "../src/shared/time.ts";

describe("dates and durations", () => {
  it("reads durations the way people type them", () => {
    expect(parseDuration("1:30")).toBe(5400);
    expect(parseDuration("1.5")).toBe(5400);
    expect(parseDuration("1,25")).toBe(4500);
    expect(parseDuration("2")).toBe(7200);
    expect(parseDuration(".5")).toBe(1800);
    expect(parseDuration("0:05")).toBe(300);
    expect(parseDuration("  ")).toBeNull();
    for (const bad of ["abc", "1:75", "25", "24:01", "-1", "1:30:00"]) expect(parseDuration(bad)).toBeNaN();
  });

  it("reads typed durations: up to 24 is hours, 25 and above is minutes", () => {
    expect(parseTypedDuration("8")).toBe(8 * 3600);
    expect(parseTypedDuration("24")).toBe(86400);
    expect(parseTypedDuration("25")).toBe(25 * 60);
    expect(parseTypedDuration("90")).toBe(5400);
    expect(parseTypedDuration("45")).toBe(2700);
    expect(parseTypedDuration("1440")).toBe(86400);
    for (const same of ["90m", "90 min", "1h30", "1h 30m", "1:30", "1.5", "1,5", "1.5h", " 1.5 h "]) expect(parseTypedDuration(same)).toBe(5400);
    expect(parseTypedDuration("2h")).toBe(7200);
    expect(parseTypedDuration(".5")).toBe(1800);
    expect(parseTypedDuration("0")).toBe(0);
    expect(parseTypedDuration("  ")).toBeNull();
    for (const bad of ["abc", "1:75", "1441", "24:01", "-1", "1:30:00", "25h", "90x", "1h75x"]) expect(parseTypedDuration(bad)).toBeNaN();
  });

  it("keeps the file parser strict: 30 in a file is not 30 minutes", () => {
    expect(parseDuration("90")).toBeNaN();
    expect(parseDuration("90m")).toBeNaN();
    expect(parseDuration("30")).toBeNaN();
  });

  it("shows durations as hours and minutes, rounding down", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5399)).toBe("1:29");
    expect(formatDuration(36000)).toBe("10:00");
    expect(formatDuration(3725, true)).toBe("1:02:05");
  });

  it("works with calendar days", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(startOfWeek("2026-10-15")).toBe("2026-10-12"); // Thursday → Monday
    expect(startOfWeek("2026-10-18")).toBe("2026-10-12"); // Sunday belongs to the week before
    expect(startOfWeek("2026-10-12")).toBe("2026-10-12");
  });
});

describe("how times are written", () => {
  it("writes a week the same way in every case", () => {
    expect(formatWeekRange("2026-10-19", "en-US")).toBe("Oct 19 – 25, 2026");
    expect(formatWeekRange("2026-10-26", "en-US")).toBe("Oct 26 – Nov 1, 2026");
    expect(formatWeekRange("2026-12-28", "en-US")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });

  it("says when a single entry is under a minute instead of showing 0:00", () => {
    expect(formatEntryDuration(17)).toBe("under a minute");
    expect(formatEntryDuration(59.9)).toBe("under a minute");
    expect(formatEntryDuration(0)).toBe("0:00");
    expect(formatEntryDuration(60)).toBe("0:01");
    expect(formatEntryDuration(5400)).toBe("1:30");
  });

  it("reads a budget in hours without the 24-hour cap", () => {
    expect(parseBudgetHours("40")).toBe(40 * 3600);
    expect(parseBudgetHours("40.5")).toBe(40.5 * 3600);
    expect(parseBudgetHours("40,5")).toBe(40.5 * 3600);
    expect(parseBudgetHours("40:30")).toBe(40.5 * 3600);
    expect(parseBudgetHours("601:15")).toBe(601 * 3600 + 15 * 60);
    expect(parseBudgetHours("  ")).toBeNull();
    for (const bad of ["abc", "-5", "40:75", "1e3", "40.5.5", "999999"]) expect(parseBudgetHours(bad)).toBeNaN();
  });
});
