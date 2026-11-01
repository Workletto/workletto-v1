import { expect, test, type Locator } from "@playwright/test";
import { choose, dollars, invoiced, seedClient, seedEntry, seedProject, unique, worth } from "./helpers.ts";

const RATE = 9550; // $95.50 an hour
const DAY = "2026-02-10";

test("create an invoice from unbilled time: the total is hours x rate to the cent, then sent and paid", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Invoiced Project"), clientId: client.id, hourlyRate: RATE });
  // 4:35 in all is 4.583 hours on the invoice, and the line charges exactly that: 4.583 × $95.50 = $437.6765.
  const billable = [90, 140, 45];
  for (const minutes of billable) await seedEntry(request, { projectId: project.id, date: DAY, minutes, notes: `Billable ${minutes}` });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 60, notes: "Not billable", billable: false });
  const total = dollars(invoiced(billable.reduce((a, b) => a + b, 0), RATE));
  expect(total).toBe("$437.68");

  // The invoices page offers the client's billable time, not the non-billable hour.
  await page.goto("/invoices");
  const ready = page.getByRole("listitem").filter({ hasText: client.name });
  await expect(ready).toContainText("4:35 billable hours");
  await expect(ready).toContainText(total);
  await ready.getByRole("link", { name: /^Create invoice/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "New invoice" })).toBeVisible();
  await expect(page.getByText(`Includes 4:35 hours (${total})`)).toBeVisible();
  await page.getByRole("button", { name: "Create invoice" }).click();

  // The draft: one line for the project, and the total.
  await expect(page.getByRole("heading", { level: 1, name: "Invoice" })).toBeVisible();
  const invoice = page.locator("article");
  await expect(invoice.getByRole("row", { name: new RegExp(project.name) })).toContainText(total);
  await expect(invoice.getByRole("row", { name: new RegExp(project.name) })).toContainText("$95.50");
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText(`Total${total}`);
  await expect(invoice.getByText(client.name, { exact: true })).toBeVisible();
  const number = (await invoice.locator("dt", { hasText: "Number" }).locator("xpath=following-sibling::dd").textContent())!.trim();
  expect(number).toMatch(/^\d{4}$/);

  // Draft, sent, paid.
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark as unpaid" })).toBeVisible();

  // It was saved: the list shows it as paid, and the client has nothing left to bill.
  await page.goto("/invoices");
  const listed = page.getByRole("row").filter({ hasText: number }).filter({ hasText: client.name });
  await expect(listed).toContainText(total);
  await expect(listed).toContainText("Paid");
  await expect(page.getByRole("listitem").filter({ hasText: client.name })).toHaveCount(0);

  // Invoiced time is locked on the day it was worked; the non-billable hour is still free.
  await page.goto(`/time/day/${DAY}`);
  await expect(page.getByRole("listitem").filter({ hasText: "Billable 90" })).toContainText(`Invoice ${number}`);
  await expect(page.getByRole("listitem").filter({ hasText: "Not billable" }).getByRole("button", { name: /^Edit/ })).toBeVisible();
});

test("tax is added to the subtotal to the cent", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Taxed Project"), clientId: client.id, hourlyRate: RATE });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 270, notes: "Four and a half hours" });
  const subtotal = worth(270, RATE); // $429.75
  const tax = Math.round((subtotal * 825) / 10000); // 8.25% is $35.45 (35.4544)

  await page.goto(`/invoices/new/${client.id}`);
  await expect(page.getByText(`Includes 4:30 hours (${dollars(subtotal)})`)).toBeVisible();
  await page.getByLabel("Tax (%)").fill("8.25");
  await page.getByRole("button", { name: "Create invoice" }).click();

  const invoice = page.locator("article");
  await expect(invoice.getByText("Subtotal").locator("..")).toHaveText(`Subtotal${dollars(subtotal)}`);
  await expect(invoice.getByText("Tax (8.25%)").locator("..")).toHaveText(`Tax (8.25%)${dollars(tax)}`);
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText(`Total${dollars(subtotal + tax)}`);
  expect(dollars(subtotal + tax)).toBe("$465.20");
});

