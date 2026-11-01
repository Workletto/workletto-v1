import { expect, test } from "@playwright/test";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";

// Every field says exactly what it is for (WCAG 1.3.1, 2.4.6, 4.1.2): it has a label, no two
// fields on a page share one (a screen reader user hears "Billable rate for Ada Admin", not
// "Billable rate" five times), and names spell days out ("Monday", not "Mon").

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
});
test.afterAll(async ({ playwright, baseURL }) => {
  await endPages(playwright, baseURL);
});

/** The name each field and control has for assistive technology (a close reading of the accessible-name rules). */
function namesOnPage() {
  // The words a screen reader reads: text, minus anything hidden from it.
  const text = (el: Element | null): string => {
    if (!el) return "";
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
      else if (node instanceof Element && node.getAttribute("aria-hidden") !== "true") node.childNodes.forEach(walk);
    };
    walk(el);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  const nameOf = (el: HTMLElement): string => {
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(" ").trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return [...labels].map((l) => text(l)).join(" ").trim();
    if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "combobox") return text(el);
    return (el.getAttribute("title") ?? "").trim();
  };
  // Hidden from assistive technology too: Radix's native <select> and checkbox inputs behind its own controls.
  const visible = (el: HTMLElement) => el.checkVisibility() && !el.closest('[inert], [data-radix-popper-content-wrapper], [aria-hidden="true"]') && el.tabIndex !== -1;
  const fieldSelector = 'main input:not([type="hidden"]):not([type="radio"]), main select, main textarea, main [role="combobox"], main [role="switch"]';
  const fields = [...document.querySelectorAll<HTMLElement>(fieldSelector)].filter(visible).map((el) => ({ name: nameOf(el), tag: el.tagName.toLowerCase() }));
  const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button, header a[href], header button")].filter(visible).map((el) => nameOf(el));
  return { fields, controls };
}

const SHORT_DAY = /\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b(?!day)/;

for (const { name, path, heading } of PAGES) {
  test(`${name}: every field has its own label, and day names are spelled out`, async ({ page }) => {
    await openPage(page, path(seeded), heading);
    const { fields, controls } = await page.evaluate(namesOnPage);

    const unlabelled = fields.filter((f) => !f.name).map((f) => f.tag);
    expect(unlabelled, "fields with no label").toEqual([]);

    const counts = new Map<string, number>();
    for (const f of fields) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([label, n]) => `"${label}" × ${n}`);
    expect(shared, "fields that share a label").toEqual([]);

    const short = [...fields.map((f) => f.name), ...controls].filter((n) => SHORT_DAY.test(n));
    expect(short, "names with a shortened day").toEqual([]);
  });
}
