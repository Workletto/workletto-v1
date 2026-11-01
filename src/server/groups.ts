import { Hono, type Context } from "hono";
import type { OrgDb } from "./db.ts";
import { readBody, readName, requireAdmin, requireManager, type SignedIn } from "./http.ts";
import { projectLabel, recordAudit } from "./audit.ts";

// User groups (WRK-149): teams or departments, like "Design" or "Studio B". Admins make them on the
// Team page; a person can be in several. They filter Reports, the Team page, the Schedule and
// Approvals, can add their people to a project's team in one step, and show in exports. They never
// change what anyone can see or do: roles stay as they are.

const SELECT = { id: true, name: true, members: { select: { userId: true } } } as const;
const toGroup = ({ members, ...g }: { id: string; name: string; members: { userId: string }[] }) => ({ ...g, memberIds: members.map((m) => m.userId) });

/** The people filter for ?groupId=: only the group's members. Another organization's group matches nobody. */
export function groupWhere(c: Context<SignedIn>): Record<string, unknown> {
  const groupId = c.req.query("groupId");
  return groupId ? { groups: { some: { groupId } } } : {};
}

/** Each person's groups, by name, for exports: userId → "Design, Studio B". */
export async function groupNames(db: OrgDb): Promise<Map<string, string>> {
  const rows = await db.userGroupMember.findMany({ select: { userId: true, group: { select: { name: true } } }, orderBy: { group: { name: "asc" } } });
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.group.name]);
  return new Map([...out].map(([id, names]) => [id, names.join(", ")]));
}

const NAME_ERROR = "Enter a group name of up to 60 characters.";
const taken = (name: string) => `There's already a group called ${name}.`;

async function nameTaken(db: OrgDb, name: string, exceptId?: string) {
  return !!(await db.userGroup.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));
}

/** People in this organization, from a list of ids, or an error. */
async function readMembers(db: OrgDb, value: unknown): Promise<string[] | { error: string }> {
  if (!Array.isArray(value) || value.length > 1000 || !value.every((id) => typeof id === "string")) return { error: "Choose the people in the group." };
  const ids = [...new Set(value as string[])];
  const found = await db.user.count({ where: { id: { in: ids } } });
  return found === ids.length ? ids : { error: "Some of those people aren't in your organization." };
}

export const groupRoutes = new Hono<SignedIn>()
  // Admins and managers use groups to filter; only admins make and change them.
  .get("/", requireManager("see groups"), async (c) => {
    const rows = await c.get("db").userGroup.findMany({ select: SELECT, orderBy: { name: "asc" } });
    return c.json({ groups: rows.map(toGroup) });
  })
  // { name, memberIds? }
  .post("/", requireAdmin("make groups"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const name = readName(body.name);
    if (!name || name.length > 60) return c.json({ error: NAME_ERROR }, 400);
    if (await nameTaken(db, name)) return c.json({ error: taken(name) }, 409);
    const members = body.memberIds === undefined ? [] : await readMembers(db, body.memberIds);
    if (!Array.isArray(members)) return c.json(members, 400);
    const group = await db.$transaction(async (tx) => {
      const created = await tx.userGroup.create({ data: { name } as { name: string; organizationId: string }, select: { id: true } });
      if (members.length) await tx.userGroupMember.createMany({ data: members.map((userId) => ({ groupId: created.id, userId })) as never });
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "created", label: `Group ${name}`, changes: [{ field: "groupMembers", from: null, to: String(members.length) }] });
      return tx.userGroup.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
    });
    return c.json({ group: toGroup(group) }, 201);
  })
  // { name?, memberIds? }
  .patch("/:id", requireAdmin("change groups"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const group = await db.userGroup.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
    if (!group) return c.json({ error: "Group not found." }, 404);
    let name: string | undefined;
    if ("name" in body) {
      name = readName(body.name) ?? undefined;
      if (!name || name.length > 60) return c.json({ error: NAME_ERROR }, 400);
      if (await nameTaken(db, name, group.id)) return c.json({ error: taken(name) }, 409);
    }
    const members = "memberIds" in body ? await readMembers(db, body.memberIds) : null;
    if (members && !Array.isArray(members)) return c.json(members, 400);
    const updated = await db.$transaction(async (tx) => {
      if (name) await tx.userGroup.updateMany({ where: { id: group.id }, data: { name } });
      if (members) {
        await tx.userGroupMember.deleteMany({ where: { groupId: group.id } });
        if (members.length) await tx.userGroupMember.createMany({ data: members.map((userId) => ({ groupId: group.id, userId })) as never });
      }
      const changes = [
        ...(name && name !== group.name ? [{ field: "name", from: group.name, to: name }] : []),
        ...(members && members.length !== group.members.length ? [{ field: "groupMembers", from: String(group.members.length), to: String(members.length) }] : []),
      ];
      if (changes.length) await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "changed", label: `Group ${name ?? group.name}`, changes });
      return tx.userGroup.findFirstOrThrow({ where: { id: group.id }, select: SELECT });
    });
    return c.json({ group: toGroup(updated) });
  })
  // The people stay; only the group goes.
  .delete("/:id", requireAdmin("delete groups"), async (c) => {
    const db = c.get("db");
    const group = await db.userGroup.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
    if (!group) return c.json({ error: "Group not found." }, 404);
    await db.$transaction(async (tx) => {
      await tx.userGroup.deleteMany({ where: { id: group.id } });
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "deleted", label: `Group ${group.name}`, changes: [{ field: "groupMembers", from: String(group.members.length), to: null }] });
    });
    return c.json({ ok: true });
  })
  // { projectId }: the group's people join the project's team (it stops being open to everyone).
  // The team is still a list of people: someone who joins the group later isn't added.
  .post("/:id/add-to-project", requireManager("change projects"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const group = await db.userGroup.findFirst({ where: { id: c.req.param("id") }, select: SELECT });
    if (!group) return c.json({ error: "Group not found." }, 404);
    const project = typeof body.projectId === "string"
      ? await db.project.findFirst({ where: { id: body.projectId }, select: { id: true, name: true, everyone: true, client: { select: { name: true, currency: true } }, members: { select: { userId: true } } } })
      : null;
    if (!project) return c.json({ error: "Project not found." }, 404);
    const active = new Set((await db.user.findMany({ where: { id: { in: group.members.map((m) => m.userId) }, deactivatedAt: null }, select: { id: true } })).map((u) => u.id));
    const already = new Set(project.members.map((m) => m.userId));
    const adding = [...active].filter((id) => !already.has(id));
    await db.$transaction(async (tx) => {
      if (adding.length) await tx.projectMember.createMany({ data: adding.map((userId) => ({ projectId: project.id, userId })) as never });
      if (project.everyone) await tx.project.updateMany({ where: { id: project.id }, data: { everyone: false } });
      if (adding.length || project.everyone) {
        await recordAudit(tx as OrgDb, c.get("user"), {
          kind: "project", action: "changed", subjectId: project.id, label: projectLabel(project), currency: project.client?.currency,
          changes: [{ field: "team", from: project.everyone ? "Everyone" : null, to: `Added group ${group.name} (${adding.length} ${adding.length === 1 ? "person" : "people"})` }],
        });
      }
    });
    return c.json({ added: adding.length });
  });
