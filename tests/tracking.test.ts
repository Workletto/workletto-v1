import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function adminOf(orgName: string, email: string) {
  const { organization, user } = await createOrgWithUser(orgName, email, "admin-password-1", "admin");
  const { cookie } = await signIn(email, "admin-password-1");
  return { organization, user, cookie };
}

async function json(res: Response | Promise<Response>) {
  return (await res).json();
}

async function createClient(cookie: string, name = "Northwind") {
  const res = await request("/api/clients", { body: { name }, cookie });
  expect(res.status).toBe(201);
  return (await res.json()).client as { id: string; name: string; archived: boolean };
}

async function createProject(cookie: string, body: Record<string, unknown> = {}) {
  const res = await request("/api/projects", { body: { name: "Brand refresh", ...body }, cookie });
  expect(res.status).toBe(201);
  return (await res.json()).project as { id: string; billable: boolean };
}

async function addEntry(cookie: string, body: Record<string, unknown>) {
  return request("/api/time-entries", { body: { date: TODAY, seconds: 3600, ...body }, cookie });
}

// Moves the running timer's start back, as if it had been running for a while.
async function backdateTimer(userId: string, seconds: number) {
  await prisma.timeEntry.updateMany({
    where: { userId, startedAt: { not: null } },
    data: { startedAt: new Date(Date.now() - seconds * 1000) },
  });
}

