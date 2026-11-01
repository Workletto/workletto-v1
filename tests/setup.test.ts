import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { app, cookieFrom, request, resetDatabase, SETUP_CODE, signIn, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

describe("first-run setup", () => {
  it("reports that a fresh install needs setup", async () => {
    const res = await request("/api/setup/status");
    expect(await res.json()).toEqual({ needsSetup: true, setupCodeConfigured: true, setupCodeUrl: null, demo: false, passwordResetByEmail: false });
  });

  it("on Render, links to the service's Environment page until the install is claimed", async () => {
    const saved = process.env.RENDER_SERVICE_ID;
    try {
      process.env.RENDER_SERVICE_ID = "srv-dbbfc15g1s2s738pcdp0";
      const status = await (await request("/api/setup/status")).json();
      expect(status.setupCodeUrl).toBe("https://dashboard.render.com/web/srv-dbbfc15g1s2s738pcdp0/env");
      expect((await request("/api/setup", { body: validSetup })).status).toBe(201);
      expect((await (await request("/api/setup/status")).json()).setupCodeUrl).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.RENDER_SERVICE_ID;
      else process.env.RENDER_SERVICE_ID = saved;
    }
  });

  it("rejects a wrong setup code and creates nothing", async () => {
    const res = await request("/api/setup", { body: { ...validSetup, setupCode: "wrong-code-wrong-code" } });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects missing fields and short passwords", async () => {
    expect((await request("/api/setup", { body: { ...validSetup, organizationName: " " } })).status).toBe(400);
    expect((await request("/api/setup", { body: { ...validSetup, email: "not-an-email" } })).status).toBe(400);
    expect((await request("/api/setup", { body: { ...validSetup, password: "short" } })).status).toBe(400);
    expect((await request("/api/setup", { body: "nonsense" })).status).toBe(400);
  });

  it("refuses to run when the host has no usable setup code", async () => {
    const saved = process.env.SETUP_CODE;
    try {
      process.env.SETUP_CODE = "too-short";
      const status = await (await request("/api/setup/status")).json();
      expect(status.setupCodeConfigured).toBe(false);
      const res = await request("/api/setup", { body: { ...validSetup, setupCode: "too-short" } });
      expect(res.status).toBe(503);
    } finally {
      process.env.SETUP_CODE = saved;
    }
  });

  it("creates the organization and admin, and signs the admin in", async () => {
    const res = await request("/api/setup", { body: validSetup });
    expect(res.status).toBe(201);

    const me = await request("/api/me", { cookie: cookieFrom(res) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { name: "Ada Admin", email: "ada@example.com", role: "admin" },
      organization: { name: "Studio North" },
    });
    expect(await (await request("/api/setup/status")).json()).toMatchObject({ needsSetup: false });
  });

  it("is gone for good once an admin exists, even with the right code", async () => {
    await request("/api/setup", { body: validSetup });
    const again = await request("/api/setup", { body: { ...validSetup, email: "mallory@example.com" } });
    expect(again.status).toBe(404);
    expect(await prisma.user.count()).toBe(1);
  });

  it("lets only one of two simultaneous setups succeed", async () => {
    const [a, b] = await Promise.all([
      request("/api/setup", { body: validSetup, ip: "203.0.113.2" }),
      request("/api/setup", { body: { ...validSetup, email: "other@example.com" }, ip: "203.0.113.3" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 404]);
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("slows down repeated guessing from one address", async () => {
    for (let i = 0; i < 10; i++) {
      await request("/api/setup", { body: { ...validSetup, setupCode: `guess-${i}-padding-padding` } });
    }
    const res = await request("/api/setup", { body: validSetup });
    expect(res.status).toBe(429);
    // A different address can still finish setup with the right code.
    expect((await request("/api/setup", { body: validSetup, ip: "198.51.100.7" })).status).toBe(201);
  });

  it("keeps the setup code out of every response", async () => {
    const res = await request("/api/setup", { body: { ...validSetup, setupCode: "wrong-code-wrong-code" } });
    expect(await res.text()).not.toContain(SETUP_CODE);
  });
});

describe("sign-in", () => {
  beforeEach(async () => {
    await request("/api/setup", { body: validSetup });
  });

  it("signs in with the admin's email in any letter case", async () => {
    const { res, cookie } = await signIn("ADA@example.com", validSetup.password);
    expect(res.status).toBe(200);
    expect((await request("/api/me", { cookie })).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const { res } = await signIn("ada@example.com", "not the password at all");
    expect(res.status).toBe(401);
  });

  it("keeps the sign-in endpoints the app doesn't use switched off, even for someone signed in", async () => {
    const cookie = cookieFrom(await request("/api/setup", { body: validSetup }));
    for (const path of ["/update-user", "/update-session", "/list-accounts", "/unlink-account", "/get-access-token", "/refresh-token", "/account-info"]) {
      const res = await request(`/api/auth${path}`, { body: { name: "Mallory" }, cookie });
      expect(res.status, path).toBe(404);
    }
    // Nothing was renamed.
    expect((await prisma.user.findFirstOrThrow()).name).toBe(validSetup.name);
  });

  it("does not allow anyone to sign themselves up", async () => {
    const res = await request("/api/auth/sign-up/email", {
      body: { name: "Mallory", email: "mallory@example.com", password: "mallory-password-1" },
    });
    expect(res.status).toBe(404);
    expect(await prisma.user.count()).toBe(1);
  });

  it("requires a session for app data", async () => {
    expect((await request("/api/me")).status).toBe(401);
    expect((await request("/api/members")).status).toBe(401);
  });

  it("signs out", async () => {
    const { cookie } = await signIn("ada@example.com", validSetup.password);
    const out = await request("/api/auth/sign-out", { body: {}, cookie });
    expect(out.status).toBe(200);
    expect((await request("/api/me", { cookie })).status).toBe(401);
  });
});

describe("request safety", () => {
  it("rejects form posts from another site", async () => {
    const res = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: "a=1",
    });
    expect(res.status).toBe(403);
  });

  it("rejects oversized requests", async () => {
    const res = await request("/api/setup", { body: { ...validSetup, name: "x".repeat(1024 * 1024 + 10) } });
    expect(res.status).toBe(413);
  });

  it("sends security headers", async () => {
    const res = await request("/api/health");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
