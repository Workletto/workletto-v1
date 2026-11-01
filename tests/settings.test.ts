import { beforeEach, describe, expect, it } from "vitest";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

const company = { name: "Studio North Ltd", appName: "North Hours", currency: "EUR", address: "1 Quay St\nDublin" };
const save = (cookie: string, body: unknown) => request("/api/settings/company", { method: "PUT", body, cookie });

describe("company settings", () => {
  it("lets an admin rename the company and the app, and set currency and address", async () => {
    const cookie = cookieFrom(await request("/api/setup", { body: validSetup }));
    const res = await save(cookie, { ...company, appName: "  North Hours " });
    expect((await res.json()).organization).toEqual(company);
    expect((await (await request("/api/me", { cookie })).json()).organization).toMatchObject(company);
    // The sign-in page shows the new names.
    expect(await (await request("/api/branding")).json()).toMatchObject({ name: "Studio North Ltd", appName: "North Hours" });

    expect((await (await save(cookie, { ...company, appName: "" })).json()).organization.appName).toBeNull();
  });

  it("checks what it's given", async () => {
    const cookie = cookieFrom(await request("/api/setup", { body: validSetup }));
    expect((await save(cookie, { ...company, name: "" })).status).toBe(400);
    expect((await save(cookie, { ...company, currency: "XYZ" })).status).toBe(400);
    expect((await save(cookie, { ...company, appName: "x".repeat(41) })).status).toBe(400);
  });

  it("is for admins only, and only changes their own organization", async () => {
    const a = await createOrgWithUser("Org A", "a@a.test", "admin-password-1", "admin");
    await addUser(a.organization.id, "m@a.test", "manager-password-1", "manager");
    await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const manager = (await signIn("m@a.test", "manager-password-1")).cookie;
    expect((await save(manager, company)).status).toBe(403);

    const b = (await signIn("b@b.test", "admin-password-1")).cookie;
    expect((await save(b, company)).status).toBe(200);
    const aAdmin = (await signIn("a@a.test", "admin-password-1")).cookie;
    expect((await (await request("/api/me", { cookie: aAdmin })).json()).organization).toMatchObject({ name: "Org A", currency: "USD", appName: null });
  });
});
