import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

beforeEach(resetDatabase);

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const post = async (path: string, body: Record<string, unknown>, cookie = adminCookie) => (await request(path, { body, cookie })).json();

  const client = (await post("/api/clients", { name: "Northwind" })).client;
  await request(`/api/clients/${client.id}`, { method: "PATCH", body: { address: "1 Quay St\nDublin", email: "ap@northwind.test" }, cookie: adminCookie });
  const other = (await post("/api/clients", { name: "Other" })).client;
  const brand = (await post("/api/projects", { name: "Brand", clientId: client.id, hourlyRate: 10000 })).project;
  const site = (await post("/api/projects", { name: "Site", clientId: client.id, billBy: "person" })).project;
  const elsewhere = (await post("/api/projects", { name: "Elsewhere", clientId: other.id, hourlyRate: 5000 })).project;
  await request(`/api/people/${member.id}`, { method: "PATCH", body: { hourlyRate: 8000 }, cookie: adminCookie });
  await request(`/api/people/${admin.id}`, { method: "PATCH", body: { hourlyRate: 12000 }, cookie: adminCookie });

  const entry = async (cookie: string, projectId: string, date: string, seconds: number, extra: Record<string, unknown> = {}) =>
    (await post("/api/time-entries", { projectId, date, seconds, ...extra }, cookie)).entry;
  const e1 = await entry(memberCookie, brand.id, "2026-10-12", 5400); // 1.5 h × 100
  await entry(adminCookie, brand.id, "2026-10-13", 1800); // 0.5 h × 100
  await entry(memberCookie, site.id, "2026-10-13", 3600); // 1 h × 80 (person rate)
  await entry(adminCookie, site.id, "2026-10-14", 3600); // 1 h × 120 (person rate)
  await entry(adminCookie, brand.id, "2026-10-14", 3600, { billable: false }); // not billable
  await entry(adminCookie, brand.id, "2026-11-02", 3600); // outside October
  await entry(adminCookie, elsewhere.id, "2026-10-14", 3600); // other client
  const expense = (await post("/api/expenses", { projectId: brand.id, date: "2026-10-12", category: "Printing", amount: 4500, notes: "Proofs" }, memberCookie)).expense;
  return { organization, admin, member, adminCookie, memberCookie, client, brand, site, e1, expense };
}

const create = (cookie: string, body: Record<string, unknown>) =>
  request("/api/invoices", { body: { issueDate: "2026-11-01", dueDate: "2026-11-30", ...body }, cookie });

