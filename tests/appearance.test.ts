import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { inkOn, contrast } from "../src/shared/color.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

async function setUpAndSignIn() {
  const res = await request("/api/setup", { body: validSetup });
  return cookieFrom(res);
}

function save(cookie: string, body: unknown) {
  return request("/api/settings/appearance", { method: "PUT", body, cookie });
}

describe("appearance", () => {
  it("shows the default look before setup", async () => {
    expect(await (await request("/api/branding")).json()).toEqual({ name: null, appName: null, accentColor: null, colorMode: "system", logoVersion: null, sso: null });
  });

  it("shows the install's name on the sign-in screen after setup", async () => {
    await setUpAndSignIn();
    expect(await (await request("/api/branding")).json()).toEqual({
      name: "Studio North",
      appName: null,
      accentColor: null,
      colorMode: "system",
      logoVersion: null,
      sso: null,
    });
  });

  it("lets an admin save a color and mode, everywhere at once", async () => {
    const cookie = await setUpAndSignIn();
    const res = await save(cookie, { accentColor: "#C2410C", colorMode: "dark" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accentColor: "#c2410c", colorMode: "dark" });

    expect(await (await request("/api/branding")).json()).toMatchObject({ accentColor: "#c2410c", colorMode: "dark" });
    const me = await (await request("/api/me", { cookie })).json();
    expect(me.organization).toMatchObject({ accentColor: "#c2410c", colorMode: "dark" });
  });

  it("resets to the default color", async () => {
    const cookie = await setUpAndSignIn();
    await save(cookie, { accentColor: "#c2410c", colorMode: "light" });
    await save(cookie, { accentColor: null, colorMode: "system" });
    expect(await (await request("/api/branding")).json()).toMatchObject({ accentColor: null, colorMode: "system" });
  });

  it.each([
    [{ accentColor: "red", colorMode: "light" }],
    [{ accentColor: "#fff", colorMode: "light" }],
    [{ accentColor: "#12345g", colorMode: "light" }],
    [{ accentColor: "#123456;background:url(x)", colorMode: "light" }],
    [{ accentColor: "#123456", colorMode: "sepia" }],
    [{ accentColor: "#123456" }],
  ])("rejects %j", async (body) => {
    const cookie = await setUpAndSignIn();
    expect((await save(cookie, body)).status).toBe(400);
  });

  it("is for admins only", async () => {
    await setUpAndSignIn();
    const org = await prisma.organization.findFirstOrThrow();
    await addUser(org.id, "member@example.com", "member-password", "member");
    const { cookie } = await signIn("member@example.com", "member-password");
    expect((await save(cookie, { accentColor: "#c2410c", colorMode: "dark" })).status).toBe(403);
    expect((await request("/api/settings/appearance", { method: "PUT", body: {} })).status).toBe(401);
    expect((await prisma.organization.findFirstOrThrow()).accentColor).toBeNull();
  });

  it("only changes the admin's own organization", async () => {
    await setUpAndSignIn();
    await createOrgWithUser("Org B", "b@example.com", "password-for-b", "admin");
    const { cookie } = await signIn("b@example.com", "password-for-b");
    expect((await save(cookie, { accentColor: "#c2410c", colorMode: "dark" })).status).toBe(200);

    // The install's own organization (and so the sign-in screen) is untouched.
    expect(await (await request("/api/branding")).json()).toMatchObject({ name: "Studio North", accentColor: null });
    expect((await prisma.organization.findFirstOrThrow({ where: { name: "Org B" } })).accentColor).toBe("#c2410c");
  });
});

describe("button text on the accent color", () => {
  it.each(["#2b4a78", "#c2410c", "#facc15", "#ffffff", "#000000", "#777777", "#22c55e"])(
    "stays readable on %s",
    (accent) => {
      expect(contrast(accent, inkOn(accent))).toBeGreaterThanOrEqual(4.5);
    },
  );
});
