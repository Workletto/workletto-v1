import { expect, test } from "@playwright/test";
import { api, choose, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// Findings QA-35 to QA-57 that show on screen.

test("an export with the dates the wrong way round saves nothing and says why (QA-39)", async ({ page }) => {
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.goto("/manage/data");
  await page.getByLabel("From", { exact: true }).first().fill("2026-12-31");
  await page.getByLabel("To", { exact: true }).first().fill("2026-01-01");
  await page.getByRole("button", { name: "Time entries" }).click();
  await expect(page.getByRole("alert")).toHaveText("The start date is after the end date.");
  await page.waitForTimeout(500);
  expect(downloads).toEqual([]);
  // With sensible dates the file is saved.
  await page.getByLabel("From", { exact: true }).first().fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).first().fill("2026-12-31");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Time entries" }).click();
  expect((await download).suggestedFilename()).toBe("time-2026-01-01-to-2026-12-31.csv");
});

test("an accent color that isn't a color is called out (QA-41)", async ({ page }) => {
  await page.goto("/manage/appearance");
  const hex = page.getByLabel("Accent color as a hex code");
  await hex.fill("red");
  await hex.press("Tab");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter a color like #2f5bd3.")).toBeVisible();
  await hex.fill("#2f5bd3");
  await expect(page.getByText("Enter a color like #2f5bd3.")).toHaveCount(0);
  await expect(hex).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Reset to default" }).click();
});

test("dates the wrong way round get a message in Reports and on a new invoice (QA-43)", async ({ page, request }) => {
  await page.goto("/reports");
  await choose(page.getByRole("combobox", { name: "Period" }), "Custom dates");
  await page.getByLabel("From", { exact: true }).fill("2026-10-15");
  await page.getByLabel("To", { exact: true }).fill("2026-10-10");
  await expect(page.getByText("The start date is after the end date.")).toBeVisible();
  await expect(page.getByText("Choose a start and end date")).toHaveCount(0);
  await expect(page.getByText("Billable hours")).toHaveCount(0);
  await page.getByLabel("To", { exact: true }).fill("2026-10-20");
  await expect(page.getByText("The start date is after the end date.")).toHaveCount(0);
  await expect(page.getByText("Billable hours")).toBeVisible();

  const client = await seedClient(request, unique("Dates Client"));
  await page.goto(`/invoices/new/${client.id}`);
  await page.getByRole("radio", { name: "Only between two dates" }).check();
  await page.getByLabel("From", { exact: true }).fill("2026-10-20");
  await page.getByLabel("To", { exact: true }).fill("2026-10-10");
  await expect(page.getByText("The start date is after the end date.")).toBeVisible();
  await expect(page.getByText("Nothing to bill for this client in that period.")).toHaveCount(0);
});

test("tab titles tell the two reports apart (QA-48)", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page).toHaveTitle(/^Reports · /);
  await page.goto("/reports/profitability");
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page).toHaveTitle(/^Profitability · /);
});

