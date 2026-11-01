import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { prisma, type OrgDb } from "./db.ts";
import { requireManager, readBody, type SignedIn } from "./http.ts";
import { PLACEHOLDER_DOMAIN } from "./people.ts";
import { asDate, dayOf, dayOrEmpty, daysBetween, isIsoDate, MAX_ENTRY_SECONDS, parseDuration, startOfWeek } from "../shared/time.ts";
import { isCents, parseMoney } from "../shared/money.ts";
import { personKey, planRates, projectKey, parseYesNo, type PlanInput, type ProjectPlan, type RatePlan } from "../shared/importPlan.ts";
import { rateFor, valueOf } from "./billing.ts";
import { toCsv } from "../shared/csv.ts";
import { activeFields, customValues, type FieldKind } from "./customFields.ts";
import { groupNames } from "./groups.ts";
import { recordAudit } from "./audit.ts";
import { checkBudgets } from "./budget.ts";
import { approvalsOn } from "./timesheets.ts";
import { MAX_IMPORT_ROWS } from "../shared/importFields.ts";
import { isEmail } from "../shared/email.ts";

// CSV export of clients, projects, tasks, time and expenses, and import of
// Harvest's "Detailed time" CSV. The browser reads the file and matches its
// columns; rows arrive here as { field: text } in batches. A dry run checks
// them without saving. Admins and managers only.

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const money = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));
// Four decimals, so a 20-minute entry (0.3333) comes back in as 1200 seconds.
const hours = (seconds: number | null) => (seconds == null ? "" : String(+(seconds / 3600).toFixed(4)));
const STATUS_TEXT = { todo: "To do", in_progress: "In progress", done: "Done" } as const;

const EXPORT_HEADERS = {
  clients: ["Name", "Email", "Address", "Currency", "Archived"],
  projects: ["Project", "Client", "Currency", "Billable", "Bill by", "Hourly rate", "Fixed fee", "Budget type", "Budget hours", "Budget amount", "Archived"],
  tasks: ["Project", "Client", "Task", "Status", "Assigned to", "Due date", "Notes"],
  time: ["Date", "Person", "Person email", "Client", "Project", "Task", "Notes", "Hours", "Billable", "Billable rate", "Billable amount", "Currency", "Invoiced", "Groups"],
  expenses: ["Date", "Person", "Person email", "Client", "Project", "Category", "Amount", "Currency", "Notes", "Billable", "Reimbursable", "Groups"],
} as const;
type ExportType = keyof typeof EXPORT_HEADERS;
const EXPORT_TYPES = Object.keys(EXPORT_HEADERS) as ExportType[];

