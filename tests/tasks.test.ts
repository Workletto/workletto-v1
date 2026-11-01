import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const project = (await (await request("/api/projects", { body: { name: "Website" }, cookie: adminCookie })).json()).project;
  return { organization, admin, member, adminCookie, memberCookie, project };
}

const addTask = (cookie: string, body: Record<string, unknown>) => request("/api/tasks", { body: { title: "Wireframes", ...body }, cookie });

describe("tasks", () => {
  it("lets anyone on the project add, assign, date and finish tasks", async () => {
    const s = await studio();
    const res = await addTask(s.memberCookie, { projectId: s.project.id, assigneeId: s.member.id, dueDate: "2026-10-20" });
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task).toMatchObject({ title: "Wireframes", status: "todo", dueDate: "2026-10-20", assignee: { id: s.member.id }, completedAt: null });

    expect((await (await request("/api/tasks?mine=1", { cookie: s.memberCookie })).json()).tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect((await (await request("/api/tasks?mine=1", { cookie: s.adminCookie })).json()).tasks).toEqual([]);

    const done = (await (await request(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "done" }, cookie: s.memberCookie })).json()).task;
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    // Finished tasks drop out of the pickers but stay on the project.
    expect((await (await request("/api/tasks", { cookie: s.memberCookie })).json()).tasks).toEqual([]);
    expect((await (await request(`/api/projects/${s.project.id}`, { cookie: s.memberCookie })).json()).tasks).toHaveLength(1);
  });

  it("checks titles, dates and people", async () => {
    const s = await studio();
    const p = s.project.id;
    expect((await addTask(s.adminCookie, { projectId: p, title: "" })).status).toBe(400);
    expect((await addTask(s.adminCookie, { projectId: p, dueDate: "2026-13-01" })).status).toBe(400);
    expect((await addTask(s.adminCookie, { projectId: p, status: "blocked" })).status).toBe(400);
    expect((await addTask(s.adminCookie, { projectId: p, assigneeId: "nobody" })).status).toBe(400);

    // Someone who isn't on a closed project's team can't be given its tasks.
    const closed = (await (await request("/api/projects", { body: { name: "Closed", everyone: false, memberIds: [] }, cookie: s.adminCookie })).json()).project;
    expect((await addTask(s.adminCookie, { projectId: closed.id, assigneeId: s.member.id })).status).toBe(400);
    expect((await addTask(s.memberCookie, { projectId: closed.id })).status).toBe(404);
  });

  it("links time to a task on the same project, and keeps the time when the task goes", async () => {
    const s = await studio();
    const other = (await (await request("/api/projects", { body: { name: "Other" }, cookie: s.adminCookie })).json()).project;
    const task = (await (await addTask(s.memberCookie, { projectId: s.project.id })).json()).task;
    const otherTask = (await (await addTask(s.memberCookie, { projectId: other.id })).json()).task;

    const entry = (await (await request("/api/time-entries", { body: { projectId: s.project.id, taskId: task.id, date: TODAY, seconds: 600 }, cookie: s.memberCookie })).json()).entry;
    expect(entry.task).toEqual({ id: task.id, title: "Wireframes" });
    expect((await request("/api/time-entries", { body: { projectId: s.project.id, taskId: otherTask.id, date: TODAY, seconds: 60 }, cookie: s.memberCookie })).status).toBe(400);

    const timer = await request("/api/timer/start", { body: { projectId: s.project.id, taskId: task.id, date: TODAY }, cookie: s.memberCookie });
    expect((await timer.json()).entry.task.id).toBe(task.id);

    // Moving the entry to another project drops its task.
    const moved = (await (await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { projectId: other.id }, cookie: s.memberCookie })).json()).entry;
    expect(moved.task).toBeNull();
    const back = (await (await request(`/api/time-entries/${entry.id}`, { method: "PATCH", body: { projectId: s.project.id, taskId: task.id }, cookie: s.memberCookie })).json()).entry;
    expect(back.task.id).toBe(task.id);

    // A task with time is an admin's or manager's to delete: the time loses it.
    expect((await request(`/api/tasks/${task.id}`, { method: "DELETE", cookie: s.memberCookie })).status).toBe(403);
    expect((await request(`/api/tasks/${task.id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(200);
    expect(await prisma.timeEntry.count({ where: { userId: s.member.id } })).toBe(2);
    expect(await prisma.timeEntry.count({ where: { taskId: { not: null } } })).toBe(0);
  });
});

describe("organization isolation for tasks", () => {
  it("never shows, changes or links across organizations", async () => {
    const a = await studio();
    const task = (await (await addTask(a.adminCookie, { projectId: a.project.id })).json()).task;
    const b = await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const bCookie = (await signIn("b@b.test", "admin-password-1")).cookie;
    const bProject = (await (await request("/api/projects", { body: { name: "B" }, cookie: bCookie })).json()).project;

    expect((await (await request("/api/tasks", { cookie: bCookie })).json()).tasks).toEqual([]);
    expect((await addTask(bCookie, { projectId: a.project.id })).status).toBe(404);
    expect((await addTask(bCookie, { projectId: bProject.id, assigneeId: a.member.id })).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}`, { method: "PATCH", body: { title: "Hacked" }, cookie: bCookie })).status).toBe(404);
    expect((await request(`/api/tasks/${task.id}`, { method: "DELETE", cookie: bCookie })).status).toBe(404);
    expect((await request("/api/time-entries", { body: { projectId: bProject.id, taskId: task.id, date: TODAY, seconds: 60 }, cookie: bCookie })).status).toBe(400);

    // The database itself refuses a task from one project on another project's entry.
    await expect(
      prisma.timeEntry.create({
        data: { organizationId: b.organization.id, userId: b.user.id, projectId: bProject.id, taskId: task.id, date: new Date(TODAY), billable: true },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.task.create({ data: { organizationId: b.organization.id, projectId: bProject.id, title: "x", assigneeId: a.member.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
