import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { MAX_RECEIPT_BYTES } from "../src/server/receipts.ts";
import { addUser, app, createOrgWithUser, ORIGIN, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

const DAY = "2026-10-12";

function png(padTo = 64) {
  const b = new Uint8Array(padTo);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 800);
  new DataView(b.buffer).setUint32(20, 1200);
  return b;
}
const pdf = (text = "%PDF-1.7\n%receipt\n%%EOF") => new TextEncoder().encode(text);

function upload(expenseId: string, bytes: Uint8Array, cookie: string, name?: string) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/octet-stream", cookie };
  if (name !== undefined) headers["x-file-name"] = encodeURIComponent(name);
  return app.request(`/api/expenses/${expenseId}/receipt`, { method: "PUT", headers, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
}

async function studio() {
  const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "member@studio.test", "member-password-1");
  await addUser(organization.id, "other@studio.test", "other-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const other = (await signIn("other@studio.test", "other-password-1")).cookie;
  const project = (await (await request("/api/projects", { body: { name: "Website" }, cookie: admin })).json()).project;
  const { expense } = await (await request("/api/expenses", { body: { projectId: project.id, date: DAY, category: "Travel", amount: 4250 }, cookie: member })).json();
  return { organization, admin, member, other, expense };
}

describe("receipts", { timeout: 20_000 }, () => {
  it("attaches, opens and removes a photo, recorded in the history", async () => {
    const s = await studio();
    const res = await upload(s.expense.id, png(), s.member, "C:\\Users\\me\\Taxi to client.png");
    expect(res.status).toBe(200);
    expect((await res.json()).receipt).toEqual({ fileName: "Taxi to client.png", contentType: "image/png", size: 64 });

    const { expenses } = await (await request(`/api/expenses?from=${DAY}&to=${DAY}`, { cookie: s.member })).json();
    expect(expenses[0].receipt).toEqual({ fileName: "Taxi to client.png", contentType: "image/png", size: 64 });

    const open = await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: s.member });
    expect(open.status).toBe(200);
    expect(open.headers.get("content-type")).toBe("image/png");
    expect(open.headers.get("x-content-type-options")).toBe("nosniff");
    expect(open.headers.get("content-disposition")).toMatch(/^inline; filename="Taxi to client.png"/);
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(png());

    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { method: "DELETE", cookie: s.member })).status).toBe(200);
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: s.member })).status).toBe(404);
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { method: "DELETE", cookie: s.member })).status).toBe(404);

    const history = (await (await request("/api/history?kind=expense", { cookie: s.admin })).json()).events;
    expect(history.slice(0, 2).map((e: { changes: unknown }) => e.changes)).toEqual([
      [{ field: "receipt", from: "Taxi to client.png", to: null }],
      [{ field: "receipt", from: null, to: "Taxi to client.png" }],
    ]);
  });

  it("downloads PDFs instead of opening them in the app", async () => {
    const s = await studio();
    expect((await upload(s.expense.id, pdf(), s.member, "Hotel.pdf")).status).toBe(200);
    const open = await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: s.member });
    expect(open.headers.get("content-type")).toBe("application/pdf");
    expect(open.headers.get("content-disposition")).toMatch(/^attachment; filename="Hotel.pdf"/);
  });

  it("replaces a receipt, and names one without a name", async () => {
    const s = await studio();
    await upload(s.expense.id, png(), s.member, "first.png");
    const res = await upload(s.expense.id, pdf(), s.member);
    expect((await res.json()).receipt).toMatchObject({ fileName: "receipt.pdf", contentType: "application/pdf" });
    expect(await prisma.receipt.count()).toBe(1);
  });

  it("checks the file by its contents, with clear messages", async () => {
    const s = await studio();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = await upload(s.expense.id, svg, s.member, "receipt.png");
    expect(html.status).toBe(400);
    expect((await html.json()).error).toBe("Upload a JPEG, PNG or WebP photo, or a PDF.");
    expect((await upload(s.expense.id, new Uint8Array(), s.member)).status).toBe(400);

    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(pdf());
    const tooBig = await upload(s.expense.id, big, s.member, "scan.pdf");
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("That file is over 5 MB. Try a smaller photo or a compressed PDF.");
    const justRight = new Uint8Array(MAX_RECEIPT_BYTES);
    justRight.set(pdf());
    expect((await upload(s.expense.id, justRight, s.member, "scan.pdf")).status).toBe(200);
    // Other requests keep the small limit.
    expect((await app.request("/api/expenses", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: s.member }, body: JSON.stringify({ notes: "x".repeat(1024 * 1024 + 1) }) })).status).toBe(413);
  });

  it("lets only the owner change it; admins and managers can open it", async () => {
    const s = await studio();
    await upload(s.expense.id, png(), s.member, "taxi.png");
    expect((await upload(s.expense.id, png(), s.other)).status).toBe(404);
    expect((await upload(s.expense.id, png(), s.admin)).status).toBe(404);
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { method: "DELETE", cookie: s.other })).status).toBe(404);
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: s.other })).status).toBe(404);
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: s.admin })).status).toBe(200);

    await createOrgWithUser("Elsewhere", "boss@else.test", "boss-password-1", "admin");
    const outsider = (await signIn("boss@else.test", "boss-password-1")).cookie;
    expect((await request(`/api/expenses/${s.expense.id}/receipt`, { cookie: outsider })).status).toBe(404);
  });

  it("goes with its expense", async () => {
    const s = await studio();
    await upload(s.expense.id, png(), s.member);
    expect((await request(`/api/expenses/${s.expense.id}`, { method: "DELETE", cookie: s.member })).status).toBe(200);
    expect(await prisma.receipt.count()).toBe(0);
  });
});
