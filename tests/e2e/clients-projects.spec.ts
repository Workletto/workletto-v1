import { expect, test } from "@playwright/test";
import { choose, unique } from "./helpers.ts";

test("create a client, then a project with an hourly rate and a budget", async ({ page }) => {
  const client = unique("Bluebird Bakery");
  const project = unique("Website Refresh");

  // The client.
  await page.goto("/clients");
  await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
  await page.getByLabel("Client name").fill(client);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: client })).toContainText("0 projects");

  // The same name again (in other capitals) is refused (QA-49). The form clears after a save;
  // wait for that, so the clearing can't wipe what's typed next.
  await expect(page.getByLabel("Client name")).toHaveValue("");
  await page.getByLabel("Client name").fill(client.toUpperCase());
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByRole("alert")).toHaveText(`There's already a client called ${client.toUpperCase()}.`);
  await page.getByLabel("Client name").fill("x");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The project, for that client.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await page.getByLabel("Project name").fill(project);
  await choose(page.getByRole("combobox", { name: /^Client/ }), client);
  await page.getByRole("button", { name: "Add project" }).click();

  // Adding a project opens its settings: one hourly rate, and a budget in fees.
  await expect(page).toHaveURL(/\/projects\/[\w-]+\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: project })).toBeVisible();
  await page.getByLabel("Project hourly rate").fill("95.50");
  await page.getByRole("radio", { name: /^Total fees/ }).check();
  await page.getByLabel("Budget amount").fill("5000");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // It is still there after a reload ...
  await page.reload();
  await expect(page.getByLabel("Project hourly rate")).toHaveValue("95.50");
  await expect(page.getByLabel("Budget amount")).toHaveValue("5000.00");

  // Text that isn't an amount is refused with a message; the saved rate stays (QA-35).
  await page.getByLabel("Project hourly rate").fill("abc");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter amounts like 120 or 95.50.");
  await expect(page.getByLabel("Project hourly rate")).toHaveAttribute("aria-invalid", "true");
  await page.reload();
  await expect(page.getByLabel("Project hourly rate")).toHaveValue("95.50");
  // A budget in hours may be written 40:30 or 40.5, with no 24-hour cap (QA-36).
  await page.getByRole("radio", { name: /^Total hours/ }).check();
  await page.getByLabel("Budget in hours").fill("40:30");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Budget in hours")).toHaveValue("40.5");
  await page.getByRole("radio", { name: /^Total fees/ }).check();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // ... and the overview shows the rate and the budget.
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("At $95.50 an hour")).toBeVisible();
  await expect(page.getByText("$0.00 of $5,000.00")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Budget used" })).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByText(client, { exact: true })).toBeVisible();

  // The client now counts the project.
  await page.goto("/clients");
  await expect(page.getByRole("listitem").filter({ hasText: client })).toContainText("1 project");
});
