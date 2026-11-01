import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ORG_SCOPED_MODELS } from "../src/server/db.ts";
import { TABLES } from "../src/server/backup.ts";
import { app, request, resetDatabase } from "./helpers.ts";

beforeEach(resetDatabase);

// Routes anyone may call without signing in. Everything else under /api must answer 401.
const PUBLIC = [
  /^\/api\/health$/,
  /^\/api\/auth(\/|$)/, // sign-in itself
  /^\/api\/demo(\/|$)/,
  /^\/api\/setup(\/|$)/, // first run, guarded by the setup code
  /^\/api\/branding(\/|$)/, // the sign-in page's name and colors
  /^\/api\/invites(\/|$)/, // accepting an invite, guarded by its token
  /^\/api\/password-reset(\/|$)/, // guarded by the reset token
  /^\/api\/payments(\/|$)/, // Stripe's notifications, guarded by their signature
];

const ID = "00000000-0000-4000-8000-000000000000";

describe("route access", () => {
  const routes = [...new Map(
    app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/") && !r.path.includes("*"))
      .map((r) => [`${r.method} ${r.path}`, r] as const),
  ).values()];

  it("finds the app's routes", () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it("answers 401 to signed-out requests on every route that isn't public", async () => {
    const open: string[] = [];
    for (const route of routes) {
      if (PUBLIC.some((p) => p.test(route.path))) continue;
      const path = route.path.replace(/:\w+(\{[^}]*\})?/g, ID);
      const res = await request(path, { method: route.method, body: route.method === "GET" ? undefined : {} });
      if (res.status !== 401) open.push(`${route.method} ${route.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it("scopes every table that belongs to an organization", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const withOrganization = [...schema.matchAll(/^model (\w+) \{([^}]*)\}/gm)]
      .filter(([, , body]) => /^\s+organizationId\s/m.test(body!))
      .map(([, name]) => name!);
    // The one exception: the install's single row, read before anyone is signed in.
    const global = ["Installation"];
    expect(withOrganization.filter((m) => !global.includes(m) && !ORG_SCOPED_MODELS.has(m))).toEqual([]);
    expect([...ORG_SCOPED_MODELS].filter((m) => !withOrganization.includes(m))).toEqual([]);
  });

  // The unrestricted client skips orgDb()'s organization check (db.ts says when that's right).
  // A new file using it should be a decision, so this list has to be changed on purpose.
  it("uses the unrestricted database client only in the files that need it", () => {
    const allowed = [
      "about.ts", // migrations and the Postgres version, for the diagnostics page
      "app.ts", // the health check
      "auth.ts", // sessions, before the person's organization is known
      "backup.ts", // backups and restore cover the whole install
      "branding.ts", // the sign-in page's name, colors and logo
      "demo.ts", // creating and cleaning up demo organizations
      "importExport.ts", // an imported person's email must be unused on the install
      "passwordReset.ts", // reset links, before anyone is signed in
      "payments.ts", // Pay now pages, Stripe's notifications and the payment check
      "people.ts", // invites, and email addresses unique on the install
      "recurring.ts", // the repeating-invoice job, across organizations
      "reminders.ts", // the late-payment reminder job, across organizations
      "twoFactor.ts", // Better Auth's two-factor table has no organization; a person is found through orgDb first
      "setup.ts", // first-run setup
      "sso.ts", // single sign-on, before anyone is signed in
      "timesheets.ts", // the weekly reminder job, across organizations
    ];
    const using = readdirSync("src/server")
      .filter((file) => file.endsWith(".ts") && file !== "db.ts")
      .filter((file) => /\bprisma\.(\$|[a-zA-Z]+\.)/.test(readFileSync(`src/server/${file}`, "utf8")));
    expect(using.sort()).toEqual(allowed.sort());
  });

  it("backs up every table that belongs to an organization", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const withOrganization = [...schema.matchAll(/^model (\w+) \{([^}]*)\}/gm)]
      .filter(([, , body]) => /^\s+organizationId\s/m.test(body!))
      .map(([, name]) => name!);
    // Left out on purpose: the install's own row, and reset links (short-lived; backup.ts says why).
    const notBackedUp = ["Installation", "PasswordReset"];
    const backedUp = new Set(TABLES.map((t) => t.model.charAt(0).toUpperCase() + t.model.slice(1)));
    expect(withOrganization.filter((m) => !notBackedUp.includes(m) && !backedUp.has(m))).toEqual([]);
  });
});
