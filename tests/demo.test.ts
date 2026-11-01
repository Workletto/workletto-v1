import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/server/db.ts";
import { DEMO_MONTHS, deleteExpiredDemos } from "../src/server/demo.ts";
import { demoStartsPerIp } from "../src/server/rateLimit.ts";
import { generateDataset } from "../src/server/demoDataset.ts";
import { app, cookieFrom, ORIGIN, request, resetDatabase } from "./helpers.ts";
import { addDays } from "../src/shared/time.ts";
import { DEMO_LOGO } from "../src/server/demoLogo.ts";

// Each demo start writes a lived-in studio, which takes about a second.
vi.setConfig({ testTimeout: 60_000 });

beforeAll(() => {
  process.env.DEMO_MODE = "true";
});
afterAll(() => {
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_MAX_WORKSPACES;
});
beforeEach(async () => {
  await resetDatabase();
  demoStartsPerIp.reset();
  delete process.env.DEMO_MAX_WORKSPACES;
});

let visitor = 0;
async function startDemo() {
  const res = await request("/api/demo/start", { body: {}, ip: `198.51.100.${++visitor % 250}` });
  expect(res.status).toBe(201);
  return cookieFrom(res);
}

describe("demo mode", () => {
  it("gives a visitor a ready-made workspace, signed in as its admin", async () => {
    const cookie = await startDemo();
    const me = await (await request("/api/me", { cookie })).json();
    expect(me.user.role).toBe("admin");
    expect(me.organization.name).toBe("Demo Studio");
    const hours = (new Date(me.organization.demoExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThanOrEqual(2);
    const { members } = await (await request("/api/members", { cookie })).json();
    expect(members).toHaveLength(generateDataset({ today: new Date().toISOString().slice(0, 10), months: DEMO_MONTHS }).people.length);
  });

  it("fills the workspace with a studio's clients, projects and months of time", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = generateDataset({ today, months: DEMO_MONTHS });
    const res = await request("/api/demo/start", { body: { today }, ip: "198.51.100.251" });
    const cookie = cookieFrom(res);
    expect((await (await request("/api/clients", { cookie })).json()).clients).toHaveLength(data.clients.length);
    const { projects } = await (await request("/api/projects", { cookie })).json();
    expect(projects).toHaveLength(data.projects.length);
    expect(projects.filter((p: { billable: boolean }) => !p.billable)).toHaveLength(3);

    // The visitor has their own history, ending today; weekends and no timer running.
    const from = addDays(today, -28);
    const { entries } = await (await request(`/api/time-entries?from=${from}&to=${addDays(today, 5)}`, { cookie })).json();
    const mine = data.entries.filter((e) => e.personKey === "p0" && e.date >= from);
    expect(mine.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(mine.length);
    expect([...new Set(entries.map((e: { date: string }) => e.date))]).toEqual([...new Set(mine.map((e) => e.date))]);
    expect(entries.every((e: { startedAt: string | null }) => e.startedAt === null)).toBe(true);
    // The sample people have time too, but each visitor sees only their own.
    expect(await prisma.timeEntry.count()).toBe(data.entries.length);
  });

  it("has no setup screen", async () => {
    expect(await (await request("/api/setup/status")).json()).toMatchObject({ needsSetup: false, demo: true });
    expect((await request("/api/setup", { body: { setupCode: "test-setup-code-0123456789" } })).status).toBe(404);
  });

  it("never lets one visitor see or change another's workspace", async () => {
    const a = await startDemo();
    const b = await startDemo();

    const meA = await (await request("/api/me", { cookie: a })).json();
    const meB = await (await request("/api/me", { cookie: b })).json();
    expect(meA.organization.id).not.toBe(meB.organization.id);

    const membersA = (await (await request("/api/members", { cookie: a })).json()).members.map((m: { id: string }) => m.id);
    const membersB = (await (await request("/api/members", { cookie: b })).json()).members.map((m: { id: string }) => m.id);
    expect(membersA.filter((id: string) => membersB.includes(id))).toEqual([]);

    // Each has their own sample projects and time.
    const projectsA = (await (await request("/api/projects", { cookie: a })).json()).projects.map((p: { id: string }) => p.id);
    const projectsB = (await (await request("/api/projects", { cookie: b })).json()).projects.map((p: { id: string }) => p.id);
    expect(projectsA.filter((id: string) => projectsB.includes(id))).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    const entry = await request("/api/time-entries", { body: { projectId: projectsA[0], date: today, seconds: 60 }, cookie: b });
    expect(entry.status).toBe(400);

    // A changes their look; B's stays the default.
    const put = await request("/api/settings/appearance", { method: "PUT", body: { accentColor: "#c2410c", colorMode: "dark" }, cookie: a });
    expect(put.status).toBe(200);
    expect((await (await request("/api/me", { cookie: b })).json()).organization).toMatchObject({ accentColor: null, colorMode: "system" });

    // A's logo is A's alone.
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]);
    const upload = await app.request("/api/settings/appearance/logo", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: a, "content-type": "image/png" },
      body: new Blob([png]),
    });
    expect(upload.status).toBe(200);
    // B still sees the demo's own logo, not A's.
    const bLogo = await request("/api/logo", { cookie: b });
    expect(bLogo.status).toBe(200);
    expect(Buffer.from(await bLogo.arrayBuffer()).equals(DEMO_LOGO.data)).toBe(true);

    // The public sign-in branding never reveals a visitor's workspace.
    expect(await (await request("/api/branding")).json()).toMatchObject({ name: null, accentColor: null, logoVersion: null });
  });

  it("blocks password and profile changes", async () => {
    const cookie = await startDemo();
    const res = await request("/api/auth/change-password", {
      body: { currentPassword: "x", newPassword: "something-long-enough" },
      cookie,
    });
    expect(res.status).toBe(403);
    expect((await request("/api/auth/update-user", { body: { name: "Mallory" }, cookie })).status).toBe(403);
  });

  it("shows the Email invoice button as if email were on, but sends nothing", async () => {
    const cookie = await startDemo();
    const { invoices } = await (await request("/api/invoices", { cookie })).json();
    const draft = invoices.find((i: { status: string }) => i.status !== "paid") ?? invoices[0];
    const page = await (await request(`/api/invoices/${draft.id}`, { cookie })).json();
    expect(page.emailConfigured).toBe(true);

    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true, emailedAt: true } });
    const res = await request(`/api/invoices/${draft.id}/email`, { body: { to: "client@example.com" }, cookie });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Email isn't available in the demo. In your own copy, an admin turns it on under Manage → Email, and this sends the invoice straight to your client.",
    );
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true, emailedAt: true } })).toEqual(before);
  });

  it("limits how many demos one address can start", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request("/api/demo/start", { body: {}, ip: "203.0.113.50" })).status).toBe(201);
    }
    expect((await request("/api/demo/start", { body: {}, ip: "203.0.113.50" })).status).toBe(429);
  });

  it("removes the oldest workspaces when the cap is reached", async () => {
    process.env.DEMO_MAX_WORKSPACES = "2";
    const first = await startDemo();
    await startDemo();
    await startDemo();
    expect(await prisma.organization.count()).toBe(2);
    expect((await request("/api/me", { cookie: first })).status).toBe(401);
  });

  it("deletes expired workspaces and everything in them, and nothing else", async () => {
    const expired = await startDemo();
    const live = await startDemo();
    const customer = await prisma.organization.create({ data: { name: "Not a demo" } });
    const expiredOrg = (await (await request("/api/me", { cookie: expired })).json()).organization.id;
    await prisma.organization.update({ where: { id: expiredOrg }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });

    expect(await deleteExpiredDemos()).toBe(1);
    expect((await request("/api/me", { cookie: expired })).status).toBe(401);
    expect(await prisma.user.count({ where: { organizationId: expiredOrg } })).toBe(0);
    expect((await request("/api/me", { cookie: live })).status).toBe(200);
    expect(await prisma.organization.findUnique({ where: { id: customer.id } })).not.toBeNull();
  });
});

describe("outside demo mode", () => {
  beforeAll(() => {
    delete process.env.DEMO_MODE;
  });
  afterAll(() => {
    process.env.DEMO_MODE = "true";
  });

  it("does not offer demos", async () => {
    expect((await request("/api/demo/start", { body: {} })).status).toBe(404);
  });
});
