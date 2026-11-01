import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";
import { ADMIN_STATE, api, seedClient, unique } from "./helpers.ts";

// What accessibility scanners cannot see (the audit in notes/a11y-audit-2026-10-16.md):
// that focus is visible on every control, that controls are big enough and have an outline
// you can see, that nothing scrolls sideways on a small screen, and that dialogs keep focus.

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
});
test.afterAll(async ({ playwright, baseURL }) => {
  await endPages(playwright, baseURL);
});

// Nothing moves while a page is being photographed.
test.use({ reducedMotion: "reduce" });

// ---- Keyboard walk: Tab through the page, and look for a visible focus indicator at each stop ----

type Stop = { key: string; name: string; tag: string; box: { x: number; y: number; width: number; height: number } };

async function walk(page: Page, limit = 120) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const seen = new Set<string>();
  const hidden: string[] = [];
  let stops = 0;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate<Stop | null>(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.id || "").trim().replace(/\s+/g, " ").slice(0, 40);
      return {
        key: `${el.tagName}:${[...document.querySelectorAll("*")].indexOf(el)}`,
        name,
        tag: el.tagName.toLowerCase() + (el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""),
        box: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 },
      };
    });
    if (!stop) break; // focus left the page: the walk is complete
    if (seen.has(stop.key)) break; // back at the start
    seen.add(stop.key);
    stops++;
    const focused = await page.screenshot({ clip: stop.box });
    await page.evaluate(() => {
      (window as unknown as { __stop: Element }).__stop = document.activeElement!;
      (document.activeElement as HTMLElement).blur();
    });
    const plain = await page.screenshot({ clip: stop.box });
    await page.evaluate(() => (window as unknown as { __stop: HTMLElement }).__stop.focus());
    if (focused.equals(plain)) hidden.push(`${stop.tag} "${stop.name}"`);
  }
  return { stops, hidden };
}

const WALKS = [
  { look: "light", scheme: "light" as const, accent: null, pages: PAGES.map((p) => p.name) },
  { look: "dark", scheme: "dark" as const, accent: null, pages: PAGES.map((p) => p.name) },
  // A pale accent is the hard case for a focus ring.
  { look: "light with a pale accent", scheme: "light" as const, accent: "#a7f3d0", pages: ["Time, day", "Invoices", "Invoice", "Appearance"] },
  { look: "dark with a very dark accent", scheme: "dark" as const, accent: "#0b1f3a", pages: ["Time, day", "Invoices", "Invoice", "Appearance"] },
];

for (const { look, scheme, accent, pages } of WALKS) {
  test.describe(`keyboard walk, ${look}`, () => {
    test.use({ colorScheme: scheme });
    test.beforeAll(async ({ playwright, baseURL }) => {
      if (!accent) return;
      const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
      await api(request, "PUT", "/api/settings/appearance", { accentColor: accent, colorMode: "system" });
      await request.dispose();
    });
    test.afterAll(async ({ playwright, baseURL }) => {
      if (!accent) return;
      const request = await playwright.request.newContext({ baseURL, storageState: ADMIN_STATE });
      await api(request, "PUT", "/api/settings/appearance", { accentColor: null, colorMode: "system" });
      await request.dispose();
    });

    for (const { name, path, heading } of PAGES.filter((p) => pages.includes(p.name))) {
      test(`${name}: every stop shows where focus is`, async ({ page }) => {
        test.setTimeout(120_000);
        await openPage(page, path(seeded), heading);
        const { stops, hidden } = await walk(page);
        test.info().annotations.push({ type: "stops", description: String(stops) });
        expect(stops, "the page has controls to reach with the keyboard").toBeGreaterThan(0);
        expect(hidden, `stops with no visible focus indicator (of ${stops})`).toEqual([]);
      });
    }
  });
}

// ---- Targets of at least 24 x 24 px ----

for (const { look, use } of [
  { look: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  { look: "phone", use: { viewport: { width: 390, height: 844 } } },
]) {
  test.describe(`target size, ${look}`, () => {
    test.use(use);
    for (const { name, path, heading } of PAGES) {
      test(`${name}: every control is at least 24 x 24 px`, async ({ page }) => {
        await openPage(page, path(seeded), heading);
        const small = await page.evaluate(() => {
          const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], [tabindex="0"]';
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>(selector)) {
            // Radix keeps a hidden copy of each drop-down list for forms; it is not a control.
            if (!el.checkVisibility() || el.closest("[inert], [hidden], [aria-hidden='true']")) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.right < 0 || r.left > innerWidth + 1) continue;
            // A link inside a sentence is exempt (WCAG 2.5.8, inline).
            const inline = el instanceof HTMLAnchorElement && getComputedStyle(el).display === "inline";
            if (inline) continue;
            // The skip link waits off-screen until focused.
            if (el.classList.contains("wl-skip")) continue;
            if (r.width < 23.5 || r.height < 23.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        });
        expect(small).toEqual([]);
      });
    }
  });
}

