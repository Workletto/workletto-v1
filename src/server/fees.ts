import type { OrgDb } from "./db.ts";
import { currencies } from "./currency.ts";
import { formatMoney } from "../shared/money.ts";

// Fixed fee projects (WRK-134). A project with a fixedFee isn't billed by the hour (rateFor in
// billing.ts gives its time no rate). Its fee goes on invoices instead, in full or in parts, as
// "fee" lines that point back at the project. What's invoiced is always added up from those
// lines, on drafts too, so removing a line or deleting a draft makes that part billable again.
//
// Fee per phase (WRK-151): a fixed fee project can bill a fee on each of its tasks instead. Each
// task with a fee is a phase; the project's fixedFee is always their sum (setPhaseFees). Fee lines
// then point at their phase too, and each phase is billed within its own fee.

/** How much of each project's fee is on an invoice, in cents. */
export async function invoicedFees(db: OrgDb, projectIds: string[]) {
  if (!projectIds.length) return new Map<string, number>();
  const groups = await db.invoiceLine.groupBy({ by: ["projectId"], where: { kind: "fee", projectId: { in: projectIds } }, _sum: { amount: true } });
  return new Map(groups.map((g) => [g.projectId!, g._sum.amount ?? 0]));
}

/** How much of each phase's fee is on an invoice, in cents. */
export async function invoicedPhaseFees(db: OrgDb, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, number>();
  const groups = await db.invoiceLine.groupBy({ by: ["taskId"], where: { kind: "fee", taskId: { in: taskIds } }, _sum: { amount: true } });
  return new Map(groups.map((g) => [g.taskId!, g._sum.amount ?? 0]));
}

export type PhaseLeft = { taskId: string; title: string; fee: number; invoiced: number; left: number };
export type FeeLeft = { projectId: string; name: string; clientId: string | null; fee: number; invoiced: number; left: number; phases: PhaseLeft[] | null };

/** The phases of projects billed per phase, in the order they were added, with what's invoiced and left. */
export async function phasesOf(db: OrgDb, projectIds: string[]): Promise<Map<string, PhaseLeft[]>> {
  const tasks = projectIds.length
    ? await db.task.findMany({ where: { projectId: { in: projectIds }, fee: { not: null }, project: { feeByPhase: true } }, select: { id: true, projectId: true, title: true, fee: true }, orderBy: { createdAt: "asc" } })
    : [];
  const invoiced = await invoicedPhaseFees(db, tasks.map((t) => t.id));
  const out = new Map<string, PhaseLeft[]>();
  for (const t of tasks) {
    const done = invoiced.get(t.id) ?? 0;
    out.set(t.projectId, [...(out.get(t.projectId) ?? []), { taskId: t.id, title: t.title, fee: t.fee!, invoiced: done, left: t.fee! - done }]);
  }
  return out;
}

/** Fixed fee projects (for one client, or every client) with what's invoiced and what's left to bill. */
export async function feesLeft(db: OrgDb, clientId: string | null): Promise<FeeLeft[]> {
  const projects = await db.project.findMany({
    where: { fixedFee: { not: null }, ...(clientId ? { clientId } : { clientId: { not: null } }) },
    select: { id: true, name: true, clientId: true, fixedFee: true, feeByPhase: true },
    orderBy: { name: "asc" },
  });
  const [invoiced, phases] = await Promise.all([invoicedFees(db, projects.map((p) => p.id)), phasesOf(db, projects.filter((p) => p.feeByPhase).map((p) => p.id))]);
  return projects.map((p) => {
    const done = invoiced.get(p.id) ?? 0;
    return { projectId: p.id, name: p.name, clientId: p.clientId, fee: p.fixedFee!, invoiced: done, left: p.fixedFee! - done, phases: p.feeByPhase ? phases.get(p.id) ?? [] : null };
  });
}

