import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { formatMoney } from "../src/shared/money.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

beforeEach(resetDatabase);

const smtp = (port: number) => ({ provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "" });

async function studio() {
  const { organization } = await createOrgWithUser("Studio North", "admin@studio.test", "admin-password-1", "admin");
  await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  await addUser(organization.id, "member@studio.test", "member-password-1", "member");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const manager = (await signIn("manager@studio.test", "manager-password-1")).cookie;
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const turnOnEmail = async (port: number) => expect((await request("/api/settings/email", { method: "PUT", body: smtp(port), cookie: admin })).status).toBe(200);
  return { organization, admin, manager, member, turnOnEmail };
}

async function invoiceFor(cookie: string, clientEmail: string | null = "ap@northwind.test") {
  const client = (await (await request("/api/clients", { body: { name: "Northwind" }, cookie })).json()).client;
  if (clientEmail) await request(`/api/clients/${client.id}`, { method: "PATCH", body: { email: clientEmail }, cookie });
  const id = (await (await request("/api/invoices", { body: { clientId: client.id, issueDate: "2026-11-01", dueDate: "2026-11-30", taxPercent: "10", notes: "Pay within 30 days." }, cookie })).json()).invoice.id;
  const line = await request(`/api/invoices/${id}/lines`, { body: { description: "Design <work>", quantity: 2500, unitPrice: 12345 }, cookie });
  expect(line.status).toBe(201);
  return id as string;
}
const emailInvoice = (cookie: string, id: string, body: Record<string, unknown> = {}) => request(`/api/invoices/${id}/email`, { body, cookie });
const getInvoice = async (cookie: string, id: string) => (await (await request(`/api/invoices/${id}`, { cookie })).json());

