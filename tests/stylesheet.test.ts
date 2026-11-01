import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The app promises it never contacts anyone, and that includes the sites that
// usually serve fonts. The typeface (Inter) comes from an npm package that is
// bundled into the build, so a person's browser only ever talks to their own server.
describe("the interface loads nothing from other sites", () => {
  const css = readFileSync("src/client/styles.css", "utf8");
  const html = readFileSync("index.html", "utf8");

  it("takes its font from the bundled package", () => {
    expect(css).toMatch(/@import\s+"@fontsource-variable\/inter\//);
  });

  it("has no outside address in the stylesheet or the page", () => {
    expect(css).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/(?:href|src)=["']?(?:https?:)?\/\//);
  });
});

// The interface is styled by Radix Themes and one stylesheet of our own. These keep that
// stylesheet honest: no framework left over, and no rule for something that isn't there.
describe("the stylesheet", () => {
  const css = readFileSync("src/client/styles.css", "utf8");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [readFileSync(join(dir, entry.name), "utf8")] : [],
    );
  }
  const code = sources("src/client").join("\n");

  it("leaves no Tailwind behind", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: object; devDependencies?: object };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => /tailwind/i.test(name))).toEqual([]);
    expect(readFileSync("vite.config.ts", "utf8")).not.toMatch(/tailwind/i);
    expect(css).not.toMatch(/tailwind|@theme|@apply|@tailwind/i);
  });

  it("styles only classes that the screens use", () => {
    const defined = new Set(rules.match(/\.wl-[a-z0-9-]+/g)?.map((c) => c.slice(1)));
    const used = new Set(code.match(/\bwl-[a-z0-9-]+/g));
    expect([...defined].filter((c) => !used.has(c))).toEqual([]);
  });

  it("is not missing a class that the screens use", () => {
    const defined = new Set(rules.match(/\.wl-[a-z0-9-]+/g)?.map((c) => c.slice(1)));
    // Names starting with wl- that are CSS variables (var(--wl-ink)) are not classes.
    const used = [...new Set(code.match(/(?<!-)\bwl-[a-z0-9-]+/g))];
    expect(used.filter((c) => !defined.has(c))).toEqual([]);
  });

  it("defines only variables that something reads", () => {
    const defined = [...new Set([...rules.matchAll(/(--wl-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!))];
    const readers = rules + code;
    expect(defined.filter((name) => !new RegExp(`var\\(${name}[,)]`).test(readers))).toEqual([]);
  });
});
