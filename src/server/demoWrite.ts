import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.ts";
import type { DemoDataset } from "./demoDataset.ts";
import { asDate } from "../shared/time.ts";

/** What a demo person costs: a little over half their billable rate, in whole dollars, so profitability looks real. */
const demoCostRate = (hourlyRate: number) => Math.round((hourlyRate * 0.55) / 100) * 100;

const CHUNK = 1000; // rows per insert, to stay under Postgres's limit on query parameters

async function insert<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK));
}

/**
 * Writes a generated dataset into one organization, with fresh ids. The admin (the dataset's first
 * person, "You") already exists; the others are created with emails at `domain`. Everything goes in
 * with createMany, parents before children, and entries and expenses are inserted already pointing
 * at their invoice lines.
 */
export async function writeDataset(tx: Prisma.TransactionClient, organizationId: string, adminUserId: string, domain: string, data: DemoDataset) {
  const { currency } = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } });
  const id = new Map<string, string>();
  const idOf = (key: string) => id.get(key)!;
  const fresh = (key: string) => id.set(key, randomUUID()).get(key)!;

  const admin = data.people[0]!;
  id.set(admin.key, adminUserId);
  const others = data.people.slice(1);
  await tx.user.createMany({
    data: others.map((p) => ({
      id: fresh(p.key), organizationId, name: p.name, email: `${p.name.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`,
      role: p.role, hourlyRate: p.hourlyRate, costRate: demoCostRate(p.hourlyRate), createdAt: asDate(p.joined < data.windowStart ? data.windowStart : p.joined),
      // Someone who left keeps their history but can't sign in.
      deactivatedAt: p.left ? asDate(p.left) : null,
    })),
  });

  await tx.client.createMany({
    data: data.clients.map((c) => ({
      id: fresh(c.key), organizationId, name: c.name, email: c.email, address: c.address, currency: c.currency ?? currency, archived: c.archived, createdAt: asDate(data.windowStart),
    })),
  });
  await tx.project.createMany({
    data: data.projects.map((p) => ({
      id: fresh(p.key), organizationId, name: p.name, clientId: p.clientKey ? idOf(p.clientKey) : null, billable: p.billable, billBy: p.billBy,
      hourlyRate: p.hourlyRate, fixedFee: p.fixedFee, feeByPhase: p.feeByPhase ?? false, budgetBy: p.budgetBy, budgetSeconds: p.budgetSeconds, budgetAmount: p.budgetAmount,
      archived: p.archived,
      createdAt: asDate(p.startDate ?? data.windowStart),
    })),
  });
  await tx.user.update({ where: { id: adminUserId }, data: { hourlyRate: admin.hourlyRate, costRate: demoCostRate(admin.hourlyRate) } });

  await tx.task.createMany({
    data: data.tasks.map((t) => ({
      id: fresh(t.key), organizationId, projectId: idOf(t.projectKey), title: t.title, status: t.status,
      assigneeId: t.assigneeKey ? idOf(t.assigneeKey) : null, dueDate: t.dueDate ? asDate(t.dueDate) : null,
      completedAt: t.completedAt ? new Date(t.completedAt) : null, fee: t.fee ?? null,
    })),
  });

  const clientCurrency = new Map(data.clients.map((c) => [c.key, c.currency ?? currency]));
  await tx.invoice.createMany({
    data: data.invoices.map((i) => {
      // A fee or a monthly charge is for no particular period.
      const forWork = i.lines.some((l) => l.kind === "time" || l.kind === "expense");
      return {
        id: fresh(i.key), organizationId, clientId: idOf(i.clientKey), number: i.number, status: i.status, issueDate: asDate(i.issueDate),
        dueDate: asDate(i.dueDate), periodFrom: forWork ? asDate(i.periodFrom) : null, periodTo: forWork ? asDate(i.periodTo) : null,
        currency: clientCurrency.get(i.clientKey)!, notes: i.notes,
        sentAt: i.sentAt ? new Date(i.sentAt) : null, paidAt: i.paidAt ? new Date(i.paidAt) : null,
        remindersSent: i.remindersSent ?? 0, lastReminderAt: i.lastReminderAt ? new Date(i.lastReminderAt) : null,
        emailedAt: i.lastReminderAt ? new Date(i.lastReminderAt) : null,
      };
    }),
  });
  // The dataset numbers its invoices 0001, 0002…; new ones carry on from there.
  await tx.organization.update({ where: { id: organizationId }, data: { invoiceNextNumber: data.invoices.length + 1 } });
  const lineOfEntry = new Map<string, string>();
  const lineOfExpense = new Map<string, string>();
  const lines: Prisma.InvoiceLineCreateManyInput[] = [];
  for (const invoice of data.invoices) {
    invoice.lines.forEach((l, position) => {
      const lineId = randomUUID();
      for (const k of l.entryKeys) lineOfEntry.set(k, lineId);
      for (const k of l.expenseKeys) lineOfExpense.set(k, lineId);
      lines.push({
        id: lineId, organizationId, invoiceId: idOf(invoice.key), position, kind: l.kind, description: l.description,
        quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount,
        projectId: l.projectKey ? idOf(l.projectKey) : null, taskId: l.taskKey ? idOf(l.taskKey) : null,
      });
    });
  }
  await insert(lines, (chunk) => tx.invoiceLine.createMany({ data: chunk }));

  const entryIds = new Map(data.entries.map((e) => [e.key, randomUUID()]));
  await insert(data.entries, (chunk) =>
    tx.timeEntry.createMany({
      data: chunk.map((e) => ({
        id: entryIds.get(e.key)!, organizationId, userId: idOf(e.personKey), projectId: idOf(e.projectKey), taskId: e.taskKey ? idOf(e.taskKey) : null,
        date: asDate(e.date), seconds: e.seconds, notes: e.notes, billable: e.billable, invoiceLineId: lineOfEntry.get(e.key) ?? null,
      })),
    }),
  );
  await insert(data.expenses, (chunk) =>
    tx.expense.createMany({
      data: chunk.map((x) => ({
        id: randomUUID(), organizationId, userId: idOf(x.personKey), projectId: idOf(x.projectKey), date: asDate(x.date), category: x.category,
        amount: x.amount, notes: x.notes, billable: x.billable, invoiceLineId: lineOfExpense.get(x.key) ?? null,
      })),
    }),
  );
  await writeShowcase(tx, organizationId, data, idOf, (key) => entryIds.get(key)!);
  return { people: data.people.length, entries: data.entries.length, invoices: data.invoices.length };
}

