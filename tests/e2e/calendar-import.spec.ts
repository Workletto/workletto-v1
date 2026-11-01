import { expect, test } from "@playwright/test";
import { api, choose, seedProject, unique } from "./helpers.ts";

// Calendar import (WRK-105): upload an .ics file, tick an event, give it a project, import it,
// and find it on the timesheet; the event isn't offered again.
const WEEK = "2026-11-02";
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VEVENT",
  "UID:e2e-kickoff@test",
  "SUMMARY:Kickoff with the client",
  "DTSTART:20261103T090000",
  "DTEND:20261103T103000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:e2e-holiday@test",
  "SUMMARY:Office closed",
  "DTSTART;VALUE=DATE:20261105",
  "DTEND;VALUE=DATE:20261106",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("import a calendar event from an .ics file as a time entry", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Calendar Project") });
  await page.goto(`/time/week/${WEEK}`);
  await page.getByRole("link", { name: "Import from calendar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Import from calendar" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Help for this page/ })).toHaveAttribute("href", /\/help\/time-tracking\/import-from-calendar$/);

  await page.getByLabel("Calendar file (.ics)").setInputFiles({ name: "work.ics", mimeType: "text/calendar", buffer: Buffer.from(ICS) });
  await expect(page.getByText("Left out: 1 all-day.")).toBeVisible();
  const event = page.getByRole("checkbox", { name: /Kickoff with the client/ });
  await event.click();
  await expect(page.getByText("Choose a project for each ticked event.")).toBeVisible();
  await choose(page.getByRole("combobox", { name: /^Project for Kickoff with the client/ }), project.name);
  await page.getByRole("button", { name: "Import 1 event" }).click();
  await expect(page.getByText("Imported 1 event as time entries.")).toBeVisible();
  await expect(page.getByText("No events to import this week.")).toBeVisible();
  await expect(page.getByText("Left out: 1 all-day, 1 already imported.")).toBeVisible();

  const { entries } = await api<{ entries: { notes: string; seconds: number; date: string; project: { id: string } }[] }>(request, "GET", `/api/time-entries?from=${WEEK}&to=2026-11-08`);
  expect(entries.filter((e) => e.project.id === project.id).map((e) => [e.date, e.seconds, e.notes])).toEqual([["2026-11-03", 5400, "Kickoff with the client"]]);
});
