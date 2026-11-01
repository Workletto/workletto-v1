import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Scheduling: planned hours per person, project and week (WRK-139).

beforeEach(resetDatabase);

const WEEK = "2026-10-12"; // a Monday
const HOUR = 3600;

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const manager = await addUser(organization.id, "max@studio.test", "manager-password-1", "manager");
  const member = await addUser(organization.id, "mo@studio.test", "member-password-1");
  const client = await prisma.client.create({ data: { organizationId: organization.id, name: "Acme", currency: "USD" } });
  const site = await prisma.project.create({ data: { organizationId: organization.id, name: "Website", clientId: client.id } });
  const admin2 = await prisma.project.create({ data: { organizationId: organization.id, name: "Studio admin" } });
  const cookies = {
    admin: (await signIn("admin@studio.test", "admin-password-1")).cookie,
    manager: (await signIn("max@studio.test", "manager-password-1")).cookie,
    member: (await signIn("mo@studio.test", "member-password-1")).cookie,
  };
  const json = async (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await request(path, { cookie, ...init });
    return { status: res.status, body: await res.json() };
  };
  const plan = (userId: string, week: string, rows: { projectId: string; minutes: number }[], repeat = false, cookie = cookies.manager) =>
    json(`/api/schedule/${userId}/${week}`, cookie, { method: "PUT", body: { rows, repeat } });
  const grid = (cookie = cookies.manager) => json(`/api/schedule?from=${WEEK}`, cookie);
  return { organization, admin, manager, member, projects: { site, admin: admin2 }, cookies, json, plan, grid };
}

type Week = { week: string; planned: number; available: number; daysOff: number; rows: { project: string; seconds: number }[] };
const weeksOf = (body: { people: { id: string; weeks: Week[] }[] }, id: string) => body.people.find((p) => p.id === id)!.weeks;

