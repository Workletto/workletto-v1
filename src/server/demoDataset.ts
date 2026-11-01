import { addDays, daysBetween, startOfWeek } from "../shared/time.ts";
import { hoursQuantity, rateFor, timeLineAmount, timeLines, valueOf, type BillableEntry } from "./billing.ts";
import { addShowcase, type DemoShowcase } from "./demoShowcase.ts";

// The demo studio's history: a small fictional agency with people, clients, projects, time, expenses
// and invoices. A pure function of `today` and `months`: no database, and the only randomness is a
// PRNG with one fixed seed, so the same input always gives the same dataset. Rows refer to each other
// by local keys; demoWrite.ts turns them into database rows. Dates are "YYYY-MM-DD" strings.
//
// Invoice money comes from the app's own code (billing.ts): timeLines, hoursQuantity and timeLineAmount.

export type DemoPerson = {
  key: string; name: string; role: "admin" | "manager" | "member"; hourlyRate: number;
  /** First and last day with the studio (left is null for people still here). */
  joined: string; left: string | null;
};
export type DemoClient = { key: string; name: string; email: string; address: string; archived: boolean; currency?: string };
export type DemoProject = {
  key: string; name: string; clientKey: string | null; billable: boolean; billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null;
  budgetBy: "none" | "hours" | "fees"; budgetSeconds: number | null; budgetAmount: number | null;
  startDate: string | null; endDate: string | null; archived: boolean; feeByPhase?: boolean;
};
export type DemoTask = {
  key: string; projectKey: string; title: string; status: "todo" | "in_progress" | "done"; assigneeKey: string | null;
  dueDate: string | null; completedAt: string | null; fee?: number;
};
export type DemoEntry = { key: string; personKey: string; projectKey: string; taskKey: string | null; date: string; seconds: number; notes: string; billable: boolean };
export type DemoExpense = { key: string; personKey: string; projectKey: string; date: string; category: string; amount: number; notes: string; billable: boolean };
export type DemoInvoiceLine = {
  kind: "time" | "expense" | "fee" | "custom"; description: string; quantity: number; unitPrice: number; amount: number;
  entryKeys: string[]; expenseKeys: string[];
  /** A fee line's project, and its phase on a project billed per phase. */
  projectKey?: string; taskKey?: string;
};
export type DemoInvoice = {
  key: string; number: string; clientKey: string; status: "draft" | "sent" | "paid";
  issueDate: string; dueDate: string; periodFrom: string; periodTo: string; notes: string;
  sentAt: string | null; paidAt: string | null; lines: DemoInvoiceLine[];
  /** A repeating invoice's schedule, and late-payment reminders already sent. */
  repeat?: { every: "month"; startDate: string }; remindersSent?: number; lastReminderAt?: string;
};
export type DemoDataset = {
  today: string; windowStart: string;
  people: DemoPerson[]; clients: DemoClient[]; projects: DemoProject[]; tasks: DemoTask[];
  entries: DemoEntry[]; expenses: DemoExpense[]; invoices: DemoInvoice[];
} & Partial<DemoShowcase>;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261017;
const QUARTER = 900; // entries come in 15-minute steps

// ---- Dates ----

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const isWeekend = (date: string) => [0, 6].includes(weekdayOf(date));
const monthOf = (date: string) => date.slice(0, 7);
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const monthStart = (month: string) => `${month}-01`;
const monthEnd = (month: string) => addDays(monthStart(shiftMonth(month, 1)), -1);
const nextWeekday = (date: string) => (weekdayOf(date) === 6 ? addDays(date, 2) : weekdayOf(date) === 0 ? addDays(date, 1) : date);
const prevWeekday = (date: string) => (weekdayOf(date) === 6 ? addDays(date, -1) : weekdayOf(date) === 0 ? addDays(date, -2) : date);

/** Days the whole studio is closed, by their real weekday: New Year, the May and August bank holidays, and the last week of December. */
function isStudioHoliday(date: string) {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  const monday = weekdayOf(date) === 1;
  if (m === 1 && d === 1) return true;
  if (m === 12 && d >= 24) return true;
  if (m === 5 && monday && (d <= 7 || d >= 25)) return true;
  return m === 8 && monday && d >= 25;
}

