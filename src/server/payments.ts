import { Hono, type Context } from "hono";
import { orgDb, prisma, type OrgDb } from "./db.ts";
import { requireAdmin, readBody, type SignedIn } from "./http.ts";
import { env, isDemoMode } from "./env.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { escapeHtml } from "./mail.ts";
import { recordAudit } from "./audit.ts";
import { badWebhooksPerIp, checkoutsPerInvoice, payLinksPerIp } from "./rateLimit.ts";
import { limitIp } from "./clientIp.ts";
import { INVOICE_SELECT, toInvoice } from "./invoices.ts";
import { createCheckout, deleteWebhook, expireCheckout, getCheckout, getWebhook, keyMode, registerWebhook, STRIPE_KEY, StripeError, testKey, toStripeAmount, verifyWebhook, type CheckoutSession } from "./stripe.ts";
import { formatMoney } from "../shared/money.ts";
import { inkOn, HEX_COLOR } from "../shared/color.ts";
import { displayAppName, NEUTRAL_APP_NAME } from "../shared/product.ts";
import { installOrganizationId } from "./branding.ts";
import { describeError } from "./logging.ts";

// Online invoice payments ("payments through the app"). An admin connects the
// organization's own Stripe account; every sent invoice then has a Pay now link,
// /pay/<invoice id>, which sends the client to a Stripe Checkout Session for the
// invoice's current total. The money goes straight to the organization's Stripe account.
//
// An invoice is marked paid only after a Checkout Session read back from Stripe
// with the organization's own key says it's paid, and its amount, currency and
// invoice all match what was asked for. The return from Stripe and its webhooks
// only prompt that check; nothing they carry is trusted. Open checkouts are also
// checked every few minutes, so payments arrive even when Stripe can't reach
// this server.
//
// So a client can't pay twice by mistake, an invoice has at most one open checkout:
// a second visit goes back to it, and the others are ended at Stripe when a new one
// starts, when one is paid, and when the invoice stops being "sent". While a bank
// payment is on its way, the link takes no other payment.

const CHECKOUT_HOURS = 24;
/** Bank payments can take two weeks or more to arrive. They're checked hourly for this long. */
const PROCESSING_DAYS = 30;
const ONLINE_PAYMENT = { id: null, name: "Online payment (Stripe)" };

const UNREADABLE_KEY = "The saved Stripe key can't be read on this install (it came from a backup made with another secret). Connect Stripe again.";

/** The saved key, or null when payments aren't connected (or the key can't be read with this install's secret). */
async function stripeKey(db: OrgDb) {
  const settings = await db.paymentSettings.findFirst();
  if (!settings) return null;
  const key = decryptSecret(settings.secret);
  return key ? { key, settings } : null;
}

export async function payLinkFor(db: OrgDb, invoiceId: string) {
  return (await stripeKey(db)) ? `${env.baseUrl}/pay/${invoiceId}` : null;
}

const PAYMENT_SELECT = { id: true, invoiceId: true, providerRef: true, amount: true, amountCents: true, currency: true, status: true, createdAt: true } as const;
type PaymentRow = { id: string; invoiceId: string; providerRef: string; amount: number; amountCents: number; currency: string; status: string };
type Outcome = "open" | "processing" | "paid" | "expired" | "failed";

const invoiceLabel = (invoice: { number: string; client: { name: string } }) => `Invoice ${invoice.number} · ${invoice.client.name}`;

/**
 * Records how a checkout stands, unless it was settled meanwhile (by a check that ran at the
 * same time). True when this call is the one that settled it.
 */
async function settle(db: OrgDb, payment: PaymentRow, status: Exclude<Outcome, "paid">) {
  const { count } = await db.payment.updateMany({ where: { id: payment.id, status: { in: ["open", "processing"] }, NOT: { status } }, data: { status, checkedAt: new Date() } });
  if (!count) await db.payment.updateMany({ where: { id: payment.id, status }, data: { checkedAt: new Date() } });
  return count > 0;
}

/**
 * Asks Stripe about one checkout and records the outcome, with the session Stripe returned.
 * Safe to run any number of times, from anywhere. "processing": the client finished, but the
 * money hasn't arrived yet (a bank payment); it's checked until it does.
 */
