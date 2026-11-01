import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_STATE, expectSignedIn, ORG_NAME, SETUP_CODE } from "./helpers.ts";

// Runs first, once per database: the first-run screen creates the admin account and the
// organization. Every other test starts from the sign-in this test saves.
test("first-run setup: setup code, admin account and organization name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Set up", exact: true })).toBeVisible();

  const fillIn = async (code: string) => {
    await page.getByLabel("Setup code", { exact: true }).fill(code);
    await page.getByLabel("Organization name", { exact: true }).fill(ORG_NAME);
    await page.getByLabel("Your name", { exact: true }).fill(ADMIN.name);
    await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Create admin account" }).click();
  };

  // A wrong code creates nothing.
  await fillIn("not-the-setup-code-0000");
  await expect(page.getByRole("alert")).toHaveText("That setup code is not correct.");
  await expect(page.getByRole("heading", { level: 1, name: "Set up", exact: true })).toBeVisible();

  // Restoring a backup asks for the setup code too; a wrong one restores nothing.
  await page.getByRole("button", { name: "Restoring from another install? Restore a backup" }).click();
  const restore = page.getByRole("form", { name: "Restore a backup" });
  await restore.getByLabel("Setup code", { exact: true }).fill("not-the-setup-code-0000");
  await restore.getByLabel("Backup file").setInputFiles({ name: "backup.json.gz", mimeType: "application/gzip", buffer: Buffer.from("not a backup") });
  await restore.getByRole("button", { name: "Restore" }).click();
  await expect(restore.getByRole("alert")).toHaveText("That setup code is not correct.");
  await page.reload();

  // The right code creates the admin, signs them in and names the organization.
  await fillIn(SETUP_CODE);
  await expectSignedIn(page);
  await expect(page.locator("header")).toContainText(ORG_NAME);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Manage" })).toBeVisible();

  await page.context().storageState({ path: ADMIN_STATE });
});
