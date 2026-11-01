import { parseMoney } from "./money.ts";
import { parseDuration } from "./time.ts";

// Working out rates before a time import creates anything. Apps like Harvest
// keep a rate per person that can differ per project, and a file's first row
// for a project says little about what the rest of it is billed at. So the
// whole file is read first: each person gets their most common billable rate,
// and each new project is billed by project (one rate for everyone) or by
// person (rates differ inside it). The browser runs this over every row and
// sends the result with each batch; the server runs it itself when it isn't sent.

export type PlanInput = {
  person?: string;
  personEmail?: string;
  client?: string;
  project?: string;
  hours?: string;
  billable?: string;
  rate?: string;
};
export type ProjectPlan = { billable: boolean; billBy: "project" | "person"; rate: number | null };
export type RatePlan = { people: Record<string, number>; projects: Record<string, ProjectPlan> };

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
export const personKey = (name?: string, email?: string) => norm(name) || norm(email);
export const projectKey = (client?: string, project?: string) => `${norm(client)}|${norm(project)}`;

/** Yes/No as written in a file: undefined when blank, null when unreadable. */
export function parseYesNo(text: string | undefined): boolean | undefined | null {
  const t = norm(text);
  if (!t) return undefined;
  if (["yes", "y", "true", "1", "billable"].includes(t)) return true;
  if (["no", "n", "false", "0", "non-billable", "not billable"].includes(t)) return false;
  return null;
}

type Tally = Map<number, { count: number; seconds: number }>;

/** The most common rate; ties go to the one with more hours, then the higher rate. */
function commonest(tally: Tally): number {
  return [...tally.entries()].sort(([ra, a], [rb, b]) => b.count - a.count || b.seconds - a.seconds || rb - ra)[0]![0];
}

export function planRates(rows: PlanInput[]): RatePlan {
  const people = new Map<string, Tally>();
  const projects = new Map<string, { billable: boolean; rates: Set<number> }>();
  for (const row of rows) {
    if (!norm(row.project)) continue;
    const billable = parseYesNo(row.billable);
    const seconds = parseDuration(row.hours ?? "");
    if (billable === null || seconds === null || Number.isNaN(seconds)) continue; // the row will be reported as a problem
    const projectId = projectKey(row.client, row.project);
    const project = projects.get(projectId) ?? { billable: false, rates: new Set<number>() };
    projects.set(projectId, project);
    if (billable === false) continue; // never take a rate from a non-billable row, whatever it says
    project.billable = true;
    const rate = parseMoney(row.rate ?? "");
    if (!rate || rate <= 0) continue; // blank, unreadable or $0
    project.rates.add(rate);
    const who = personKey(row.person, row.personEmail);
    if (!who) continue;
    const tally = people.get(who) ?? new Map();
    people.set(who, tally);
    const seen = tally.get(rate) ?? { count: 0, seconds: 0 };
    tally.set(rate, { count: seen.count + 1, seconds: seen.seconds + seconds });
  }
  return {
    // Object.fromEntries so a project or person called "__proto__" is just a key.
    people: Object.fromEntries([...people].map(([who, tally]) => [who, commonest(tally)])),
    projects: Object.fromEntries(
      [...projects].map(([id, p]): [string, ProjectPlan] => {
        const rates = [...p.rates];
        return [id, { billable: p.billable, billBy: rates.length > 1 ? "person" : "project", rate: rates.length === 1 ? rates[0]! : null }];
      }),
    ),
  };
}
