import { expect, test } from "@playwright/test";
import { startFakeSmtp } from "../fakeSmtp.ts";
import { ADMIN, api } from "./helpers.ts";

// Email is shared by the whole organization, so turn it off again for the other tests.
test.afterEach(async ({ request }) => {
  await api(request, "DELETE", "/api/settings/email", {});
});

test("set up an SMTP server, send a test email and see it arrive", async ({ page }) => {
  const server = await startFakeSmtp({ user: "mailer", password: "e2e-mail-password" });
  try {
    await page.goto("/manage/email");
    await expect(page.getByRole("heading", { level: 1, name: "Email" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();

    await page.getByRole("radio", { name: "SMTP server" }).click();
    await page.getByLabel("Sender name").fill("Studio North");
    await page.getByLabel("Sender address").fill("billing@studio-north.test");
    await page.getByLabel("Host", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("Port", { exact: true }).fill(String(server.port));
    await page.getByLabel("Username").fill("mailer");
    await page.getByLabel("Password", { exact: true }).fill("e2e-mail-password");
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    // The password is never shown again.
    await page.reload();
    await expect(page.getByLabel("Host", { exact: true })).toHaveValue("127.0.0.1");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", "Saved. Enter a new one to replace it.");
    await expect(page.locator("body")).not.toContainText("e2e-mail-password");

    await page.getByRole("button", { name: "Send a test email" }).click();
    await expect(page.getByText("Sent. Check your inbox.")).toBeVisible();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({ from: "billing@studio-north.test", to: [ADMIN.email], subject: "Test email" });
    await expect(page.getByText(/^Last test: .*Sent\.$/)).toBeVisible();

    // A wrong password is reported in plain words.
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send a test email" }).click();
    await expect(page.getByText("The email server refused the username or password.").first()).toBeVisible();

    // Turning email off forgets the settings.
    await page.getByRole("radio", { name: "Off" }).click();
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByText("Email is off.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a test email" })).toHaveCount(0);
  } finally {
    await server.close();
  }
});
