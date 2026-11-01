import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { parseCsv } from "../src/shared/csv.ts";

beforeEach(resetDatabase);

async function admin(org = "Studio", email = "admin@studio.test") {
  const { organization, user } = await createOrgWithUser(org, email, "admin-password-1", "admin");
  const cookie = (await signIn(email, "admin-password-1")).cookie;
  return { organization, user, cookie };
}

const importRows = async (cookie: string, type: string, rows: Record<string, string | undefined>[], options: Record<string, unknown> = {}) =>
  (await request(`/api/data/import/${type}`, { body: { rows, dryRun: false, ...options }, cookie })).json();

describe("export", () => {
  it("downloads a CSV file", async () => {
    const s = await admin();
    const client = (await (await request("/api/clients", { body: { name: "Northwind, Inc." }, cookie: s.cookie })).json()).client;
    await request("/api/projects", { body: { name: "Brand", clientId: client.id, hourlyRate: 12000 }, cookie: s.cookie });

    const res = await request("/api/data/export/projects", { cookie: s.cookie });
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/projects\.csv/);
    const rows = parseCsv(await res.text());
    expect(rows[0]).toEqual(["Project", "Client", "Currency", "Billable", "Bill by", "Hourly rate", "Fixed fee", "Budget type", "Budget hours", "Budget amount", "Archived"]);
    expect(rows[1]).toEqual(["Brand", "Northwind, Inc.", "USD", "Yes", "Project", "120.00", "", "None", "", "", "No"]);
    expect((await request("/api/data/export/nonsense", { cookie: s.cookie })).status).toBe(404);
  });

  it("has all five files, with their headers", async () => {
    const s = await admin();
    const headers = async (type: string) => parseCsv(await (await request(`/api/data/export/${type}`, { cookie: s.cookie })).text())[0];
    expect(await headers("clients")).toEqual(["Name", "Email", "Address", "Currency", "Archived"]);
    expect(await headers("tasks")).toEqual(["Project", "Client", "Task", "Status", "Assigned to", "Due date", "Notes"]);
    expect(await headers("time")).toEqual(["Date", "Person", "Person email", "Client", "Project", "Task", "Notes", "Hours", "Billable", "Billable rate", "Billable amount", "Currency", "Invoiced", "Groups"]);
    expect(await headers("expenses")).toEqual(["Date", "Person", "Person email", "Client", "Project", "Category", "Amount", "Currency", "Notes", "Billable", "Reimbursable", "Groups"]);
  });

  it("writes hours to four decimals, so a 20-minute entry round-trips", async () => {
    const s = await admin();
    await importRows(s.cookie, "time", [{ date: "2026-10-12", person: "Admin", client: "Northwind", project: "Brand", hours: "0:20" }]);
    const rows = parseCsv(await (await request("/api/data/export/time", { cookie: s.cookie })).text());
    const hoursColumn = rows[0]!.indexOf("Hours");
    expect(rows[1]![hoursColumn]).toBe("0.3333");

    // The exported value goes back in as the same 1200 seconds.
    await importRows(s.cookie, "time", [{ date: "2026-10-13", person: "Admin", client: "Northwind", project: "Brand", hours: rows[1]![hoursColumn] }]);
    const seconds = (await prisma.timeEntry.findMany({ select: { seconds: true } })).map((e) => e.seconds);
    expect(seconds).toEqual([1200, 1200]);
  });

  it("is for admins and managers only", async () => {
    const s = await admin();
    await addUser(s.organization.id, "m@studio.test", "member-password-1");
    const member = (await signIn("m@studio.test", "member-password-1")).cookie;
    expect((await request("/api/data/export/clients", { cookie: member })).status).toBe(403);
    expect((await request("/api/data/import/time", { body: { rows: [] }, cookie: member })).status).toBe(403);
  });
});

