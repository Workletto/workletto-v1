import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Update app workflow asks GitHub for Workletto's releases and lets this script choose one.

type Release = { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: { name: string }[] };

const release = (version: string, extra: Partial<Release> = {}): Release => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: `workletto-v${version}.zip` }, { name: `workletto-v${version}.zip.sig` }, { name: `workletto-v${version}.zip.sha256` }],
  ...extra,
});

function pick(releases: unknown, current: string) {
  const dir = mkdtempSync(join(tmpdir(), "pick-release-"));
  const file = join(dir, "releases.json");
  writeFileSync(file, JSON.stringify(releases));
  const result = spawnSync("node", [".github/update-app/pick-release.mjs", file, current], { encoding: "utf8" });
  return { status: result.status, version: result.stdout.trim() };
}

describe("choosing the release to update to", () => {
  it("picks the newest release with this copy's major version, comparing numbers, not text", () => {
    expect(pick([release("1.2.0"), release("1.10.0"), release("1.9.3")], "1.2.0").version).toBe("1.10.0");
  });

  it("never moves to a new major version by itself", () => {
    expect(pick([release("1.4.0"), release("2.0.0")], "1.2.0").version).toBe("1.4.0");
    expect(pick([release("2.0.0")], "1.2.0").version).toBe("");
  });

  it("skips drafts, pre-releases, odd tags and releases missing the zip or its signature", () => {
    const releases = [
      release("1.3.0"),
      release("1.9.0", { draft: true }),
      release("1.8.0", { prerelease: true }),
      release("1.7.0", { tag_name: "v1.7.0-beta" }),
      release("1.6.0", { assets: [{ name: "workletto-v1.6.0.zip" }] }),
      release("1.5.0", { assets: [{ name: "workletto-v1.5.0.zip.sig" }] }),
      release("1.4.0", { assets: [{ name: "other-v1.4.0.zip" }, { name: "other-v1.4.0.zip.sig" }] }),
    ];
    expect(pick(releases, "1.0.0").version).toBe("1.3.0");
  });

  it("returns this copy's own version when that's the newest, and nothing for an empty list", () => {
    expect(pick([release("1.2.0")], "1.2.0").version).toBe("1.2.0");
    expect(pick([], "1.2.0").version).toBe("");
    expect(pick({ message: "Not Found" }, "1.2.0").version).toBe("");
  });

  it("only takes tags written exactly vX.Y.Z", () => {
    const releases = [release("1.2.0"), release("1.5.0", { tag_name: "1.5.0" }), release("1.4.0", { tag_name: "v01.4.0" })];
    expect(pick(releases, "1.0.0").version).toBe("1.2.0");
  });

  it("reads every page of a long list", () => {
    expect(pick([[release("1.2.0")], [release("1.3.0")]], "1.0.0").version).toBe("1.3.0");
  });

  it("refuses a current version it can't read", () => {
    expect(pick([release("1.2.0")], "latest").status).toBe(2);
    expect(pick([release("1.2.0")], "1.2.0-rc.1").status).toBe(2);
  });
});
