import { expect, test } from "@playwright/test";
import { api, seedClient, today } from "./helpers.ts";

const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

// Repeating invoices (WRK-42): repeat an invoice every month, and a new draft is made from it
// for someone to check and send.
test("an invoice repeats every month as new drafts, and can be paused", async ({ page, request }) => {
  const client = await seedClient(request);
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: daysAgo(30) });
  await api(request, "POST", `/api/invoices/${invoice.id}/lines`, { description: "Monthly retainer", quantity: 1000, unitPrice: 250_000 });
  try {
    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole("button", { name: "Repeat this invoice" }).click();
    const form = page.getByRole("region", { name: "Repeat this invoice" });
    await expect(form.getByRole("combobox", { name: "Repeats" })).toContainText("Every month");
    // Yesterday, so the first draft is made right away whatever the organization's time zone.
    await form.getByLabel("Next draft on").fill(daysAgo(1));
    await form.getByRole("button", { name: "Start repeating" }).click();
    await expect(page.getByText(/^Repeats every month\. Next draft on /)).toBeVisible();

    // The new draft has the invoice's own line, and waits to be sent.
    await page.getByRole("link", { name: "open it" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /^Invoice / })).toBeVisible();
    await expect(page.locator("article").getByRole("row", { name: /Monthly retainer/ })).toContainText("$2,500.00");
    await expect(page.getByRole("button", { name: "Mark as sent" })).toBeVisible();

    // The list marks the invoice that repeats.
    await page.goto("/invoices");
    await expect(page.getByRole("row").filter({ hasText: client.name }).filter({ hasText: "Every month" })).toHaveCount(1);

    // Paused, it makes no drafts until it's resumed.
    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText(/^Repeats every month, but it's paused/)).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText(/^Repeats every month\. Next draft on /)).toBeVisible();
  } finally {
    const { invoices } = await api<{ invoices: { id: string; client: { id: string } }[] }>(request, "GET", "/api/invoices");
    for (const i of invoices.filter((i) => i.client.id === client.id)) await api(request, "DELETE", `/api/invoices/${i.id}`, {});
  }
});
