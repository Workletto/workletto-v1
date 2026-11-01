// An invoice's money, the same on the server and on the screen that previews a new invoice.
// Every amount is in cents; quantities are in thousandths (1.5 hours is 1500).

export const lineAmount = (quantity: number, unitPrice: number) => Math.round((quantity * unitPrice) / 1000);

/** The text of a line billing part of a fixed fee project's fee (WRK-134). */
/** A fee line's description: "Brand refresh – fixed fee", or with its phase (WRK-151) "Library – Schematic Design – fixed fee". */
export const feeLineDescription = (projectName: string, phase?: string | null) => `${projectName}${phase ? ` – ${phase}` : ""} – fixed fee`;
export const taxOf = (subtotal: number, basisPoints: number) => Math.round((subtotal * basisPoints) / 10000);

/** A discount on the subtotal: a percentage of it, or an amount. Never more than the subtotal, nor below zero. */
export function discountOf(subtotal: number, basisPoints: number, amount: number) {
  const base = Math.max(subtotal, 0);
  return basisPoints ? Math.round((base * basisPoints) / 10000) : Math.min(amount, base);
}

/** Subtotal, less the discount, plus tax on what's left. */
export function invoiceTotals(lineAmounts: number[], { discountBasisPoints, discountAmount, taxBasisPoints }: { discountBasisPoints: number; discountAmount: number; taxBasisPoints: number }) {
  const subtotal = lineAmounts.reduce((sum, a) => sum + a, 0);
  const discount = discountOf(subtotal, discountBasisPoints, discountAmount);
  const tax = taxOf(subtotal - discount, taxBasisPoints);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

/** A percentage as typed ("8.25") in hundredths of a percent, or null if it isn't 0–100 with up to two decimals. Empty is 0. */
export function readPercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 0;
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  const bp = Math.round(n * 100);
  return Math.abs(bp - n * 100) < 1e-6 ? bp : null;
}
