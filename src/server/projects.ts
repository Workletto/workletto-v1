import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { addCommonTasks } from "./commonTasks.ts";
import { requireManager, isStillReferenced, readBody, readName, type SignedIn } from "./http.ts";
import { projectsFor } from "./billing.ts";
import { checkBudgets, projectTotals } from "./budget.ts";
import { invoicedFees, PhaseProblem, phasesOf, setPhaseFees } from "./fees.ts";
import { currencies } from "./currency.ts";
import { formatMoney, isCents } from "../shared/money.ts";
import { dayOf } from "../shared/time.ts";
import { canManageWork } from "../shared/roles.ts";
import { TASK_SELECT, toTask } from "./tasks.ts";
import { templateTasks } from "./projectTemplates.ts";
import { readCustomFields, saveCustomFields } from "./customFields.ts";
import { diff, projectLabel, recordAudit, snapshot } from "./audit.ts";

// Projects are what people track time against. A project may belong to a
// client; its billable setting is the default for new time entries; it is
// billed at one project rate or at each person's rate, or for a fixed fee (fees.ts); it may
// have a budget in hours or money; and it is open to everyone or to a chosen team.
// Admins and managers see and change every project. Members see the projects
// they can track time on, without rates or budgets.

const SELECT = {
  id: true,
  name: true,
  billable: true,
  archived: true,
  billBy: true,
  hourlyRate: true,
  fixedFee: true,
  feeByPhase: true,
  budgetBy: true,
  budgetSeconds: true,
  budgetAmount: true,
  budgetAlertLevel: true,
  everyone: true,
  client: { select: { id: true, name: true, archived: true, currency: true } },
  members: { select: { userId: true } },
  // Custom fields in use (WRK-148), for admins and managers.
  customValues: { where: { field: { archivedAt: null } }, select: { fieldId: true, value: true } },
} as const;

type Row = {
  id: string; name: string; billable: boolean; archived: boolean;
  billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null; feeByPhase: boolean;
  budgetBy: "none" | "hours" | "fees"; budgetSeconds: number | null; budgetAmount: number | null; budgetAlertLevel: number;
  everyone: boolean;
  client: { id: string; name: string; archived: boolean; currency: string } | null;
  members: { userId: string }[];
  customValues: { fieldId: string; value: string }[];
};


function toProject(row: Row, full: boolean) {
  const { members, billBy, hourlyRate, fixedFee, feeByPhase, budgetBy, budgetSeconds, budgetAmount, budgetAlertLevel, everyone, customValues, ...basic } = row;
  // Whether it is open to everyone is no secret from members: they see the team's names too.
  if (!full) return { ...basic, everyone };
  const customFields = Object.fromEntries(customValues.map((v) => [v.fieldId, v.value]));
  return { ...basic, billBy, hourlyRate, fixedFee, feeByPhase, budgetBy, budgetSeconds, budgetAmount, budgetAlertLevel, everyone, memberIds: members.map((m) => m.userId), customFields };
}

// What the history records about a project: its money settings, budget and status.
const AUDITED = ["name", "client", "billable", "billBy", "hourlyRate", "fixedFee", "feeByPhase", "budgetBy", "budgetSeconds", "budgetAmount", "archived"] as const;
const audited = (row: Row) => ({
  name: row.name, client: row.client?.name ?? null, billable: row.billable, billBy: row.billBy, hourlyRate: row.hourlyRate, fixedFee: row.fixedFee, feeByPhase: row.feeByPhase,
  budgetBy: row.budgetBy, budgetSeconds: row.budgetSeconds, budgetAmount: row.budgetAmount, archived: row.archived,
});
const auditEvent = (row: Row) => ({ kind: "project" as const, subjectId: row.id, label: projectLabel(row), currency: row.client?.currency });

const NAME_ERROR = "Enter a project name (up to 200 characters).";
type PhaseRow = { taskId: string; title: string; fee: number; invoiced: number; left: number };
const MAX_BUDGET_SECONDS = 100_000 * 3600;

// Projects without a client come last; otherwise by client, then project name.
type Sortable = { name: string; client: { name: string } | null };
const byClientThenName = (a: Sortable, b: Sortable) =>
  Number(!a.client) - Number(!b.client) ||
  (a.client?.name ?? "").localeCompare(b.client?.name ?? "") ||
  a.name.localeCompare(b.name);

