import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/server/db.ts";
import { localNow, sendTimesheetReminders } from "../src/server/timesheets.ts";
import { addDays, startOfWeek } from "../src/shared/time.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);

let server: Awaited<ReturnType<typeof startFakeSmtp>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const today = () => new Date().toISOString().slice(0, 10);
const WEEK = "2026-10-05"; // a Monday in the past
const DAY = "2026-10-07";

async function studio({ approvals = true } = {}) {
  const { organization, user: adminUser } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const managerUser = await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const memberUser = await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  if (approvals) expect((await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "America/New_York" }, cookie: admin })).status).toBe(200);
  const project = (await (await request("/api/projects", { body: { name: "Website" }, cookie: admin })).json()).project;
  const track = (cookie: string, date = DAY, seconds = 3600) => request("/api/time-entries", { body: { projectId: project.id, date, seconds }, cookie });
  const submit = (cookie: string, week = WEEK) => request(`/api/timesheets/mine/${week}/submit`, { body: {}, cookie });
  const decide = (cookie: string, userId: string, decision: string, body: Record<string, unknown> = {}, week = WEEK) =>
    request(`/api/timesheets/${userId}/${week}/${decision}`, { body, cookie });
  const mine = async (cookie: string, from = WEEK, to = WEEK) => (await request(`/api/timesheets/mine?from=${from}&to=${to}`, { cookie })).json();
  return { organization, adminUser, managerUser, memberUser, admin, manager, member, project, track, submit, decide, mine };
}

