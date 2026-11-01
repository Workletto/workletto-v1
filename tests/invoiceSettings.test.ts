import { beforeEach, describe, expect, it } from "vitest";
import { formatMoney } from "../src/shared/money.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);

async function studio() {
  const { organization } = await createOrgWithUser("Studio North", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  await addUser(organization.id, "member@studio.test", "member-password-1", "member");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const client = (await (await request("/api/clients", { body: { name: "Northwind" }, cookie: admin })).json()).client as { id: string };
  return { organization, admin, manager, member, client };
}

const DEFAULTS = { prefix: "", nextNumber: "0001", dueDays: 30, taxPercent: "", taxLabel: "", notes: "" };
const save = (cookie: string, body: Record<string, unknown>) => request("/api/settings/invoices", { method: "PUT", body: { ...DEFAULTS, ...body }, cookie });
const settings = async (cookie: string) => (await request("/api/settings/invoices", { cookie })).json();
async function create(cookie: string, clientId: string, body: Record<string, unknown> = {}) {
  const res = await request("/api/invoices", { body: { clientId, issueDate: "2026-11-01", ...body }, cookie });
  expect(res.status).toBe(201);
  const { invoice } = await (await request(`/api/invoices/${(await res.json()).invoice.id}`, { cookie })).json();
  return invoice;
}

describe("invoice settings", () => {
  it("start with four-digit numbers from 0001, net 30 and no tax; managers can read them, only admins change them", async () => {
    const s = await studio();
    expect(await settings(s.admin)).toEqual({
      settings: { prefix: "", nextNumber: "0001", dueDays: 30, taxBasisPoints: 0, taxLabel: "Tax", notes: "", reminderDays: 0 },
      next: "0001",
    });
    expect((await request("/api/settings/invoices", { cookie: s.manager })).status).toBe(200);
    expect((await request("/api/settings/invoices", { cookie: s.member })).status).toBe(403);
    expect((await save(s.manager, { prefix: "M-" })).status).toBe(403);
    expect((await save(s.member, { prefix: "M-" })).status).toBe(403);
  });

  it("number new invoices and fill in their due date, tax and notes; each invoice can differ", async () => {
    const s = await studio();
    const res = await save(s.admin, { prefix: "WL-", nextNumber: "0042", dueDays: 14, taxPercent: "20", taxLabel: "VAT", notes: "Bank: 12-34-56" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { prefix: "WL-", nextNumber: "0042", dueDays: 14, taxBasisPoints: 2000, taxLabel: "VAT", notes: "Bank: 12-34-56", reminderDays: 0 },
      next: "WL-0042",
    });

    // Nothing but the client and issue date: the rest comes from the settings.
    const first = await create(s.manager, s.client.id);
    expect(first).toMatchObject({ number: "WL-0042", issueDate: "2026-11-01", dueDate: "2026-11-15", taxBasisPoints: 2000, taxLabel: "VAT", notes: "Bank: 12-34-56" });

    // What the new-invoice form sends wins.
    const second = await create(s.manager, s.client.id, { dueDate: "2026-12-01", taxPercent: "0", taxLabel: "GST", notes: "Thanks!" });
    expect(second).toMatchObject({ number: "WL-0043", dueDate: "2026-12-01", taxBasisPoints: 0, taxLabel: "GST", notes: "Thanks!" });
    expect((await settings(s.admin)).settings.nextNumber).toBe("0044");

    // Changing the settings leaves existing invoices alone.
    await save(s.admin, { prefix: "WL-", nextNumber: "0044", taxPercent: "5" });
    expect((await (await request(`/api/invoices/${first.id}`, { cookie: s.admin })).json()).invoice).toMatchObject({ number: "WL-0042", taxBasisPoints: 2000, taxLabel: "VAT" });

    // Due on receipt, a new prefix, and no zero padding.
    await save(s.admin, { prefix: "2027/", nextNumber: "7", dueDays: 0 });
    expect(await create(s.admin, s.client.id)).toMatchObject({ number: "2027/7", dueDate: "2026-11-01", taxLabel: "Tax" });
    expect((await create(s.admin, s.client.id)).number).toBe("2027/8");
    // Past 9999 a number just grows.
    await save(s.admin, { nextNumber: "9999" });
    expect((await create(s.admin, s.client.id)).number).toBe("9999");
    expect((await create(s.admin, s.client.id)).number).toBe("10000");
  });

  it("never give two invoices the same number", async () => {
    const s = await studio();
    for (const n of ["0001", "0002", "0003"]) expect((await create(s.admin, s.client.id)).number).toBe(n);

    // Going back to a number that's taken skips ahead to the first free one.
    expect((await (await save(s.admin, { nextNumber: "0002" })).json()).next).toBe("0004");
    expect((await settings(s.admin)).settings.nextNumber).toBe("0002");
    expect((await create(s.admin, s.client.id)).number).toBe("0004");

    // A number typed on a draft is skipped too.
    const draft = await create(s.admin, s.client.id);
    expect(draft.number).toBe("0005");
    expect((await request(`/api/invoices/${draft.id}`, { method: "PATCH", body: { number: "0007" }, cookie: s.admin })).status).toBe(200);
    expect((await create(s.admin, s.client.id)).number).toBe("0006");
    expect((await settings(s.admin)).next).toBe("0008");
    expect((await create(s.admin, s.client.id)).number).toBe("0008");

    // Deleting a draft doesn't hand its number out again.
    const last = await create(s.admin, s.client.id);
    expect((await request(`/api/invoices/${last.id}`, { method: "DELETE", cookie: s.admin })).status).toBe(200);
    expect((await create(s.admin, s.client.id)).number).toBe("0010");

    // Invoices made at the same moment get numbers in a row.
    const made = await Promise.all(Array.from({ length: 5 }, () => request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-11-01" }, cookie: s.admin })));
    // Any refusal shows its message, so a failure here says why.
    expect(await Promise.all(made.map(async (r) => (r.status === 201 ? 201 : `${r.status} ${await r.text()}`)))).toEqual([201, 201, 201, 201, 201]);
    const { invoices } = await (await request("/api/invoices", { cookie: s.admin })).json();
    const numbers = invoices.map((i: { number: string }) => i.number).sort();
    expect(numbers.slice(-5)).toEqual(["0011", "0012", "0013", "0014", "0015"]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("check what they're given", async () => {
    const s = await studio();
    for (const body of [
      { prefix: "x".repeat(21) },
      { prefix: "A\nB" },
      { nextNumber: "abc" },
      { nextNumber: "0" },
      { nextNumber: "1234567890" },
      { nextNumber: null },
      { dueDays: 366 },
      { dueDays: -1 },
      { dueDays: "30" },
      { taxPercent: "101" },
      { taxPercent: "8.255" },
      { taxLabel: "x".repeat(21) },
      { notes: "x".repeat(2001) },
    ]) {
      expect((await save(s.admin, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await settings(s.admin)).settings).toMatchObject({ prefix: "", nextNumber: "0001" });
    // Spaces around the prefix and tax name are dropped; an empty tax name is "Tax".
    expect((await (await save(s.admin, { prefix: "  INV-  ", taxLabel: "   " })).json()).settings).toMatchObject({ prefix: "INV-", taxLabel: "Tax" });
  });

  it("belong to one organization", async () => {
    const s = await studio();
    await save(s.admin, { prefix: "WL-", nextNumber: "0500", taxPercent: "20" });
    await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const b = (await signIn("b@b.test", "admin-password-1")).cookie;
    expect((await settings(b)).settings).toMatchObject({ prefix: "", nextNumber: "0001", taxBasisPoints: 0 });
    const bClient = (await (await request("/api/clients", { body: { name: "B client" }, cookie: b })).json()).client;
    expect((await create(b, bClient.id)).number).toBe("0001");
    expect((await create(s.admin, s.client.id)).number).toBe("WL-0500");
    // Org B's invoices never block Org A's numbers, nor the other way round.
    await save(b, { prefix: "WL-", nextNumber: "0500" });
    expect((await create(b, bClient.id)).number).toBe("WL-0500");
  });
});

describe("discounts", () => {
  // One line of $333.33, so percentages have to round.
  async function invoiceOf333(s: Awaited<ReturnType<typeof studio>>, body: Record<string, unknown> = {}) {
    const invoice = await create(s.admin, s.client.id, body);
    expect((await request(`/api/invoices/${invoice.id}/lines`, { body: { description: "Design", quantity: 1000, unitPrice: 33333 }, cookie: s.admin })).status).toBe(201);
    return (await (await request(`/api/invoices/${invoice.id}`, { cookie: s.admin })).json()).invoice;
  }
  const patch = (s: Awaited<ReturnType<typeof studio>>, id: string, body: Record<string, unknown>) => request(`/api/invoices/${id}`, { method: "PATCH", body, cookie: s.admin });

  it("come off the subtotal before tax, rounded to the cent", async () => {
    const s = await studio();
    // 12.5% of 333.33 is 41.66625 → 41.67. Tax is on 291.66: 20% is 58.332 → 58.33.
    const invoice = await invoiceOf333(s, { discountPercent: "12.5", taxPercent: "20", taxLabel: "VAT" });
    expect(invoice).toMatchObject({ discountBasisPoints: 1250, discountAmount: 0, subtotal: 33333, discount: 4167, tax: 5833, total: 34999 });

    // An amount instead: 50.00 off, tax on 283.33 is 56.666 → 56.67.
    const amount = (await (await patch(s, invoice.id, { discountAmount: 5000 })).json()).invoice;
    expect(amount).toMatchObject({ discountBasisPoints: 0, discountAmount: 5000, discount: 5000, tax: 5667, total: 34000 });

    // Never more than the subtotal.
    expect((await (await patch(s, invoice.id, { discountAmount: 50000 })).json()).invoice).toMatchObject({ discount: 33333, tax: 0, total: 0 });
    // Removed.
    expect((await (await patch(s, invoice.id, { discountPercent: "" })).json()).invoice).toMatchObject({ discount: 0, tax: 6667, total: 40000 });

    // The list's totals include the discount.
    await patch(s, invoice.id, { discountPercent: "10" });
    const { invoices } = await (await request("/api/invoices", { cookie: s.admin })).json();
    expect(invoices.find((i: { id: string }) => i.id === invoice.id)).toMatchObject({ discount: 3333, tax: 6000, total: 36000 });
  });

  it("are a percentage or an amount, on drafts only", async () => {
    const s = await studio();
    expect((await request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-11-01", discountPercent: "10", discountAmount: 500 }, cookie: s.admin })).status).toBe(400);
    expect((await request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-11-01", discountPercent: "110" }, cookie: s.admin })).status).toBe(400);
    expect((await request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-11-01", discountAmount: -500 }, cookie: s.admin })).status).toBe(400);
    expect((await request("/api/invoices", { body: { clientId: s.client.id, issueDate: "2026-11-01", discountAmount: 12.5 }, cookie: s.admin })).status).toBe(400);
    const invoice = await invoiceOf333(s, { discountAmount: 1000 });
    expect(invoice).toMatchObject({ discount: 1000, total: 32333 });
    expect((await patch(s, invoice.id, { status: "sent" })).status).toBe(200);
    expect((await patch(s, invoice.id, { discountPercent: "50" })).status).toBe(409);
    expect((await patch(s, invoice.id, { taxLabel: "VAT" })).status).toBe(409);
  });

  it("show in the emailed invoice, with the tax's own name", async () => {
    const s = await studio();
    await request(`/api/clients/${s.client.id}`, { method: "PATCH", body: { email: "ap@northwind.test" }, cookie: s.admin });
    const server = await startFakeSmtp();
    try {
      const smtp = { provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: server.port, smtpSecure: false, smtpUser: "" };
      expect((await request("/api/settings/email", { method: "PUT", body: smtp, cookie: s.admin })).status).toBe(200);
      const invoice = await invoiceOf333(s, { discountPercent: "10", taxPercent: "20", taxLabel: "VAT" });
      expect((await request(`/api/invoices/${invoice.id}/email`, { body: {}, cookie: s.admin })).status).toBe(200);
      const body = server.received[0]!.body.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
      expect(body).toContain(`Discount (10%): ${formatMoney(-3333, "USD")}`);
      expect(body).toContain(`VAT (20%): ${formatMoney(6000, "USD")}`);
      expect(body).toContain(`Total: ${formatMoney(36000, "USD")}`);
    } finally {
      await server.close();
    }
  });
});
