import { expect, test } from "@playwright/test";
import { seedEntry, seedProject, unique } from "./helpers.ts";

// QA2-27: more hours than expected isn't an error, so the week's bar stays neutral, not red.
test("a week with more hours than expected keeps a neutral bar", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Long Week Project") });
  for (const date of ["2024-03-04", "2024-03-05"]) await seedEntry(request, { projectId: project.id, date, minutes: 21 * 60 });
  await page.goto("/time/week/2024-03-04");
  await expect(page.getByText("42:00", { exact: false }).first()).toBeVisible();
  const bar = page.getByRole("progressbar", { name: "Hours this week of the hours expected" });
  await expect(bar).toHaveAttribute("data-accent-color", "gray");
});
