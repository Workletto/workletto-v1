// Money is always stored as whole hundredths ("cents") of its own currency: the organization's, or a client's (WRK-135).

export const CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK",
  "PLN", "CZK", "JPY", "SGD", "HKD", "INR", "ZAR", "BRL", "MXN", "AED",
] as const;

export const isCurrency = (value: unknown): value is string => CURRENCIES.includes(value as (typeof CURRENCIES)[number]);

/** 123456 → "$1,234.56" in the reader's language. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

/** An invoice line's quantity (stored in thousandths): 2500 → "2.5". */
export const formatQuantity = (q: number) => (q / 1000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/**
 * What someone typed as an amount, in cents; null if the box is empty, NaN if it can't be read for certain.
 * Both 1,250.50 and 1.250,50 work: a comma or point with one or two digits after it is the
 * decimal mark (12,5 is 12.50), and groups of three digits are thousands (1,500 is 1500).
 * One point with three digits after it (1.500) could mean 1.5 or 1500, so it's refused, not guessed.
 * Spaces, apostrophes (1'250.50) and a currency sign or code before or after are ignored.
 */
export function parseMoney(text: string): number | null {
  if (!text.trim()) return null;
  const t = text.trim().replace(/[\s\u00a0\u202f']/g, "").replace(/^[^\d.,-]+/, "").replace(/[^\d.,]+$/, "");
  let whole = t;
  let fraction = "";
  const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (last >= 0 && t.length - last - 1 <= 2) {
    whole = t.slice(0, last);
    fraction = t.slice(last + 1);
    // The decimal mark can't also separate thousands: 1,234,56 is a typo.
    if (whole.includes(t[last]!)) return Number.NaN;
  } else if (last >= 0 && t[last] === "." && t.indexOf(".") === last && !t.includes(",")) {
    return Number.NaN;
  }
  // Before the decimals: plain digits, or groups of three split by one kind of mark.
  if (!/^(\d*|\d{1,3}(?:([.,])\d{3}(?:\2\d{3})*)?)$/.test(whole)) return Number.NaN;
  const digits = whole.replace(/[.,]/g, "");
  if ((!digits && !fraction) || digits.length > 9) return Number.NaN;
  return Number(digits || "0") * 100 + Number(`${fraction}00`.slice(0, 2));
}

/** Cents as plain text for an input box: 9550 → "95.50". */
export const moneyInput = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

/** Whole cents, from 0 up to 100 million in the currency. */
/** The largest amount the database holds in one place (21,474,836.47 in a two-decimal currency). */
export const MAX_CENTS = 2_147_483_647;
export const isCents = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_CENTS;

/** Amounts in several currencies, never added across them: "€1,200.00 and $450.00". */
export function moneyByCurrency(items: { amount: number; currency: string }[]) {
  const sums = new Map<string, number>();
  for (const { amount, currency } of items) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  const parts = [...sums].filter(([, sum]) => sum).map(([currency, sum]) => formatMoney(sum, currency));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}
