import { addDays, startOfWeek } from "../shared/time.ts";
import type { DemoDataset, DemoInvoice } from "./demoDataset.ts";

// The demo's newer features (WRK-145): what the app gained after the first dataset (WRK-93), added
// to the generated studio so a visitor sees them in use. Still a pure function of the dataset: no
// randomness beyond the dataset's own, and nothing that changes how many hours anyone worked. The
// two fee projects take over some of this month's not-yet-invoiced hours from other projects.

export type DemoTimeOff = { personKey: string; date: string; kind: "vacation" | "sick" | "other"; status: "approved" | "pending"; note: string };
export type DemoHoliday = { date: string; name: string };
export type DemoPlan = { personKey: string; projectKey: string; weekStart: string; minutes: number };
export type DemoField = { key: string; name: string; appliesTo: "time" | "project"; type: "choice" | "text"; choices: string[] };
export type DemoFieldValue = { fieldKey: string; entryKey?: string; projectKey?: string; value: string };
export type DemoGroup = { name: string; memberKeys: string[] };
export type DemoShowcase = {
  /** Home-currency value of one unit of each other currency, in millionths. */
  exchangeRates: Record<string, number>;
  invoiceReminderDays: number;
  timeOff: DemoTimeOff[]; holidays: DemoHoliday[]; schedule: DemoPlan[];
  fields: DemoField[]; fieldValues: DemoFieldValue[]; groups: DemoGroup[];
  templates: { name: string; projectKey: string }[];
};

const isWeekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
/** A stable number from a string, for choices that must not depend on Math.random. */
const hash = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** People by what they do, for the user groups. Keys are the dataset's (p0 = the first person). */
const DISCIPLINES: Record<string, string[]> = {
  Strategy: ["p0", "p1", "p2"],
  Design: ["p3", "p5", "p6", "p8", "p11", "p13"],
  Development: ["p4", "p7", "p10", "p12"],
  Content: ["p9"],
};

const PHASES: [string, number][] = [["Schematic Design", 600_000], ["Design Development", 950_000], ["Construction Documents", 1_200_000]];
const FIXED_FEE = 1_800_000;
const MONTHLY_SUPPORT = 45_000;