// ---- The agency ----

type Discipline = "design" | "development" | "strategy" | "content";
// name, role, rate in cents per hour, billable share, days ago they joined, days ago they left, discipline, weekday off (part-timers)
const PEOPLE: [string, DemoPerson["role"], number, number, number, number | null, Discipline, number | null][] = [
  ["You", "admin", 17500, 0.4, 800, null, "strategy", null],
  ["Maya Chen", "manager", 15500, 0.5, 800, null, "strategy", null],
  ["Tomasz Kowal", "manager", 14500, 0.5, 800, null, "strategy", null],
  ["Priya Nair", "member", 13500, 0.82, 800, null, "design", null],
  ["Jonas Berg", "member", 12500, 0.8, 800, null, "development", null],
  ["Lena Fischer", "member", 11500, 0.8, 800, 365, "design", null],
  ["Omar Haddad", "member", 9500, 0.78, 800, null, "design", 5],
  ["Hannah Brooks", "member", 12000, 0.8, 640, null, "development", null],
  ["Diego Alvarez", "member", 10500, 0.82, 560, null, "design", null],
  ["Sofia Rossi", "member", 11000, 0.75, 480, null, "content", 5],
  ["Kwame Mensah", "member", 13000, 0.8, 400, null, "development", null],
  ["Elin Johansson", "member", 8500, 0.85, 300, null, "design", null],
  ["Aiden Park", "member", 9000, 0.8, 200, null, "development", 3],
  ["Nadia Volkova", "member", 10000, 0.82, 100, null, "design", null],
];

const CLIENTS = [
  "Fernhill Dental", "Marlow & Finch Solicitors", "Quayside Brewing Co.", "Alder Street Bakery", "Brightwater Energy",
  "Copperleaf Interiors", "Ostler Cycles", "Halden Books", "Tidewell Physio", "Kestrel Outdoor",
  "Lantern Theatre", "Pennine Foods", "Riverbend Pottery", "Saltmarsh Gallery", "Wren & Co. Architects",
  "Elmstead Arts Trust", "Juniper Hill School", "Granite Row Fitness", "Nightingale Records", "Beacon Hill Savings",
];
const STREETS = ["Harbour Road", "Mill Lane", "Station Approach", "Albion Street", "Kings Parade", "Orchard Way", "Canal Street"];
const TOWNS = ["Bristol BS1 4XY", "Leeds LS2 8JA", "Bath BA1 2QT", "York YO1 7HL", "Norwich NR2 1AB", "Brighton BN1 3FF", "Exeter EX4 3PD"];

const PROJECT_NAMES = [
  "Brand identity", "Website redesign", "Campaign launch", "Packaging design", "App prototype", "Annual report", "Social content",
  "Photography direction", "Wayfinding", "E-commerce build", "Brand guidelines", "Email templates", "Launch microsite",
  "Exhibition stand", "Newsletter system", "Menu and signage", "Product catalogue", "Video explainer", "Intranet refresh",
];
const RETAINER_NAMES = ["Website care plan", "Social media retainer", "Brand support retainer"];
const INTERNAL = ["Studio admin", "New business", "Training"];

const TASK_TITLES = [
  "Discovery and research", "Stakeholder interviews", "Moodboards", "Concept directions", "Wireframes", "Visual design", "Design review",
  "Copywriting", "Prototype", "Build", "QA and testing", "Content migration", "Launch checklist", "Handover", "Print proofs",
  "Photography brief", "Feedback round", "Accessibility pass", "Brand guidelines", "Social templates", "Competitor review", "Project plan",
];
const INTERNAL_TASKS: Record<string, string[]> = {
  "Studio admin": ["Update the rate card", "Archive old project files", "Renew software licences", "Refresh the studio handbook", "Quarterly accounts pack"],
  "New business": ["Proposal for a retail client", "Case study write-up", "Portfolio refresh", "Pitch deck template", "Follow up past enquiries"],
  Training: ["Accessibility workshop", "Prototyping course", "Design systems reading group", "Pair-programming Fridays"],
};

