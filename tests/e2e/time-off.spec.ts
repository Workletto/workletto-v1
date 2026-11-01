import { expect, test } from "@playwright/test";
import { ADMIN, api } from "./helpers.ts";

// Time off and company holidays (WRK-138): add days off and a holiday, and the Team page's
// capacity for that week goes down by them.
test("days off and a holiday come off capacity on the Team page", async ({ page, request }) => {
  // A week well ahead, so nothing else in the run has time there.
  const monday = "2027-03-01";
  try {
    // Time off opens from the top of the Time page.
    await page.goto("/");
    await page.getByRole("link", { name: "Time off" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Time off" })).toBeVisible();

    // A company holiday on the Wednesday.
    const holidays = page.locator("section", { has: page.getByRole("heading", { name: "Company holidays" }) });
    await holidays.getByLabel("Date").fill("2027-03-03");
    await holidays.getByRole("textbox", { name: "Holiday" }).fill("Studio day");
    await holidays.getByRole("button", { name: "Add holiday" }).click();
    await expect(holidays.getByRole("listitem").filter({ hasText: "Studio day" })).toBeVisible();

    // Monday to Wednesday off: the holiday is skipped, so 2 days.
    await page.getByLabel("First day").fill(monday);
    await page.getByLabel("Last day").fill("2027-03-03");
    await page.getByRole("button", { name: "Add time off" }).click();
    await expect(page.getByText("2 days off added.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Mon, Mar 1 – Tue, Mar 2" })).toContainText("Vacation · 2 days");

    // 40 hours less 3 days (2 off and the holiday) is 16 hours.
    await page.goto(`/team/${monday}`);
    await expect(page.getByRole("listitem").filter({ hasText: ADMIN.name })).toContainText("Capacity 16:00 (3 days off)");
  } finally {
    const { timeOff, holidays } = await api<{ timeOff: { id: string }[]; holidays: { id: string }[] }>(request, "GET", `/api/time-off?from=${monday}&to=2027-03-07`);
    for (const t of timeOff) await api(request, "DELETE", `/api/time-off/${t.id}`, {});
    for (const h of holidays) await api(request, "DELETE", `/api/settings/time-off/holidays/${h.id}`, {});
  }
});
