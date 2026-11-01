import { beforeEach, describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/shared/csv.ts";
import { createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// CSV formula injection (WRK-81): a spreadsheet runs a cell that starts with = + - @ (and sometimes
// tab or carriage return) as a formula. Whatever someone types into a name or a note, the files the
// app writes must open as plain text.

beforeEach(resetDatabase);

const FORMULAS = ["=HYPERLINK(\"http://evil.test\",\"x\")", "+SUM(1+1)", "-2+3", "@SUM(A1)", "=cmd|' /C calc'!A0"];

describe("toCsv", () => {
  it("defuses every cell that starts with = + - @, a tab or a carriage return", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = parseCsv(toCsv([[`${lead}1+1`]]))[0]?.[0];
      expect(cell, JSON.stringify(lead)).toBe(`'${lead}1+1`);
    }
    // A leading carriage return is quoted as well as defused, so the file stays one cell.
    expect(toCsv([["\r=1"]])).toBe('"\'\r=1"\r\n');
  });

  it("leaves ordinary text and numbers alone, and only looks at the start of a cell", () => {
    expect(toCsv([["Acme = Co", "a+b", "x@y.test", 5, -5, true, null, undefined, ""]])).toBe("Acme = Co,a+b,x@y.test,5,-5,true,,,\r\n");
  });

  it("defuses a formula hidden behind quotes and commas", () => {
    expect(parseCsv(toCsv([['=A1,"B"']]))[0]).toEqual(["'=A1,\"B\""]);
  });
});

describe("the files the app writes", () => {
  async function studio() {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const cookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    const post = async (path: string, body: Record<string, unknown>) => (await request(path, { body, cookie })).json();
    return { cookie, post };
  }

  const cellsOf = async (cookie: string, path: string) => parseCsv(await (await request(path, { cookie })).text()).flat();
  const expectDefused = (cells: string[], formula: string) => {
    expect(cells, formula).toContain(`'${formula}`);
    expect(cells, `${formula} as a live cell`).not.toContain(formula);
  };

  it("defuses client, project, task, notes and expense category in every data export", async () => {
    const { cookie, post } = await studio();
    const [byClient, byProject, byTask, byNotes, byCategory] = FORMULAS as [string, string, string, string, string];
    const client = (await post("/api/clients", { name: byClient })).client;
    await request(`/api/clients/${client.id}`, { method: "PATCH", body: { email: "ap@acme.test", address: byNotes }, cookie });
    const project = (await post("/api/projects", { name: byProject, clientId: client.id, hourlyRate: 10000 })).project;
    const task = (await post("/api/tasks", { projectId: project.id, title: byTask, notes: byNotes })).task;
    const entry = await post("/api/time-entries", { projectId: project.id, taskId: task.id, date: "2026-10-12", seconds: 3600, notes: byNotes });
    expect(entry.entry.notes).toBe(byNotes);
    expect((await request("/api/expenses", { body: { projectId: project.id, date: "2026-10-12", category: byCategory, amount: 1200, notes: byNotes }, cookie })).status).toBe(201);

    const clients = await cellsOf(cookie, "/api/data/export/clients");
    expectDefused(clients, byClient);
    expectDefused(clients, byNotes); // the address
    const projects = await cellsOf(cookie, "/api/data/export/projects");
    expectDefused(projects, byProject);
    expectDefused(projects, byClient);
    const tasks = await cellsOf(cookie, "/api/data/export/tasks");
    for (const f of [byTask, byProject, byClient, byNotes]) expectDefused(tasks, f);
    const time = await cellsOf(cookie, "/api/data/export/time");
    for (const f of [byNotes, byProject, byClient, byTask]) expectDefused(time, f);
    const expenses = await cellsOf(cookie, "/api/data/export/expenses");
    for (const f of [byCategory, byNotes, byProject, byClient]) expectDefused(expenses, f);
  });

  it("defuses a person's name in the exports", async () => {
    const { cookie, post } = await studio();
    await post("/api/projects", { name: "Site" });
    // An imported person has a name and no login; the time export lists their name.
    const imported = await request("/api/data/import/time", { body: { rows: [{ date: "2026-10-12", person: "=Evil Person", project: "Site", hours: "1" }], dryRun: false, createMissing: true }, cookie });
    expect(imported.status).toBe(200);
    expectDefused(await cellsOf(cookie, "/api/data/export/time"), "=Evil Person");
  });

  it("defuses names and values in the history download", async () => {
    const { cookie, post } = await studio();
    const client = (await post("/api/clients", { name: "Acme" })).client;
    const project = (await post("/api/projects", { name: FORMULAS[1]!, clientId: client.id })).project;
    await request(`/api/projects/${project.id}`, { method: "PATCH", body: { name: FORMULAS[3] }, cookie });
    const cells = await cellsOf(cookie, "/api/history/export");
    expectDefused(cells, FORMULAS[3]!);
    for (const cell of cells) expect(cell, cell).not.toMatch(/^[=+@\t\r]/);
  });

  it("keeps every cell of a data export from starting a formula", async () => {
    const { cookie, post } = await studio();
    for (const [i, formula] of FORMULAS.entries()) {
      const client = (await post("/api/clients", { name: formula })).client;
      const project = (await post("/api/projects", { name: formula, clientId: client.id })).project;
      await post("/api/time-entries", { projectId: project.id, date: "2026-10-12", seconds: 60 * (i + 1), notes: formula });
    }
    for (const type of ["clients", "projects", "tasks", "time", "expenses"]) {
      const rows = parseCsv(await (await request(`/api/data/export/${type}`, { cookie })).text());
      for (const cell of rows.slice(1).flat()) expect(cell, `${type}: ${cell}`).not.toMatch(/^[=+@\t\r]/);
    }
  });
});
