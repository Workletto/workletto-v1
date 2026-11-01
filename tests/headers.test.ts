import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.ts";
import { auth } from "../src/server/auth.ts";
import { app, createOrgWithUser, ORIGIN, request, resetDatabase, signIn } from "./helpers.ts";

// Security headers, cross-site requests, oversized bodies and error answers (WRK-81).

beforeEach(resetDatabase);

// The complete set createApp sends on every response (Hono's secureHeaders, with our own policy).
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
};

function expectSecureHeaders(res: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  expect(res.headers.get("x-powered-by")).toBeNull();
}

// The built interface is served by src/server/index.ts, after createApp's middleware. This
// rebuilds that arrangement with a stand-in index.html so the page's headers can be checked.
describe("security headers", () => {
  let dir: string;
  let spa: ReturnType<typeof createApp>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spa-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>App</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    spa = createApp();
    const root = relative(process.cwd(), dir);
    spa.use("/assets/*", serveStatic({ root }));
    spa.use("*", serveStatic({ root }));
    spa.get("*", serveStatic({ path: join(root, "index.html") }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("sends the full set with the interface's HTML page", async () => {
    for (const path of ["/", "/projects/anything"]) {
      const res = await spa.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expectSecureHeaders(res);
    }
  });

  it("sends the full set with the interface's scripts too", async () => {
    const res = await spa.request("/assets/app.js");
    expect(res.status).toBe(200);
    expectSecureHeaders(res);
  });

  it("sends the full set with JSON from the API, signed in or not", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    for (const res of [await request("/api/me", { cookie }), await request("/api/me"), await request("/api/nothing-here"), await request("/api/health")]) {
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expectSecureHeaders(res);
    }
  });

  it("sends the full set on a file download and keeps it out of caches", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const res = await request("/api/settings/backup", { cookie });
    expect(res.status).toBe(200);
    expectSecureHeaders(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await res.arrayBuffer();
  });

  it("sends the full set with the public Pay now pages, and no-store", async () => {
    const unknown = await request("/pay/00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toMatch(/text\/html/);
    expectSecureHeaders(unknown);
    expect(unknown.headers.get("cache-control")).toBe("no-store");

    // A sent invoice, so the page for a real one is checked as well.
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const post = async (path: string, body: Record<string, unknown>) => (await request(path, { body, cookie })).json();
    const client = (await post("/api/clients", { name: "Acme" })).client;
    const project = (await post("/api/projects", { name: "Site", clientId: client.id, hourlyRate: 10000 })).project;
    await post("/api/time-entries", { projectId: project.id, date: "2026-10-12", seconds: 3600 });
    const { invoice } = await post("/api/invoices", { clientId: client.id, issueDate: "2026-11-01", dueDate: "2026-11-30" });
    await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "sent" }, cookie });
    for (const path of [`/pay/${invoice.id}`, `/pay/${invoice.id}/return`, `/pay/${invoice.id}/cancelled`]) {
      const res = await request(path);
      expect(res.headers.get("content-type"), path).toMatch(/text\/html/);
      expectSecureHeaders(res);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("has a Content-Security-Policy that blocks framing, other sites' scripts and form posts elsewhere", async () => {
    const csp = (await request("/api/health")).headers.get("content-security-policy")!;
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives["default-src"]).toEqual(["'self'"]); // scripts, fonts, connections, objects: this site only
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'self'"]);
    expect(directives["img-src"]).toEqual(["'self'", "data:"]);
    expect(csp).not.toContain("unsafe-eval");
    expect(directives["script-src"]).toBeUndefined(); // so default-src applies: no inline scripts
    expect(directives["style-src"]).toContain("'unsafe-inline'"); // the interface sets colors in style attributes
  });

  it("restricts <base> in the Content-Security-Policy", async () => {
    expect((await request("/api/health")).headers.get("content-security-policy")).toContain("base-uri 'none'");
  });
  it("sends a Permissions-Policy that turns off camera, microphone and location", async () => {
    expect((await request("/api/health")).headers.get("permissions-policy")).toMatch(/camera=\(\)/);
  });
});

describe("cross-site requests", () => {
  const post = (init: { headers?: Record<string, string>; body?: string }) =>
    app.request("/api/clients", { method: "POST", ...init, headers: { "x-forwarded-for": "203.0.113.1", ...init.headers } });

  it("refuses a cross-site form post", async () => {
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain"]) {
      const res = await post({ headers: { origin: "https://evil.test", "content-type": type, "sec-fetch-site": "cross-site" }, body: "name=x" });
      expect(res.status, type).toBe(403);
    }
  });

  it("refuses a cross-site post with no content type", async () => {
    const res = await post({ headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" }, body: "name=x" });
    expect(res.status).toBe(403);
  });

  it("refuses a post that says nothing about where it came from", async () => {
    expect((await post({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=x" })).status).toBe(403);
    expect((await post({ body: "name=x" })).status).toBe(403);
  });

  it("refuses a form post whose origin is another port or scheme of this host", async () => {
    for (const origin of ["http://localhost:3001", "https://localhost:3000", "null"]) {
      const res = await post({ headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
      expect(res.status, origin).toBe(403);
    }
  });

  it("refuses a cross-site form post on every kind of change, and does not change anything", async () => {
    const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/api/clients", { method, headers: { origin: "https://evil.test", "content-type": "text/plain", "sec-fetch-site": "cross-site", cookie }, body: "{\"name\":\"x\"}" });
      expect(res.status, method).toBe(403);
    }
    expect((await (await request("/api/clients", { cookie })).json()).clients).toEqual([]);
    void organization;
  });

  it("lets a same-site JSON post through", async () => {
    const res = await request("/api/clients", { body: { name: "x" } }); // signed out: past the CSRF check, then 401
    expect(res.status).toBe(401);
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    expect((await request("/api/clients", { body: { name: "Acme" }, cookie })).status).toBe(201);
    // The browser's own marker for a same-origin request works as well, with the origin header left out.
    const res2 = await app.request("/api/clients", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", cookie }, body: JSON.stringify({ name: "Beta" }) });
    expect(res2.status).toBe(201);
  });

  it("gives no other site permission to read answers (no CORS headers)", async () => {
    for (const res of [
      await app.request("/api/me", { headers: { origin: "https://evil.test" } }),
      await app.request("/api/me", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }),
      await app.request("/api/clients", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: "{}" }),
    ]) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("request size limits", () => {
  const MB = 1024 * 1024;
  const big = (bytes: number) => new Uint8Array(bytes).fill(32); // spaces

  it("answers 413 to a JSON body over 1 MB, signed in or not, before looking at it", async () => {
    const body = JSON.stringify({ name: "x".repeat(MB + 10) });
    expect((await app.request("/api/clients", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body })).status).toBe(413);
    expect((await app.request("/api/auth/sign-in/email", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body })).status).toBe(413);
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const res = await request("/api/clients", { body: { name: "x".repeat(MB + 10) }, cookie });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large." });
    expect((await (await request("/api/clients", { cookie })).json()).clients).toEqual([]);
  });

  it("answers 413 when the size is only found out while reading (no Content-Length)", async () => {
    const chunk = big(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= MB + chunk.length) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request("/api/clients", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("accepts a body just under 1 MB", async () => {
    const res = await app.request("/api/clients", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: big(MB - 10) });
    expect(res.status).toBe(401); // past the size check
  });

  it("applies the 1 MB limit to every other change method too", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/api/clients/anything", { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: big(MB + 10) });
      expect(res.status, method).toBe(413);
    }
    // A receipt's path is only exempt for PUT.
    const res = await app.request("/api/expenses/anything/receipt", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: big(MB + 10) });
    expect(res.status).toBe(413);
  });

  it("lets a receipt upload be bigger than 1 MB (up to its own 5 MB), and refuses more", async () => {
    const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    void organization;
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const project = (await (await request("/api/projects", { body: { name: "Site" }, cookie })).json()).project;
    const { expense } = await (await request("/api/expenses", { body: { projectId: project.id, date: "2026-10-12", category: "Travel", amount: 1000 }, cookie })).json();
    const pdf = (bytes: number) => {
      const b = new Uint8Array(bytes);
      b.set(new TextEncoder().encode("%PDF-1.7\n"));
      return b;
    };
    const put = (bytes: Uint8Array) =>
      app.request(`/api/expenses/${expense.id}/receipt`, { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/octet-stream", cookie }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
    expect((await put(pdf(2 * MB))).status).toBe(200);
    expect((await put(pdf(5 * MB + 1))).status).toBe(413);
  });

  it("lets the setup page's backup restore be bigger than 1 MB (it has its own, much larger limit)", async () => {
    const res = await app.request("/api/setup/restore", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/gzip", "x-setup-code": "not-the-code-not-the-code", "x-forwarded-for": "198.51.100.9" },
      body: big(2 * MB),
    });
    expect(res.status).toBe(403); // the wrong setup code, not "too large"
  });
});

describe("error answers", () => {
  it("answers a failure inside a real route with one plain sentence, no stack, SQL or secrets", async () => {
    const secret = 'connect ECONNREFUSED 10.0.0.5:5432 - password authentication failed for user "work" at /srv/app/node_modules/pg/lib/client.js:12:3';
    const getSession = vi.spyOn(auth.api, "getSession").mockRejectedValue(new Error(secret));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await request("/api/me", { cookie: "better-auth.session_token=abc.def" });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expectSecureHeaders(res);
      const text = await res.text();
      expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
      expect(JSON.parse(text).error).toMatch(/^Something went wrong\./);
      for (const leak of ["ECONNREFUSED", "10.0.0.5", "password", "node_modules", "client.js", "Error:", "    at "]) expect(text, leak).not.toContain(leak);
      expect(log.mock.calls.flat().join(" ")).not.toContain("abc.def"); // the log has the error, not the request's cookie
    } finally {
      getSession.mockRestore();
      log.mockRestore();
    }
  });

  it("answers bad JSON and unknown paths without internals", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const bad = await app.request("/api/clients", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toMatch(/SyntaxError|Unexpected token|at /);
    const missing = await request("/api/does-not-exist", { cookie });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found." });
    // Ids that aren't ids are answered, not thrown.
    for (const path of ["/api/clients/'; DROP TABLE client;--", "/api/invoices/not-a-uuid", "/api/projects/..%2F..%2Fetc"]) {
      const res = await request(path, { method: path.includes("clients") ? "PATCH" : "GET", body: path.includes("clients") ? {} : undefined, cookie });
      expect([400, 404], path).toContain(res.status);
    }
  });

  // A NUL byte can't be stored in Postgres text; it's turned away before it reaches the database.
  it("answers a NUL byte in an id or a name with a 400/404, not a 500", async () => {
    await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    const { cookie } = await signIn("admin@studio.test", "admin-password-1");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const inId = await request("/api/projects/%00", { cookie });
      const inName = await request("/api/clients", { body: { name: "a\u0000b" }, cookie });
      expect([inId.status, inName.status].every((s) => s >= 400 && s < 500)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
