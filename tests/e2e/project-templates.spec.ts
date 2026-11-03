import { expect, test } from "@playwright/test";
import { api, choose, seedClient, unique } from "./helpers.ts";

// Project templates (WRK-150): save a project's settings and tasks, start a new project from them,
// then rename and delete the template in Manage → Templates.
test("save a project as a template, start a new project from it, then rename and delete it", async ({ page, request }) => {
  const acme = await seedClient(request, unique("Acme"));
  const globex = await seedClient(request, unique("Globex"));
  const { project } = await api<{ project: { id: string } }>(request, "POST", "/api/projects", { name: unique("Retainer"), clientId: acme.id, fixedFee: 900_000, budgetBy: "hours", budgetSeconds: 40 * 3600 });
  await api(request, "POST", "/api/tasks", { projectId: project.id, title: "Discovery" });
  const templateName = unique("Monthly retainer");

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("button", { name: "Save as template" }).click();
  await page.getByLabel("Template name").fill(templateName);
  await page.getByRole("button", { name: "Save template" }).click();
  // The visible message; the screen reader announcement says only its first sentence.
  await expect(page.getByText(/^Saved as a template\. Start new projects/)).toBeVisible();

  await page.goto("/projects");
  const newName = unique("Globex retainer");
  await page.getByLabel("Project name").fill(newName);
  await choose(page.getByLabel("Client", { exact: true }), globex.name);
  await choose(page.getByLabel("Start from a template"), templateName);
  await expect(page.getByText(/^Fixed fee · Hours budget · \d+ tasks? · Everyone$/)).toBeVisible();
  await page.getByRole("button", { name: "Add project" }).click();

  // The new project's settings are the template's, with the client chosen here.
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(newName);
  await expect(page.getByRole("radio", { name: "A fixed fee, invoiced in full or in parts" })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Fixed fee" })).toHaveValue("9000.00");
  await expect(page.getByLabel("Budget in hours")).toHaveValue("40");
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: /^Tasks/ }).click();
  await expect(page.getByRole("checkbox", { name: "Mark Discovery as done" })).toBeVisible();

  await page.goto("/manage/templates");
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
  await page.getByRole("button", { name: `More actions for ${templateName}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renamed = unique("Retainer template");
  await page.getByLabel("Template name").fill(renamed);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `More actions for ${renamed}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(renamed, { exact: true })).toBeHidden();
});
