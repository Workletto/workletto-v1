import { expect, test } from "@playwright/test";
import { seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// Fixed fee projects (WRK-134): set the fee on the project, bill part of it on an invoice, and
// see what's left to bill on the project.
test("a fixed fee project is billed in parts, never by the hour", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Rebrand"), clientId: client.id, hourlyRate: 15000 });

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("radio", { name: "A fixed fee, invoiced in full or in parts" }).click();
  // A money budget means nothing for a fixed fee: the option goes away.
  await expect(page.getByRole("radio", { name: "Total fees (billable amount)" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Fixed fee" }).fill("12000");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Project saved.")).toBeVisible();

  // Its time isn't billed by the hour: two hours here add nothing to bill but the fee.
  await seedEntry(request, { projectId: project.id, date: "2026-02-10", minutes: 120, notes: "Concepts" });
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("$0.00 invoiced · $12,000.00 left to bill")).toBeVisible();

  await page.goto("/invoices");
  const ready = page.getByRole("listitem").filter({ hasText: client.name });
  await expect(ready).toContainText("$12,000.00 of fixed fees left to bill");
  await expect(ready).not.toContainText("billable hours");
  await ready.getByRole("link", { name: /^Create invoice/ }).click();

  // Bill a deposit: a third of the fee.
  await page.getByRole("checkbox", { name: `Bill the ${project.name} fee` }).check();
  const amount = page.getByLabel("Amount to bill");
  await expect(amount).toHaveValue("12000.00");
  await amount.fill("4000");
  const preview = page.getByRole("region", { name: "Invoice preview" });
  await expect(preview.getByRole("row", { name: `${project.name} – fixed fee` })).toContainText("$4,000.00");
  await page.getByRole("button", { name: "Create invoice" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Invoice" })).toBeVisible();
  const invoice = page.locator("article");
  await expect(invoice.getByRole("row", { name: `${project.name} – fixed fee` })).toContainText("$4,000.00");
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText("Total$4,000.00");

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("$4,000.00 invoiced · $8,000.00 left to bill")).toBeVisible();
});
