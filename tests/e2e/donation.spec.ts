import { expect, test } from "@playwright/test";

// The one-time donation card (WRK-168). When it shows is the server's call, tested in
// tests/about.test.ts (14 days after setup, once time is tracked); here the shared test
// organization is new, so the answer is stubbed to check the card itself.
test("an admin sees the donation card once on the Time screen, and either button hides it", async ({ page }) => {
  let dismissed = 0;
  await page.route("**/api/settings/about/donation", (route) => route.fulfill({ json: { show: dismissed === 0 } }));
  await page.route("**/api/settings/about/donation/dismiss", (route) => {
    dismissed += 1;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/");
  const card = page.getByRole("region", { name: "Workletto is free, but building and running it isn’t." });
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "Donate" })).toHaveAttribute("href", "https://workletto.com/support");
  await expect(card.getByRole("link", { name: "Donate" })).toHaveAttribute("target", "_blank");

  await card.getByRole("button", { name: "Don’t show again" }).click();
  await expect(card).toBeHidden();
  expect(dismissed).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(card).toBeHidden();
});

test("the real server doesn't show the card to a new organization", async ({ page }) => {
  const answer = page.waitForResponse("**/api/settings/about/donation");
  await page.goto("/");
  expect(await (await answer).json()).toEqual({ show: false });
  await expect(page.getByRole("region", { name: /building and running it/ })).toHaveCount(0);
});

test("Manage → About has a quiet donate link", async ({ page }) => {
  await page.goto("/manage/about");
  await expect(page.getByRole("heading", { level: 1, name: "About" })).toBeVisible();
  await expect(page.getByRole("link", { name: "make a donation" })).toHaveAttribute("href", "https://workletto.com/support");
});
