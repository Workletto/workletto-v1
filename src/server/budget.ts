import type { OrgDb } from "./db.ts";
import { rateFor, valueOf } from "./billing.ts";
import { env } from "./env.ts";
import { escapeHtml, isEmailConfigured, sendMail } from "./mail.ts";
import { PLACEHOLDER_DOMAIN } from "./people.ts";
import { formatMoney } from "../shared/money.ts";
import { formatDuration } from "../shared/time.ts";
import { describeError } from "./logging.ts";

// Budget alerts. When a project's time reaches 80%, and then 100%, of its budget,
// admins and managers see it on the Projects screen and, if email is on, get an
// email. The project remembers the level it last reached (budgetAlertLevel), so
// each level is sent once. Dropping back below a level (time deleted, budget
// raised) re-arms it. Changing the budget itself never sends one: whoever
// changed it already knows. Running timers count once they stop.

export const BUDGET_LEVELS = [80, 100] as const;
export type BudgetLevel = 0 | (typeof BUDGET_LEVELS)[number];

type Rates = { billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null };
type Budget = Rates & { budgetBy: "none" | "hours" | "fees"; budgetSeconds: number | null; budgetAmount: number | null };
type TimeRow = { userId: string; billable: boolean; seconds: number };
export type Totals = { seconds: number; billableSeconds: number; billableAmount: number };

/** A project's time, billable time and billable value (in cents, rounded once at the end). */
export function sumTotals(project: Rates, rows: TimeRow[], person: (userId: string) => { hourlyRate: number | null }): Totals {
  let seconds = 0;
  let billableSeconds = 0;
  let billableAmount = 0;
  for (const r of rows) {
    seconds += r.seconds;
    if (!r.billable) continue;
    billableSeconds += r.seconds;
    billableAmount += valueOf(r.seconds, rateFor(project, person(r.userId)));
  }
  return { seconds, billableSeconds, billableAmount: Math.round(billableAmount) };
}

/**
 * Each project's totals, the one way they're counted everywhere: saved time per person (so
 * person rates apply), plus, with `running`, timers still running up to now. Screens show
 * running time; alerts count saved time only, since they're checked when a timer stops.
 */
export async function projectTotals(db: OrgDb, projects: (Rates & { id: string })[], { running }: { running: boolean }) {
  const ids = projects.map((p) => p.id);
  const [groups, timers, people] = await Promise.all([
    db.timeEntry.groupBy({ by: ["projectId", "userId", "billable"], where: { projectId: { in: ids } }, _sum: { seconds: true } }),
    running ? db.timeEntry.findMany({ where: { projectId: { in: ids }, startedAt: { not: null } }, select: { projectId: true, userId: true, billable: true, startedAt: true } }) : [],
    db.user.findMany({ select: { id: true, hourlyRate: true } }),
  ]);
  const now = Date.now();
  const rowsOf = new Map<string, TimeRow[]>(ids.map((id) => [id, []]));
  for (const g of groups) rowsOf.get(g.projectId)!.push({ userId: g.userId, billable: g.billable, seconds: g._sum.seconds ?? 0 });
  for (const t of timers) rowsOf.get(t.projectId)!.push({ userId: t.userId, billable: t.billable, seconds: Math.max(0, Math.floor((now - t.startedAt!.getTime()) / 1000)) });
  const rates = new Map(people.map((p) => [p.id, p]));
  return new Map(projects.map((p) => [p.id, sumTotals(p, rowsOf.get(p.id)!, (id) => rates.get(id) ?? { hourlyRate: null })]));
}

/** How much of the budget is used: hours count all time, fees count billable value. Null without a budget. */
export function budgetUse(project: Budget, totals: Totals): { used: number; max: number } | null {
  if (project.budgetBy === "hours" && project.budgetSeconds) return { used: totals.seconds, max: project.budgetSeconds };
  if (project.budgetBy === "fees" && project.budgetAmount) return { used: totals.billableAmount, max: project.budgetAmount };
  return null;
}

export function levelOf(project: Budget, totals: Totals): BudgetLevel {
  const use = budgetUse(project, totals);
  if (!use) return 0;
  const reached = BUDGET_LEVELS.filter((level) => use.used * 100 >= use.max * level);
  return reached[reached.length - 1] ?? 0;
}

