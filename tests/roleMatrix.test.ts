import { beforeAll, describe, expect, it } from "vitest";
import { addUser, app, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// Who may use each API route (WRK-79). Every route is listed with the lowest role that may use it:
//   member  = any signed-in person (some answers are filtered for members, see below)
//   manager = admins and managers
//   admin   = admins only
// A route missing from the table fails the test, so new routes have to be classified here.
type Level = "member" | "manager" | "admin";

const TABLE: Record<string, Level | [Level, string]> = {
  "GET /api/me": "member",
  "GET /api/members": ["member", "members get names only; see the filtering tests"],
  "GET /api/logo": "member",

  "PUT /api/settings/appearance": "admin",
  "PUT /api/settings/appearance/logo": "admin",
  "DELETE /api/settings/appearance/logo": "admin",
  "GET /api/settings/company": "admin",
  "PUT /api/settings/company": "admin",
  "GET /api/settings/security": "admin",
  "GET /api/settings/email": "admin",
  "PUT /api/settings/email": "admin",
  "DELETE /api/settings/email": "admin",
  "POST /api/settings/email/test": "admin",
  "GET /api/settings/invoices": "manager",
  "PUT /api/settings/invoices": "admin",
  "GET /api/settings/timesheets": ["member", "the screens read the time zone and whether approvals are on"],
  "PUT /api/settings/timesheets": "admin",
  "GET /api/settings/backup": "admin",
  "GET /api/settings/payments": "admin",
  "PUT /api/settings/payments": "admin",
  "DELETE /api/settings/payments": "admin",
  "POST /api/settings/payments/webhook": "admin",
  "PUT /api/settings/time-off": "admin",
  "POST /api/settings/time-off/holidays": "admin",
  "DELETE /api/settings/time-off/holidays/:id": "admin",
  "GET /api/settings/sso": "admin",
  "PUT /api/settings/sso": "admin",
  "DELETE /api/settings/sso": "admin",
  "GET /api/settings/about": "admin",
  "GET /api/settings/about/diagnostics": "admin",
  "GET /api/settings/about/donation": "admin",
  "POST /api/settings/about/donation/dismiss": "admin",

  "GET /api/clients": ["member", "members get id, name and archived only"],
  "POST /api/clients": "manager",
  "PATCH /api/clients/:id": "manager",
  "DELETE /api/clients/:id": "manager",

  "GET /api/projects": ["member", "only projects open to everyone or that they're on, without rates or budgets"],
  "GET /api/projects/:id": ["member", "same filter as the list"],
  "POST /api/projects": "manager",
  "PATCH /api/projects/:id": "manager",
  "PUT /api/projects/:id/phase-fees": "manager",
  "DELETE /api/projects/:id": "manager",

  "GET /api/time-entries": ["member", "own entries only"],
  "POST /api/time-entries": ["member", "own entries only"],
  "GET /api/calendar": ["member", "own calendar only"],
  "PUT /api/calendar/link": ["member", "own calendar only"],
  "DELETE /api/calendar/link": ["member", "own calendar only"],
  "POST /api/calendar/events": ["member", "own calendar only"],
  "POST /api/calendar/import": ["member", "own entries only"],
  "PATCH /api/time-entries/:id": ["member", "own entries only"],
  "DELETE /api/time-entries/:id": ["member", "own entries only"],
  "GET /api/timer": "member",
  "POST /api/timer/start": "member",
  "POST /api/timer/stop": "member",

  "GET /api/data/export/:type": "manager",
  "POST /api/data/import/time": "manager",

  "GET /api/invoices": "manager",
  "GET /api/invoices/unbilled": "manager",
  "GET /api/invoices/preview": "manager",
  "GET /api/invoices/:id": "manager",
  "GET /api/invoices/export/:format": "manager",
  "GET /api/time-off": "member",
  "POST /api/time-off": "member",
  "DELETE /api/time-off/:id": "member",
  "POST /api/time-off/:id/:decision": "manager",
  "POST /api/invoices": "manager",
  "PATCH /api/invoices/:id": "manager",
  "POST /api/invoices/:id/email": "manager",
  "DELETE /api/invoices/:id": "manager",
  "PUT /api/invoices/:id/schedule": "manager",
  "PATCH /api/invoices/:id/schedule": "manager",
  "DELETE /api/invoices/:id/schedule": "manager",
  "PATCH /api/invoices/:id/reminders": "manager",
  "POST /api/invoices/:id/lines": "manager",
  "PATCH /api/invoices/:id/lines/:lineId": "manager",
  "DELETE /api/invoices/:id/lines/:lineId": "manager",

  "GET /api/reports/summary": ["member", "own time only, without money"],
  "GET /api/reports/entries": ["member", "own time only, without money"],
  "GET /api/reports/budgets": "manager",
  "GET /api/reports/profitability": ["manager", "the split by person is for admins only; see tests/parity.test.ts"],

  "GET /api/expenses": ["member", "own expenses only"],
  "GET /api/expenses/categories": "member",
  "POST /api/expenses": ["member", "own expenses only"],
  "PATCH /api/expenses/:id": ["member", "own expenses only"],
  "DELETE /api/expenses/:id": ["member", "own expenses only"],
  "PUT /api/expenses/:id/receipt": ["member", "own expenses only"],
  "GET /api/expenses/:id/receipt": ["member", "own expenses; managers can open anyone's"],
  "DELETE /api/expenses/:id/receipt": ["member", "own expenses only"],

  "GET /api/tasks": ["member", "tasks on projects they can work on"],
  "POST /api/tasks": ["member", "on projects they can work on"],
  "PATCH /api/tasks/:id": ["member", "on projects they can work on"],
  "DELETE /api/tasks/:id": ["member", "a task that has time on it needs a manager; checked below"],
  "GET /api/common-tasks": "manager",
  "POST /api/common-tasks": "manager",
  "PATCH /api/common-tasks/:id": "manager",
  "DELETE /api/common-tasks/:id": "manager",
  "POST /api/common-tasks/:id/add-to-projects": "manager",
  "GET /api/custom-fields": ["member", "fields in use; removed ones for admins only"],
  "GET /api/groups": "manager",
  "POST /api/groups": "admin",
  "PATCH /api/groups/:id": "admin",
  "DELETE /api/groups/:id": "admin",
  "POST /api/groups/:id/add-to-project": "manager",
  "POST /api/custom-fields": "admin",
  "PATCH /api/custom-fields/:id": "admin",
  "GET /api/two-factor/settings": "admin",
  "PUT /api/two-factor/settings": "admin",
  "DELETE /api/two-factor/people/:userId": "admin",
  "GET /api/project-templates": "manager",
  "POST /api/project-templates": "manager",
  "PATCH /api/project-templates/:id": "manager",
  "DELETE /api/project-templates/:id": "manager",

  "GET /api/people": "admin",
  "POST /api/people/invites": "admin",
  "POST /api/people/invites/:id/renew": "admin",
  "DELETE /api/people/invites/:id": "admin",
  "POST /api/people/:id/invite": "admin",
  "POST /api/people/:id/reset-link": "admin",
  "PATCH /api/people/:id": "admin",

  "GET /api/timesheets/mine": "member",
  "POST /api/timesheets/mine/:weekStart/submit": "member",
  "POST /api/timesheets/mine/:weekStart/withdraw": "member",
  "GET /api/timesheets": "manager",
  "POST /api/timesheets/approve": "manager",
  "GET /api/team": "manager",
  "GET /api/schedule": "manager",
  "PUT /api/schedule/:userId/:week": "manager",
  "GET /api/schedule/me": ["member", "own plan only"],
  "GET /api/timesheets/:userId/:weekStart": "manager",
  "POST /api/timesheets/:userId/:weekStart/:decision": "manager",

  "GET /api/history": "admin",
  "GET /api/history/export": "admin",
};

// Routes that need no sign-in; routeAccess.test.ts checks everything else answers 401.
const PUBLIC = [
  /^\/api\/health$/, /^\/api\/auth(\/|$)/, /^\/api\/demo(\/|$)/, /^\/api\/setup(\/|$)/, /^\/api\/branding(\/|$)/,
  /^\/api\/invites(\/|$)/, /^\/api\/password-reset(\/|$)/, /^\/api\/payments(\/|$)/,
];

const ROLES = ["member", "manager", "admin"] as const;
const RANK: Record<Level, number> = { member: 0, manager: 1, admin: 2 };
const levelOf = (v: Level | [Level, string]) => (Array.isArray(v) ? v[0] : v);
const WEEK = "2026-10-12"; // a Monday

const routes: string[] = [...new Map(
  app.routes
    .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/") && !r.path.includes("*") && !PUBLIC.some((p) => p.test(r.path)))
    .map((r) => [`${r.method} ${r.path}`, r] as const),
).keys()];

let ids: Record<string, string>;
let cookies: Record<Level, string>;
let otherAdmin: string;

// Two organizations, three roles in the first, and one of each record in the first.
async function seed() {
  await resetDatabase();
  const { organization } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const manager = await addUser(organization.id, "manager@studio.test", "manager-password-1", "manager");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1", "member");
  await createOrgWithUser("Other Studio", "admin@other.test", "other-password-1", "admin");
  cookies = {
    admin: (await signIn("admin@studio.test", "admin-password-1")).cookie,
    manager: (await signIn("manager@studio.test", "manager-password-1")).cookie,
    member: (await signIn("member@studio.test", "member-password-1")).cookie,
  };
  otherAdmin = (await signIn("admin@other.test", "other-password-1")).cookie;

  const post = async (path: string, body: Record<string, unknown>, cookie = cookies.admin) => (await request(path, { body, cookie })).json();
  const client = (await post("/api/clients", { name: "Northwind" })).client;
  const project = (await post("/api/projects", { name: "Brand", clientId: client.id, hourlyRate: 10000 })).project;
  const task = (await post("/api/tasks", { projectId: project.id, title: "Logo" })).task;
  const commonTask = (await post("/api/common-tasks", { title: "Design" })).task;
  const template = (await post("/api/project-templates", { projectId: project.id, name: "Brand template" })).template;
  const customField = (await post("/api/custom-fields", { name: "Phase", appliesTo: "time", type: "text" })).field;
  const group = (await post("/api/groups", { name: "Design" })).group;
  const entry = (await post("/api/time-entries", { projectId: project.id, date: "2026-10-12", seconds: 3600 }, cookies.member)).entry;
  const expense = (await post("/api/expenses", { projectId: project.id, date: "2026-10-12", category: "Printing", amount: 4500 }, cookies.member)).expense;
  const created = await post("/api/invoices", { clientId: client.id, from: "2026-10-01", to: "2026-10-31", issueDate: "2026-11-01", dueDate: "2026-11-30" });
  const invoice = (await (await request(`/api/invoices/${created.invoice.id}`, { cookie: cookies.admin })).json()).invoice;
  const invite = (await post("/api/people/invites", { name: "New Person", email: "new@studio.test", role: "member" })).invite;
  expect(invoice?.lines?.length, "the fixture invoice has lines").toBeGreaterThan(0);
  ids = { client: client.id, project: project.id, task: task.id, entry: entry.id, expense: expense.id, invoice: invoice.id, line: invoice.lines[0].id, invite: invite.id, member: member.id, manager: manager.id, commonTask: commonTask.id, template: template.id, customField: customField.id, group: group.id };
}

beforeAll(seed);

/** The route pattern with real ids where it has parameters. */
function fill(pattern: string): string {
  const [, , ...segments] = pattern.split("/"); // after "", "api"
  const group = segments[0]!;
  const byGroup: Record<string, string> = { clients: ids.client!, projects: ids.project!, "time-entries": ids.entry!, invoices: ids.invoice!, expenses: ids.expense!, tasks: ids.task!, people: ids.member!, "common-tasks": ids.commonTask!, "project-templates": ids.template!, "custom-fields": ids.customField!, groups: ids.group! };
  return "/api/" + segments.map((s, i) => {
    if (!s.startsWith(":")) return s;
    if (s === ":type") return "clients";
    if (s === ":weekStart" || s === ":week") return WEEK;
    if (s === ":decision") return "approve";
    if (s === ":format") return "xero";
    if (s === ":userId") return ids.member!;
    if (s === ":lineId") return ids.line!;
    if (s === ":id" && group === "people" && segments[1] === "invites") return ids.invite!;
    // Time off and holidays: any id will do; what's checked is who may ask.
    if (s === ":id" && (group === "time-off" || segments[1] === "time-off")) return "00000000-0000-4000-8000-000000000000";
    if (s === ":id") return byGroup[group]!;
    throw new Error(`No sample for ${s} in ${pattern} (position ${i})`);
  }).join("/");
}

const call = (key: string, cookie: string) => {
  const [method, pattern] = key.split(" ") as [string, string];
  return request(fill(pattern), { method, cookie, body: method === "GET" ? undefined : {} });
};

describe("role matrix (WRK-79)", { timeout: 30_000 }, () => {
  it("has a role for every API route, and none for routes that don't exist", () => {
    expect(routes.filter((r) => !(r in TABLE))).toEqual([]);
    expect(Object.keys(TABLE).filter((r) => !routes.includes(r))).toEqual([]);
    expect(routes.length).toBe(Object.keys(TABLE).length);
  });

  for (const key of Object.keys(TABLE)) {
    const level = levelOf(TABLE[key]!);
    it(`${key} needs ${level}`, async () => {
      // Refusals first, so a route that deletes its record can't hide one.
      for (const role of ROLES.filter((r) => RANK[r] < RANK[level])) {
        const res = await call(key, cookies[role]);
        expect(res.status, `${role} on ${key}`).toBe(403);
      }
      for (const role of ROLES.filter((r) => RANK[r] >= RANK[level])) {
        const res = await call(key, cookies[role]);
        expect([401, 403], `${role} on ${key} answered ${res.status}`).not.toContain(res.status);
      }
    });
  }
});

describe("what members don't get", () => {
  beforeAll(seed);

  it("hides rates, budgets and teams on a single project, and money in its stats", async () => {
    const asMember = await (await request(`/api/projects/${ids.project}`, { cookie: cookies.member })).json();
    const asManager = await (await request(`/api/projects/${ids.project}`, { cookie: cookies.manager })).json();
    for (const field of ["hourlyRate", "billBy", "budgetBy", "budgetSeconds", "budgetAmount", "budgetAlertLevel", "memberIds"]) {
      expect(asMember.project, field).not.toHaveProperty(field);
      expect(asManager.project, field).toHaveProperty(field);
    }
    // Whether a project is open to everyone is shown to members too.
    expect(asMember.project).toHaveProperty("everyone");
    expect(asMember.stats).not.toHaveProperty("billableAmount");
    expect(asManager.stats).toHaveProperty("billableAmount");
  });

  it("shows members no emails or roles of colleagues, and no client contact details", async () => {
    const { members } = await (await request("/api/members", { cookie: cookies.member })).json();
    expect(members.length).toBeGreaterThan(1);
    for (const m of members) expect(Object.keys(m).sort()).toEqual(["active", "id", "name"]);
    const { clients } = await (await request("/api/clients", { cookie: cookies.member })).json();
    for (const c of clients) expect(Object.keys(c).sort()).toEqual(["archived", "id", "name"]);
  });

  it("shows members only their own expenses and time, and no money in reports", async () => {
    const range = "from=2026-10-01&to=2026-10-31";
    // The manager's own lists are empty: the entry and expense belong to the member.
    expect((await (await request(`/api/time-entries?${range}`, { cookie: cookies.manager })).json()).entries).toEqual([]);
    expect((await (await request(`/api/expenses?${range}`, { cookie: cookies.manager })).json()).expenses).toEqual([]);
    expect((await (await request(`/api/time-entries?${range}`, { cookie: cookies.member })).json()).entries).toHaveLength(1);
    // A member asking for someone else's report still gets only their own, without amounts.
    const summary = await (await request(`/api/reports/summary?${range}&userId=${ids.manager}`, { cookie: cookies.member })).json();
    expect(summary.totals).not.toHaveProperty("billableAmount");
    const { entries } = await (await request(`/api/reports/entries?${range}&userId=${ids.manager}`, { cookie: cookies.member })).json();
    expect(entries.map((e: { person: string }) => e.person)).toEqual(["member"]);
    for (const e of entries) expect(e).not.toHaveProperty("rate");
  });

  it("lets a member delete a task only while no time is on it", async () => {
    const withTime = (await (await request("/api/tasks", { body: { projectId: ids.project, title: "Has time" }, cookie: cookies.admin })).json()).task;
    await request("/api/time-entries", { body: { projectId: ids.project, taskId: withTime.id, date: "2026-10-13", seconds: 600 }, cookie: cookies.admin });
    expect((await request(`/api/tasks/${withTime.id}`, { method: "DELETE", cookie: cookies.member })).status).toBe(403);
    const empty = (await (await request("/api/tasks", { body: { projectId: ids.project, title: "Empty" }, cookie: cookies.admin })).json()).task;
    expect((await request(`/api/tasks/${empty.id}`, { method: "DELETE", cookie: cookies.member })).status).toBe(200);
  });
});

describe("another organization's records", () => {
  // The matrix above deletes some records, so start again: a 404 must mean "not yours", not "gone".
  beforeAll(seed);

  // Each: method, path with the first organization's id, a small body that would be valid there.
  const cases: [string, string, string, unknown?][] = [
    ["client", "PATCH", "/api/clients/{client}", { name: "Hijacked" }],
    ["client", "DELETE", "/api/clients/{client}"],
    ["project", "GET", "/api/projects/{project}"],
    ["project", "PATCH", "/api/projects/{project}", { name: "Hijacked" }],
    ["project", "DELETE", "/api/projects/{project}"],
    ["task", "PATCH", "/api/tasks/{task}", { title: "Hijacked" }],
    ["task", "DELETE", "/api/tasks/{task}"],
    ["time entry", "PATCH", "/api/time-entries/{entry}", { seconds: 60 }],
    ["time entry", "DELETE", "/api/time-entries/{entry}"],
    ["expense", "PATCH", "/api/expenses/{expense}", { amount: 100 }],
    ["expense", "DELETE", "/api/expenses/{expense}"],
    ["receipt", "GET", "/api/expenses/{expense}/receipt"],
    ["receipt", "DELETE", "/api/expenses/{expense}/receipt"],
    ["invoice", "GET", "/api/invoices/{invoice}"],
    ["invoice", "PATCH", "/api/invoices/{invoice}", { notes: "Hijacked" }],
    ["invoice", "DELETE", "/api/invoices/{invoice}"],
    ["invoice line", "PATCH", "/api/invoices/{invoice}/lines/{line}", { description: "Hijacked" }],
    ["invoice line", "DELETE", "/api/invoices/{invoice}/lines/{line}"],
    ["person", "PATCH", "/api/people/{member}", { hourlyRate: 1 }],
    ["person", "POST", "/api/people/{member}/reset-link", {}],
    ["invite", "POST", "/api/people/invites/{invite}/renew", {}],
    ["invite", "DELETE", "/api/people/invites/{invite}"],
    ["timesheet", "GET", `/api/timesheets/{member}/${WEEK}`],
    ["timesheet", "POST", `/api/timesheets/{member}/${WEEK}/approve`, {}],
  ];

  it.each(cases)("a second organization's admin gets 404 for the first one's %s on %s %s", async (_kind, method, path, body) => {
    const url = path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name]!);
    const res = await request(url, { method, body: body ?? (method === "GET" || method === "DELETE" ? undefined : {}), cookie: otherAdmin });
    expect(res.status, `${method} ${url}`).toBe(404);
  });

  it("left the first organization's records as they were", async () => {
    const admin = cookies.admin;
    expect((await request(`/api/projects/${ids.project}`, { cookie: admin })).status).toBe(200);
    expect((await (await request(`/api/projects/${ids.project}`, { cookie: admin })).json()).project.name).toBe("Brand");
    expect((await request(`/api/invoices/${ids.invoice}`, { cookie: admin })).status).toBe(200);
    expect((await (await request("/api/clients", { cookie: admin })).json()).clients.map((c: { name: string }) => c.name)).toEqual(["Northwind"]);
    expect((await (await request(`/api/people`, { cookie: admin })).json()).invites.map((i: { id: string }) => i.id)).toContain(ids.invite);
  });
});
