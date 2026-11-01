import type { APIRequest, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { ADMIN_STATE, api, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// What the accessibility tests look at: every page of the app, with something on it.

const SUBMITTED_WEEK = "2026-04-13";

/** Turns timesheet approvals off again, so the pages' seed data doesn't change the other specs. */
export async function endPages(playwright: { request: Pick<APIRequest, "newContext"> }, baseURL: string | undefined) {
  const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
  await request.fetch(`/api/timesheets/mine/${SUBMITTED_WEEK}/withdraw`, { method: "POST", data: {} });
  await api(request, "PUT", "/api/settings/timesheets", { approvals: false });
  await request.dispose();
}

export type Seeded = { clientId: string; projectId: string; invoiceId: string; adminId: string };

/** Makes the data the pages show: a client, a project with a rate and budget, time, tasks, an expense, an invitation and an invoice. */
export async function seedPages(playwright: { request: Pick<APIRequest, "newContext"> }, baseURL: string | undefined): Promise<Seeded> {
  const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
  const { user } = await api<{ user: { id: string } }>(request, "GET", "/api/me");
  // A second seeding finds last time's submitted week: open it again so time can be added.
  await request.fetch(`/api/timesheets/mine/${SUBMITTED_WEEK}/withdraw`, { method: "POST", data: {} });
  const client = await seedClient(request, unique("Accessible Client"));
  const project = await seedProject(request, { name: unique("Accessible Project"), clientId: client.id, hourlyRate: 10000, budgetAmount: 500000 });
  await seedEntry(request, { projectId: project.id, date: "2026-04-14", minutes: 95, notes: "Page layouts" });
  await api(request, "POST", "/api/tasks", { projectId: project.id, title: "Draft the layouts", dueDate: "2026-04-20", status: "todo" });
  await api(request, "POST", "/api/tasks", { projectId: project.id, title: "Choose fonts", status: "done" });
  const { expense } = await api<{ expense: { id: string } }>(request, "POST", "/api/expenses", { projectId: project.id, date: "2026-04-14", category: "Travel", amount: 4250, notes: "Train to the studio" });
  // A 1 x 1 pixel PNG, so the expense shows its Receipt link.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  await api(request, "PUT", `/api/expenses/${expense.id}/receipt`, png);
  await api(request, "POST", "/api/people/invites", { name: "Pending Person", email: `${unique("pending").replace(/\W/g, "")}@example.com`, role: "member" });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", {
    clientId: client.id,
    issueDate: "2026-04-15",
    dueDate: "2026-05-15",
    groupBy: "project",
    includeExpenses: true,
    taxPercent: 0,
    notes: "",
  });
  // Approvals on, with one submitted week (the admin's own), so the Approvals page has a row.
  await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
  await api(request, "POST", `/api/timesheets/mine/${SUBMITTED_WEEK}/submit`, {});
  await request.dispose();
  return { clientId: client.id, projectId: project.id, invoiceId: invoice.id, adminId: user.id };
}

export const PAGES: { name: string; path: (s: Seeded) => string; heading: string | RegExp }[] = [
  { name: "Time, day", path: () => "/time/day/2026-04-14", heading: /April 14/ },
  { name: "Time, week", path: () => "/time/week/2026-04-14", heading: /Apr 13/ },
  { name: "Expenses", path: () => "/expenses/2026-04", heading: /Expenses/ },
  { name: "Projects", path: () => "/projects", heading: "Projects" },
  { name: "Project overview", path: (s) => `/projects/${s.projectId}`, heading: /Accessible Project/ },
  { name: "Project tasks", path: (s) => `/projects/${s.projectId}/tasks`, heading: /Accessible Project/ },
  { name: "Project settings", path: (s) => `/projects/${s.projectId}/settings`, heading: /Accessible Project/ },
  { name: "Reports", path: () => "/reports", heading: "Reports" },
  { name: "Profitability", path: () => "/reports/profitability", heading: "Reports" },
  { name: "Team", path: () => "/team", heading: "Team" },
  { name: "Schedule", path: () => "/team/schedule", heading: /–/ },
  { name: "Team member's week", path: (s) => `/team/${s.adminId}/${SUBMITTED_WEEK}`, heading: /week/ },
  { name: "Invoices", path: () => "/invoices", heading: "Invoices" },
  { name: "New invoice", path: (s) => `/invoices/new/${s.clientId}`, heading: "New invoice" },
  { name: "Invoice", path: (s) => `/invoices/${s.invoiceId}`, heading: "Invoice" },
  { name: "Clients", path: () => "/clients", heading: "Clients" },
  { name: "People", path: () => "/manage/people", heading: "People" },
  { name: "Settings", path: () => "/manage/settings", heading: "Settings" },
  { name: "Invoicing", path: () => "/manage/invoices", heading: "Invoicing" },
  { name: "Appearance", path: () => "/manage/appearance", heading: "Appearance" },
  { name: "Payments", path: () => "/manage/payments", heading: "Payments" },
  { name: "About", path: () => "/manage/about", heading: "About" },
  { name: "Email", path: () => "/manage/email", heading: "Email" },
  { name: "Security & data", path: () => "/manage/security", heading: "Security & data" },
  { name: "History", path: () => "/manage/history", heading: "History" },
  { name: "Approvals", path: () => "/approvals", heading: "Approvals" },
  { name: "Tasks", path: () => "/manage/tasks", heading: "Tasks" },
  { name: "Templates", path: () => "/manage/templates", heading: "Templates" },
  { name: "Import from calendar", path: () => "/time/calendar/2026-11-02", heading: "Import from calendar" },
  { name: "Two-factor sign-in", path: () => "/account/two-factor", heading: "Two-factor sign-in" },
  { name: "Import & export", path: () => "/manage/data", heading: "Import & export" },
  { name: "Page not found", path: () => "/no-such-page", heading: "Page not found" },
];


/** Opens a page and waits until it has finished loading. */
export async function openPage(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  await expect(page.getByText("Loading…")).toHaveCount(0);
}
