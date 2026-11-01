import { expect, test } from "@playwright/test";
import { ADMIN, api, choose, seedProject, unique } from "./helpers.ts";

// User groups (WRK-149): an admin makes a group on the Team page, filters the page by it, and adds
// the group's people to a project's team.
test("make a group, filter the Team page by it, and add it to a project", async ({ page, request }) => {
  const name = unique("Design");
  await page.goto("/team");
  const groups = page.getByRole("region", { name: "Groups" });
  await groups.getByLabel("New group").fill(name);
  await groups.getByRole("button", { name: "Add group" }).click();
  await groups.getByRole("button", { name: `Change ${name}` }).click();
  await groups.getByRole("group", { name: "People in the group" }).getByRole("checkbox", { name: ADMIN.name }).click();
  await groups.getByRole("button", { name: "Save group" }).click();
  await expect(groups.getByText(ADMIN.name, { exact: true })).toBeVisible();

  await choose(page.getByLabel("Group", { exact: true }), name);
  await expect(page.getByRole("link", { name: new RegExp(`^Timesheet for ${ADMIN.name},`) })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Timesheet for / })).toHaveCount(1);

  const project = await seedProject(request, { name: unique("Group Project") });
  await page.goto(`/projects/${project.id}/settings`);
  await choose(page.getByLabel("Add a group's people"), name);
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Only the people I choose/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: ADMIN.name, exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText("Project saved.")).toBeVisible();
  const saved = await api<{ project: { everyone: boolean; memberIds: string[] } }>(request, "GET", `/api/projects/${project.id}`);
  expect(saved.project.everyone).toBe(false);
  expect(saved.project.memberIds).toHaveLength(1);
});
