import { beforeEach, describe, expect, it } from "vitest";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";
import { parseCsv, toCsv } from "../src/shared/csv.ts";

beforeEach(resetDatabase);

async function studio() {
  const { organization, user: admin } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const adminCookie = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const post = async (path: string, body: Record<string, unknown>, cookie = adminCookie) => (await request(path, { body, cookie })).json();

  const client = (await post("/api/clients", { name: "Northwind" })).client;
  const brand = (await post("/api/projects", { name: "Brand", clientId: client.id, hourlyRate: 10000, budgetBy: "hours", budgetSeconds: 36000 })).project;
  const site = (await post("/api/projects", { name: "Site", clientId: client.id, billBy: "person", budgetBy: "fees", budgetAmount: 100000 })).project;
  const internal = (await post("/api/projects", { name: "Admin", billable: false })).project;
  await request(`/api/people/${member.id}`, { method: "PATCH", body: { hourlyRate: 8000 }, cookie: adminCookie });
  const task = (await post("/api/tasks", { projectId: brand.id, title: "Logo" })).task;

  const entry = (cookie: string, projectId: string, date: string, seconds: number, extra: Record<string, unknown> = {}) =>
    post("/api/time-entries", { projectId, date, seconds, ...extra }, cookie);
  await entry(memberCookie, brand.id, "2026-10-12", 7200, { taskId: task.id }); // 2 h × 100 = 200
  await entry(memberCookie, site.id, "2026-10-13", 3600); // 1 h × 80 = 80
  await entry(adminCookie, brand.id, "2026-10-14", 1800); // 0.5 h × 100 = 50
  await entry(adminCookie, internal.id, "2026-10-14", 3600); // not billable
  await entry(adminCookie, brand.id, "2026-09-30", 3600); // outside October
  await post("/api/expenses", { projectId: brand.id, date: "2026-10-12", category: "Printing", amount: 5000 }, memberCookie);
  await post("/api/expenses", { projectId: internal.id, date: "2026-10-12", category: "Software", amount: 1000 }, adminCookie);
  return { organization, admin, member, adminCookie, memberCookie, client, brand, site, internal, task };
}

const OCT = "from=2026-10-01&to=2026-10-31";

