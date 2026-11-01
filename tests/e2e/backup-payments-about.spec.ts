import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { api, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

const PACKAGE_VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

test("Security & data offers a backup download that is a gzip file", async ({ page }) => {
  await page.goto("/manage/security");
  await expect(page.getByRole("heading", { level: 2, name: "Backup" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download backup" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.gz$/);
  const path = await file.path();
  const bytes = readFileSync(path);
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  expect(gunzipSync(bytes).length).toBeGreaterThan(0);
});

test("Manage → Payments shows the connect form and the server's answer to a bad key", async ({ page }) => {
  await page.goto("/manage/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Stripe" })).toBeVisible();
  await page.getByLabel("Stripe key").fill("not-a-stripe-key");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toHaveText("Paste a Stripe secret or restricted key. It starts with rk_ or sk_.");
  await expect(page.getByText(/^Connected to Stripe/)).toHaveCount(0);
});

test("an invoice has no pay link while online payments aren't connected", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Pay Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: "2026-02-10", minutes: 60 });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", {
    clientId: client.id, issueDate: "2026-02-11", dueDate: "2026-03-11", groupBy: "project", includeExpenses: false, taxPercent: 0, notes: "",
  });
  await api(request, "PATCH", `/api/invoices/${invoice.id}`, { status: "sent" });
  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByRole("button", { name: "Mark as paid" })).toBeVisible();
  await expect(page.getByText("Pay online link")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);
});

test("Manage → About shows the installed version and a diagnostics download", async ({ page }) => {
  await page.goto("/manage/about");
  await expect(page.getByRole("heading", { level: 1, name: "About" })).toBeVisible();
  await expect(page.getByText(`Version ${PACKAGE_VERSION}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/database changes applied/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download diagnostics" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^diagnostics-.*\.json$/);
  const report = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(report.app.version).toBe(PACKAGE_VERSION);
  expect(report.database).toHaveProperty("postgres");
});