export function addShowcase(data: DemoDataset): DemoDataset & DemoShowcase {
  const { today } = data;
  const monthStart = `${today.slice(0, 7)}-01`;
  const [y, m] = today.split("-").map(Number) as [number, number];
  const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
  const people = data.people.filter((p) => p.left === null);
  const clients = data.clients.map((c) => ({ ...c }));
  const projects = data.projects.map((p) => ({ ...p }));
  const tasks = [...data.tasks];
  const entries = data.entries.map((e) => ({ ...e }));
  let invoices: DemoInvoice[] = data.invoices.map((i) => ({ ...i }));

  const running = projects.filter((p) => p.billable && p.clientKey && !p.archived && p.startDate! <= today && (p.endDate === null || p.endDate >= today));
  const retainers = running.filter((p) => p.endDate === null).sort((a, b) => a.key.localeCompare(b.key));

  // A client billed in euros: one of the monthly retainers, so its invoices show the currency.
  const euro = retainers[1 % Math.max(1, retainers.length)]?.clientKey ?? null;
  for (const c of clients) if (c.key === euro) c.currency = "EUR";

  // Two new projects for active clients (an architects' practice if the studio has one): a fixed
  // fee, and a fee per phase. Both started this month.
  const candidates = clients.filter((c) => !c.archived && c.key !== euro && running.some((p) => p.clientKey === c.key)).map((c) => c.key);
  const architects = clients.find((c) => c.name.includes("Architects") && candidates.includes(c.key))?.key;
  const phaseClient = architects ?? candidates[0]!;
  const feeClient = candidates.find((k) => k !== phaseClient) ?? phaseClient;
  // A library for architects; for anyone else, their own new premises.
  const phasedName = architects ? "Riverside Library" : "New premises fit-out";
  const end = addDays(monthStart, 120);
  projects.push(
    { key: "sx1", name: "Tenant handbook", clientKey: feeClient, billable: true, billBy: "project", hourlyRate: null, fixedFee: FIXED_FEE, budgetBy: "hours", budgetSeconds: 120 * 3600, budgetAmount: null, startDate: monthStart, endDate: end, archived: false },
    { key: "sx2", name: phasedName, clientKey: phaseClient, billable: true, billBy: "project", hourlyRate: null, fixedFee: PHASES.reduce((s, [, f]) => s + f, 0), feeByPhase: true, budgetBy: "none", budgetSeconds: null, budgetAmount: null, startDate: monthStart, endDate: end, archived: false },
  );
  PHASES.forEach(([title, fee], i) => tasks.push({ key: `sxt${i}`, projectKey: "sx2", title, status: i === 0 ? "in_progress" : "todo", assigneeKey: null, dueDate: addDays(monthStart, 30 * (i + 1)), completedAt: null, fee }));

  // Their hours: some of this month's (never invoiced) hours on other hourly client projects.
  const invoiced = new Set(invoices.flatMap((i) => i.lines.flatMap((l) => l.entryKeys)));
  const movable = entries.filter((e) => e.date >= monthStart && !invoiced.has(e.key) && running.some((p) => p.key === e.projectKey && p.endDate !== null));
  movable.forEach((e, i) => {
    if (i % 5 === 0) {
      e.projectKey = "sx1";
      e.taskKey = null;
    } else if (i % 5 === 1) {
      e.projectKey = "sx2";
      e.taskKey = hash(e.key) % 3 === 0 ? "sxt1" : "sxt0";
    }
  });

  // Their invoices: a deposit on the fixed fee, part of the first phase, and a monthly support
  // invoice that repeats.
  const due = addDays(monthStart, 30);
  const sent = `${monthStart}T10:00:00.000Z`;
  const showcase: DemoInvoice[] = [
    { key: "sxi1", number: "", clientKey: feeClient, status: "sent", issueDate: monthStart, dueDate: due, periodFrom: monthStart, periodTo: monthStart, notes: "Deposit: 30% of the agreed fee.", sentAt: sent, paidAt: null,
      lines: [{ kind: "fee", description: "Tenant handbook – fixed fee", quantity: 1000, unitPrice: FIXED_FEE * 0.3, amount: FIXED_FEE * 0.3, entryKeys: [], expenseKeys: [], projectKey: "sx1" }] },
    { key: "sxi2", number: "", clientKey: phaseClient, status: "sent", issueDate: monthStart, dueDate: due, periodFrom: monthStart, periodTo: monthStart, notes: "Schematic Design, first half.", sentAt: sent, paidAt: null,
      lines: [{ kind: "fee", description: `${phasedName} – Schematic Design – fixed fee`, quantity: 1000, unitPrice: PHASES[0]![1] / 2, amount: PHASES[0]![1] / 2, entryKeys: [], expenseKeys: [], projectKey: "sx2", taskKey: "sxt0" }] },
    { key: "sxi3", number: "", clientKey: feeClient, status: "sent", issueDate: monthStart, dueDate: due, periodFrom: monthStart, periodTo: monthStart, notes: "", sentAt: sent, paidAt: null,
      lines: [{ kind: "custom", description: "Website hosting and support, monthly", quantity: 1000, unitPrice: MONTHLY_SUPPORT, amount: MONTHLY_SUPPORT, entryKeys: [], expenseKeys: [] }],
      repeat: { every: "month", startDate: nextMonth } },
  ];
  invoices = [...invoices, ...showcase];

  // Late-payment reminders already went out on the oldest overdue invoice: every one due by today,
  // 7 days after its due date and then weekly, up to 3, so the invoice page says what really happened.
  const overdue = invoices.filter((i) => i.status === "sent" && i.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const reminders = overdue ? [7, 14, 21].map((d) => addDays(overdue.dueDate, d)).filter((d) => d <= today) : [];
  if (overdue && reminders.length) Object.assign(overdue, { remindersSent: reminders.length, lastReminderAt: `${reminders[reminders.length - 1]}T09:00:00.000Z` });

  // Invoices stay numbered in the order they were issued.
  const clientName = new Map(clients.map((c) => [c.key, c.name]));
  invoices.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || clientName.get(a.clientKey)!.localeCompare(clientName.get(b.clientKey)!) || a.key.localeCompare(b.key));
  invoices.forEach((inv, i) => (inv.number = String(i + 1).padStart(4, "0")));

  // Coming weeks: time off for two people, a studio holiday, and four weeks of plans.
  const monday = addDays(startOfWeek(today), 7);
  // The planned people are the first seven after the admin; the two who are away aren't among them,
  // so nobody is booked on a day off. The studio holiday falls in the week after the plans.
  const planned = people.filter((p) => p.role !== "admin").slice(0, 7);
  const unplanned = people.filter((p) => p.role === "member" && !planned.includes(p));
  const [away1, away2] = [unplanned[0], unplanned[1]];
  const busy = planned[5] ?? planned[0];
  const timeOff: DemoTimeOff[] = [];
  if (away1) for (let d = 0; d < 5; d++) timeOff.push({ personKey: away1.key, date: addDays(monday, 7 + d), kind: "vacation", status: "approved", note: "Family holiday" });
  if (away2) {
    timeOff.push({ personKey: away2.key, date: addDays(monday, 2), kind: "other", status: "approved", note: "Moving house" });
    timeOff.push({ personKey: away2.key, date: addDays(monday, 3), kind: "other", status: "approved", note: "Moving house" });
    timeOff.push({ personKey: away2.key, date: addDays(monday, 18), kind: "vacation", status: "pending", note: "" });
  }
  const holidays: DemoHoliday[] = [{ date: addDays(monday, 22), name: "Studio away day" }].filter((h) => isWeekday(h.date));

  const thisMonday = startOfWeek(today);
  const plannable = [...running.filter((p) => p.endDate !== null), ...projects.filter((p) => p.key.startsWith("sx"))].map((p) => p.key);
  const schedule: DemoPlan[] = [];
  planned.forEach((p, n) => {
    for (let w = 0; w < 4; w++) {
      const weekStart = addDays(thisMonday, 7 * w);
      const first = plannable[(n + w) % plannable.length]!;
      const second = plannable[(n + w + 3) % plannable.length]!;
      // One person is booked over their week in the second week.
      const over = p.key === busy?.key && w === 1;
      schedule.push({ personKey: p.key, projectKey: first, weekStart, minutes: (over ? 30 : 20) * 60 });
      if (second !== first) schedule.push({ personKey: p.key, projectKey: second, weekStart, minutes: (over ? 16 : 12 + ((n + w) % 3) * 2) * 60 });
    }
  });

  // Custom fields: the phase of work on recent time, and a PO number on the fee projects.
  const fields: DemoField[] = [
    { key: "f0", name: "Phase", appliesTo: "time", type: "choice", choices: ["Discovery", "Design", "Build", "Review"] },
    { key: "f1", name: "PO number", appliesTo: "project", type: "text", choices: [] },
  ];
  const billableClientProjects = new Set(projects.filter((p) => p.billable && p.clientKey).map((p) => p.key));
  const fieldValues: DemoFieldValue[] = [
    ...entries.filter((e) => e.date >= addDays(today, -21) && billableClientProjects.has(e.projectKey))
      .map((e) => ({ fieldKey: "f0", entryKey: e.key, value: fields[0]!.choices[hash(e.key) % 4]! })),
    { fieldKey: "f1", projectKey: "sx1", value: "PO-48213" },
    { fieldKey: "f1", projectKey: "sx2", value: "RL-2026-07" },
  ];

  const present = new Set(people.map((p) => p.key));
  const groups = Object.entries(DISCIPLINES).map(([name, keys]) => ({ name, memberKeys: keys.filter((k) => present.has(k)) })).filter((g) => g.memberKeys.length);
  const template = running.find((p) => p.endDate !== null && p.billBy === "project");

  return {
    ...data, clients, projects, tasks, entries, invoices,
    exchangeRates: euro ? { EUR: 1_080_000 } : {},
    invoiceReminderDays: 7,
    timeOff, holidays, schedule, fields, fieldValues, groups,
    templates: template ? [{ name: "Website project", projectKey: template.key }] : [],
  };
}
