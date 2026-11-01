import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgDb, prisma } from "../src/server/db.ts";
import { decryptSecret, encryptSecret } from "../src/server/secrets.ts";
import { confirmPayment, PAID_UNMATCHED, sweepPayments } from "../src/server/payments.ts";
import { env } from "../src/server/env.ts";
import { badWebhooksPerIp, checkoutsPerInvoice, payLinksPerIp } from "../src/server/rateLimit.ts";
import { toStripeAmount, verifyWebhook } from "../src/server/stripe.ts";
import { addUser, app, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// A stand-in for api.stripe.com, so the tests never leave this machine.
type Session = { id: string; url: string; status: string; payment_status: string; amount_total: number; currency: string; client_reference_id: string; metadata: Record<string, string> };
const stripe = { sessions: new Map<string, Session>(), webhooks: new Map<string, string>(), calls: [] as string[], next: 1, onRegister: null as null | (() => Promise<void>) };
const KEY = "rk_test_1234567890abcdefghij";

async function fakeStripe(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  stripe.calls.push(`${method} ${url.pathname}`);
  const auth = new Headers(init?.headers).get("authorization");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (auth !== `Bearer ${KEY}`) return json({ error: { message: "Invalid API Key provided" } }, 401);
  const form = new URLSearchParams(String(init?.body ?? ""));
  if (method === "GET" && url.pathname === "/v1/checkout/sessions") return json({ data: [] });
  if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
    const amount = Number(form.get("line_items[0][price_data][unit_amount]"));
    if (amount < 50) return json({ error: { code: "amount_too_small", message: "Amount must be at least $0.50 usd" } }, 400);
    const id = `cs_test_${stripe.next++}`;
    const session = {
      id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", amount_total: amount,
      currency: form.get("line_items[0][price_data][currency]")!, client_reference_id: form.get("client_reference_id")!, metadata: { invoice_id: form.get("metadata[invoice_id]")! },
    };
    stripe.sessions.set(id, session);
    return json(session);
  }
  const expire = /^\/v1\/checkout\/sessions\/(.+)\/expire$/.exec(url.pathname);
  if (method === "POST" && expire) {
    const session = stripe.sessions.get(decodeURIComponent(expire[1]!));
    if (!session) return json({ error: { message: "No such checkout.session" } }, 404);
    if (session.status !== "open") return json({ error: { message: "Only open Checkout Sessions can be expired." } }, 400);
    session.status = "expired";
    return json(session);
  }
  const match = /^\/v1\/checkout\/sessions\/(.+)$/.exec(url.pathname);
  if (method === "GET" && match) {
    const session = stripe.sessions.get(decodeURIComponent(match[1]!));
    return session ? json(session) : json({ error: { message: "No such checkout.session" } }, 404);
  }
  if (method === "POST" && url.pathname === "/v1/webhook_endpoints") {
    const id = stripe.webhooks.size === 0 ? "we_1" : `we_${stripe.webhooks.size + 1}`;
    stripe.webhooks.set(id, form.get("url")!);
    await stripe.onRegister?.();
    return json({ id, secret: id === "we_1" ? "whsec_test_secret" : `whsec_${id}` });
  }
  const endpoint = /^\/v1\/webhook_endpoints\/(.+)$/.exec(url.pathname);
  if (method === "GET" && endpoint) {
    const where = stripe.webhooks.get(decodeURIComponent(endpoint[1]!));
    return where ? json({ id: endpoint[1], url: where }) : json({ error: { message: "No such webhook endpoint" } }, 404);
  }
  if (method === "DELETE" && endpoint) stripe.webhooks.delete(decodeURIComponent(endpoint[1]!));
  if (method === "DELETE") return json({ deleted: true });
  return json({ error: { message: "Unexpected call" } }, 500);
}