describe("reports", () => {
  it("adds up hours and money by project, client, person and task", async () => {
    const s = await studio();
    const byProject = await (await request(`/api/reports/summary?${OCT}&groupBy=project`, { cookie: s.adminCookie })).json();
    expect(byProject.totals).toEqual({ seconds: 16200, billableSeconds: 12600, billableAmount: 33000 });
    expect(byProject.rows.map((r: { label: string; seconds: number; billableAmount: number }) => [r.label, r.seconds, r.billableAmount])).toEqual([
      ["Brand", 9000, 25000],
      ["Site", 3600, 8000],
      ["Admin", 3600, 0],
    ]);
    expect(byProject.expenses).toEqual({ amount: 6000, billableAmount: 5000 });

    const byClient = await (await request(`/api/reports/summary?${OCT}&groupBy=client`, { cookie: s.adminCookie })).json();
    expect(byClient.rows.map((r: { label: string }) => r.label)).toEqual(["Northwind", "No client"]);
    const byPerson = await (await request(`/api/reports/summary?${OCT}&groupBy=person`, { cookie: s.adminCookie })).json();
    expect(byPerson.rows.map((r: { label: string; billableAmount: number }) => [r.label, r.billableAmount])).toEqual([["member", 28000], ["admin", 5000]]);
    const byTask = await (await request(`/api/reports/summary?${OCT}&groupBy=task`, { cookie: s.adminCookie })).json();
    expect(byTask.rows.find((r: { label: string }) => r.label === "Logo")).toMatchObject({ seconds: 7200, detail: "Brand" });
  });

  it("charts hours over the period: days for a month, weeks and months for longer (WRK-107)", async () => {
    const s = await studio();
    const month = await (await request(`/api/reports/summary?${OCT}&groupBy=project`, { cookie: s.adminCookie })).json();
    expect(month.series.step).toBe("day");
    expect(month.series.buckets).toHaveLength(31);
    const sum = (key: "seconds" | "billableSeconds") => month.series.buckets.reduce((t: number, b: Record<string, number>) => t + (b[key] ?? 0), 0);
    expect(sum("seconds")).toBe(month.totals.seconds);
    expect(sum("billableSeconds")).toBe(month.totals.billableSeconds);
    const quarter = await (await request("/api/reports/summary?from=2026-09-01&to=2026-11-30", { cookie: s.adminCookie })).json();
    expect(quarter.series.step).toBe("week");
    expect(quarter.series.buckets[0].start).toBe("2026-08-31"); // the Monday of the week the period starts in
    const year = await (await request("/api/reports/summary?from=2026-01-01&to=2026-12-31", { cookie: s.adminCookie })).json();
    expect(year.series.step).toBe("month");
    expect(year.series.buckets.map((b: { start: string }) => b.start)).toHaveLength(12);
  });

  it("filters by client, project, person and billable", async () => {
    const s = await studio();
    const get = async (query: string) => (await (await request(`/api/reports/summary?${OCT}&${query}`, { cookie: s.adminCookie })).json()).totals.seconds;
    expect(await get(`projectId=${s.site.id}`)).toBe(3600);
    expect(await get(`clientId=${s.client.id}`)).toBe(12600);
    expect(await get("clientId=none")).toBe(3600);
    expect(await get(`userId=${s.member.id}`)).toBe(10800);
    expect(await get("billable=false")).toBe(3600);
    expect((await request("/api/reports/summary?from=2026-10-31&to=2026-10-01", { cookie: s.adminCookie })).status).toBe(400);
  });

  it("shows members only their own time, without money", async () => {
    const s = await studio();
    const summary = await (await request(`/api/reports/summary?${OCT}&userId=${s.admin.id}`, { cookie: s.memberCookie })).json();
    expect(summary.totals).toEqual({ seconds: 10800, billableSeconds: 10800 });
    expect(summary.rows[0]).not.toHaveProperty("billableAmount");
    expect(summary.expenses).toEqual({ amount: 5000, billableAmount: 5000 });
    const { entries } = await (await request(`/api/reports/entries?${OCT}`, { cookie: s.memberCookie })).json();
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toHaveProperty("amount");
    expect((await request("/api/reports/budgets", { cookie: s.memberCookie })).status).toBe(403);
  });

  it("lists each entry with its rate and amount for export", async () => {
    const s = await studio();
    const { entries } = await (await request(`/api/reports/entries?${OCT}&userId=${s.member.id}`, { cookie: s.adminCookie })).json();
    expect(entries[0]).toEqual({
      date: "2026-10-12", person: "member", client: "Northwind", project: "Brand", task: "Logo", notes: "",
      seconds: 7200, billable: true, rate: 10000, amount: 20000, currency: "USD", customFields: {}, groups: "",
    });
  });

  it("shows how much of each budget is used", async () => {
    const s = await studio();
    const { budgets } = await (await request("/api/reports/budgets", { cookie: s.adminCookie })).json();
    expect(budgets).toEqual([
      { id: s.brand.id, name: "Brand", client: "Northwind", budgetBy: "hours", currency: "USD", budget: 36000, used: 12600 },
      { id: s.site.id, name: "Site", client: "Northwind", budgetBy: "fees", currency: "USD", budget: 100000, used: 8000 },
    ]);
  });

  it("never includes another organization's data", async () => {
    const s = await studio();
    await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    const bCookie = (await signIn("b@b.test", "admin-password-1")).cookie;
    const summary = await (await request(`/api/reports/summary?${OCT}&projectId=${s.brand.id}&userId=${s.member.id}`, { cookie: bCookie })).json();
    expect(summary.totals.seconds).toBe(0);
    expect(summary.expenses.amount).toBe(0);
    expect((await (await request(`/api/reports/entries?${OCT}`, { cookie: bCookie })).json()).entries).toEqual([]);
    expect((await (await request("/api/reports/budgets", { cookie: bCookie })).json()).budgets).toEqual([]);
  });
});

describe("CSV", () => {
  it("writes and reads quotes, commas and line breaks, and defuses formulas", () => {
    const text = toCsv([["Name", "Notes", "Hours"], ['Acme, "Ltd"', "two\nlines", 1.5], ["=HYPERLINK()", "", null]]);
    expect(text).toBe('Name,Notes,Hours\r\n"Acme, ""Ltd""","two\nlines",1.5\r\n\'=HYPERLINK(),,\r\n');
    expect(parseCsv(text)).toEqual([["Name", "Notes", "Hours"], ['Acme, "Ltd"', "two\nlines", "1.5"], ["'=HYPERLINK()", "", ""]]);
    expect(parseCsv("﻿a,b\n\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});
