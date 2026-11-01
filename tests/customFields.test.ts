import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Custom fields (WRK-148): an admin's own fields on time entries, projects and clients, filled in
// with those records, used by reports and exports, and hidden rather than deleted.

beforeEach(resetDatabase);

async function studio(name = "Studio", domain = "studio.test") {
  const { organization } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  await addUser(organization.id, `ada@${domain}`, "member-password-1", "member");
  const admin = (await signIn(`admin@${domain}`, "admin-password-1")).cookie;
  const member = (await signIn(`ada@${domain}`, "member-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json().catch(() => null), text: res.headers.get("content-type")?.includes("csv") ? await res.clone().text().catch(() => "") : "" };
  };
  const field = async (body: Record<string, unknown>) => {
    const res = await json("/api/custom-fields", { body });
    expect(res.status).toBe(201);
    return res.body.field as { id: string; name: string };
  };
  const client = (await json("/api/clients", { body: { name: "Acme" } })).body.client;
  const project = (await json("/api/projects", { body: { name: "Brand", clientId: client.id, hourlyRate: 10_000 } })).body.project;
  return { organization, admin, member, json, field, client, project };
}

const DAY = "2026-10-12";

describe("setting up custom fields", () => {
  it("takes a name, where it goes, a type and whether it's required; only admins add them", async () => {
    const s = await studio();
    const phase = await s.field({ name: "Phase", appliesTo: "time", type: "choice", choices: "Discovery\nDesign\nBuild\nDesign", required: true });
    expect(phase).toMatchObject({ name: "Phase", appliesTo: "time", type: "choice", choices: ["Discovery", "Design", "Build"], required: true, archived: false });
    await s.field({ name: "PO", appliesTo: "project", type: "text" });
    await s.field({ name: "Headcount", appliesTo: "client", type: "number" });
    expect((await s.json("/api/custom-fields", { body: { name: "phase", appliesTo: "time", type: "text" } })).status).toBe(409);
    expect((await s.json("/api/custom-fields", { body: { name: "Phase", appliesTo: "project", type: "text" } })).status).toBe(201); // another kind of record
    expect((await s.json("/api/custom-fields", { body: { name: "Mood", appliesTo: "time", type: "choice", choices: "" } })).status).toBe(400);
    expect((await s.json("/api/custom-fields", { body: { name: "Mood", appliesTo: "invoices", type: "text" } })).status).toBe(400);
    expect((await s.json("/api/custom-fields", { body: { name: "Mood", appliesTo: "time", type: "text" }, cookie: s.member })).status).toBe(403);
    // Everyone sees the fields in use, to fill them in.
    expect((await s.json("/api/custom-fields", { cookie: s.member })).body.fields).toHaveLength(4);
    expect(await prisma.auditEvent.count({ where: { label: "Custom field" } })).toBe(4);
  });
});

describe("filling them in", () => {
  it("checks each type, and needs a required field on new time entries and timers", async () => {
    const s = await studio();
    const phase = await s.field({ name: "Phase", appliesTo: "time", type: "choice", choices: ["Design", "Build"], required: true });
    const units = await s.field({ name: "Units", appliesTo: "time", type: "number" });
    const entry = (body: Record<string, unknown>) => s.json("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds: 3600, ...body }, cookie: s.member });

    expect(await entry({})).toMatchObject({ status: 400, body: { error: "Fill in Phase: it's required." } });
    expect((await entry({ customFields: { [phase.id]: "Demolition" } })).status).toBe(400);
    expect((await entry({ customFields: { [phase.id]: "Design", [units.id]: "twelve" } })).status).toBe(400);
    const made = await entry({ customFields: { [phase.id]: "Design", [units.id]: "12.5" } });
    expect(made.status).toBe(201);
    expect(made.body.entry.customFields).toEqual({ [phase.id]: "Design", [units.id]: "12.5" });
    expect((await s.json(`/api/time-entries?from=${DAY}&to=${DAY}`, { cookie: s.member })).body.entries[0].customFields).toEqual({ [phase.id]: "Design", [units.id]: "12.5" });

    // Changing: a field left out stays, an optional one can be emptied, a required one can't.
    const id = made.body.entry.id;
    expect((await s.json(`/api/time-entries/${id}`, { method: "PATCH", body: { notes: "Wireframes" }, cookie: s.member })).body.entry.customFields[phase.id]).toBe("Design");
    expect((await s.json(`/api/time-entries/${id}`, { method: "PATCH", body: { customFields: { [phase.id]: "" } }, cookie: s.member })).status).toBe(400);
    const changed = await s.json(`/api/time-entries/${id}`, { method: "PATCH", body: { customFields: { [phase.id]: "Build", [units.id]: "" } }, cookie: s.member });
    expect(changed.body.entry.customFields).toEqual({ [phase.id]: "Build" });

    expect((await s.json("/api/timer/start", { body: { projectId: s.project.id, date: DAY }, cookie: s.member })).status).toBe(400);
    const timer = await s.json("/api/timer/start", { body: { projectId: s.project.id, date: DAY, customFields: { [phase.id]: "Build" } }, cookie: s.member });
    expect(timer.status).toBe(201);
    expect(timer.body.entry.customFields).toEqual({ [phase.id]: "Build" });
  });

  it("goes on projects and clients too, shown to admins and managers", async () => {
    const s = await studio();
    const po = await s.field({ name: "PO", appliesTo: "project", type: "text" });
    const size = await s.field({ name: "Headcount", appliesTo: "client", type: "number", required: true });
    expect((await s.json("/api/clients", { body: { name: "Globex" } })).status).toBe(400);
    const client = (await s.json("/api/clients", { body: { name: "Globex", customFields: { [size.id]: "40" } } })).body.client;
    expect(client.customFields).toEqual({ [size.id]: "40" });
    expect((await s.json(`/api/clients/${client.id}`, { method: "PATCH", body: { customFields: { [size.id]: "45" } } })).body.client.customFields).toEqual({ [size.id]: "45" });
    const project = (await s.json("/api/projects", { body: { name: "Site", clientId: client.id, customFields: { [po.id]: "PO-7" } } })).body.project;
    expect(project.customFields).toEqual({ [po.id]: "PO-7" });
    expect((await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { customFields: { [po.id]: "PO-8" } } })).body.project.customFields).toEqual({ [po.id]: "PO-8" });
    // Members see neither.
    const asMember = (await s.json(`/api/projects/${project.id}`, { cookie: s.member })).body.project;
    expect(asMember).not.toHaveProperty("customFields");
  });
});

