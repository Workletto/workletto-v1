import { expect, test } from "@playwright/test";
import { ADMIN, api, choose, seedProject, unique } from "./helpers.ts";

// Scheduling (WRK-139): plan a week on the Team page's Schedule, repeat it, see it flagged
// over capacity, and see it on the Time page as "Planned for you".
test("plans a person's week, repeats it and shows it on their Time page", async ({ page, request }) => {
  // Weeks well ahead, so nothing else in the run has plans there.
  const monday = "2027-05-03";
  const { user } = await api<{ user: { id: string } }>(request, "GET", "/api/me");
  const project = await seedProject(request, { name: unique("Planned Project") });
  try {
    await page.goto(`/team/schedule/${monday}`);
    await expect(page.getByRole("heading", { level: 1, name: "May 3 – Jun 13" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Team sections" }).getByRole("link", { name: "Schedule" })).toHaveAttribute("aria-current", "page");

    // An empty week: nothing scheduled of 40 hours.
    const cell = (week: string) => page.getByRole("button", { name: new RegExp(`^${ADMIN.name}, week of ${week}:`) });
    await expect(cell("May 3")).toContainText("– / 40:00");
    await cell("May 3").click();

    const panel = page.getByRole("complementary", { name: `${ADMIN.name} · week of May 3` });
    await panel.getByRole("button", { name: "+ Add a project" }).click();
    await choose(panel.getByRole("combobox", { name: "Add a project" }), project.name);
    await panel.getByRole("textbox", { name: `Hours on ${project.name}` }).fill("44");
    await expect(panel).toContainText("44:00 scheduled, 4:00 more than the 40:00 available.");
    await panel.getByRole("checkbox", { name: "Repeat for the next 3 weeks" }).check();
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel).toBeHidden();

    // This week and the next three, over capacity; the fifth is still empty.
    for (const week of ["May 3", "May 10", "May 17", "May 24"]) {
      await expect(cell(week)).toContainText("44:00 / 40:00");
      await expect(cell(week)).toContainText("4:00 over");
    }
    await expect(cell("May 31")).toContainText("– / 40:00");

    // The person sees the plan on their timesheet for that week.
    await page.goto(`/time/week/${monday}`);
    const plan = page.getByRole("region", { name: "Planned for you that week" });
    await expect(plan).toContainText(project.name);
    await expect(plan).toContainText("0:00 tracked of 44:00 planned");
  } finally {
    await api(request, "PUT", `/api/schedule/${user.id}/${monday}`, { rows: [], repeat: true });
  }
});
