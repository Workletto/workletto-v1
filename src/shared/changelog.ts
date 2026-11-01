// CHANGELOG.md, read by Manage → About and by the release workflow (scripts/release-notes.mjs).
// Sections are "## [version] - date", with "### Added", "### Fixed", "### Database" and so on.

export type ChangelogSection = { version: string; title: string; body: string };

/** The section for one version ("0.8.0", or "Unreleased"), or null. */
export function changelogSection(markdown: string, version: string): ChangelogSection | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return { version, title: lines[start]!.slice(3).trim(), body: lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim() };
}

export type ChangeGroup = { heading: string | null; items: string[]; text: string[] };

/** A section's body as groups: an optional "### heading", its "- " items and any other lines. */
export function changeGroups(body: string): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let group: ChangeGroup = { heading: null, items: [], text: [] };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      if (group.heading || group.items.length || group.text.length) groups.push(group);
      group = { heading: line.slice(4).trim(), items: [], text: [] };
    } else if (line.startsWith("- ")) {
      group.items.push(line.slice(2).trim());
    } else if (line) {
      group.text.push(line);
    }
  }
  if (group.heading || group.items.length || group.text.length) groups.push(group);
  return groups;
}
