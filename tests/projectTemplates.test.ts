import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Project templates (WRK-150): a project's settings, team and tasks saved under a name, never its
// client. A new project copies them; nothing stays linked.

beforeEach(resetDatabase);

async function studio(name = "Studio", domain = "studio.test") {
  const { organization } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  const manager = await addUser(organization.id, `manager@${domain}`, "manager-password-1", "manager");
  const ada = await addUser(organization.id, `ada@${domain}`, "member-password-1");
  const ben = await addUser(organization.id, `ben@${domain}`, "member-password-1");
  const cookie = (await signIn(`manager@${domain}`, "manager-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await request(path, { cookie, ...init });
    return { status: res.status, body: await res.json() };
  };
  return { organization, manager, ada, ben, json };
}

/** A fixed fee project for a client, with an hours budget, a chosen team and two tasks. */
async function retainer(s: Awaited<ReturnType<typeof studio>>) {
  const client = (await s.json("/api/clients", { body: { name: "Acme" } })).body.client;
  const project = (await s.json("/api/projects", {
    body: { name: "Brand refresh", clientId: client.id, billable: true, billBy: "project", hourlyRate: 12_000, fixedFee: 900_000, budgetBy: "hours", budgetSeconds: 40 * 3600, everyone: false, memberIds: [s.ada.id, s.ben.id] },
  })).body.project;
  expect((await s.json("/api/tasks", { body: { projectId: project.id, title: "Discovery", notes: "Kick-off and interviews" } })).status).toBe(201);
  expect((await s.json("/api/tasks", { body: { projectId: project.id, title: "Design" } })).status).toBe(201);
  return { client, project };
}

describe("project templates", () => {
  it("keep a project's billing, rates, budget, team and tasks, but not its client", async () => {
    const s = await studio();
    const { project } = await retainer(s);
    const saved = await s.json("/api/project-templates", { body: { projectId: project.id, name: "Retainer" } });
    expect(saved.status).toBe(201);
    expect(saved.body.template).toEqual({
      id: expect.any(String), name: "Retainer", billable: true, billBy: "project", hourlyRate: 12_000, fixedFee: 900_000, feeByPhase: false, budgetBy: "hours",
      budgetSeconds: 40 * 3600, budgetAmount: null, everyone: false, memberIds: [s.ada.id, s.ben.id],
      tasks: [{ title: "Discovery", notes: "Kick-off and interviews", fee: null }, { title: "Design", notes: "", fee: null }],
      customFields: {},
    });
    expect(JSON.stringify(saved.body.template)).not.toContain("Acme");
    expect((await s.json("/api/project-templates")).body.templates).toHaveLength(1);
  });

  it("start a new project with the template's tasks instead of the common ones, and stay unlinked", async () => {
    const s = await studio();
    const { project } = await retainer(s);
    const template = (await s.json("/api/project-templates", { body: { projectId: project.id, name: "Retainer" } })).body.template;
    await s.json("/api/common-tasks", { body: { title: "Admin", addToNewProjects: true } });
    const other = (await s.json("/api/clients", { body: { name: "Globex" } })).body.client;

    const settings = Object.fromEntries(Object.entries(template).filter(([key]) => !["id", "name", "tasks"].includes(key)));
    const made = await s.json("/api/projects", { body: { ...settings, name: "Globex refresh", clientId: other.id, templateId: template.id } });
    expect(made.status).toBe(201);
    expect(made.body.project).toMatchObject({ name: "Globex refresh", client: { id: other.id }, fixedFee: 900_000, budgetBy: "hours", everyone: false, memberIds: [s.ada.id, s.ben.id] });
    const tasks = await prisma.task.findMany({ where: { projectId: made.body.project.id }, orderBy: { createdAt: "asc" }, select: { title: true, notes: true, status: true } });
    expect(tasks).toEqual([
      { title: "Discovery", notes: "Kick-off and interviews", status: "todo" },
      { title: "Design", notes: "", status: "todo" },
    ]);

    // Renaming or deleting the template changes nothing on the project, and changing the project changes nothing on the template.
    expect((await s.json(`/api/project-templates/${template.id}`, { method: "PATCH", body: { name: "Monthly retainer" } })).body.template.name).toBe("Monthly retainer");
    expect((await s.json(`/api/projects/${made.body.project.id}`, { method: "PATCH", body: { hourlyRate: 15_000 } })).status).toBe(200);
    expect((await s.json("/api/project-templates")).body.templates[0]).toMatchObject({ name: "Monthly retainer", hourlyRate: 12_000 });
    expect((await s.json(`/api/project-templates/${template.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await s.json(`/api/projects/${made.body.project.id}`)).body.project).toMatchObject({ name: "Globex refresh", hourlyRate: 15_000 });
    expect(await prisma.task.count({ where: { projectId: made.body.project.id } })).toBe(2);

    // A template that's gone can't be used.
    expect((await s.json("/api/projects", { body: { name: "Late", templateId: template.id } })).status).toBe(400);
  });

  it("leave out people who have left", async () => {
    const s = await studio();
    const { project } = await retainer(s);
    await s.json("/api/project-templates", { body: { projectId: project.id, name: "Retainer" } });
    await prisma.user.update({ where: { id: s.ben.id }, data: { deactivatedAt: new Date() } });
    expect((await s.json("/api/project-templates")).body.templates[0].memberIds).toEqual([s.ada.id]);
  });

  it("need a name no other template has", async () => {
    const s = await studio();
    const { project } = await retainer(s);
    expect((await s.json("/api/project-templates", { body: { projectId: project.id, name: "  " } })).status).toBe(400);
    expect((await s.json("/api/project-templates", { body: { projectId: project.id, name: "Retainer" } })).status).toBe(201);
    expect((await s.json("/api/project-templates", { body: { projectId: project.id, name: "retainer" } })).status).toBe(409);
    const second = (await s.json("/api/project-templates", { body: { projectId: project.id, name: "Sprint" } })).body.template;
    expect((await s.json(`/api/project-templates/${second.id}`, { method: "PATCH", body: { name: "RETAINER" } })).status).toBe(409);
    expect((await s.json("/api/project-templates", { body: { projectId: "nope", name: "Other" } })).status).toBe(404);
  });

  it("belong to one organization", async () => {
    const north = await studio();
    const south = await studio("South", "south.test");
    const { project } = await retainer(north);
    const template = (await north.json("/api/project-templates", { body: { projectId: project.id, name: "Retainer" } })).body.template;

    expect((await south.json("/api/project-templates")).body.templates).toEqual([]);
    expect((await south.json(`/api/project-templates/${template.id}`, { method: "PATCH", body: { name: "Mine" } })).status).toBe(404);
    expect((await south.json(`/api/project-templates/${template.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await south.json("/api/projects", { body: { name: "Copy", templateId: template.id } })).status).toBe(400);
    expect((await south.json("/api/project-templates", { body: { projectId: project.id, name: "Stolen" } })).status).toBe(404);
    expect(await prisma.projectTemplate.count()).toBe(1);
  });
});
