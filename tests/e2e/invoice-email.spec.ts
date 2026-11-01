import { expect, test } from "@playwright/test";
import { startFakeSmtp } from "../fakeSmtp.ts";
import { api, dollars, ORG_NAME, seedClient, seedEntry, seedProject, unique } from "./helpers.ts";

// Email is shared by the whole organization, so turn it off again for the other tests.
test.afterEach(async ({ request }) => {
  await api(request, "DELETE", "/api/settings/email", {});
});

test("email an invoice: it is marked sent, shows who got it, and can be followed up with a reminder", async ({ page, request }) => {
  const server = await startFakeSmtp();
  try {
    await api(request, "PUT", "/api/settings/email", {
      provider: "smtp", fromName: ORG_NAME, fromEmail: "billing@studio-north.test", smtpHost: "127.0.0.1", smtpPort: server.port, smtpSecure: false, smtpUser: "",
    });
    const client = await seedClient(request);
    await api(request, "PATCH", `/api/clients/${client.id}`, { email: "ap@client.test" });
    const project = await seedProject(request, { name: unique("Emailed Project"), clientId: client.id, hourlyRate: 10000 });
    await seedEntry(request, { projectId: project.id, date: "2026-02-10", minutes: 90 });
    const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: "2026-02-11", dueDate: "2026-12-31" });

    await page.goto(`/invoices/${invoice.id}`);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Email it to the client, or mark it as sent if you send it another way.")).toBeVisible();
    await expect(page.getByText(/Set up email in Manage/)).toBeHidden();
    await page.getByRole("button", { name: "Email to client" }).click();
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("ap@client.test");
    await page.getByLabel("Message (optional)").fill("Thanks again!");
    await page.getByRole("button", { name: "Send email" }).click();

    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Emailed to ap@client\.test on /)).toBeVisible();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({ from: "billing@studio-north.test", to: ["ap@client.test"], });
    expect(server.received[0]!.subject).toMatch(new RegExp(`^Invoice \\d{4} from ${ORG_NAME}$`));

    // Now sent: the same button sends a reminder.
    await page.reload();
    await expect(page.getByText(/^Emailed to ap@client\.test on /)).toBeVisible();
    await page.getByRole("button", { name: "Email a reminder" }).click();
    await page.getByLabel("To", { exact: true }).fill("boss@client.test");
    await page.getByRole("button", { name: "Send email" }).click();
    await expect(page.getByText(/^Emailed to boss@client\.test on /)).toBeVisible();
    expect(server.received).toHaveLength(2);
    expect(server.received[1]!.to).toEqual(["boss@client.test"]);
    expect(server.received[1]!.subject).toMatch(/^Reminder: invoice \d{4} from /);
    expect(dollars(15000)).toBe("$150.00");
    expect(server.received[1]!.body).toContain("$150.00");

    // Paid invoices can't be emailed.
    await page.getByRole("button", { name: "Mark as paid" }).click();
    await expect(page.getByText("Paid", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Email / })).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("without email set up, the invoice page has no email button", async ({ page, request }) => {
  const client = await seedClient(request);
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: "2026-02-11", dueDate: "2026-12-31" });
  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByRole("button", { name: "Mark as sent" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Email / })).toHaveCount(0);
});

test("with email off, the invoice page says how sending works", async ({ page, request }) => {
  const client = await seedClient(request);
  const project = await seedProject(request, { name: unique("No Email Project"), clientId: client.id, hourlyRate: 10000 });
  await seedEntry(request, { projectId: project.id, date: "2026-02-10", minutes: 60 });
  const { invoice } = await api<{ invoice: { id: string } }>(request, "POST", "/api/invoices", { clientId: client.id, issueDate: "2026-02-11", dueDate: "2026-12-31" });

  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email to client" })).toHaveCount(0);
  await expect(page.getByText("Set up email in Manage → Email to send invoices from here.")).toBeVisible();
  await expect(page.getByText("This is a draft. Mark it as sent when it goes to the client.")).toBeVisible();
});
