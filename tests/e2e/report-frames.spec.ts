import { expect, test } from "@playwright/test";

// QA2-20: Reports > Time and Reports > Profitability share one frame; only the content changes.
test("both Reports tabs have the filter panel and a Breakdown with the same groups in the same order", async ({ page }) => {
  for (const path of ["/reports", "/reports/profitability"]) {
    await page.goto(path);
    await expect(page.locator(".wl-filters").getByRole("combobox", { name: "Client" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Breakdown" })).toBeVisible();
    const groups = page.getByRole("radiogroup", { name: "Group results by" }).getByRole("radio");
    await expect(groups.nth(0)).toHaveAccessibleName("Clients");
    await expect(groups.nth(1)).toHaveAccessibleName("Projects");
    await expect(groups.nth(2)).toHaveAccessibleName("People");
  }
});