beforeEach(async () => {
  await resetDatabase();
  stripe.sessions.clear();
  stripe.webhooks.clear();
  stripe.onRegister = null;
  stripe.calls = [];
  payLinksPerIp.reset();
  checkoutsPerInvoice.reset();
  badWebhooksPerIp.reset();
  vi.stubGlobal("fetch", vi.fn(fakeStripe));
});
afterEach(() => vi.unstubAllGlobals());

const pay = (path: string) => app.request(path, { headers: { "x-forwarded-for": "203.0.113.9" } });

async function studio({ connect = true, seconds = 3600 } = {}) {
  const { organization } = await createOrgWithUser("Studio North", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const client = (await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: admin })).json()).client;
  await request(`/api/clients/${client.id}`, { method: "PATCH", body: { email: "ap@acme.test" }, cookie: admin });
  const project = (await (await request("/api/projects", { body: { name: "Website", clientId: client.id, hourlyRate: 12000 }, cookie: admin })).json()).project;
  await request("/api/time-entries", { body: { projectId: project.id, date: "2026-10-12", seconds }, cookie: admin });
  const { invoice } = await (await request("/api/invoices", { body: { clientId: client.id, issueDate: "2026-10-15" }, cookie: admin })).json();
  await request(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { status: "sent" }, cookie: admin });
  if (connect) expect((await request("/api/settings/payments", { method: "PUT", body: { provider: "stripe", key: KEY }, cookie: admin })).status).toBe(200);
  const status = async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status;
  return { organization, admin, manager, invoiceId: invoice.id as string, status };
}

/** Stripe's side of a payment going through. */
const payOnStripe = (id: string, changes: Partial<Session> = {}) => Object.assign(stripe.sessions.get(id)!, { status: "complete", payment_status: "paid", ...changes });

async function startCheckout(invoiceId: string) {
  const res = await pay(`/pay/${invoiceId}`);
  expect(res.status).toBe(303);
  return res.headers.get("location")!.split("/").pop()!;
}

