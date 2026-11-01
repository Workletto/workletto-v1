import { expect, test } from "@playwright/test";
import { startFakeOidc } from "../fakeOidc.ts";
import { ADMIN, api, expectSignedIn } from "./helpers.ts";

// Single sign-on (WRK-136): an admin connects a provider in Manage → Settings, and the sign-in
// page offers "Sign in with …", which signs people in through it. Against a fake provider.
test("an admin turns on single sign-on, and people sign in through the provider", async ({ page, request, browser }) => {
  const fake = await startFakeOidc("workletto-e2e", "e2e-provider-secret");
  try {
    await page.goto("/manage/settings");
    const section = page.getByRole("region", { name: "Single sign-on" });
    await expect(section.getByRole("textbox", { name: "Redirect address for your provider" })).toHaveValue(/\/api\/auth\/callback\/sso$/);
    await section.getByRole("textbox", { name: "Provider name, for the button" }).fill("Test Provider");
    await section.getByRole("textbox", { name: "Issuer" }).fill(fake.issuer);
    await section.getByRole("textbox", { name: "Client ID" }).fill("workletto-e2e");
    await section.getByLabel("Client secret").fill("e2e-provider-secret");
    await section.getByRole("textbox", { name: "Email domain" }).fill("example.com");
    await section.getByRole("button", { name: "Turn on single sign-on" }).click();
    await expect(page.locator("#main").getByText("Single sign-on saved. The sign-in page now offers “Sign in with Test Provider”.")).toBeVisible();
    // Security & data lists it among the sign-in methods and the outside connections.
    await page.goto("/manage/security");
    await expect(page.getByText("Single sign-on · Through Test Provider. Set it up under Manage → Settings.")).toBeVisible();
    await expect(page.getByText(`Single sign-on: Test Provider at ${new URL(fake.issuer).host}`)).toBeVisible();
    // Fresh browsers, signed out, on the same app.
    const baseURL = test.info().project.use.baseURL;

    // Someone signed out: the button takes them to the provider and back, signed in.
    const signedOut = { baseURL, storageState: { cookies: [], origins: [] } };
    const visitor = await browser.newContext(signedOut);
    const signIn = await visitor.newPage();
    fake.signInBrowserAs({ sub: "fake-ada", email: ADMIN.email, name: ADMIN.name });
    await signIn.goto("/");
    await signIn.getByRole("button", { name: "Sign in with Test Provider" }).click();
    await expectSignedIn(signIn);

    // Someone the provider knows but who isn't in the organization is turned back, in plain words.
    const stranger = await browser.newContext(signedOut);
    const refused = await stranger.newPage();
    fake.signInBrowserAs({ sub: "fake-sam", email: "sam@example.com", name: "Sam" });
    await refused.goto("/");
    await refused.getByRole("button", { name: "Sign in with Test Provider" }).click();
    await expect(refused.getByText("You're not in this organization yet. Ask an admin to invite you, then sign in with Test Provider.")).toBeVisible();
    await visitor.close();
    await stranger.close();
  } finally {
    // The other tests sign in with a password only.
    await api(request, "DELETE", "/api/settings/sso", {});
    await fake.close();
  }
});