/** The client id to store: null for none, the id of an active client, or an error message. */
async function readClientId(db: OrgDb, value: unknown): Promise<string | null | { error: string }> {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return { error: "Choose a client, or no client." };
  const client = await db.client.findFirst({ where: { id: value, archived: false }, select: { id: true } });
  return client ? client.id : { error: "That client doesn't exist or is archived." };
}

type ProjectData = {
  name?: string; clientId?: string | null; billable?: boolean; archived?: boolean; feeByPhase?: boolean;
  billBy?: "project" | "person"; hourlyRate?: number | null; fixedFee?: number | null;
  budgetBy?: "none" | "hours" | "fees"; budgetSeconds?: number | null; budgetAmount?: number | null;
  everyone?: boolean;
};

/**
 * The currency rules (currency.ts), given the project as it is (or nothing yet) and the change:
 * a project for a client in another currency can't bill at people's own rates (they're in the
 * home currency), and one with invoices or expenses can't move to a client in another currency.
 */
async function checkCurrency(db: OrgDb, current: Row | null, data: ProjectData) {
  const { home } = await currencies(db);
  const clientId = "clientId" in data ? data.clientId ?? null : current?.client?.id ?? null;
  const client = clientId ? await db.client.findFirst({ where: { id: clientId }, select: { name: true, currency: true } }) : null;
  const currency = client?.currency ?? home;
  const billBy = data.billBy ?? current?.billBy ?? "project";
  const fixedFee = "fixedFee" in data ? data.fixedFee ?? null : current?.fixedFee ?? null;
  if (currency !== home && billBy === "person" && fixedFee === null) {
    return `${client!.name} is billed in ${currency}, and people's own rates are in ${home}. Use a project rate or a fixed fee.`;
  }
  const was = current ? current.client?.currency ?? home : currency;
  if (current && currency !== was) {
    const [invoiced, expenses] = await Promise.all([
      db.invoiceLine.count({ where: { OR: [{ projectId: current.id }, { timeEntries: { some: { projectId: current.id } } }] } }),
      db.expense.count({ where: { projectId: current.id } }),
    ]);
    if (invoiced || expenses) return `This project has invoices or expenses in ${was}, so it can only move to a client billed in ${was}.`;
  }
  return null;
}

const FIXED_FEE_BUDGET = "A fixed fee project's time has no hourly value, so give it a budget in hours, or none.";

/**
 * The rules a fixed fee keeps, given the project as it is (or nothing yet) and the change asked
 * for: no money budget, a fee no lower than what's already invoiced, and once any of it is
 * invoiced, no going back to billing by the hour (its time was never invoiced, so it would all
 * become billable at once).
 */
async function checkFixedFee(db: OrgDb, current: Row | null, data: ProjectData) {
  const fixedFee = "fixedFee" in data ? data.fixedFee ?? null : current?.fixedFee ?? null;
  const budgetBy = data.budgetBy ?? current?.budgetBy ?? "none";
  if (fixedFee !== null && budgetBy === "fees") return FIXED_FEE_BUDGET;
  // Billed by the hour so far, with some of that time on an invoice: as a fixed fee project its
  // time would have no hourly value (rateFor), so reports would lose what was already billed.
  if (current && current.fixedFee === null && fixedFee !== null && (await db.timeEntry.count({ where: { projectId: current.id, invoiceLineId: { not: null } } }))) {
    return "Some of this project's time is already on an invoice at an hourly rate, so it stays billed by the hour.";
  }
  if (!current || !("fixedFee" in data) || current.fixedFee === null) return null;
  const invoiced = (await invoicedFees(db, [current.id])).get(current.id) ?? 0;
  if (!invoiced) return null;
  if (fixedFee === null) return "Part of this project's fee is already on an invoice, so it stays a fixed fee project.";
  // The fee is in the project's currency: its client's, or the home currency.
  const currency = current.client?.currency ?? (await currencies(db)).home;
  if (fixedFee < invoiced) return `${formatMoney(invoiced, currency)} of this fee is already on invoices, so the fee can't be less than that.`;
  return null;
}

