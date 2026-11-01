import { expect, test } from "@playwright/test";
import { api } from "./helpers.ts";

const FIXTURE = "tests/fixtures/harvest-time-export.csv";

test("import a Harvest time report: check it first, then import it", async ({ page, request }) => {
  // A line of the check or import summary. (A hidden status line repeats it for screen readers; it is outside main.)
  const note = (text: string | RegExp) => page.locator("main").getByText(text);
  const projectNames = async () => (await api<{ projects: { name: string }[] }>(request, "GET", "/api/projects")).projects.map((p) => p.name);

  await page.goto("/manage/data");
  await expect(page.getByRole("heading", { level: 1, name: "Import & export" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Import from Harvest" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "What's in the file" })).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.getByText("harvest-time-export.csv · 22 rows")).toBeVisible();
  await expect(page.getByRole("region", { name: "Preview of the first rows" })).toContainText("Bluebird Bakery");

  // The check says what will happen, and saves nothing.
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(note("22 rows are ready to import.")).toBeVisible();
  await expect(note(/Will add 3 clients, 5 projects, 4 people, \d+ tasks\./)).toBeVisible();
  await expect(note("Will set an hourly rate for 3 people")).toBeVisible();
  await expect(note("They will be imported as not billable").or(note("It will be imported as not billable"))).toBeVisible();
  await expect(page.getByText(/rows? (has|have) problems?/)).toHaveCount(0);
  expect(await projectNames()).not.toContain("Website Refresh");

  // Importing does it.
  await page.getByRole("button", { name: "Import 22 rows" }).click();
  await expect(note("Imported 22 rows.")).toBeVisible();
  await expect(note(/Added 3 clients, 5 projects, 4 people, \d+ tasks\./)).toBeVisible();
  const names = await projectNames();
  for (const name of ["Website Refresh", "Menu Photography", "Intake Portal", "Annual Filing Support", "Studio Admin"]) expect(names).toContain(name);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("link", { name: "Website Refresh", exact: true })).toBeVisible();

  // Checking the same file again finds every row already here.
  await page.goto("/manage/data");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(note(/22 already here and will be skipped/)).toBeVisible();
});