/** The newer features (demoShowcase.ts): settings, time off, holidays, plans, a repeating invoice, fields, groups, a template. */
async function writeShowcase(tx: Prisma.TransactionClient, organizationId: string, data: DemoDataset, idOf: (key: string) => string, entryId: (key: string) => string) {
  await tx.organization.update({ where: { id: organizationId }, data: { exchangeRates: data.exchangeRates ?? {}, invoiceReminderDays: data.invoiceReminderDays ?? 0 } });
  await tx.timeOff.createMany({ data: (data.timeOff ?? []).map((t) => ({ organizationId, userId: idOf(t.personKey), date: asDate(t.date), kind: t.kind, status: t.status, note: t.note })) });
  await tx.holiday.createMany({ data: (data.holidays ?? []).map((h) => ({ organizationId, date: asDate(h.date), name: h.name })) });
  await tx.scheduledWork.createMany({ data: (data.schedule ?? []).map((p) => ({ organizationId, userId: idOf(p.personKey), projectId: idOf(p.projectKey), weekStart: asDate(p.weekStart), minutes: p.minutes })) });
  await tx.invoiceSchedule.createMany({
    data: data.invoices.filter((i) => i.repeat).map((i) => ({ organizationId, invoiceId: idOf(i.key), every: i.repeat!.every, startDate: asDate(i.repeat!.startDate) })),
  });
  const fieldIds = new Map((data.fields ?? []).map((f) => [f.key, randomUUID()]));
  await tx.customField.createMany({
    data: (data.fields ?? []).map((f) => ({ id: fieldIds.get(f.key)!, organizationId, name: f.name, appliesTo: f.appliesTo, type: f.type, choices: f.choices })),
  });
  await insert(data.fieldValues ?? [], (chunk) =>
    tx.customFieldValue.createMany({
      data: chunk.map((v) => ({
        organizationId, fieldId: fieldIds.get(v.fieldKey)!, value: v.value,
        timeEntryId: v.entryKey ? entryId(v.entryKey) : null, projectId: v.projectKey ? idOf(v.projectKey) : null,
      })),
    }),
  );
  for (const group of data.groups ?? []) {
    const id = randomUUID();
    await tx.userGroup.create({ data: { id, organizationId, name: group.name } });
    await tx.userGroupMember.createMany({ data: group.memberKeys.map((k) => ({ organizationId, groupId: id, userId: idOf(k) })) });
  }
  for (const template of data.templates ?? []) {
    const project = data.projects.find((p) => p.key === template.projectKey)!;
    const tasks = data.tasks.filter((t) => t.projectKey === project.key).map((t) => ({ title: t.title, notes: "", fee: null }));
    await tx.projectTemplate.create({
      data: {
        organizationId, name: template.name, billable: project.billable, billBy: project.billBy, hourlyRate: project.hourlyRate, fixedFee: project.fixedFee,
        budgetBy: project.budgetBy, budgetSeconds: project.budgetSeconds, budgetAmount: project.budgetAmount, tasks,
      },
    });
  }
}