test("a draft invoice: discount larger than the subtotal, unsaved changes, and the currency list once invoices exist (QA-38, QA-44, QA-46)", async ({ page, request }) => {
  const client = await seedClient(request, unique("Draft Client"));
  const project = await seedProject(request, { name: unique("Draft Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: "2026-04-14", minutes: 60 });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", {
    clientId: client.id, issueDate: "2026-04-15", dueDate: "2026-05-15", groupBy: "project", includeExpenses: false, taxPercent: 0, notes: "",
  });
  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByText("Save changes to update the invoice below.")).toHaveCount(0);
  await choose(page.getByRole("combobox", { name: "Discount as" }), "USD");
  await page.getByLabel("Discount", { exact: true }).fill("100000");
  await expect(page.getByText("The discount is more than the subtotal, so it's reduced to $100.00.")).toBeVisible();
  await expect(page.getByText("Save changes to update the invoice below.")).toBeVisible();
  await page.getByLabel("Discount", { exact: true }).fill("20");
  await expect(page.getByText("The discount is more than the subtotal")).toHaveCount(0);

  // With an invoice in the books the currency can't change: the list says so before anyone tries.
  await page.goto("/manage/settings");
  await expect(page.getByRole("combobox", { name: "Currency" })).toBeDisabled();
  await expect(page.getByText("The currency can't change once there are invoices or expenses.")).toBeVisible();
});

test("every screen has a ? to its own article (QA-52, QA-53)", async ({ page, request }) => {
  const client = await seedClient(request, unique("Help Client"));
  const project = await seedProject(request, { name: unique("Help Project"), clientId: client.id });
  await seedEntry(request, { projectId: project.id, date: "2026-04-14", minutes: 30 });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", {
    clientId: client.id, issueDate: "2026-04-15", dueDate: "2026-05-15", groupBy: "project", includeExpenses: false, taxPercent: 0, notes: "",
  });
  const pages: [string, string][] = [
    ["/", "time-tracking/track-time"],
    ["/projects", "projects-and-tasks/projects"],
    [`/projects/${project.id}`, "projects-and-tasks/projects"],
    [`/projects/${project.id}/tasks`, "projects-and-tasks/projects"],
    [`/projects/${project.id}/settings`, "projects-and-tasks/projects"],
    ["/clients", "clients/add-and-manage-clients"],
    ["/reports", "reports/time-reports"],
    ["/manage/settings", "customization/brand-your-app"],
    ["/manage/appearance", "customization/brand-your-app"],
    ["/manage/security", "hosting-and-maintenance/back-up-and-restore"],
    ["/manage/data", "import-and-export/export-your-data"],
    ["/invoices", "invoicing-and-payments/create-an-invoice"],
    [`/invoices/${invoice.id}`, "invoicing-and-payments/create-an-invoice"],
    // WRK-67: the rest of the screens with an article.
    ["/expenses", "expenses/receipts"],
    ["/time-off", "team-and-permissions/time-off"],
    ["/team", "team-and-permissions/team-page"],
    ["/team/schedule", "team-and-permissions/schedule"],
    ["/reports/profitability", "reports/profitability"],
    ["/manage/tasks", "projects-and-tasks/company-wide-tasks"],
    ["/manage/people", "getting-started/invite-your-team"],
    ["/manage/invoices", "invoicing-and-payments/invoice-settings"],
    ["/manage/payments", "invoicing-and-payments/online-payments"],
    ["/manage/email", "hosting-and-maintenance/send-email-from-the-app"],
    ["/manage/history", "team-and-permissions/audit-history"],
    ["/manage/about", "hosting-and-maintenance/about-and-diagnostics"],
  ];
  for (const [path, article] of pages) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: /^Help for this page/ }), path).toHaveAttribute("href", new RegExp(`/help/${article}$`));
  }
  // Once it has gone out, the invoice's article is about sending it.
  await api(request, "PATCH", `/api/invoices/${invoice.id}`, { status: "sent" });
  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByRole("link", { name: /^Help for this page/ })).toHaveAttribute("href", /\/help\/invoicing-and-payments\/email-an-invoice$/);
});

test("a settings page asks before leaving with unsaved changes (QA-63)", async ({ page }) => {
  await page.goto("/manage/settings");
  const name = page.getByLabel("Company name");
  await expect(name).toBeVisible();
  await name.fill(`${await name.inputValue()} changed`);
  // Staying keeps the page and the typing.
  const messages: string[] = [];
  page.once("dialog", (d) => { messages.push(d.message()); void d.dismiss(); });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects" }).click();
  expect(messages).toEqual(["Leave without saving your changes?"]);
  await expect(page).toHaveURL(/\/manage\/settings$/);
  // Leaving goes on.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("long notes on a time entry are cut after four lines, with a button for the rest (QA-61)", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Notes Project") });
  const notes = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the notes`).join("\n");
  await seedEntry(request, { projectId: project.id, date: "2026-03-10", minutes: 45, notes });
  await page.goto("/time/day/2026-03-10");
  const row = page.getByRole("listitem").filter({ hasText: project.name });
  const toggle = row.getByRole("button", { name: "Show all" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(row.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  await row.getByRole("button", { name: "Show less" }).click();
  await expect(row.getByRole("button", { name: "Show all" })).toBeVisible();
});

test("the tab's icon is a plain clock until the organization has a logo (QA-62)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/icon.svg");
  expect((await page.request.get("/robots.txt")).status()).toBe(200);
  expect((await page.request.get("/favicon.ico")).status()).toBe(404);
});

test("submitting a week with no time asks first (QA-68)", async ({ page, request }) => {
  try {
    await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
    await page.goto("/time/week/2025-01-08");
    await page.getByRole("button", { name: "Submit week" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Submit a week with no time?");
    await expect(dialog).toContainText("Do this only if you didn't work that week.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Submit week" })).toBeVisible();
  } finally {
    await api(request, "PUT", "/api/settings/timesheets", { approvals: false, timeZone: "UTC" });
  }
});

test("in the phone Menu, Change password and Sign out look like the links (QA-66)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Main" });
  const measure = (name: string) => nav.getByRole(name === "Projects" ? "link" : "button", { name }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { height: s.height, font: `${s.fontFamily}|${s.fontSize}|${s.fontWeight}`, color: s.color, bg: s.backgroundColor, left: s.paddingLeft, border: s.borderTopWidth, align: s.textAlign };
  });
  const link = await measure("Projects");
  for (const name of ["Change password", "Sign out"]) {
    const button = await measure(name);
    expect({ ...button, align: "" }).toEqual({ ...link, align: "" });
  }
});
