import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs the "Download the latest release" step of the Update app workflow, exactly as written,
// in a throwaway repository, with a stand-in for the GitHub CLI that serves a list of releases.

/** The `run: |` script of the workflow step with this name. */
function stepScript(workflow: string, name: string) {
  const lines = readFileSync(workflow, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(start, `step "${name}" in ${workflow}`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  const indent = lines[run]!.search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const margin = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(margin)).join("\n");
}

const download = stepScript(".github/workflows/update-app.yml", "Download the latest release");

const FAKE_GH = `#!/bin/bash
echo "$*" >>"$FAKE_LOG"
if [ "$1" = "api" ]; then
  [ -z "$FAKE_API_FAIL" ] || exit 1
  cat "$FAKE_RELEASES"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  [ -z "$FAKE_DOWNLOAD_FAIL" ] || exit 1
  shift 3
  dir=""
  patterns=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir=$2; shift 2 ;;
      --pattern) patterns+=("$2"); shift 2 ;;
      *) shift ;;
    esac
  done
  for p in "\${patterns[@]}"; do printf 'bytes of %s' "$p" >"$dir/$p"; done
  exit 0
fi
exit 3
`;

const release = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: `workletto-v${version}.zip` }, { name: `workletto-v${version}.zip.sig` }],
});

/** A repository whose first commit is `firstVersion`, optionally with a vendor branch at `vendorVersion`. */
function repository(firstVersion: string, vendorVersion?: string, editedVersion?: string) {
  const dir = mkdtempSync(join(tmpdir(), "update-download-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(dir, ".github/update-app"), { recursive: true });
  copyFileSync(".github/update-app/pick-release.mjs", join(dir, ".github/update-app/pick-release.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: firstVersion }));
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  if (vendorVersion) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: vendorVersion }));
    git("commit", "-q", "-am", "vendor");
    git("update-ref", "refs/remotes/origin/vendor", "HEAD");
  }
  if (editedVersion) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: editedVersion }));
    git("commit", "-q", "-am", "their own edit");
  }
  return dir;
}

function run(dir: string, releases: unknown, env: Record<string, string> = {}) {
  const bin = join(dir, "..", `${dir.split("/").pop()}-bin`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const runner = join(dir, "..", `${dir.split("/").pop()}-runner`);
  mkdirSync(runner, { recursive: true });
  writeFileSync(join(runner, "fake-releases.json"), JSON.stringify(releases));
  const output = join(runner, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-c", download], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: output,
      RELEASES_REPO: "Workletto/workletto-v1",
      VENDOR_BRANCH: "vendor",
      GH_TOKEN: "test",
      FAKE_LOG: join(runner, "gh.log"),
      FAKE_RELEASES: join(runner, "fake-releases.json"),
      ...env,
    },
  });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string]));
  const log = existsSync(join(runner, "gh.log")) ? readFileSync(join(runner, "gh.log"), "utf8") : "";
  return { ...result, outputs, log };
}

describe("the Update app download step", () => {
  const list = [release("1.1.0"), release("1.3.0"), release("2.0.0")];

  it("downloads the newest release for the version the vendor branch holds, zip and signature", () => {
    const result = run(repository("1.0.0", "1.2.0", "9.9.9"), [list]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.outputs.version).toBe("1.3.0");
    expect(readFileSync(result.outputs.zip!, "utf8")).toBe("bytes of workletto-v1.3.0.zip");
    expect(readFileSync(result.outputs.sig!, "utf8")).toBe("bytes of workletto-v1.3.0.zip.sig");
    expect(result.log).toContain("api --paginate --slurp repos/Workletto/workletto-v1/releases?per_page=100");
    expect(result.log).toContain("release download v1.3.0 --repo Workletto/workletto-v1");
  });

  it("goes by the first commit when there's no vendor branch yet", () => {
    const result = run(repository("1.0.0"), [list]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.outputs.version).toBe("1.3.0");
  });

  it("stops with a clear message when GitHub can't be read or the download fails", () => {
    expect(run(repository("1.0.0"), [list], { FAKE_API_FAIL: "1" }).stdout).toContain("title=Download failed::GitHub's list");
    expect(run(repository("1.0.0"), [list], { FAKE_DOWNLOAD_FAIL: "1" }).stdout).toContain("v1.3.0 couldn't be downloaded");
  });

  it("stops when there's no release for this major version, or the version can't be read", () => {
    expect(run(repository("3.0.0"), [list]).stdout).toContain("title=No release found");
    expect(run(repository("1.2.0-rc.1"), [list]).stdout).toContain("title=Version not recognized");
  });
});
