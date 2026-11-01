import { test } from "@playwright/test";
import { api, ADMIN_STATE } from "./helpers.ts";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";

// A picture of every page, for a person to look over: not part of the normal run.
//   GALLERY=1 [GALLERY_WIDTHS=1280,768,375] [GALLERY_MODES=light,dark] [GALLERY_ACCENT=#5b2e6e] npx playwright test gallery
// Pictures land in test-results/gallery/<mode>-<width>/.
test.skip(!process.env.GALLERY, "Runs only with GALLERY=1");

const WIDTHS = (process.env.GALLERY_WIDTHS ?? "1280,768,375").split(",").map(Number);
const MODES = (process.env.GALLERY_MODES ?? "light,dark").split(",") as ("light" | "dark")[];
const ACCENT = process.env.GALLERY_ACCENT ?? null;

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
  if (ACCENT) {
    const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
    await api(request, "PUT", "/api/settings/appearance", { accentColor: ACCENT, colorMode: "system" });
    await request.dispose();
  }
});
test.afterAll(async ({ playwright, baseURL }) => {
  if (ACCENT) {
    const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
    await api(request, "PUT", "/api/settings/appearance", { accentColor: null, colorMode: "system" });
    await request.dispose();
  }
  await endPages(playwright, baseURL);
});
test.use({ reducedMotion: "reduce" });

for (const mode of MODES) {
  for (const width of WIDTHS) {
    test.describe(`${mode} ${width}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: mode });
      for (const { name, path, heading } of PAGES) {
        test(name, async ({ page }) => {
          await openPage(page, path(seeded), heading);
          await page.screenshot({ path: `test-results/gallery/${mode}-${width}/${name.replace(/[^a-z0-9]+/gi, "-")}.png`, fullPage: true });
        });
      }
    });
  }
}

// The signed-out screens, in each mode.
for (const mode of MODES) {
  test.describe(`${mode} signed out`, () => {
    test.use({ storageState: { cookies: [], origins: [] }, colorScheme: mode });
    for (const width of WIDTHS) {
      test(`Sign in at ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.screenshot({ path: `test-results/gallery/${mode}-${width}/Sign-in.png`, fullPage: true });
      });
    }
  });
}