const PROJECT = {
  id: true, name: true, archived: true, billBy: true, hourlyRate: true, fixedFee: true, budgetBy: true, budgetSeconds: true, budgetAmount: true, budgetAlertLevel: true,
  client: { select: { name: true, currency: true } },
} as const;

/**
 * Brings the alert level of these projects (or every project) up to date, and emails
 * admins and managers about levels newly reached when `notify` is set.
 */
export async function checkBudgets(db: OrgDb, which: string[] | "all", notify: boolean) {
  // Runs after the change it follows has been saved, so a failure here is logged, never answered with an error.
  try {
    await check(db, which, notify);
  } catch (error) {
    console.error("Checking budgets failed", describeError(error));
  }
}

async function check(db: OrgDb, which: string[] | "all", notify: boolean) {
  const ids = which === "all" ? undefined : [...new Set(which)];
  if (ids && !ids.length) return;
  const projects = await db.project.findMany({
    where: { AND: [ids ? { id: { in: ids } } : {}, { OR: [{ budgetBy: { not: "none" } }, { budgetAlertLevel: { gt: 0 } }] }] },
    select: PROJECT,
  });
  if (!projects.length) return;
  const totalsOf = await projectTotals(db, projects, { running: false });

  const reached: { project: (typeof projects)[number]; level: BudgetLevel; use: { used: number; max: number } }[] = [];
  for (const project of projects) {
    const totals = totalsOf.get(project.id)!;
    const level = levelOf(project, totals);
    if (level === project.budgetAlertLevel) continue;
    // Only if nobody else moved it meanwhile, so two saves at once can't both send the alert.
    const { count } = await db.project.updateMany({ where: { id: project.id, budgetAlertLevel: project.budgetAlertLevel }, data: { budgetAlertLevel: level } });
    // Nobody tracks time on an archived project, so a rate change doesn't make news of it.
    if (count && notify && level > project.budgetAlertLevel && !project.archived) reached.push({ project, level, use: budgetUse(project, totals)! });
  }
  if (reached.length) await emailAlerts(db, reached);
}

async function emailAlerts(db: OrgDb, reached: { project: { id: string; name: string; budgetBy: string; client: { name: string; currency: string } | null }; level: BudgetLevel; use: { used: number; max: number } }[]) {
  if (!(await isEmailConfigured(db))) return;
  const [org, recipients] = await Promise.all([
    db.organization.findFirstOrThrow({ select: { currency: true } }),
    db.user.findMany({
      where: { role: { in: ["admin", "manager"] }, deactivatedAt: null, accounts: { some: {} }, NOT: { email: { endsWith: PLACEHOLDER_DOMAIN } } },
      select: { name: true, email: true },
    }),
  ]);
  // A money budget is in the project's currency: its client's, or the home currency.
  const show = (project: { budgetBy: string; client: { currency: string } | null }, n: number) =>
    project.budgetBy === "hours" ? `${formatDuration(n)} h` : formatMoney(n, project.client?.currency ?? org.currency);
  const lines = reached.map(({ project, level, use }) => {
    const name = project.client ? `${project.name} (${project.client.name})` : project.name;
    const what = level === 100 ? "has used all of its budget" : `has used ${level}% of its budget`;
    return { name, sentence: `${name} ${what}: ${show(project, use.used)} of ${show(project, use.max)}.`, link: `${env.baseUrl}/projects/${project.id}` };
  });
  const subject = lines.length === 1
    ? `${lines[0]!.name} ${reached[0]!.level === 100 ? "has used all of its budget" : `has used ${reached[0]!.level}% of its budget`}`
    : `${lines.length} projects reached a budget alert`;
  const text = lines.map((l) => `${l.sentence}\n${l.link}`).join("\n\n");
  const html = lines.map((l) => `<p>${escapeHtml(l.sentence)}<br><a href="${l.link}">${l.link}</a></p>`).join("");
  // An alert that can't be emailed still shows on the Projects screen; a failure is saved as the last email error.
  for (const r of recipients) await sendMail(db, { to: r.email, subject, text: `Hi ${r.name},\n\n${text}`, html: `<p>Hi ${escapeHtml(r.name)},</p>${html}` });
}