async function checkPayment(db: OrgDb, payment: PaymentRow, key: string): Promise<{ outcome: Outcome; session: CheckoutSession | null }> {
  if (payment.status === "paid") return { outcome: "paid", session: null };
  let session: CheckoutSession;
  try {
    session = await getCheckout(key, payment.providerRef);
  } catch (error) {
    // Stripe doesn't know this checkout: the key was replaced by one for another Stripe account or mode.
    if (!(error instanceof StripeError) || error.status !== 404) throw error;
    if ((await settle(db, payment, "failed")) && payment.status === "processing") {
      const invoice = await db.invoice.findFirstOrThrow({ where: { id: payment.invoiceId }, select: { number: true, client: { select: { name: true } } } });
      await recordAudit(db, ONLINE_PAYMENT, { kind: "invoice", action: "changed", subjectId: payment.invoiceId, label: invoiceLabel(invoice), changes: [{ field: "note", from: null, to: "A bank payment that was still being processed can't be checked any more: the Stripe key was changed. Look for it in the previous Stripe account." }] });
    }
    return { outcome: "failed", session: null };
  }
  const now = new Date();
  const sameCheckout = session.id === payment.providerRef && session.client_reference_id === payment.invoiceId && (session.metadata?.invoice_id ?? payment.invoiceId) === payment.invoiceId;
  const paid = session.payment_status === "paid" && session.amount_total === payment.amount && session.currency === payment.currency.toLowerCase();

  if (!sameCheckout) {
    await settle(db, payment, "failed");
    return { outcome: "failed", session };
  }
  if (!paid) {
    const outcome = session.status === "expired" ? "expired" : session.status !== "complete" ? "open" : session.payment_status === "unpaid" ? "processing" : "failed";
    const changed = await settle(db, payment, outcome);
    // Finished at Stripe, but not for what was asked: never counts, and a person should know.
    if (outcome === "failed" && changed) {
      const invoice = await db.invoice.findFirstOrThrow({ where: { id: payment.invoiceId }, select: { number: true, client: { select: { name: true } } } });
      await recordAudit(db, ONLINE_PAYMENT, { kind: "invoice", action: "changed", subjectId: payment.invoiceId, label: invoiceLabel(invoice), changes: [{ field: "note", from: null, to: "An online checkout finished for a different amount or currency, so it wasn't counted. Check it in Stripe." }] });
    }
    return { outcome, session };
  }

  let first = false;
  await db.$transaction(async (tx) => {
    const t = tx as OrgDb;
    // Only once, however many checks run at the same time.
    const { count } = await t.payment.updateMany({ where: { id: payment.id, status: { not: "paid" } }, data: { status: "paid", paidAt: now, checkedAt: now } });
    if (!count) return;
    first = true;
    const invoice = toInvoice(await t.invoice.findFirstOrThrow({ where: { id: payment.invoiceId }, select: INVOICE_SELECT }));
    const received = { field: "paidOnline", from: null, to: payment.amountCents };
    // The invoice is marked paid only if it still asks for exactly what was paid. Otherwise
    // (it was changed after the client opened the link, or was already paid) a person decides.
    if (invoice.status === "sent" && invoice.total === payment.amountCents && invoice.currency === payment.currency) {
      await t.invoice.update({ where: { id: invoice.id }, data: { status: "paid", paidAt: now } });
      await recordAudit(t, ONLINE_PAYMENT, { kind: "invoice", action: "changed", subjectId: invoice.id, label: invoiceLabel(invoice), currency: invoice.currency, changes: [{ field: "status", from: "sent", to: "paid" }, received] });
    } else {
      await recordAudit(t, ONLINE_PAYMENT, { kind: "invoice", action: "changed", subjectId: invoice.id, label: invoiceLabel(invoice), currency: invoice.currency, changes: [received, { field: "note", from: null, to: PAID_UNMATCHED }] });
    }
  });
  // One payment is enough: no other checkout for this invoice may take another.
  if (first) await closeCheckouts(db, payment.invoiceId, key, payment.id);
  return { outcome: "paid", session };
}

