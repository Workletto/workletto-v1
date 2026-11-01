// Picks the release the Update app workflow downloads, from GitHub's list of Workletto
// releases (the JSON of GET /repos/{owner}/{repo}/releases, one page or `gh api --paginate
// --slurp`'s list of pages).
//
//   node .github/update-app/pick-release.mjs releases.json 1.2.0   → prints 1.4.1, or nothing
//
// The newest published release (not a draft or pre-release) with the same major version as
// this copy, and with both its zip and its signature attached. A new major version can change
// how the app is set up, so moving to one is a step you take yourself; it's never picked here.
// Whether the release is newer than this copy is checked later, by apply-release.sh.
import { readFileSync } from "node:fs";

const [file, current] = process.argv.slice(2);
// Exactly X.Y.Z (tags are vX.Y.Z): numbers without leading zeros, nothing after them.
const NUMBER = "(0|[1-9]\\d*)";
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const TAG = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const parse = (text, pattern) => pattern.exec(String(text))?.slice(1).map(Number);

const mine = parse(current, VERSION);
if (!file || !mine) {
  console.error("usage: node pick-release.mjs <releases.json> <current version, e.g. 1.2.0>");
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const releases = Array.isArray(data) ? data.flat() : [];
const candidates = releases
  .filter((release) => release && !release.draft && !release.prerelease)
  .map((release) => ({ version: parse(release.tag_name, TAG), assets: (release.assets ?? []).map((asset) => asset?.name) }))
  .filter(({ version, assets }) => {
    if (!version || version[0] !== mine[0]) return false;
    const zip = `workletto-v${version.join(".")}.zip`;
    return assets.includes(zip) && assets.includes(`${zip}.sig`);
  })
  .map(({ version }) => version)
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

const newest = candidates.at(-1);
if (newest) console.log(newest.join("."));
