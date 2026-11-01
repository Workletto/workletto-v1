import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { api, expectSignedIn, signOut, unique } from "./helpers.ts";

const FIRST = "e2e-first-password";
const SECOND = "e2e-second-password";

/** A member with a login, joined through an invite, in a browser of their own. */
async function newMember(browser: Browser, request: Parameters<typeof api>[0], name: string) {
  const email = `${unique(name.split(" ")[0]!.toLowerCase()).replace(/\W/g, "")}@example.com`;
  const { token } = await api<{ token: string }>(request, "POST", "/api/people/invites", { name, email, role: "member" });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel("Password", { exact: true }).fill(FIRST);
  await page.getByRole("button", { name: "Join" }).click();
  await expectSignedIn(page);
  return { email, context, page };
}

async function signInAs(page: Page, email: string, password: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an admin's reset link lets a member choose a new password; their other session ends", async ({ page, browser, request }) => {
  const rae = await newMember(browser, request, "Rae Member");
  let second: BrowserContext | null = null;
  try {
    // The admin makes a reset link and copies it.
    await page.goto("/manage/people");
    await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
    await page.getByRole("listitem").filter({ hasText: rae.email }).getByRole("button", { name: "More actions for Rae Member" }).click();
    await page.getByRole("menuitem", { name: "Reset link" }).click();
    await expect(page.getByText("Send this link to Rae Member")).toBeVisible();
    const link = await page.getByLabel("Reset link").inputValue();
    expect(link).toMatch(/\/reset\/[\w-]+$/);

    // Rae opens it in another browser and chooses a new password.
    second = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const fresh = await second.newPage();
    await fresh.goto(new URL(link).pathname);
    await expect(fresh.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
    await expect(fresh.getByText(`For ${rae.email}`)).toBeVisible();
    await fresh.getByLabel("New password", { exact: true }).fill(SECOND);
    await fresh.getByRole("button", { name: "Save password" }).click();
    await expectSignedIn(fresh);

    // Her first browser is signed out, and the link works once.
    await rae.page.reload();
    await expect(rae.page.getByRole("button", { name: "Sign in" })).toBeVisible();
    const again = await second.newPage();
    await again.goto(new URL(link).pathname);
    await expect(again.getByRole("heading", { level: 1, name: "This link doesn't work" })).toBeVisible();

    // Only the new password signs her in.
    await signInAs(rae.page, rae.email, FIRST);
    await expect(rae.page.getByText("That email and password don't match.")).toBeVisible();
    await signInAs(rae.page, rae.email, SECOND);
    await expectSignedIn(rae.page);
  } finally {
    await rae.context.close();
    await second?.close();
  }
});

test("changing your own password from the account menu", async ({ browser, request }) => {
  const sol = await newMember(browser, request, "Sol Member");
  try {
    const { page } = sol;
    await page.getByRole("banner").getByRole("button", { name: /account menu$/ }).click();
    await page.getByRole("menuitem", { name: "Change password" }).click();
    const dialog = page.getByRole("dialog", { name: "Change password" });
    await expect(dialog).toBeVisible();

    // A wrong current password is refused; the dialog stays open.
    await dialog.getByLabel("Current password").fill("not-the-password");
    await dialog.getByLabel("New password", { exact: true }).fill(SECOND);
    await dialog.getByLabel("New password again").fill(SECOND);
    await dialog.getByRole("button", { name: "Change password" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("That isn't your current password.");

    await dialog.getByLabel("Current password").fill(FIRST);
    await dialog.getByRole("button", { name: "Change password" }).click();
    await expect(dialog).toBeHidden();
    await expectSignedIn(page);

    await signOut(page);
    await signInAs(page, sol.email, SECOND);
    await expectSignedIn(page);
  } finally {
    await sol.context.close();
  }
});

test("an admin changes a member's name and sign-in email; the member signs in with the new one", async ({ page, browser, request }) => {
  const name = unique("Lee Member");
  const lee = await newMember(browser, request, name);
  const newName = `${name} Park`;
  const newEmail = `new-${lee.email}`;
  try {
    await page.goto("/manage/people");
    const row = page.getByRole("listitem").filter({ hasText: lee.email });
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    const form = page.getByRole("form", { name: `Edit ${name}` });
    await form.getByLabel("Name", { exact: true }).fill(newName);
    await form.getByLabel("Email", { exact: true }).fill(newEmail);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: newEmail })).toContainText(newName);

    // A new sign-in email signs them out everywhere; the new address works.
    await lee.page.reload();
    await expect(lee.page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await signInAs(lee.page, newEmail, FIRST);
    await expectSignedIn(lee.page);
  } finally {
    await lee.context.close();
  }
});
