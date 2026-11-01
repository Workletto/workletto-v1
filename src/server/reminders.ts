// Late-payment reminders (WRK-146): when an organization turns them on (Manage → Invoices), a
// sent, unpaid invoice gets an email reminder some days after its due date, then one every
// 7 days, up to 3. Dates are the organization's own (its time zone). A draft, a paid invoice,
// one with an online payment under way, or one switched to "Don't remind" never gets one.

import type { OrgDb } from "./db.ts";
import { orgDb, prisma } from "./db.ts";
import { isDemoMode } from "./env.ts";
import { recordAudit } from "./audit.ts";
import { describeError } from "./logging.ts";
import { isEmailConfigured, sendMail } from "./mail.ts";
import { payLinkFor } from "./payments.ts";
import { localNow } from "./timesheets.ts";
import { INVOICE_SELECT, invoiceEmail, toInvoice } from "./invoices.ts";
import { displayAppName } from "../shared/product.ts";
import { dayOrNull, longDay } from "../shared/time.ts";
import { dueReminder, MAX_REMINDERS } from "../shared/reminders.ts";

/** Who the History says sent a reminder. */
export const REMINDER = { id: null, name: "Late-payment reminder" };

const REMINDABLE = {
  status: "sent" as const,
  remindersOff: false,
  remindersSent: { lt: MAX_REMINDERS },
  payments: { none: { status: { in: ["processing" as const, "paid" as const] } } },
};

/**
 * Sends the reminders due by `today` (the organization's date) for one organization. Each is
 * claimed first (remindersSent moves on only if nobody moved it meanwhile), so two sweeps at once
 * send it once. If the email fails, the claim is undone and the next sweep tries again.
 */
export async function sendDueReminders(db: OrgDb, today: string, now = new Date()): Promise<number> {
  const org = await db.organization.findFirstOrThrow({ select: { name: true, appName: true, accentColor: true, invoiceReminderDays: true } });
  if (org.invoiceReminderDays <= 0 || !(await isEmailConfigured(db))) return 0;
  const candidates = await db.invoice.findMany({
    where: { ...REMINDABLE, dueDate: { lt: new Date(`${today}T00:00:00Z`) } },
    select: { id: true, dueDate: true, remindersSent: true, lastReminderAt: true },
  });
  let sent = 0;
  for (const candidate of candidates) {
    const n = dueReminder(dayOrNull(candidate.dueDate)!, org.invoiceReminderDays, candidate.remindersSent, today);
    if (n === null) continue;
    const { count } = await db.invoice.updateMany({
      where: { id: candidate.id, ...REMINDABLE, remindersSent: candidate.remindersSent },
      data: { remindersSent: n + 1, lastReminderAt: now },
    });
    if (count !== 1) continue;
    const row = await db.invoice.findFirstOrThrow({ where: { id: candidate.id }, select: INVOICE_SELECT });
    const to = (row.emailedTo || row.client.email || "").trim();
    const undo = () => db.invoice.updateMany({ where: { id: row.id, remindersSent: n + 1, lastReminderAt: now }, data: { remindersSent: candidate.remindersSent, lastReminderAt: candidate.lastReminderAt } });
    if (!to) {
      await undo();
      continue;
    }
    const invoice = toInvoice(row);
    const message = `This invoice was due on ${longDay(invoice.dueDate)} and hasn't been paid yet. If you've already paid it, thank you, and please ignore this reminder.`;
    const mail = invoiceEmail(to, invoice, row.fromName ?? org.name, true, message, await payLinkFor(db, row.id), { name: displayAppName(org), accentColor: org.accentColor });
    const result = await sendMail(db, mail);
    if (!result.ok) {
      await undo();
      console.error("A late-payment reminder couldn't be sent", describeError(new Error(result.error)));
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.invoice.updateMany({ where: { id: row.id }, data: { emailedAt: now, emailedTo: to } });
      await recordAudit(tx as OrgDb, REMINDER, {
        kind: "invoice", action: "changed", subjectId: row.id, label: `Invoice ${row.number} · ${row.client.name}`, currency: row.currency,
        changes: [{ field: "reminder", from: null, to: `Reminder ${n + 1} of ${MAX_REMINDERS} sent to ${to}` }],
      });
    });
    sent++;
  }
  return sent;
}

/** Every organization's due reminders, on its own date. Runs every few minutes. Returns how many went out. */
export async function sweepReminders(now = new Date()): Promise<number> {
  if (isDemoMode()) return 0;
  const orgs = await prisma.organization.findMany({ where: { invoiceReminderDays: { gt: 0 }, demoExpiresAt: null }, select: { id: true, timeZone: true } });
  let sent = 0;
  for (const org of orgs) {
    try {
      sent += await sendDueReminders(orgDb(org.id), localNow(org.timeZone, now).date, now);
    } catch (error) {
      console.error("Late-payment reminders failed for one organization", describeError(error));
    }
  }
  return sent;
}
