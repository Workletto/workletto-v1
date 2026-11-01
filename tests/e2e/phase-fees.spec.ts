import { expect, test } from "@playwright/test";
import { api, seedClient, unique } from "./helpers.ts";

// Fixed fees per phase (WRK-151): switch a fixed fee project to a fee per phase, set each phase's
// fee, and bill part of one phase on a new invoice.
test("set a fee per phase and bill part of one phase", async ({ page, request }) => {
  const client = await seedClient(request, unique("City Library"));
  const name = unique("Library");
  const { project } = await api<{ project: { id: string } }>(request, "POST", "/api/projects", { name, clientId: client.id, fixedFee: 100_000 });
  await api(request, "POST", "/api/tasks", { projectId: project.id, title: "Schematic Design" });
  await api(request, "POST", "/api/tasks", { projectId: project.id, title: "Design Development" });

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByRole("checkbox", { name: /^Fee per phase/ }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Project saved.")).toBeVisible();
  await page.getByLabel("Schematic Design fee").fill("12500.50");
  await page.getByLabel("Design Development fee").fill("20000.25");
  await page.getByRole("button", { name: "Save phase fees" }).click();
  await expect(page.getByText("Phase fees saved.").and(page.locator(":not([role=status])"))).toBeVisible();
  await expect(page.getByText(/Fixed fee: \$32,500\.75, the sum of the phases below\./)).toBeVisible();

  await page.goto(`/projects/${project.id}`);
  const phases = page.getByRole("region", { name: "Phases" });
  await expect(phases.getByRole("row", { name: /Schematic Design/ })).toContainText("$12,500.50");

  await page.goto(`/invoices/new/${client.id}`);
  await page.getByRole("checkbox", { name: `Bill the ${name} – Schematic Design fee` }).click();
  await page.getByLabel("Amount to bill").fill("6250.25");
  await page.getByRole("button", { name: "Create invoice" }).click();
  const invoice = page.locator("article");
  await expect(invoice.getByRole("rowheader", { name: `${name} – Schematic Design – fixed fee`, exact: true })).toBeVisible();
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText("Total$6,250.25");
});