describe("schedule", () => {
  it("shows six weeks of planned hours against each person's available hours", async () => {
    const s = await studio();
    expect((await s.plan(s.member.id, WEEK, [{ projectId: s.projects.site.id, minutes: 24 * 60 }, { projectId: s.projects.admin.id, minutes: 22 * 60 }])).status).toBe(200);
    const { status, body } = await s.grid();
    expect(status).toBe(200);
    expect(body.weeks.map((w: { week: string }) => w.week)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"]);
    const mo = weeksOf(body, s.member.id);
    expect(mo[0]).toMatchObject({ planned: 46 * HOUR, available: 40 * HOUR, daysOff: 0 });
    expect(mo[0]!.rows).toEqual([
      { projectId: s.projects.admin.id, project: "Studio admin", seconds: 22 * HOUR },
      { projectId: s.projects.site.id, project: "Website · Acme", seconds: 24 * HOUR },
    ]);
    expect(mo[1]).toMatchObject({ planned: 0, rows: [] });
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual(["Studio admin", "Website · Acme"]);
  });

  it("takes time off and holidays off the hours available", async () => {
    const s = await studio();
    await s.json("/api/settings/time-off/holidays", s.cookies.admin, { body: { date: "2026-10-21", name: "Founders' Day" } });
    await s.json("/api/time-off", s.cookies.member, { body: { from: WEEK, to: "2026-10-13", kind: "vacation" } });
    await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-26", to: "2026-10-30", kind: "vacation" } });
    const { body } = await s.grid();
    const mo = weeksOf(body, s.member.id);
    expect(mo[0]).toMatchObject({ available: 24 * HOUR, daysOff: 2 });
    // The holiday week: a day less for everyone, and it isn't counted as their own time off.
    expect(mo[1]).toMatchObject({ available: 32 * HOUR, daysOff: 0 });
    expect(weeksOf(body, s.manager.id)[1]).toMatchObject({ available: 32 * HOUR, daysOff: 0 });
    expect(body.weeks[1].holidays).toEqual([{ date: "2026-10-21", name: "Founders' Day" }]);
    // Off all week.
    expect(mo[2]).toMatchObject({ available: 0, daysOff: 5 });
  });

  it("replaces a week's plan, repeats it for the next three weeks, and clears it", async () => {
    const s = await studio();
    await s.plan(s.member.id, WEEK, [{ projectId: s.projects.site.id, minutes: 600 }], true);
    let mo = weeksOf((await s.grid()).body, s.member.id);
    expect(mo.map((w) => w.planned)).toEqual([10, 10, 10, 10, 0, 0].map((h) => h * HOUR));

    await s.plan(s.member.id, "2026-10-19", [{ projectId: s.projects.admin.id, minutes: 90 }, { projectId: s.projects.site.id, minutes: 0 }]);
    mo = weeksOf((await s.grid()).body, s.member.id);
    expect(mo[1]!.rows).toEqual([{ projectId: s.projects.admin.id, project: "Studio admin", seconds: 90 * 60 }]);

    await s.plan(s.member.id, WEEK, []);
    expect(weeksOf((await s.grid()).body, s.member.id)[0]!.planned).toBe(0);
    expect(await prisma.auditEvent.count({ where: { organizationId: s.organization.id, kind: "person" } })).toBe(3);
  });

  it("refuses bad plans", async () => {
    const s = await studio();
    const site = s.projects.site.id;
    expect((await s.plan(s.member.id, "2026-10-13", [{ projectId: site, minutes: 60 }])).status).toBe(400); // not a Monday
    expect((await s.plan(s.member.id, WEEK, [{ projectId: site, minutes: 169 * 60 }])).status).toBe(400);
    expect((await s.plan(s.member.id, WEEK, [{ projectId: site, minutes: 1.5 }])).status).toBe(400);
    expect((await s.plan(s.member.id, WEEK, [{ projectId: site, minutes: 60 }, { projectId: site, minutes: 60 }])).status).toBe(400);
    expect((await s.plan(s.member.id, WEEK, [{ projectId: "00000000-0000-4000-8000-000000000000", minutes: 60 }])).status).toBe(400);
    expect((await s.plan("00000000-0000-4000-8000-000000000000", WEEK, [])).status).toBe(404);
    expect((await s.plan(s.member.id, WEEK, [{ projectId: site, minutes: 60 }], false, s.cookies.member)).status).toBe(403);
    expect((await s.grid(s.cookies.member)).status).toBe(403);
  });

  it("keeps each organization's schedule to itself", async () => {
    const s = await studio();
    const other = await createOrgWithUser("Other", "olga@other.test", "other-password-1", "admin");
    const theirs = await prisma.project.create({ data: { organizationId: other.organization.id, name: "Theirs" } });
    const olga = (await signIn("olga@other.test", "other-password-1")).cookie;
    // Neither another organization's project nor its people can be planned.
    expect((await s.plan(s.member.id, WEEK, [{ projectId: theirs.id, minutes: 60 }])).status).toBe(400);
    expect((await s.plan(other.user.id, WEEK, [{ projectId: s.projects.site.id, minutes: 60 }])).status).toBe(404);
    await s.plan(s.member.id, WEEK, [{ projectId: s.projects.site.id, minutes: 60 }]);
    const { body } = await s.json(`/api/schedule?from=${WEEK}`, olga);
    expect(body.people.map((p: { id: string }) => p.id)).toEqual([other.user.id]);
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual(["Theirs"]);
  });

  it("shows members their own plan for the week, with what they've tracked", async () => {
    const s = await studio();
    await s.plan(s.member.id, WEEK, [{ projectId: s.projects.site.id, minutes: 24 * 60 }]);
    await s.plan(s.manager.id, WEEK, [{ projectId: s.projects.admin.id, minutes: 60 }]);
    await prisma.timeEntry.create({ data: { organizationId: s.organization.id, userId: s.member.id, projectId: s.projects.site.id, date: new Date(`${WEEK}T00:00:00Z`), seconds: 5 * HOUR, billable: true } });
    await prisma.timeEntry.create({ data: { organizationId: s.organization.id, userId: s.member.id, projectId: s.projects.site.id, date: new Date("2026-10-19T00:00:00Z"), seconds: HOUR, billable: true } });
    const { status, body } = await s.json(`/api/schedule/me?week=${WEEK}`, s.cookies.member);
    expect(status).toBe(200);
    expect(body.rows).toEqual([{ projectId: s.projects.site.id, project: "Website · Acme", seconds: 24 * HOUR, tracked: 5 * HOUR }]);
    expect((await s.json("/api/schedule/me?week=2026-10-13", s.cookies.member)).status).toBe(400);
  });
});