describe("clients and projects", () => {
  it("needs a signed-in person", async () => {
    for (const path of ["/api/clients", "/api/projects", "/api/timer", `/api/time-entries?from=${TODAY}&to=${TODAY}`]) {
      expect((await request(path)).status).toBe(401);
    }
  });

  it("lets an admin add a client and a project for it", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const client = await createClient(cookie, "  Northwind  ");
    expect(client).toMatchObject({ name: "Northwind", archived: false });

    const project = await createProject(cookie, { clientId: client.id });
    expect(project).toMatchObject({ billable: true, client: { id: client.id, name: "Northwind" } });
    const internal = await createProject(cookie, { name: "Studio admin", billable: false });
    expect(internal).toMatchObject({ billable: false, client: null });

    const { projects } = await json(request("/api/projects", { cookie }));
    expect(projects.map((p: { name: string }) => p.name)).toEqual(["Brand refresh", "Studio admin"]);
    const { clients } = await json(request("/api/clients", { cookie }));
    expect(clients).toEqual([{ id: client.id, name: "Northwind", address: "", email: "", currency: "USD", archived: false, projectCount: 1, customFields: {} }]);
  });

  it("checks names and clients", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    expect((await request("/api/clients", { body: { name: "  " }, cookie })).status).toBe(400);
    expect((await request("/api/projects", { body: { name: "x".repeat(201) }, cookie })).status).toBe(400);
    expect((await request("/api/projects", { body: { name: "P", clientId: "no-such-client" }, cookie })).status).toBe(400);

    const client = await createClient(cookie);
    await request(`/api/clients/${client.id}`, { method: "PATCH", body: { archived: true }, cookie });
    const res = await request("/api/projects", { body: { name: "P", clientId: client.id }, cookie });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/archived/);
  });

  it("lets members see clients and projects but not change them", async () => {
    const { organization, cookie: adminCookie } = await adminOf("Studio", "admin@studio.test");
    const client = await createClient(adminCookie);
    const project = await createProject(adminCookie);
    await addUser(organization.id, "member@studio.test", "member-password-1");
    const { cookie } = await signIn("member@studio.test", "member-password-1");

    expect((await json(request("/api/projects", { cookie }))).projects).toHaveLength(1);
    expect((await json(request("/api/clients", { cookie }))).clients).toHaveLength(1);
    expect((await request("/api/clients", { body: { name: "New" }, cookie })).status).toBe(403);
    expect((await request("/api/projects", { body: { name: "New" }, cookie })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}`, { method: "PATCH", body: { archived: true }, cookie })).status).toBe(403);
    expect((await request(`/api/clients/${client.id}`, { method: "DELETE", cookie })).status).toBe(403);
  });

  it("only deletes clients and projects that nothing uses", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const client = await createClient(cookie);
    const project = await createProject(cookie, { clientId: client.id });
    await addEntry(cookie, { projectId: project.id });

    expect((await request(`/api/clients/${client.id}`, { method: "DELETE", cookie })).status).toBe(409);
    expect((await request(`/api/projects/${project.id}`, { method: "DELETE", cookie })).status).toBe(409);

    const unused = await createProject(cookie, { name: "Unused" });
    expect((await request(`/api/projects/${unused.id}`, { method: "DELETE", cookie })).status).toBe(200);
    const spare = await createClient(cookie, "Spare");
    expect((await request(`/api/clients/${spare.id}`, { method: "DELETE", cookie })).status).toBe(200);
  });

  it("renames, archives and restores", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const client = await createClient(cookie);
    const project = await createProject(cookie);

    const renamed = await json(request(`/api/clients/${client.id}`, { method: "PATCH", body: { name: "Northwind Coffee" }, cookie }));
    expect(renamed.client.name).toBe("Northwind Coffee");
    const archived = await json(request(`/api/projects/${project.id}`, { method: "PATCH", body: { archived: true, clientId: client.id }, cookie }));
    expect(archived.project).toMatchObject({ archived: true, client: { id: client.id } });
    const restored = await json(request(`/api/projects/${project.id}`, { method: "PATCH", body: { archived: false, clientId: null }, cookie }));
    expect(restored.project).toMatchObject({ archived: false, client: null });
  });
});

describe("time entries", () => {
  it("adds a manual entry whose billable setting follows the project", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const billable = await createProject(cookie);
    const internal = await createProject(cookie, { name: "Studio admin", billable: false });

    const a = await json(addEntry(cookie, { projectId: billable.id, seconds: 5400, notes: " Logo work " }));
    expect(a.entry).toMatchObject({ date: TODAY, seconds: 5400, notes: "Logo work", billable: true, startedAt: null });
    expect((await json(addEntry(cookie, { projectId: internal.id }))).entry.billable).toBe(false);
    expect((await json(addEntry(cookie, { projectId: billable.id, billable: false }))).entry.billable).toBe(false);
  });

  it("checks dates, durations and projects", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(cookie);
    expect((await addEntry(cookie, { projectId: project.id, date: "2026-02-30" })).status).toBe(400);
    expect((await addEntry(cookie, { projectId: project.id, seconds: 1.5 })).status).toBe(400);
    expect((await addEntry(cookie, { projectId: project.id, seconds: 24 * 3600 + 1 })).status).toBe(400);
    expect((await addEntry(cookie, { projectId: "nope" })).status).toBe(400);

    await request(`/api/projects/${project.id}`, { method: "PATCH", body: { archived: true }, cookie });
    expect((await addEntry(cookie, { projectId: project.id })).status).toBe(400);
    expect((await request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie })).status).toBe(400);
  });

  it("lists your entries for a date range, with their project", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const client = await createClient(cookie);
    const project = await createProject(cookie, { clientId: client.id });
    for (const date of ["2026-10-11", "2026-10-12", "2026-10-18", "2026-10-19"]) await addEntry(cookie, { projectId: project.id, date });

    const { entries } = await json(request("/api/time-entries?from=2026-10-12&to=2026-10-18", { cookie }));
    expect(entries.map((e: { date: string }) => e.date)).toEqual(["2026-10-12", "2026-10-18"]);
    expect(entries[0].project).toMatchObject({ name: "Brand refresh", client: { name: "Northwind" } });

    expect((await request("/api/time-entries?from=2026-10-18&to=2026-10-12", { cookie })).status).toBe(400);
    expect((await request("/api/time-entries?from=2026-01-01&to=2026-12-31", { cookie })).status).toBe(400);
  });

  it("edits and deletes your entries", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const billable = await createProject(cookie);
    const internal = await createProject(cookie, { name: "Studio admin", billable: false });
    const { entry } = await json(addEntry(cookie, { projectId: billable.id }));

    const moved = await json(request(`/api/time-entries/${entry.id}`, {
      method: "PATCH",
      body: { projectId: internal.id, date: "2026-10-14", seconds: 1800, notes: "Planning" },
      cookie,
    }));
    // A new project brings its own billable default.
    expect(moved.entry).toMatchObject({ date: "2026-10-14", seconds: 1800, notes: "Planning", billable: false, project: { id: internal.id } });
    const marked = await json(request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { billable: true }, cookie }));
    expect(marked.entry.billable).toBe(true);

    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: -1 }, cookie })).status).toBe(400);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("keeps each person's entries to themselves within an organization", async () => {
    const { organization, cookie: adminCookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(adminCookie);
    const { entry } = await json(addEntry(adminCookie, { projectId: project.id }));
    await request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie: adminCookie });

    await addUser(organization.id, "member@studio.test", "member-password-1");
    const { cookie } = await signIn("member@studio.test", "member-password-1");
    expect((await json(request(`/api/time-entries?from=${TODAY}&to=${TODAY}`, { cookie }))).entries).toEqual([]);
    expect((await json(request("/api/timer", { cookie }))).entry).toBeNull();
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 1 }, cookie })).status).toBe(404);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await request("/api/timer/start", { body: { entryId: entry.id }, cookie })).status).toBe(404);

    // The member's stop doesn't touch the admin's running timer.
    expect((await json(request("/api/timer/stop", { body: {}, cookie }))).entry).toBeNull();
    expect((await json(request("/api/timer", { cookie: adminCookie }))).entry).not.toBeNull();
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).seconds).toBe(3600);
  });
});

describe("timer", () => {
  it("starts, shows as running, and stops with the time it ran", async () => {
    const { user, cookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(cookie);

    const start = await request("/api/timer/start", { body: { projectId: project.id, date: TODAY, notes: "Sketches" }, cookie });
    expect(start.status).toBe(201);
    const started = (await start.json()).entry;
    expect(started).toMatchObject({ date: TODAY, seconds: 0, notes: "Sketches", billable: true });
    expect(started.startedAt).not.toBeNull();
    expect((await json(request("/api/timer", { cookie }))).entry.id).toBe(started.id);

    await backdateTimer(user.id, 90 * 60);
    const stopped = (await json(request("/api/timer/stop", { body: {}, cookie }))).entry;
    expect(stopped.startedAt).toBeNull();
    expect(stopped.seconds).toBeGreaterThanOrEqual(5400);
    expect(stopped.seconds).toBeLessThan(5410);
    expect((await json(request("/api/timer", { cookie }))).entry).toBeNull();
  });

  it("stops the running timer when another starts, and restarts an entry where it left off", async () => {
    const { user, cookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(cookie);
    const first = (await json(request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie }))).entry;
    await backdateTimer(user.id, 600);
    const second = (await json(request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie }))).entry;

    const rows = await prisma.timeEntry.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.startedAt !== null)).toEqual([false, true]);
    expect(rows[0]!.seconds).toBeGreaterThanOrEqual(600);

    const restarted = (await json(request("/api/timer/start", { body: { entryId: first.id }, cookie }))).entry;
    expect(restarted.id).toBe(first.id);
    expect(restarted.seconds).toBeGreaterThanOrEqual(600);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: second.id } })).startedAt).toBeNull();
  });

  it("carries on running after its duration is edited", async () => {
    const { cookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(cookie);
    const { entry } = await json(request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie }));
    const edited = (await json(request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 3600 }, cookie }))).entry;
    expect(edited.seconds).toBe(3600);
    expect(edited.startedAt).not.toBeNull();
  });

  it("allows one running timer per person, enforced by the database", async () => {
    const { organization, user, cookie } = await adminOf("Studio", "admin@studio.test");
    const project = await createProject(cookie);
    const other = await addUser(organization.id, "member@studio.test", "member-password-1");
    const row = (userId: string) => ({
      organizationId: organization.id,
      userId,
      projectId: project.id,
      date: new Date(`${TODAY}T00:00:00Z`),
      billable: true,
      startedAt: new Date(),
    });

    await prisma.timeEntry.create({ data: row(user.id) });
    await expect(prisma.timeEntry.create({ data: row(user.id) })).rejects.toMatchObject({ code: "P2002" });
    await prisma.timeEntry.create({ data: row(other.id) }); // someone else may run their own
    await prisma.timeEntry.create({ data: { ...row(user.id), startedAt: null } }); // stopped entries are unlimited
  });
});

// The demo runs many organizations in one database: none may see or link to another's rows.
describe("organization isolation for clients, projects and time", () => {
  async function twoStudios() {
    const a = await adminOf("Org A", "a@a.test");
    const b = await adminOf("Org B", "b@b.test");
    const client = await createClient(a.cookie, "A's client");
    const project = await createProject(a.cookie, { clientId: client.id });
    const { entry } = await json(addEntry(a.cookie, { projectId: project.id }));
    return { a, b, client, project, entry };
  }

  it("never shows one organization's clients, projects or entries to another", async () => {
    const { b } = await twoStudios();
    expect((await json(request("/api/clients", { cookie: b.cookie }))).clients).toEqual([]);
    expect((await json(request("/api/projects", { cookie: b.cookie }))).projects).toEqual([]);
    expect((await json(request(`/api/time-entries?from=${TODAY}&to=${TODAY}`, { cookie: b.cookie }))).entries).toEqual([]);
  });

  it("refuses to link to, change or delete another organization's rows through the API", async () => {
    const { b, client, project, entry } = await twoStudios();
    const cookie = b.cookie;

    expect((await request("/api/projects", { body: { name: "Mine", clientId: client.id }, cookie })).status).toBe(400);
    expect((await addEntry(cookie, { projectId: project.id })).status).toBe(400);
    expect((await request("/api/timer/start", { body: { projectId: project.id, date: TODAY }, cookie })).status).toBe(400);
    expect((await request("/api/timer/start", { body: { entryId: entry.id }, cookie })).status).toBe(404);

    const own = await createProject(cookie, { name: "B's project" });
    expect((await request(`/api/projects/${own.id}`, { method: "PATCH", body: { clientId: client.id }, cookie })).status).toBe(400);
    const { entry: bEntry } = await json(addEntry(cookie, { projectId: own.id }));
    expect((await request(`/api/time-entries/${bEntry.id}`, { method: "PATCH", body: { projectId: project.id }, cookie })).status).toBe(400);

    expect((await request(`/api/clients/${client.id}`, { method: "PATCH", body: { name: "Hacked" }, cookie })).status).toBe(404);
    expect((await request(`/api/projects/${project.id}`, { method: "PATCH", body: { archived: true }, cookie })).status).toBe(404);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { seconds: 1 }, cookie })).status).toBe(404);
    expect((await request(`/api/clients/${client.id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await request(`/api/projects/${project.id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await request(`/api/time-entries/${entry.id}`, { method: "DELETE", cookie })).status).toBe(404);

    expect(await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).toMatchObject({ name: "A's client" });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ archived: false });
    expect(await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ seconds: 3600 });
  });

  it("makes cross-organization links impossible in the database itself", async () => {
    const { a, b, client, project } = await twoStudios();
    const fk = { code: "P2003" };

    await expect(
      prisma.project.create({ data: { organizationId: b.organization.id, name: "Sneaky", clientId: client.id } }),
    ).rejects.toMatchObject(fk);
    const entry = (overrides: { userId?: string; projectId?: string }) => ({
      organizationId: b.organization.id,
      userId: b.user.id,
      projectId: project.id,
      date: new Date(`${TODAY}T00:00:00Z`),
      billable: true,
      ...overrides,
    });
    // B's person on A's project.
    await expect(prisma.timeEntry.create({ data: entry({}) })).rejects.toMatchObject(fk);
    // A's person filed under B.
    const own = await prisma.project.create({ data: { organizationId: b.organization.id, name: "B's" } });
    await expect(prisma.timeEntry.create({ data: entry({ projectId: own.id, userId: a.user.id }) })).rejects.toMatchObject(fk);
  });

  it("deletes everything with its organization and leaves others alone", async () => {
    const { a, b } = await twoStudios();
    const bProject = await createProject(b.cookie);
    await addEntry(b.cookie, { projectId: bProject.id });

    await prisma.organization.delete({ where: { id: a.organization.id } });
    expect(await prisma.timeEntry.count()).toBe(1);
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.client.count()).toBe(0);
  });
});
