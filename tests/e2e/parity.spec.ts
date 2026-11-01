import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { api, choose, dollars, expectSignedIn, seedEntry, seedProject, today, unique } from "./helpers.ts";
import { addDays, startOfWeek } from "../../src/shared/time.ts";

// The Team page, cost rates and capacity, profitability, company-wide tasks and bulk approval.

const PASSWORD = "e2e-person-password";

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
  const { user } = await api<{ user: { id: string } }>(context.request, "GET", "/api/me");
  return { page, request: context.request, context, id: user.id };
}

const nav = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Main" });

test("the Team page shows a week's hours against capacity and opens a person's week; members don't see it", async ({ page, browser, request }) => {
  const project = await seedProject(request, { name: unique("Team Project") });
  const name = unique("Tess Teammate");
  const member = await joinAs(browser, request, "member", name);
  const notes = unique("Team page notes");
  await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: today(), seconds: 2 * 3600, notes, billable: true });

  await page.goto("/");
  await nav(page).getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  // Hours are written as on Time (H:MM, no " h"), and the band's bar sits inside its card with a caption (QA2-19).
  await expect(page.getByText(/^of \d+:\d\d capacity$/)).toBeVisible();
  await expect(page.locator(".wl-stats-band .wl-capbar")).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText(/\d:\d\d h\b/);
  await page.getByLabel("Filter by name").fill(name);
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  // 2 of 40 hours is 5%.
  await expect(row).toContainText("2:00");
  await expect(row).toContainText("Utilization 5%");
  await expect(row).toContainText("Capacity 40:00");
  await expect(row.getByRole("img")).toHaveAttribute("aria-label", "2:00 of 40:00 hours, 2:00 billable");

  // Changing the week changes the address.
  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(page).toHaveURL(new RegExp(`/team/${addDays(startOfWeek(today()), -7)}$`));
  await page.getByRole("button", { name: "This week" }).click();
  await expect(page).toHaveURL(/\/team$/);

  // Their week, read only, with the entry.
  await row.getByRole("link", { name: /^Timesheet/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name}'s week` })).toBeVisible();
  await expect(page.getByText(notes)).toBeVisible();
  await expect(page.getByText("Total")).toBeVisible();
  await page.locator("#main").getByRole("link", { name: "Team", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();

  // A member has no link, and the address shows the usual page instead.
  await expect(nav(member.page).getByRole("link", { name: "Team" })).toHaveCount(0);
  await member.page.goto("/team");
  await expect(member.page.getByRole("heading", { level: 1, name: "Team" })).toHaveCount(0);
  await member.context.close();
});

test("an admin sets a cost rate and the hours a week; the Team page uses the new capacity", async ({ page, browser, request }) => {
  const name = unique("Cass Capacity");
  const member = await joinAs(browser, request, "member", name);
  await member.context.close();

  await page.goto("/manage/people");
  const row = page.getByRole("listitem").filter({ hasText: name });
  await row.getByRole("button", { name: /^Edit/ }).click();
  const form = page.getByRole("form", { name: `Edit ${name}` });
  await form.getByLabel("Cost rate (per hour)").fill("55");
  await form.getByLabel("Hours a week").fill("37.5");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Cost $55.00/h");

  await page.goto("/team");
  await page.getByLabel("Filter by name").fill(name);
  await expect(page.getByRole("listitem").filter({ hasText: name })).toContainText("Capacity 37:30");

  // A rate that isn't a number is explained, and nothing is saved.
  await page.goto("/manage/people");
  await row.getByRole("button", { name: /^Edit/ }).click();
  await form.getByLabel("Hours a week").fill("lots");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Enter the hours a week as a number/)).toBeVisible();
});

