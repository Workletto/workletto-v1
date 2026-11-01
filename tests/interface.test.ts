import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { serveInterface } from "../src/server/interface.ts";

describe("what the server answers outside the API (QA-62)", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spa-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>App</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    app = createApp();
    serveInterface(app, relative(process.cwd(), dir));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("asks search engines to stay out", async () => {
    const res = await app.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *\nDisallow: /");
  });

  it("gives the app's page to app addresses and files to file addresses", async () => {
    for (const path of ["/", "/projects/anything", "/manage/settings", "/time/day/2026-01-01"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("<title>App</title>");
    }
    expect((await app.request("/assets/app.js")).status).toBe(200);
    expect((await app.request("/favicon.svg")).status).toBe(200);
  });

  it("answers 404, not the app, for a file that isn't there", async () => {
    for (const path of ["/favicon.ico", "/x.png", "/assets/missing.js", "/some/dir/file.txt"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("<title>App</title>");
    }
  });
});