describe("invoices", () => {
  it("shows what's ready to bill for each client", async () => {
    const s = await studio();
    const { clients } = await (await request("/api/invoices/unbilled", { cookie: s.adminCookie })).json();
    expect(clients.map((c: { client: { name: string }; seconds: number; amount: number; expenses: number }) => [c.client.name, c.seconds, c.amount, c.expenses])).toEqual([
      ["Northwind", 18000, 50000, 4500], // includes the November hour
      ["Other", 3600, 5000, 0],
    ]);
  });

  it("makes an invoice from a client's unbilled time and expenses in a period", async () => {
    const s = await studio();
    const res = await create(s.adminCookie, { clientId: s.client.id, from: "2026-10-01", to: "2026-10-31", taxPercent: "10", notes: "Thanks!" });
    expect(res.status).toBe(201);
    const { invoice } = await (await request(`/api/invoices/${(await res.json()).invoice.id}`, { cookie: s.adminCookie })).json();
    expect(invoice).toMatchObject({
      number: "0001", status: "draft", currency: "USD", taxBasisPoints: 1000, notes: "Thanks!",
      periodFrom: "2026-10-01", periodTo: "2026-10-31",
      client: { name: "Northwind", address: "1 Quay St\nDublin", email: "ap@northwind.test" },
    });
    expect(invoice.lines.map((l: { kind: string; description: string; quantity: number; unitPrice: number; amount: number }) =>
      [l.kind, l.description, l.quantity, l.unitPrice, l.amount])).toEqual([
      ["time", "Brand", 2000, 10000, 20000],
      ["time", "Site – admin", 1000, 12000, 12000],
      ["time", "Site – member", 1000, 8000, 8000],
      ["expense", "Printing – Proofs (Brand, 2026-10-12)", 1000, 4500, 4500],
    ]);
    expect(invoice).toMatchObject({ subtotal: 44500, tax: 4450, total: 48950 });

    // Invoiced time is locked, and isn't billed twice.
    const locked = await request(`/api/time-entries/${s.e1.id}`, { method: "PATCH", body: { seconds: 60 }, cookie: s.memberCookie });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toMatch(/invoice 0001/);
    expect((await request(`/api/time-entries/${s.e1.id}`, { method: "DELETE", cookie: s.memberCookie })).status).toBe(409);
    expect((await request(`/api/expenses/${s.expense.id}`, { method: "DELETE", cookie: s.memberCookie })).status).toBe(409);
    expect((await request("/api/timer/start", { body: { entryId: s.e1.id }, cookie: s.memberCookie })).status).toBe(404);
    const { entries } = await (await request("/api/time-entries?from=2026-10-12&to=2026-10-12", { cookie: s.memberCookie })).json();
    expect(entries[0].invoice).toMatchObject({ number: "0001" });

    const second = await (await create(s.adminCookie, { clientId: s.client.id })).json();
    const { invoice: next } = await (await request(`/api/invoices/${second.invoice.id}`, { cookie: s.adminCookie })).json();
    expect(next.number).toBe("0002");
    expect(next.lines.map((l: { description: string; quantity: number }) => [l.description, l.quantity])).toEqual([["Brand", 1000]]); // only November's hour
  });

  it("charges each time line its quantity times its rate, matching the preview, and keeps amounts when a line is renamed", async () => {
    await createOrgWithUser("Tiny", "admin@tiny.test", "admin-password-1", "admin");
    const cookie = (await signIn("admin@tiny.test", "admin-password-1")).cookie;
    const post = async (path: string, body: Record<string, unknown>) => (await request(path, { body, cookie })).json();
    const client = (await post("/api/clients", { name: "QA" })).client;
    const project = (await post("/api/projects", { name: "QA Website", clientId: client.id, hourlyRate: 12500 })).project;
    await post("/api/time-entries", { projectId: project.id, date: "2026-10-16", seconds: 2 }); // a 2-second timer

    // 2 seconds is 0.001 h on the invoice, and the line charges what it says: 0.001 × $125 = $0.125,
    // so 13 cents (QA-37), in the ready-to-invoice list and on the invoice alike.
    const { clients } = await (await request("/api/invoices/unbilled", { cookie })).json();
    expect(clients[0].amount).toBe(13);
    const id = (await (await create(cookie, { clientId: client.id })).json()).invoice.id;
    const lineOf = async () => (await (await request(`/api/invoices/${id}`, { cookie })).json()).invoice.lines[0];
    expect(await lineOf()).toMatchObject({ quantity: 1, unitPrice: 12500, amount: 13 }); // shown as 0.001 h

    // Saving the line unchanged, or renaming it, keeps the invoiced amount.
    const line = await lineOf();
    await request(`/api/invoices/${id}/lines/${line.id}`, { method: "PATCH", body: { description: "Website QA", quantity: 1, unitPrice: 12500 }, cookie });
    expect(await lineOf()).toMatchObject({ description: "Website QA", amount: 13 });

    // Changing the quantity or rate reprices the line from what was typed.
    await request(`/api/invoices/${id}/lines/${line.id}`, { method: "PATCH", body: { quantity: 1000 }, cookie });
    expect(await lineOf()).toMatchObject({ quantity: 1000, amount: 12500 });
  });

  it("groups lines by person, task or entry when asked, and can leave expenses off", async () => {
    const s = await studio();
    const id = (await (await create(s.adminCookie, { clientId: s.client.id, to: "2026-10-31", groupBy: "entry", includeExpenses: false })).json()).invoice.id;
    const { invoice } = await (await request(`/api/invoices/${id}`, { cookie: s.adminCookie })).json();
    expect(invoice.lines).toHaveLength(4);
    expect(invoice.lines[0].description).toBe("2026-10-12 · Brand");
    expect(await prisma.expense.count({ where: { invoiceLineId: null } })).toBe(1);
  });

  it("edits drafts, adds custom lines, and releases time when lines or drafts go", async () => {
    const s = await studio();
    const id = (await (await create(s.adminCookie, { clientId: s.client.id, to: "2026-10-31" })).json()).invoice.id;
    const custom = await request(`/api/invoices/${id}/lines`, { body: { description: "Discount", quantity: 1000, unitPrice: -5000 }, cookie: s.adminCookie });
    expect((await custom.json()).line).toMatchObject({ kind: "custom", amount: -5000 });

    const { invoice } = await (await request(`/api/invoices/${id}`, { cookie: s.adminCookie })).json();
    const brandLine = invoice.lines.find((l: { description: string }) => l.description === "Brand");
    const changed = await request(`/api/invoices/${id}/lines/${brandLine.id}`, { method: "PATCH", body: { quantity: 2500 }, cookie: s.adminCookie });
    expect((await changed.json()).line.amount).toBe(25000);

    expect((await request(`/api/invoices/${id}/lines/${brandLine.id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(200);
    expect((await request(`/api/time-entries/${s.e1.id}`, { method: "PATCH", body: { seconds: 60 }, cookie: s.memberCookie })).status).toBe(200);

    const edit = await request(`/api/invoices/${id}`, { method: "PATCH", body: { number: "INV-7", taxPercent: 8.25, dueDate: "2026-12-01" }, cookie: s.adminCookie });
    expect((await edit.json()).invoice).toMatchObject({ number: "INV-7", taxBasisPoints: 825, dueDate: "2026-12-01" });
    expect((await request(`/api/invoices/${id}`, { method: "PATCH", body: { taxPercent: 120 }, cookie: s.adminCookie })).status).toBe(400);

    expect((await request(`/api/invoices/${id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(200);
    expect(await prisma.timeEntry.count({ where: { invoiceLineId: { not: null } } })).toBe(0);
    expect(await prisma.expense.count({ where: { invoiceLineId: { not: null } } })).toBe(0);
  });

  it("locks sent and paid invoices until they're back in draft", async () => {
    const s = await studio();
    const id = (await (await create(s.adminCookie, { clientId: s.client.id })).json()).invoice.id;
    const sent = (await (await request(`/api/invoices/${id}`, { method: "PATCH", body: { status: "sent" }, cookie: s.adminCookie })).json()).invoice;
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
    expect((await request(`/api/invoices/${id}`, { method: "PATCH", body: { notes: "x" }, cookie: s.adminCookie })).status).toBe(409);
    expect((await request(`/api/invoices/${id}/lines`, { body: { description: "x", quantity: 1000, unitPrice: 1 }, cookie: s.adminCookie })).status).toBe(409);
    expect((await request(`/api/invoices/${id}`, { method: "DELETE", cookie: s.adminCookie })).status).toBe(409);
    const paid = (await (await request(`/api/invoices/${id}`, { method: "PATCH", body: { status: "paid" }, cookie: s.adminCookie })).json()).invoice;
    expect(paid.paidAt).not.toBeNull();
    expect((await (await request("/api/invoices", { cookie: s.adminCookie })).json()).invoices[0]).toMatchObject({ status: "paid", total: 54500 });
  });

  it("is for admins and managers only", async () => {
    const s = await studio();
    expect((await request("/api/invoices", { cookie: s.memberCookie })).status).toBe(403);
    expect((await create(s.memberCookie, { clientId: s.client.id })).status).toBe(403);
  });

  it("checks what it's given", async () => {
    const s = await studio();
    expect((await create(s.adminCookie, { clientId: "nope" })).status).toBe(400);
    expect((await create(s.adminCookie, { clientId: s.client.id, dueDate: "2026-10-01" })).status).toBe(400);
    expect((await create(s.adminCookie, { clientId: s.client.id, taxPercent: "lots" })).status).toBe(400);
    expect((await create(s.adminCookie, { clientId: s.client.id, from: "soon" })).status).toBe(400);
  });
});

describe("organization isolation for invoices", () => {
  it("never shows, bills or changes another organization's work", async () => {
    const s = await studio();
    const id = (await (await create(s.adminCookie, { clientId: s.client.id })).json()).invoice.id;
    await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const b = (await signIn("b@b.test", "admin-password-1")).cookie;
    expect((await (await request("/api/invoices", { cookie: b })).json()).invoices).toEqual([]);
    expect((await (await request("/api/invoices/unbilled", { cookie: b })).json()).clients).toEqual([]);
    expect((await create(b, { clientId: s.client.id })).status).toBe(400);
    expect((await request(`/api/invoices/${id}`, { cookie: b })).status).toBe(404);
    expect((await request(`/api/invoices/${id}`, { method: "PATCH", body: { status: "paid" }, cookie: b })).status).toBe(404);
    expect((await request(`/api/invoices/${id}`, { method: "DELETE", cookie: b })).status).toBe(404);
    expect((await request(`/api/invoices/${id}/lines`, { body: { description: "x", quantity: 1, unitPrice: 1 }, cookie: b })).status).toBe(404);
    // Invoice numbers are per organization.
    const bClient = (await (await request("/api/clients", { body: { name: "B client" }, cookie: b })).json()).client;
    const bInvoice = (await (await create(b, { clientId: bClient.id })).json()).invoice.id;
    expect((await (await request(`/api/invoices/${bInvoice}`, { cookie: b })).json()).invoice.number).toBe("0001");
  });
});

describe("a new invoice's preview (WRK-116)", () => {
  it("shows exactly the lines the invoice gets, without making it or taking a number", async () => {
    const s = await studio();
    const query = `clientId=${s.client.id}&from=2026-10-01&to=2026-10-31&groupBy=project`;
    const res = await request(`/api/invoices/preview?${query}`, { cookie: s.adminCookie });
    expect(res.status).toBe(200);
    const preview = await res.json();
    expect(preview.number).toBe("0001");
    expect(preview.seconds).toBe(5400 + 1800 + 3600 + 3600);
    expect(preview.from).toMatchObject({ name: "Studio" });
    // Asking twice takes nothing: no invoice, no number, nothing marked as billed.
    await request(`/api/invoices/preview?${query}`, { cookie: s.adminCookie });
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.timeEntry.count({ where: { invoiceLineId: { not: null } } })).toBe(0);

    const made = await (await create(s.adminCookie, { clientId: s.client.id, from: "2026-10-01", to: "2026-10-31", groupBy: "project" })).json();
    const { invoice } = await (await request(`/api/invoices/${made.invoice.id}`, { cookie: s.adminCookie })).json();
    expect(invoice.number).toBe(preview.number);
    const shape = (l: { kind: string; description: string; quantity: number; unitPrice: number; amount: number }) =>
      ({ kind: l.kind, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount });
    expect(invoice.lines.map(shape)).toEqual(preview.lines.map(shape));
    expect(preview.lines.map((l: { kind: string }) => l.kind)).toContain("expense");
  });

  it("leaves expenses out when asked, and checks the client and period", async () => {
    const s = await studio();
    const lines = async (q: string) => (await (await request(`/api/invoices/preview?clientId=${s.client.id}&${q}`, { cookie: s.adminCookie })).json()).lines;
    expect((await lines("includeExpenses=false")).every((l: { kind: string }) => l.kind === "time")).toBe(true);
    expect((await request("/api/invoices/preview", { cookie: s.adminCookie })).status).toBe(400);
    expect((await request(`/api/invoices/preview?clientId=${s.client.id}&from=October`, { cookie: s.adminCookie })).status).toBe(400);
    expect((await request(`/api/invoices/preview?clientId=${s.client.id}`, { cookie: s.memberCookie })).status).toBe(403);
    // Another organization's client is unknown here.
    await createOrgWithUser("Elsewhere", "else@else.test", "else-password-1", "admin");
    const other = (await signIn("else@else.test", "else-password-1")).cookie;
    expect((await request(`/api/invoices/preview?clientId=${s.client.id}`, { cookie: other })).status).toBe(400);
  });
});

describe("PO number and subject (WRK-116)", () => {
  it("are set when making an invoice, changed on a draft, recorded, and go in the email", async () => {
    const s = await studio();
    expect((await create(s.adminCookie, { clientId: s.client.id, poNumber: "x".repeat(51) })).status).toBe(400);
    expect((await create(s.adminCookie, { clientId: s.client.id, subject: "x".repeat(201) })).status).toBe(400);
    const made = await (await create(s.adminCookie, { clientId: s.client.id, poNumber: " PO-77 ", subject: "Brand refresh" })).json();
    const id = made.invoice.id;
    const read = async () => (await (await request(`/api/invoices/${id}`, { cookie: s.adminCookie })).json()).invoice;
    expect(await read()).toMatchObject({ poNumber: "PO-77", subject: "Brand refresh" });

    const patched = await request(`/api/invoices/${id}`, { method: "PATCH", body: { poNumber: "PO-78", subject: "" }, cookie: s.adminCookie });
    expect(patched.status).toBe(200);
    expect(await read()).toMatchObject({ poNumber: "PO-78", subject: "" });
    const changes = (await prisma.auditEvent.findFirstOrThrow({ where: { kind: "invoice", action: "changed" } })).changes;
    expect(changes).toEqual([{ field: "poNumber", from: "PO-77", to: "PO-78" }, { field: "subject", from: "Brand refresh", to: "" }]);

    await request(`/api/invoices/${id}`, { method: "PATCH", body: { status: "sent" }, cookie: s.adminCookie });
    expect((await request(`/api/invoices/${id}`, { method: "PATCH", body: { poNumber: "PO-79" }, cookie: s.adminCookie })).status).toBe(409);
  });
});

describe("invoice line arithmetic (QA-37)", () => {
  it("every time line's amount is its quantity times its rate, to the cent", async () => {
    await createOrgWithUser("Odd", "admin@odd.test", "admin-password-1", "admin");
    const cookie = (await signIn("admin@odd.test", "admin-password-1")).cookie;
    const post = async (path: string, body: Record<string, unknown>) => (await request(path, { body, cookie })).json();
    const client = (await post("/api/clients", { name: "Odd seconds" })).client;
    const project = (await post("/api/projects", { name: "Site", clientId: client.id, hourlyRate: 8000 })).project;
    // 1:30:18 is 1.505 h; 0:45:07 is 0.752 h; 2:59:59 is 3.000 h.
    for (const seconds of [5418, 2707, 10799]) await post("/api/time-entries", { projectId: project.id, date: "2026-10-16", seconds });
    const made = await (await create(cookie, { clientId: client.id, groupBy: "entry" })).json();
    const { invoice } = await (await request(`/api/invoices/${made.invoice.id}`, { cookie })).json();
    const lines = invoice.lines as { quantity: number; unitPrice: number; amount: number }[];
    expect(lines.map((l) => l.quantity).sort((a, b) => a - b)).toEqual([752, 1505, 3000]);
    for (const l of lines) expect(l.amount).toBe(Math.round((l.quantity * l.unitPrice) / 1000));
    expect(lines.find((l) => l.quantity === 1505)!.amount).toBe(12040); // 1.505 × $80.00 = $120.40
    expect(invoice.subtotal).toBe(lines.reduce((sum, l) => sum + l.amount, 0));
  });
});
