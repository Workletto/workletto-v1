import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs the signing step of the release workflow and the checking step of the customer's
// Update app workflow, exactly as written in the workflow files, with a throwaway key.

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

function keyPair(dir: string, name: string) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "releases@workletto.com", "-f", join(dir, name)]);
  return { private: readFileSync(join(dir, name), "utf8"), public: readFileSync(join(dir, `${name}.pub`), "utf8").trim().split(" ").slice(0, 2).join(" ") };
}

/** A folder laid out like a checkout, trusting `publicKey`. */
function checkout(publicKey: string) {
  const dir = mkdtempSync(join(tmpdir(), "release-signing-"));
  mkdirSync(join(dir, ".github/update-app"), { recursive: true });
  // The real file, with the test's key in place of Workletto's.
  const allowed = readFileSync(".github/update-app/allowed_signers", "utf8").replace(/^(releases@workletto\.com namespaces="workletto-release" ).*$/m, `$1${publicKey}`);
  writeFileSync(join(dir, ".github/update-app/allowed_signers"), allowed);
  mkdirSync(join(dir, "release"));
  mkdirSync(join(dir, "runner"));
  return dir;
}

const bash = (script: string, cwd: string, env: Record<string, string>) => spawnSync("bash", ["-c", script], { cwd, env: { PATH: process.env.PATH!, RUNNER_TEMP: join(cwd, "runner"), ...env }, encoding: "utf8" });

describe("release signatures", () => {
  const keys = mkdtempSync(join(tmpdir(), "release-keys-"));
  const ours = keyPair(keys, "ours");
  const theirs = keyPair(keys, "theirs");
  const check = stepScript(".github/workflows/update-app.yml", "Check Workletto signed it");

  /** The customer's check of a downloaded zip and the signature file published beside it. */
  function verify(zip: Buffer, signature: string | null, trusted = ours.public) {
    const dir = checkout(trusted);
    writeFileSync(join(dir, "runner/release.zip"), zip);
    if (signature !== null) writeFileSync(join(dir, "runner/release.zip.sig"), signature);
    return bash(check, dir, { ZIP: join(dir, "runner/release.zip"), SIG: join(dir, "runner/release.zip.sig") });
  }

  /** The .sig file the release workflow makes and publishes beside the zip. */
  function sign(zip: Buffer, key: string) {
    const dir = mkdtempSync(join(tmpdir(), "sign-"));
    writeFileSync(join(dir, "key"), key, { mode: 0o600 });
    writeFileSync(join(dir, "release.zip"), zip);
    execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-f", join(dir, "key"), "-n", "workletto-release", join(dir, "release.zip")]);
    return readFileSync(join(dir, "release.zip.sig"), "utf8");
  }

  const zip = Buffer.from("PK\u0003\u0004 pretend this is a release");

  it("applies a release signed with the trusted key, and nothing else", () => {
    const good = verify(zip, sign(zip, ours.private));
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toContain("Signature checked");

    expect(verify(Buffer.concat([zip, Buffer.from("!")]), sign(zip, ours.private)).stdout).toContain("Release not verified"); // changed on the way
    expect(verify(zip, sign(zip, theirs.private)).stdout).toContain("Release not verified"); // someone else's key
    expect(verify(zip, null).stdout).toContain("Release not signed");
    expect(verify(zip, "").stdout).toContain("Release not signed");
    expect(verify(zip, "not a signature at all!").stdout).toContain("Release not verified");
  });

  it.skipIf(!existsSync(".github/workflows/release.yml"))("signs each release with the key customers trust", () => {
    const script = stepScript(".github/workflows/release.yml", "Sign it");
    const dir = checkout(ours.public);
    writeFileSync(join(dir, "release/workletto-v0.8.0.zip"), zip);
    const signed = bash(script, dir, { TAG: "v0.8.0", RELEASE_SIGNING_KEY: ours.private });
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    expect(readFileSync(join(dir, "release/workletto-v0.8.0.zip.sha256"), "utf8")).toMatch(/^[0-9a-f]{64}  workletto-v0\.8\.0\.zip\n$/);
    const signature = readFileSync(join(dir, "release/workletto-v0.8.0.zip.sig"), "utf8");
    expect(verify(zip, signature).status).toBe(0);

    // A key that doesn't match the published public half stops the release.
    const other = checkout(ours.public);
    writeFileSync(join(other, "release/workletto-v0.8.0.zip"), zip);
    expect(bash(script, other, { TAG: "v0.8.0", RELEASE_SIGNING_KEY: theirs.private }).status).not.toBe(0);
    expect(bash(script, other, { TAG: "v0.8.0", RELEASE_SIGNING_KEY: "" }).stdout).toContain("Add the RELEASE_SIGNING_KEY secret");
  });
});