test("profitability shows revenue, cost and profit to the cent; managers don't get the team breakdown", async ({ page, browser, request }) => {
  const project = await seedProject(request, { name: unique("Profit Project"), hourlyRate: 10000 });
  const member = await joinAs(browser, request, "member", unique("Pat Profit"));
  const manager = await joinAs(browser, request, "manager", unique("Mel Manager"));
  await api(request, "PATCH", `/api/people/${member.id}`, { costRate: 4000 });
  // 90 minutes billed at $100 an hour is $150.00; at $40 an hour it costs $60.00.
  await api(member.request, "POST", "/api/time-entries", { projectId: project.id, date: today(), seconds: 90 * 60, notes: "", billable: true });

  const open = async (p: typeof page) => {
    await p.goto("/reports/profitability");
    await expect(p.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await choose(p.getByRole("combobox", { name: "Project" }), project.name);
  };
  await open(page);
  await expect(page.getByText(`Invoiced ${dollars(0)} · Not invoiced ${dollars(15000)}`)).toBeVisible();
  await expect(page.getByText(`Time ${dollars(6000)} · Expenses ${dollars(0)}`)).toBeVisible();
  await expect(page.getByText("Margin 60%")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: project.name });
  await expect(row).toContainText(`${dollars(15000)}${dollars(6000)}${dollars(9000)}60%`);
  await expect(page.getByRole("row").filter({ hasText: "Total" })).toContainText(`${dollars(15000)}${dollars(6000)}${dollars(9000)}60%`);
  await expect(page.getByRole("img", { name: /Revenue, cost and profit per day/ })).toBeVisible();
  // Admins also get each person.
  await page.getByRole("radio", { name: "People" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Pat Profit" })).toContainText(`${dollars(15000)}${dollars(6000)}${dollars(9000)}`);

  await open(manager.page);
  await expect(manager.page.getByText("Margin 60%")).toBeVisible();
  await expect(manager.page.getByRole("radio", { name: "Projects" })).toBeVisible();
  await expect(manager.page.getByRole("radio", { name: "People" })).toHaveCount(0);

  // Members have no Profitability tab.
  await member.page.goto("/reports");
  await expect(member.page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(member.page.getByRole("link", { name: "Profitability" })).toHaveCount(0);
  await member.context.close();
  await manager.context.close();
});

test("company-wide tasks: common ones start on new projects, others can be added to every project", async ({ page, request }) => {
  const common = unique("Design");
  const other = unique("Vacation");
  try {
    await page.goto("/manage/tasks");
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    await page.getByLabel("Task name").fill(common);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: common })).toBeVisible();
    // An error from the Add form goes when the name is edited (QA-24) ...
    await page.getByLabel("Task name").fill(common);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("There's already a task with that name.")).toBeVisible();
    await page.getByLabel("Task name").fill(other);
    await expect(page.getByText("There's already a task with that name.")).toHaveCount(0);
    // ... and when something else on the page starts.
    await page.getByLabel("Task name").fill(common);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("There's already a task with that name.")).toBeVisible();
    await page.getByRole("listitem").filter({ hasText: common }).getByRole("button", { name: /^More actions/ }).click();
    await page.getByRole("menuitem", { name: "Add to all projects" }).click();
    await expect(page.getByText("There's already a task with that name.")).toHaveCount(0);
    await page.getByLabel("Task name").fill(other);
    await page.getByRole("checkbox", { name: "Add to new projects" }).uncheck();
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("heading", { name: "Common tasks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Other tasks" })).toBeVisible();

    // A new project has the common task, and not the other.
    const project = await seedProject(request, { name: unique("Tasks Project") });
    await page.goto(`/projects/${project.id}/tasks`);
    await expect(page.getByRole("listitem").filter({ hasText: common })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: other })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage → Tasks" })).toBeVisible();

    // Adding the other one to every project says how many got it.
    await page.goto("/manage/tasks");
    const row = page.getByRole("listitem").filter({ hasText: other });
    await row.getByRole("button", { name: /^More actions/ }).click();
    await page.getByRole("menuitem", { name: "Add to all projects" }).click();
    await expect(page.getByRole("main").getByText(/^Added to \d+ projects?\.$/)).toBeVisible();
    await page.goto(`/projects/${project.id}/tasks`);
    await expect(page.getByRole("listitem").filter({ hasText: other })).toBeVisible();
  } finally {
    // Leave no tasks behind for the other tests' projects.
    const { tasks } = await api<{ tasks: { id: string; title: string }[] }>(request, "GET", "/api/tasks");
    for (const t of tasks.filter((t) => t.title === common || t.title === other)) await api(request, "DELETE", `/api/tasks/${t.id}`, {});
    const list = await api<{ tasks: { id: string; title: string }[] }>(request, "GET", "/api/common-tasks");
    for (const t of list.tasks.filter((t) => t.title === common || t.title === other)) await api(request, "DELETE", `/api/common-tasks/${t.id}`, {});
  }
});

