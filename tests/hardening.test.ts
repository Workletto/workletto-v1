import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

describe("hardening (WRK-79, WRK-80, WRK-81)", () => {
  it("checks the database in the health check", async () => {
    const res = await request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers an unexpected error with a plain sentence and logs it without the request", async () => {
    const app = createApp();
    app.post("/boom", () => {
      throw new Error("relation \"secret_table\" does not exist");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await app.request("/boom", { method: "POST", body: JSON.stringify({ password: "hunter2-hunter2" }), headers: { "content-type": "application/json", cookie: "session=abc" } });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("secret_table");
      expect(JSON.parse(text).error).toMatch(/^Something went wrong/);
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("POST /boom failed");
      expect(logged).not.toContain("hunter2");
      expect(logged).not.toContain("session=abc");
    } finally {
      log.mockRestore();
    }
  });

  it("shows members client and colleague names, but not their contact details", async () => {
    const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    await addUser(organization.id, "member@studio.test", "member-password-1");
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    const member = (await signIn("member@studio.test", "member-password-1")).cookie;
    const { client } = await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: admin })).json();
    await request(`/api/clients/${client.id}`, { method: "PATCH", body: { email: "ap@acme.test", address: "1 Main St" }, cookie: admin });

    expect((await (await request("/api/clients", { cookie: member })).json()).clients).toEqual([{ id: client.id, name: "Acme Ltd", archived: false }]);
    expect((await (await request("/api/clients", { cookie: admin })).json()).clients[0]).toMatchObject({ email: "ap@acme.test", address: "1 Main St" });

    const asMember = (await (await request("/api/members", { cookie: member })).json()).members;
    expect(asMember).toHaveLength(2);
    for (const m of asMember) expect(Object.keys(m).sort()).toEqual(["active", "id", "name"]);
    expect((await (await request("/api/members", { cookie: admin })).json()).members[0]).toMatchObject({ email: "admin@studio.test", role: "admin" });
  });
});
