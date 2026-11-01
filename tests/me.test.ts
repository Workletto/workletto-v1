import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { cookieFrom, request, resetDatabase, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

describe("/api/me", () => {
  it("includes the person's weekly capacity, for the timesheet's expected hours (WRK-125)", async () => {
    const cookie = cookieFrom(await request("/api/setup", { body: validSetup }));
    const me = await (await request("/api/me", { cookie })).json();
    // 40 hours unless Manage → People says otherwise.
    expect(me.user.weeklyCapacity).toBe(40 * 3600);

    await prisma.user.update({ where: { id: me.user.id }, data: { weeklyCapacity: 30 * 3600 } });
    expect((await (await request("/api/me", { cookie })).json()).user.weeklyCapacity).toBe(30 * 3600);
  });
});