/**
 * A bank payment that was on its way failed (Stripe said so in a signed webhook), or is still not
 * through after PROCESSING_DAYS. It stops holding the invoice: the Pay now link takes a new payment
 * and reminders go out again. A person sees why in the invoice's History.
 */
async function bankPaymentFailed(db: OrgDb, payment: PaymentRow, why = "A bank payment for this invoice failed, so it's open for payment again. Check it in Stripe.") {
  // "open" too: Stripe can send the failure before the notice that the client finished.
  const { count } = await db.payment.updateMany({ where: { id: payment.id, status: { in: ["open", "processing"] } }, data: { status: "failed", checkedAt: new Date() } });
  if (!count) return;
  const invoice = await db.invoice.findFirstOrThrow({ where: { id: payment.invoiceId }, select: { number: true, client: { select: { name: true } } } });
  await recordAudit(db, ONLINE_PAYMENT, { kind: "invoice", action: "changed", subjectId: payment.invoiceId, label: invoiceLabel(invoice), changes: [{ field: "note", from: null, to: why }] });
}

export const PAID_UNMATCHED = "Paid online, but not marked paid: the invoice changed or was already paid. Check it, and refund the client in Stripe if they paid twice.";

export async function confirmPayment(db: OrgDb, payment: PaymentRow, key: string): Promise<Outcome> {
  return (await checkPayment(db, payment, key)).outcome;
}

/** Ends one checkout at Stripe and records how it ended: expired, or paid if the client just finished. */
async function closeCheckout(db: OrgDb, payment: PaymentRow, key: string) {
  try {
    await expireCheckout(key, payment.providerRef);
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (error.status === 0) return; // Stripe can't be reached now; the sweep tries again
    // Otherwise it wasn't open any more. The check below says why.
  }
  await confirmPayment(db, payment, key);
}

/**
 * Ends the open checkouts of one invoice (or, with null, the whole organization's), except `keep`,
 * so none of them can take a payment.
 */
export async function closeCheckouts(db: OrgDb, invoiceId: string | null, key: string, keep?: string) {
  const open = await db.payment.findMany({ where: { status: "open", ...(invoiceId ? { invoiceId } : {}), ...(keep ? { id: { not: keep } } : {}) }, select: PAYMENT_SELECT });
  for (const payment of open) await closeCheckout(db, payment, key);
}

/**
 * Before a sent invoice goes back to draft: ends its checkouts first, so none can take a payment
 * while it's being changed. False when one is still open because Stripe couldn't be reached.
 */
export async function endCheckoutsFirst(db: OrgDb, invoiceId: string): Promise<boolean> {
  const stripe = await stripeKey(db);
  if (!stripe) return true; // nothing to end them with; disconnecting already stopped the link
  try {
    await closeCheckouts(db, invoiceId, stripe.key);
  } catch (error) {
    console.error("Ending an invoice's checkouts failed", describeError(error));
    return false;
  }
  return !(await db.payment.count({ where: { invoiceId, status: "open" } }));
}

/** For an invoice that just stopped being "sent": its checkouts can't take a payment any more. */
export async function closeInvoiceCheckouts(db: OrgDb, invoiceId: string) {
  try {
    const stripe = await stripeKey(db);
    if (stripe) await closeCheckouts(db, invoiceId, stripe.key);
  } catch (error) {
    // The sweep ends them later.
    console.error("Ending an invoice's online checkouts failed", describeError(error));
  }
}

let sweeping = false;

