// Invoice numbers: a prefix and a counter, zero-padded. The server and the
// Invoice settings screen's preview both use this.

/** "INV-", 42 and 4 digits → "INV-0042". Numbers longer than `digits` are never cut. */
export const formatInvoiceNumber = (prefix: string, n: number, digits: number) => `${prefix}${String(n).padStart(digits, "0")}`;

/** The next number as typed ("0042"): its value and how many digits to pad to, or null if it isn't 1 to 9 digits above zero. */
export function readNextNumber(text: string): { n: number; digits: number } | null {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t) || Number(t) < 1) return null;
  return { n: Number(t), digits: t.length };
}
