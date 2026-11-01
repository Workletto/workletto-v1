import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";
import { ADMIN_STATE, api } from "./helpers.ts";

// WCAG 2.2 level AA, and the levels below it that it builds on.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
});
test.afterAll(async ({ playwright, baseURL }) => {
  await endPages(playwright, baseURL);
});

async function expectNoViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const report = violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")}\n  ${n.failureSummary?.replace(/\n/g, "\n  ")}`).join("\n")}`);
  expect(report, report.join("\n\n")).toEqual([]);
}

const LOOKS = [
  { name: "light mode", use: { colorScheme: "light" as const } },
  { name: "dark mode", use: { colorScheme: "dark" as const } },
  { name: "phone", use: { colorScheme: "light" as const, viewport: { width: 390, height: 844 } } },
  { name: "tablet", use: { colorScheme: "light" as const, viewport: { width: 768, height: 1024 } } },
];

for (const { name: look, use } of LOOKS) {
  test.describe(look, () => {
    test.use(use);

    for (const { name, path, heading } of PAGES) {
      test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await openPage(page, path(seeded), heading);
        await expectNoViolations(page);
      });
    }

    test.describe("signed out", () => {
      test.use({ storageState: { cookies: [], origins: [] } });

      test("Sign in has no WCAG 2.2 AA violations", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Sign in");
        await expectNoViolations(page);
      });
    });
  });
}

// A customer's own color changes buttons, links, the selected section and focus rings. A light,
// bright one is the hardest to keep readable: every page, in both modes, with a yellow accent.
test.describe("a customer's yellow accent", () => {
  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
    await api(request, "PUT", "/api/settings/appearance", { accentColor: "#f2c200", colorMode: "system" });
    await request.dispose();
  });
  test.afterAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
    await api(request, "PUT", "/api/settings/appearance", { accentColor: null, colorMode: "system" });
    await request.dispose();
  });
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });
      for (const { name, path, heading } of PAGES) {
        test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
          await openPage(page, path(seeded), heading);
          await expectNoViolations(page);
        });
      }
    });
  }
});
