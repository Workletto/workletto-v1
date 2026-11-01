import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { isUniqueViolation, readBody, readName, requireManager, type SignedIn } from "./http.ts";

// Manage → Tasks: the tasks the whole organization uses, such as Design or Project
// management. Common ones are copied onto every new project; "Add to all projects" copies
// one onto every active project that doesn't have it yet. Each project keeps its own copy,
// so renaming or removing one here leaves the projects' tasks as they are.

const SELECT = { id: true, title: true, addToNewProjects: true } as const;
const TAKEN = "There's already a task with that name.";

/** Another common task with this title, ignoring capitals. */
const sameTitle = (db: OrgDb, title: string, exceptId?: string) =>
  db.commonTask.findFirst({ where: { title: { equals: title, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });

/** Copies the common tasks marked for new projects onto a project that was just created. */
export async function addCommonTasks(tx: OrgDb, projectId: string) {
  const common = await tx.commonTask.findMany({ where: { addToNewProjects: true }, select: { title: true }, orderBy: { title: "asc" } });
  if (!common.length) return;
  const rows = common.map((t) => ({ projectId, title: t.title }));
  await tx.task.createMany({ data: rows as (typeof rows[number] & { organizationId: string })[] }); // orgDb fills in organizationId
}

export const commonTaskRoutes = new Hono<SignedIn>()
  .use(requireManager("change the organization's tasks"))
  .get("/", async (c) => {
    const tasks = await c.get("db").commonTask.findMany({ select: SELECT, orderBy: { title: "asc" } });
    return c.json({ tasks });
  })
  // { title, addToNewProjects }
  .post("/", async (c) => {
    const db = c.get("db");
    const body = await readBody(c);
    const title = readName(body.title);
    if (!title) return c.json({ error: "Enter a task (up to 200 characters)." }, 400);
    if (await sameTitle(db, title)) return c.json({ error: TAKEN }, 409);
    const data = { title, addToNewProjects: body.addToNewProjects !== false };
    try {
      const task = await db.commonTask.create({ data: data as typeof data & { organizationId: string }, select: SELECT });
      return c.json({ task }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: TAKEN }, 409);
      throw error;
    }
  })
  // { title?, addToNewProjects? }
  .patch("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await readBody(c);
    const data: { title?: string; addToNewProjects?: boolean } = {};
    if ("title" in body) {
      const title = readName(body.title);
      if (!title) return c.json({ error: "Enter a task (up to 200 characters)." }, 400);
      if (await sameTitle(db, title, id)) return c.json({ error: TAKEN }, 409);
      data.title = title;
    }
    if ("addToNewProjects" in body) {
      if (typeof body.addToNewProjects !== "boolean") return c.json({ error: "Choose whether new projects get this task." }, 400);
      data.addToNewProjects = body.addToNewProjects;
    }
    try {
      const { count } = await db.commonTask.updateMany({ where: { id }, data });
      if (!count) return c.json({ error: "Task not found." }, 404);
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: TAKEN }, 409);
      throw error;
    }
    return c.json({ task: await db.commonTask.findFirstOrThrow({ where: { id }, select: SELECT }) });
  })
  .delete("/:id", async (c) => {
    const { count } = await c.get("db").commonTask.deleteMany({ where: { id: c.req.param("id") } });
    if (!count) return c.json({ error: "Task not found." }, 404);
    return c.json({ ok: true });
  })
  // Copies the task onto every active project that has no task by that name. Archived
  // projects are left alone.
  .post("/:id/add-to-projects", async (c) => {
    const db = c.get("db");
    const task = await db.commonTask.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
    if (!task) return c.json({ error: "Task not found." }, 404);
    const projects = await db.project.findMany({
      where: { archived: false, tasks: { none: { title: { equals: task.title, mode: "insensitive" } } } },
      select: { id: true },
    });
    const rows = projects.map((p) => ({ projectId: p.id, title: task.title }));
    if (rows.length) await db.task.createMany({ data: rows as (typeof rows[number] & { organizationId: string })[] });
    return c.json({ added: rows.length });
  });