// ---- Outlines of fields and controls: at least 3:1 against what is around them ----

/** Looks at the outline of every field and control on the page. */
async function outlines(page: Page) {
  return await page.evaluate(() => {
    // Any CSS color (including color-mix and display-p3) as sRGB, by painting it.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      g.clearRect(0, 0, 1, 1);
      for (const c of layers) {
        g.fillStyle = "#ffffff00";
        g.fillStyle = c;
        g.fillRect(0, 0, 1, 1);
      }
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return [r!, gg!, b!];
    };
    const lum = ([r, g2, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g2!) + 0.0722 * f(b!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const backdrop = (el: Element) => {
      const layers: string[] = ["#ffffff"];
      const chain: Element[] = [];
      for (let e = el.parentElement; e; e = e.parentElement) chain.unshift(e);
      for (const e of chain) {
        layers.push(getComputedStyle(e).backgroundColor);
        // A card paints its fill on a ::before layer (the invoice paper is always light, even in dark mode).
        if (e.classList.contains("rt-Card")) layers.push(getComputedStyle(e, "::before").backgroundColor);
      }
      return layers;
    };
    // The color of the line that identifies a control: a border, an inset ring, or an underline (an inset shadow
    // offset by 1px or more with no blur or spread, like a filled field's bottom line), on the element or its ::before/::after.
    const outline = (el: Element): string | null => {
      for (const pseudo of [null, "::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (!pseudo && parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== "none" && cs.borderTopColor !== "rgba(0, 0, 0, 0)") return cs.borderTopColor;
        const parts = cs.boxShadow.split(/,(?![^(]*\))/);
        for (const part of parts) {
          const nums = [...part.matchAll(/(-?[\d.]+)px/g)].map((m) => parseFloat(m[1]!));
          const color = part.replace(/(-?[\d.]+)px/g, "").replace("inset", "").trim();
          if (nums.length >= 4 && nums[2] === 0 && nums[3]! >= 1 && color && color !== "none") return color;
          if (part.includes("inset") && nums.length >= 4 && nums[2] === 0 && nums[3] === 0 && Math.abs(nums[1]!) >= 1 && color && color !== "none") return color;
        }
      }
      return null;
    };
    // What WCAG 1.4.11 asks a line of (WRK-121): fields, selects, checkboxes, radios and radio cards keep a full
    // outline or an underline at 3:1; a switch's chosen option keeps a 3:1 edge. Buttons with words are identified
    // by their words (axe checks that text), so they need no outline; icon buttons are checked on their icon below.
    const targets = [
      ".rt-TextFieldRoot", ".rt-TextAreaRoot", ".rt-SelectTrigger:not(.rt-variant-ghost)", ".rt-BaseCheckboxRoot", ".rt-BaseRadioRoot",
      ".rt-SegmentedControlIndicator", ".rt-RadioCardsItem", ".wl-color",
    ];
    const failures: string[] = [];
    let checked = 0;
    let lowest = Infinity;
    for (const el of document.querySelectorAll<HTMLElement>(targets.join(","))) {
      if (!el.checkVisibility() || el.closest("[inert]") || el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled) continue;
      const checkedState = el.getAttribute("data-state") === "checked" || el.getAttribute("aria-checked") === "true";
      if (checkedState) continue; // a checked box or radio is a solid fill of the accent
      const line = outline(el);
      const around = backdrop(el);
      const label = `${el.className.toString().match(/rt-\w+/)?.[0]} "${(el.getAttribute("aria-label") || el.innerText || el.id || "").trim().slice(0, 24)}"`;
      if (!line) {
        failures.push(`${label}: no outline`);
        continue;
      }
      const value = ratio(paint([...around, line]), paint(around));
      checked++;
      lowest = Math.min(lowest, value);
      if (value < 3) failures.push(`${label}: ${value.toFixed(2)}:1`);
    }
    // An icon-only button is identified by its icon: the glyph (drawn in currentColor) is at least 3:1.
    for (const el of document.querySelectorAll<HTMLElement>(".rt-IconButton")) {
      if (!el.checkVisibility() || el.closest("[inert]") || (el as HTMLButtonElement).disabled) continue;
      const own = getComputedStyle(el).backgroundColor;
      const around = [...backdrop(el), own];
      const value = ratio(paint([...around, getComputedStyle(el).color]), paint(around));
      checked++;
      lowest = Math.min(lowest, value);
      if (value < 3) failures.push(`rt-IconButton "${(el.getAttribute("aria-label") || "").slice(0, 24)}" icon: ${value.toFixed(2)}:1`);
    }
    return { failures, checked, lowest };
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`control outlines, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const { name, path, heading } of PAGES) {
      test(`${name}: field and control outlines are at least 3:1`, async ({ page }) => {
        await openPage(page, path(seeded), heading);
        const result = await outlines(page);
        test.info().annotations.push({ type: "outlines", description: `${result.checked} checked, lowest ${result.lowest.toFixed(2)}:1` });
        expect(result.failures).toEqual([]);
      });
    }

    // The import screen shows radio cards and a table only once a file is chosen.
    test(`Import & export with a file chosen: outlines are at least 3:1`, async ({ page }) => {
      await openPage(page, "/manage/data", "Import & export");
      await page.locator('input[type="file"]').setInputFiles("tests/fixtures/harvest-time-export.csv");
      await expect(page.getByRole("radiogroup")).toBeVisible();
      const result = await outlines(page);
      expect(result.checked).toBeGreaterThan(10);
      expect(result.failures).toEqual([]);
    });
  });
}

// ---- Nothing scrolls sideways at 320 px, except a table in its own labeled region ----

test.describe("reflow at 320 px", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  for (const { name, path, heading } of PAGES) {
    test(`${name}: no sideways scroll outside labeled regions`, async ({ page }) => {
      await openPage(page, path(seeded), heading);
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) out.push(`the page scrolls sideways: ${root.scrollWidth}px wide`);
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          const cs = getComputedStyle(el);
          if (!["auto", "scroll"].includes(cs.overflowX) || el.scrollWidth <= el.clientWidth + 1) continue;
          const labeled = el.getAttribute("role") === "region" && !!el.getAttribute("aria-label") && el.tabIndex === 0;
          if (!labeled) out.push(`${el.tagName.toLowerCase()}.${el.className} scrolls sideways without a label`);
        }
        return out;
      });
      expect(problems).toEqual([]);
    });
  }
});

// ---- Menus and dialogs ----

test.describe("dialogs and menus", () => {
  test("the confirm dialog starts on Cancel, closes with Escape and gives focus back", async ({ page, request }) => {
    const client = await seedClient(request, unique("Dialog Client"));
    await page.goto("/clients");
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
    // Archive is in the row's "More actions" menu, which opens on its first item.
    const more = page.getByRole("button", { name: `More actions for ${client.name}` });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Archive" })).toBeFocused();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Archive ${client.name}?`);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    // It is a real dialog: it passes the accessibility scan with its page behind it.
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);

    // Tab stays inside it.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Archive" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    // Escape changes nothing and puts focus back on the button that asked.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();
    await expect(page.getByRole("listitem").filter({ hasText: client.name })).toBeVisible();

    // Confirming does it, and focus is not lost to the top of the page.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Archive" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    // The client is now under the collapsed "Archived" list, with Restore.
    await page.getByText(/^Archived \(\d+\)$/).click();
    await expect(page.getByRole("button", { name: `Restore ${client.name}` })).toBeVisible();
  });

  test("a drop-down list opened with the keyboard has no accessibility violations", async ({ page }) => {
    await openPage(page, `/invoices/new/${seeded.clientId}`, "New invoice");
    const lines = page.getByRole("combobox", { name: "Lines" });
    await lines.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    // While a list is open, Radix hides the page behind it from assistive technology (aria-hidden on #root), which is what a modal list should do; axe's rule about focusable content in a hidden area does not apply to it.
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).disableRules(["aria-hidden-focus"]).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(lines).toBeFocused();
  });

  test("the logo's Choose file button works from the keyboard", async ({ page }) => {
    await openPage(page, "/manage/appearance", "Appearance");
    const button = page.getByRole("button", { name: /^Choose file/ });
    await button.focus();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    expect((await chooser).isMultiple()).toBe(false);
    await expect(button).toBeFocused();
  });
});
