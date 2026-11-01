import { expect, test } from "@playwright/test";
import { api, choose, dollars, seedClient, seedEntry, seedProject, today, unique, worth } from "./helpers.ts";

const RATE = 9550; // $95.50 an hour
const DAY = "2026-03-10";
const DEFAULTS = { prefix: "", nextNumber: "0001", dueDays: 30, taxPercent: "", taxLabel: "", notes: "", reminderDays: 0 };
const NOTES = "Please pay by bank transfer to account 12345678.";
const inDays = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// The other invoice tests expect four-digit numbers and no tax.
test.afterEach(async ({ request }) => {
  await api(request, "PUT", "/api/settings/invoices", DEFAULTS);
});

test("invoice settings number new invoices and fill in their terms, tax and notes; a discount shows on the invoice and its PDF", async ({ page, request }) => {
  await page.goto("/manage/invoices");
  await expect(page.getByRole("heading", { level: 1, name: "Invoicing", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Help for this page/ })).toHaveAttribute("href", /\/help\/invoicing-and-payments\/invoice-settings$/);
  await page.getByLabel("Prefix").fill("WL-");
  await page.getByLabel("Next number").fill("0100");
  await expect(page.getByText("Next invoice: WL-0100")).toBeVisible();
  await choose(page.getByLabel("New invoices are due"), "14 days after the issue date");
  await page.getByLabel("Name on invoices").fill("VAT");
  await page.getByLabel("Default rate (%)").fill("20");
  await page.getByLabel("Notes on new invoices").fill(NOTES);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // A new invoice starts with them, and takes a discount.
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Discounted Project"), clientId: client.id, hourlyRate: RATE });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 270, notes: "Four and a half hours" });
  await page.goto(`/invoices/new/${client.id}`);
  await expect(page.getByLabel("VAT (%)")).toHaveValue("20");
  await expect(page.getByLabel("Due date")).toHaveValue(inDays(14));
  await expect(page.getByLabel("Notes (payment details, thanks)")).toHaveValue(NOTES);
  await expect(page.getByText("It will be number WL-0100.")).toBeVisible();
  await page.getByLabel("Discount", { exact: true }).fill("12.5");
  await page.getByRole("button", { name: "Create invoice" }).click();

  // $429.75, less 12.5% ($53.71875 → $53.72), plus 20% VAT on $376.03 ($75.206 → $75.21).
  const subtotal = worth(270, RATE);
  const discount = Math.round((subtotal * 1250) / 10000);
  const vat = Math.round(((subtotal - discount) * 2000) / 10000);
  expect([subtotal, discount, vat, subtotal - discount + vat].map(dollars)).toEqual(["$429.75", "$53.72", "$75.21", "$451.24"]);

  const invoice = page.locator("article");
  await expect(invoice.locator("dt", { hasText: "Number" }).locator("xpath=following-sibling::dd")).toHaveText("WL-0100");
  await expect(invoice.getByText("Subtotal").locator("..")).toHaveText(`Subtotal${dollars(subtotal)}`);
  await expect(invoice.getByText("Discount (12.5%)").locator("..")).toHaveText(`Discount (12.5%)${dollars(-discount)}`);
  await expect(invoice.getByText("VAT (20%)").locator("..")).toHaveText(`VAT (20%)${dollars(vat)}`);
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText(`Total${dollars(subtotal - discount + vat)}`);
  await expect(invoice.getByText(NOTES)).toBeVisible();

  // The PDF is the printed page: the discount and VAT are on it, the buttons aren't.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeHidden();
  await expect(invoice.getByText("Discount (12.5%)")).toBeVisible();
  await expect(invoice.getByText("VAT (20%)")).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  // The draft can change its own discount: an amount instead of a percentage.
  // Nothing has changed yet, so there is nothing to save.
  const saveChanges = page.getByRole("button", { name: "Save changes" });
  await expect(saveChanges).toHaveAttribute("aria-disabled", "true");
  await page.getByLabel("Discount", { exact: true }).fill("100");
  await choose(page.getByRole("combobox", { name: "Discount as" }), "USD");
  await expect(saveChanges).not.toHaveAttribute("aria-disabled", "true");
  await saveChanges.click();
  await expect(invoice.getByText("Discount", { exact: true }).locator("..")).toHaveText(`Discount${dollars(-10000)}`);
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(saveChanges).toHaveAttribute("aria-disabled", "true");
  // Changing it again takes the note away and turns the button back on.
  await page.getByLabel("Discount", { exact: true }).fill("120");
  await expect(page.getByText("Saved.", { exact: true })).toBeHidden();
  await expect(saveChanges).not.toHaveAttribute("aria-disabled", "true");
  await page.getByLabel("Discount", { exact: true }).fill("100");
  await expect(saveChanges).toHaveAttribute("aria-disabled", "true");

  // The next invoice carries on from there.
  const next = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: today() });
  const made = await api<{ invoice: { number: string; taxLabel: string } }>(request, "GET", `/api/invoices/${next.invoice.id}`);
  expect(made.invoice).toMatchObject({ number: "WL-0101", taxLabel: "VAT" });
});

test("a custom payment term, and setting the due date by terms (WRK-103, WRK-104)", async ({ page, request }) => {
  await page.goto("/manage/invoices");
  await choose(page.getByLabel("New invoices are due"), "Custom…");
  await page.getByLabel("Days after the issue date", { exact: true }).fill("21");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  const client = await seedClient(request);
  await page.goto(`/invoices/new/${client.id}`);
  await expect(page.getByLabel("Due date")).toHaveValue(inDays(21));
  await expect(page.getByLabel("Due in")).toContainText("21 days");
  await choose(page.getByLabel("Due in"), "60 days");
  await expect(page.getByLabel("Due date")).toHaveValue(inDays(60));
  // A new issue date keeps the terms.
  await page.getByLabel("Issue date").fill(inDays(1));
  await expect(page.getByLabel("Due date")).toHaveValue(inDays(61));
  // A date picked by hand shows its terms; one before the issue date shows as "Other date".
  await page.getByLabel("Due date").fill(inDays(50));
  await expect(page.getByLabel("Due in")).toContainText("49 days");
  await page.getByLabel("Due date").fill(inDays(0));
  await expect(page.getByLabel("Due in")).toContainText("Other date");
});

test("late-payment reminders are turned on in Invoicing, and each sent invoice can opt out (WRK-146)", async ({ page, request }) => {
  await page.goto("/manage/invoices");
  await choose(page.getByLabel("Remind clients about unpaid invoices"), "7 days after the due date");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  const client = await seedClient(request);
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: today(), dueDate: inDays(3) });
  await api(request, "POST", `/api/invoices/${invoice.id}/lines`, { description: "Retainer", quantity: 1000, unitPrice: 50_000 });
  await api(request, "PATCH", `/api/invoices/${invoice.id}`, { status: "sent" });

  await page.goto(`/invoices/${invoice.id}`);
  const section = page.getByRole("region", { name: "Late-payment reminders" });
  await expect(section.getByText(/^Next reminder on .+, if it's still unpaid\.$/)).toBeVisible();
  await expect(section.getByRole("link", { name: /^Help with late-payment reminders/ })).toHaveAttribute("href", /\/help\/invoicing-and-payments\/email-an-invoice$/);
  const optOut = section.getByRole("checkbox", { name: "Don't remind" });
  await optOut.click();
  await expect(optOut).toBeChecked();
  await expect(section.getByText("The client won't be reminded about this invoice.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Late-payment reminders" }).getByRole("checkbox", { name: "Don't remind" })).toBeChecked();
});
