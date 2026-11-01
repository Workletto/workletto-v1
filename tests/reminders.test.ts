import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { sweepReminders } from "../src/server/reminders.ts";
import { dueReminder } from "../src/shared/reminders.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { startFakeSmtp } from "./fakeSmtp.ts";

// Late-payment reminders (WRK-146): a sent, unpaid invoice gets an email some days after its due
// date, then every 7 days, up to 3, on the organization's own date. Each goes out exactly once.

beforeEach(resetDatabase);

const smtp = (port: number) => ({ provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, smtpUser: "" });
const at = (iso: string) => new Date(iso);

async function studio(name = "Studio North", domain = "studio.test") {
  const { organization } = await createOrgWithUser(name, `admin@${domain}`, "admin-password-1", "admin");
  await addUser(organization.id, `manager@${domain}`, "manager-password-1", "manager");
  const admin = (await signIn(`admin@${domain}`, "admin-password-1")).cookie;
  const manager = (await signIn(`manager@${domain}`, "manager-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json() };
  };
  const remindAfter = (days: number, timeZone = "UTC") => prisma.organization.update({ where: { id: organization.id }, data: { invoiceReminderDays: days, timeZone } });
  return { organization, admin, manager, json, remindAfter };
}

/** An invoice for $100 due on 2026-11-30, sent (or left as it is) to a client with an email address. */
let clients = 0;
async function invoice(s: Awaited<ReturnType<typeof studio>>, { status = "sent", email = "ap@northwind.test" }: { status?: string; email?: string } = {}) {
  const client = (await s.json("/api/clients", { body: { name: `Northwind ${++clients}` } })).body.client;
  if (email) await s.json(`/api/clients/${client.id}`, { method: "PATCH", body: { email } });
  const id = (await s.json("/api/invoices", { body: { clientId: client.id, issueDate: "2026-11-01", dueDate: "2026-11-30" } })).body.invoice.id as string;
  expect((await s.json(`/api/invoices/${id}/lines`, { body: { description: "Design", quantity: 1000, unitPrice: 10_000 } })).status).toBe(201);
  if (status !== "draft") expect((await s.json(`/api/invoices/${id}`, { method: "PATCH", body: { status: "sent" } })).status).toBe(200);
  if (status === "paid") expect((await s.json(`/api/invoices/${id}`, { method: "PATCH", body: { status: "paid" } })).status).toBe(200);
  return id;
}

async function withSmtp(s: Awaited<ReturnType<typeof studio>>, work: (server: Awaited<ReturnType<typeof startFakeSmtp>>) => Promise<void>) {
  const server = await startFakeSmtp();
  try {
    expect((await s.json("/api/settings/email", { method: "PUT", body: smtp(server.port) })).status).toBe(200);
    await work(server);
  } finally {
    await server.close();
  }
}

describe("when reminders are due", () => {
  it("starts the chosen days after the due date, then every 7 days, up to 3, catching up with one", () => {
    expect(dueReminder("2026-11-30", 3, 0, "2026-12-02")).toBeNull();
    expect(dueReminder("2026-11-30", 3, 0, "2026-12-03")).toBe(0);
    expect(dueReminder("2026-11-30", 3, 1, "2026-12-09")).toBeNull();
    expect(dueReminder("2026-11-30", 3, 1, "2026-12-10")).toBe(1);
    expect(dueReminder("2026-11-30", 14, 0, "2026-12-14")).toBe(0);
    expect(dueReminder("2026-11-30", 3, 3, "2027-06-01")).toBeNull();
    // A server that was off for weeks sends the latest one, not all three at once.
    expect(dueReminder("2026-11-30", 3, 0, "2027-01-15")).toBe(2);
    expect(dueReminder("2026-11-30", 0, 0, "2027-01-15")).toBeNull();
  });
});

describe("late-payment reminders", () => {
  it("emails the client once per reminder, records each in the History, and stops after 3", async () => {
    const s = await studio();
    await withSmtp(s, async (server) => {
      await s.remindAfter(3);
      const id = await invoice(s);
      expect(await sweepReminders(at("2026-12-02T23:00:00Z"))).toBe(0);

      // Two sweeps at once send it once.
      const [a, b] = await Promise.all([sweepReminders(at("2026-12-03T09:00:00Z")), sweepReminders(at("2026-12-03T09:00:00Z"))]);
      expect(a + b).toBe(1);
      expect(await sweepReminders(at("2026-12-04T09:00:00Z"))).toBe(0);
      expect(server.received).toHaveLength(1);
      const mail = server.received[0]!;
      expect(mail.to).toEqual(["ap@northwind.test"]);
      expect(mail.subject).toBe("Reminder: invoice 0001 from Studio North");
      const body = mail.body.replace(/=\r?\n/g, "");
      expect(body).toContain("hasn't been paid yet");
      expect(body).toContain("$100.00");

      const got = (await s.json(`/api/invoices/${id}`)).body.invoice;
      expect(got).toMatchObject({ remindersSent: 1, remindersOff: false, emailedTo: "ap@northwind.test" });
      expect(got.lastReminderAt).toBe("2026-12-03T09:00:00.000Z");
      const events = await prisma.auditEvent.findMany({ where: { subjectId: id, actorName: "Late-payment reminder" } });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.changes)).toContain("Reminder 1 of 3 sent to ap@northwind.test");

      expect(await sweepReminders(at("2026-12-10T09:00:00Z"))).toBe(1);
      expect(await sweepReminders(at("2026-12-17T09:00:00Z"))).toBe(1);
      expect(await sweepReminders(at("2026-12-24T09:00:00Z"))).toBe(0);
      expect(await sweepReminders(at("2027-03-01T09:00:00Z"))).toBe(0);
      expect(server.received).toHaveLength(3);
      expect((await s.json(`/api/invoices/${id}`)).body.invoice.remindersSent).toBe(3);
    });
  });

  it("never reminds about a draft, a paid invoice, one switched off, or one without an address", async () => {
    const s = await studio();
    await withSmtp(s, async (server) => {
      await s.remindAfter(3);
      await invoice(s, { status: "draft" });
      await invoice(s, { status: "paid" });
      await invoice(s, { email: "" });
      const off = await invoice(s);
      const switched = await s.json(`/api/invoices/${off}/reminders`, { method: "PATCH", body: { off: true }, cookie: s.manager });
      expect(switched.status).toBe(200);
      expect(switched.body.invoice.remindersOff).toBe(true);
      expect(await sweepReminders(at("2026-12-20T09:00:00Z"))).toBe(0);
      expect(server.received).toHaveLength(0);

      // Switching back on: the next sweep reminds, and both switches are in the History.
      expect((await s.json(`/api/invoices/${off}/reminders`, { method: "PATCH", body: { off: false } })).status).toBe(200);
      expect(await sweepReminders(at("2026-12-20T09:00:00Z"))).toBe(1);
      const switches = await prisma.auditEvent.findMany({ where: { subjectId: off, actorName: { not: "Late-payment reminder" }, action: "changed" } });
      expect(switches.map((e) => JSON.stringify(e.changes)).filter((c) => c.includes('"reminders"'))).toHaveLength(2);
      expect((await s.json(`/api/invoices/${off}/reminders`, { method: "PATCH", body: { off: "yes" } })).status).toBe(400);
    });
  });

  it("sends nothing while the setting is off, or without email", async () => {
    const s = await studio();
    await invoice(s);
    await s.remindAfter(3);
    expect(await sweepReminders(at("2026-12-20T09:00:00Z"))).toBe(0); // no email set up
    await withSmtp(s, async (server) => {
      await s.remindAfter(0);
      expect(await sweepReminders(at("2026-12-20T09:00:00Z"))).toBe(0);
      expect(server.received).toHaveLength(0);
    });
  });

  it("undoes the claim when the email fails, so the next sweep tries again", async () => {
    const s = await studio();
    const server = await startFakeSmtp();
    expect((await s.json("/api/settings/email", { method: "PUT", body: smtp(server.port) })).status).toBe(200);
    await server.close();
    await s.remindAfter(3);
    const id = await invoice(s);
    expect(await sweepReminders(at("2026-12-03T09:00:00Z"))).toBe(0);
    const got = (await s.json(`/api/invoices/${id}`)).body.invoice;
    expect(got).toMatchObject({ remindersSent: 0, lastReminderAt: null });
  });

  it("goes by each organization's own date and setting", async () => {
    const north = await studio();
    const south = await studio("Studio South", "south.test");
    await withSmtp(north, async (server) => {
      // Auckland is already on Dec 3 at 12:00 UTC on Dec 2; Los Angeles is still on Dec 2.
      await north.remindAfter(3, "Pacific/Auckland");
      const northId = await invoice(north);
      expect((await south.json("/api/settings/email", { method: "PUT", body: smtp(server.port) })).status).toBe(200);
      await south.remindAfter(3, "America/Los_Angeles");
      const southId = await invoice(south);

      expect(await sweepReminders(at("2026-12-02T12:00:00Z"))).toBe(1);
      expect((await north.json(`/api/invoices/${northId}`)).body.invoice.remindersSent).toBe(1);
      expect((await south.json(`/api/invoices/${southId}`)).body.invoice.remindersSent).toBe(0);
      expect(await sweepReminders(at("2026-12-03T09:00:00Z"))).toBe(1);
      expect((await south.json(`/api/invoices/${southId}`)).body.invoice.remindersSent).toBe(1);

      // One organization can't switch another's invoice.
      expect((await north.json(`/api/invoices/${southId}/reminders`, { method: "PATCH", body: { off: true } })).status).toBe(404);
    });
  });

  it("is chosen in Manage → Invoicing: off, 3, 7 or 14 days; left out means unchanged", async () => {
    const s = await studio();
    const settings = (await s.json("/api/settings/invoices")).body.settings;
    expect(settings.reminderDays).toBe(0);
    const base = { prefix: "", nextNumber: "0001", dueDays: 30, taxPercent: "", taxLabel: "Tax", notes: "" };
    expect((await s.json("/api/settings/invoices", { method: "PUT", body: { ...base, reminderDays: 7 } })).body.settings.reminderDays).toBe(7);
    expect((await s.json("/api/settings/invoices", { method: "PUT", body: base })).body.settings.reminderDays).toBe(7);
    expect((await s.json("/api/settings/invoices", { method: "PUT", body: { ...base, reminderDays: 5 } })).status).toBe(400);
    expect((await s.json("/api/settings/invoices", { method: "PUT", body: { ...base, reminderDays: 0 }, cookie: s.manager })).status).toBe(403);
  });
});
