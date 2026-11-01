import { expect, test, type APIRequestContext } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { ADMIN_STATE, api } from "./helpers.ts";

// The sidebar's brand (QA2-25) and how a logo shows on dark surfaces (QA2-11).

function crc32(buf: Buffer) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A real PNG of one near-black color on a transparent background, so a browser can draw it. */
export function darkPng(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([17, 24, 39, x % 8 < 4 ? 255 : 0], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function setLogo(request: APIRequestContext, png: Buffer) {
  const res = await request.put("/api/settings/appearance/logo", { data: png, headers: { "Content-Type": "image/png" } });
  expect(res.ok(), await res.text()).toBe(true);
}

type Company = { organization: { name: string; appName: string | null; currency: string; address: string } };
async function company(request: APIRequestContext) {
  return (await api<Company>(request, "GET", "/api/settings/company")).organization;
}

test.describe("the brand in the sidebar", () => {
  let original: Awaited<ReturnType<typeof company>>;
  test.beforeEach(async ({ request }) => {
    original = await company(request);
    await api(request, "PUT", "/api/settings/company", { ...original, name: "Northwind Studio", appName: "Northwind Time" });
  });
  test.afterEach(async ({ request }) => {
    await api(request, "DELETE", "/api/settings/appearance/logo", {});
    await api(request, "PUT", "/api/settings/company", { ...original, appName: original.appName ?? "" });
  });

  test("a square logo, or none, sits beside the app name; a wide logo stands alone (QA2-25)", async ({ page, request }) => {
    const brand = page.locator(".wl-sidebar .wl-brand");
    // No logo: the app name, and no second line with the company name.
    await page.goto("/");
    await expect(brand).toContainText("Northwind Time");
    await expect(brand).not.toContainText("Northwind Studio");

    // A square logo: the same name beside it, as in the tab title.
    await setLogo(request, darkPng(64, 64));
    await page.reload();
    await expect(brand.locator("img")).toBeVisible();
    await expect(brand.locator(".wl-brand-name")).toHaveText("Northwind Time");
    await expect(brand.locator(".wl-brand-name")).toHaveAttribute("title", "Northwind Time");
    await expect(page).toHaveTitle(/Northwind Time/);

    // A wide logo stands alone; the name stays for screen readers.
    await setLogo(request, darkPng(256, 64));
    await page.reload();
    await expect(brand).toHaveAttribute("data-logo", "wide");
    await expect(brand.locator(".wl-brand-name")).toHaveCount(0);
    await expect(brand.locator(".wl-sr-only")).toHaveText("Northwind Time");
  });
});

test.describe("text buttons under a form line up with its fields (QA2-26)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // The link only shows when email can send the reset, so email is on for these (and off again after).
  test.beforeEach(async ({ browser }) => {
    const admin = await browser.newContext({ storageState: ADMIN_STATE });
    await api(admin.request, "PUT", "/api/settings/email", { provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false, smtpUser: "" });
    await admin.close();
  });
  test.afterEach(async ({ browser }) => {
    const admin = await browser.newContext({ storageState: ADMIN_STATE });
    await api(admin.request, "DELETE", "/api/settings/email", {});
    await admin.close();
  });
  for (const width of [1440, 375]) {
    test(`Forgot your password? starts at the fields' left edge at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      const button = page.getByRole("button", { name: "Forgot your password?" });
      await expect(button).toBeVisible();
      const field = await page.getByLabel("Email").boundingBox();
      // The button's box starts 8px left of the fields (its padding), so its text starts where the fields do.
      const text = await button.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      });
      expect(Math.abs(text - field!.x)).toBeLessThanOrEqual(1.5);
    });
  }
});

test.describe("dark mode (QA2-11)", () => {
  test.afterEach(async ({ request }) => {
    await api(request, "DELETE", "/api/settings/appearance/logo", {});
    await api(request, "PUT", "/api/settings/appearance", { accentColor: null, colorMode: "system" });
  });
  const plate = (el: Element) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, radius: s.borderTopLeftRadius, padding: s.paddingTop };
  };

  test("a logo sits on a light plate on dark surfaces, and only in dark mode", async ({ page, request, browser }) => {
    await setLogo(request, darkPng(64, 64));
    await api(request, "PUT", "/api/settings/appearance", { accentColor: "#7c3aed", colorMode: "light" });
    await page.goto("/manage/appearance");
    const logo = page.locator(".wl-sidebar .wl-brand img");
    await expect(logo).toBeVisible();
    expect((await logo.evaluate(plate)).background).toBe("rgba(0, 0, 0, 0)");

    await api(request, "PUT", "/api/settings/appearance", { accentColor: "#7c3aed", colorMode: "dark" });
    await page.reload();
    await expect(logo).toBeVisible();
    expect(await logo.evaluate(plate)).toEqual({ background: "rgb(255, 255, 255)", radius: "6px", padding: "4px" });
    // The Appearance preview shows the same.
    expect(await page.locator(".wl-preview .wl-brand img").evaluate(plate)).toEqual({ background: "rgb(255, 255, 255)", radius: "6px", padding: "4px" });

    // The sign-in card too.
    const out = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const signedOut = await out.newPage();
    await signedOut.goto("/");
    const authLogo = signedOut.locator(".wl-auth-logo");
    await expect(authLogo).toBeVisible();
    expect(await authLogo.evaluate(plate)).toEqual({ background: "rgb(255, 255, 255)", radius: "6px", padding: "4px" });
    await out.close();
  });

  test("the invoice on screen stays light in dark mode, with the accent's light shades", async ({ page, request }) => {
    const client = (await api<{ client: { id: string } }>(request, "POST", "/api/clients", { name: `Paper Client ${Date.now()}` })).client;
    const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: "2026-11-01", dueDate: "2026-11-30" });
    await api(request, "PUT", "/api/settings/appearance", { accentColor: "#7c3aed", colorMode: "dark" });
    await page.goto(`/invoices/${invoice.id}`);
    const paper = page.locator("article.wl-invoice");
    await expect(paper).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const look = await paper.evaluate((el) => ({
      background: getComputedStyle(el, "::before").backgroundColor,
      ink: getComputedStyle(el).color,
      accent: getComputedStyle(el).getPropertyValue("--accent-11").trim(),
      pageAccent: getComputedStyle(document.documentElement).getPropertyValue("--accent-11").trim(),
      scheme: getComputedStyle(el).colorScheme,
    }));
    expect(look.background).toBe("rgb(255, 255, 255)");
    expect(look.scheme).toBe("light");
    expect(look.accent).not.toBe("");
    expect(look.accent).not.toBe(look.pageAccent);
    const [r, g, b] = look.ink.match(/\d+/g)!.map(Number);
    expect((r! + g! + b!) / 3).toBeLessThan(100); // dark ink on white
  });
});