/**
 * Fee per phase (WRK-151): switching between one fee and a fee per phase, either way, only while
 * none of the fee is on an invoice; and while it's per phase, the fee is the phases' sum, never set
 * by hand. Going back to billing by the hour also ends the phases. Says what changes, or why not.
 */
async function phaseRules(db: OrgDb, before: Row & { id: string }, data: ProjectData): Promise<{ problem: string } | { on: boolean; off: boolean }> {
  const fixedAfter = "fixedFee" in data ? data.fixedFee ?? null : before.fixedFee;
  const on = data.feeByPhase === true && !before.feeByPhase;
  const off = before.feeByPhase && (data.feeByPhase === false || fixedAfter === null);
  if (before.feeByPhase && !off && "fixedFee" in data && data.fixedFee !== before.fixedFee) {
    return { problem: "This project's fee is the sum of its phases. Change the phase fees instead." };
  }
  if (on && fixedAfter === null) return { problem: "Only a fixed fee project can have a fee per phase." };
  if ((on || off) && ((await invoicedFees(db, [before.id])).get(before.id) ?? 0) > 0) {
    return { problem: "Part of this project's fee is already on an invoice, so it can't switch between one fee and a fee per phase." };
  }
  if (off) data.feeByPhase = false;
  return { on, off };
}

/** The project's fee as the sum of its phases' fees. */
async function sumPhases(db: OrgDb, projectId: string) {
  const sum = (await db.task.aggregate({ where: { projectId, fee: { not: null } }, _sum: { fee: true } }))._sum.fee ?? 0;
  await db.project.updateMany({ where: { id: projectId }, data: { fixedFee: sum } });
}

/** Reads the fields present in a request body. On create, a name is required. */
const duplicateProject = (name: string) => `This client already has a project called ${name}.`;
/** Whether the client (or "no client") already has a project of this name, ignoring capitals. */
async function projectNameTaken(db: OrgDb, name: string, clientId: string | null, exceptId?: string) {
  return !!(await db.project.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, clientId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  }));
}

async function readProject(db: OrgDb, body: Record<string, unknown>, creating: boolean) {
  const data: ProjectData = {};
  let memberIds: string[] | undefined;
  const fail = (error: string) => ({ error });

  if (creating || "name" in body) {
    const name = readName(body.name);
    if (!name) return fail(NAME_ERROR);
    data.name = name;
  }
  if ("clientId" in body) {
    const clientId = await readClientId(db, body.clientId);
    if (typeof clientId === "object" && clientId) return clientId;
    data.clientId = clientId;
  }
  for (const key of ["billable", "archived", "everyone", "feeByPhase"] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== "boolean") return fail(`${key} must be true or false.`);
    data[key] = body[key];
  }
  if ("billBy" in body) {
    if (body.billBy !== "project" && body.billBy !== "person") return fail("Bill by the project's rate or by each person's rate.");
    data.billBy = body.billBy;
  }
  if ("budgetBy" in body) {
    if (body.budgetBy !== "none" && body.budgetBy !== "hours" && body.budgetBy !== "fees") return fail("Choose no budget, hours or fees.");
    data.budgetBy = body.budgetBy;
  }
  for (const key of ["hourlyRate", "budgetAmount"] as const) {
    if (!(key in body)) continue;
    if (body[key] !== null && !isCents(body[key])) return fail("Enter an amount like 120 or 95.50.");
    data[key] = body[key] as number | null;
  }
  // Null bills by the hour; an amount makes it a fixed fee project.
  if ("fixedFee" in body) {
    if (body.fixedFee !== null && !(isCents(body.fixedFee) && (body.fixedFee as number) > 0)) return fail("Enter the fixed fee as an amount, like 12000 or 9500.50.");
    data.fixedFee = body.fixedFee as number | null;
  }
  if ("budgetSeconds" in body) {
    const v = body.budgetSeconds;
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_BUDGET_SECONDS)) {
      return fail("Enter a budget of up to 100,000 hours.");
    }
    data.budgetSeconds = v as number | null;
  }
  if ("memberIds" in body) {
    const ids = body.memberIds;
    if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((id) => typeof id === "string")) return fail("Choose the people on this project.");
    memberIds = [...new Set(ids as string[])];
    const found = await db.user.count({ where: { id: { in: memberIds } } });
    if (found !== memberIds.length) return fail("Some of those people aren't in your organization.");
  }
  return { data, memberIds };
}

