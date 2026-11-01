import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { prisma } from "./db.ts";
import { readBody, requireAdmin, type SignedIn } from "./http.ts";
import { recordAudit } from "./audit.ts";

// Two-factor sign-in (WRK-147), the admin's side. People set it up and turn it off themselves
// through Better Auth's twoFactor plugin (auth.ts). Here an admin can require it for everyone
// who signs in with a password, and reset it for someone who lost their phone. The plugin's
// table isn't organization-scoped, so a person is always found through this organization first.

const onOff = (on: boolean) => (on ? "On" : "Off");

export const twoFactorRoutes = new Hono<SignedIn>()
  .use(requireAdmin("change two-factor sign-in"))
  .get("/settings", async (c) => {
    const db = c.get("db");
    const [{ requireTwoFactor }, enabled] = await Promise.all([
      db.organization.findFirstOrThrow({ select: { requireTwoFactor: true } }),
      db.user.count({ where: { twoFactorEnabled: true, deactivatedAt: null } }),
    ]);
    return c.json({ required: requireTwoFactor, enabled });
  })
  // { required }
  .put("/settings", async (c) => {
    const body = await readBody(c);
    if (typeof body.required !== "boolean") return c.json({ error: "Say whether two-factor sign-in is required." }, 400);
    const required = body.required;
    const db = c.get("db");
    const user = c.get("user");
    // An admin who requires it starts with their own, so they aren't locked out of the rest of the app.
    if (required) {
      const me = await db.user.findFirstOrThrow({ where: { id: user.id }, select: { twoFactorEnabled: true, accounts: { where: { providerId: "credential" }, select: { id: true }, take: 1 } } });
      if (!me.twoFactorEnabled && me.accounts.length > 0) return c.json({ error: "Set up two-factor sign-in for yourself first, from the menu with your name." }, 409);
    }
    await db.$transaction(async (tx) => {
      const before = await tx.organization.findFirstOrThrow({ select: { requireTwoFactor: true } });
      await tx.organization.update({ where: { id: user.organizationId }, data: { requireTwoFactor: required } });
      if (before.requireTwoFactor !== required) {
        await recordAudit(tx as OrgDb, user, { kind: "settings", action: "changed", label: "Two-factor sign-in", changes: [{ field: "requireTwoFactor", from: onOff(before.requireTwoFactor), to: onOff(required) }] });
      }
    });
    return c.json({ required });
  })
  // Someone lost their phone: their two-factor is removed, and they set it up again after signing in.
  .delete("/people/:userId", async (c) => {
    const db = c.get("db");
    const person = await db.user.findFirst({ where: { id: c.req.param("userId") }, select: { id: true, name: true, twoFactorEnabled: true } });
    if (!person) return c.json({ error: "Person not found." }, 404);
    if (!person.twoFactorEnabled) return c.json({ error: `${person.name} doesn't use two-factor sign-in.` }, 409);
    // Turned off first: with the flag off, a leftover secret is never asked for.
    await db.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { id: person.id }, data: { twoFactorEnabled: false } });
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "person", action: "changed", subjectId: person.id, label: person.name, changes: [{ field: "twoFactor", from: "On", to: "Reset" }] });
    });
    await prisma.twoFactor.deleteMany({ where: { userId: person.id } });
    return c.json({ ok: true });
  });
