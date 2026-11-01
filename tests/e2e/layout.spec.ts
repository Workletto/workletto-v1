import { expect, test } from "@playwright/test";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";

// Visual QA that runs on every push: controls that sit on one line line up, and no two
// controls overlap. A person's eye catches a box 15px lower than its neighbours; this
// catches it first, on every page, at desktop and phone widths.

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
});
test.afterAll(async ({ playwright, baseURL }) => {
  await endPages(playwright, baseURL);
});
test.use({ reducedMotion: "reduce" });

/**
 * Pairs of controls on one line (sharing the nearest row-direction flex or grid container and
 * overlapping by more than half the shorter one's height) whose tops, centers and bottoms all
 * differ by more than a few pixels, and controls that overlap each other.
 */
function layoutProblems() {
  // A field's visible box is its Radix root, not the bare input inside it.
  const boxOf = (el: Element) => (el.closest(".rt-TextFieldRoot, .rt-TextAreaRoot") ?? el) as HTMLElement;
  const found = document.querySelectorAll<HTMLElement>(
    'main button, main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), main select, main textarea, main [role="combobox"]',
  );
  const controls = [...new Set([...found].map(boxOf))].filter(
    (el) => el.checkVisibility() && !el.closest("[data-radix-popper-content-wrapper], [inert], .wl-sr-only") && el.getBoundingClientRect().height > 0,
  );
  const lineOf = (el: HTMLElement) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) || cs.display.includes("grid")) return p;
    }
    return null;
  };
  const name = (el: HTMLElement) =>
    (el.getAttribute("aria-label") || el.querySelector("input,textarea")?.getAttribute("aria-label") || el.innerText || el.className.toString())
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 28);
  const groups = new Map<HTMLElement, HTMLElement[]>();
  for (const el of controls) {
    const line = lineOf(el);
    if (line) groups.set(line, [...(groups.get(line) ?? []), el]);
  }
  const problems: string[] = [];
  for (const els of groups.values()) {
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i]!.getBoundingClientRect();
        const b = els[j]!.getBoundingClientRect();
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (overlapY > 1 && overlapX > 1) {
          problems.push(`"${name(els[i]!)}" overlaps "${name(els[j]!)}"`);
          continue;
        }
        if (overlapY <= 0.5 * Math.min(a.height, b.height)) continue; // not on one line
        const tops = Math.abs(a.top - b.top);
        const bottoms = Math.abs(a.bottom - b.bottom);
        const centers = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
        if (tops > 2 && bottoms > 2 && centers > 3) {
          problems.push(`"${name(els[i]!)}" and "${name(els[j]!)}" on one line are ${Math.round(centers)}px apart (tops ${Math.round(a.top)} / ${Math.round(b.top)})`);
        }
      }
    }
  }
  return problems;
}

for (const width of [1280, 375]) {
  test.describe(`controls line up at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const { name, path, heading } of PAGES) {
      test(`${name}: controls on one line line up and don't overlap`, async ({ page }) => {
        await openPage(page, path(seeded), heading);
        expect(await page.evaluate(layoutProblems)).toEqual([]);
      });
    }
  });
}
