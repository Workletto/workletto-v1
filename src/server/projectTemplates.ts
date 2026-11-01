import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isUniqueViolation, readBody, readName, requireManager, type SignedIn } from "./http.ts";

// Project templates (WRK-150): a project's settings saved under a name, to start new projects
// from. A template keeps the billing, rates, budget, team and tasks, never the client. Starting
// a project from one copies them; nothing stays linked. Admins and managers, like projects.

const SELECT = {
  id: true, name: true, billable: true, billBy: true, hourlyRate: true, fixedFee: true, feeByPhase: true, budgetBy: true,
  budgetSeconds: true, budgetAmount: true, everyone: true, memberIds: true, tasks: true, customFields: true,
} as const;

/** A template's task; `fee` is its phase fee in cents on a template billed per phase (WRK-151). */
export type TemplateTask = { title: string; notes: string; fee: number | null };

/** The template's tasks, whatever the stored JSON holds. */
export function templateTasks(value: unknown): TemplateTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is { title: string; notes?: unknown; fee?: unknown } => !!t && typeof (t as { title?: unknown }).title === "string")
    .map((t) => ({ title: t.title, notes: typeof t.notes === "string" ? t.notes : "", fee: Number.isInteger(t.fee) && (t.fee as number) > 0 ? (t.fee as number) : null }));
}

const NAME_ERROR = "Enter a template name (up to 200 characters).";
const nameTaken = (name: string) => `There's already a template called ${name}.`;

async function taken(db: OrgDb, name: string, exceptId?: string) {
  return !!(await db.projectTemplate.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));
}

/** A template as the app shows it: its team without people who have left. */
async function present(db: OrgDb, rows: { memberIds: string[]; tasks: unknown; customFields: unknown }[]) {
  const active = new Set((await db.user.findMany({ where: { deactivatedAt: null }, select: { id: true } })).map((u) => u.id));
  const fields = new Set((await db.customField.findMany({ where: { appliesTo: "project", archivedAt: null }, select: { id: true } })).map((f) => f.id));
  return rows.map((row) => ({
    ...row,
    memberIds: row.memberIds.filter((id) => active.has(id)),
    tasks: templateTasks(row.tasks),
    // Custom field values (WRK-148), for the fields still in use.
    customFields: Object.fromEntries(Object.entries((row.customFields ?? {}) as Record<string, string>).filter(([id, v]) => fields.has(id) && typeof v === "string")),
  }));
}

export const projectTemplateRoutes = new Hono<SignedIn>()
  .use(requireManager("work with project templates"))
  .get("/", async (c) => {
    const db = c.get("db");
    const rows = await db.projectTemplate.findMany({ select: SELECT, orderBy: { name: "asc" } });
    return c.json({ templates: await present(db, rows) });
  })
  // { projectId, name }: saves the project's settings, team and tasks as a new template.
  .post("/", async (c) => {
    const db = c.get("db");
    const body = await readBody(c);
    const name = readName(body.name);
    if (!name) return c.json({ error: NAME_ERROR }, 400);
    const project = typeof body.projectId === "string"
      ? await db.project.findFirst({
          where: { id: body.projectId },
          select: {
            billable: true, billBy: true, hourlyRate: true, fixedFee: true, feeByPhase: true, budgetBy: true, budgetSeconds: true, budgetAmount: true, everyone: true,
            members: { select: { userId: true } },
            tasks: { select: { title: true, notes: true, fee: true }, orderBy: { createdAt: "asc" } },
            customValues: { where: { field: { archivedAt: null } }, select: { fieldId: true, value: true } },
          },
        })
      : null;
    if (!project) return c.json({ error: "Project not found." }, 404);
    if (await taken(db, name)) return c.json({ error: nameTaken(name) }, 409);
    const { members, tasks, customValues, ...settings } = project;
    const data = {
      name, ...settings, memberIds: members.map((m) => m.userId), tasks: tasks.map((t) => ({ title: t.title, notes: t.notes, fee: settings.feeByPhase ? t.fee : null })),
      customFields: Object.fromEntries(customValues.map((v) => [v.fieldId, v.value])),
    };
    try {
      const row = await db.projectTemplate.create({ data: data as typeof data & { organizationId: string }, select: SELECT });
      return c.json({ template: (await present(db, [row]))[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: nameTaken(name) }, 409);
      throw error;
    }
  })
  // { name }
  .patch("/:id", async (c) => {
    const db = c.get("db");
    const name = readName((await readBody(c)).name);
    if (!name) return c.json({ error: NAME_ERROR }, 400);
    const found = await db.projectTemplate.findFirst({ where: { id: c.req.param("id") }, select: { id: true } });
    if (!found) return c.json({ error: "Template not found." }, 404);
    if (await taken(db, name, found.id)) return c.json({ error: nameTaken(name) }, 409);
    try {
      await db.projectTemplate.updateMany({ where: { id: found.id }, data: { name } });
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: nameTaken(name) }, 409);
      throw error;
    }
    const row = await db.projectTemplate.findFirstOrThrow({ where: { id: found.id }, select: SELECT });
    return c.json({ template: (await present(db, [row]))[0] });
  })
  // Projects started from it keep everything they copied.
  .delete("/:id", async (c) => {
    const { count } = await c.get("db").projectTemplate.deleteMany({ where: { id: c.req.param("id") } });
    if (!count) return c.json({ error: "Template not found." }, 404);
    return c.json({ ok: true });
  });