describe("import", () => {
  it("checks a time file without saving, then imports it, creating missing clients, projects, tasks and people", async () => {
    const s = await admin();
    const rows = [
      { date: "2026-10-12", person: "Maya Chen", client: "Northwind", project: "Brand", task: "Logo", notes: "Sketches", hours: "1.5", billable: "Yes", rate: "120" },
      { date: "2026-10-13", person: "Maya Chen", client: "Northwind", project: "Brand", task: "Logo", hours: "2:15", billable: "No" },
      { date: "2026-10-13", client: "Northwind", project: "Brand", hours: "0.5" }, // no person: the importer's own time
      { date: "2026-13-01", person: "Maya Chen", project: "Brand", hours: "1" },
      { date: "2026-10-14", person: "Maya Chen", project: "Brand", hours: "30" },
    ];
    const check = await (await request("/api/data/import/time", { body: { rows, dryRun: true }, cookie: s.cookie })).json();
    expect(check.created).toEqual({ clients: 1, projects: 1, people: 1, tasks: 1 });
    expect(check.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
    expect(await prisma.project.count()).toBe(0);

    const done = await importRows(s.cookie, "time", rows);
    expect(done.ok).toBe(3);
    const project = await prisma.project.findFirstOrThrow({ include: { client: true, tasks: true } });
    expect(project).toMatchObject({ name: "Brand", hourlyRate: 12000, client: { name: "Northwind" } });
    expect(project.tasks.map((t) => t.title)).toEqual(["Logo"]);
    const maya = await prisma.user.findFirstOrThrow({ where: { name: "Maya Chen" }, include: { accounts: true } });
    expect(maya.accounts).toEqual([]);
    const entries = await prisma.timeEntry.findMany({ orderBy: [{ date: "asc" }, { seconds: "asc" }] });
    expect(entries.map((e) => [e.userId === maya.id ? "maya" : "admin", e.seconds, e.billable, e.taskId !== null])).toEqual([
      ["maya", 5400, true, true],
      ["admin", 1800, true, false],
      ["maya", 8100, false, true],
    ]);
  });

  it("refuses unknown names when told not to create them", async () => {
    const s = await admin();
    const done = await importRows(s.cookie, "time", [{ date: "2026-10-12", project: "Nope", hours: "1" }], { createMissing: false });
    expect(done).toMatchObject({ ok: 0, errors: [{ row: 1, error: 'There\'s no project called "Nope".' }] });
  });

  it("only imports time: the other kinds are gone", async () => {
    const s = await admin();
    for (const kind of ["clients", "projects", "tasks", "expenses"]) {
      expect((await request(`/api/data/import/${kind}`, { body: { rows: [{ name: "X" }], dryRun: false }, cookie: s.cookie })).status).toBe(404);
    }
    expect(await prisma.client.count()).toBe(0);
  });
});

describe("people brought in by an import", () => {
  it("can be invited later, keeping their time", async () => {
    const s = await admin();
    await importRows(s.cookie, "time", [{ date: "2026-10-12", person: "Maya Chen", project: "Brand", hours: "2" }]);
    const { people } = await (await request("/api/people", { cookie: s.cookie })).json();
    const maya = people.find((p: { name: string }) => p.name === "Maya Chen");
    expect(maya).toMatchObject({ joined: false, email: "", active: true });

    const res = await request(`/api/people/${maya.id}/invite`, { body: { email: "maya@studio.test" }, cookie: s.cookie });
    expect(res.status).toBe(201);
    const { token } = await res.json();
    const joined = await request("/api/invites/accept", { body: { token, name: "Maya Chen", password: "a-long-enough-password" } });
    expect(joined.status).toBe(201);
    const me = await (await request("/api/me", { cookie: cookieFrom(joined) })).json();
    expect(me.user).toMatchObject({ id: maya.id, email: "maya@studio.test" });
    expect(await prisma.timeEntry.count({ where: { userId: maya.id } })).toBe(1);
    expect((await request(`/api/people/${maya.id}/invite`, { body: { email: "x@studio.test" }, cookie: s.cookie })).status).toBe(409);
  });
});
