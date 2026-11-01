import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { api, expectSignedIn, signOut, unique } from "./helpers.ts";

// Two-factor sign-in (WRK-147): a member sets it up with an authenticator app, then signs in with
// a code from it, and with a backup code.
const PASSWORD = "e2e-two-factor-password";

/** RFC 6238 codes from the setup key, worked out here as an authenticator app would. */
function totp(key: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...key.replace(/\s/g, "").toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const secret = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function signInWithPassword(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("set up two-factor sign-in, then sign in with a code and with a backup code", async ({ request, browser }) => {
  const email = `${unique("tfa").replace(/\W/g, "")}@example.com`;
  const { token } = await api<{ token: string }>(request, "POST", "/api/people/invites", { name: "Theo Twofactor", email, role: "member", emailLink: false });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/invite/${token}`);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Join" }).click();
  await expectSignedIn(page);

  // Set up from the menu with their name.
  await page.getByRole("button", { name: /account menu/ }).click();
  await page.getByRole("menuitem", { name: "Two-factor sign-in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Two-factor sign-in" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Help for this page/ })).toHaveAttribute("href", /\/help\/team-and-permissions\/two-factor-sign-in$/);
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up two-factor sign-in" }).click();
  await expect(page.getByRole("img", { name: "QR code to scan with your authenticator app" })).toBeVisible();
  const key = (await page.locator("code").first().innerText()).trim();
  await page.getByLabel("Code", { exact: true }).fill("000000" === totp(key) ? "111111" : "000000");
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("That code didn't work. Enter the code your app shows now.")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(totp(key));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText(/^Two-factor sign-in is on\./)).toBeVisible();
  const codes = await page.getByRole("list", { name: "Backup codes" }).getByRole("listitem").allInnerTexts();
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I've saved my backup codes" }).click();
  await expect(page.getByText(/^Two-factor sign-in is on\. You enter a code/)).toBeVisible();

  // Signing in now takes the password, then the code.
  await signOut(page);
  await signInWithPassword(page, email);
  await expect(page.getByText("Enter the 6-digit code from your authenticator app.")).toBeVisible();
  await page.getByLabel("Code", { exact: true }).fill(totp(key));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectSignedIn(page);

  // Or a backup code, once.
  await signOut(page);
  await signInWithPassword(page, email);
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(codes[0]!.trim());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectSignedIn(page);
  await context.close();
});
