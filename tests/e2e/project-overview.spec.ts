import { expect, test } from "@playwright/test";
import { seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// WRK-126: the project page shows its open tasks, the latest time, who worked on it and, for
// admins and managers, what it earned and cost; New invoice starts an invoice for its client.
test("the project overview shows recent time, the team's hours and profitability, and starts an invoice", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Overview Project"), clientId: client.id, hourlyRate: 12000 });
  const notes = unique("Storyboards");
  await seedEntry(request, { projectId: project.id, date: "2026-05-04", minutes: 90, notes });

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(project.name);

  const recent = page.locator("section", { has: page.getByRole("heading", { name: "Recent time" }) });
  await expect(recent.getByRole("listitem").filter({ hasText: notes })).toContainText("1:30");

  const team = page.locator("section", { has: page.getByRole("heading", { name: "Team" }) });
  await expect(team.getByRole("listitem").first()).toContainText("1:30");
  // Only people with time are listed, no rows of 0:00 (QA2-21); and the row's text is one size.
  await expect(team.getByRole("listitem")).toHaveCount(1);
  await expect(team).not.toContainText("0:00");
  const sizes = await recent.getByRole("listitem").filter({ hasText: notes }).locator(".rt-Text").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
  expect(new Set(sizes).size).toBe(1);

  // Reports opens on this project.
  await recent.getByRole("link", { name: "See this project in Reports" }).click();
  await expect(page).toHaveURL(new RegExp(`/reports\\?projectId=${project.id}$`));
  await expect(page.getByRole("combobox", { name: "Project" })).toContainText(project.name);
  await page.goBack();

  // 1.5 hours at $120.00: $180.00 earned.
  const profit = page.locator("section", { has: page.getByRole("heading", { name: "Profitability" }) });
  await expect(profit).toContainText("Revenue");
  await expect(profit).toContainText("$180.00");

  await page.getByRole("link", { name: `New invoice for ${client.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/invoices/new/${client.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "New invoice" })).toBeVisible();
});

test("a project nobody has tracked time on says so in its Team card (QA2-21)", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Quiet Project") });
  await page.goto(`/projects/${project.id}`);
  const team = page.locator("section", { has: page.getByRole("heading", { name: "Team" }) });
  await expect(team.getByText("No time yet.")).toBeVisible();
  await expect(team.getByRole("listitem")).toHaveCount(0);
});
