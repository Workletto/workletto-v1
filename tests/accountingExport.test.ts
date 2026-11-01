import { beforeEach, describe, expect, it } from "vitest";
import { exportRows, quickbooksCsvRows, xeroCsvRows, type ExportInvoice } from "../src/server/accountingExport.ts";
import { invoiceTotals } from "../src/shared/invoiceMath.ts";
import { parseCsv } from "../src/shared/csv.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Invoices as QuickBooks Online and Xero import files (WRK-137): every invoice's rows add up to
// exactly what the client was billed.

const invoice = (over: Partial<ExportInvoice> = {}): ExportInvoice => ({
  number: "0007", issueDate: "2026-10-05", dueDate: "2026-11-04", currency: "EUR", poNumber: "PO-12", subject: "Rebrand",
  taxBasisPoints: 1900, taxLabel: "VAT", discountBasisPoints: 0, discountAmount: 0,
  client: { name: "Berlin GmbH", email: "ap@berlin.test", address: "Hauptstraße 1\n10115 Berlin\nGermany" },
  lines: [
    { description: "Design – 7.583 h", quantity: 7583, unitPrice: 12500, amount: 94788 },
    { description: "Rebrand – fixed fee", quantity: 1000, unitPrice: 400001, amount: 400001 },
    { description: "Travel", quantity: 1000, unitPrice: 3333, amount: 3333 },
  ],
  ...over,
});

const billed = (inv: ExportInvoice) => invoiceTotals(inv.lines.map((l) => l.amount), inv).total;
const exported = (inv: ExportInvoice) => exportRows(inv).reduce((sum, r) => sum + r.amount + r.tax, 0);

describe("an invoice's export rows", () => {
  it("add up to the billed total to the cent, with the tax shared out", () => {
    for (const over of [{}, { discountBasisPoints: 1250 }, { discountAmount: 9999 }, { taxBasisPoints: 0 }, { taxBasisPoints: 825, discountAmount: 1 }]) {
      const inv = invoice(over);
      expect(exported(inv), JSON.stringify(over)).toBe(billed(inv));
    }
    const rows = exportRows(invoice({ discountBasisPoints: 1000 }));
    expect(rows.at(-1)).toMatchObject({ description: "Discount (10%)", quantity: 1000, amount: -49812 });
    expect(rows.map((r) => r.tax).reduce((a, b) => a + b)).toBe(invoiceTotals(invoice().lines.map((l) => l.amount), invoice({ discountBasisPoints: 1000 })).tax);
  });

  it("are laid out the way Xero and QuickBooks import them", () => {
    const [first] = xeroCsvRows([invoice()]);
    expect(first).toEqual([
      "Berlin GmbH", "ap@berlin.test", "Hauptstraße 1", "10115 Berlin", "Germany", "", "", "", "", "",
      "0007", "PO-12", "05/10/2026", "04/11/2026", "", "Design – 7.583 h", 7.583, 125, "",
      "", "", expect.any(Number), "", "", "", "", "EUR", "",
    ]);
    const qb = quickbooksCsvRows([invoice()])[0]!;
    expect(qb.slice(0, 13)).toEqual(["0007", "Berlin GmbH", "10/05/2026", "11/04/2026", "", "", "PO PO-12 · Rebrand", "", "Design – 7.583 h", 7.583, 125, 947.88, ""]);
    expect(qb[14]).toBe("EUR");
  });
});

describe("the export download", () => {
  it("has sent and paid invoices issued in the period, never drafts, for admins and managers", async () => {
    const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
    await addUser(organization.id, "mo@studio.test", "member-password-1");
    const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
    const member = (await signIn("mo@studio.test", "member-password-1")).cookie;
    const client = (await (await request("/api/clients", { body: { name: "Acme" }, cookie: admin })).json()).client;
    const project = (await (await request("/api/projects", { body: { name: "Site", clientId: client.id, hourlyRate: 10_000 }, cookie: admin })).json()).project;
    const make = async (date: string) => {
      await request("/api/time-entries", { body: { projectId: project.id, date, seconds: 3600 }, cookie: admin });
      return (await (await request("/api/invoices", { body: { clientId: client.id, issueDate: date, to: date }, cookie: admin })).json()).invoice.id;
    };
    const sent = await make("2026-10-05");
    await request(`/api/invoices/${sent}`, { method: "PATCH", body: { status: "sent" }, cookie: admin });
    await make("2026-10-06"); // a draft

    const res = await request("/api/invoices/export/xero?from=2026-10-01&to=2026-10-31", { cookie: admin });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="invoices-xero-2026-10-01-to-2026-10-31.csv"');
    const rows = parseCsv(await res.text());
    expect(rows).toHaveLength(2);
    expect(rows[1]!.slice(10, 14)).toEqual(["0001", "", "05/10/2026", "04/11/2026"]);
    expect(rows[1]![16]).toBe("1");
    expect(rows[1]![17]).toBe("100");

    expect((await request("/api/invoices/export/quickbooks?from=2026-10-01&to=2026-10-31", { cookie: admin })).status).toBe(200);
    expect((await request("/api/invoices/export/sage?from=2026-10-01&to=2026-10-31", { cookie: admin })).status).toBe(404);
    expect((await request("/api/invoices/export/xero?from=2026-10-31&to=2026-10-01", { cookie: admin })).status).toBe(400);
    expect((await request("/api/invoices/export/xero?from=2026-10-01&to=2026-10-31", { cookie: member })).status).toBe(403);
  });
});

beforeEach(resetDatabase);