describe("online payments with Stripe", () => {
  it("connects with an admin's own key, kept encrypted and never shown again", async () => {
    const s = await studio({ connect: false });
    const put = (body: unknown, cookie = s.admin) => request("/api/settings/payments", { method: "PUT", body, cookie });
    expect((await put({ provider: "stripe", key: "pk_test_123" })).status).toBe(400);
    const wrong = await put({ provider: "stripe", key: "rk_test_wrongwrongwrong" });
    expect((await wrong.json()).error).toBe("Stripe didn't accept this key. Copy it again from the Stripe Dashboard.");
    expect((await put({ provider: "stripe", key: KEY }, s.manager)).status).toBe(403);

    const res = await put({ provider: "stripe", key: KEY });
    // This test install is on localhost, which Stripe can't reach: no webhook, checks instead.
    expect(await res.json()).toEqual({ connected: true, provider: "stripe", mode: "test", keyHint: "ghij", webhook: false, lastError: null });
    const row = await prisma.paymentSettings.findFirstOrThrow();
    expect(row.secret).not.toContain(KEY);
    expect(JSON.stringify(await (await request("/api/settings/payments", { cookie: s.admin })).json())).not.toContain(KEY);
    expect((await (await request("/api/settings/security", { cookie: s.admin })).json()).payments).toEqual({ provider: "stripe", mode: "test", host: "api.stripe.com" });
    // Which Stripe account payments go to is on record.
    expect((await (await request("/api/history?kind=settings", { cookie: s.admin })).json()).events[0].changes).toEqual([{ field: "payments", from: null, to: "Stripe, test mode, key ending ghij" }]);

    expect((await (await request(`/api/invoices/${s.invoiceId}`, { cookie: s.admin })).json()).payLink).toBe(`http://localhost:3000/pay/${s.invoiceId}`);
    expect(await (await request("/api/settings/payments", { method: "DELETE", cookie: s.admin })).json()).toEqual({ connected: false });
    expect((await (await request(`/api/invoices/${s.invoiceId}`, { cookie: s.admin })).json()).payLink).toBeNull();
  });

  it("marks an invoice paid only once Stripe confirms the right amount", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    const session = stripe.sessions.get(id)!;
    expect(session).toMatchObject({ amount_total: 12000, currency: "usd", client_reference_id: s.invoiceId });
    expect(stripe.calls).toContain("POST /v1/checkout/sessions");

    // Coming back before paying: nothing changes.
    expect(await (await pay(`/pay/${s.invoiceId}/return?session_id=${id}`)).text()).toContain("The payment didn&#39;t go through");
    expect(await s.status()).toBe("sent");

    payOnStripe(id);
    const back = await pay(`/pay/${s.invoiceId}/return?session_id=${id}`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Thank you, your payment went through");
    expect(await s.status()).toBe("paid");
    const [event] = (await (await request("/api/history?kind=invoice", { cookie: s.admin })).json()).events;
    expect(event).toMatchObject({ actorId: null, actorName: "Online payment (Stripe)", changes: [{ field: "status", from: "sent", to: "paid" }, { field: "paidOnline", from: null, to: 12000 }] });
    expect((await (await request(`/api/invoices/${s.invoiceId}`, { cookie: s.admin })).json()).payments).toMatchObject([{ amountCents: 12000, currency: "USD" }]);

    // Once paid, the link says so and starts no new checkout.
    stripe.calls = [];
    expect(await (await pay(`/pay/${s.invoiceId}`)).text()).toContain("is paid");
    expect(stripe.calls).toEqual([]);
  });

  it("trusts nothing the browser sends", async () => {
    const s = await studio();
    // A made-up session id, or one Stripe never heard of.
    expect(await (await pay(`/pay/${s.invoiceId}/return?session_id=cs_test_forged`)).text()).toContain("didn&#39;t go through");
    // Paid, but for less than asked, or in another currency.
    const cheap = await startCheckout(s.invoiceId);
    payOnStripe(cheap, { amount_total: 100 });
    await pay(`/pay/${s.invoiceId}/return?session_id=${cheap}`);
    const euro = await startCheckout(s.invoiceId);
    payOnStripe(euro, { currency: "eur" });
    await pay(`/pay/${s.invoiceId}/return?session_id=${euro}`);
    // Paid, but for another invoice.
    const other = await startCheckout(s.invoiceId);
    payOnStripe(other, { client_reference_id: "11111111-1111-4111-8111-111111111111" });
    await pay(`/pay/${s.invoiceId}/return?session_id=${other}`);
    expect(await s.status()).toBe("sent");
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: other } })).status).toBe("failed");
    expect(await prisma.payment.count({ where: { status: "paid" } })).toBe(0);
  });

  it("leaves an invoice that changed after checkout for a person to check", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "draft" }, cookie: s.admin });
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { discountPercent: "10" }, cookie: s.admin });
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    payOnStripe(id);
    await pay(`/pay/${s.invoiceId}/return?session_id=${id}`);
    expect(await s.status()).toBe("sent");
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("paid");
    const [event] = (await (await request("/api/history?kind=invoice", { cookie: s.admin })).json()).events;
    expect(event.changes).toEqual([{ field: "paidOnline", from: null, to: 12000 }, { field: "note", from: null, to: PAID_UNMATCHED }]);
  });

  it("checks open payments without the client coming back, once", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    await sweepPayments();
    expect(await s.status()).toBe("sent");
    // A bank payment that completed but isn't paid yet is on its way.
    payOnStripe(id, { payment_status: "unpaid" });
    await sweepPayments();
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("processing");
    expect(await (await pay(`/pay/${s.invoiceId}/return?session_id=${id}`)).text()).toContain("Your payment is being processed");
    payOnStripe(id);
    const payment = await prisma.payment.findFirstOrThrow();
    const db = orgDb(s.organization.id);
    await Promise.all([sweepPayments(), confirmPayment(db, payment, KEY), pay(`/pay/${s.invoiceId}/return?session_id=${id}`)]);
    expect(await s.status()).toBe("paid");
    expect(await prisma.auditEvent.count({ where: { actorName: "Online payment (Stripe)" } })).toBe(1);
  });

  it("acts on Stripe's notifications only when they're signed, then asks Stripe", async () => {
    const s = await studio();
    await prisma.paymentSettings.updateMany({ data: { webhookId: "we_1", webhookSecret: encryptSecret("whsec_test_secret") } });
    const id = await startCheckout(s.invoiceId);
    payOnStripe(id);
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { object: "checkout.session", id, payment_status: "paid" } } });
    const send = (signature: string) => app.request(`/api/payments/stripe/webhook/${s.organization.id}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body });
    const sign = (t: number, secret = "whsec_test_secret") => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    const now = Math.floor(Date.now() / 1000);

    expect((await send(sign(now, "whsec_wrong"))).status).toBe(400);
    expect((await send(sign(now - 3600))).status).toBe(400);
    expect(await s.status()).toBe("sent");
    expect((await send(sign(now))).status).toBe(200);
    expect(await s.status()).toBe("paid");
    expect(verifyWebhook(body, sign(now), "whsec_test_secret")).toEqual({ sessionId: id, type: "checkout.session.completed" });
  });

  it("explains links that can't take a payment", async () => {
    const s = await studio({ seconds: 9 }); // 9 seconds at $120/h: $0.30
    const small = await pay(`/pay/${s.invoiceId}`);
    expect(small.status).toBe(400);
    expect(await small.text()).toContain("below the smallest amount Stripe can take online");
    expect((await pay("/pay/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await pay("/pay/not-an-id")).status).toBe(404);
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "draft" }, cookie: s.admin });
    expect((await pay(`/pay/${s.invoiceId}`)).status).toBe(404); // drafts aren't payable
    await request("/api/settings/payments", { method: "DELETE", cookie: s.admin });
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    expect(await (await pay(`/pay/${s.invoiceId}`)).text()).toContain("Online payment isn't available for this invoice");
  });

  it("says when Stripe's notifications go to another address, and an admin sends them here (WRK-129)", async () => {
    const s = await studio();
    const old = `https://workspace-ab12.onrender.com/api/payments/stripe/webhook/${s.organization.id}`;
    stripe.webhooks.set("we_1", old);
    await prisma.paymentSettings.updateMany({ data: { webhookId: "we_1", webhookSecret: encryptSecret("whsec_test_secret") } });
    const settings = async (cookie = s.admin) => (await request("/api/settings/payments", { cookie })).json();

    // Not on the internet: nothing to offer, and nothing to send there.
    expect((await settings()).notifications).toEqual({ state: "unreachable" });
    expect((await request("/api/settings/payments/webhook", { method: "POST", cookie: s.admin })).status).toBe(400);

    const saved = env.baseUrl;
    env.baseUrl = "https://time.studio.test";
    try {
      expect((await settings()).notifications).toEqual({ state: "elsewhere", host: "workspace-ab12.onrender.com" });
      // Never on its own, and only admins.
      expect(stripe.webhooks.get("we_1")).toBe(old);
      expect((await request("/api/settings/payments/webhook", { method: "POST", cookie: s.manager })).status).toBe(403);

      const moved = await request("/api/settings/payments/webhook", { method: "POST", cookie: s.admin });
      expect(moved.status).toBe(200);
      expect((await moved.json()).notifications).toEqual({ state: "here" });
      const row = await prisma.paymentSettings.findFirstOrThrow();
      expect(row.webhookId).toBe("we_2");
      expect(decryptSecret(row.webhookSecret!)).toBe("whsec_we_2");
      expect([...stripe.webhooks]).toEqual([["we_2", `https://time.studio.test/api/payments/stripe/webhook/${s.organization.id}`]]);
      expect(await prisma.auditEvent.count({ where: { label: "Online payments", action: "changed" } })).toBeGreaterThan(0);

      // A webhook removed at Stripe: offered again, and a fresh one is made.
      stripe.webhooks.clear();
      expect((await settings()).notifications).toEqual({ state: "none" });
    } finally {
      env.baseUrl = saved;
    }
  });

  it("escapes the company's name on its client pages, and keeps a wide logo's name in its alt text", async () => {
    const s = await studio();
    await prisma.organization.update({ where: { id: s.organization.id }, data: { appName: `<b>Bold & "Co"</b>` } });
    await prisma.installation.create({ data: { id: 1, organizationId: s.organization.id } });
    await prisma.logo.create({ data: { organizationId: s.organization.id, contentType: "image/png", data: new Uint8Array([1]), width: 300, height: 60 } });
    const html = await (await pay(`/pay/${s.invoiceId}/cancelled`)).text();
    expect(html).not.toContain("<b>Bold");
    expect(html).toContain('alt="&lt;b&gt;Bold &amp; &quot;Co&quot;&lt;/b&gt;" class="wide"');
  });

  it("leaves the settings alone, and removes the webhook it made, if they changed meanwhile", async () => {
    const s = await studio();
    stripe.webhooks.set("we_1", "https://old.example/api/payments/stripe/webhook/x");
    await prisma.paymentSettings.updateMany({ data: { webhookId: "we_1", webhookSecret: encryptSecret("whsec_test_secret") } });
    const saved = env.baseUrl;
    env.baseUrl = "https://time.studio.test";
    try {
      // Another tab connects a new key while this one is registering.
      stripe.onRegister = async () => {
        await prisma.paymentSettings.updateMany({ data: { webhookId: "we_other" } });
      };
      const res = await request("/api/settings/payments/webhook", { method: "POST", cookie: s.admin });
      expect(res.status).toBe(409);
      expect((await prisma.paymentSettings.findFirstOrThrow()).webhookId).toBe("we_other");
      expect([...stripe.webhooks.keys()]).toEqual(["we_1"]);
    } finally {
      env.baseUrl = saved;
    }
  });

  it("shows the company's name and logo on its client pages, and offers to pay again only while it can (QA2-29)", async () => {
    const s = await studio();
    // Before the install is linked to an organization (the demo), a bad link carries the neutral label.
    expect(await (await pay("/pay/not-an-id")).text()).toContain("Time tracking");
    await prisma.installation.create({ data: { id: 1, organizationId: s.organization.id } });
    await prisma.logo.create({ data: { organizationId: s.organization.id, contentType: "image/png", data: new Uint8Array([1]), width: 64, height: 64 } });
    const notFound = await (await pay("/pay/not-an-id")).text();
    expect(notFound).toContain('<p class="brand"><img src="/api/branding/logo?v=');
    expect(notFound).toContain("Studio North");
    expect(notFound).not.toContain("Time tracking");

    expect(await (await pay(`/pay/${s.invoiceId}/cancelled`)).text()).toContain(`href="/pay/${s.invoiceId}"`);
    await request("/api/settings/payments", { method: "DELETE", cookie: s.admin });
    const cancelled = await (await pay(`/pay/${s.invoiceId}/cancelled`)).text();
    expect(cancelled).not.toContain(`href="/pay/${s.invoiceId}"`);
    expect(cancelled).toContain("Online payment isn't available for this invoice now. Contact Studio North to pay it.");
  });

  it("sends a second visit to the same checkout, and ends checkouts that can't be paid any more", async () => {
    const s = await studio();
    const first = await startCheckout(s.invoiceId);
    expect(await startCheckout(s.invoiceId)).toBe(first);
    expect(stripe.calls.filter((call) => call === "POST /v1/checkout/sessions")).toHaveLength(1);

    // Back to draft: the open checkout ends at Stripe.
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "draft" }, cookie: s.admin });
    expect(stripe.sessions.get(first)!.status).toBe("expired");
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: first } })).status).toBe("expired");
    // Changed and sent again: a new checkout for the new total.
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { discountPercent: "10" }, cookie: s.admin });
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    const second = await startCheckout(s.invoiceId);
    expect(second).not.toBe(first);
    expect(stripe.sessions.get(second)!.amount_total).toBe(10800);
    // Marked paid by hand (a bank transfer): the link takes no more payments.
    await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "paid" }, cookie: s.admin });
    expect(stripe.sessions.get(second)!.status).toBe("expired");
    expect(await (await pay(`/pay/${s.invoiceId}`)).text()).toContain("is paid");
  });

  it("ends open checkouts when Stripe is disconnected, and doesn't count a key it can't read", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    await request("/api/settings/payments", { method: "DELETE", cookie: s.admin });
    expect(stripe.sessions.get(id)!.status).toBe("expired");

    await request("/api/settings/payments", { method: "PUT", body: { provider: "stripe", key: KEY }, cookie: s.admin });
    await prisma.paymentSettings.updateMany({ data: { secret: "garbage" } }); // as after a restore with another secret
    expect(await (await request("/api/settings/payments", { cookie: s.admin })).json()).toEqual({ connected: false, lastError: expect.stringContaining("can't be read on this install") });
    expect((await (await request(`/api/invoices/${s.invoiceId}`, { cookie: s.admin })).json()).payLink).toBeNull();
  });

  it("counts a second payment for the same invoice once, and says to refund it", async () => {
    const s = await studio();
    const first = await startCheckout(s.invoiceId);
    // Another checkout open at the same time, both paid before either was checked.
    const second = "cs_test_second";
    stripe.sessions.set(second, { ...stripe.sessions.get(first)!, id: second, url: `https://checkout.stripe.com/c/pay/${second}` });
    await prisma.payment.create({ data: { organizationId: s.organization.id, invoiceId: s.invoiceId, provider: "stripe", providerRef: second, amount: 12000, amountCents: 12000, currency: "USD" } });
    payOnStripe(first);
    payOnStripe(second);
    await pay(`/pay/${s.invoiceId}/return?session_id=${first}`);
    expect(await s.status()).toBe("paid");
    expect(await prisma.payment.count({ where: { status: "paid" } })).toBe(2);
    const [event] = (await (await request("/api/history?kind=invoice", { cookie: s.admin })).json()).events;
    expect(event.changes).toEqual([{ field: "paidOnline", from: null, to: 12000 }, { field: "note", from: null, to: PAID_UNMATCHED }]);
  });

  it("keeps checking a bank payment for days, and takes no other payment meanwhile", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    payOnStripe(id, { payment_status: "unpaid" });
    await sweepPayments();
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("processing");
    stripe.calls = [];
    expect(await (await pay(`/pay/${s.invoiceId}`)).text()).toContain("A payment for this invoice is being processed");
    expect(stripe.calls).toEqual([]);

    const later = new Date(Date.now() + 3 * 86_400_000);
    await sweepPayments(later);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("processing");
    payOnStripe(id);
    await sweepPayments(later);
    expect(await s.status()).toBe("paid");
  });

  it("opens the invoice again when a bank payment fails, or isn't through after 30 days", async () => {
    const s = await studio();
    await prisma.paymentSettings.updateMany({ data: { webhookId: "we_1", webhookSecret: encryptSecret("whsec_test_secret") } });
    const id = await startCheckout(s.invoiceId);
    payOnStripe(id, { payment_status: "unpaid" });
    await sweepPayments();
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("processing");

    // Stripe's signed notification that the bank payment failed: the session itself still says "unpaid".
    const body = JSON.stringify({ type: "checkout.session.async_payment_failed", data: { object: { object: "checkout.session", id } } });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${createHmac("sha256", "whsec_test_secret").update(`${t}.${body}`).digest("hex")}`;
    const res = await app.request(`/api/payments/stripe/webhook/${s.organization.id}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body });
    expect(res.status).toBe(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("failed");
    expect(await s.status()).toBe("sent");
    const [event] = (await (await request("/api/history?kind=invoice", { cookie: s.admin })).json()).events;
    expect(event.changes).toEqual([{ field: "note", from: null, to: "A bank payment for this invoice failed, so it's open for payment again. Check it in Stripe." }]);
    expect((await pay(`/pay/${s.invoiceId}`)).status).toBe(303); // a new checkout

    // Without a notification, a bank payment still on its way after 30 days stops holding the invoice.
    const later = await startCheckout(s.invoiceId);
    payOnStripe(later, { payment_status: "unpaid" });
    await sweepPayments();
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: later } })).status).toBe("processing");
    await sweepPayments(new Date(Date.now() + 31 * 86_400_000));
    expect((await prisma.payment.findFirstOrThrow({ where: { providerRef: later } })).status).toBe("failed");
  });

  it("ends a sent invoice's checkout before it goes back to draft, and waits if Stripe can't be reached", async () => {
    const s = await studio();
    await startCheckout(s.invoiceId);
    const toDraft = () => request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "draft" }, cookie: s.admin });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed")); // the expire call
    const waiting = await toDraft();
    expect(waiting.status).toBe(503);
    expect(await s.status()).toBe("sent");
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("open");

    const done = await toDraft();
    expect(done.status).toBe(200);
    expect(await s.status()).toBe("draft");
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("expired");
  });

  it("records a bank payment's failure even when Stripe sends it before the client's finish", async () => {
    const s = await studio();
    await prisma.paymentSettings.updateMany({ data: { webhookId: "we_1", webhookSecret: encryptSecret("whsec_test_secret") } });
    const id = await startCheckout(s.invoiceId);
    const send = async (type: string) => {
      const body = JSON.stringify({ type, data: { object: { object: "checkout.session", id } } });
      const t = Math.floor(Date.now() / 1000);
      const signature = `t=${t},v1=${createHmac("sha256", "whsec_test_secret").update(`${t}.${body}`).digest("hex")}`;
      return app.request(`/api/payments/stripe/webhook/${s.organization.id}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body });
    };
    expect((await send("checkout.session.async_payment_failed")).status).toBe(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("failed");
    payOnStripe(id, { payment_status: "unpaid" });
    expect((await send("checkout.session.completed")).status).toBe(200);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe("failed");
  });

  it("keeps an invoice paid online paid, and its link closed", async () => {
    const s = await studio();
    const id = await startCheckout(s.invoiceId);
    payOnStripe(id);
    await pay(`/pay/${s.invoiceId}/return?session_id=${id}`);
    expect(await s.status()).toBe("paid");
    const back = await request(`/api/invoices/${s.invoiceId}`, { method: "PATCH", body: { status: "sent" }, cookie: s.admin });
    expect(back.status).toBe(409);
    expect((await back.json()).error).toBe("This invoice was paid online, so it stays paid. Refunds are made in Stripe.");
    // Even if its status were changed some other way, the link says it's paid.
    await prisma.invoice.updateMany({ where: { id: s.invoiceId }, data: { status: "sent" } });
    stripe.calls = [];
    expect(await (await pay(`/pay/${s.invoiceId}`)).text()).toContain("is paid");
    expect(stripe.calls).toEqual([]);
  });

  it("answers strangers' webhooks the same way, and slows down ones that keep failing", async () => {
    const s = await studio();
    const send = (organizationId: string) =>
      app.request(`/api/payments/stripe/webhook/${organizationId}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00", "x-forwarded-for": "203.0.113.50" }, body: "{}" });
    const unknown = await send("00000000-0000-4000-8000-000000000000");
    const known = await send(s.organization.id); // connected, but this install has no webhook
    expect([unknown.status, known.status]).toEqual([400, 400]);
    expect(await unknown.json()).toEqual(await known.json());
    for (let i = 0; i < 30; i++) await send("not-an-id");
    expect((await send(s.organization.id)).status).toBe(429);
  });

  it("counts yen in whole yen for Stripe", () => {
    expect(toStripeAmount(123456, "USD")).toBe(123456);
    expect(toStripeAmount(123400, "JPY")).toBe(1234);
    expect(toStripeAmount(123456, "JPY")).toBeNull(); // a fraction of a yen can't be charged
  });
});
