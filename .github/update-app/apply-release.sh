#!/usr/bin/env bash
# Adds a downloaded Workletto release to the `vendor` branch of this repository.
# The Update app workflow (.github/workflows/update-app.yml) runs it; you can
# also run it yourself from the repository folder:
#
#   bash .github/update-app/apply-release.sh path/to/workletto-v1.2.0.zip 1.2.0
#
# How updates keep your changes: the `vendor` branch holds only untouched
# releases. It starts at this repository's first commit (the release you
# installed) and gets one commit per update. Merging `vendor` into your main
# branch brings in only what changed between releases, and Git keeps your own
# edits. Only lines that both you and the update changed need a decision.
#
# Settings (environment variables):
#   VENDOR_BRANCH        branch name, default "vendor"
#   VENDOR_REMOTE        remote to continue from, default "origin"
#   HOLD_BACK_WORKFLOWS  "1": leave .github/workflows as it is on `vendor`
#                        (GitHub's built-in workflow token may not change them)
set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then say "::error title=Update stopped::$*"; else say "Update stopped: $*" >&2; fi
  exit 1
}
output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then say "$1=$2" >>"$GITHUB_OUTPUT"; fi; }

[ $# -eq 2 ] || fail "usage: apply-release.sh <release zip> <version, e.g. 1.2.0>"
[ -f "$1" ] || fail "$1 does not exist."
zip=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
version=$2
[[ $version =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || fail "\"$version\" is not a version number like 1.2.0."
repo=$(git rev-parse --show-toplevel)
cd "$repo"
branch=${VENDOR_BRANCH:-vendor}
remote=${VENDOR_REMOTE:-origin}
git check-ref-format --branch "$branch" >/dev/null || fail "\"$branch\" is not a valid branch name."
command -v python3 >/dev/null || fail "python3 is needed to unpack the release."

# Where the vendor branch continues from: the local branch, else the one on
# GitHub, else this repository's first commit (the release you started from).
if start=$(git rev-parse --verify --quiet "refs/heads/$branch^{commit}"); then
  say "Continuing the $branch branch."
elif start=$(git rev-parse --verify --quiet "refs/remotes/$remote/$branch^{commit}"); then
  say "Continuing the $branch branch from $remote."
else
  roots=$(git rev-list --max-parents=0 HEAD)
  [ "$(printf '%s\n' "$roots" | wc -l)" -eq 1 ] ||
    fail "This repository has more than one first commit, so the release it started from is unclear. A developer or an AI coding assistant can create the $branch branch at the commit you started from."
  start=$roots
  say "Starting the $branch branch at this repository's first commit, $(git log -1 --format='%h "%s"' "$start")."
fi

# Never go backwards: the update must not be older than what vendor holds.
current=$(git show "$start:package.json" 2>/dev/null |
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)
if [ -n "$current" ]; then
  python3 - "$version" "$current" <<'PY' || fail "v$version is older than v$current, which $branch already has."
import sys
new, cur = (tuple(int(p) for p in v.split(".")) for v in sys.argv[1:3])
sys.exit(0 if new >= cur else 1)
PY
fi

work=$(mktemp -d)
cleanup() {
  git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true
  rm -rf "$work"
  git -C "$repo" worktree prune
}
trap cleanup EXIT
git worktree add --quiet --detach "$work/tree" "$start"

# Replace every file with the release's files, then let Git work out the change.
find "$work/tree" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

python3 - "$zip" "$work/tree" "$version" <<'PY' || fail "The release zip could not be unpacked safely."
# Unpacks the release zip, refusing anything that could write outside the
# folder, plant Git internals, or fill the disk.
import os, stat, sys, zipfile

zip_path, dest, version = sys.argv[1:4]
MAX_ENTRIES, MAX_BYTES, CHUNK = 20_000, 300 * 1024 * 1024, 1 << 16

def stop(message):
    print(message, file=sys.stderr)
    sys.exit(1)

try:
    archive = zipfile.ZipFile(zip_path)
except zipfile.BadZipFile:
    stop("The download is not a zip file.")

with archive:
    entries = archive.infolist()
    if not entries or len(entries) > MAX_ENTRIES:
        stop("The release zip has an unexpected number of files.")
    tops = {e.filename.split("/", 1)[0] for e in entries}
    if len(tops) != 1:
        stop("The release zip must contain exactly one top-level folder.")
    top = tops.pop()
    if not top.endswith(f"-v{version}"):
        stop(f"The zip holds {top}, not version {version}.")

    total = 0
    for entry in entries:
        name = entry.filename
        if name in (top, top + "/"):
            continue
        if not name.startswith(top + "/"):
            stop(f"Unexpected entry {name!r}.")
        parts = name[len(top) + 1 :].rstrip("/").split("/")
        if any(p in ("", ".", "..") or p.lower() == ".git" or "\\" in p or "\0" in p for p in parts):
            stop(f"Unsafe path {name!r}.")
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            stop(f"Symbolic link {name!r} is not allowed.")
        target = os.path.join(dest, *parts)
        if entry.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(entry) as src, open(target, "xb") as out:  # "x": never overwrite
            while chunk := src.read(CHUNK):
                total += len(chunk)
                if total > MAX_BYTES:
                    stop("The release zip is unexpectedly large.")
                out.write(chunk)
        os.chmod(target, 0o755 if mode & 0o111 else 0o644)
PY

tree() { git -C "$work/tree" "$@"; }
# -f: mirror the release exactly, even files that match a .gitignore pattern.
tree add -A -f

# Files that run in the customer's repository, or decide which releases it trusts:
# the pull request points them out.
automation=$(tree diff --cached --name-only -- .github | paste -sd, -)

held_back=""
if [ "${HOLD_BACK_WORKFLOWS:-0}" = "1" ]; then
  held_back=$(tree diff --cached --name-only -- .github/workflows | paste -sd, -)
  if [ -n "$held_back" ]; then
    tree restore --source=HEAD --staged --worktree -- .github/workflows
    say "Left these workflow files as they were (see the pull request): $held_back"
  fi
fi
output held_back "$held_back"
# What's left in the update after holding back (held-back files are explained separately).
if [ -n "$held_back" ]; then
  automation=$(tree diff --cached --name-only -- .github | paste -sd, -)
fi
output automation "$automation"

if tree diff --cached --quiet; then
  changed=false
  git branch --force "$branch" "$start" >/dev/null
  say "The $branch branch already has v$version. Nothing new to add."
else
  changed=true
  tree -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --no-verify \
    -m "Workletto v$version" -m "Untouched release, added by the Update app workflow."
  git branch --force "$branch" "$(tree rev-parse HEAD)" >/dev/null
  say "Added v$version to the $branch branch:$(git diff --shortstat "$start" "$branch")."
fi
output changed "$changed"
output version "$version"

# Is there anything on vendor that the current branch has not merged yet?
if git merge-base --is-ancestor "$branch" HEAD; then output pending false; else output pending true; fi