describe("emailing an invoice", () => {
  it("sends a draft to the client with the total in the body, and marks it sent", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const id = await invoiceFor(s.manager);
      // 2.5 x 123.45 = 308.63 (rounded once), 10% tax = 30.86, total 339.49.
      const before = await getInvoice(s.manager, id);
      expect(before.emailConfigured).toBe(true);
      expect(before.invoice).toMatchObject({ status: "draft", emailedAt: null, total: 33949 });

      const res = await emailInvoice(s.manager, id, { message: "Thanks for the work!" });
      expect(res.status).toBe(200);
      const { invoice } = await res.json();
      expect(invoice.status).toBe("sent");
      expect(invoice.sentAt).toBeTruthy();
      expect(invoice.emailedAt).toBeTruthy();
      expect(invoice.emailedTo).toBe("ap@northwind.test");

      expect(server.received).toHaveLength(1);
      const mail = server.received[0]!;
      expect(mail.to).toEqual(["ap@northwind.test"]);
      expect(mail.from).toBe("billing@studio.test");
      expect(mail.subject).toBe("Invoice 0001 from Studio North");
      const body = mail.body.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
      expect(body).toContain(formatMoney(33949, "USD"));
      expect(body).toContain(formatMoney(12345, "USD"));
      expect(body).toContain("Thanks for the work!");
      expect(body).toContain("Pay within 30 days.");
      expect(body).toContain("Design &lt;work&gt;"); // escaped in the HTML version
      expect(body).toContain("Content-Type: text/html");
      expect(body).toContain("Content-Type: text/plain");
      expect((await getInvoice(s.manager, id)).invoice.status).toBe("sent");
    } finally {
      await server.close();
    }
  });

  it("uses one font, a header with the app name and a rule in the accent color, and keeps escaping (QA2-23)", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      expect((await request("/api/settings/company", { method: "PUT", cookie: s.admin, body: { name: "Studio North", appName: "North <Hours>", currency: "USD", address: "" } })).status).toBe(200);
      expect((await request("/api/settings/appearance", { method: "PUT", cookie: s.admin, body: { accentColor: "#C2410C", colorMode: "system" } })).status).toBe(200);
      const id = await invoiceFor(s.manager);
      expect((await emailInvoice(s.manager, id, { message: "<b>Thanks</b>" })).status).toBe(200);
      const html = server.received[0]!.body.replace(/=\r?\n/g, "").replace(/=3D/g, "=").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const stack = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
      expect(html).toContain(`<div style="font-family:${stack}`); // on the outer wrapper
      expect(html).toContain("North &lt;Hours&gt;"); // the display name, escaped
      expect(html).toContain("border-bottom:2px solid #c2410c"); // the accent rule
      expect(html).toContain("&lt;b&gt;Thanks&lt;/b&gt;");
      expect(html.split("Content-Type: text/html")[1]).not.toContain("<b>Thanks</b>"); // only the plain-text part may hold it raw
      expect(html).toContain(formatMoney(33949, "USD"));
    } finally {
      await server.close();
    }
  });

  it("goes to another address when one is given, and asks for a valid one", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const id = await invoiceFor(s.admin);
      expect((await emailInvoice(s.admin, id, { to: "not an address" })).status).toBe(400);
      expect((await emailInvoice(s.admin, id, { message: 5 })).status).toBe(400);
      expect(server.received).toHaveLength(0);
      expect((await getInvoice(s.admin, id)).invoice.status).toBe("draft");
      const res = await emailInvoice(s.admin, id, { to: "  boss@northwind.test " });
      expect(res.status).toBe(200);
      expect(server.received[0]!.to).toEqual(["boss@northwind.test"]);
      expect((await res.json()).invoice.emailedTo).toBe("boss@northwind.test");
    } finally {
      await server.close();
    }
  });

  it("needs an address when the client has none", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const id = await invoiceFor(s.admin, null);
      const res = await emailInvoice(s.admin, id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/no email address/);
      expect((await emailInvoice(s.admin, id, { to: "ap@northwind.test" })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("sends a reminder for a sent invoice, and refuses a paid one", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const id = await invoiceFor(s.admin);
      await emailInvoice(s.admin, id);
      const first = (await getInvoice(s.admin, id)).invoice;
      const again = await emailInvoice(s.admin, id);
      expect(again.status).toBe(200);
      expect(server.received.map((m) => m.subject)).toEqual(["Invoice 0001 from Studio North", "Reminder: invoice 0001 from Studio North"]);
      const second = (await again.json()).invoice;
      expect(second.status).toBe("sent");
      expect(second.sentAt).toBe(first.sentAt); // a reminder doesn't change when it was first sent
      expect(new Date(second.emailedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.emailedAt).getTime());

      await request(`/api/invoices/${id}`, { method: "PATCH", body: { status: "paid" }, cookie: s.admin });
      const paid = await emailInvoice(s.admin, id);
      expect(paid.status).toBe(409);
      expect(server.received).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("reports a failed send and leaves the invoice as it was", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    await s.turnOnEmail(server.port);
    await server.close(); // nothing is listening any more
    const id = await invoiceFor(s.admin);
    const res = await emailInvoice(s.admin, id);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/./);
    const { invoice } = await getInvoice(s.admin, id);
    expect(invoice).toMatchObject({ status: "draft", sentAt: null, emailedAt: null, emailedTo: null });
    expect((await prisma.emailSettings.findFirstOrThrow()).lastError).toBeTruthy();
  });

  it("is refused for members, for missing invoices, and when email is off", async () => {
    const s = await studio();
    const id = await invoiceFor(s.admin);
    expect((await emailInvoice(s.member, id)).status).toBe(403);
    expect((await emailInvoice(s.admin, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const off = await emailInvoice(s.admin, id);
    expect(off.status).toBe(409);
    expect((await getInvoice(s.admin, id)).emailConfigured).toBe(false);
    expect((await getInvoice(s.admin, id)).invoice.status).toBe("draft");
  });

  it("never reaches another organization's invoice", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const id = await invoiceFor(s.admin);
      await createOrgWithUser("Other Studio", "boss@other.test", "other-password-1", "admin");
      const other = (await signIn("boss@other.test", "other-password-1")).cookie;
      expect((await emailInvoice(other, id)).status).toBe(404);
      expect(server.received).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("emailing invites", () => {
  const invite = (cookie: string, extra: Record<string, unknown> = {}) =>
    request("/api/people/invites", { body: { name: "Maya Chen", email: "maya@studio.test", role: "member", ...extra }, cookie });
  const linkIn = (mail: { body: string }, token: string) => mail.body.replace(/=\r?\n/g, "").includes(`http://localhost:3000/invite/${token}`);

  it("emails the link when email is on, and still returns it", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const res = await invite(s.admin);
      expect(res.status).toBe(201);
      const { token, emailed, emailError } = await res.json();
      expect(emailed).toBe(true);
      expect(emailError).toBeUndefined();
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toMatchObject({ to: ["maya@studio.test"], subject: "Join Studio North" });
      expect(linkIn(server.received[0]!, token)).toBe(true);
      expect(server.received[0]!.body).toContain("Content-Type: text/html");

      // Renewing sends the new link.
      const inviteId = (await prisma.invite.findFirstOrThrow()).id;
      const renewed = await (await request(`/api/people/invites/${inviteId}/renew`, { body: {}, cookie: s.admin })).json();
      expect(renewed.emailed).toBe(true);
      expect(server.received).toHaveLength(2);
      expect(linkIn(server.received[1]!, renewed.token)).toBe(true);
      expect(linkIn(server.received[1]!, token)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("emails someone who has no login yet", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const sam = await prisma.user.create({ data: { name: "Sam", email: "sam@no-login.invalid", organizationId: s.organization.id } });
      const res = await request(`/api/people/${sam.id}/invite`, { body: { email: "sam@studio.test" }, cookie: s.admin });
      expect(res.status).toBe(201);
      expect((await res.json()).emailed).toBe(true);
      expect(server.received[0]).toMatchObject({ to: ["sam@studio.test"], subject: "Join Studio North" });
    } finally {
      await server.close();
    }
  });

  it("honors the checkbox: emailLink false sends nothing", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    try {
      await s.turnOnEmail(server.port);
      const res = await invite(s.admin, { emailLink: false });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.emailed).toBe(false);
      expect(body.token).toBeTruthy();
      const inviteId = (await prisma.invite.findFirstOrThrow()).id;
      expect((await (await request(`/api/people/invites/${inviteId}/renew`, { body: { emailLink: false }, cookie: s.admin })).json()).emailed).toBe(false);
      expect(server.received).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("sends nothing when email is off", async () => {
    const s = await studio();
    const res = await invite(s.admin);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ emailed: false });
    expect((await (await request("/api/people", { cookie: s.admin })).json()).emailConfigured).toBe(false);
  });

  it("reports a failed send but still gives the link", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    await s.turnOnEmail(server.port);
    expect((await (await request("/api/people", { cookie: s.admin })).json()).emailConfigured).toBe(true);
    await server.close();
    const res = await invite(s.admin);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.emailed).toBe(false);
    expect(body.emailError).toMatch(/./);
    expect(body.token).toBeTruthy();
    expect(await prisma.invite.count()).toBe(1);
  });
});
