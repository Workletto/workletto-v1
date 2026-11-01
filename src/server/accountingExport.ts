import { invoiceTotals } from "../shared/invoiceMath.ts";

// Invoices as files QuickBooks Online and Xero import (WRK-137), instead of a live connection:
// each install has its own address, which their app registrations don't allow for, and a
// connector in the middle would see customers' accounting data. Formats as their help pages
// describe them (October 2026):
//   - Xero, "Import customer invoices": one row per invoice line, rows of one invoice share its
//     number; dates DD/MM/YYYY; amounts all tax-exclusive in one file; a TaxAmount column for
//     exact tax; AccountCode and TaxType must match the organisation's own, so they're left
//     for the person importing to fill in or set in Xero.
//   - QuickBooks Online, Import data → Invoices: one row per line, invoice number, customer and
//     dates repeated; columns are matched during import, where the date format is chosen.
// Amounts are never converted: each invoice is in its own currency. The rows of an invoice add
// up to exactly what the client was billed: a discount is a line of its own, and the tax is
// shared out over the lines to the cent.

export type ExportInvoice = {
  number: string; issueDate: string; dueDate: string; currency: string; poNumber: string; subject: string;
  taxBasisPoints: number; taxLabel: string; discountBasisPoints: number; discountAmount: number;
  client: { name: string; email: string; address: string };
  lines: { description: string; quantity: number; unitPrice: number; amount: number }[];
};

type Row = { description: string; quantity: number; unitPrice: number; amount: number; tax: number };

/** An invoice's rows: its lines, then the discount as a line, each with its share of the tax. */
export function exportRows(invoice: ExportInvoice): Row[] {
  const { discount, tax } = invoiceTotals(invoice.lines.map((l) => l.amount), invoice);
  const rows = invoice.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, tax: 0 }));
  if (discount) rows.push({ description: invoice.discountBasisPoints ? `Discount (${invoice.discountBasisPoints / 100}%)` : "Discount", quantity: 1000, unitPrice: -discount, amount: -discount, tax: 0 });
  // The tax, shared out in proportion to each row's amount: running totals rounded, so the
  // shares add up to exactly the invoice's tax.
  const base = rows.reduce((sum, r) => sum + r.amount, 0);
  if (tax && base) {
    let running = 0;
    let given = 0;
    for (const r of rows) {
      running += r.amount;
      const upTo = Math.round((running * tax) / base);
      r.tax = upTo - given;
      given = upTo;
    }
  }
  return rows;
}

const money = (cents: number) => Number((cents / 100).toFixed(2));
const quantity = (thousandths: number) => Number((thousandths / 1000).toFixed(3));
const ddmmyyyy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const mmddyyyy = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
/** The client's address as up to four lines (the last one keeps whatever is left). */
function addressLines(address: string) {
  const lines = address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [lines[0] ?? "", lines[1] ?? "", lines[2] ?? "", lines.slice(3).join(", ")];
}

export const XERO_HEADERS = [
  "*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry",
  "*InvoiceNumber", "Reference", "*InvoiceDate", "*DueDate", "InventoryItemCode", "*Description", "*Quantity", "*UnitAmount", "Discount",
  "*AccountCode", "*TaxType", "TaxAmount", "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency", "BrandingTheme",
];

export function xeroCsvRows(invoices: ExportInvoice[]) {
  return invoices.flatMap((inv) =>
    exportRows(inv).map((r) => [
      inv.client.name, inv.client.email, ...addressLines(inv.client.address), "", "", "", "",
      inv.number, inv.poNumber || inv.subject, ddmmyyyy(inv.issueDate), ddmmyyyy(inv.dueDate), "", r.description, quantity(r.quantity), money(r.unitPrice), "",
      "", "", money(r.tax), "", "", "", "", inv.currency, "",
    ]),
  );
}

export const QUICKBOOKS_HEADERS = [
  "*InvoiceNo", "*Customer", "*InvoiceDate", "*DueDate", "Terms", "Location", "Memo", "Item(Product/Service)", "ItemDescription",
  "ItemQuantity", "ItemRate", "*ItemAmount", "*ItemTaxCode", "ItemTaxAmount", "Currency", "Service Date",
];

export function quickbooksCsvRows(invoices: ExportInvoice[]) {
  return invoices.flatMap((inv) =>
    exportRows(inv).map((r) => [
      inv.number, inv.client.name, mmddyyyy(inv.issueDate), mmddyyyy(inv.dueDate), "", "", [inv.poNumber && `PO ${inv.poNumber}`, inv.subject].filter(Boolean).join(" · "), "", r.description,
      quantity(r.quantity), money(r.unitPrice), money(r.amount), "", money(r.tax), inv.currency, "",
    ]),
  );
}
