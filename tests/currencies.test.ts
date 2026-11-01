import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { readRate, toHome } from "../src/server/currency.ts";
import { addUser, createOrgWithUser, request, resetDatabase, signIn } from "./helpers.ts";

// A currency per client (WRK-135): a client's money is all in its currency and never converted;
// reports add other currencies up in the home currency at the organization's exchange rates.

beforeEach(resetDatabase);

const TODAY = "2026-10-15";

async function studio() {
  const { organization, user } = await createOrgWithUser("Studio", "admin@studio.test", "admin-password-1", "admin");
  const member = await addUser(organization.id, "member@studio.test", "member-password-1");
  const admin = (await signIn("admin@studio.test", "admin-password-1")).cookie;
  const memberCookie = (await signIn("member@studio.test", "member-password-1")).cookie;
  const json = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await request(path, { cookie: admin, ...init });
    return { status: res.status, body: await res.json() };
  };
  return { organization, user, member, admin, memberCookie, json };
}

describe("exchange rates", () => {
  it("are read as typed, in millionths, and convert for reports only", () => {
    expect(readRate("1.08")).toBe(1_080_000);
    expect(readRate("1,08")).toBe(1_080_000);
    expect(readRate(0.0065)).toBe(6_500);
    expect(readRate("12")).toBe(12_000_000);
    for (const bad of ["", "0", "-1", "1.0000001", "abc", "1e3", null]) expect(readRate(bad), String(bad)).toBeNull();
    const convert = toHome({ home: "USD", rates: { EUR: 1_080_000 } });
    expect(convert(10_000, "USD")).toBe(10_000);
    expect(convert(10_000, "EUR")).toBe(10_800);
    expect(convert(10_000, "GBP")).toBe(0);
  });
});

describe("a client billed in another currency", () => {
  it("needs an exchange rate the first time its currency is used", async () => {
    const s = await studio();
    const noRate = await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR" } });
    expect(noRate).toMatchObject({ status: 400, body: { error: "Enter what 1 EUR is worth in USD, like 1.08. Reports use it to add amounts up." } });
    expect((await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "lots" } })).status).toBe(400);
    expect((await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "XYZ" } })).status).toBe(400);

    const berlin = await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "1.08" } });
    expect(berlin.body.client).toMatchObject({ currency: "EUR" });
    // The second EUR client uses the rate already set.
    expect((await s.json("/api/clients", { body: { name: "Munich AG", currency: "EUR" } })).body.client.currency).toBe("EUR");
    expect((await s.json("/api/clients", { body: { name: "Local Co" } })).body.client.currency).toBe("USD");

    const { body } = await s.json("/api/clients");
    expect(body.exchangeRates).toEqual({ EUR: "1.08" });
    const settings = (await s.json("/api/settings/company")).body;
    expect(settings.otherCurrencies).toEqual([{ currency: "EUR", clients: 2, rate: "1.08" }]);
  });

  it("bills everything in its currency, and never at people's own rates", async () => {
    const s = await studio();
    const client = (await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "1.08" } })).body.client;
    const byPerson = await s.json("/api/projects", { body: { name: "Site", clientId: client.id, billBy: "person" } });
    expect(byPerson.body.error).toBe("Berlin GmbH is billed in EUR, and people's own rates are in USD. Use a project rate or a fixed fee.");

    const project = (await s.json("/api/projects", { body: { name: "Site", clientId: client.id, hourlyRate: 10_000 } })).body.project;
    expect((await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { billBy: "person" } })).status).toBe(400);
    await s.json("/api/time-entries", { body: { projectId: project.id, date: TODAY, seconds: 3600 } });
    await s.json("/api/expenses", { body: { projectId: project.id, date: TODAY, category: "Travel", amount: 5000, billable: true } });

    const preview = (await s.json(`/api/invoices/preview?clientId=${client.id}`)).body;
    expect(preview.currency).toBe("EUR");
    const id = (await s.json("/api/invoices", { body: { clientId: client.id, issueDate: TODAY } })).body.invoice.id;
    const invoice = (await s.json(`/api/invoices/${id}`)).body.invoice;
    // Not converted: €100 an hour and a €50 expense are €150.
    expect(invoice).toMatchObject({ currency: "EUR", subtotal: 15_000, total: 15_000 });
  });

  it("keeps its currency once it has invoices or expenses, or while a project bills at people's rates", async () => {
    const s = await studio();
    const client = (await s.json("/api/clients", { body: { name: "Acme" } })).body.client;
    const project = (await s.json("/api/projects", { body: { name: "Site", clientId: client.id, billBy: "person" } })).body.project;
    const toEuro = () => s.json(`/api/clients/${client.id}`, { method: "PATCH", body: { currency: "EUR", exchangeRate: "1.08" } });
    expect((await toEuro()).body.error).toBe("Some of this client's projects bill at each person's own rate, which is in USD. Give them a project rate or a fixed fee first.");

    await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { billBy: "project", hourlyRate: 10_000 } });
    expect((await toEuro()).body.client.currency).toBe("EUR");
    await s.json("/api/expenses", { body: { projectId: project.id, date: TODAY, category: "Travel", amount: 5000 } });
    const back = await s.json(`/api/clients/${client.id}`, { method: "PATCH", body: { currency: "USD" } });
    expect(back).toMatchObject({ status: 409, body: { error: "The currency can't change once the client has invoices or expenses: their amounts are in EUR." } });
  });

  it("keeps a project with expenses or invoiced work, and each expense, in its currency", async () => {
    const s = await studio();
    const euro = (await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "1.08" } })).body.client;
    const local = (await s.json("/api/clients", { body: { name: "Local Co" } })).body.client;
    const project = (await s.json("/api/projects", { body: { name: "Site", clientId: euro.id, hourlyRate: 10_000 } })).body.project;
    const home = (await s.json("/api/projects", { body: { name: "Home", clientId: local.id } })).body.project;
    // With nothing on it yet, the project can still move.
    expect((await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { clientId: local.id } })).status).toBe(200);
    expect((await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { clientId: euro.id } })).status).toBe(200);

    const expense = (await s.json("/api/expenses", { body: { projectId: project.id, date: TODAY, category: "Travel", amount: 5000 } })).body.expense;
    expect(expense.project.client).toMatchObject({ currency: "EUR" });
    const move = await s.json(`/api/projects/${project.id}`, { method: "PATCH", body: { clientId: local.id } });
    expect(move.body.error).toBe("This project has invoices or expenses in EUR, so it can only move to a client billed in EUR.");
    const moveExpense = await s.json(`/api/expenses/${expense.id}`, { method: "PATCH", body: { projectId: home.id } });
    expect(moveExpense.body.error).toBe("This expense is in EUR and that project is billed in USD. Add it again on that project instead.");
  });
});

