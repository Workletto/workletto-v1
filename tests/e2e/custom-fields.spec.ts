import { expect, test } from "@playwright/test";
import { api, choose, seedProject, unique } from "./helpers.ts";

// Custom fields (WRK-148): add a "Phase" list field to time entries, fill it in on an entry, and
// group a report by it.
const DAY = "2026-09-14";

test("add a list field, use it on a time entry, and group a report by it", async ({ page, request }) => {
  const name = unique("Phase").replace(/\s/g, "");
  const project = await seedProject(request, { name: unique("Fields Project") });

  await page.goto("/manage/settings");
  const section = page.getByRole("region", { name: "Custom fields" }).or(page.locator("section", { has: page.getByRole("heading", { name: "Custom fields" }) })).first();
  await section.getByLabel("Field name").fill(name);
  await choose(section.getByLabel("On", { exact: true }), "Time entries");
  await choose(section.getByLabel("Type", { exact: true }), "A list of choices");
  await section.getByLabel("Choices, one per line").fill("Discovery\nDesign\nBuild");
  await section.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
  await expect(section.getByText(`${name} on time entries: Discovery, Design, Build`)).toBeVisible();

  // On the day view, the new entry form has the field.
  await page.goto(`/time/day/${DAY}`);
  await choose(page.getByLabel("Project", { exact: true }), project.name);
  await page.getByLabel("Duration").fill("1:30");
  await choose(page.getByLabel(name, { exact: true }), "Design");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByText(`Saved 1:30 for ${project.name}.`)).toBeAttached();

  // The report groups by it.
  await page.goto(`/reports?projectId=${project.id}`);
  await choose(page.getByLabel("Period", { exact: true }), "Custom dates");
  await page.getByLabel("From", { exact: true }).fill(DAY);
  await page.getByLabel("To", { exact: true }).fill(DAY);
  await page.getByRole("radio", { name }).click();
  const table = page.getByRole("region", { name: `${name} report` });
  await expect(table.getByRole("row", { name: /Design/ })).toContainText("1:30");

  // Removed, it's gone from the form; the value stays.
  const fields = await api<{ fields: { id: string; name: string }[] }>(request, "GET", "/api/custom-fields");
  const id = fields.fields.find((f) => f.name === name)!.id;
  await api(request, "PATCH", `/api/custom-fields/${id}`, { archived: true });
  await page.goto(`/time/day/${DAY}`);
  await expect(page.getByLabel("Duration")).toBeVisible();
  await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
});