async function exportRows(db: OrgDb, type: ExportType, from: string, to: string): Promise<{ id: string; cells: (string | number)[] }[]> {
  const period = { date: { gte: asDate(from), lte: asDate(to) } };
  // Amounts are in their own currency: a client's, or the home currency (currency.ts).
  const { currency: home } = await db.organization.findFirstOrThrow({ select: { currency: true } });
  const currencyOf = (project: { client: { currency: string } | null }) => project.client?.currency ?? home;
  // Each person's user groups (WRK-149).
  const groups = type === "time" || type === "expenses" ? await groupNames(db) : new Map<string, string>();
  switch (type) {
    case "clients":
      return (await db.client.findMany({ orderBy: { name: "asc" } })).map((c) => ({ id: c.id, cells: [c.name, c.email, c.address, c.currency, yesNo(c.archived)] }));
    case "projects":
      return (await db.project.findMany({ include: { client: true }, orderBy: { name: "asc" } })).map((p) => ({ id: p.id, cells: [
        p.name, p.client?.name ?? "", currencyOf(p), yesNo(p.billable), p.billBy === "person" ? "Person" : "Project", money(p.hourlyRate), money(p.fixedFee),
        p.budgetBy === "none" ? "None" : p.budgetBy === "hours" ? "Hours" : "Fees", hours(p.budgetSeconds), money(p.budgetAmount),
        yesNo(p.archived),
      ] }));
    case "tasks":
      return (await db.task.findMany({ include: { project: { include: { client: true } }, assignee: true }, orderBy: { createdAt: "asc" } })).map((t) => ({ id: t.id, cells: [
        t.project.name, t.project.client?.name ?? "", t.title, STATUS_TEXT[t.status],
        t.assignee ? (t.assignee.email.endsWith(PLACEHOLDER_DOMAIN) ? t.assignee.name : t.assignee.email) : "", dayOrEmpty(t.dueDate), t.notes,
      ] }));
    case "time":
      return (await db.timeEntry.findMany({ where: period, include: { user: true, project: { include: { client: true } }, task: true }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] })).map((e) => ({ id: e.id, cells: [
        dayOrEmpty(e.date), e.user.name, e.user.email.endsWith(PLACEHOLDER_DOMAIN) ? "" : e.user.email, e.project.client?.name ?? "", e.project.name,
        // The rate the entry is billed at today (the project's, or the person's when billed by person), and
        // what its exact time is worth at it, as in Reports. Empty for time that isn't billable.
        e.task?.title ?? "", e.notes, hours(e.seconds), yesNo(e.billable),
        e.billable ? money(rateFor(e.project, e.user)) : "",
        e.billable ? money(Math.round(valueOf(e.seconds, rateFor(e.project, e.user)))) : "",
        currencyOf(e.project),
        yesNo(e.invoiceLineId !== null),
        groups.get(e.userId) ?? "",
      ] }));
    case "expenses":
      return (await db.expense.findMany({ where: period, include: { user: true, project: { include: { client: true } } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] })).map((x) => ({ id: x.id, cells: [
        dayOrEmpty(x.date), x.user.name, x.user.email.endsWith(PLACEHOLDER_DOMAIN) ? "" : x.user.email, x.project.client?.name ?? "", x.project.name,
        x.category, money(x.amount), currencyOf(x.project), x.notes, yesNo(x.billable), yesNo(x.reimbursable),
        groups.get(x.userId) ?? "",
      ] }));
  }
}

// ── Import ────────────────────────────────────────────────────────────────

type Row = Record<string, string | undefined>;
class RowError extends Error {}
const fail = (message: string): never => {
  throw new RowError(message);
};
const key = (s: string) => s.trim().toLowerCase();

