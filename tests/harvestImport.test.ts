import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { parseCsv } from "../src/shared/csv.ts";
import { guessMapping, MAX_IMPORT_ROWS } from "../src/shared/importFields.ts";
import { planRates } from "../src/shared/importPlan.ts";
import { buildRow, runImport, type ImportOptions, type ImportResult } from "../src/shared/importRun.ts";
import { createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

// tests/fixtures/harvest-time-export.csv is made-up data in the layout of Harvest's
// "Detailed time report" export: 22 rows, 4 people, 3 clients, 5 projects.

async function admin() {
  const { organization, user } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  return { organization, user, cookie: (await signIn("admin@studio.test", "admin-password-1")).cookie };
}

/** The file as the Import screen reads it: through the same column guessing and row building. */
function loadCsv(text: string) {
  const [headers, ...cells] = parseCsv(text);
  const file = { headers: headers!, rows: cells };
  const mapping = guessMapping(file.headers);
  const rows = cells.map((c) => buildRow(file, c, mapping, "ymd"));
  const cell = (c: string[], name: string) => c[file.headers.indexOf(name)]!;
  return { file, mapping, rows, cells, cell };
}
const harvest = loadCsv(readFileSync(new URL("./fixtures/harvest-time-export.csv", import.meta.url), "utf8"));

const DEFAULTS: ImportOptions = { dryRun: false, createMissing: true, skipDuplicates: true, invoiced: "not-billable" };
/** What the Import screen does: the same batching and plan, through the real API. */
const importTime = (cookie: string, rows: Record<string, string>[], options: Partial<ImportOptions> = {}) =>
  runImport(rows, { ...DEFAULTS, ...options }, async (body) => (await request("/api/data/import/time", { body, cookie })).json() as Promise<ImportResult>);

const cents = (dollars: string) => Math.round(Number(dollars) * 100);
const report = async (cookie: string) =>
  (await (await request("/api/reports/summary?from=2026-01-01&to=2026-12-31&groupBy=project", { cookie })).json()) as {
    totals: { seconds: number; billableSeconds: number; billableAmount: number };
    rows: { label: string; seconds: number; billableAmount: number }[];
  };

/** What Harvest says the billable rows are worth, by project, optionally leaving out invoiced rows. */
function harvestBillable(withInvoiced: boolean) {
  const byProject = new Map<string, number>();
  let hours = 0;
  for (const c of harvest.cells) {
    if (harvest.cell(c, "Billable?") !== "Yes" || (!withInvoiced && harvest.cell(c, "Invoiced?") === "Yes")) continue;
    byProject.set(harvest.cell(c, "Project"), (byProject.get(harvest.cell(c, "Project")) ?? 0) + cents(harvest.cell(c, "Billable Amount")));
    hours += Number(harvest.cell(c, "Hours"));
  }
  return { byProject, total: [...byProject.values()].reduce((a, b) => a + b, 0), hours };
}

describe("Harvest column matching", () => {
  it("finds every column the import uses and lists the rest", () => {
    const { mapping, file } = harvest;
    expect(mapping).toMatchObject({ date: 0, client: 1, project: 2, task: 4, notes: 5, hours: 6, billable: 7, invoiced: 8, rate: 16, person: null, personEmail: null });
    const used = new Set(Object.values(mapping).filter((i) => i !== null));
    const ignored = file.headers.filter((_, i) => !used.has(i) && !["First Name", "Last Name"].includes(file.headers[i]!));
    expect(ignored).toEqual([
      "Project Code", "Approved?", "Employee Id", "Roles", "Teams", "Employee?", "Billable Amount", "Cost Rate", "Cost Amount", "Currency", "External Reference URL",
    ]);
    expect(harvest.rows[0]).toMatchObject({ person: "Odessa Lindqvist", project: "Website Refresh", hours: "0.50", billable: "No", rate: "0.0" });
  });
});

describe("importing a Harvest time report", () => {
  it("checks the file first and warns about what needs a decision, saving nothing", async () => {
    const s = await admin();
    const check = await importTime(s.cookie, harvest.rows, { dryRun: true });
    expect(check).toMatchObject({ ok: 22, skipped: 0, duplicates: 0, invoiced: 1, leftOut: 0, ratesSet: 3, errors: [], noRate: [], rateDiffers: [], warnings: [] });
    expect(check.created).toEqual({ clients: 3, projects: 5, people: 4, tasks: expect.any(Number) });
    expect(await prisma.timeEntry.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);

    const skipping = await importTime(s.cookie, harvest.rows, { dryRun: true, invoiced: "skip" });
    expect(skipping).toMatchObject({ ok: 21, invoiced: 1, leftOut: 1 });
  });

  it("charges what Harvest charged, to the cent", async () => {
    const s = await admin();
    const done = await importTime(s.cookie, harvest.rows);
    expect(done).toMatchObject({ ok: 22, skipped: 0, errors: [], noRate: [], rateDiffers: [] });

    // The invoiced row is kept but not billable; everything else bills as in Harvest.
    const expected = harvestBillable(false);
    const summary = await report(s.cookie);
    expect(summary.totals.billableAmount).toBe(expected.total);
    expect(summary.totals.billableSeconds / 3600).toBeCloseTo(expected.hours, 6);
    expect(summary.totals.seconds / 3600).toBeCloseTo(harvest.cells.reduce((sum, c) => sum + Number(harvest.cell(c, "Hours")), 0), 6);
    for (const [project, amount] of expected.byProject) expect(summary.rows.find((r) => r.label === project)?.billableAmount, project).toBe(amount);
    expect(summary.rows.find((r) => r.label === "Studio Admin")?.billableAmount).toBe(0);
    expect(await prisma.timeEntry.count()).toBe(22);
  });

  it("gives people their most common billable rate and projects the right way of billing", async () => {
    const s = await admin();
    await importTime(s.cookie, harvest.rows);
    // Rafferty bills $150 on one project and $175 on another: $150 is the more common.
    const people = await prisma.user.findMany({ where: { id: { not: s.user.id } } });
    expect(Object.fromEntries(people.map((u) => [u.name, u.hourlyRate]))).toEqual({
      "Odessa Lindqvist": 10000, "Rafferty Okonkwo": 15000, "Mirabel Santos-Reyes": 17500, "Tobias Nakamura": null,
    });

    const projects = Object.fromEntries((await prisma.project.findMany({ include: { client: true } })).map((p) => [p.name, p]));
    const shape = (name: string) => ({ billable: projects[name]!.billable, billBy: projects[name]!.billBy, hourlyRate: projects[name]!.hourlyRate, client: projects[name]!.client?.name });
    // Starts with a non-billable $0 row, but others pay different rates, so it bills by person.
    expect(shape("Website Refresh")).toEqual({ billable: true, billBy: "person", hourlyRate: null, client: "Bluebird Bakery" });
    expect(shape("Annual Filing Support")).toEqual({ billable: true, billBy: "person", hourlyRate: null, client: "Fennimore Legal" });
    // One rate for everyone: billed by project, so Rafferty's $175 here is kept.
    expect(shape("Menu Photography")).toEqual({ billable: true, billBy: "project", hourlyRate: 17500, client: "Bluebird Bakery" });
    expect(shape("Intake Portal")).toEqual({ billable: true, billBy: "project", hourlyRate: 17500, client: "Fennimore Legal" });
    // Nothing in it is billable.
    expect(shape("Studio Admin")).toEqual({ billable: false, billBy: "project", hourlyRate: null, client: "Internal" });

    const entries = await prisma.timeEntry.findMany({ include: { project: true } });
    expect(entries.filter((e) => e.project.name === "Studio Admin").every((e) => !e.billable)).toBe(true);
    expect(entries.filter((e) => e.project.name === "Menu Photography").every((e) => e.billable)).toBe(true);
    expect(await prisma.task.count()).toBeGreaterThan(0);
    // Imported people are placeholders with no login.
    expect(await prisma.account.count({ where: { user: { name: "Odessa Lindqvist" } } })).toBe(0);
  });

  it("imports time marked as invoiced as not billable, so it can never be invoiced again", async () => {
    const s = await admin();
    await importTime(s.cookie, harvest.rows);
    const row = await prisma.timeEntry.findFirstOrThrow({ where: { notes: "Logo cleanup for site" }, include: { user: true } });
    expect(row).toMatchObject({ billable: false, seconds: 14400, invoiceLineId: null, user: { name: "Odessa Lindqvist" } });

    // Ready to bill for Bluebird Bakery: its billable rows less the invoiced one.
    const { clients } = await (await request("/api/invoices/unbilled", { cookie: s.cookie })).json();
    const bluebird = clients.find((c: { client: { name: string } }) => c.client.name === "Bluebird Bakery");
    const want = harvest.cells.filter((c) => harvest.cell(c, "Client") === "Bluebird Bakery" && harvest.cell(c, "Billable?") === "Yes" && harvest.cell(c, "Invoiced?") === "No");
    expect(bluebird.amount).toBe(want.reduce((sum, c) => sum + cents(harvest.cell(c, "Billable Amount")), 0));
  });

  it("can leave invoiced time out instead", async () => {
    const s = await admin();
    const done = await importTime(s.cookie, harvest.rows, { invoiced: "skip" });
    expect(done).toMatchObject({ ok: 21, invoiced: 1, leftOut: 1, skipped: 0 });
    expect(await prisma.timeEntry.count()).toBe(21);
    expect(await prisma.timeEntry.count({ where: { notes: "Logo cleanup for site" } })).toBe(0);
    expect((await report(s.cookie)).totals.billableAmount).toBe(harvestBillable(false).total);
  });
});

describe("importing the same file again", () => {
  it("adds nothing, and says how many rows were already here", async () => {
    const s = await admin();
    await importTime(s.cookie, harvest.rows);
    const before = { people: await prisma.user.count(), projects: await prisma.project.count(), tasks: await prisma.task.count() };

    // The file has two identical rows (Odessa's wireframes), and both came in the first time.
    expect(await prisma.timeEntry.count({ where: { notes: "Homepage wireframes" } })).toBe(2);
    const check = await importTime(s.cookie, harvest.rows, { dryRun: true });
    expect(check).toMatchObject({ ok: 0, skipped: 22, duplicates: 22, created: { clients: 0, projects: 0, people: 0, tasks: 0 } });
    const again = await importTime(s.cookie, harvest.rows);
    expect(again).toMatchObject({ ok: 0, skipped: 22, duplicates: 22 });
    expect(await prisma.timeEntry.count()).toBe(22);
    expect({ people: await prisma.user.count(), projects: await prisma.project.count(), tasks: await prisma.task.count() }).toEqual(before);
  });

  it("brings in only what is missing when part of the file is already here", async () => {
    const s = await admin();
    await importTime(s.cookie, harvest.rows);
    const wireframes = await prisma.timeEntry.findMany({ where: { notes: "Homepage wireframes" } });
    await prisma.timeEntry.delete({ where: { id: wireframes[0]!.id } });
    await prisma.timeEntry.delete({ where: { id: (await prisma.timeEntry.findFirstOrThrow({ where: { notes: "Mobile layouts" } })).id } });

    const again = await importTime(s.cookie, harvest.rows);
    expect(again).toMatchObject({ ok: 2, skipped: 20, duplicates: 20 });
    expect(await prisma.timeEntry.count()).toBe(22);
    expect(await prisma.timeEntry.count({ where: { notes: "Homepage wireframes" } })).toBe(2);
  });

  it("adds them again when told not to skip them", async () => {
    const s = await admin();
    await importTime(s.cookie, harvest.rows);
    const again = await importTime(s.cookie, harvest.rows, { skipDuplicates: false });
    expect(again).toMatchObject({ ok: 22, skipped: 0, duplicates: 22 });
    expect(await prisma.timeEntry.count()).toBe(44);
  });

  it("does not mistake identical rows saved by an earlier batch of the same import for duplicates", async () => {
    const s = await admin();
    // Two genuinely identical entries, one at the end of the first batch and one at the start of the second.
    const row = (i: number, notes = `Task ${i}`) => ({ date: "2026-03-02", person: "Zed Quill", client: "Acme", project: "Big", hours: "0.25", notes });
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 2 }, (_, i) => row(i));
    rows[MAX_IMPORT_ROWS - 1] = row(0, "Same twice");
    rows[MAX_IMPORT_ROWS] = row(0, "Same twice");
    expect(await importTime(s.cookie, rows)).toMatchObject({ ok: MAX_IMPORT_ROWS + 2, skipped: 0, duplicates: 0 });
    expect(await prisma.timeEntry.count()).toBe(MAX_IMPORT_ROWS + 2);
    expect(await importTime(s.cookie, rows)).toMatchObject({ ok: 0, skipped: MAX_IMPORT_ROWS + 2 });
    expect(await prisma.timeEntry.count()).toBe(MAX_IMPORT_ROWS + 2);
  });
});

