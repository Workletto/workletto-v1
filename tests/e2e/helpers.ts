import { randomBytes } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

// Made-up values for the throwaway end-to-end database only.
// The setup code needs 16 or more characters.
export const SETUP_CODE = "e2e-setup-code-1234";
export const ORG_NAME = "Studio North";
export const ADMIN = { name: "Ada Admin", email: "ada.admin@example.com", password: "e2e-admin-password" };
/** Where the setup test saves the admin's sign-in for the other tests. */
export const ADMIN_STATE = "tests/e2e/.auth/admin.json";

let counter = 0;
/** A name no other test uses, so tests never depend on each other's data. */
export const unique = (prefix: string) => `${prefix} ${++counter}${randomBytes(2).toString("hex")}`;

/** Today in the browser's time zone (UTC, see playwright.config.ts). */
export const today = () => new Date().toISOString().slice(0, 10);

/** Calls the app's own API as whoever the request context is signed in as. */
export async function api<T = unknown>(request: APIRequestContext, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data });
  if (!res.ok()) throw new Error(`${method} ${path} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function seedClient(request: APIRequestContext, name = unique("Client")) {
  const { client } = await api<{ client: { id: string; name: string } }>(request, "POST", "/api/clients", { name });
  return client;
}

/** A project, optionally for a client, billed at one hourly rate (cents) and with a fees budget (cents). */
export async function seedProject(
  request: APIRequestContext,
  options: { name?: string; clientId?: string; hourlyRate?: number; budgetAmount?: number; billable?: boolean } = {},
) {
  const { project } = await api<{ project: { id: string; name: string } }>(request, "POST", "/api/projects", {
    name: options.name ?? unique("Project"),
    clientId: options.clientId ?? null,
    billable: options.billable ?? true,
  });
  if (options.hourlyRate !== undefined || options.budgetAmount !== undefined) {
    await api(request, "PATCH", `/api/projects/${project.id}`, {
      billBy: "project",
      ...(options.hourlyRate !== undefined ? { hourlyRate: options.hourlyRate } : {}),
      ...(options.budgetAmount !== undefined ? { budgetBy: "fees", budgetAmount: options.budgetAmount } : {}),
    });
  }
  return project;
}

/** A finished time entry of the signed-in person. `minutes` keeps the sums readable. */
export async function seedEntry(request: APIRequestContext, entry: { projectId: string; date: string; minutes: number; notes?: string; billable?: boolean }) {
  const { projectId, date, minutes, notes, billable } = entry;
  await api(request, "POST", "/api/time-entries", { projectId, date, seconds: minutes * 60, notes: notes ?? "", billable });
}

/** The value of some minutes at an hourly rate in cents, rounded to the cent like an invoice does. */
export const worth = (minutes: number, hourlyRateCents: number) => Math.round((minutes * hourlyRateCents) / 60);
/** What an invoice line charges for this much time: hours to three decimals × the rate, to the cent. */
export const invoiced = (minutes: number, hourlyRateCents: number) => Math.round((Math.round((minutes * 60) / 3.6) * hourlyRateCents) / 1000);

/** 43771 → "$437.71" (the tests run in en-US). */
export const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The signed-in frame is up: its main navigation shows. */
export async function expectSignedIn(page: Page) {
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** Picks an option in a drop-down list (a button that opens a list), given the button. */
export async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole("option", { name: option, exact: true }).click();
}

/** Signs out through the account menu in the header. */
export async function signOut(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: /account menu$/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}