function readYesNo(text: string | undefined, label: string): boolean | undefined {
  const value = parseYesNo(text);
  return value === null ? fail(`${label} should be Yes or No, not "${text}".`) : value;
}
function readAmount(text: string | undefined, label: string): number | null {
  if (!text?.trim()) return null;
  const negative = text.trim().startsWith("-");
  const cents = parseMoney(text.replace(/^\s*-/, ""));
  if (cents === null || Number.isNaN(cents)) return fail(`${label} should be an amount like 120 or 95.50, not "${text}".`);
  return negative ? -cents : cents;
}
function readDate(text: string | undefined, label: string, required: true): Date;
function readDate(text: string | undefined, label: string, required?: false): Date | null;
function readDate(text: string | undefined, label: string, required = false) {
  const t = text?.trim() ?? "";
  if (!t) return required ? fail(`${label} is missing.`) : null;
  return isIsoDate(t) ? asDate(t) : fail(`${label} "${t}" isn't a date in the chosen format.`);
}
const text = (value: string | undefined, max: number, label: string) => {
  const t = (value ?? "").trim().replace(/^'(?=[=+\-@])/, ""); // undo our formula guard
  return t.length > max ? fail(`${label} is longer than ${max} characters.`) : t;
};

type Created = { clients: number; projects: number; people: number; tasks: number };

/** What a run noticed along the way, for the check step and the final summary. */
type Report = {
  duplicates: number; // rows already here (counted in "skipped" too)
  invoiced: number; // rows the file marks as already invoiced
  leftOut: number; // of those, rows not imported because of the choice
  ratesSet: number; // people who were given a rate
  noRate: { row: number; project: string }[]; // billable rows that will be worth $0
  rateDiffers: { row: number; person: string; project: string; file: number; work: number }[];
  warnings: string[];
};

type Plan = { people: Map<string, number>; projects: Map<string, ProjectPlan> };
type Options = {
  dryRun: boolean;
  createMissing: boolean;
  skipDuplicates: boolean;
  /** What to do with time the file says was already invoiced: import it as not billable (so it can't be invoiced twice), or leave it out. */
  invoiced: "not-billable" | "skip";
  plan: Plan;
  /** Entries made after this moment (earlier batches of this same import) are not "already here". */
  since: Date;
};

type KnownProject = { id: string; label: string; name: string; clientKey: string; billable: boolean; billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null };

const timeSignature = (date: Date, userId: string, projectId: string, taskId: string | null, seconds: number, notes: string) =>
  ["time", dayOrEmpty(date), userId, projectId, taskId ?? "", seconds, notes].join("\0");

/** Finds (or, when allowed, makes) the clients, projects, people and tasks rows refer to. */
class Lookup {
  clients = new Map<string, string>();
  projects: KnownProject[] = [];
  peopleByEmail = new Map<string, string>();
  peopleByName = new Map<string, string>();
  rates = new Map<string, number | null>(); // person id → hourly rate
  tasks = new Map<string, string>();
  created: Created = { clients: 0, projects: 0, people: 0, tasks: 0 };
  report: Report = { duplicates: 0, invoiced: 0, leftOut: 0, ratesSet: 0, noRate: [], rateDiffers: [], warnings: [] };
  private existing = new Map<string, number>(); // entry signature → how many are already here
  private fakeId = 0;
  private rateChecked = new Set<string>();
  /** "personId|Monday" for weeks that are submitted or approved while approvals are on. */
  lockedWeeks = new Set<string>();

  constructor(private db: OrgDb, public opts: Options) {}

  async load() {
    if (await approvalsOn(this.db)) {
      const weeks = await this.db.timesheetWeek.findMany({ where: { status: { in: ["submitted", "approved"] } }, select: { userId: true, weekStart: true } });
      for (const w of weeks) this.lockedWeeks.add(`${w.userId}|${dayOf(w.weekStart)}`);
    }
    const [clients, projects, people, tasks] = await Promise.all([
      this.db.client.findMany({ select: { id: true, name: true } }),
      this.db.project.findMany({ select: { id: true, name: true, billable: true, billBy: true, hourlyRate: true, fixedFee: true, client: { select: { name: true } } } }),
      this.db.user.findMany({ select: { id: true, name: true, email: true, hourlyRate: true } }),
      this.db.task.findMany({ select: { id: true, title: true, projectId: true } }),
    ]);
    for (const c of clients) this.clients.set(key(c.name), c.id);
    this.projects = projects.map((p) => ({
      id: p.id, label: p.name, name: key(p.name), clientKey: key(p.client?.name ?? ""), billable: p.billable, billBy: p.billBy, hourlyRate: p.hourlyRate, fixedFee: p.fixedFee,
    }));
    for (const p of people) {
      this.peopleByEmail.set(key(p.email), p.id);
      if (!this.peopleByName.has(key(p.name))) this.peopleByName.set(key(p.name), p.id);
      this.rates.set(p.id, p.hourlyRate);
    }
    for (const t of tasks) this.tasks.set(`${t.projectId}|${key(t.title)}`, t.id);
    return this;
  }

  /** Counts the time already in the organization on the days these rows cover. */
  async loadExisting(rows: Row[]) {
    const dates = rows.map((r) => r.date?.trim() ?? "").filter(isIsoDate).sort();
    if (dates.length === 0) return;
    const where = { date: { gte: asDate(dates[0]!), lte: asDate(dates[dates.length - 1]!) }, createdAt: { lt: this.opts.since } };
    const entries = await this.db.timeEntry.findMany({ where, select: { date: true, userId: true, projectId: true, taskId: true, seconds: true, notes: true } });
    for (const e of entries) {
      const signature = timeSignature(e.date, e.userId, e.projectId, e.taskId, e.seconds, e.notes);
      this.existing.set(signature, (this.existing.get(signature) ?? 0) + 1);
    }
  }

  /**
   * Counts the row as a duplicate when an equal entry was already here before this import
   * began, and says whether to leave it out. Each existing entry matches one row only, so
   * two genuinely identical rows in a file both come in the first time, and a second import
   * of the same file adds nothing.
   */
  takeDuplicate(signature: string): boolean {
    const left = this.existing.get(signature) ?? 0;
    if (left === 0) return false;
    this.existing.set(signature, left - 1);
    this.report.duplicates++;
    return this.opts.skipDuplicates;
  }

  /** In a dry run nothing is saved; made-up ids stand in for what would be created. */
  private async make<T>(create: () => Promise<T>, fake: () => T): Promise<T> {
    return this.opts.dryRun ? fake() : create();
  }
  private placeholder = () => ({ id: `new-${++this.fakeId}` });

  async client(name: string): Promise<string | null> {
    if (!name) return null;
    const found = this.clients.get(key(name));
    if (found) return found;
    if (!this.opts.createMissing) return fail(`There's no client called "${name}".`);
    // A new client is billed in the home currency, like one added by hand.
    const create = async () => {
      const { currency } = await this.db.organization.findFirstOrThrow({ select: { currency: true } });
      return this.db.client.create({ data: { name, currency } as never, select: { id: true } });
    };
    const { id } = await this.make(create, this.placeholder);
    this.clients.set(key(name), id);
    this.created.clients++;
    return id;
  }

  /** A project that exists, or a new one set up the way the file's rows suggest (see planRates). */
  async project(name: string, clientName: string, plan?: ProjectPlan): Promise<KnownProject> {
    if (!name) return fail("Project is missing.");
    const matches = this.projects.filter((p) => p.name === key(name) && (!clientName || p.clientKey === key(clientName)));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return fail(`Several projects are called "${name}". Add the Client column to tell them apart.`);
    if (!this.opts.createMissing) return fail(`There's no project called "${name}"${clientName ? ` for ${clientName}` : ""}.`);
    const clientId = await this.client(clientName);
    const settings = { billable: plan?.billable ?? true, billBy: plan?.billBy ?? "project", hourlyRate: plan?.rate ?? null } as const;
    const data = { name, clientId: clientId?.startsWith("new-") ? null : clientId, ...settings };
    const { id } = await this.make(() => this.db.project.create({ data: data as never, select: { id: true } }), this.placeholder);
    const project = { id, label: name, name: key(name), clientKey: key(clientName), ...settings, fixedFee: null };
    this.projects.push(project);
    this.created.projects++;
    return project;
  }

  /**
   * By email, then by name. Unknown people can be added without a login, to invite later.
   * `rate` is what the file says they usually bill at: it's set on people who have none
   * (new ones included), and a different rate already set here is left alone and reported.
   */
  async person(name: string, email: string, fallback: string | null, rate: number | null = null): Promise<string> {
    const found = (email ? this.peopleByEmail.get(key(email)) : undefined) ?? (name ? this.peopleByName.get(key(name)) : undefined);
    if (found) {
      await this.giveRate(found, name || email, rate);
      return found;
    }
    if (!name && !email) return fallback ?? fail("Person is missing.");
    if (!this.opts.createMissing) return fail(`There's nobody called "${name || email}" in your organization.`);
    if (email && !isEmail(email)) return fail(`"${email}" isn't an email address.`);
    const displayName = name || email.split("@")[0]!;
    // Emails are unique across the whole install; one used elsewhere becomes a placeholder until they're invited.
    const usable = email && !(await prisma.user.findUnique({ where: { email: key(email) }, select: { id: true } }));
    const address = usable
      ? key(email)
      : `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "person"}.${randomBytes(3).toString("hex")}${PLACEHOLDER_DOMAIN}`;
    const { id } = await this.make(
      () => this.db.user.create({ data: { name: displayName, email: address, role: "member", hourlyRate: rate } as never, select: { id: true } }),
      this.placeholder,
    );
    if (email) this.peopleByEmail.set(key(email), id);
    this.peopleByName.set(key(displayName), id);
    this.rates.set(id, rate);
    if (rate) this.report.ratesSet++;
    this.created.people++;
    return id;
  }

  private async giveRate(id: string, label: string, rate: number | null) {
    if (!rate || this.rateChecked.has(id)) return;
    this.rateChecked.add(id);
    const current = this.rates.get(id) ?? null;
    if (current === null) {
      await this.make(() => this.db.user.update({ where: { id }, data: { hourlyRate: rate } as never, select: { id: true } }), this.placeholder);
      this.rates.set(id, rate);
      this.report.ratesSet++;
    } else if (current !== rate) {
      this.report.warnings.push(
        `${label} already has an hourly rate of ${money(current)} here, but the file mostly has ${money(rate)}. The existing ${money(current)} is kept; change it under People if that's wrong.`,
      );
    }
  }

  async task(projectId: string, title: string): Promise<string | null> {
    if (!title) return null;
    const found = this.tasks.get(`${projectId}|${key(title)}`);
    if (found) return found;
    if (!this.opts.createMissing) return fail(`There's no task called "${title}" on that project.`);
    const { id } = await this.make(() => this.db.task.create({ data: { projectId, title } as never, select: { id: true } }), this.placeholder);
    this.tasks.set(`${projectId}|${key(title)}`, id);
    this.created.tasks++;
    return id;
  }
}

/**
 * Checks one row and, unless it's a dry run, saves it. Returns "skipped" for time that is
 * already here, and "left-out" for time the file says is already invoiced, if asked to leave it out.
 */
async function importRow(row: Row, look: Lookup, db: OrgDb, user: { id: string }, rowNumber: number): Promise<"ok" | "skipped" | "left-out"> {
  // Everything that can be checked on the row alone comes first, so a row with a problem creates nothing.
  const date = readDate(row.date, "Date", true);
  const personName = text(row.person, 200, "Person");
  const personEmail = text(row.personEmail, 254, "Person email");
  const projectName = text(row.project, 200, "Project");
  const clientName = text(row.client, 200, "Client");
  const notes = text(row.notes, 2000, "Notes");
  const billableText = readYesNo(row.billable, "Billable");
  const seconds = parseDuration(row.hours ?? "");
  if (seconds === null) fail("Hours is missing.");
  if (Number.isNaN(seconds) || seconds! > MAX_ENTRY_SECONDS) fail(`Hours "${row.hours}" should be like 1.5 or 1:30, up to 24.`);
  const fileRate = readAmount(row.rate, "Billable rate");
  const taskTitle = text(row.task, 200, "Task");
  const invoiced = readYesNo(row.invoiced, "Invoiced") === true;
  if (invoiced) {
    look.report.invoiced++;
    if (look.opts.invoiced === "skip") {
      look.report.leftOut++;
      return "left-out";
    }
  }

  const { plan } = look.opts;
  const userId = await look.person(personName, personEmail, user.id, plan.people.get(personKey(personName, personEmail)) ?? null);
  const project = await look.project(projectName, clientName, plan.projects.get(projectKey(clientName, projectName)));
  const taskId = await look.task(project.id, taskTitle);
  if (look.lockedWeeks.has(`${userId}|${startOfWeek(dayOf(date))}`)) {
    fail("This person's week is submitted or approved. Reopen it in Approvals first.");
  }
  if (look.takeDuplicate(timeSignature(date, userId, project.id, taskId, seconds!, notes))) return "skipped";

  // Time already invoiced elsewhere is kept, but not billable, so it can never be invoiced a second time.
  const billable = invoiced ? false : billableText ?? project.billable;
  if (billable && seconds! > 0) {
    const rate = rateFor(project, { hourlyRate: look.rates.get(userId) ?? null });
    if (!rate) look.report.noRate.push({ row: rowNumber, project: project.label });
    else if (fileRate && fileRate > 0 && fileRate !== rate) {
      look.report.rateDiffers.push({ row: rowNumber, person: personName || personEmail || "You", project: project.label, file: fileRate, work: rate });
    }
  }
  if (!look.opts.dryRun) await db.timeEntry.create({ data: { userId, projectId: project.id, taskId, date, seconds, notes, billable } as never });
  return "ok";
}

const toPlan = (plan: RatePlan): Plan => ({ people: new Map(Object.entries(plan.people)), projects: new Map(Object.entries(plan.projects)) });

/** The plan the browser sent, if it's well formed. Anything else is ignored and the server works one out from the rows it has. */
function readPlan(raw: unknown): Plan | null {
  const { people, projects } = (raw ?? {}) as { people?: unknown; projects?: unknown };
  if (!people || typeof people !== "object" || !projects || typeof projects !== "object") return null;
  const plan: Plan = { people: new Map(), projects: new Map() };
  for (const [who, rate] of Object.entries(people)) if (isCents(rate) && rate > 0) plan.people.set(who, rate);
  for (const [id, p] of Object.entries(projects) as [string, Partial<ProjectPlan> | null][]) {
    if (!p || typeof p.billable !== "boolean" || (p.billBy !== "project" && p.billBy !== "person") || !(p.rate === null || isCents(p.rate))) continue;
    plan.projects.set(id, { billable: p.billable, billBy: p.billBy, rate: p.rate });
  }
  return plan;
}

export const importExportRoutes = new Hono<SignedIn>()
  .use(requireManager("import and export"))
  .get("/export/:type", async (c) => {
    const type = c.req.param("type") as ExportType;
    if (!EXPORT_TYPES.includes(type)) return c.json({ error: "Not found." }, 404);
    const from = c.req.query("from") ?? "2000-01-01";
    const to = c.req.query("to") ?? "2100-12-31";
    if (!isIsoDate(from) || !isIsoDate(to) || daysBetween(from, to) < 0) return c.json({ error: "Choose valid dates." }, 400);
    const db = c.get("db");
    const rows = await exportRows(db, type, from, to);
    // Custom fields in use (WRK-148), as columns after the others.
    const kind = ({ clients: "client", projects: "project", time: "time" } as const)[type as "clients" | "projects" | "time"] as FieldKind | undefined;
    const fields = kind ? await activeFields(db, kind) : [];
    const values = kind ? await customValues(db, kind, rows.map((r) => r.id)) : new Map<string, Record<string, string>>();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${type}${type === "time" || type === "expenses" ? `-${from}-to-${to}` : ""}.csv"`);
    return c.body(toCsv([[...EXPORT_HEADERS[type], ...fields.map((f) => f.name)], ...rows.map((r) => [...r.cells, ...fields.map((f) => values.get(r.id)?.[f.id] ?? "")])]));
  })
  // Harvest's Detailed time export. { rows: [{ field: text }], dryRun, createMissing, offset, skipDuplicates, invoiced, plan, since }:
  // offset numbers the rows in errors; plan (see planRates) and since come from the browser, which sends
  // the same ones with every batch of a file. since is the startedAt this answered with the first time.
  .post("/import/time", async (c) => {
    const body = await readBody(c);
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      return c.json({ error: `Send up to ${MAX_IMPORT_ROWS} rows at a time.` }, 400);
    }
    const startedAt = new Date();
    const since = typeof body.since === "string" && !Number.isNaN(Date.parse(body.since)) ? new Date(Math.min(Date.parse(body.since), startedAt.getTime())) : startedAt;
    const cleaned: Row[] = (rows as Record<string, unknown>[]).map((raw) =>
      Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v == null ? undefined : String(v)])),
    );
    const offset = Number.isInteger(body.offset) ? (body.offset as number) : 0;
    const dryRun = body.dryRun !== false;
    const options: Options = {
      dryRun,
      createMissing: body.createMissing !== false,
      skipDuplicates: body.skipDuplicates !== false,
      invoiced: body.invoiced === "skip" ? "skip" : "not-billable",
      plan: readPlan(body.plan) ?? toPlan(planRates(cleaned as PlanInput[])),
      since,
    };
    const user = c.get("user");

    const run = async (db: OrgDb) => {
      const look = await new Lookup(db, options).load();
      await look.loadExisting(cleaned);
      let ok = 0;
      let skipped = 0;
      const errors: { row: number; error: string }[] = [];
      for (const [i, row] of cleaned.entries()) {
        try {
          const result = await importRow(row, look, db, user, offset + i + 1);
          if (result === "ok") ok++;
          else if (result === "skipped") skipped++;
        } catch (error) {
          if (!(error instanceof RowError)) throw error;
          errors.push({ row: offset + i + 1, error: error.message });
        }
      }
      return { ok, skipped, errors, created: look.created, ...look.report };
    };
    const db = c.get("db");
    const result = dryRun ? await run(db) : await db.$transaction(async (tx) => {
      const done = await run(tx as OrgDb);
      // One history line per batch, not one per row.
      if (done.ok) await recordAudit(tx as OrgDb, user, { kind: "import", action: "created", label: `Imported ${done.ok} ${done.ok === 1 ? "time entry" : "time entries"}`, changes: [] });
      return done;
    }, { timeout: 60_000 });
    // Imported history isn't news: budgets catch up without an alert.
    if (!dryRun && result.ok) await checkBudgets(db, "all", false);
    return c.json({ dryRun, startedAt: startedAt.toISOString(), ...result });
  });