describe("rates", () => {
  const row = (person: string, project: string, rate: string, extra: Record<string, string> = {}) => ({
    date: "2026-03-02", person, client: "Acme", project, hours: "1", billable: "Yes", rate, ...extra,
  });

  it("looks at the whole file, not at each batch or at a project's first row", async () => {
    const s = await admin();
    // The first batch is all non-billable $0 time; the only rate in the file arrives in the second.
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => row("Zed Quill", "Retainer", "0.0", { billable: "No", notes: `n${i}` }));
    rows.push(row("Zed Quill", "Retainer", "90.0", { notes: "billable" }));
    expect(await importTime(s.cookie, rows)).toMatchObject({ ok: MAX_IMPORT_ROWS + 1, noRate: [] });
    expect(await prisma.project.findFirstOrThrow({ where: { name: "Retainer" } })).toMatchObject({ billable: true, billBy: "project", hourlyRate: 9000 });
    expect((await prisma.user.findFirstOrThrow({ where: { name: "Zed Quill" } })).hourlyRate).toBe(9000);
  });

  it("never takes a rate from a non-billable row, and marks a project nobody bills as non-billable", async () => {
    const s = await admin();
    const rows = [row("Ann Lee", "Internal", "75.0", { billable: "No" }), row("Ann Lee", "Internal", "75.0", { billable: "No" })];
    expect(planRates(rows)).toEqual({ people: {}, projects: { "acme|internal": { billable: false, billBy: "project", rate: null } } });
    expect(await importTime(s.cookie, rows)).toMatchObject({ ok: 2, noRate: [], ratesSet: 0 });
    expect(await prisma.project.findFirstOrThrow()).toMatchObject({ billable: false, hourlyRate: null });
    expect((await prisma.user.findFirstOrThrow({ where: { name: "Ann Lee" } })).hourlyRate).toBeNull();
  });

  it("picks the commonest rate, then the one with more hours, then the higher one", () => {
    const hours = (rate: string, h: string) => row("Pat", "P", rate, { hours: h });
    expect(planRates([hours("100", "1"), hours("100", "1"), hours("200", "5")]).people).toEqual({ pat: 10000 });
    expect(planRates([hours("100", "1"), hours("200", "2")]).people).toEqual({ pat: 20000 });
    expect(planRates([hours("100", "1"), hours("200", "1")]).people).toEqual({ pat: 20000 });
  });

  it("warns about billable time with no rate", async () => {
    const s = await admin();
    const rows = [row("Ann Lee", "Open", "0.0"), row("Ann Lee", "Open", ""), row("Ann Lee", "Fine", "50.0", { notes: "ok" })];
    const check = await importTime(s.cookie, rows, { dryRun: true });
    expect(check.noRate).toEqual([{ row: 1, project: "Open" }, { row: 2, project: "Open" }]);
    expect(check.errors).toEqual([]);
  });

  it("warns about rows it cannot charge at the file's rate, naming them", async () => {
    const s = await admin();
    // Ann and Bob bill differently on "Mixed", so it bills by person; Bob's one $200 row can't be kept.
    const rows = [
      row("Ann Lee", "Mixed", "100", { notes: "a1" }), row("Ann Lee", "Mixed", "100", { notes: "a2" }),
      row("Bob Ray", "Mixed", "150", { notes: "b1" }), row("Bob Ray", "Mixed", "150", { notes: "b2" }), row("Bob Ray", "Mixed", "200", { notes: "b3" }),
    ];
    const done = await importTime(s.cookie, rows);
    expect(done.rateDiffers).toEqual([{ row: 5, person: "Bob Ray", project: "Mixed", file: 20000, work: 15000 }]);
    expect(await prisma.project.findFirstOrThrow()).toMatchObject({ billBy: "person", hourlyRate: null });
    expect((await prisma.user.findFirstOrThrow({ where: { name: "Bob Ray" } })).hourlyRate).toBe(15000);
  });

  it("sets rates for existing people who have none, and leaves a different rate alone with a warning", async () => {
    const s = await admin();
    const cara = await prisma.user.create({ data: { name: "Cara Dunn", email: "cara@studio.test", organizationId: s.organization.id, hourlyRate: 9000 } });
    const dan = await prisma.user.create({ data: { name: "Dan Moss", email: "dan@studio.test", organizationId: s.organization.id } });
    const rows = [row("Cara Dunn", "Site", "120", { notes: "c" }), row("Dan Moss", "Site", "120", { notes: "d" })];
    const done = await importTime(s.cookie, rows);
    expect(done.ratesSet).toBe(1);
    expect(done.warnings).toHaveLength(1);
    expect(done.warnings[0]).toMatch(/Cara Dunn already has an hourly rate of 90\.00.*120\.00/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: cara.id } })).hourlyRate).toBe(9000);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: dan.id } })).hourlyRate).toBe(12000);
    // One rate for the project, so Cara's $120 on it is charged as filed even though her own rate stays $90.
    expect(done.rateDiffers).toEqual([]);
  });
});
