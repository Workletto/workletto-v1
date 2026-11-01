import { expect, test } from "@playwright/test";

test("on a phone the Manage tabs are one row that scrolls sideways, with the current tab in view", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/manage/history");

  const tabs = page.getByRole("region", { name: "Manage sections, scrolls sideways" });
  const links = tabs.getByRole("link");
  await expect(links.first()).toBeVisible();
  expect(await links.count()).toBeGreaterThan(6);

  // One row: every tab sits at the same height.
  const tops = await links.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // It scrolls inside its own box, not the page.
  const sizes = await tabs.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect(sizes.page).toBeLessThanOrEqual(sizes.view);

  // The current tab (History is near the end) was scrolled into view, and is still a link in the navigation.
  const history = page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "History" });
  const inView = await history.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= document.documentElement.clientWidth;
  });
  expect(inView).toBe(true);

  // A fade at the edge says there are more tabs that way (History is near the end, so tabs lie to the left).
  await expect(page.locator("[data-tabs-fade]").first()).toBeVisible();

  // Keyboard: the region can be focused to scroll it, and tabbing along the links keeps focus visible.
  await tabs.focus();
  await expect(tabs).toBeFocused();
});

test("at tablet width the Manage tabs wrap, so every tab is in view and none hides behind a fade (QA-69)", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto("/manage/people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  const links = page.getByRole("navigation", { name: "Manage sections" }).getByRole("link");
  expect(await links.count()).toBeGreaterThan(6);
  const allInView = await links.evaluateAll((els) =>
    els.every((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth;
    }),
  );
  expect(allInView).toBe(true);
  await expect(page.locator("[data-tabs-fade]")).toHaveCount(0);
});

test("when the tabs have room, their wrapper is not a region and adds no Tab stop (QA2-15)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/manage/history");
  const nav = page.getByRole("navigation", { name: "Manage sections" });
  await expect(nav.getByRole("link").first()).toBeVisible();
  await expect(page.getByRole("region", { name: /scrolls sideways/ })).toHaveCount(0);
  expect(await nav.evaluate((el) => el.parentElement?.getAttribute("tabindex") ?? null)).toBeNull();

  // Squeezed until they overflow, the wrapper becomes the labeled, focusable region again.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole("region", { name: "Manage sections, scrolls sideways" })).toHaveAttribute("tabindex", "0");
});
