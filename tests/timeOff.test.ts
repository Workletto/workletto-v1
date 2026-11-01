import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Time off and company holidays (WRK-138).

beforeEach(resetDatabase);

const WEEK = "2026-10-12"; // a Monday

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const manager = await addUser(organization.id, "max@studio.test", "manager-password-1", "manager");
  const member = await addUser(organization.id, "mo@studio.test", "member-password-1");
  const cookies = {
    admin: (await signIn("admin@studio.test", "admin-password-1")).cookie,
    manager: (await signIn("max@studio.test", "manager-password-1")).cookie,
    member: (await signIn("mo@studio.test", "member-password-1")).cookie,
  };
  const json = async (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await request(path, { cookie, ...init });
    return { status: res.status, body: await res.json() };
  };
  const list = (cookie: string) => json(`/api/time-off?from=${WEEK}&to=2026-10-25`, cookie);
  return { organization, admin, manager, member, cookies, json, list };
}

describe("time off", () => {
  it("takes weekdays off, skipping weekends, company holidays and days already off", async () => {
    const s = await studio();
    await s.json("/api/settings/time-off/holidays", s.cookies.admin, { body: { date: "2026-10-14", name: "Founders' Day" } });
    const added = await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-12", to: "2026-10-19", kind: "vacation", note: "Lisbon" } });
    // Mon 12, Tue 13, Thu 15, Fri 16, Mon 19: the Wednesday holiday and the weekend are skipped.
    expect(added).toEqual({ status: 201, body: { added: 5, status: "approved" } });
    const again = await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-17", to: "2026-10-19", kind: "vacation" } });
    expect(again.status).toBe(409);

    const { body } = await s.list(s.cookies.member);
    expect(body.timeOff.map((t: { date: string }) => t.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-15", "2026-10-16", "2026-10-19"]);
    expect(body.timeOff[0]).toMatchObject({ kind: "vacation", note: "Lisbon", status: "approved", half: false, name: "mo" });
    expect(body.holidays).toEqual([expect.objectContaining({ date: "2026-10-14", name: "Founders' Day" })]);
  });

  it("is a half day only on a single day, and needs a kind", async () => {
    const s = await studio();
    expect((await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-12", to: "2026-10-13", half: true, kind: "sick" } })).status).toBe(400);
    expect((await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-12", to: "2026-10-12", kind: "holiday" } })).status).toBe(400);
    expect((await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-12", to: "2026-10-12", half: true, kind: "sick" } })).status).toBe(201);
  });

  it("is added for others only by admins and managers, and members see only their own", async () => {
    const s = await studio();
    expect((await s.json("/api/time-off", s.cookies.member, { body: { userId: s.manager.id, from: WEEK, to: WEEK, kind: "other" } })).status).toBe(403);
    expect((await s.json("/api/time-off", s.cookies.manager, { body: { userId: s.member.id, from: WEEK, to: WEEK, kind: "sick" } })).status).toBe(201);
    await s.json("/api/time-off", s.cookies.manager, { body: { from: "2026-10-13", to: "2026-10-13", kind: "vacation" } });
    expect((await s.list(s.cookies.member)).body.timeOff).toHaveLength(1);
    expect((await s.list(s.cookies.manager)).body.timeOff).toHaveLength(2);

    const theirs = (await s.list(s.cookies.manager)).body.timeOff.find((t: { userId: string }) => t.userId === s.manager.id);
    expect((await s.json(`/api/time-off/${theirs.id}`, s.cookies.member, { method: "DELETE" })).status).toBe(404);
    expect((await s.json(`/api/time-off/${theirs.id}`, s.cookies.manager, { method: "DELETE" })).status).toBe(200);
  });

  it("waits for approval when the organization asks for it, and is turned down by removing it", async () => {
    const s = await studio();
    expect((await s.json("/api/settings/time-off", s.cookies.manager, { method: "PUT", body: { approval: true } })).status).toBe(403);
    await s.json("/api/settings/time-off", s.cookies.admin, { method: "PUT", body: { approval: true } });
    expect((await s.json("/api/time-off", s.cookies.member, { body: { from: WEEK, to: "2026-10-13", kind: "vacation" } })).body.status).toBe("pending");
    // A manager's own time off doesn't wait.
    expect((await s.json("/api/time-off", s.cookies.manager, { body: { from: WEEK, to: WEEK, kind: "vacation" } })).body.status).toBe("approved");

    const [monday, tuesday] = (await s.list(s.cookies.member)).body.timeOff;
    expect((await s.json(`/api/time-off/${monday.id}/approve`, s.cookies.member, { body: {} })).status).toBe(403);
    expect((await s.json(`/api/time-off/${monday.id}/approve`, s.cookies.manager, { body: {} })).status).toBe(200);
    expect((await s.json(`/api/time-off/${tuesday.id}/decline`, s.cookies.manager, { body: {} })).status).toBe(200);
    expect((await s.list(s.cookies.member)).body.timeOff.map((t: { status: string }) => t.status)).toEqual(["approved"]);
    expect((await s.json(`/api/time-off/${monday.id}/approve`, s.cookies.manager, { body: {} })).status).toBe(409);
  });
});

describe("the Team page", () => {
  it("takes approved days off and holidays off each person's capacity", async () => {
    const s = await studio();
    await prisma.user.updateMany({ where: { organizationId: s.organization.id }, data: { weeklyCapacity: 40 * 3600 } });
    await s.json("/api/settings/time-off/holidays", s.cookies.admin, { body: { date: "2026-10-16", name: "Studio day" } });
    await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-12", to: "2026-10-12", kind: "vacation" } });
    await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-13", to: "2026-10-13", half: true, kind: "sick" } });
    // Pending time off doesn't count yet.
    await s.json("/api/settings/time-off", s.cookies.admin, { method: "PUT", body: { approval: true } });
    await s.json("/api/time-off", s.cookies.member, { body: { from: "2026-10-14", to: "2026-10-14", kind: "vacation" } });

    const { body } = await s.json(`/api/team?week=${WEEK}`, s.cookies.manager);
    const mo = body.people.find((p: { id: string }) => p.id === s.member.id);
    const max = body.people.find((p: { id: string }) => p.id === s.manager.id);
    // 40 hours, less a day, half a day and the holiday: 2.5 days of 8 hours.
    expect(mo).toMatchObject({ weeklyCapacity: 144000, capacity: 72000, daysOff: 2.5 });
    expect(max).toMatchObject({ capacity: 115200, daysOff: 1 });
  });
});

describe("company holidays", () => {
  it("are kept by admins, one a day", async () => {
    const s = await studio();
    const body = { date: "2026-12-25", name: "Christmas Day" };
    expect((await s.json("/api/settings/time-off/holidays", s.cookies.manager, { body })).status).toBe(403);
    const made = await s.json("/api/settings/time-off/holidays", s.cookies.admin, { body });
    expect(made.status).toBe(201);
    expect((await s.json("/api/settings/time-off/holidays", s.cookies.admin, { body })).status).toBe(409);
    expect((await s.json(`/api/settings/time-off/holidays/${made.body.holiday.id}`, s.cookies.admin, { method: "DELETE" })).status).toBe(200);
  });
});