test("the discount and tax fields line up on the new invoice and the draft", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Aligned Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 60 });
  const pageTop = (locator: Locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().y + window.scrollY));
  const top = (label: string | RegExp) => pageTop(page.getByLabel(label, { exact: typeof label === "string" }));

  // On the new invoice the discount's "%" menu sits level with its box; the tax field is under them.
  await page.goto("/invoices");
  await page.getByRole("listitem").filter({ hasText: client.name }).getByRole("link", { name: /^Create invoice/ }).click();
  await expect(page.getByText(/^Includes 1:00 hours/)).toBeVisible();
  const discount = await top("Discount");
  expect(Math.abs((await pageTop(page.getByRole("combobox", { name: "Discount as" }))) - discount)).toBeLessThanOrEqual(1);

  // On the draft the tax field has a hint under it, which used to push the discount row down.

  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Invoice" })).toBeVisible();
  await expect(page.getByLabel("Tax name")).toBeVisible();
  const draft = await top("Discount");
  expect(await top("Tax name")).toBe(draft);
  expect(await top(/^Tax \(%\)/)).toBe(draft);
  expect(Math.abs((await pageTop(page.getByRole("combobox", { name: "Discount as" }))) - draft)).toBeLessThanOrEqual(1);
});

test("the new invoice page previews the invoice as you fill it in, PO number and subject included (WRK-116)", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Preview Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 120, notes: "Two hours" });

  await page.goto(`/invoices/new/${client.id}`);
  const preview = page.getByRole("region", { name: "Invoice preview" });
  await expect(preview.getByRole("heading", { level: 2, name: "Invoice" })).toBeVisible();
  await expect(preview.getByText(client.name, { exact: true })).toBeVisible();
  await expect(preview.getByRole("row", { name: new RegExp(project.name) })).toContainText("$200.00");
  const total = preview.getByText("Total", { exact: true }).locator("..");
  await expect(total).toHaveText("Total$200.00");

  // Discount and tax change the totals straight away, worked out like the server does.
  await page.getByLabel("Discount", { exact: true }).fill("10");
  await page.getByLabel("Tax (%)").fill("8.25");
  await expect(total).toHaveText("Total$194.85"); // 200 − 20 = 180, plus 8.25% = 14.85
  await page.getByLabel("PO number").fill("PO-4412");
  await page.getByLabel("Subject").fill("Brand refresh, phase 1");
  await expect(preview.getByText("PO-4412")).toBeVisible();
  await expect(preview.getByText("Brand refresh, phase 1")).toBeVisible();
  // Grouping by entry shows the entry's own line.
  await choose(page.getByLabel("Lines", { exact: true }), "One line per time entry");
  await expect(preview.getByRole("row", { name: /Two hours/ })).toBeVisible();

  await page.getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Invoice" })).toBeVisible();
  const invoice = page.locator("article");
  await expect(invoice.getByText("Total", { exact: true }).locator("..")).toHaveText("Total$194.85");
  await expect(invoice.getByText("PO-4412")).toBeVisible();
  await expect(invoice.getByText("Brand refresh, phase 1")).toBeVisible();
  // Both can still be changed on the draft.
  await expect(page.getByLabel("PO number")).toHaveValue("PO-4412");
  await expect(page.getByLabel("Subject")).toHaveValue("Brand refresh, phase 1");
});

test("a draft's save error is tied to its field, focuses it, and clears once corrected (WRK-122)", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("Error Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: DAY, minutes: 60 });
  const made = await request.post("/api/invoices", { data: { clientId: client.id, issueDate: DAY } });
  const { invoice } = await made.json();
  await page.goto(`/invoices/${invoice.id}`);
  const tax = page.getByLabel("Tax (%)");
  await tax.fill("-1");
  await page.getByRole("button", { name: "Save changes" }).click();
  const error = page.getByText(/Enter tax as a percentage/);
  await expect(error).toBeVisible();
  await expect(tax).toHaveAttribute("aria-invalid", "true");
  const errorId = await error.getAttribute("id");
  expect(errorId).toBeTruthy();
  await expect(tax).toHaveAttribute("aria-describedby", new RegExp(errorId!.replace(/[:]/g, "\\:")));
  await expect(tax).toBeFocused();
  // Correcting it clears the error and the field's invalid state.
  await tax.fill("8.25");
  await expect(error).toBeHidden();
  await expect(tax).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
});
