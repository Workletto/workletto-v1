import { expect, test, type Page } from "@playwright/test";
import { api, expectSignedIn, ORG_NAME, seedClient, seedEntry, seedProject, signOut, unique } from "./helpers.ts";

const MEMBER_PASSWORD = "e2e-member-password";

test("invite a member: they join, sign in, and see no rates, budgets or admin settings", async ({ page, request, browser }) => {
  const name = "Maya Member";
  const email = `${unique("maya").replace(/\W/g, "")}@example.com`;
  const project = await seedProject(request, {
    name: unique("Rated Project"),
    clientId: (await seedClient(request)).id,
    hourlyRate: 12000,
    budgetAmount: 800000,
  });
  await seedEntry(request, { projectId: project.id, date: "2026-02-11", minutes: 60 });

  // The admin invites her and copies the link.
  await page.goto("/manage/people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Send this link to Maya Member")).toBeVisible();
  const link = await page.getByLabel("Invite link").inputValue();
  expect(link).toMatch(/\/invite\/[\w-]+$/);
  await expect(page.getByRole("listitem").filter({ hasText: email })).toContainText("Link works until");

  // She follows it in her own browser, chooses a password and is signed in.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const member = await context.newPage();
  // The donation card is for admins only (WRK-168): a member's app never even asks for it.
  const donationAsks: string[] = [];
  member.on("request", (r) => r.url().includes("/api/settings/about/donation") && donationAsks.push(r.url()));
  await member.goto(new URL(link).pathname);
  await expect(member.getByRole("heading", { level: 1, name: `Join ${ORG_NAME}` })).toBeVisible();
  await member.getByLabel("Password", { exact: true }).fill(MEMBER_PASSWORD);
  await member.getByRole("button", { name: "Join" }).click();
  await expectSignedIn(member);

  // She signs out and back in with her password.
  await signOut(member);
  await member.getByLabel("Email", { exact: true }).fill(email);
  await member.getByLabel("Password", { exact: true }).fill(MEMBER_PASSWORD);
  await member.getByRole("button", { name: "Sign in" }).click();
  await expectSignedIn(member);

  await expectNoAdminOrMoney(member, project);
  await member.goto("/");
  await expect(member.getByRole("heading", { level: 1 })).toBeVisible();
  expect(donationAsks).toEqual([]);

  // On a project limited to chosen people she is told so, not that everyone can track time.
  const { user } = await api<{ user: { id: string } }>(member.request, "GET", "/api/me");
  const limited = await api<{ project: { id: string } }>(request, "POST", "/api/projects", { name: unique("Limited Project"), everyone: false, memberIds: [user.id] });
  await member.goto(`/projects/${limited.project.id}`);
  await expect(member.getByText("Only these people can track time here.")).toBeVisible();
  await expect(member.getByText("Everyone can track time")).toHaveCount(0);
  await member.goto(`/projects/${project.id}`);
  await expect(member.getByText("Everyone can track time on this project.")).toBeVisible();

  // The invite link works once.
  const reused = await context.newPage();
  await reused.goto(new URL(link).pathname);
  await expect(reused.getByRole("heading", { level: 1, name: "This link doesn't work" })).toBeVisible();
  await context.close();

  // The admin's list now shows her once, as a member who has joined.
  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: email });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("combobox", { name: /^Role for / })).toHaveText("Member");
});

async function expectNoAdminOrMoney(page: Page, project: { id: string; name: string }) {
  // The menu has no Invoices or Manage.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Projects" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Invoices" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Manage" })).toHaveCount(0);

  // She sees the project, but not its settings, rate or budget.
  await nav.getByRole("link", { name: "Projects" }).click();
  await page.getByRole("link", { name: project.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  await expect(page.getByText("Hours tracked")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  for (const hidden of ["Billable amount", "Budget", "an hour", "$"]) await expect(page.locator("main").getByText(hidden)).toHaveCount(0);

  // Typing the address of a page she may not open (or one that doesn't exist) shows "Page not found",
  // with nothing about what would be there and no item of the navigation highlighted.
  for (const path of ["/team", "/manage/settings", "/manage/people", "/manage/appearance", "/manage/email", "/clients", "/manage/security", "/manage/payments", "/manage/about", "/invoices", "/nope"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText("Page not found");
    await expect(page.getByText("This address doesn't exist, or you don't have access to it."), path).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).locator('[aria-current="page"]'), path).toHaveCount(0);
    await expect(page.getByLabel("Project hourly rate"), path).toHaveCount(0);
    await expect(page.getByLabel("Budget amount"), path).toHaveCount(0);
  }
  // The way out is her time, at the front address.
  await page.getByRole("link", { name: "Go to your time" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Time" })).toHaveAttribute("aria-current", "page");
  // A project's settings are not hers either: she gets the project overview.
  await page.goto(`/projects/${project.id}/settings`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(project.name);
  await expect(page.getByLabel("Project hourly rate")).toHaveCount(0);
  await expect(page.getByLabel("Budget amount")).toHaveCount(0);

  // Reports show her hours without money.
  await page.goto("/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.locator("main").getByText("Billable amount")).toHaveCount(0);

  // The server holds the line too, not just the screens.
  const { project: shown } = await api<{ project: Record<string, unknown> }>(page.request, "GET", `/api/projects/${project.id}`);
  for (const key of ["hourlyRate", "budgetBy", "budgetAmount", "budgetSeconds", "billBy"]) expect(shown, key).not.toHaveProperty(key);
  expect((await page.request.get("/api/invoices")).status()).toBe(403);
  expect((await page.request.get("/api/people")).status()).toBe(403);
  expect((await page.request.put("/api/settings/appearance", { data: { accentColor: "#ff0000", colorMode: "dark" } })).status()).toBe(403);
}