describe("timesheet approvals", () => {
  it("are off until an admin turns them on", async () => {
    const s = await studio({ approvals: false });
    expect((await s.submit(s.member)).status).toBe(409);
    expect((await s.mine(s.member)).approvals).toBe(false);
    expect((await (await request("/api/me", { cookie: s.member })).json()).organization.timesheetApprovals).toBe(false);
    expect((await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true }, cookie: s.manager })).status).toBe(403);
    expect((await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "Mars/Olympus" }, cookie: s.admin })).status).toBe(400);
    const on = await request("/api/settings/timesheets", { method: "PUT", body: { approvals: true, timeZone: "Europe/Berlin" }, cookie: s.admin });
    expect(await on.json()).toEqual({ approvals: true, timeZone: "Europe/Berlin" });
    expect((await (await request("/api/me", { cookie: s.member })).json()).organization.timesheetApprovals).toBe(true);
  });

  it("locks a submitted week until it's withdrawn", async () => {
    const s = await studio();
    const { entry } = await (await s.track(s.member)).json();
    const res = await s.submit(s.member);
    expect(res.status).toBe(200);
    expect((await res.json()).week).toMatchObject({ weekStart: WEEK, status: "submitted" });
    expect((await s.submit(s.member)).status).toBe(409);

    expect((await s.track(s.member)).status).toBe(409);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 60 }, cookie: s.member })).status).toBe(409);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { date: "2026-10-14" }, cookie: s.member })).status).toBe(409);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie: s.member })).status).toBe(409);
    expect((await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.member })).status).toBe(409);
    expect((await request("/api/timer/start", { body: { entryId: entry.id }, cookie: s.member })).status).toBe(409);
    // Moving other time into the locked week is refused too; other weeks are untouched.
    const other = (await (await s.track(s.member, "2026-10-14")).json()).entry;
    expect((await request(`/api/time-entries/${other.id}`, { method: "PATCH", body: { date: DAY }, cookie: s.member })).status).toBe(409);
    expect((await s.track(s.admin)).status).toBe(201); // someone else's week

    expect((await request(`/api/timesheets/mine/${WEEK}/withdraw`, { body: {}, cookie: s.member })).status).toBe(200);
    expect((await s.mine(s.member)).weeks).toEqual([]);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 60 }, cookie: s.member })).status).toBe(200);
  });

  it("lets managers approve, which locks the week until they reopen it", async () => {
    const s = await studio();
    await s.track(s.member);
    await s.submit(s.member);
    const waiting = (await (await request("/api/timesheets", { cookie: s.manager })).json()).weeks;
    expect(waiting).toMatchObject([{ weekStart: WEEK, status: "submitted", person: { id: s.memberUser.id, name: "member" }, seconds: 3600, billableSeconds: 3600 }]);
    const detail = await (await request(`/api/timesheets/${s.memberUser.id}/${WEEK}`, { cookie: s.manager })).json();
    expect(detail.entries).toHaveLength(1);
    expect(detail.week.status).toBe("submitted");

    const approved = await s.decide(s.manager, s.memberUser.id, "approve");
    expect((await approved.json()).week).toMatchObject({ status: "approved", decidedByName: "manager" });
    expect((await s.track(s.member)).status).toBe(409);
    expect((await request(`/api/timesheets/mine/${WEEK}/withdraw`, { body: {}, cookie: s.member })).status).toBe(409);
    expect((await (await request("/api/timesheets?status=approved", { cookie: s.admin })).json()).weeks).toHaveLength(1);

    expect((await s.decide(s.admin, s.memberUser.id, "reopen")).status).toBe(200);
    expect((await s.track(s.member)).status).toBe(201);

    const history = (await (await request("/api/history?kind=timesheet", { cookie: s.admin })).json()).events;
    expect(history.map((e: { changes: { to: unknown }[] }) => e.changes[0]!.to)).toEqual([null, "approved", "submitted"]);
    expect(history[1]).toMatchObject({ label: "member", entryDate: WEEK, actorName: "manager" });
  });

  it("sends a rejected week back with a note, to fix and submit again", async () => {
    const s = await studio();
    const { entry } = await (await s.track(s.member)).json();
    await s.submit(s.member);
    expect((await s.decide(s.manager, s.memberUser.id, "reject", { note: "Split the workshop time out, please." })).status).toBe(200);
    expect((await s.mine(s.member)).weeks).toMatchObject([{ status: "rejected", note: "Split the workshop time out, please.", decidedByName: "manager" }]);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 1800 }, cookie: s.member })).status).toBe(200);
    expect((await (await s.submit(s.member)).json()).week).toMatchObject({ status: "submitted", note: "" });
    expect((await s.decide(s.manager, s.memberUser.id, "reject", { note: "x".repeat(501) })).status).toBe(400);
  });

  it("never lets anyone decide on their own week, and keeps members out", async () => {
    const s = await studio();
    await s.track(s.manager);
    await s.submit(s.manager);
    expect((await s.decide(s.manager, s.managerUser.id, "approve")).status).toBe(403);
    expect((await s.decide(s.manager, s.managerUser.id, "reopen")).status).toBe(403);
    expect((await s.decide(s.admin, s.managerUser.id, "approve")).status).toBe(200);
    expect((await request("/api/timesheets", { cookie: s.member })).status).toBe(403);
    expect((await s.decide(s.member, s.managerUser.id, "reopen")).status).toBe(403);
    expect((await request(`/api/timesheets/${s.managerUser.id}/${WEEK}`, { cookie: s.member })).status).toBe(403);
    // Nothing to decide on: an open week.
    expect((await s.decide(s.manager, s.memberUser.id, "approve")).status).toBe(409);
  });

  it("checks the week", async () => {
    const s = await studio();
    expect((await s.submit(s.member, "2026-10-06")).status).toBe(400); // a Tuesday
    expect((await s.submit(s.member, addDays(startOfWeek(today()), 14))).status).toBe(400); // hasn't started
    await request("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.member });
    expect((await s.submit(s.member)).status).toBe(409); // a timer is running in it
    expect((await request("/api/timesheets/mine?from=2026-10-06&to=2026-10-12", { cookie: s.member })).status).toBe(400);
  });

  it("reminds people whose last week is still open, on Monday from 9:00 their time, once", async () => {
    const s = await studio();
    server = await startFakeSmtp();
    const smtp = { provider: "smtp", fromName: "Studio", fromEmail: "hello@studio.test", smtpHost: "127.0.0.1", smtpPort: server.port, smtpSecure: false, smtpUser: "" };
    await request("/api/settings/email", { method: "PUT", body: smtp, cookie: s.admin });

    // "Last week" is the week we're in now, seen from next Monday.
    const lastWeek = startOfWeek(today());
    const monday = addDays(lastWeek, 7);
    await s.track(s.member, lastWeek);
    await s.submit(s.member, lastWeek);

    expect(await sendTimesheetReminders(new Date(`${monday}T12:00:00Z`))).toBe(0); // 8:00 in New York
    expect(await sendTimesheetReminders(new Date(`${addDays(monday, -1)}T18:00:00Z`))).toBe(0); // Sunday
    expect(await sendTimesheetReminders(new Date(`${monday}T14:00:00Z`))).toBe(2); // 10:00 in New York
    expect(server.received.flatMap((m) => m.to).sort()).toEqual(["admin@studio.test", "manager@studio.test"]);
    expect(server.received[0]!.subject).toBe("Please submit last week's timesheet");
    expect(server.received[0]!.body).toContain(`/time/week/${lastWeek}`);
    expect(await sendTimesheetReminders(new Date(`${monday}T15:00:00Z`))).toBe(0); // once a week

    // Off means no reminders.
    await prisma.organization.update({ where: { id: s.organization.id }, data: { timesheetApprovals: false, reminderWeek: null } });
    expect(await sendTimesheetReminders(new Date(`${monday}T14:00:00Z`))).toBe(0);
  });

  it("doesn't remind about the week that ended before approvals were turned on, nor claim a week without email", async () => {
    // Turned on on a Wednesday afternoon in New York. Fixed, so the test doesn't depend on the
    // day it runs: on a Sunday evening the week has all but ended when approvals come on.
    vi.useFakeTimers({ now: new Date("2026-10-14T19:00:00Z"), toFake: ["Date"] });
    let s: Awaited<ReturnType<typeof studio>>;
    try {
      s = await studio();
    } finally {
      vi.useRealTimers();
    }
    // Past the fixed date, the sign-ins made then have expired, and people may count as joining
    // after these weeks: sign in again now, and date everyone's joining back.
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    await prisma.user.updateMany({ where: { organizationId: s.organization.id }, data: { createdAt: new Date("2026-10-01T00:00:00Z") } });
    const thisMonday = startOfWeek(localNow("America/New_York", new Date("2026-10-14T19:00:00Z")).date);
    server = await startFakeSmtp();
    const smtp = { provider: "smtp", fromName: "Studio", fromEmail: "hello@studio.test", smtpHost: "127.0.0.1", smtpPort: server.port, smtpSecure: false, smtpUser: "" };
    expect((await request("/api/settings/email", { method: "PUT", body: smtp, cookie: admin })).status).toBe(200);
    expect(await sendTimesheetReminders(new Date(`${thisMonday}T14:00:00Z`))).toBe(0);

    // Without email, Monday's run leaves the week unclaimed, so turning email on later still sends.
    await prisma.emailSettings.deleteMany({ where: { organizationId: s.organization.id } });
    const nextMonday = addDays(thisMonday, 7);
    expect(await sendTimesheetReminders(new Date(`${nextMonday}T14:00:00Z`))).toBe(0);
    expect((await request("/api/settings/email", { method: "PUT", body: smtp, cookie: admin })).status).toBe(200);
    expect(await sendTimesheetReminders(new Date(`${nextMonday}T16:00:00Z`))).toBe(3);
  });

  it("keeps imports out of locked weeks", async () => {
    const s = await studio();
    await s.track(s.member);
    await s.submit(s.member);
    await s.decide(s.manager, s.memberUser.id, "approve");
    const rows = [
      { date: DAY, personEmail: "member@studio.test", project: "Website", hours: "2" },
      { date: "2026-10-14", personEmail: "member@studio.test", project: "Website", hours: "2" },
    ];
    const res = await (await request("/api/data/import/time", { body: { rows, dryRun: false }, cookie: s.admin })).json();
    expect(res.ok).toBe(1);
    expect(res.errors).toEqual([{ row: 1, error: "This person's week is submitted or approved. Reopen it in Approvals first." }]);
  });

  it("reads the local day and hour in a time zone", () => {
    expect(localNow("America/New_York", new Date("2026-10-19T03:30:00Z"))).toEqual({ date: "2026-10-18", weekday: 0, hour: 23 });
    expect(localNow("Asia/Tokyo", new Date("2026-10-18T23:30:00Z"))).toEqual({ date: "2026-10-19", weekday: 1, hour: 8 });
  });
});
