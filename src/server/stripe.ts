import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe, with plain fetch (no SDK). Used only after an admin connects their own
// Stripe account in Manage → Payments, and only to api.stripe.com: creating
// Checkout Sessions, reading them back to confirm a payment, and registering
// one webhook. Nothing the browser or a webhook says is trusted on its own: a
// payment counts only once a Checkout Session read from Stripe says it's paid.

const API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2026-09-30.endive";
const TIMEOUT_MS = 15_000;

/** Currencies Stripe counts in whole units. The app keeps hundredths of every currency. */
const ZERO_DECIMAL = new Set(["JPY"]);
/** What to ask Stripe for, in its smallest unit; null when that can't be the exact total (a fraction of a yen). */
export function toStripeAmount(cents: number, currency: string): number | null {
  if (!ZERO_DECIMAL.has(currency.toUpperCase())) return cents;
  return cents % 100 === 0 ? cents / 100 : null;
}

export const STRIPE_KEY = /^(rk|sk)_(test|live)_[A-Za-z0-9]{10,}$/;
export const keyMode = (key: string) => (key.includes("_live_") ? "live" : "test");

export class StripeError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function call<T>(key: string, method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_VERSION,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StripeError("Stripe couldn't be reached. Check this server's internet connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) {
    if (res.status === 401) throw new StripeError("Stripe didn't accept this key. Copy it again from the Stripe Dashboard.", 401);
    if (res.status === 403) throw new StripeError("This key doesn't have the permission it needs. Give it Checkout Sessions: Write.", 403);
    throw new StripeError(data.error?.message ?? "Stripe returned an error. Try again.", res.status, data.error?.code);
  }
  return data;
}

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
};

/** Checks the key can work with Checkout Sessions. */
export async function testKey(key: string) {
  await call(key, "GET", "/checkout/sessions?limit=1");
}

export function createCheckout(key: string, p: { invoiceId: string; number: string; amount: number; currency: string; email?: string; successUrl: string; cancelUrl: string; expiresAt: Date }) {
  const form: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": p.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(p.amount),
    "line_items[0][price_data][product_data][name]": `Invoice ${p.number}`,
    client_reference_id: p.invoiceId,
    "metadata[invoice_id]": p.invoiceId,
    "payment_intent_data[metadata][invoice_id]": p.invoiceId,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    expires_at: String(Math.floor(p.expiresAt.getTime() / 1000)),
  };
  if (p.email) form.customer_email = p.email;
  return call<CheckoutSession>(key, "POST", "/checkout/sessions", form);
}

export const getCheckout = (key: string, id: string) => call<CheckoutSession>(key, "GET", `/checkout/sessions/${encodeURIComponent(id)}`);

/** Ends an open checkout, so it can't take a payment. Stripe refuses when it isn't open any more. */
export const expireCheckout = (key: string, id: string) => call<CheckoutSession>(key, "POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, {});

export const WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"];

export function registerWebhook(key: string, url: string) {
  const form: Record<string, string> = { url, api_version: STRIPE_VERSION, description: "Invoice payments" };
  WEBHOOK_EVENTS.forEach((event, i) => (form[`enabled_events[${i}]`] = event));
  return call<{ id: string; secret: string }>(key, "POST", "/webhook_endpoints", form);
}

export const deleteWebhook = (key: string, id: string) => call(key, "DELETE", `/webhook_endpoints/${encodeURIComponent(id)}`);

/** Where a registered webhook sends its notifications. */
export const getWebhook = (key: string, id: string) => call<{ id: string; url: string }>(key, "GET", `/webhook_endpoints/${encodeURIComponent(id)}`);

/**
 * The Checkout Session a webhook is about and the event's type, if its signature is right and
 * recent. A payment counts only once the session read back from Stripe says it's paid; the type
 * is used only to record a bank payment that failed, which the session doesn't show.
 */
export function verifyWebhook(rawBody: string, header: string | undefined, secret: string, now = Date.now()): { sessionId: string; type: string } | null {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length || Math.abs(now / 1000 - t) > 300) return null;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const valid = signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return null;
  try {
    const event = JSON.parse(rawBody) as { type?: unknown; data?: { object?: { object?: string; id?: unknown } } };
    const object = event.data?.object;
    return object?.object === "checkout.session" && typeof object.id === "string" ? { sessionId: object.id, type: typeof event.type === "string" ? event.type : "" } : null;
  } catch {
    return null;
  }
}
