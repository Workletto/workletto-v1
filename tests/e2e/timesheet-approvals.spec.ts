import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { api, expectSignedIn, seedProject, unique } from "./helpers.ts";
import { addDays, startOfWeek } from "../../src/shared/time.ts";

const PASSWORD = "e2e-person-password";
const today = () => new Date().toISOString().slice(0, 10);
const lastMonday = () => addDays(startOfWeek(today()), -7);

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

const setApprovals = (request: APIRequestContext, approvals: boolean) => api(request, "PUT", "/api/settings/timesheets", { approvals, timeZone: "UTC" });

test("submit a week, have it approved, reopened and edit it again", async ({ page, browser, request }) => {
  const project = await seedProject(request, { name: unique("Approval Project") });
  const week = lastMonday();
  try {
    // The admin turns approvals on in Settings.
    await page.goto("/manage/settings");
    await page.getByRole("checkbox", { name: /Ask everyone to submit their week/ }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    // The time zone is a setting of its own: Monday reminders go out at 9:00 in it (QA-29).
    await expect(page.getByText("Monday reminders go out at 9:00 in this time zone.")).toBeVisible();
    const zone = page.getByRole("combobox", { name: "Time zone" });
    await zone.click();
    await page.getByRole("option", { name: "Europe/Berlin", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    expect((await api<{ approvals: boolean; timeZone: string }>(request, "GET", "/api/settings/timesheets")).timeZone).toBe("Europe/Berlin");
    // Turning approvals off and on again keeps the zone that was saved.
    await page.getByRole("checkbox", { name: /Ask everyone to submit their week/ }).click();
    await expect(page.getByRole("checkbox", { name: /Ask everyone to submit their week/ })).not.toBeChecked();
    await page.getByRole("checkbox", { name: /Ask everyone to submit their week/ }).click();
    await expect(page.getByRole("checkbox", { name: /Ask everyone to submit their week/ })).toBeChecked();
    await page.reload();
    await expect(zone).toContainText("Europe/Berlin");
    expect(await api(request, "GET", "/api/settings/timesheets")).toEqual({ approvals: true, timeZone: "Europe/Berlin" });
    await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Approvals" })).toBeVisible();

    // Names unique to this run, so a retry in the same database finds only its own rows.
    const [maya, max] = [unique("Maya Member"), unique("Max Manager")];
    const member = await joinAs(browser, request, "member", maya);
    const manager = await joinAs(browser, request, "manager", max);

    // The member sees the reminder, and adds time in last week.
    await member.page.goto("/");
    await expect(member.page.getByText(/isn't submitted yet\./)).toBeVisible();
    await member.page.getByRole("link", { name: "Go to last week" }).click();
    await expect(member.page).toHaveURL(new RegExp(`/time/week/${week}$`));
    await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: week, seconds: 90 * 60, notes: "Layouts", billable: true });
    await member.page.reload();
    await expect(member.page.getByText(/isn't submitted yet\./)).toHaveCount(0);

    // Submitting locks the week.
    await member.page.getByRole("button", { name: "Submit week" }).click();
    await expect(member.page.getByText("Submitted", { exact: true })).toBeVisible();
    await expect(member.page.getByText("This week is submitted. Withdraw it to make changes.")).toBeVisible();
    await member.page.goto(`/time/day/${week}`);
    await expect(member.page.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
    await expect(member.page.getByRole("button", { name: "Save entry" })).toHaveCount(0);

    // The manager approves it.
    await manager.page.getByRole("link", { name: "Approvals" }).click();
    await expect(manager.page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
    const row = manager.page.getByRole("listitem").filter({ hasText: maya });
    await expect(row).toContainText("1:30");
    await row.getByRole("button", { name: /^More actions/ }).click();
    await manager.page.getByRole("menuitem", { name: "View entries" }).click();
    await expect(row).toContainText("Layouts");
    // The sidebar count follows the decision at once, without a page change (QA2-12).
    const countOf = async () => Number(((await manager.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Approvals/ }).textContent()) ?? "").replace(/\D/g, "") || 0);
    const waitingBefore = await countOf();
    expect(waitingBefore).toBeGreaterThan(0);
    await row.getByRole("button", { name: /^Approve/ }).click();
    await expect(row).toHaveCount(0); // it left Waiting once the server saved it
    await expect.poll(countOf).toBe(waitingBefore - 1);
    await manager.page.getByRole("link", { name: "Approved", exact: true }).click();
    await expect(row).toContainText(`Approved by ${max}`);

    await member.page.goto(`/time/week/${week}`);
    await expect(member.page.getByText("Approved", { exact: true })).toBeVisible();
    await expect(member.page.getByText("This week is approved. Ask a manager to reopen it to make changes.")).toBeVisible();

    // The manager reopens it, and the member can edit again.
    await row.getByRole("button", { name: /^More actions/ }).click();
    await manager.page.getByRole("menuitem", { name: "Reopen" }).click();
    await manager.page.getByRole("alertdialog").getByRole("button", { name: "Reopen" }).click();
    await expect(manager.page.getByText("Nothing here yet.")).toBeVisible();

    await member.page.goto(`/time/day/${week}`);
    await expect(member.page.getByRole("button", { name: "Submit week" })).toBeVisible();
    const entry = member.page.getByRole("listitem").filter({ hasText: "Layouts" });
    await entry.getByRole("button", { name: /^Edit/ }).click();
    const editor = member.page.getByRole("listitem").filter({ has: member.page.getByRole("button", { name: "Cancel" }) });
    await editor.getByLabel("Duration").fill("2:00");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(entry).toContainText("2:00");

    await member.context.close();
    await manager.context.close();
  } finally {
    await setApprovals(request, false);
  }
});

test("a manager sends a week back with a note, and the person submits it again", async ({ browser, request }) => {
  const project = await seedProject(request, { name: unique("Sent Back Project") });
  const week = lastMonday();
  try {
    await setApprovals(request, true);
    const [sam, mo] = [unique("Sam Member"), unique("Mo Manager")];
    const member = await joinAs(browser, request, "member", sam);
    const manager = await joinAs(browser, request, "manager", mo);
    await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: week, seconds: 3600, notes: "", billable: true });
    await api(member.request, "POST", `/api/timesheets/mine/${week}/submit`, {});

    await manager.page.goto("/approvals");
    const row = manager.page.getByRole("listitem").filter({ hasText: sam });
    await row.getByRole("button", { name: /^More actions/ }).click();
    await manager.page.getByRole("menuitem", { name: "Send back…" }).click();
    await manager.page.getByLabel(`Note for ${sam}`, { exact: false }).fill("Please add Friday");
    await manager.page.getByRole("button", { name: "Send back", exact: true }).click();
    // The week leaves Waiting once the server has saved it; only then is it on Sent back.
    await expect(row).toHaveCount(0);
    await manager.page.getByRole("link", { name: "Sent back" }).click();
    await expect(row).toContainText("Please add Friday");

    await member.page.goto(`/time/week/${week}`);
    await expect(member.page.getByText(`Sent back by ${mo}.`)).toBeVisible();
    await expect(member.page.getByText("Please add Friday")).toBeVisible();
    await member.page.getByRole("button", { name: "Submit again" }).click();
    await expect(member.page.getByText("Submitted", { exact: true })).toBeVisible();

    // Nobody decides on their own week.
    await api(manager.request, "POST", "/api/time-entries", { projectId: project.id, date: week, seconds: 600, notes: "", billable: true });
    await api(manager.request, "POST", `/api/timesheets/mine/${week}/submit`, {});
    await manager.page.goto("/approvals");
    await expect(manager.page.getByRole("listitem").filter({ hasText: mo })).toContainText("Someone else approves your week");
    // The sidebar count leaves their own week out: it counts the weeks they can act on (QA2-12).
    const actionable = await manager.page.getByRole("main").getByRole("listitem").filter({ hasNotText: "Someone else approves your week" }).filter({ has: manager.page.getByRole("button", { name: /^Approve/ }) }).count();
    expect(actionable).toBeGreaterThan(0);
    const link = manager.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Approvals/ });
    await expect(link).toContainText(`${actionable} waiting`);

    await member.context.close();
    await manager.context.close();
  } finally {
    await setApprovals(request, false);
  }
});