/** Checks open checkouts every few minutes, and bank payments on their way every hour. */
export async function sweepPayments(now = new Date()) {
  if (sweeping) return; // the last run is still going (a slow Stripe)
  sweeping = true;
  try {
    const due = await prisma.payment.findMany({
      where: {
        OR: [
          { status: "open" },
          { status: "processing", createdAt: { gt: new Date(now.getTime() - PROCESSING_DAYS * 86_400_000) }, OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - 3_600_000) } }] },
        ],
      },
      select: { ...PAYMENT_SELECT, organizationId: true, invoice: { select: { status: true } } },
      // Least recently checked first, so a pile of checkouts Stripe can't answer for can't crowd out the rest.
      orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: 200,
    });
    const tooOld = new Date(now.getTime() - (CHECKOUT_HOURS + 2) * 3_600_000);
    for (const payment of due) {
      const db = orgDb(payment.organizationId);
      try {
        const stripe = await stripeKey(db);
        if (!stripe) {
          // Disconnected, or the key can't be read on this install: there's nothing to ask Stripe with.
          await db.payment.updateMany({ where: { id: payment.id }, data: { checkedAt: now, ...(payment.status === "open" && payment.createdAt < tooOld ? { status: "expired" } : {}) } });
        } else if (payment.status === "open" && payment.invoice.status !== "sent") {
          await closeCheckout(db, payment, stripe.key);
        } else {
          await confirmPayment(db, payment, stripe.key);
        }
      } catch (error) {
        await db.payment.updateMany({ where: { id: payment.id }, data: { checkedAt: now } }).catch(() => undefined);
        console.error("Checking an online payment failed", describeError(error));
      }
    }
    // Bank payments still not through after PROCESSING_DAYS stop holding their invoices. If one
    // arrives after all, a webhook or the return page still records it (checkPayment).
    const stale = await prisma.payment.findMany({
      where: { status: "processing", createdAt: { lte: new Date(now.getTime() - PROCESSING_DAYS * 86_400_000) } },
      select: { ...PAYMENT_SELECT, organizationId: true },
      take: 200,
    });
    for (const payment of stale) {
      const why = `A bank payment for this invoice was still not through after ${PROCESSING_DAYS} days, so it's open for payment again. Check it in Stripe.`;
      await bankPaymentFailed(orgDb(payment.organizationId), payment, why).catch((error) => console.error("Ending an old bank payment failed", describeError(error)));
    }
  } finally {
    sweeping = false;
  }
}

// ---- Manage → Payments (admins) ----

const SETTINGS = { provider: true, mode: true, keyHint: true, webhookId: true, lastError: true } as const;
const toSettings = (row: { provider: string; mode: string; keyHint: string; webhookId: string | null; lastError: string | null } | null) =>
  row ? { connected: true, provider: row.provider, mode: row.mode, keyHint: row.keyHint, webhook: row.webhookId !== null, lastError: row.lastError } : { connected: false };

const describeKey = (s: { mode: string; keyHint: string }) => `Stripe, ${s.mode} mode, key ending ${s.keyHint}`;

/** Stripe can only send webhooks to an address on the internet. */
const reachable = (baseUrl = env.baseUrl) => {
  const host = new URL(baseUrl).hostname;
  return baseUrl.startsWith("https://") && host !== "localhost" && !host.endsWith(".localhost") && host !== "127.0.0.1";
};

const webhookUrl = (organizationId: string, baseUrl = env.baseUrl) => `${baseUrl}/api/payments/stripe/webhook/${organizationId}`;

/**
 * Whether Stripe's payment notifications reach this app. They don't after the app moves to another
 * address (its own domain), or when Stripe was connected before the app was on the internet. An
 * admin then sends them here from Manage → Payments. That is never done on its own: a restored copy
 * of an install (a staging copy) would otherwise take a live install's notifications.
 */
type Notifications = { state: "here" } | { state: "elsewhere"; host: string } | { state: "none" } | { state: "unknown" } | { state: "unreachable" };

async function notificationsFor(stripe: { key: string; settings: { webhookId: string | null } }, organizationId: string): Promise<Notifications> {
  if (!reachable()) return { state: "unreachable" };
  if (!stripe.settings.webhookId) return { state: "none" };
  try {
    const current = await getWebhook(stripe.key, stripe.settings.webhookId);
    if (current.url === webhookUrl(organizationId)) return { state: "here" };
    return { state: "elsewhere", host: URL.canParse(current.url) ? new URL(current.url).host : current.url };
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return { state: "none" };
    return { state: "unknown" };
  }
}

async function settingsFor(db: OrgDb, organizationId: string) {
  const row = await db.paymentSettings.findFirst({ select: SETTINGS });
  if (!row) return toSettings(null);
  const stripe = await stripeKey(db);
  if (!stripe) return { connected: false, lastError: UNREADABLE_KEY };
  return { ...toSettings(row), notifications: await notificationsFor(stripe, organizationId) };
}

