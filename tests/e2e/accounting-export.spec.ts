import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { api, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// Invoices as a file Xero imports (WRK-137): sent invoices of a period, one row per line.
test("sent invoices download as a file for Xero", async ({ page, request }) => {
  const client = await seedClient(request, unique("Northwind"));
  const project = await seedProject(request, { name: unique("Site"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: "2026-03-10", minutes: 90, notes: "Build" });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: "2026-03-12", to: "2026-03-10" });
  await api(request, "PATCH", `/api/invoices/${invoice.id}`, { status: "sent" });

  await page.goto("/invoices");
  const section = page.getByRole("heading", { name: "Export for accounting" }).locator("xpath=..");
  await section.getByLabel("Issued from").fill("2026-03-01");
  await section.getByLabel("To", { exact: true }).fill("2026-03-31");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download for Xero" }).click()]);
  expect(download.suggestedFilename()).toBe("invoices-xero-2026-03-01-to-2026-03-31.csv");
  const text = await readFile((await download.path())!, "utf8");
  expect(text.split("\r\n")[0]).toMatch(/^\*ContactName,EmailAddress,/);
  // 1.5 hours at $100: one row, with the client, the dates as Xero wants them and the amount.
  const row = text.split("\r\n").find((line) => line.startsWith(client.name))!;
  expect(row).toContain(",12/03/2026,");
  expect(row).toContain(",1.5,100,");
});
