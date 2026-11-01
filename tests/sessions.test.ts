import { beforeEach, describe, expect, it } from "vitest";
import { deleteExpiredSessions } from "../src/server/auth.ts";
import { prisma } from "../src/server/db.ts";
import { createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Expired sign-in sessions don't keep their IP address and browser forever (WRK-143).

beforeEach(resetDatabase);

const HOUR = 60 * 60 * 1000;

describe("deleteExpiredSessions", () => {
  it("deletes sessions that ran out more than a day ago, and keeps the rest", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const live = await signIn("admin@studio.test", "admin-password-1");
    await signIn("admin@studio.test", "admin-password-1");
    await signIn("admin@studio.test", "admin-password-1");
    const sessions = await prisma.session.findMany({ orderBy: { createdAt: "asc" } });
    expect(sessions).toHaveLength(3);
    const now = new Date();
    const [, recentlyExpired, longExpired] = sessions;
    await prisma.session.update({ where: { id: recentlyExpired!.id }, data: { expiresAt: new Date(now.getTime() - 12 * HOUR) } });
    await prisma.session.update({ where: { id: longExpired!.id }, data: { expiresAt: new Date(now.getTime() - 48 * HOUR) } });

    expect(await deleteExpiredSessions(now)).toBe(1);
    const left = await prisma.session.findMany({ select: { id: true } });
    expect(left.map((s) => s.id).sort()).toEqual([sessions[0]!.id, recentlyExpired!.id].sort());

    // The session still in use keeps working.
    expect((await request("/api/me", { cookie: live.cookie })).status).toBe(200);
  });

  it("does nothing when no session has expired", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    await signIn("admin@studio.test", "admin-password-1");
    expect(await deleteExpiredSessions()).toBe(0);
    expect(await prisma.session.count()).toBe(1);
  });
});
