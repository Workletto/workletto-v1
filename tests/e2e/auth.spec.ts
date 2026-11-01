import { expect, test } from "@playwright/test";
import { ADMIN, expectSignedIn, ORG_NAME, signOut } from "./helpers.ts";

// Signing in is rate limited per address (10 tries a minute, src/server/rateLimit.ts), so the whole
// suite signs in by password only a few times: twice here, once in members.spec.ts.
test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in and out; a wrong password is refused", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: `Sign in to ${ORG_NAME}` })).toBeVisible();

    await expect(page).toHaveTitle(`Sign in · ${ORG_NAME}`);

    // Nothing typed: one clear message, and the empty fields are marked (no request is made).
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter your email and password.");
    await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");
    // An address that isn't one reads in the app's words, not the library's.
    await page.getByLabel("Email", { exact: true }).fill("not-an-address");
    await page.getByLabel("Password", { exact: true }).fill("whatever-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a valid email address.");

    await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expectSignedIn(page);

    await signOut(page);
    await expect(page.getByRole("heading", { level: 1, name: `Sign in to ${ORG_NAME}` })).toBeVisible();
  });

  test("setup cannot run twice, and the API needs a sign-in", async ({ request }) => {
    const again = await request.post("/api/setup", {
      data: { setupCode: "e2e-setup-code-1234", organizationName: "Intruder", name: "Mallory", email: "mallory@example.com", password: "mallory-password" },
    });
    expect(again.status()).toBe(404);
    expect(await again.json()).toEqual({ error: "Setup is already complete. Sign in instead." });

    for (const path of ["/api/me", "/api/projects", "/api/invoices", "/api/people"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
  });
});