/**
 * Inside a transaction: locks a fixed fee project until the transaction ends, so two invoices
 * made at once can't both bill the same part of its fee, then says what's left. On a project
 * billed per phase, `taskId` names the phase, and what's left is that phase's. Null if it isn't a
 * fixed fee project (of this client, when one is given), or the phase doesn't fit the project.
 */
export async function holdFee(tx: OrgDb, projectId: string, clientId?: string, taskId?: string | null) {
  const project = await tx.project.findFirst({ where: { id: projectId, fixedFee: { not: null }, ...(clientId ? { clientId } : {}) }, select: { name: true, fixedFee: true, feeByPhase: true } });
  if (!project) return null;
  // Writing the fee back unchanged takes the row lock; a fee changed meanwhile matches nothing.
  // Phase fees change only with the project held (setPhaseFees), so the lock covers them too.
  const { count } = await tx.project.updateMany({ where: { id: projectId, fixedFee: project.fixedFee }, data: { fixedFee: project.fixedFee } });
  if (!count) return null;
  if (project.feeByPhase) {
    if (!taskId) return null;
    const phase = await tx.task.findFirst({ where: { id: taskId, projectId, fee: { not: null } }, select: { title: true, fee: true } });
    if (!phase) return null;
    const invoiced = (await invoicedPhaseFees(tx, [taskId])).get(taskId) ?? 0;
    return { name: `${project.name} – ${phase.title}`, projectName: project.name, phase: phase.title, fee: phase.fee!, invoiced, left: phase.fee! - invoiced };
  }
  if (taskId) return null;
  const invoiced = (await invoicedFees(tx, [projectId])).get(projectId) ?? 0;
  return { name: project.name, projectName: project.name, phase: null, fee: project.fixedFee!, invoiced, left: project.fixedFee! - invoiced };
}

export class PhaseProblem extends Error {}

/**
 * Sets the phase fees of a project billed per phase ({ taskId: cents, or null for not a phase }),
 * with the project held, and makes the project's fee their sum. A phase can't drop below what's
 * already invoiced of it. Returns the changes for the History.
 */
export async function setPhaseFees(tx: OrgDb, projectId: string, fees: Map<string, number | null>) {
  const project = await tx.project.findFirst({ where: { id: projectId }, select: { fixedFee: true, feeByPhase: true, client: { select: { currency: true } } } });
  if (!project?.feeByPhase || project.fixedFee === null) throw new PhaseProblem("This project isn't billed per phase.");
  const currency = project.client?.currency ?? (await currencies(tx)).home;
  const { count } = await tx.project.updateMany({ where: { id: projectId, fixedFee: project.fixedFee }, data: { fixedFee: project.fixedFee } });
  if (!count) throw new PhaseProblem("This project's fee just changed. Reload the page and try again.");
  const tasks = await tx.task.findMany({ where: { projectId }, select: { id: true, title: true, fee: true } });
  const invoiced = await invoicedPhaseFees(tx, tasks.map((t) => t.id));
  const changes: { field: string; from: number | null; to: number | null }[] = [];
  for (const t of tasks) {
    if (!fees.has(t.id)) continue;
    const fee = fees.get(t.id)!;
    const done = invoiced.get(t.id) ?? 0;
    if (done > 0 && (fee === null || fee < done)) throw new PhaseProblem(`${formatMoney(done, currency)} of the ${t.title} fee is already on invoices, so it can't be less than that.`);
    if (fee !== t.fee) {
      await tx.task.updateMany({ where: { id: t.id }, data: { fee } });
      changes.push({ field: `phase: ${t.title}`, from: t.fee, to: fee });
    }
  }
  const sum = (await tx.task.aggregate({ where: { projectId, fee: { not: null } }, _sum: { fee: true } }))._sum.fee ?? 0;
  if (sum !== project.fixedFee) {
    await tx.project.updateMany({ where: { id: projectId }, data: { fixedFee: sum } });
    changes.push({ field: "fixedFee", from: project.fixedFee, to: sum });
  }
  return changes;
}
