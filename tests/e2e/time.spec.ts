import { expect, test } from "@playwright/test";
import { choose, seedClient, seedEntry, seedProject, today, unique } from "./helpers.ts";
import { addDays, startOfWeek } from "../../src/shared/time.ts";

test("start and stop the timer", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Timer Project"), clientId: (await seedClient(request)).id });
  const notes = unique("Timer notes");

  await page.goto("/");
  await choose(page.getByRole("combobox", { name: /^Project/ }), project.name);
  await page.getByLabel("Notes", { exact: true }).fill(notes);
  await page.getByRole("button", { name: "Start timer" }).click();
  // Screen reader users hear that it started (QA2-14).
  await expect(page.getByRole("status").filter({ hasText: `Timer started for ${project.name}.` })).toHaveCount(1);

  // The clock in the header ticks, and it is kept on the server: a reload doesn't lose it.
  const timer = page.getByRole("group", { name: "Running timer" });
  await expect(timer).toContainText(project.name);
  await expect(timer.getByRole("timer")).toHaveText(/^0:00:0[1-9]$/);
  await page.reload();
  await expect(timer).toContainText(project.name);

  await timer.getByRole("button", { name: "Stop" }).click();
  await expect(timer).toBeHidden();

  // The entry stays on today's list and can be started again.
  const entry = page.getByRole("listitem").filter({ hasText: notes });
  await expect(entry).toContainText(project.name);
  await expect(entry.getByRole("button", { name: /^Start/ })).toBeVisible();
  await expect(entry.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
});

