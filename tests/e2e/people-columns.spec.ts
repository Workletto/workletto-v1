import { expect, request as newRequest, test } from "@playwright/test";
import { api, unique } from "./helpers.ts";

test("Manage > People: rate boxes, role menus and Edit line up from row to row (QA2-13)", async ({ page, request }) => {
  // A manager and a member who have joined, so their rows sit beside the admin's own.
  const visitor = await newRequest.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  for (const role of ["manager", "member"]) {
    const name = unique(`Column ${role}`);
    const { token } = await api<{ token: string }>(request, "POST", "/api/people/invites", { name, email: `${unique(role).replace(/\W/g, "")}@example.com`, role });
    await api(visitor, "POST", "/api/invites/accept", { token, name, password: "e2e-column-password" });
  }
  await visitor.dispose();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/manage/people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  // The heading shows before the people load: wait for the rows before measuring them.
  await expect.poll(() => page.locator(".wl-person-controls").count()).toBeGreaterThanOrEqual(3);

  const lefts = (selector: string) =>
    page.locator(".wl-person-controls").evaluateAll(
      (rows, sel) => rows.map((row) => Math.round(row.querySelector(sel)!.getBoundingClientRect().left)),
      selector,
    );
  const rates = await lefts(".wl-rate");
  expect(rates.length).toBeGreaterThanOrEqual(3);
  expect(new Set(rates).size).toBe(1);
  expect(new Set(await lefts(".rt-SelectTrigger")).size).toBe(1);
  expect(new Set(await lefts(".wl-row-actions")).size).toBe(1);
  const widths = await page.locator(".wl-person-controls .rt-SelectTrigger").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
});
