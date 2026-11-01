import { beforeEach, describe, expect, it } from "vitest";
import { cookieFrom, request, resetDatabase, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

async function admin() {
  return cookieFrom(await request("/api/setup", { body: validSetup }));
}
const post = (cookie: string, path: string, body: unknown) => request(path, { body, cookie });
const patch = (cookie: string, path: string, body: unknown) => request(path, { method: "PATCH", body, cookie });

describe("duplicate names (QA-49)", () => {
  it("refuses a second client of the same name, ignoring capitals and spaces around it", async () => {
    const cookie = await admin();
    expect((await post(cookie, "/api/clients", { name: "Gamma GmbH" })).status).toBe(201);
    for (const [typed, shown] of [["Gamma GmbH", "Gamma GmbH"], ["gamma gmbh", "gamma gmbh"], ["  Gamma GmbH ", "Gamma GmbH"]]) {
      const res = await post(cookie, "/api/clients", { name: typed });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(`There's already a client called ${shown}.`);
    }
    // Renaming onto another client's name is refused; keeping or re-capitalising its own is fine.
    const other = (await (await post(cookie, "/api/clients", { name: "Delta" })).json()).client;
    expect((await patch(cookie, `/api/clients/${other.id}`, { name: "GAMMA gmbh" })).status).toBe(409);
    expect((await patch(cookie, `/api/clients/${other.id}`, { name: "DELTA" })).status).toBe(200);
    // An archived client still holds its name.
    const archived = (await (await post(cookie, "/api/clients", { name: "Old Co" })).json()).client;
    await patch(cookie, `/api/clients/${archived.id}`, { archived: true });
    expect((await post(cookie, "/api/clients", { name: "old co" })).status).toBe(409);
  });

  it("refuses a second project of the same name for the same client only", async () => {
    const cookie = await admin();
    const a = (await (await post(cookie, "/api/clients", { name: "Acme" })).json()).client;
    const b = (await (await post(cookie, "/api/clients", { name: "Beta" })).json()).client;
    expect((await post(cookie, "/api/projects", { name: "Website", clientId: a.id })).status).toBe(201);
    const again = await post(cookie, "/api/projects", { name: "website", clientId: a.id });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This client already has a project called website.");
    // Another client, or no client, may use the name.
    expect((await post(cookie, "/api/projects", { name: "Website", clientId: b.id })).status).toBe(201);
    expect((await post(cookie, "/api/projects", { name: "Website" })).status).toBe(201);
    expect((await post(cookie, "/api/projects", { name: "WEBSITE" })).status).toBe(409);
    // Renaming, or moving to a client that has one, is checked too.
    const app = (await (await post(cookie, "/api/projects", { name: "App", clientId: a.id })).json()).project;
    expect((await patch(cookie, `/api/projects/${app.id}`, { name: "Website" })).status).toBe(409);
    expect((await patch(cookie, `/api/projects/${app.id}`, { name: "Website", clientId: null })).status).toBe(409);
    expect((await patch(cookie, `/api/projects/${app.id}`, { billable: false })).status).toBe(200);
  });
});