export const paymentSettingsRoutes = new Hono<SignedIn>()
  .use(requireAdmin("change payment settings"))
  .get("/", async (c) => c.json(await settingsFor(c.get("db"), c.get("user").organizationId)))
  // Sends Stripe's payment notifications to this app's address: a new webhook here, then the old one
  // removed. It only takes effect if nobody changed the settings meanwhile (a new key, another tab).
  .post("/webhook", async (c) => {
    if (isDemoMode()) return c.json({ error: "Online payments can't be connected in the demo." }, 403);
    const db = c.get("db");
    const organizationId = c.get("user").organizationId;
    const stripe = await stripeKey(db);
    if (!stripe) return c.json({ error: "Connect Stripe first." }, 400);
    if (!reachable()) return c.json({ error: "Stripe can only reach this app once it has a public https address." }, 400);
    const previous = stripe.settings.webhookId;
    let webhook: { id: string; secret: string };
    try {
      webhook = await registerWebhook(stripe.key, webhookUrl(organizationId));
    } catch (error) {
      if (error instanceof StripeError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const undo = () => deleteWebhook(stripe.key, webhook.id).catch(() => undefined);
    let count: number;
    try {
      ({ count } = await db.paymentSettings.updateMany({
        where: { webhookId: previous },
        data: { webhookId: webhook.id, webhookSecret: encryptSecret(webhook.secret), lastError: null },
      }));
    } catch (error) {
      await undo();
      throw error;
    }
    if (count !== 1) {
      await undo();
      return c.json({ error: "The payment settings just changed. Reload the page and try again." }, 409);
    }
    if (previous) await deleteWebhook(stripe.key, previous).catch(() => undefined);
    await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Online payments", changes: [{ field: "notifications", from: previous ? "another address" : null, to: new URL(env.baseUrl).host }] });
    return c.json(await settingsFor(db, organizationId));
  })
  // { provider: "stripe", key }: checks the key with Stripe, registers a webhook when this
  // install can be reached, and saves the key encrypted.
  .put("/", async (c) => {
    if (isDemoMode()) return c.json({ error: "Online payments can't be connected in the demo." }, 403);
    const db = c.get("db");
    const body = await readBody(c);
    if (body.provider !== "stripe") return c.json({ error: "Choose Stripe." }, 400);
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!STRIPE_KEY.test(key)) return c.json({ error: "Paste a Stripe secret or restricted key. It starts with rk_ or sk_." }, 400);
    try {
      await testKey(key);
    } catch (error) {
      if (error instanceof StripeError) return c.json({ error: error.message }, 400);
      throw error;
    }

    const previous = await stripeKey(db);
    if (previous) {
      // Checkouts started with the old key end, so no payment goes to an account the app no longer checks.
      await closeCheckouts(db, null, previous.key).catch(() => undefined);
      if (previous.settings.webhookId) await deleteWebhook(previous.key, previous.settings.webhookId).catch(() => undefined);
    }
    let webhook: { id: string; secret: string } | null = null;
    let note: string | null = null;
    if (reachable()) {
      webhook = await registerWebhook(key, webhookUrl(c.get("user").organizationId)).catch(() => null);
      if (!webhook) note = "Stripe couldn't set up its notifications to this app, so payments are checked every few minutes instead.";
    }
    const data = {
      provider: "stripe" as const,
      mode: keyMode(key),
      secret: encryptSecret(key),
      keyHint: key.slice(-4),
      webhookId: webhook?.id ?? null,
      webhookSecret: webhook ? encryptSecret(webhook.secret) : null,
      lastError: note,
    };
    const row = await db.paymentSettings.upsert({
      where: { organizationId: c.get("user").organizationId },
      create: data as typeof data & { organizationId: string }, // orgDb fills in organizationId
      update: data,
      select: SETTINGS,
    });
    // Which account clients' payments go to is on record.
    await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Online payments", changes: [{ field: "payments", from: previous ? describeKey(previous.settings) : null, to: describeKey(data) }] });
    return c.json(toSettings(row));
  })
  .delete("/", async (c) => {
    const db = c.get("db");
    const stripe = await stripeKey(db);
    if (stripe) {
      // Open checkouts end: a payment made after this couldn't be checked.
      await closeCheckouts(db, null, stripe.key).catch(() => undefined);
      if (stripe.settings.webhookId) await deleteWebhook(stripe.key, stripe.settings.webhookId).catch(() => undefined);
    }
    const before = await db.paymentSettings.findFirst({ select: { mode: true, keyHint: true } });
    await db.paymentSettings.deleteMany({});
    if (before) await recordAudit(db, c.get("user"), { kind: "settings", action: "changed", label: "Online payments", changes: [{ field: "payments", from: describeKey(before), to: null }] });
    return c.json(toSettings(null));
  });

// ---- Stripe's notifications ----

export const paymentWebhookRoutes = new Hono().post("/stripe/webhook/:organizationId", async (c) => {
  const ip = limitIp(c);
  if (badWebhooksPerIp.over(ip)) return c.json({ error: "Too many tries." }, 429);
  const raw = await c.req.text();
  const id = c.req.param("organizationId");
  const organization = UUID.test(id) ? await prisma.organization.findUnique({ where: { id }, select: { id: true } }) : null;
  const db = organization ? orgDb(organization.id) : null;
  const stripe = db ? await stripeKey(db) : null;
  const secret = stripe?.settings.webhookSecret ? decryptSecret(stripe.settings.webhookSecret) : null;
  const event = secret ? verifyWebhook(raw, c.req.header("stripe-signature"), secret) : null;
  // One answer for an unknown organization, one without payments, and a bad signature.
  if (!db || !stripe || event === null) {
    badWebhooksPerIp.hit(ip);
    return c.json({ error: "Not accepted." }, 400);
  }
  const payment = await db.payment.findFirst({ where: { provider: "stripe", providerRef: event.sessionId }, select: PAYMENT_SELECT });
  if (payment && event.type === "checkout.session.async_payment_failed") await bankPaymentFailed(db, payment);
  else if (payment) await confirmPayment(db, payment, stripe.key);
  return c.json({ ok: true });
});

// ---- The client's side: /pay/<invoice id> ----

type Brand = { name: string; accent: string; logo: { url: string; wide: boolean } | null };

async function brandFor(db: OrgDb): Promise<Brand> {
  const org = await db.organization.findFirstOrThrow({ select: { id: true, name: true, appName: true, accentColor: true, logo: { select: { width: true, height: true, updatedAt: true } } } });
  // The public logo address serves only the install's own organization (never the demo's).
  const logo = org.logo && org.id === (await installOrganizationId())
    ? { url: `/api/branding/logo?v=${org.logo.updatedAt.getTime()}`, wide: org.logo.width >= 2 * org.logo.height }
    : null;
  return { name: displayAppName(org), accent: org.accentColor && HEX_COLOR.test(org.accentColor) ? org.accentColor : "#1f2937", logo };
}

/** Pages with no invoice to go by (a bad link, too many tries) still carry the install's own name. */
async function installBrand(): Promise<Brand> {
  const organizationId = await installOrganizationId();
  return organizationId ? brandFor(orgDb(organizationId)) : NEUTRAL;
}

// The look of the app's signed-out pages: a white card on the gray shell, the company's logo and name.
// A wide logo stands alone, as in the app's sidebar; a square one sits beside the name.
function brandLine(brand: Brand) {
  const name = escapeHtml(brand.name);
  if (!brand.logo) return `<p class="brand">${name}</p>`;
  if (brand.logo.wide) return `<p class="brand"><img src="${brand.logo.url}" alt="${name}" class="wide"></p>`;
  return `<p class="brand"><img src="${brand.logo.url}" alt="">${name}</p>`;
}

function page(c: Context, brand: Brand, title: string, body: string, status: 200 | 400 | 404 | 429 | 502 = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(brand.name)}</title>
<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;background:#eceef2}main{box-sizing:border-box;max-width:28rem;margin:12vh auto;padding:32px;background:#fff;border:1px solid #dfe2e7;border-radius:12px}@media (max-width:30rem){main{margin:24px 16px;padding:24px}}p.brand{display:flex;align-items:center;gap:12px;margin:0 0 24px;font-weight:600;color:#374151}p.brand img{height:32px;width:auto;max-width:200px;border-radius:6px}p.brand img.wide{height:36px;border-radius:0}h1{font-size:24px;line-height:1.25;margin:0 0 8px}p{margin:0 0 8px;color:#374151}a.button{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:8px;background:${brand.accent};color:${inkOn(brand.accent)};text-decoration:none;font-weight:600}a.button:focus-visible{outline:3px solid #111827;outline-offset:2px}</style></head>
<body><main>${brandLine(brand)}<h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html, status);
}

