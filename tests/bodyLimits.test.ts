import { describe, expect, it } from "vitest";
import { app, ORIGIN } from "./helpers.ts";

// A JSON body is checked for NUL characters, which means reading it. That happens only for bodies
// within the normal limit, so a huge one to the restore route is refused before anything reads it.

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body });

describe("JSON body size", () => {
  it("refuses a large JSON body sent to the restore route", async () => {
    const res = await post("/api/setup/restore", "x".repeat(2 * 1024 * 1024));
    expect([413, 415]).toContain(res.status);
  });

  it("refuses a JSON body to the restore route that has no Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
    const res = await app.request("/api/setup/restore", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: stream, duplex: "half" } as RequestInit);
    expect([413, 415]).toContain(res.status);
  });

  it("refuses an oversize JSON body on a normal route with 413", async () => {
    const res = await post("/api/setup", JSON.stringify({ a: "x".repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("still reads small JSON bodies on normal routes", async () => {
    const res = await post("/api/setup", JSON.stringify({ a: "b\u0000" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unusual characters");
  });
});
