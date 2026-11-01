import { expect, test } from "@playwright/test";
import { api, seedProject, unique } from "./helpers.ts";

// QA-47: the header never makes the page scroll sideways, at any width, for the admin with the most links.
test("the header fits every width from 320 to 1440 with approvals on and a timer running", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("A Fairly Long Project Name For The Header") });
  try {
    await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
    await api(request, "POST", "/api/timer/start", { projectId: project.id, date: new Date().toISOString().slice(0, 10) });
    await page.goto("/");
    await expect(page.getByRole("group", { name: "Running timer" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Approvals" })).toBeAttached();
    for (let width = 320; width <= 1440; width += width < 800 ? 40 : 80) {
      await page.setViewportSize({ width, height: 800 });
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(scroll, `page width at ${width}px`).toBeLessThanOrEqual(inner);
      // The links are either all in view or behind the Menu button.
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      if (width < 1200) await expect(menu, `Menu at ${width}px`).toBeVisible();
      else await expect(menu, `no Menu at ${width}px`).toBeHidden();
    }
  } finally {
    await api(request, "POST", "/api/timer/stop", {}).catch(() => undefined);
    await api(request, "PUT", "/api/settings/timesheets", { approvals: false, timeZone: "UTC" });
  }
});

// QA2-28: on short laptop screens the large running card on the week view doesn't push Help and
// the account menu out of the sidebar.
test("on 1366 x 768 and 1280 x 720 the whole sidebar fits, with approvals on and the large timer card", async ({ page, request }) => {
  const project = await seedProject(request, { name: unique("Sidebar Height Project") });
  try {
    await api(request, "PUT", "/api/settings/timesheets", { approvals: true, timeZone: "UTC" });
    await api(request, "POST", "/api/timer/start", { projectId: project.id, date: new Date().toISOString().slice(0, 10) });
    for (const [width, height] of [[1366, 768], [1280, 720]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/time/week/${new Date().toISOString().slice(0, 10)}`);
      await expect(page.locator('.wl-timer[data-size="full"]')).toBeVisible();
      const fit = await page.locator(".wl-sidebar").evaluate((el) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
        account: Math.round(document.querySelector(".wl-account")!.getBoundingClientRect().bottom),
      }));
      expect(fit.scroll, `sidebar at ${width} x ${height}`).toBeLessThanOrEqual(fit.client);
      expect(fit.account, `account menu at ${width} x ${height}`).toBeLessThanOrEqual(height);
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Help/ })).toBeInViewport();
    }
  } finally {
    await api(request, "POST", "/api/timer/stop", {}).catch(() => undefined);
    await api(request, "PUT", "/api/settings/timesheets", { approvals: false, timeZone: "UTC" });
  }
});