const NOT_FOUND = "This payment link doesn't work. Check you have the whole link from the email.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEUTRAL: Brand = { name: NEUTRAL_APP_NAME, accent: "#1f2937", logo: null };
// Answered without asking the database, so the limit keeps protecting it.
const tooMany = (c: Context) => page(c, NEUTRAL, "Too many tries", "<p>Wait a few minutes, then open the link again.</p>", 429);
const notFound = async (c: Context) => page(c, await installBrand(), "Link not found", `<p>${escapeHtml(NOT_FOUND)}</p>`, 404);

/** The invoice behind a Pay now link, with its own organization's database client. */
async function invoiceFor(id: string) {
  const found = UUID.test(id) ? await prisma.invoice.findUnique({ where: { id }, select: { organizationId: true } }) : null;
  if (!found) return null;
  const db = orgDb(found.organizationId);
  const invoice = toInvoice(await db.invoice.findFirstOrThrow({ where: { id }, select: INVOICE_SELECT }));
  return { db, invoice };
}

export const payRoutes = new Hono()
  .use(async (c, next) => {
    if (!payLinksPerIp.hit(limitIp(c))) return tooMany(c);
    await next();
  })
  .get("/:invoiceId", async (c) => {
    const found = await invoiceFor(c.req.param("invoiceId"));
    if (!found || found.invoice.status === "draft") return notFound(c);
    const { db, invoice } = found;
    const brand = await brandFor(db);
    const total = formatMoney(invoice.total, invoice.currency);
    const paidPage = () => page(c, brand, `Invoice ${invoice.number} is paid`, "<p>Thank you. There's nothing more to pay.</p>");
    const processingPage = () => page(c, brand, "A payment for this invoice is being processed", `<p>Some payment methods take a few days. You don't need to pay again. If something seems wrong, contact ${escapeHtml(brand.name)}.</p>`);
    // Paid, or paid online at any time: one payment is enough, whatever the invoice's status says now.
    if (invoice.status === "paid" || (await db.payment.count({ where: { invoiceId: invoice.id, status: "paid" } }))) return paidPage();
    if (invoice.total <= 0) return page(c, brand, `Invoice ${invoice.number}: ${total}`, `<p>There's nothing to pay online for this invoice. Contact ${escapeHtml(brand.name)} with any questions.</p>`);
    const stripe = await stripeKey(db);
    if (!stripe) return page(c, brand, `Invoice ${invoice.number}: ${total}`, `<p>Online payment isn't available for this invoice. Contact ${escapeHtml(brand.name)} to pay it.</p>`);
    const amount = toStripeAmount(invoice.total, invoice.currency);
    if (amount === null) return page(c, brand, `Invoice ${invoice.number}: ${total}`, `<p>This total includes a fraction of a yen, which can't be charged online. Contact ${escapeHtml(brand.name)} to pay it another way.</p>`, 400);

    try {
      // Back to a checkout that's still open for this total, so a second tab or visit can't pay twice.
      const earlier = await db.payment.findMany({ where: { invoiceId: invoice.id, status: { in: ["open", "processing"] } }, select: PAYMENT_SELECT, orderBy: { createdAt: "desc" } });
      if (earlier.some((p) => p.status === "processing")) return processingPage();
      for (const payment of earlier) {
        if (payment.amountCents !== invoice.total || payment.currency !== invoice.currency) continue;
        const { outcome, session } = await checkPayment(db, payment, stripe.key);
        if (outcome === "open" && session?.url) return c.redirect(session.url, 303);
        if (outcome === "processing") return processingPage();
        if (outcome === "paid") return paidPage();
      }

      if (!checkoutsPerInvoice.hit(invoice.id)) return tooMany(c);
      const pay = `${env.baseUrl}/pay/${invoice.id}`;
      const session = await createCheckout(stripe.key, {
        invoiceId: invoice.id,
        number: invoice.number,
        amount,
        currency: invoice.currency,
        email: invoice.client.email || undefined,
        successUrl: `${pay}/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${pay}/cancelled`,
        expiresAt: new Date(Date.now() + CHECKOUT_HOURS * 3600_000 - 60_000),
      });
      if (!session.url) throw new StripeError("Stripe didn't return a checkout page.", 502);
      const data = { invoiceId: invoice.id, provider: "stripe" as const, providerRef: session.id, amount, amountCents: invoice.total, currency: invoice.currency };
      const created = await db.payment.create({ data: data as typeof data & { organizationId: string }, select: { id: true } }); // orgDb fills in organizationId
      // Only the newest checkout stays open.
      await closeCheckouts(db, invoice.id, stripe.key, created.id).catch((error) => console.error("Ending older checkouts failed", describeError(error)));
      // One of them may have been paid meanwhile, which ends this one too.
      if ((await db.invoice.findFirstOrThrow({ where: { id: invoice.id }, select: { status: true } })).status === "paid") return paidPage();
      return c.redirect(session.url, 303);
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      if (error.code === "amount_too_large") {
        return page(c, brand, `Invoice ${invoice.number}: ${total}`, `<p>This total is above the largest amount Stripe can take online. Contact ${escapeHtml(brand.name)} to pay it another way.</p>`, 400);
      }
      if (error.code === "amount_too_small") {
        return page(c, brand, `Invoice ${invoice.number}: ${total}`, `<p>This total is below the smallest amount Stripe can take online. Contact ${escapeHtml(brand.name)} to pay it another way.</p>`, 400);
      }
      await db.paymentSettings.updateMany({ data: { lastError: error.message } });
      return page(c, brand, "Payment isn't available right now", `<p>Try again in a few minutes, or contact ${escapeHtml(brand.name)}.</p>`, 502);
    }
  })
  // Back from Stripe. The session id in the address only says which checkout to ask Stripe about.
  .get("/:invoiceId/return", async (c) => {
    const found = await invoiceFor(c.req.param("invoiceId"));
    if (!found) return notFound(c);
    const { db, invoice } = found;
    const brand = await brandFor(db);
    const payment = await db.payment.findFirst({ where: { invoiceId: invoice.id, provider: "stripe", providerRef: c.req.query("session_id") ?? "" }, select: PAYMENT_SELECT });
    const stripe = await stripeKey(db);
    let status: string = payment?.status ?? "missing";
    if (payment && stripe) {
      try {
        status = await confirmPayment(db, payment, stripe.key);
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
      }
    }
    const again = `<p><a class="button" href="/pay/${invoice.id}">Try again</a></p>`;
    if (status === "paid") return page(c, brand, "Thank you, your payment went through", `<p>Invoice ${escapeHtml(invoice.number)} for ${escapeHtml(formatMoney(invoice.total, invoice.currency))} is paid. Stripe emails a receipt if you gave your email address.</p>`);
    if (status === "processing") return page(c, brand, "Your payment is being processed", "<p>Some payment methods take a few days. You don't need to pay again; you'll hear when it's done.</p>");
    return page(c, brand, "The payment didn't go through", `<p>Nothing was charged.</p>${again}`);
  })
  .get("/:invoiceId/cancelled", async (c) => {
    const found = await invoiceFor(c.req.param("invoiceId"));
    if (!found) return notFound(c);
    const brand = await brandFor(found.db);
    // Offer to pay again only while online payment is on; otherwise the button would lead nowhere.
    const again = (await stripeKey(found.db))
      ? `<p><a class="button" href="/pay/${found.invoice.id}">Pay invoice ${escapeHtml(found.invoice.number)}</a></p>`
      : `<p>Online payment isn't available for this invoice now. Contact ${escapeHtml(brand.name)} to pay it.</p>`;
    return page(c, brand, "Payment cancelled", `<p>Nothing was charged.</p>${again}`);
  });
