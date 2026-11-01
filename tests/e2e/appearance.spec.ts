import { expect, test, type Page } from "@playwright/test";
import { api } from "./helpers.ts";

const ACCENT = "#7c3aed";

// The look is shared by the whole organization, so put the default back for the other tests.
test.afterEach(async ({ request }) => {
  await api(request, "PUT", "/api/settings/appearance", { accentColor: null, colorMode: "system" });
});

const look = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? null,
    brand: document.documentElement.style.getPropertyValue("--wl-brand"),
    background: getComputedStyle(document.body).backgroundColor,
  }));

test("change the accent color and dark mode: both persist after a reload", async ({ page, browser }) => {
  await page.goto("/manage/appearance");
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  const before = await look(page);
  expect(before.theme).toBeNull();
  expect(before.brand).toBe("");

  // Changes show at once, before anything is saved.
  await page.getByLabel("Accent color as a hex code").fill(ACCENT);
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect.poll(() => look(page)).toMatchObject({ theme: "dark", brand: ACCENT });
  const dark = await look(page);
  expect(dark.background).not.toBe(before.background);

  await page.getByRole("button", { name: "Save appearance" }).click();
  await expect(page.getByText("Saved. Everyone in your organization now sees this look.")).toBeVisible();

  // After a reload the saved look is applied from the server.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();
  await expect.poll(() => look(page)).toMatchObject({ theme: "dark", brand: ACCENT, background: dark.background });
  await expect(page.getByLabel("Accent color as a hex code")).toHaveValue(ACCENT);
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  // Everyone gets it, even before they sign in.
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const signIn = await visitor.newPage();
  await signIn.goto("/");
  await expect(signIn.getByRole("heading", { level: 1 })).toContainText("Sign in");
  await expect.poll(() => look(signIn)).toMatchObject({ theme: "dark", brand: ACCENT });
  await visitor.close();

  // The default color comes back with one click, and focus moves to the color field.
  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect(page.getByLabel("Accent color as a hex code")).toBeFocused();
  await expect(page.getByRole("button", { name: "Reset to default" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Light" }).click();
  await page.getByRole("button", { name: "Save appearance" }).click();
  await expect(page.getByText("Saved. Everyone in your organization now sees this look.")).toBeVisible();
  await page.reload();
  await expect.poll(() => look(page)).toMatchObject({ theme: "light", brand: "" });
});