const NOTES: Record<Discipline | "internal", string[]> = {
  design: ["Concept sketches", "Layout exploration", "Revisions after feedback", "Visual system", "Asset production", "Presentation boards", "Handover files", "Type and colour tests"],
  development: ["Building components", "Fixing browser bugs", "CMS set-up", "Performance pass", "Code review", "Deploy and QA", "Forms and validation"],
  strategy: ["Client call", "Scoping and planning", "Review session", "Briefing the team", "Status update", "Stakeholder workshop", "Reviewing designs"],
  content: ["Copy draft", "Editing and proofing", "Content audit", "Interview write-up", "Page copy revisions"],
  internal: ["Invoices and planning", "Team stand-up", "Tidying the shared drive", "Timesheets", "Proposal draft", "Intro call", "Workshop", "Tool research"],
};
const EXPENSE_KINDS: [string, string[], number, number][] = [
  ["Travel", ["Train to the client workshop", "Taxi to a site visit", "Train to a photo shoot", "Parking at the client's office"], 1800, 24000],
  ["Software", ["Font licence", "Plugin subscription, one month", "Prototype tool seat", "Stock icon pack"], 1500, 12000],
  ["Printing", ["Proof prints", "Business cards", "Brochure proofs", "Poster run"], 3000, 45000],
  ["Stock images", ["Image licences", "Hero photography licence", "Illustration pack"], 2900, 19900],
  ["Couriers", ["Artwork delivery", "Samples to the client", "Print proofs, next day"], 1200, 6500],
];

type Proj = DemoProject & { weight: number; team: string[]; retainer: boolean; internal: boolean };
type Task = DemoTask & { openFrom: string; openUntil: string };

export function generateDataset({ today, months }: { today: string; months: number }): DemoDataset & DemoShowcase {
  return addShowcase(generateHistory({ today, months }));
}

