import { canManageWork } from "../shared/roles.ts";
import { dayOf } from "../shared/time.ts";
import { lineAmount } from "../shared/invoiceMath.ts";

// Rates, amounts and who can work on which project. Amounts are worked out
// from entries whenever they're needed; only invoices keep their own copy.

type ProjectRates = { billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null };

/**
 * The hourly rate (in cents) billable time on this project is charged at, for this person. None on a
 * fixed fee project: its time isn't billed by the hour, so it has no value of its own anywhere
 * (invoices, reports, budgets); the fee is invoiced instead (invoices.ts).
 */
export function rateFor(project: ProjectRates, person: { hourlyRate: number | null }): number | null {
  if (project.fixedFee !== null) return null;
  return project.billBy === "project" ? project.hourlyRate : person.hourlyRate;
}

/** The value of some seconds at a rate, in (fractional) cents. Round only the final total. */
export const valueOf = (seconds: number, rate: number | null) => (rate ? (seconds * rate) / 3600 : 0);

/** Thousandths of an hour: the quantity on an invoice's time line. */
export const hoursQuantity = (seconds: number) => Math.round(seconds / 3.6);

/**
 * What a time line on an invoice charges: its quantity (hours to three decimals) times its
 * rate, like every other line, so the client can check it with a calculator (QA-37). Reports
 * value the exact seconds instead, so the two can differ by a few cents.
 */
export const timeLineAmount = (seconds: number, unitPrice: number) => lineAmount(hoursQuantity(seconds), unitPrice);

export const GROUPINGS = ["project", "person", "task", "entry"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/** What turning time into invoice lines needs to know about each entry. */
export type BillableEntry = {
  id: string;
  date: Date;
  seconds: number;
  notes: string;
  user: { id: string; name: string; hourlyRate: number | null };
  task: { id: string; title: string } | null;
  project: ProjectRates & { id: string; name: string };
};

/**
 * Turns time into invoice lines. Projects billed by person get a line per person, since rates differ.
 * A line's amount is Math.round(valueOf(line.seconds, line.unitPrice)): money comes from the exact seconds.
 */
export function timeLines(entries: BillableEntry[], grouping: Grouping) {
  const lines = new Map<string, { description: string; seconds: number; unitPrice: number; entryIds: string[] }>();
  for (const e of entries) {
    const rate = rateFor(e.project, e.user) ?? 0;
    const byPerson = grouping === "person" || (grouping === "project" && e.project.billBy === "person");
    let key: string;
    let description: string;
    if (grouping === "entry") {
      key = e.id;
      description = `${dayOf(e.date)} · ${e.project.name}${e.task ? ` – ${e.task.title}` : ""}${e.notes ? `: ${e.notes}` : ""}`;
    } else if (grouping === "task") {
      key = `${e.project.id}|${e.task?.id ?? ""}|${rate}`;
      description = `${e.project.name} – ${e.task?.title ?? "Other work"}`;
    } else if (byPerson) {
      key = `${e.project.id}|${e.user.id}|${rate}`;
      description = `${e.project.name} – ${e.user.name}`;
    } else {
      key = `${e.project.id}|${rate}`;
      description = e.project.name;
    }
    const line = lines.get(key) ?? { description, seconds: 0, unitPrice: rate, entryIds: [] };
    line.seconds += e.seconds;
    line.entryIds.push(e.id);
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => (grouping === "entry" ? 0 : a.description.localeCompare(b.description)));
}

/**
 * A filter for the projects someone may see and track time on: everything for
 * admins and managers; for members, projects open to everyone or that they're on.
 */
export function projectsFor(user: { id: string; role: string }) {
  if (canManageWork(user.role)) return {};
  return { OR: [{ everyone: true }, { members: { some: { userId: user.id } } }] };
}
