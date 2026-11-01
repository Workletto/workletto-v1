import { writeFileSync, mkdirSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { endPages, openPage, PAGES, seedPages, type Seeded } from "./a11y-pages.ts";

// What a screen reader says on the main pages, written out for a person to read: not part of
// the normal run.
//   SCREEN_READER=1 npx playwright test screen-reader
// For each page, test-results/screen-reader/<page>.txt has two parts:
//   - Reading order: what is announced moving through the page item by item (as with
//     VoiceOver's VO+Right or NVDA's down arrow), from the browser's own accessibility tree.
//   - Tab order: what is announced on each press of Tab, in order.
test.skip(!process.env.SCREEN_READER, "Runs only with SCREEN_READER=1");

const WANTED = ["Time, week", "Time, day", "Project overview", "Reports", "New invoice", "Invoice", "People", "Expenses", "Settings"];

// How screen readers commonly name each kind of thing (close to VoiceOver's words).
const SPOKEN: Record<string, string> = {
  textbox: "edit text",
  combobox: "pop-up button",
  link: "link",
  button: "button",
  checkbox: "checkbox",
  radio: "radio button",
  switch: "switch",
  tab: "tab",
  heading: "heading",
  navigation: "navigation",
  banner: "banner",
  main: "main",
  region: "region",
  group: "group",
  list: "list",
  listitem: "",
  table: "table",
  row: "row",
  rowheader: "row header",
  columnheader: "column header",
  cell: "",
  img: "image",
  progressbar: "progress indicator",
  status: "status",
  alert: "alert",
  dialog: "dialog",
  paragraph: "",
  text: "",
  timer: "timer",
  separator: "",
  figure: "figure",
  definition: "",
  term: "",
};

/** Turns Playwright's accessibility snapshot (YAML) into the lines a screen reader would speak. */
function spoken(snapshot: string): string[] {
  const out: string[] = [];
  for (const raw of snapshot.split("\n")) {
    const line = raw.trim().replace(/^- /, "");
    if (!line || line.startsWith("/")) continue;
    // e.g.  heading "Oct 19 – 25, 2026" [level=1]   or   text: Billable   or   link "Projects":
    const text = /^text: (.*)$/.exec(line);
    if (text) {
      out.push(text[1]!.replace(/^"|"$/g, ""));
      continue;
    }
    const m = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/.exec(line);
    if (!m) continue;
    const [, role, name = "", attrs = "", inline = ""] = m;
    const word = SPOKEN[role!] ?? role!;
    const states = [...attrs.matchAll(/\[([^\]]+)\]/g)].map((a) => a[1]!.replace("=", " ").replace("level ", "level ").replace("checked", "checked").replace("expanded", "expanded"));
    const parts = [name || inline.replace(/^"|"$/g, ""), word, ...states].filter(Boolean);
    if (!word && !name && !inline) continue;
    if (!parts.length) continue;
    out.push(parts.join(", "));
  }
  return out;
}

async function tabOrder(page: Page, limit = 80): Promise<string[]> {
  const lines: string[] = [];
  await page.locator("body").press("Home");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    if ((await focused.count()) === 0) break;
    const snap = await focused.ariaSnapshot().catch(() => "");
    const first = spoken(snap)[0] ?? "(unnamed)";
    if (lines.length && first === lines[0]) break; // wrapped round to the start
    lines.push(first);
  }
  return lines;
}

let seeded: Seeded;
test.beforeAll(async ({ playwright, baseURL }) => {
  seeded = await seedPages(playwright, baseURL);
  mkdirSync("test-results/screen-reader", { recursive: true });
});
test.afterAll(async ({ playwright, baseURL }) => {
  await endPages(playwright, baseURL);
});

for (const { name, path, heading } of PAGES.filter((p) => WANTED.includes(p.name))) {
  test(name, async ({ page }) => {
    await openPage(page, path(seeded), heading);
    const reading = spoken(await page.locator("body").ariaSnapshot());
    const tabs = await tabOrder(page);
    const file = `test-results/screen-reader/${name.replace(/[^a-z0-9]+/gi, "-")}.txt`;
    writeFileSync(
      file,
      [`${name} — what a screen reader says`, "", "READING ORDER (moving item by item)", ...reading.map((l) => `  ${l}`), "", "TAB ORDER (each press of Tab)", ...tabs.map((l, i) => `  ${String(i + 1).padStart(2)}. ${l}`), ""].join("\n"),
    );
  });
}
