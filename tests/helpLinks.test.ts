import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_CENTER_URL } from "../src/shared/product.ts";

// The "?" beside page titles and the help links in running text (WRK-67) point at Help Center
// articles by their path under /help. These tests keep those links working.

const CLIENT = "src/client";

function clientFiles(dir = CLIENT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? clientFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** Every article path the app links to: help="…" on page headers, article={…} on help links, helpUrl("…"). */
function linkedArticles() {
  const found = new Map<string, string>();
  for (const file of clientFiles()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!/\b(help|article)=|helpUrl\(/.test(line)) return;
      for (const [, path] of line.matchAll(/"([a-z0-9-]+\/[a-z0-9-]+(?:#[a-z0-9-]+)?)"/g)) found.set(path!, `${file}:${i + 1}`);
    });
  }
  return found;
}

describe("help links", () => {
  it("point at the Help Center on the product's own domain unless the build says otherwise", () => {
    expect(HELP_CENTER_URL).toBe("https://workletto.com/help");
    expect(readFileSync(join(CLIENT, "ui.tsx"), "utf8")).toContain("import.meta.env.VITE_HELP_CENTER_URL || HELP_CENTER_URL");
  });

  it("give every screen with a page title a ? to its article", () => {
    const missing: string[] = [];
    for (const file of clientFiles(join(CLIENT, "screens"))) {
      if (file.endsWith("NotFound.tsx")) continue;
      const text = readFileSync(file, "utf8");
      const headers = text.split("<PageHeader").slice(1);
      headers.forEach((h, i) => {
        // The props run to the tag's end: the first ">" outside braces.
        let depth = 0;
        let end = 0;
        for (; end < h.length; end++) {
          if (h[end] === "{") depth++;
          else if (h[end] === "}") depth--;
          else if (h[end] === ">" && depth === 0) break;
        }
        if (!/\bhelp=/.test(h.slice(0, end))) missing.push(`${file} (page header ${i + 1})`);
      });
    }
    expect(missing).toEqual([]);
  });

  // The Help Center is in the store repository. When it's checked out beside this one (as on
  // the vendor's machine), every linked article and heading must exist there.
  const docs = "../store/src/content/docs/help";
  it.skipIf(!existsSync(docs))("link only to articles and headings that exist", () => {
    const links = linkedArticles();
    expect(links.size).toBeGreaterThan(20);
    const broken: string[] = [];
    for (const [link, where] of links) {
      const [article, anchor] = link.split("#");
      const file = join(docs, `${article}.mdx`);
      if (!existsSync(file)) {
        broken.push(`${where}: ${link} (no article)`);
        continue;
      }
      if (!anchor) continue;
      const slugs = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => /^#{2,6} /.test(l))
        .map((l) => l.replace(/^#+ /, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"));
      if (!slugs.includes(anchor)) broken.push(`${where}: ${link} (no such heading)`);
    }
    expect(broken).toEqual([]);
  });
});
