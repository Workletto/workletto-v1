import { expect, test } from "@playwright/test";
import { choose, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// A currency per client (WRK-135): set a client's currency and exchange rate, and its invoice
// is in that currency, never converted.
test("a client billed in euros gets invoices in euros", async ({ page, request }) => {
  const client = await seedClient(request, unique("Berlin GmbH"));

  await page.goto("/clients");
  const row = page.getByRole("listitem").filter({ hasText: client.name });
  await row.getByRole("button", { name: `Edit ${client.name}` }).click();
  await choose(page.getByRole("combobox", { name: "Billed in" }), "EUR");
  await page.getByRole("textbox", { name: "1 EUR is worth" }).fill("1.08");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: client.name })).toContainText("Billed in EUR");

  // €95.50 an hour for two hours is €191.00, not converted.
  const project = await seedProject(request, { name: unique("Website"), clientId: client.id, hourlyRate: 9550 });
  await seedEntry(request, { projectId: project.id, date: "2026-02-10", minutes: 120, notes: "Design" });
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("At €95.50 an hour")).toBeVisible();

  await page.goto(`/invoices/new/${client.id}`);
  await expect(page.getByText("Includes 2:00 hours (€191.00)")).toBeVisible();
  await page.getByRole("button", { name: "Create invoice" }).click();
  const invoice = page.locator("article");
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText("Total€191.00");

  // The exchange rate can change later, in Settings; only reports use it.
  await page.goto("/manage/settings");
  await expect(page.getByRole("textbox", { name: "1 EUR is worth" })).toHaveValue("1.08");
});
