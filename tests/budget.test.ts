import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);

const DAY = "2026-10-12";
const HOUR = 3600;
let server: Awaited<ReturnType<typeof startFakeSmtp>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function studio({ email = true } = {}) {
  const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  if (email) {
    server = await startFakeSmtp();
    const smtp = { provider: "smtp", fromName: "Studio", fromEmail: "hello@studio.test", smtpHost: "127.0.0.1", smtpPort: server.port, smtpSecure: false, smtpUser: "" };
    expect((await request("/api/settings/email", { method: "PUT", body: smtp, cookie: admin })).status).toBe(200);
  }
  const client = (await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: admin })).json()).client;
  const newProject = async (body: Record<string, unknown>) =>
    (await (await request("/api/projects", { body: { name: "Website", clientId: client.id, ...body }, cookie: manager })).json()).project;
  const track = async (projectId: string, seconds: number, billable?: boolean) => {
    const res = await request("/api/time-entries", { body: { projectId, date: DAY, seconds, ...(billable === undefined ? {} : { billable }) }, cookie: member });
    expect(res.status).toBe(201);
    return (await res.json()).entry as { id: string };
  };
  const level = async (projectId: string) =>
    (await (await request("/api/projects", { cookie: manager })).json()).projects.find((p: { id: string }) => p.id === projectId).budgetAlertLevel;
  const alerts = () => (server?.received ?? []).filter((m) => m.subject.includes("budget"));
  return { admin, manager, member, newProject, track, level, alerts };
}

describe("budget alerts", () => {
  it("emails admins and managers once at 80% and once at 100%, never members", async () => {
    const s = await studio();
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 10 * HOUR });
    await s.track(p.id, 7 * HOUR);
    expect(s.alerts()).toEqual([]);
    expect(await s.level(p.id)).toBe(0);

    await s.track(p.id, 1 * HOUR); // 8 of 10 hours
    expect(await s.level(p.id)).toBe(80);
    expect(s.alerts().flatMap((m) => m.to).sort()).toEqual(["admin@studio.test", "manager@studio.test"]);
    expect(s.alerts()[0]!.subject).toBe("Website (Acme Ltd) has used 80% of its budget");
    expect(s.alerts()[0]!.body).toContain("8:00 h of 10:00 h");
    expect(s.alerts()[0]!.body).toContain(`/projects/${p.id}`);

    await s.track(p.id, 1 * HOUR); // 90%: nothing new
    expect(s.alerts()).toHaveLength(2);
    await s.track(p.id, 1 * HOUR); // 100%
    expect(await s.level(p.id)).toBe(100);
    expect(s.alerts()).toHaveLength(4);
    expect(s.alerts()[2]!.subject).toBe("Website (Acme Ltd) has used all of its budget");
    await s.track(p.id, 2 * HOUR); // over: nothing new
    expect(s.alerts()).toHaveLength(4);
  });

  it("works without email, on the Projects screen only", async () => {
    const s = await studio({ email: false });
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 10 * HOUR });
    await s.track(p.id, 11 * HOUR);
    expect(await s.level(p.id)).toBe(100);
    // Members don't see budgets at all.
    const asMember = (await (await request("/api/projects", { cookie: s.member })).json()).projects[0];
    expect(asMember.budgetAlertLevel).toBeUndefined();
    expect(asMember.budgetSeconds).toBeUndefined();
  });

  it("re-arms when time goes back below a level", async () => {
    const s = await studio();
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 10 * HOUR });
    const mistake = await s.track(p.id, 9 * HOUR);
    expect(s.alerts()).toHaveLength(2);
    await request(`/api/time-entries/${mistake.id}`, { method: "DELETE", cookie: s.member });
    expect(await s.level(p.id)).toBe(0);
    await s.track(p.id, 8 * HOUR);
    expect(s.alerts()).toHaveLength(4);
  });

  it("never alerts about a budget someone just changed", async () => {
    const s = await studio();
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 20 * HOUR });
    await s.track(p.id, 9 * HOUR);
    expect(await s.level(p.id)).toBe(0);
    const lowered = await request(`/api/projects/${p.id}`, { method: "PATCH", body: { budgetSeconds: 9 * HOUR }, cookie: s.manager });
    expect((await lowered.json()).project.budgetAlertLevel).toBe(100);
    expect(s.alerts()).toEqual([]);
    await request(`/api/projects/${p.id}`, { method: "PATCH", body: { budgetSeconds: 100 * HOUR }, cookie: s.manager });
    expect(await s.level(p.id)).toBe(0);
    await request(`/api/projects/${p.id}`, { method: "PATCH", body: { budgetBy: "none" }, cookie: s.manager });
    expect(await s.level(p.id)).toBe(0);
  });

  it("counts billable value for fee budgets, including a rate change", async () => {
    const s = await studio();
    const p = await s.newProject({ hourlyRate: 10000, budgetBy: "fees", budgetAmount: 100000 }); // $100/h, $1,000
    await s.track(p.id, 20 * HOUR, false); // not billable: doesn't count
    await s.track(p.id, 7 * HOUR);
    expect(await s.level(p.id)).toBe(0);
    await request(`/api/projects/${p.id}`, { method: "PATCH", body: { hourlyRate: 12000 }, cookie: s.manager }); // $840 of $1,000
    expect(await s.level(p.id)).toBe(80);
    expect(s.alerts()[0]!.body).toContain("$840.00 of $1,000.00");
  });

  it("sends one alert when two entries cross the line at once", async () => {
    const s = await studio();
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 10 * HOUR });
    await s.track(p.id, 7 * HOUR);
    await Promise.all([s.track(p.id, HOUR), s.track(p.id, HOUR)]);
    expect(await s.level(p.id)).toBe(80);
    expect(s.alerts()).toHaveLength(2); // one each for the admin and the manager
  });

  it("sets each project's level from the time tracked against its budget", async () => {
    const s = await studio({ email: false });
    const hours = await s.newProject({ name: "Hours", budgetBy: "hours", budgetSeconds: 10 * HOUR });
    const fees = await s.newProject({ name: "Fees", hourlyRate: 10000, budgetBy: "fees", budgetAmount: 100000 });
    const under = await s.newProject({ name: "Under", budgetBy: "hours", budgetSeconds: 10 * HOUR });
    await s.track(hours.id, 10 * HOUR);
    await s.track(fees.id, 8.5 * HOUR);
    await s.track(fees.id, 5 * HOUR, false);
    await s.track(under.id, 7.9 * HOUR);
    const levels = async () => Object.fromEntries((await prisma.project.findMany({ select: { name: true, budgetAlertLevel: true } })).map((p) => [p.name, p.budgetAlertLevel]));
    expect(await levels()).toEqual({ Hours: 100, Fees: 80, Under: 0 });
  });

  it("counts a timer once it stops", async () => {
    const s = await studio({ email: false });
    const p = await s.newProject({ budgetBy: "hours", budgetSeconds: 10 * HOUR });
    const { entry } = await (await request("/api/timer/start", { body: { projectId: p.id, date: DAY }, cookie: s.member })).json();
    await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 9 * HOUR }, cookie: s.member });
    expect(await s.level(p.id)).toBe(80);
    await request("/api/timer/stop", { body: {}, cookie: s.member });
    expect(await s.level(p.id)).toBe(80);
  });
});
