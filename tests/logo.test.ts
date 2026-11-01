import { beforeEach, describe, expect, it } from "vitest";
import { checkLogo, inspectImage } from "../src/server/logo.ts";
import { MAX_LOGO_BYTES } from "../src/shared/limits.ts";
import { prisma } from "../src/server/db.ts";
import { addUser, app, cookieFrom, createOrgWithUser, ORIGIN, request, resetDatabase, signIn, validSetup } from "./helpers.ts";

// Minimal file headers, enough for the size checks. Browsers would need more to draw them.
function png(width: number, height: number, padTo = 64) {
  const b = new Uint8Array(padTo);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number) {
  // SOI, an APP0 segment to skip, then SOF0 with the size.
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
}
function webpHeader(fourcc: string) {
  const b = new Uint8Array(40);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  b.set([...fourcc].map((c) => c.charCodeAt(0)), 12);
  return b;
}
function webpX(width: number, height: number) {
  const b = webpHeader("VP8X");
  b.set([(width - 1) & 255, ((width - 1) >> 8) & 255, (width - 1) >> 16], 24);
  b.set([(height - 1) & 255, ((height - 1) >> 8) & 255, (height - 1) >> 16], 27);
  return b;
}
function webpLossy(width: number, height: number) {
  const b = webpHeader("VP8 ");
  b.set([0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8], 23);
  return b;
}
function webpLossless(width: number, height: number) {
  const b = webpHeader("VP8L");
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  b.set([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 20);
  return b;
}
const text = (s: string) => new TextEncoder().encode(s);

describe("inspectImage", () => {
  it.each([
    ["PNG", png(300, 120), "image/png"],
    ["JPEG", jpeg(640, 480), "image/jpeg"],
    ["WebP (extended)", webpX(1000, 250), "image/webp"],
    ["WebP (lossy)", webpLossy(200, 100), "image/webp"],
    ["WebP (lossless)", webpLossless(512, 256), "image/webp"],
  ])("reads the type and size of a %s", (_, bytes, type) => {
    const info = inspectImage(bytes);
    expect(info?.contentType).toBe(type);
  });

  it("reads exact dimensions", () => {
    expect(inspectImage(png(300, 120))).toEqual({ contentType: "image/png", width: 300, height: 120 });
    expect(inspectImage(jpeg(640, 480))).toEqual({ contentType: "image/jpeg", width: 640, height: 480 });
    expect(inspectImage(webpX(1000, 250))).toMatchObject({ width: 1000, height: 250 });
    expect(inspectImage(webpLossy(200, 100))).toMatchObject({ width: 200, height: 100 });
    expect(inspectImage(webpLossless(512, 256))).toMatchObject({ width: 512, height: 256 });
  });

  it.each([
    ["SVG", text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["HTML", text("<!doctype html><script>alert(1)</script>")],
    ["GIF", text("GIF89a............")],
    ["a truncated PNG", png(300, 120).slice(0, 20)],
    ["a truncated JPEG", jpeg(640, 480).slice(0, 12)],
    ["a JPEG with no size", new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])],
    ["empty bytes", new Uint8Array()],
  ])("rejects %s", (_, bytes) => {
    expect(inspectImage(bytes)).toBeNull();
  });
});

describe("checkLogo", () => {
  it("rejects tiny, huge and oversized images", () => {
    expect(checkLogo(png(8, 8))).toMatchObject({ status: 400 });
    expect(checkLogo(png(5000, 100))).toMatchObject({ status: 400 });
    // The limit is 1 MB, and the message says so in the units the Appearance page uses.
    expect(MAX_LOGO_BYTES).toBe(1024 * 1024);
    expect(checkLogo(png(100, 100, MAX_LOGO_BYTES + 1))).toEqual({ status: 413, error: "That file is over 1 MB. Try a smaller or compressed image." });
    expect(checkLogo(png(100, 100))).toMatchObject({ contentType: "image/png" });
  });
});