describe("removing a field", () => {
  it("hides it and keeps its values, until it's restored; a choice in use can't be dropped", async () => {
    const s = await studio();
    const phase = await s.field({ name: "Phase", appliesTo: "time", type: "choice", choices: ["Design", "Build"], required: true });
    const made = await s.json("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds: 600, customFields: { [phase.id]: "Design" } } });
    expect((await s.json(`/api/custom-fields/${phase.id}`, { method: "PATCH", body: { choices: ["Build"] } })).status).toBe(409);
    expect((await s.json(`/api/custom-fields/${phase.id}`, { method: "PATCH", body: { choices: ["Design", "Build", "Launch"] } })).body.field.choices).toEqual(["Design", "Build", "Launch"]);

    expect((await s.json(`/api/custom-fields/${phase.id}`, { method: "PATCH", body: { archived: true } })).body.field.archived).toBe(true);
    expect((await s.json("/api/custom-fields")).body.fields).toEqual([]);
    expect((await s.json("/api/custom-fields?all=1")).body.fields).toHaveLength(1);
    expect((await s.json("/api/custom-fields?all=1", { cookie: s.member })).body.fields).toHaveLength(0);
    // No longer required or shown, but the value is still there.
    expect((await s.json("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds: 600 } })).status).toBe(201);
    expect((await s.json(`/api/time-entries?from=${DAY}&to=${DAY}`)).body.entries.find((e: { id: string }) => e.id === made.body.entry.id).customFields).toEqual({});
    expect(await prisma.customFieldValue.count()).toBe(1);

    await s.json(`/api/custom-fields/${phase.id}`, { method: "PATCH", body: { archived: false } });
    expect((await s.json(`/api/time-entries?from=${DAY}&to=${DAY}`)).body.entries.find((e: { id: string }) => e.id === made.body.entry.id).customFields).toEqual({ [phase.id]: "Design" });
  });
});

describe("reports and exports", () => {
  it("group and filter by a list field, and add the values as columns", async () => {
    const s = await studio();
    const phase = await s.field({ name: "Phase", appliesTo: "time", type: "choice", choices: ["Design", "Build"] });
    const tier = await s.field({ name: "Tier", appliesTo: "client", type: "choice", choices: ["Gold", "Silver"] });
    await s.json(`/api/clients/${s.client.id}`, { method: "PATCH", body: { customFields: { [tier.id]: "Gold" } } });
    const add = (seconds: number, value?: string) => s.json("/api/time-entries", { body: { projectId: s.project.id, date: DAY, seconds, ...(value ? { customFields: { [phase.id]: value } } : {}) } });
    await add(3600, "Design");
    await add(1800, "Design");
    await add(7200, "Build");
    await add(900);

    const range = `from=${DAY}&to=${DAY}`;
    const grouped = (await s.json(`/api/reports/summary?${range}&groupBy=field:${phase.id}`)).body;
    expect(grouped.groupBy).toBe(`field:${phase.id}`);
    expect(grouped.rows.map((r: { label: string; seconds: number }) => [r.label, r.seconds])).toEqual([["Build", 7200], ["Design", 5400], ["No Phase", 900]]);
    const byTier = (await s.json(`/api/reports/summary?${range}&groupBy=field:${tier.id}`)).body;
    expect(byTier.rows.map((r: { label: string; seconds: number }) => [r.label, r.seconds])).toEqual([["Gold", 13500]]);

    const design = (await s.json(`/api/reports/summary?${range}&fieldId=${phase.id}&fieldValue=Design`)).body;
    expect(design.totals.seconds).toBe(5400);
    expect((await s.json(`/api/reports/summary?${range}&fieldId=${phase.id}&fieldValue=`)).body.totals.seconds).toBe(900);
    expect((await s.json(`/api/reports/summary?${range}&fieldId=${tier.id}&fieldValue=Silver`)).body.totals.seconds).toBe(0);
    // A member can't group by a client field: the report falls back to projects.
    expect((await s.json(`/api/reports/summary?${range}&groupBy=field:${tier.id}`, { cookie: s.member })).body.groupBy).toBe("project");

    const entries = (await s.json(`/api/reports/entries?${range}&fieldId=${phase.id}&fieldValue=Build`)).body;
    expect(entries.fields).toEqual([{ id: phase.id, name: "Phase" }]);
    expect(entries.entries.map((e: { customFields: Record<string, string> }) => e.customFields)).toEqual([{ [phase.id]: "Build" }]);

    const csv = await (await request(`/api/data/export/time?${range}`, { cookie: s.admin })).text();
    const [header, ...lines] = csv.trim().split(/\r?\n/);
    expect(header!.endsWith(",Invoiced,Groups,Phase")).toBe(true);
    expect(lines.filter((l) => l.endsWith(",Design"))).toHaveLength(2);
    const clientsCsv = await (await request("/api/data/export/clients", { cookie: s.admin })).text();
    expect(clientsCsv.split(/\r?\n/)[0]!.endsWith(",Archived,Tier")).toBe(true);
    expect(clientsCsv).toContain(",Gold");
  });
});

describe("isolation", () => {
  it("keeps each organization's fields and values to itself", async () => {
    const north = await studio();
    const south = await studio("South", "south.test");
    const phase = await north.field({ name: "Phase", appliesTo: "time", type: "text", required: true });
    expect((await south.json("/api/custom-fields")).body.fields).toEqual([]);
    expect((await south.json(`/api/custom-fields/${phase.id}`, { method: "PATCH", body: { archived: true } })).status).toBe(404);
    // Another organization's field is ignored, and doesn't make anything required there.
    const made = await south.json("/api/time-entries", { body: { projectId: south.project.id, date: DAY, seconds: 60, customFields: { [phase.id]: "Sneaky" } } });
    expect(made.status).toBe(201);
    expect(made.body.entry.customFields).toEqual({});
    expect(await prisma.customFieldValue.count()).toBe(0);
    expect((await south.json(`/api/reports/summary?from=${DAY}&to=${DAY}&groupBy=field:${phase.id}`)).body.groupBy).toBe("project");
  });
});