async function saveMembers(db: OrgDb, projectId: string, memberIds: string[] | undefined) {
  if (!memberIds) return;
  await db.projectMember.deleteMany({ where: { projectId } });
  if (memberIds.length) {
    await db.projectMember.createMany({ data: memberIds.map((userId) => ({ projectId, userId })) as never }); // orgDb fills in organizationId
  }
}

export const projectRoutes = new Hono<SignedIn>()
  .get("/", async (c) => {
    const user = c.get("user");
    const rows = await c.get("db").project.findMany({ where: projectsFor(user), select: SELECT });
    return c.json({ projects: rows.sort(byClientThenName).map((r) => toProject(r, canManageWork(user.role))) });
  })
  // One project with its totals, for the project page.
  .get("/:id", async (c) => {
    const user = c.get("user");
    const db = c.get("db");
    const full = canManageWork(user.role);
    const row = await db.project.findFirst({ where: { AND: [{ id: c.req.param("id") }, projectsFor(user)] }, select: SELECT });
    if (!row) return c.json({ error: "Project not found." }, 404);

    // Counted like the budgets report: running timers up to now. Who worked on it and the latest
    // entries are everyone's for admins and managers, and only your own for members.
    const own = full ? {} : { userId: user.id };
    const [totalsOf, people, tasks, byPerson, running, latest, feesInvoiced] = await Promise.all([
      projectTotals(db, [row], { running: true }),
      db.user.findMany({ select: { id: true, name: true, deactivatedAt: true }, orderBy: { name: "asc" } }),
      db.task.findMany({ where: { projectId: row.id }, select: TASK_SELECT, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] }),
      db.timeEntry.groupBy({ by: ["userId"], where: { projectId: row.id, ...own }, _sum: { seconds: true } }),
      db.timeEntry.findMany({ where: { projectId: row.id, startedAt: { not: null }, ...own }, select: { id: true, userId: true, startedAt: true } }),
      db.timeEntry.findMany({
        where: { projectId: row.id, ...own },
        select: { id: true, date: true, seconds: true, startedAt: true, notes: true, user: { select: { id: true, name: true } }, task: { select: { title: true } } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 5,
      }),
      full && row.fixedFee !== null ? invoicedFees(db, [row.id]) : null,
    ]);
    // Fee per phase (WRK-151): each phase's fee, what's invoiced and left, and its hours.
    let phases: (PhaseRow & { seconds: number })[] | null = null;
    if (full && row.feeByPhase) {
      const [list, time] = await Promise.all([
        phasesOf(db, [row.id]),
        db.timeEntry.groupBy({ by: ["taskId"], where: { projectId: row.id, taskId: { not: null } }, _sum: { seconds: true } }),
      ]);
      const seconds = new Map(time.map((t) => [t.taskId!, t._sum.seconds ?? 0]));
      phases = (list.get(row.id) ?? []).map((p) => ({ ...p, seconds: seconds.get(p.taskId) ?? 0 }));
    }
    const { seconds, billableSeconds, billableAmount } = totalsOf.get(row.id)!;
    const now = Date.now();
    const runningFor = (startedAt: Date | null) => (startedAt ? Math.max(0, Math.floor((now - startedAt.getTime()) / 1000)) : 0);
    const names = new Map(people.map((p) => [p.id, p.name]));
    const hours = byPerson
      .map((g) => ({
        id: g.userId,
        name: names.get(g.userId) ?? "Someone",
        seconds: (g._sum.seconds ?? 0) + running.filter((r) => r.userId === g.userId).reduce((sum, r) => sum + runningFor(r.startedAt), 0),
      }))
      .filter((p) => p.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));

    const memberIds = new Set(row.members.map((m) => m.userId));
    const team = people
      .filter((p) => !p.deactivatedAt && (row.everyone || memberIds.has(p.id)))
      .map((p) => ({ id: p.id, name: p.name }));
    return c.json({
      project: toProject(row, full),
      ...(phases ? { phases } : {}),
      team,
      tasks: tasks.map(toTask),
      hours,
      recent: latest.map((e) => ({
        id: e.id,
        date: dayOf(e.date),
        person: e.user,
        task: e.task?.title ?? null,
        notes: e.notes,
        seconds: e.seconds + runningFor(e.startedAt),
        running: e.startedAt !== null,
      })),
      stats: full
        ? {
            seconds, billableSeconds, billableAmount,
            // A fixed fee project's fee: how much of it is on invoices (drafts too), and what's left.
            ...(row.fixedFee !== null ? { feeInvoiced: feesInvoiced?.get(row.id) ?? 0 } : {}),
          }
        : { seconds, billableSeconds },
    });
  })
  .post("/", requireManager("add projects"), async (c) => {
    const db = c.get("db");
    const body = await readBody(c);
    const input = await readProject(db, body, true);
    if ("error" in input) return c.json(input, 400);
    const fields = await readCustomFields(db, "project", body, true);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    // Started from a template (WRK-150): the form sent its settings and team; its tasks come from here.
    let template: { tasks: unknown } | null = null;
    if (body.templateId != null) {
      template = typeof body.templateId === "string" ? await db.projectTemplate.findFirst({ where: { id: body.templateId }, select: { tasks: true } }) : null;
      if (!template) return c.json({ error: "That template doesn't exist any more." }, 400);
    }
    const feeProblem = (await checkFixedFee(db, null, input.data)) ?? (await checkCurrency(db, null, input.data));
    if (feeProblem) return c.json({ error: feeProblem }, 400);
    if (input.data.feeByPhase && input.data.fixedFee == null) return c.json({ error: "Only a fixed fee project can have a fee per phase." }, 400);
    if (await projectNameTaken(db, input.data.name!, input.data.clientId ?? null)) return c.json({ error: duplicateProject(input.data.name!) }, 409);
    const project = await db.$transaction(async (tx) => {
      const created = await tx.project.create({ data: input.data as ProjectData & { name: string; organizationId: string }, select: { id: true } });
      await saveMembers(tx as OrgDb, created.id, input.memberIds);
      await saveCustomFields(tx as OrgDb, "project", created.id, fields);
      // The organization's common tasks (Manage → Tasks) start on every new project, or the template's tasks.
      if (template) {
        // A template billed per phase brings its phases' fees (WRK-151).
        const rows = templateTasks(template.tasks).map((t) => ({ projectId: created.id, title: t.title, notes: t.notes, fee: input.data.feeByPhase ? t.fee : null }));
        if (rows.length) await tx.task.createMany({ data: rows as (typeof rows[number] & { organizationId: string })[] }); // orgDb fills in organizationId
      } else {
        await addCommonTasks(tx as OrgDb, created.id);
      }
      if (input.data.feeByPhase) await sumPhases(tx as OrgDb, created.id);
      const project = await tx.project.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
      const changes = snapshot(audited(project), AUDITED).filter((ch) => ch.field !== "archived");
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(project), action: "created", changes });
      return project;
    });
    return c.json({ project: toProject(project, true) }, 201);
  })
  // Fee per phase (WRK-151): { fees: { taskId: cents, or null for not a phase } }. The project's
  // fee becomes their sum; a phase can't go below what's invoiced of it.
  .put("/:id/phase-fees", requireManager("change projects"), async (c) => {
    const db = c.get("db");
    const body = await readBody(c);
    const raw = body.fees;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "Enter each phase's fee." }, 400);
    const fees = new Map<string, number | null>();
    for (const [taskId, fee] of Object.entries(raw as Record<string, unknown>)) {
      if (fee !== null && !(isCents(fee) && (fee as number) > 0)) return c.json({ error: "Enter each phase's fee as an amount above zero, like 12000 or 9500.50, or leave it empty." }, 400);
      fees.set(taskId, fee as number | null);
    }
    const id = c.req.param("id");
    const result = await db.$transaction(async (tx) => {
      const before = await tx.project.findFirst({ where: { id }, select: SELECT });
      if (!before) return null;
      const changes = await setPhaseFees(tx as OrgDb, id, fees);
      const after = await tx.project.findFirstOrThrow({ where: { id }, select: SELECT });
      if (changes.length) await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(after), action: "changed", changes });
      return after;
    }).catch((error: unknown) => {
      if (error instanceof PhaseProblem) return error;
      throw error;
    });
    if (!result) return c.json({ error: "Project not found." }, 404);
    if (result instanceof PhaseProblem) return c.json({ error: result.message }, 409);
    const phases = (await phasesOf(db, [id])).get(id) ?? [];
    return c.json({ project: toProject(result, true), phases });
  })
  .patch("/:id", requireManager("change projects"), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await readBody(c);
    const input = await readProject(db, body, false);
    if ("error" in input) return c.json(input, 400);
    const fields = await readCustomFields(db, "project", body, false);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    if ("name" in input.data || "clientId" in input.data) {
      const current = await db.project.findFirst({ where: { id }, select: { name: true, clientId: true } });
      if (current) {
        const name = input.data.name ?? current.name;
        const clientId = "clientId" in input.data ? input.data.clientId ?? null : current.clientId;
        // Only a change of name or client is checked, so a project that already shares a name can still be edited.
        if ((name.toLowerCase() !== current.name.toLowerCase() || clientId !== current.clientId) && (await projectNameTaken(db, name, clientId, id))) {
          return c.json({ error: duplicateProject(name) }, 409);
        }
      }
    }
    const project = await db.$transaction(async (tx) => {
      const before = await tx.project.findFirst({ where: { id }, select: SELECT });
      if (!before) return null;
      // Checked while the project is held, so a fee can't drop below an invoice made meanwhile.
      if ("fixedFee" in input.data || "budgetBy" in input.data) {
        const { count } = await tx.project.updateMany({ where: { id, fixedFee: before.fixedFee }, data: { fixedFee: before.fixedFee } });
        if (!count) return { problem: "This project's fee just changed. Reload the page and try again." };
        const problem = await checkFixedFee(tx as OrgDb, before, input.data);
        if (problem) return { problem };
      }
      if ("clientId" in input.data || "billBy" in input.data || "fixedFee" in input.data) {
        const problem = await checkCurrency(tx as OrgDb, before, input.data);
        if (problem) return { problem };
      }
      const phases = await phaseRules(tx as OrgDb, before, input.data);
      if ("problem" in phases) return phases;
      await tx.project.updateMany({ where: { id }, data: input.data });
      // Per phase, the fee is the phases' sum; back to one fee, the tasks stop being phases.
      if (phases.on) await sumPhases(tx as OrgDb, id);
      if (phases.off) await tx.task.updateMany({ where: { projectId: id }, data: { fee: null } });
      await saveMembers(tx as OrgDb, id, input.memberIds);
      await saveCustomFields(tx as OrgDb, "project", id, fields);
      const after = await tx.project.findFirstOrThrow({ where: { id }, select: SELECT });
      await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(after), action: "changed", changes: diff(audited(before), audited(after), AUDITED) });
      return after;
    });
    if (!project) return c.json({ error: "Project not found." }, 404);
    if ("problem" in project) return c.json({ error: project.problem }, 400);
    // A new budget starts from where the project is, without an alert; a new rate can reach one.
    const budgetChanged = ["budgetBy", "budgetSeconds", "budgetAmount"].some((k) => k in input.data);
    await checkBudgets(db, [id], !budgetChanged);
    const fresh = await db.project.findFirstOrThrow({ where: { id }, select: SELECT });
    return c.json({ project: toProject(fresh, true) });
  })
  // Only a project with no time on it can be deleted; otherwise archive it.
  .delete("/:id", requireManager("delete projects"), async (c) => {
    try {
      const deleted = await c.get("db").$transaction(async (tx) => {
        const project = await tx.project.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
        if (!project) return false;
        await tx.project.deleteMany({ where: { id: project.id } });
        await recordAudit(tx as OrgDb, c.get("user"), { ...auditEvent(project), action: "deleted", changes: snapshot(audited(project), AUDITED, true) });
        return true;
      });
      if (!deleted) return c.json({ error: "Project not found." }, 404);
    } catch (error) {
      if (!isStillReferenced(error)) throw error;
      return c.json({ error: "This project has time, expenses or an invoiced fee on it. Archive it instead." }, 409);
    }
    return c.json({ ok: true });
  });
