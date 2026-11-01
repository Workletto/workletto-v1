import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { encryptSecret } from "../src/server/secrets.ts";
import { changeGroups, changelogSection } from "../src/shared/changelog.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

async function studio() {
  const { organization, user } = await createOrgWithUser("Studio North", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "member@studio.test", "member-password-1", "member");
  return {
    organization,
    adminId: user.id,
    admin: (await signIn("admin@studio.test", "admin-password-1")).cookie,
    member: (await signIn("member@studio.test", "member-password-1")).cookie,
  };
}

describe("Settings → About", () => {
  it("shows the installed version, what it changed and the database's state, to admins", async () => {
    const s = await studio();
    expect((await request("/api/settings/about", { cookie: s.member })).status).toBe(403);
    expect((await request("/api/settings/about")).status).toBe(401);
    const about = await (await request("/api/settings/about", { cookie: s.admin })).json();
    expect(about.version).toBe(version);
    expect(about.notes.title).toMatch(new RegExp(`^(${version.replace(/\./g, "\\.")}|Unreleased)( · |$)`));
    expect(about.notes.groups.map((g: { heading: string }) => g.heading)).toContain("Database");
    expect(about.database).toMatchObject({ unfinished: [], latest: expect.any(String) });
    expect(about.database.migrations).toBeGreaterThan(0);
  });

  it("makes a diagnostics file with no secrets, addresses or business data", async () => {
    const s = await studio();
    await prisma.emailSettings.create({ data: { organizationId: s.organization.id, provider: "smtp", fromEmail: "hi@studio.test", smtpHost: "smtp.studio.test", smtpUser: "hi", secret: encryptSecret("smtp-password-123") } });
    expect((await request("/api/settings/about/diagnostics", { cookie: s.member })).status).toBe(403);
    const res = await request("/api/settings/about/diagnostics", { cookie: s.admin });
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="diagnostics-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    const report = JSON.parse(text);
    expect(report.app.version).toBe(version);
    expect(report.database.postgres).toMatch(/^\d+/);
    expect(report.setup.email).toEqual({ provider: "smtp", working: true });
    for (const secret of ["Studio North", "studio.test", "smtp-password", process.env.BETTER_AUTH_SECRET, process.env.DATABASE_URL, "localhost"].filter((s): s is string => Boolean(s))) {
      expect(text).not.toContain(secret);
    }
  });

  it("leaves the vendor server's versions and load out of the demo's diagnostics", async () => {
    const s = await studio();
    process.env.DEMO_MODE = "true";
    try {
      const report = await (await request("/api/settings/about/diagnostics", { cookie: s.admin })).json();
      expect(report.app.demo).toBe(true);
      expect(report.app.version).toBe(version);
      for (const field of ["node", "platform", "uptimeMinutes", "memoryMb"]) expect(report.app).not.toHaveProperty(field);
      expect(report.database).not.toHaveProperty("postgres");
      expect(report.database.applied).toBeGreaterThan(0);
    } finally {
      delete process.env.DEMO_MODE;
    }
  });

  it("reads CHANGELOG.md sections", () => {
    const markdown = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2027-01-05\n\nIntro.\n\n### Fixed\n\n- One\n- Two\n\n### Database\n\nAdds a column.\n\n## [1.0.0] - 2026-12-01\n\n- Old";
    const section = changelogSection(markdown, "1.1.0")!;
    expect(section.title).toBe("[1.1.0] - 2027-01-05");
    expect(changeGroups(section.body)).toEqual([
      { heading: null, items: [], text: ["Intro."] },
      { heading: "Fixed", items: ["One", "Two"], text: [] },
      { heading: "Database", items: [], text: ["Adds a column."] },
    ]);
    expect(changelogSection(markdown, "Unreleased")!.body).toBe("");
    expect(changelogSection(markdown, "2.0.0")).toBeNull();
  });
});

describe("the one-time donation card (WRK-168)", () => {
  const show = async (cookie: string) => ((await (await request("/api/settings/about/donation", { cookie })).json()) as { show: boolean }).show;
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

  it("shows to admins 14 days after setup, once the team has tracked time, until it's dismissed", async () => {
    const s = await studio();
    expect((await request("/api/settings/about/donation", { cookie: s.member })).status).toBe(403);
    expect((await request("/api/settings/about/donation/dismiss", { cookie: s.member, body: {} })).status).toBe(403);

    // A new organization: not yet.
    expect(await show(s.admin)).toBe(false);
    // 14 days on, but no time tracked yet.
    await prisma.organization.update({ where: { id: s.organization.id }, data: { createdAt: daysAgo(14) } });
    expect(await show(s.admin)).toBe(false);
    // With time tracked, it shows.
    const project = await prisma.project.create({ data: { organizationId: s.organization.id, name: "Brand" } });
    await prisma.timeEntry.create({ data: { organizationId: s.organization.id, userId: s.adminId, projectId: project.id, date: new Date("2026-10-01T00:00:00Z"), seconds: 3600, billable: true } });
    expect(await show(s.admin)).toBe(true);

    // Donate and Don't show again both dismiss it, for good and for every admin.
    expect((await request("/api/settings/about/donation/dismiss", { cookie: s.admin, body: {} })).status).toBe(200);
    expect(await show(s.admin)).toBe(false);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: s.organization.id } });
    expect(org.donationPromptDismissedAt).toBeInstanceOf(Date);
  });

  it("never shows in the vendor's demo", async () => {
    const s = await studio();
    await prisma.organization.update({ where: { id: s.organization.id }, data: { createdAt: daysAgo(30) } });
    const project = await prisma.project.create({ data: { organizationId: s.organization.id, name: "Brand" } });
    await prisma.timeEntry.create({ data: { organizationId: s.organization.id, userId: s.adminId, projectId: project.id, date: new Date("2026-10-01T00:00:00Z"), seconds: 3600, billable: true } });
    process.env.DEMO_MODE = "true";
    try {
      expect(await show(s.admin)).toBe(false);
    } finally {
      delete process.env.DEMO_MODE;
    }
    expect(await show(s.admin)).toBe(true);
  });

  it("only dismisses its own organization's card", async () => {
    const a = await studio();
    const { organization: other } = await createOrgWithUser("Studio South", "admin@south.test", "admin-password-2", "admin");
    const south = (await signIn("admin@south.test", "admin-password-2")).cookie;
    await request("/api/settings/about/donation/dismiss", { cookie: south, body: {} });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.organization.id } })).donationPromptDismissedAt).toBeNull();
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: other.id } })).donationPromptDismissedAt).toBeInstanceOf(Date);
  });
});
