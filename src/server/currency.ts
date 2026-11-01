import type { OrgDb } from "./db.ts";
import { isCurrency } from "../shared/money.ts";

// Currencies (WRK-135). The organization's currency is the home currency: people's rates and
// costs, projects without a client and new clients use it. A client can be billed in another
// currency; then its projects' rates, fees and budgets, its expenses, invoices and payments are
// all in that currency, and nothing about them is ever converted. Only reports add amounts in
// different currencies together, converting to the home currency at the organization's
// exchange rates (organization.exchangeRates: millionths of the home currency per unit).

export type Rates = Record<string, number>;

/** The largest rate accepted: one unit worth a million of the home currency. */
const MAX_RATE_MICROS = 1_000_000 * 1_000_000;

/** A rate as typed ("1.08", "0.0065", 1.08) in millionths, or null if it isn't a positive number with up to six decimals. */
export function readRate(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(",", ".") : "";
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return micros > 0 && micros <= MAX_RATE_MICROS ? micros : null;
}

/** The rates saved for an organization, keeping only well-formed entries. */
export function ratesOf(value: unknown): Rates {
  const rates: Rates = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return rates;
  for (const [code, micros] of Object.entries(value)) if (isCurrency(code) && Number.isInteger(micros) && (micros as number) > 0) rates[code] = micros as number;
  return rates;
}

/** The home currency and the exchange rates. */
export async function currencies(db: OrgDb) {
  const org = await db.organization.findFirstOrThrow({ select: { currency: true, exchangeRates: true } });
  return { home: org.currency, rates: ratesOf(org.exchangeRates) };
}

/**
 * Converts an amount (in hundredths, fractions allowed) to the home currency, for reports. An
 * amount in a currency without a rate counts as nothing; a client can't use a currency until it
 * has one, so that only happens if the data was changed by hand.
 */
export function toHome({ home, rates }: { home: string; rates: Rates }) {
  return (amount: number, currency: string) => (currency === home ? amount : rates[currency] ? (amount * rates[currency]) / 1_000_000 : 0);
}

/** The currency a project's money is in: its client's, or the home currency without a client. */
export const currencyOf = (project: { client: { currency: string } | null }, home: string) => project.client?.currency ?? home;
