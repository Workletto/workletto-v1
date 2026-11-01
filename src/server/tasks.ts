import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { readBody, readName, type SignedIn } from "./http.ts";
import { projectsFor } from "./billing.ts";
import { asDate, dayOrNull, isIsoDate } from "../shared/time.ts";
import { canManageWork } from "../shared/roles.ts";
import { recordAudit } from "./audit.ts";

// Tasks are a project's to-dos. Anyone who can work on a project can add and
// change its tasks.

export const TASK_SELECT = {
  id: true,
  projectId: true,
  title: true,
  notes: true,
  status: true,
  dueDate: true,
  completedAt: true,
  assignee: { select: { id: true, name: true } },
} as const;

export const toTask = <T extends { dueDate: Date | null; completedAt: Date | null }>(t: T) => ({
  ...t,
  dueDate: dayOrNull(t.dueDate),
  completedAt: t.completedAt?.toISOString() ?? null,
});

const STATUSES = ["todo", "in_progress", "done"] as const;
type Status = (typeof STATUSES)[number];
type User = { id: string; role: string };

/** A project this person can work on, or null. */
function openProject(db: OrgDb, user: User, id: unknown) {
  if (typeof id !== "string") return null;
  return db.project.findFirst({ where: { AND: [{ id }, projectsFor(user)] }, select: { id: true, everyone: true } });
}

type TaskData = {
  title?: string; notes?: string; status?: Status; completedAt?: Date | null;
  assigneeId?: string | null; dueDate?: Date | null;
};

/** Reads task fields from a request body, checking links against the task's project. */
async function readTask(db: OrgDb, body: Record<string, unknown>, project: { id: string; everyone: boolean }, creating: boolean) {
  const data: TaskData = {};
  const fail = (error: string) => ({ error });
  if (creating || "title" in body) {
    const title = readName(body.title);
    if (!title) return fail("Enter a task (up to 200 characters).");
    data.title = title;
  }
  if ("notes" in body) {
    if (typeof body.notes !== "string" || body.notes.length > 5000) return fail("Notes can be up to 5,000 characters.");
    data.notes = body.notes.trim();
  }
  if ("status" in body) {
    if (!STATUSES.includes(body.status as Status)) return fail("Choose To do, In progress or Done.");
    data.status = body.status as Status;
    data.completedAt = data.status === "done" ? new Date() : null;
  }
  if ("dueDate" in body) {
    if (body.dueDate !== null && body.dueDate !== "" && !isIsoDate(body.dueDate)) return fail("Choose a valid due date.");
    data.dueDate = body.dueDate ? asDate(body.dueDate as string) : null;
  }
  if ("assigneeId" in body) {
    if (body.assigneeId === null || body.assigneeId === "") data.assigneeId = null;
    else {
      const person = typeof body.assigneeId === "string"
        ? await db.user.findFirst({
            where: { id: body.assigneeId, deactivatedAt: null },
            select: { id: true, role: true, projects: { where: { projectId: project.id }, select: { userId: true } } },
          })
        : null;
      if (!person) return fail("Choose someone in your organization.");
      if (!project.everyone && !canManageWork(person.role) && person.projects.length === 0) {
        return fail("That person isn't on this project's team.");
      }
      data.assigneeId = person.id;
    }
  }
  return { data };
}

export const taskRoutes = new Hono<SignedIn>()
  // Open tasks on the projects you can work on, for picking a task when tracking time.
  // With ?mine=1, only the ones assigned to you.
  .get("/", async (c) => {
    const user = c.get("user");
    const rows = await c.get("db").task.findMany({
      where: {
        status: { not: "done" },
        project: { archived: false, ...projectsFor(user) },
        ...(c.req.query("mine") ? { assigneeId: user.id } : {}),
      },
      select: { ...TASK_SELECT, project: { select: { name: true } } },
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    });
    return c.json({ tasks: rows.map(toTask) });
  })
  .post("/", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const project = await openProject(db, c.get("user"), body.projectId);
    if (!project) return c.json({ error: "Project not found." }, 404);
    const input = await readTask(db, body, project, true);
    if ("error" in input) return c.json(input, 400);
    const data = { ...input.data, projectId: project.id };
    const task = await db.task.create({ data: data as typeof data & { title: string; organizationId: string }, select: TASK_SELECT });
    return c.json({ task: toTask(task) }, 201);
  })
  .patch("/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const task = await db.task.findFirst({
      where: { id: c.req.param("id"), project: projectsFor(user) },
      select: { id: true, project: { select: { id: true, everyone: true } } },
    });
    if (!task) return c.json({ error: "Task not found." }, 404);
    const input = await readTask(db, await readBody(c), task.project, false);
    if ("error" in input) return c.json(input, 400);
    const updated = await db.task.update({ where: { id: task.id }, data: input.data, select: TASK_SELECT });
    return c.json({ task: toTask(updated) });
  })
  // Time tracked on the task stays on the project, just without the task.
  .delete("/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const task = await db.task.findFirst({
      where: { id: c.req.param("id"), project: projectsFor(user) },
      select: { id: true, title: true, fee: true, project: { select: { id: true, name: true, feeByPhase: true } }, _count: { select: { timeEntries: true, feeLines: true } } },
    });
    if (!task) return c.json({ error: "Task not found." }, 404);
    // A phase whose fee is on an invoice stays (WRK-151); its fee lines point at it.
    if (task._count.feeLines) return c.json({ error: "This phase's fee is on invoices, so it can't be deleted." }, 409);
    if (task.fee !== null && task.project.feeByPhase && !canManageWork(user.role)) return c.json({ error: "This task is a phase with a fee. Ask an admin or manager to delete it." }, 403);
    // Its time changes too (it loses the task), so only admins and managers decide that.
    if (task._count.timeEntries && !canManageWork(user.role)) return c.json({ error: "This task has time on it. Ask an admin or manager to delete it." }, 403);
    await db.$transaction(async (tx) => {
      const { count } = await tx.timeEntry.updateMany({ where: { taskId: task.id }, data: { taskId: null } });
      await tx.task.deleteMany({ where: { id: task.id } });
      // The project's fee stays the sum of its phases.
      if (task.fee !== null && task.project.feeByPhase) {
        const sum = (await tx.task.aggregate({ where: { projectId: task.project.id, fee: { not: null } }, _sum: { fee: true } }))._sum.fee ?? 0;
        await tx.project.updateMany({ where: { id: task.project.id }, data: { fixedFee: sum } });
      }
      if (count) {
        await recordAudit(tx as OrgDb, user, { kind: "project", action: "changed", subjectId: task.project.id, label: task.project.name, changes: [{ field: "task", from: `${task.title} (deleted, ${count} time ${count === 1 ? "entry" : "entries"} kept without it)`, to: null }] });
      }
    });
    return c.json({ ok: true });
  });