describe("logo API", () => {
  beforeEach(resetDatabase);

  async function adminCookie() {
    return cookieFrom(await request("/api/setup", { body: validSetup }));
  }
  function upload(bytes: Uint8Array, cookie?: string, type = "image/png") {
    const headers: Record<string, string> = { origin: ORIGIN, "content-type": type };
    if (cookie) headers.cookie = cookie;
    return app.request("/api/settings/appearance/logo", { method: "PUT", headers, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  }

  it("stores an admin's logo and serves it back unchanged", async () => {
    const cookie = await adminCookie();
    const bytes = png(300, 120);
    const res = await upload(bytes, cookie);
    expect(res.status).toBe(200);
    const { logoVersion } = await res.json();
    expect(typeof logoVersion).toBe("number");

    const own = await request("/api/logo", { cookie });
    expect(own.headers.get("content-type")).toBe("image/png");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(bytes);

    // The sign-in screen can show it too.
    const pub = await request("/api/branding/logo");
    expect(pub.status).toBe(200);
    expect((await (await request("/api/branding")).json()).logoVersion).toBe(logoVersion);
    expect((await (await request("/api/me", { cookie })).json()).organization.logoVersion).toBe(logoVersion);
  });

  it("uses the detected type, not the type the browser claims", async () => {
    const cookie = await adminCookie();
    await upload(jpeg(640, 480), cookie, "image/png");
    expect((await request("/api/logo", { cookie })).headers.get("content-type")).toBe("image/jpeg");
  });

  it("rejects an SVG pretending to be a PNG", async () => {
    const cookie = await adminCookie();
    const res = await upload(text("<svg><script>alert(1)</script></svg>"), cookie, "image/png");
    expect(res.status).toBe(400);
    expect(await prisma.logo.count()).toBe(0);
  });

  it("answers repeat requests with 304 when nothing changed", async () => {
    const cookie = await adminCookie();
    await upload(png(300, 120), cookie);
    const first = await request("/api/logo", { cookie });
    const etag = first.headers.get("etag")!;
    const again = await app.request("/api/logo", { headers: { cookie, "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("replaces and removes the logo", async () => {
    const cookie = await adminCookie();
    await upload(png(300, 120), cookie);
    await upload(webpX(1000, 250), cookie);
    expect(await prisma.logo.count()).toBe(1);
    expect((await request("/api/logo", { cookie })).headers.get("content-type")).toBe("image/webp");

    const del = await request("/api/settings/appearance/logo", { method: "DELETE", cookie });
    expect(del.status).toBe(200);
    expect((await request("/api/logo", { cookie })).status).toBe(404);
    expect((await (await request("/api/branding")).json()).logoVersion).toBeNull();
  });

  it("takes a logo of up to 1 MB in one request, and refuses a bigger one with the logo's own message", async () => {
    const cookie = await adminCookie();
    expect((await upload(png(100, 100, MAX_LOGO_BYTES - 1024), cookie)).status).toBe(200);
    const res = await upload(png(100, 100, MAX_LOGO_BYTES + 1), cookie);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "That file is over 1 MB. Try a smaller or compressed image." });
  });

  it("is for admins only", async () => {
    await adminCookie();
    const org = await prisma.organization.findFirstOrThrow();
    await addUser(org.id, "member@example.com", "member-password");
    const { cookie } = await signIn("member@example.com", "member-password");
    expect((await upload(png(300, 120), cookie)).status).toBe(403);
    expect((await upload(png(300, 120))).status).toBe(401);
    expect(await prisma.logo.count()).toBe(0);
  });

  it("keeps each organization's logo to itself", async () => {
    const adminA = await adminCookie();
    await upload(png(300, 120), adminA);
    await createOrgWithUser("Org B", "b@example.com", "password-for-b", "admin");
    const { cookie: adminB } = await signIn("b@example.com", "password-for-b");

    expect((await request("/api/logo", { cookie: adminB })).status).toBe(404);
    await upload(jpeg(640, 480), adminB);
    expect((await request("/api/logo", { cookie: adminA })).headers.get("content-type")).toBe("image/png");
    // The public sign-in logo is always the install's own organization's.
    expect((await request("/api/branding/logo")).headers.get("content-type")).toBe("image/png");
  });
});