test("adding a project task starts the next one unassigned (QA-23)", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Assign Project") });
  await page.goto(`/projects/${project.id}/tasks`);
  const assignee = page.getByRole("combobox", { name: "Assigned to" });
  await expect(assignee).toContainText("Nobody");
  await choose(assignee, "Ada Admin");
  await expect(assignee).toContainText("Ada Admin");
  const first = unique("Assigned task");
  await page.getByLabel("New task").fill(first);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: first })).toBeVisible();
  await expect(assignee).toContainText("Nobody");
  await expect(page.getByLabel("New task")).toHaveValue("");
});

test("approve all shown approves every submitted week listed", async ({ page, browser, request }) => {
  const project = await seedProject(request, { name: unique("Bulk Project") });
  const week = addDays(startOfWeek(today()), -21);
  const people: Awaited<ReturnType<typeof joinAs>>[] = [];
  try {
    await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
    people.push(await joinAs(browser, request, "member", unique("Bea Bulk")), await joinAs(browser, request, "manager", unique("Bo Bulk")));
    for (const p of people) {
      await api(p.request, "POST", "/api/time-entries", { projectId: project.id, date: week, seconds: 3600, notes: "", billable: true });
      await api(p.request, "POST", `/api/timesheets/mine/${week}/submit`, {});
    }

    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
    await choose(page.getByRole("combobox", { name: "Week" }), "One week");
    // It starts on last week; go back to the week with the two submissions.
    await page.getByRole("button", { name: "Previous week" }).click();
    await page.getByRole("button", { name: "Previous week" }).click();
    await expect(page.getByText("2 timesheets · 2:00, 2:00 billable")).toBeVisible();
    await page.getByRole("button", { name: "Approve all shown (2)" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Approved 2.")).toBeVisible();
    await expect(page.getByText("No weeks waiting for approval.")).toBeVisible();
    await page.getByRole("link", { name: "Approved", exact: true }).click();
    await expect(page.getByText("2 timesheets")).toBeVisible();
  } finally {
    // Leave the Approved tab empty for the other approval tests.
    for (const p of people) {
      await request.fetch(`/api/timesheets/${p.id}/${week}/reopen`, { method: "POST", data: {} });
      await p.context.close();
    }
    await api(request, "PUT", "/api/settings/timesheets", { approvals: false, timeZone: "UTC" });
  }
});

test("a person's week draws its rule between days and says Non-billable (QA2-22)", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Rule Project") });
  const week = "2025-06-02";
  await seedEntry(request, { projectId: project.id, date: "2025-06-02", minutes: 30, notes: "Monday first" });
  await seedEntry(request, { projectId: project.id, date: "2025-06-02", minutes: 30, notes: "Monday second", billable: false });
  await seedEntry(request, { projectId: project.id, date: "2025-06-03", minutes: 30, notes: "Tuesday only" });
  const { user } = await api<{ user: { id: string } }>(request, "GET", "/api/me");
  await page.goto(`/team/${user.id}/${week}`);
  await expect(page.getByText("Tuesday only")).toBeVisible();
  await expect(page.getByText("Non-billable", { exact: true })).toBeVisible();
  await expect(page.getByText("Not billable")).toHaveCount(0);
  const border = (locator: import("@playwright/test").Locator, side: "Top" | "Bottom") =>
    locator.evaluate((el, s) => getComputedStyle(el)[`border${s}Width` as "borderTopWidth"], side);
  const monday = page.getByRole("region", { name: /Monday/ });
  const tuesday = page.getByRole("region", { name: /Tuesday/ });
  expect(await border(tuesday, "Top")).toBe("1px"); // between the days
  expect(await border(monday.getByRole("listitem").last(), "Bottom")).toBe("0px"); // not after the last entry of a day
  expect(await border(monday.getByRole("listitem").first(), "Bottom")).toBe("1px"); // between the entries of one day
});