describe("reports with more than one currency", () => {
  it("add amounts up in the home currency at the exchange rate, and say so", async () => {
    const s = await studio();
    await s.json(`/api/people/${s.member.id}`, { method: "PATCH", body: { costRate: 5000 } });
    const euro = (await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "1.10" } })).body.client;
    const local = (await s.json("/api/clients", { body: { name: "Local Co" } })).body.client;
    const eurProject = (await s.json("/api/projects", { body: { name: "Berlin site", clientId: euro.id, hourlyRate: 10_000 } })).body.project;
    const usdProject = (await s.json("/api/projects", { body: { name: "Local site", clientId: local.id, hourlyRate: 10_000 } })).body.project;
    const track = (projectId: string) => s.json("/api/time-entries", { body: { projectId, date: TODAY, seconds: 3600 }, cookie: s.memberCookie });
    await track(eurProject.id); // €100 = $110
    await track(usdProject.id); // $100
    await s.json("/api/expenses", { body: { projectId: eurProject.id, date: TODAY, category: "Travel", amount: 10_000, billable: true } }); // €100 = $110

    const summary = (await s.json(`/api/reports/summary?from=${TODAY}&to=${TODAY}&groupBy=client`)).body;
    expect(summary).toMatchObject({ currency: "USD", converted: true, totals: { billableAmount: 21_000 }, expenses: { amount: 11_000, billableAmount: 11_000 } });
    expect(summary.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Berlin GmbH", billableAmount: 11_000 })]));

    const profit = (await s.json(`/api/reports/profitability?from=${TODAY}&to=${TODAY}`)).body;
    // Revenue $110 + $100 + $110; cost: two hours at $50, plus the €100 expense at $110.
    expect(profit).toMatchObject({ currency: "USD", converted: true, totals: { revenue: 32_000, timeCost: 10_000, expenseCost: 11_000, profit: 11_000 } });

    // The spreadsheet keeps each entry in its own currency.
    const entries = (await s.json(`/api/reports/entries?from=${TODAY}&to=${TODAY}`)).body.entries;
    expect(entries.map((e: { amount: number; currency: string }) => [e.amount, e.currency]).sort()).toEqual([[10_000, "EUR"], [10_000, "USD"]]);

    // Changing the rate changes the reports, never the amounts themselves.
    await s.json("/api/settings/company", { method: "PUT", body: { name: "Studio", currency: "USD", address: "", exchangeRates: { EUR: "1.20" } } });
    expect((await s.json(`/api/reports/summary?from=${TODAY}&to=${TODAY}`)).body.totals.billableAmount).toBe(22_000);
  });

  it("say nothing about converting when everything is in the home currency", async () => {
    const s = await studio();
    const local = (await s.json("/api/clients", { body: { name: "Local Co" } })).body.client;
    const project = (await s.json("/api/projects", { body: { name: "Local site", clientId: local.id, hourlyRate: 10_000 } })).body.project;
    await s.json("/api/time-entries", { body: { projectId: project.id, date: TODAY, seconds: 3600 } });
    expect((await s.json(`/api/reports/summary?from=${TODAY}&to=${TODAY}`)).body.converted).toBe(false);
  });
});

describe("the home currency", () => {
  it("keeps every rate a client needs, and stays while clients use others", async () => {
    const s = await studio();
    await s.json("/api/clients", { body: { name: "Berlin GmbH", currency: "EUR", exchangeRate: "1.08" } });
    const company = { name: "Studio", currency: "USD", address: "" };
    const dropped = await s.json("/api/settings/company", { method: "PUT", body: { ...company, exchangeRates: {} } });
    expect(dropped.body.error).toBe("Clients are billed in EUR, so it needs an exchange rate.");
    const toPounds = await s.json("/api/settings/company", { method: "PUT", body: { ...company, currency: "GBP" } });
    expect(toPounds.body.error).toBe("Some clients are billed in EUR, at exchange rates against USD. Change those clients to USD first.");
  });

  it("moves clients billed in it along when it changes before anything is invoiced", async () => {
    const s = await studio();
    const local = (await s.json("/api/clients", { body: { name: "Local Co" } })).body.client;
    expect((await s.json("/api/settings/company", { method: "PUT", body: { name: "Studio", currency: "GBP", address: "" } })).status).toBe(200);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: local.id }, select: { currency: true } })).toEqual({ currency: "GBP" });
  });
});