test("add a manual entry on a day, change it and delete it", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Manual Project") });
  const notes = unique("Manual notes");
  const day = "2026-01-14";

  await page.goto(`/time/day/${day}`);
  await choose(page.getByRole("combobox", { name: /^Project/ }), project.name);
  await page.getByLabel("Notes", { exact: true }).fill(notes);

  // A duration that isn't one is refused ...
  await page.getByLabel("Duration").fill("soon");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a duration like 1:30 or 1.5, up to 24 hours.");

  // ... a zero is refused too, and nothing is saved (QA-4) ...
  await expect(page.getByText("Like 1:30, 1.5 or 90m. A whole number up to 24 is hours; from 25 it's minutes.")).toBeVisible();
  for (const zero of ["0", "0m", "0:00"]) {
    await page.getByLabel("Duration").fill(zero);
    await page.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a time above zero, or leave it empty to start a timer.");
  }
  await expect(page.getByText("No time on this day yet.")).toBeVisible();

  // ... minutes are understood and the box shows how they were read ...
  await page.getByLabel("Duration").fill("90");
  await page.getByLabel("Notes", { exact: true }).focus();
  await expect(page.getByLabel("Duration")).toHaveValue("1:30");

  // ... a real one is saved.
  await page.getByLabel("Duration").fill("1:30");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Saved 1:30 for ${project.name}.` })).toHaveCount(1);
  const entry = page.getByRole("listitem").filter({ hasText: notes });
  await expect(entry).toContainText("1:30");
  await expect(page.locator("p", { hasText: /^Total/ })).toHaveText(/^Total\s*1:30$/);

  // Hours written as a decimal work too, when editing. An entry being edited shows its notes in a box.
  const editor = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Cancel" }) });
  await entry.getByRole("button", { name: /^Edit/ }).click();
  await editor.getByLabel("Duration").fill("2.25");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(entry).toContainText("2:15");
  await page.reload();
  await expect(entry).toContainText("2:15");

  await entry.getByRole("button", { name: /^Edit/ }).click();
  await editor.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(notes)).toHaveCount(0);
  await expect(page.getByText("No time on this day yet.")).toBeVisible();
});

test("enter time on the week timesheet", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Timesheet Project"), clientId: (await seedClient(request)).id });
  // Wednesday 4 March 2026 is in the week of Monday 2 March.
  await page.goto("/time/week/2026-03-04");
  await expect(page.getByRole("heading", { level: 1, name: "Mar 2 – 8, 2026" })).toBeVisible();

  await choose(page.getByLabel("Project to add as a row"), project.name);
  await page.getByRole("button", { name: "Add row" }).click();
  const row = page.locator("tbody tr").filter({ hasText: project.name });
  const day = (name: string) => row.getByRole("textbox", { name: `${project.name}, ${name}`, exact: true });
  const rowTotal = row.locator("td").last();

  // Enter saves; leaving the box saves too.
  await day("Monday, March 2").fill("2:15");
  await day("Monday, March 2").press("Enter");
  await expect(rowTotal).toHaveText("2:15");
  await day("Wednesday, March 4").fill("1.5");
  await day("Wednesday, March 4").press("Tab");
  await expect(day("Wednesday, March 4")).toHaveValue("1:30");
  // The week's totals sit above the grid, against the hours expected (40 a week by default).
  await expect(page.getByText("of 40:00 expected")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Hours this week of the hours expected" })).toHaveAttribute("aria-valuenow", String(3.75 * 3600));
  await expect(rowTotal).toHaveText("3:45");
  await expect(page.locator("tfoot td").last()).toHaveText("3:45");
  // Days without time read 0:00 in the total row, not blank (QA2-22).
  await expect(page.locator("tfoot td").nth(1)).toHaveText("0:00");
  await expect(page.locator("tfoot td").nth(6)).toHaveText("0:00");

  // The time is on the server.
  await page.reload();
  await expect(day("Monday, March 2")).toHaveValue("2:15");
  await expect(day("Wednesday, March 4")).toHaveValue("1:30");

  // The same entries show in the day view.
  await page.goto("/time/day/2026-03-04");
  await expect(page.getByRole("listitem").filter({ hasText: project.name })).toContainText("1:30");

  // Typing 0 clears a box: it shows nothing, not "0:00" (QA-32).
  await page.goto("/time/week/2026-03-04");
  await day("Wednesday, March 4").fill("0");
  await day("Wednesday, March 4").press("Tab");
  await expect(day("Wednesday, March 4")).toHaveValue("");
  await expect(rowTotal).toHaveText("2:15");
  await page.reload();
  await expect(day("Wednesday, March 4")).toHaveValue("");

  // Emptying a box removes its entry too (and a row with no time left goes).
  await day("Monday, March 2").fill("");
  await day("Monday, March 2").press("Enter");
  await expect(page.getByText("No time this week.")).toBeVisible();
});

test("a day that adds up to more than 24 hours gets a notice, and the week reads the same everywhere", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Long Day Project") });
  const day = "2026-02-10";
  await page.goto(`/time/day/${day}`);
  await expect(page.getByText(/This day adds up to more than 24 hours/)).toHaveCount(0);
  await seedEntry(request, { projectId: project.id, date: day, minutes: 24 * 60 });
  await seedEntry(request, { projectId: project.id, date: day, minutes: 60 });
  await page.reload();
  await expect(page.getByText("This day adds up to more than 24 hours. Check for a time typed in the wrong unit.")).toBeVisible();
  // An entry under a minute reads "under a minute", not 0:00.
  const quick = await request.post("/api/time-entries", { data: { projectId: project.id, date: "2026-02-11", seconds: 17, notes: "Quick", billable: true } });
  expect(quick.ok()).toBe(true);
  await page.goto("/time/day/2026-02-11");
  await expect(page.getByRole("listitem").filter({ hasText: "Quick" })).toContainText("under a minute");
  // One week format: across months and across years.
  await page.goto("/time/week/2026-10-28");
  await expect(page.getByRole("heading", { level: 1, name: "Oct 26 – Nov 1, 2026" })).toBeVisible();
  await page.goto("/time/week/2026-12-30");
  await expect(page.getByRole("heading", { level: 1, name: "Dec 28, 2026 – Jan 3, 2027" })).toBeVisible();
});

test("copy last week's rows into this week, without their hours (WRK-106)", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Retainer Project") });
  const monday = startOfWeek(today());
  await seedEntry(request, { projectId: project.id, date: addDays(monday, -5), minutes: 90 });
  await page.goto(`/time/week/${monday}`);
  const grid = page.getByRole("region", { name: "Week timesheet" });
  await expect(grid.getByText(project.name)).toHaveCount(0);
  await page.getByRole("button", { name: "Copy last week's rows" }).click();
  const row = grid.getByRole("row").filter({ hasText: project.name });
  await expect(row).toBeVisible();
  // A row, not a copy of the time: every cell is empty.
  for (const cell of await row.getByRole("textbox").all()) await expect(cell).toHaveValue("");
});
