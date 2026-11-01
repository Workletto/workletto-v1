import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { api, expectSignedIn, seedClient, seedProject, today, unique } from "./helpers.ts";

const PASSWORD = "e2e-person-password";
// A real 1 x 1 pixel PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

/** Invites someone as `role`, follows the invite in a fresh browser and returns their signed-in page and API access. */
async function joinAs(browser: Browser, admin: APIRequestContext, role: "manager" | "member", name: string) {
  const email = `${unique(role).replace(/\W/g, "")}@example.com`;
  const { token } = await api<{ token: string }>(admin, "POST", "/api/people/invites", { name, email, role });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const accepted = await context.request.post("/api/invites/accept", { data: { token, name, password: PASSWORD } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  const page = await context.newPage();
  await page.goto("/");
  await expectSignedIn(page);
  return { page, request: context.request, context };
}

test("an admin sees a rate change in History, with the old and new values", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("History Project"), clientId: (await seedClient(request)).id, hourlyRate: 9550 });

  await page.goto(`/projects/${project.id}/settings`);
  await page.getByLabel("Project hourly rate").fill("120.00");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.goto("/manage/history");
  await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
  const event = page.getByRole("listitem").filter({ hasText: project.name }).filter({ hasText: "$95.50 → $120.00" });
  await expect(event).toHaveCount(1);
  await expect(event).toContainText("Ada Admin changed a project");
  await expect(event).toContainText("Hourly rate: $95.50 → $120.00");

  // The filters narrow the list.
  await page.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Invoices", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: project.name })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: project.name }).first()).toBeVisible();
  await page.getByLabel("From").fill("2000-01-01");
  await page.getByLabel("To").fill("2000-01-02");
  await expect(page.getByText("No changes match these filters.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", /\/api\/history\/export\?kind=project&since=.+&until=.+/);
});

test("History is for admins only", async ({ browser, request }) => {
  const manager = await joinAs(browser, request, "manager", "Mia Manager");
  await expect(manager.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Manage" })).toBeVisible();
  await manager.page.goto("/manage/history");
  await expect(manager.page.getByRole("heading", { level: 1 })).not.toHaveText("History");
  expect((await manager.request.get("/api/history")).status()).toBe(403);
  await manager.context.close();
});

test("a manager sees the 80% budget badge once a member's time gets there", async ({ browser, request }) => {
  const project = await seedProject(request, { name: unique("Budget Project") });
  const manager = await joinAs(browser, request, "manager", "Max Manager");
  const member = await joinAs(browser, request, "member", "Maya Member");

  // The manager sets a one-hour budget; the member adds 50 minutes.
  await api(manager.request, "PATCH", `/api/projects/${project.id}`, { budgetBy: "hours", budgetSeconds: 3600 });
  await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: today(), seconds: 50 * 60, notes: "", billable: true });

  await manager.page.goto("/projects");
  const row = manager.page.getByRole("listitem").filter({ hasText: project.name });
  await expect(row).toContainText("80% of budget");
  await manager.page.getByRole("link", { name: project.name, exact: true }).click();
  await expect(manager.page.getByText("(past the 80% alert)")).toBeVisible();

  // The member sees no badge.
  await member.page.goto("/projects");
  await expect(member.page.getByRole("listitem").filter({ hasText: project.name })).toBeVisible();
  await expect(member.page.getByText("80% of budget")).toHaveCount(0);

  // More time takes it past 100%.
  await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: today(), seconds: 20 * 60, notes: "", billable: true });
  await manager.page.goto("/projects");
  await expect(manager.page.getByRole("listitem").filter({ hasText: project.name })).toContainText("Budget used");
  await manager.context.close();
  await member.context.close();
});

test("a member attaches a receipt to an expense, opens it and removes it", async ({ browser, request }) => {
  const project = await seedProject(request, { name: unique("Receipt Project") });
  const member = await joinAs(browser, request, "member", "Rae Member");
  const page: Page = member.page;
  const { expense } = await api<{ expense: { id: string } }>(member.request, "POST", "/api/expenses", {
    projectId: project.id, date: today(), category: "Train", amount: 4250, notes: "", billable: true,
  });

  await page.goto("/expenses");
  const row = page.getByRole("listitem").filter({ hasText: "Train" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: /^Receipt/ })).toHaveCount(0);

  // Attach a photo.
  await row.getByRole("button", { name: /^More actions/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Attach receipt" }).click();
  await (await chooser).setFiles({ name: "train.png", mimeType: "image/png", buffer: PNG });
  const link = row.getByRole("link", { name: /^Receipt/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `/api/expenses/${expense.id}/receipt`);
  const opened = await member.request.get(`/api/expenses/${expense.id}/receipt`);
  expect(opened.headers()["content-type"]).toBe("image/png");

  // A file that isn't a photo or PDF is turned down with the server's message.
  await row.getByRole("button", { name: /^More actions/ }).click();
  const second = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Replace receipt" }).click();
  await (await second).setFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("not a picture") });
  await expect(row.getByText("Upload a JPEG, PNG or WebP photo, or a PDF.")).toBeVisible();

  // Remove it.
  await row.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: "Remove receipt" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row.getByRole("link", { name: /^Receipt/ })).toHaveCount(0);
  await expect.poll(async () => (await member.request.get(`/api/expenses/${expense.id}/receipt`)).status()).toBe(404);
  await member.context.close();
});