/** The studio's history as first built (WRK-93), before the newer features are added to it. */
function generateHistory({ today, months }: { today: string; months: number }): DemoDataset {
  const rng = mulberry32(SEED);
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const chance = (p: number) => rng() < p;
  const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
  const shuffled = <T>(items: readonly T[]) => {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const weightedPick = <T>(items: T[], weight: (item: T) => number): T => {
    let r = rng() * items.reduce((s, i) => s + weight(i), 0);
    for (const item of items) {
      r -= weight(item);
      if (r <= 0) return item;
    }
    return items[items.length - 1]!;
  };
  const off = (days: number) => addDays(today, days);
  const later = (a: string, b: string) => (a > b ? a : b);

  const windowStart = monthStart(shiftMonth(monthOf(today), -months));
  const dates: string[] = [];
  for (let d = windowStart; d <= today; d = addDays(d, 1)) dates.push(d);
  const currentMonth = monthOf(today);

  // ---- People ----
  const people: DemoPerson[] = PEOPLE.map(([name, role, hourlyRate, , joinedAgo, leftAgo], i) => ({
    key: `p${i}`, name, role, hourlyRate, joined: off(-joinedAgo), left: leftAgo === null ? null : off(-leftAgo),
  })).filter((p) => p.left === null || p.left >= windowStart);
  const spec = (key: string) => PEOPLE[Number(key.slice(1))]!;
  const personByKey = new Map(people.map((p) => [p.key, p]));

  // Two weeks of holiday a year each: one in summer, one at another time.
  const mondays = dates.filter((d) => weekdayOf(d) === 1);
  const holidayWeeks = new Map<string, Set<string>>();
  for (const p of people) {
    const weeks = new Set<string>();
    for (const year of [...new Set(mondays.map((d) => d.slice(0, 4)))]) {
      const ofYear = mondays.filter((d) => d.startsWith(year));
      const summer = ofYear.filter((d) => ["07", "08"].includes(d.slice(5, 7)));
      const other = ofYear.filter((d) => ["03", "04", "05", "06", "09", "10", "11"].includes(d.slice(5, 7)));
      for (const pool of [summer, other]) {
        if (!pool.length) continue;
        const start = pick(pool);
        weeks.add(start);
        weeks.add(addDays(start, 7));
      }
    }
    holidayWeeks.set(p.key, weeks);
  }
  const working = (p: DemoPerson, date: string) =>
    date >= p.joined && (p.left === null || date <= p.left) && !isWeekend(date) && !isStudioHoliday(date)
    && weekdayOf(date) !== spec(p.key)[7] && !holidayWeeks.get(p.key)!.has(startOfWeek(date));

  // ---- Clients and projects ----
  const archivedClients = new Set([17, 18, 19]);
  const retainerClients = [3, 7, 11];
  const earlyClients = new Set([0, 1, 3, 5, 9]); // already clients when the history starts
  const threeProjectClients = new Set([0, 1, 2, 4]);
  const clients: DemoClient[] = CLIENTS.map((name, i) => {
    const slug = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
    return {
      key: `c${i}`, name, email: `accounts@${slug}.example`, archived: archivedClients.has(i),
      address: `${name}\n${int(2, 98)} ${STREETS[i % STREETS.length]}\n${TOWNS[i % TOWNS.length]}`,
    };
  });

  const projects: Proj[] = [];
  const addProject = (name: string, ci: number | null, startOff: number, endOff: number | null, billBy: "project" | "person", kind: "normal" | "retainer" | "internal") => {
    const billable = kind !== "internal";
    projects.push({
      key: `j${projects.length}`, name, clientKey: ci === null ? null : `c${ci}`, billable, billBy: billable ? billBy : "project",
      hourlyRate: billable && billBy === "project" ? int(19, 33) * 500 : null, fixedFee: null,
      budgetBy: "none", budgetSeconds: null, budgetAmount: null,
      startDate: later(off(startOff), windowStart), endDate: endOff === null ? null : off(endOff),
      archived: endOff !== null && endOff < -90,
      weight: kind === "retainer" ? 0.25 : kind === "internal" ? 1 : 0.7 + rng() * 0.8,
      team: shuffled(people.map((p) => p.key)).slice(0, kind === "retainer" ? 2 : int(3, 4)),
      retainer: kind === "retainer", internal: kind === "internal",
    });
  };
  CLIENTS.forEach((_, ci) => {
    const names = shuffled(PROJECT_NAMES).slice(0, 3);
    if (archivedClients.has(ci)) {
      let start = int(-745, -690);
      for (let k = 0; k < 2; k++) {
        const dur = int(100, 200);
        addProject(names[k]!, ci, start, start + dur, chance(0.3) ? "person" : "project", "normal");
        start += dur + int(5, 40);
      }
      return;
    }
    // A client's projects come one after another, in a cluster placed somewhere in the two years (later more often: the studio grows).
    const n = threeProjectClients.has(ci) ? 3 : 2;
    const spans = Array.from({ length: n }, () => ({ duration: int(35, 85), gap: int(10, 130) }));
    const length = spans.reduce((s, x) => s + x.duration + x.gap, 0) - spans[n - 1]!.gap;
    let start = earlyClients.has(ci) ? int(-745, -690) : Math.round(-740 + (100 - length + 740) * Math.sqrt(rng()));
    if (retainerClients.includes(ci)) addProject(RETAINER_NAMES[retainerClients.indexOf(ci)]!, ci, ci === 3 ? int(-745, -690) : int(-330, -80), null, "project", "retainer");
    for (const [k, span] of spans.entries()) {
      addProject(names[k]!, ci, start, start + span.duration, chance(0.3) ? "person" : "project", "normal");
      start += span.duration + span.gap;
    }
  });
  for (const name of INTERNAL) addProject(name, null, -800, null, "project", "internal");
  const activeOn = (p: Proj, date: string) => (p.startDate === null || p.startDate <= date) && (p.endDate === null || p.endDate >= date);

  // ---- Tasks ----
  const tasks: Task[] = [];
  const spread = (from: string, to: string, i: number, n: number) => prevWeekday(addDays(from, Math.round((daysBetween(from, to) * (i + 0.5)) / n)));
  const stillHere = people.filter((x) => x.left === null).map((x) => x.key);
  for (const p of projects) {
    const start = p.startDate!;
    const end = p.endDate ?? off(60);
    const finished = p.endDate !== null && p.endDate < today;
    const team = p.team.filter((k) => stillHere.includes(k));
    const titles = p.internal ? INTERNAL_TASKS[p.name]! : shuffled(TASK_TITLES).slice(0, p.retainer ? 5 : int(4, 7));
    const progress = finished ? 1 : p.retainer || p.internal ? 0.5 : Math.min(0.95, Math.max(0.1, daysBetween(start, today) / Math.max(1, daysBetween(start, end))));
    const nDone = finished ? titles.length : Math.min(titles.length - 1, Math.round(titles.length * progress));
    const doneUntil = later(off(-3), start);
    titles.forEach((title, i) => {
      const done = i < nDone;
      let dueDate = done ? spread(start, doneUntil, i, nDone) : spread(off(-6), later(end, off(14)), i - nDone, titles.length - nDone);
      if (i === nDone && chance(0.4)) dueDate = later(start, prevWeekday(off(-int(1, 6)))); // the task in progress is running late
      const finishedOn = addDays(dueDate, int(-3, 2));
      const completed = done ? later(start, finishedOn > off(-1) ? off(-1) : finishedOn) : null;
      tasks.push({
        key: `t${tasks.length}`, projectKey: p.key, title, status: done ? "done" : i === nDone ? "in_progress" : "todo",
        assigneeKey: team.length ? pick(team) : null, dueDate,
        completedAt: completed ? `${completed}T16:00:00.000Z` : null,
        openFrom: done ? later(start, addDays(dueDate, -28)) : later(start, off(-45)),
        openUntil: completed ?? today,
      });
    });
  }
  const tasksByProject = new Map<string, Task[]>();
  for (const t of tasks) tasksByProject.set(t.projectKey, [...(tasksByProject.get(t.projectKey) ?? []), t]);

  // ---- Time ----
  const entries: DemoEntry[] = [];
  const internalProjects = projects.filter((p) => p.internal);
  const roleWeights = (role: DemoPerson["role"]) => (role === "member" ? [0.5, 0.1, 0.4] : [0.45, 0.45, 0.1]);
  for (const date of dates) {
    const isToday = date === today;
    const activeClient = projects.filter((p) => !p.internal && activeOn(p, date));
    for (const person of people) {
      if (!working(person, date)) continue;
      const share = spec(person.key)[3];
      const discipline = spec(person.key)[6];
      const quarters = isToday ? int(11, 14) : int(24, 30); // today is only a morning's work
      const mineActive = activeClient.filter((p) => p.team.includes(person.key));
      const candidates = mineActive.length ? mineActive : activeClient;
      let billableQ = candidates.length ? Math.min(quarters, Math.max(0, Math.round(quarters * share) + int(-3, 3))) : 0;
      let internalQ = quarters - billableQ;
      if (internalQ > 0 && internalQ < 4 && billableQ > 0) {
        billableQ += internalQ;
        internalQ = 0;
      }
      const pieces: { project: Proj; quarters: number }[] = [];
      if (billableQ > 0) {
        const wanted = chance(0.55) ? 1 : chance(0.85) ? 2 : 3;
        const n = Math.max(1, Math.min(wanted, candidates.length, Math.floor(billableQ / 2)));
        const chosen: Proj[] = [];
        const rest = [...candidates];
        for (let i = 0; i < n; i++) chosen.push(rest.splice(rest.indexOf(weightedPick(rest, (p) => p.weight)), 1)[0]!);
        const weights = chosen.map(() => 0.3 + rng());
        const total = weights.reduce((s, w) => s + w, 0);
        const parts = weights.map((w) => 2 + Math.floor(((billableQ - 2 * n) * w) / total));
        parts[0]! += billableQ - parts.reduce((s, q) => s + q, 0);
        chosen.forEach((project, i) => pieces.push({ project, quarters: parts[i]! }));
      }
      if (internalQ > 0) {
        const w = roleWeights(person.role);
        pieces.push({ project: weightedPick(internalProjects, (p) => w[internalProjects.indexOf(p)]!), quarters: internalQ });
      }
      for (const { project, quarters: q } of pieces) {
        const eligible = (tasksByProject.get(project.key) ?? []).filter((t) => t.openFrom <= date && date <= t.openUntil);
        const task = eligible.length && chance(project.internal ? 0.15 : 0.35) ? pick(eligible) : null;
        entries.push({
          key: `e${entries.length}`, personKey: person.key, projectKey: project.key, taskKey: task?.key ?? null, date,
          seconds: q * QUARTER, notes: chance(0.8) ? pick(project.internal ? NOTES.internal : NOTES[discipline]) : "", billable: project.billable,
        });
      }
    }
  }

  // ---- Budgets, from what the work turned out to need ----
  const projectByKey = new Map(projects.map((p) => [p.key, p]));
  const totals = new Map<string, { seconds: number; value: number }>();
  for (const e of entries) {
    const t = totals.get(e.projectKey) ?? { seconds: 0, value: 0 };
    t.seconds += e.seconds;
    if (e.billable) t.value += valueOf(e.seconds, rateFor(projectByKey.get(e.projectKey)!, personByKey.get(e.personKey)!) ?? 0);
    totals.set(e.projectKey, t);
  }
  let finishedBudgets = 0;
  for (const p of projects) {
    const t = totals.get(p.key);
    if (p.internal || p.retainer || !t || t.seconds === 0) continue;
    const kind = chance(0.4) ? "hours" : chance(0.67) ? "fees" : "none";
    if (kind === "none") continue;
    let ratio: number; // work done divided by budget: a few finished projects go 10-30% over, the rest come in under
    if (p.endDate! < today) ratio = finishedBudgets++ % 7 === 3 ? 1.1 + rng() * 0.2 : 0.8 + rng() * 0.2;
    else ratio = Math.max(0.2, Math.min(1, daysBetween(p.startDate!, today) / Math.max(1, daysBetween(p.startDate!, p.endDate!)))) / (0.95 + rng() * 0.15);
    p.budgetBy = kind;
    if (kind === "hours") p.budgetSeconds = Math.max(10, Math.round(t.seconds / 3600 / ratio / 5) * 5) * 3600;
    else p.budgetAmount = Math.max(50000, Math.round(t.value / ratio / 25000) * 25000);
  }

  // ---- Expenses ----
  const expenseCount = Math.round((200 * dates.length) / 740);
  const workDates = dates.filter((d) => !isWeekend(d) && !isStudioHoliday(d));
  const pending: Omit<DemoExpense, "key">[] = [];
  for (let attempt = 0; pending.length < expenseCount && attempt < expenseCount * 50; attempt++) {
    const date = pick(workDates);
    const who = people.filter((p) => working(p, date));
    const open = projects.filter((p) => !p.internal && !p.retainer && activeOn(p, date));
    if (!who.length || !open.length) continue;
    const person = pick(who);
    const project = chance(0.88) ? pick(open.filter((p) => p.team.includes(person.key)).concat(open)) : pick(internalProjects);
    const [category, notes, low, high] = pick(EXPENSE_KINDS);
    pending.push({ personKey: person.key, projectKey: project.key, date, category, amount: int(low, high), notes: pick(notes), billable: project.billable && chance(0.92) });
  }
  pending.sort((a, b) => a.date.localeCompare(b.date));
  const expenses: DemoExpense[] = pending.map((x, i) => ({ key: `x${i}`, ...x }));

  // ---- Invoices: one per client per month worked, for that month's billable time and expenses ----
  const groups = new Map<string, { clientKey: string; month: string; entries: BillableEntry[]; expenses: DemoExpense[] }>();
  const groupOf = (clientKey: string, month: string) => {
    const id = `${clientKey}|${month}`;
    return groups.get(id) ?? groups.set(id, { clientKey, month, entries: [], expenses: [] }).get(id)!;
  };
  const taskByKey = new Map(tasks.map((t) => [t.key, t]));
  for (const e of entries) {
    const project = projectByKey.get(e.projectKey)!;
    if (!e.billable || !project.clientKey || monthOf(e.date) >= currentMonth) continue;
    const person = personByKey.get(e.personKey)!;
    const task = e.taskKey ? taskByKey.get(e.taskKey)! : null;
    groupOf(project.clientKey, monthOf(e.date)).entries.push({
      id: e.key, date: new Date(`${e.date}T00:00:00Z`), seconds: e.seconds, notes: e.notes,
      user: { id: person.key, name: person.name, hourlyRate: person.hourlyRate },
      task: task ? { id: task.key, title: task.title } : null,
      project: { id: project.key, name: project.name, billBy: project.billBy, hourlyRate: project.hourlyRate, fixedFee: project.fixedFee },
    });
  }
  for (const x of expenses) {
    const project = projectByKey.get(x.projectKey)!;
    if (x.billable && project.clientKey && monthOf(x.date) < currentMonth) groupOf(project.clientKey, monthOf(x.date)).expenses.push(x);
  }

  const dueDaysFor = (clientKey: string) => (Number(clientKey.slice(1)) % 5 === 2 ? 14 : 30);
  type Draft = DemoInvoice & { month: string };
  const drafts: Draft[] = [];
  const ordered = [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || Number(a.clientKey.slice(1)) - Number(b.clientKey.slice(1)));
  for (const g of ordered) {
    const lines: DemoInvoiceLine[] = timeLines(g.entries, "project").map((l) => ({
      kind: "time", description: l.description, quantity: hoursQuantity(l.seconds), unitPrice: l.unitPrice,
      amount: timeLineAmount(l.seconds, l.unitPrice), entryKeys: l.entryIds, expenseKeys: [],
    }));
    for (const x of g.expenses) {
      lines.push({
        kind: "expense", description: `${x.category}${x.notes ? ` – ${x.notes}` : ""} (${projectByKey.get(x.projectKey)!.name}, ${x.date})`,
        quantity: 1000, unitPrice: x.amount, amount: x.amount, entryKeys: [], expenseKeys: [x.key],
      });
    }
    if (!lines.length) continue;
    // Issued in the first week of the next month, on a weekday, and never in the future.
    const issueDate = nextWeekday(addDays(monthStart(shiftMonth(g.month, 1)), int(0, 4)));
    const issued = issueDate > today ? today : issueDate;
    const dueDays = dueDaysFor(g.clientKey);
    drafts.push({
      key: "", number: "", clientKey: g.clientKey, status: "paid", issueDate: issued, dueDate: addDays(issued, dueDays),
      periodFrom: monthStart(g.month), periodTo: monthEnd(g.month), month: g.month,
      notes: `Payment terms: ${dueDays} days by bank transfer. Thank you!`, sentAt: `${issued}T09:00:00.000Z`, paidAt: null, lines,
    });
  }

  // Settle them: old ones are paid (some late), a few from two months ago are overdue, the newest are sent, and a couple are still drafts.
  const paid = (inv: Draft) => {
    const latest = later(addDays(today, -1), inv.issueDate);
    const date = addDays(inv.issueDate, 5 + Math.floor(rng() ** 1.5 * 41));
    inv.status = "paid";
    inv.paidAt = `${date > latest ? latest : date}T14:00:00.000Z`;
  };
  const lastMonth = shiftMonth(currentMonth, -1);
  const overdue = new Set(shuffled(drafts.filter((d) => d.month === shiftMonth(currentMonth, -2))).slice(0, 3));
  for (const inv of drafts) {
    if (overdue.has(inv)) {
      inv.status = "sent";
      inv.dueDate = addDays(inv.issueDate, 14); // issued early last month, so long past due by now
    } else if (inv.month === lastMonth && inv.dueDate >= today) {
      inv.status = "sent";
    } else {
      paid(inv);
    }
  }
  const stillOpen = drafts.filter((d) => d.month === lastMonth && d.status === "sent");
  for (const inv of shuffled(stillOpen).slice(0, Math.min(2, stillOpen.length))) {
    inv.status = "draft";
    inv.sentAt = null;
  }

  const clientName = new Map(clients.map((c) => [c.key, c.name]));
  drafts.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || clientName.get(a.clientKey)!.localeCompare(clientName.get(b.clientKey)!));
  const invoices: DemoInvoice[] = drafts.map(({ month: _month, ...inv }, i) => ({ ...inv, key: `i${i}`, number: String(i + 1).padStart(4, "0") }));

  // ---- Leave out whatever ended before the window starts ----
  const kept = projects.filter((p) => p.endDate === null || p.endDate >= windowStart);
  const keptKeys = new Set(kept.map((p) => p.key));
  return {
    today, windowStart, people,
    clients: clients.filter((c) => kept.some((p) => p.clientKey === c.key)),
    projects: kept.map(({ weight: _w, team: _t, retainer: _r, internal: _i, ...p }) => p),
    tasks: tasks.filter((t) => keptKeys.has(t.projectKey)).map(({ openFrom: _f, openUntil: _u, ...t }) => t),
    entries, expenses, invoices,
  };
}
