import net from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { startFakeOidc } from "./fakeOidc.ts";
import { cookieFrom, createOrgWithUser, request, resetDatabase, signIn, validSetup } from "./helpers.ts";

// The app promises it never contacts anyone: not the makers of Workletto, not
// analytics, nobody. These tests keep that true. If one fails, the change
// added a network call. Remove it, or if it is truly needed (and the customer
// turns it on themselves), add it to ALLOWED with the reason, and update
// SECURITY.md and Manage → Security & data to say so.

const SERVER = "src/server";

// Ways server code can reach the network.
const NETWORK = [
  { what: "fetch()", pattern: /\bfetch\s*\(/ },
  { what: "a network module", pattern: /\bfrom\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)(?:\/[\w/]*)?["']/ },
  { what: "a network module", pattern: /\b(?:import|require)\s*\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)["']/ },
  { what: "an HTTP client package", pattern: /["'](?:undici|axios|node-fetch|got|ky|ws|better-fetch|@better-fetch\/fetch)["']/ },
  { what: "a browser network API", pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/ },
];

// file (relative to src/server) → why its network use is allowed. Empty: nothing is.
const ALLOWED: Record<string, string> = {
  "mail.ts": "Sends email only after an admin turns email on in Manage → Email; the customer chooses where it goes.",
  "stripe.ts": "Talks to api.stripe.com only after an admin connects their own Stripe account in Manage → Payments, for clients paying invoices online.",
  "calendarFetch.ts": "Fetches a person's own private calendar address (iCal) only when they load a week to import in Time → Import from calendar; they choose the address, and only public https addresses are fetched.",
  "ssoSettings.ts": "Reads the identity provider's OpenID Connect settings only when an admin saves single sign-on in Manage → Settings; the customer chooses the provider.",
};

function serverFiles(dir = SERVER): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? serverFiles(join(dir, e.name)) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("no phone-home", () => {
  it("server code makes no network calls of its own", () => {
    const found: string[] = [];
    for (const file of serverFiles()) {
      if (ALLOWED[file.slice(SERVER.length + 1)]) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments
        for (const { what, pattern } of NETWORK) if (pattern.test(line)) found.push(`${file}:${i + 1} uses ${what}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("the check above would notice a network call", () => {
    const lines = ['await fetch("https://example.com")', 'import https from "node:https";', 'import { connect } from "net";', "new WebSocket(url)"];
    for (const line of lines) expect(NETWORK.some(({ pattern }) => pattern.test(line)), line).toBe(true);
    expect(NETWORK.some(({ pattern }) => pattern.test("serve({ fetch: app.fetch, port })"))).toBe(false);
  });

  // What actually runs on a host is dist/server.js, bundled by scripts/build-server.mjs (same
  // options here). Bundling must not bring in anything the check above didn't see: packages
  // stay outside it, and the runtime check below covers what they do.
  it("the built server adds no network calls of its own", async () => {
    const { build } = await import("esbuild");
    const out = await build({ entryPoints: ["src/server/index.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", write: false, logLevel: "silent" });
    const code = out.outputFiles[0]!.text;
    // package → why the server may load it.
    const PACKAGES: Record<string, string> = {
      hono: "answers requests; makes none",
      "@hono/node-server": "answers requests; makes none",
      "@prisma/client": "the database",
      "@prisma/adapter-pg": "the database",
      "better-auth": "sign-in; connects only to the single sign-on provider an admin sets up",
      nodemailer: "email, from mail.ts (allowed above)",
      "ical.js": "reads calendar files for calendar import; makes no network calls",
    };
    // Node's network modules, only as imported by the files allowed above.
    const allowedNodeModules = new Set(Object.keys(ALLOWED).flatMap((file) => [...readFileSync(join(SERVER, file), "utf8").matchAll(/from\s+"(node:[\w/]+)"/g)].map((m) => m[1]!)));
    const modules = new Set([...code.matchAll(/^import\b[^;]*?\bfrom\s*"([^"]+)";/gm)].map((m) => m[1]!));
    const unexpected = [...modules].filter((m) => {
      if (m.startsWith("node:")) return !allowedNodeModules.has(m) && NETWORK.some(({ pattern }) => pattern.test(`from "${m}"`));
      const name = m.startsWith("@") ? m.split("/").slice(0, 2).join("/") : m.split("/")[0]!;
      return !PACKAGES[name];
    });
    expect(unexpected).toEqual([]);
    // Every fetch() in the bundle comes from a file allowed above.
    const count = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\bfetch\s*\(/.test(l)).length;
    const allowedCalls = Object.keys(ALLOWED).reduce((n, file) => n + count(readFileSync(join(SERVER, file), "utf8")), 0);
    expect(count(code)).toBe(allowedCalls);
  });

  // Starting the app runs the database tool first (`npm start`: prisma migrate deploy). Its only
  // call home is an update check, turned off in the start command and in the Docker image.
  it("starting the app turns off the database tool's update check", () => {
    const start = JSON.parse(readFileSync("package.json", "utf8")).scripts.start as string;
    expect(start).toMatch(/^CHECKPOINT_DISABLE=1 prisma migrate deploy && /);
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toMatch(/CHECKPOINT_DISABLE=1/);
    expect(docker).toMatch(/NPM_CONFIG_UPDATE_NOTIFIER=false/);
    expect(docker).toMatch(/^CMD \["npm", "start"\]$/m);
    // Render and Docker Compose start the image as it is.
    expect(readFileSync("render.yaml", "utf8")).not.toMatch(/startCommand|preDeployCommand/);
    expect(readFileSync("compose.yaml", "utf8")).not.toMatch(/^\s*(command|entrypoint):/m);
  });

  // The same promise, checked while the app runs, so libraries are covered too:
  // every outgoing connection must go to the database.
  describe("while the app runs", () => {
    const connections: string[] = [];
    const realConnect = net.Socket.prototype.connect;
    const db = new URL(process.env.DATABASE_URL!);
    const allowed = new Set([`${db.hostname}:${db.port || 5432}`]);

    beforeAll(() => {
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        // net.connect() passes its already-read options as one array.
        const [first, second] = (Array.isArray(args[0]) ? args[0] : args) as [unknown, unknown];
        const target =
          first && typeof first === "object"
            ? (first as { path?: string; host?: string; port?: number }).path ?? `${(first as { host?: string }).host ?? "localhost"}:${(first as { port?: number }).port}`
            : typeof first === "number" || /^\d+$/.test(String(first))
              ? `${typeof second === "string" ? second : "localhost"}:${first}`
              : String(first);
        connections.push(target);
        if (!allowed.has(target) && !target.startsWith("/")) {
          // Block it, so a failing test never actually sends anything.
          queueMicrotask(() => this.destroy(new Error(`Blocked connection to ${target}`)));
          return this;
        }
        return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
      } as typeof realConnect;
    });
    afterAll(() => {
      net.Socket.prototype.connect = realConnect;
    });

    it("contacts nothing but the database during everyday use", async () => {
      await resetDatabase();
      const cookie = cookieFrom(await request("/api/setup", { body: validSetup }));
      const call = (path: string, body?: unknown, method?: string) => request(path, { cookie, body, method });

      expect((await request("/api/auth/sign-in/email", { body: { email: validSetup.email, password: validSetup.password } })).status).toBe(200);
      const { client } = await (await call("/api/clients", { name: "Acme" })).json();
      const { project } = await (await call("/api/projects", { name: "Website", clientId: client.id })).json();
      const today = new Date().toISOString().slice(0, 10);
      expect((await call("/api/time-entries", { projectId: project.id, date: today, seconds: 3600 })).status).toBe(201);
      for (const path of ["/api/me", "/api/members", `/api/time-entries?from=${today}&to=${today}`, `/api/reports/summary?from=${today}&to=${today}`, "/api/data/export/clients", "/api/settings/security", "/api/people", "/api/settings/email"]) {
        expect((await call(path)).status, path).toBeLessThan(400);
      }
      // There's no other way to sign in, so nothing to connect to.
      expect((await request("/api/auth/sign-in/social", { body: { provider: "google", callbackURL: "/" } })).status).toBe(404);
      await call("/api/auth/sign-out", {});

      expect(connections.filter((c) => !allowed.has(c) && !c.startsWith("/"))).toEqual([]);
      // And the watch above really sees connections: the database's own.
      expect(connections.some((c) => allowed.has(c))).toBe(true);
    });

    // With single sign-on on, signing in trades a one-time code with the provider the admin
    // chose: that provider, and nobody else, is contacted. Its tokens aren't kept.
    it("contacts only the chosen provider when someone signs in through single sign-on", async () => {
      await resetDatabase();
      const fake = await startFakeOidc("workletto-test", "provider-secret");
      const provider = new URL(fake.issuer).host;
      allowed.add(provider);
      try {
        await createOrgWithUser("Studio", "ada@studio.test", "admin-password-1", "admin");
        const admin = (await signIn("ada@studio.test", "admin-password-1")).cookie;
        connections.length = 0;
        const saved = await request("/api/settings/sso", {
          method: "PUT",
          cookie: admin,
          body: { providerName: "Okta", issuer: fake.issuer, clientId: "workletto-test", clientSecret: "provider-secret", domain: "studio.test", allowJoin: false, requireSso: false },
        });
        expect(saved.status).toBe(200);
        // Manage → Security & data says so.
        expect((await (await request("/api/settings/security", { cookie: admin })).json()).sso).toEqual({ providerName: "Okta", host: provider, required: false });
        const start = await request("/api/auth/sign-in/social", { body: { provider: "sso", callbackURL: "/", errorCallbackURL: "/sign-in" } });
        const { code, state } = fake.approve((await start.json()).url, { sub: "okta-ada", email: "ada@studio.test" });
        const back = await request(`/api/auth/callback/sso?code=${code}&state=${encodeURIComponent(state)}`, { cookie: cookieFrom(start) });
        expect(back.headers.get("location")).toBe("/");

        expect(connections).toContain(provider);
        expect(connections.filter((c) => !allowed.has(c) && !c.startsWith("/"))).toEqual([]);
        expect(await prisma.account.findFirstOrThrow({ where: { providerId: "sso" } })).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
      } finally {
        await request("/api/settings/sso", { method: "DELETE", cookie: (await signIn("ada@studio.test", "admin-password-1")).cookie });
        allowed.delete(provider);
        fake.close();
      }
    });

    it("would notice a connection somewhere else", async () => {
      connections.length = 0;
      await expect(fetch("http://192.0.2.1/")).rejects.toThrow();
      expect(connections).toContain("192.0.2.1:80");
    });
  });
});
