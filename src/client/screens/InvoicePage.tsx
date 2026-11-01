import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Box, Dialog, Flex, Grid, Heading, Table, Text, TextField } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { api, type Invoice, type InvoiceLine, type InvoiceSchedule } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { setPageTitle } from "../theme.ts";
import { ActionButton, CheckField, ErrorNote, Field, FORM_ERROR_ID, HelpLink, InlineError, Loading, RowButton, Select, RowMenu, RowMenuItem, SavedNote, SaveButton, SrOnly, TextAreaInput, TextInput, useConfirm, usePageHeading, useSaveForm } from "../ui.tsx";
import { formatMoney, formatQuantity, moneyInput, parseMoney } from "../../shared/money.ts";
import { DiscountField, discountBody, discountForm, DueDateField, InvoiceStatus, withIssueDate } from "./Invoices.tsx";
import { InvoicePaper, type From } from "./InvoicePaper.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { occurrence, REPEAT_EVERY, REPEAT_LABELS, type RepeatEvery } from "../../shared/repeat.ts";
import { dueReminder, MAX_REMINDERS, reminderDate } from "../../shared/reminders.ts";

const quantityText = formatQuantity;

// One invoice: change it while it's a draft, mark it sent or paid, and save it
// as a PDF from the browser's print dialog.
export function InvoicePage({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [data, setData] = useState<{ invoice: Invoice; from: From; emailConfigured: boolean; reminderDays: number; payLink: string | null; payments: { amountCents: number; currency: string; paidAt: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/invoices/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  // The tab's title is the invoice number. The PDF's file name comes from the title
  // while printing, so that carries the client's name too.
  const number = data?.invoice.number;
  const heading = usePageHeading(number && `Invoice ${number}`);
  useAnnounceWhen(data !== null, "Invoice loaded.");
  useEffect(() => {
    if (!data) return;
    const tabTitle = `Invoice ${data.invoice.number}`;
    const forPdf = () => setPageTitle(`Invoice ${data.invoice.number} – ${data.invoice.client.name}`);
    const back = () => setPageTitle(tabTitle);
    window.addEventListener("beforeprint", forPdf);
    window.addEventListener("afterprint", back);
    return () => {
      window.removeEventListener("beforeprint", forPdf);
      window.removeEventListener("afterprint", back);
    };
  }, [data]);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (!data) return error ? <ErrorNote message={error} /> : <Loading />;
  const { invoice, from, emailConfigured, payLink, payments } = data;
  const draft = invoice.status === "draft";
  const setStatus = (status: Invoice["status"], done: string) => run(() => api(`/api/invoices/${id}`, { status }, "PATCH")).then((ok) => ok && announce(done));
  async function remove() {
    const ok = await confirm({
      title: `Delete invoice ${invoice.number}?`,
      description: "Its time and expenses can be billed again. This can't be undone.",
      confirm: "Delete invoice",
    });
    if (ok) void run(async () => { await api(`/api/invoices/${id}`, undefined, "DELETE"); navigate("/invoices"); });
  }

  return (
    <>
      <div className="wl-no-print wl-page-header">
        <Box minWidth="0">
          <p className="wl-eyebrow"><Link to="/invoices" className="wl-link">Invoices</Link></p>
          <Flex align="center" gap="3" wrap="wrap">
            <Heading ref={heading} as="h1" tabIndex={-1} size="6" className="wl-num">Invoice {invoice.number}</Heading>
            <InvoiceStatus invoice={invoice} />
            <HelpLink article={draft ? "invoicing-and-payments/create-an-invoice" : "invoicing-and-payments/email-an-invoice"} />
          </Flex>
        </Box>
        <Flex wrap="wrap" align="center" gap="2" className="wl-page-actions">
          {emailConfigured && invoice.status !== "paid" && (
            <EmailDialog invoice={invoice} onSent={async () => { await load(); announce("Invoice emailed."); }} />
          )}
          {invoice.status === "draft" && <ActionButton onClick={() => void setStatus("sent", "Marked as sent.")}>Mark as sent</ActionButton>}
          {invoice.status === "sent" && <ActionButton onClick={() => void setStatus("paid", "Marked as paid.")}>Mark as paid</ActionButton>}
          {invoice.status === "sent" && <RowButton onClick={() => void setStatus("draft", "Back to draft.")}>Back to draft</RowButton>}
          {invoice.status === "paid" && <RowButton onClick={() => void setStatus("sent", "Marked as unpaid.")}>Mark as unpaid</RowButton>}
          <RowButton onClick={() => window.print()} title="Opens your browser's print dialog. Choose Save as PDF.">Print / Save as PDF</RowButton>
          {draft && (
            <RowMenu label={`More actions for invoice ${invoice.number}`}>
              <RowMenuItem danger onSelect={() => void remove()}>Delete invoice</RowMenuItem>
            </RowMenu>
          )}
        </Flex>
      </div>
      <div className="wl-no-print">
        <ErrorNote message={error} />
        {!emailConfigured && invoice.status !== "paid" && (
          <Text as="p" size="2" color="gray">
            {isAdmin ? "Set up email in Manage → Email to send invoices from here." : "Ask an admin to set up email."}
          </Text>
        )}
        {invoice.emailedAt && (
          <Text as="p" size="2" color="gray" role="status">
            {draft ? "Last emailed to" : "Emailed to"} {invoice.emailedTo ?? invoice.client.email} on {new Date(invoice.emailedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
            {draft ? ", before it went back to draft." : "."}
          </Text>
        )}
      </div>
      {(payLink || payments.length > 0) && (
        <Flex direction="column" gap="2" className="wl-no-print" mt="3">
          {payLink && <PayLink link={payLink} />}
          {payments.map((p, i) => (
            <Text key={i} as="p" size="2" color="gray">
              Paid online {formatMoney(p.amountCents, p.currency)} on {new Date(p.paidAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
            </Text>
          ))}
        </Flex>
      )}
      <RepeatSection invoice={invoice} reload={load} />
      {invoice.status === "sent" && (data.reminderDays > 0 || invoice.lastReminderAt) && <ReminderSection invoice={invoice} days={data.reminderDays} reload={load} />}
      {draft && <DraftSettings invoice={invoice} emailConfigured={emailConfigured} reload={load} />}

      <InvoicePaper
        invoice={invoice}
        from={from}
        heading={<Heading as="h2" size="8" mb="3">Invoice</Heading>}
        lines={invoice.lines.map((line) => <LineRow key={line.id} line={line} invoiceId={id} currency={invoice.currency} editable={draft} run={run} />)}
        lineCount={invoice.lines.length}
        empty="No lines yet."
        actionsColumn={draft}
        afterLines={draft && <NewLine invoiceId={id} run={run} />}
        addressHint={draft}
      />
    </>
  );
}

// Sends the invoice (or, once it has been sent, a reminder) by email. The server marks a draft as sent.
function EmailDialog({ invoice, onSent }: { invoice: Invoice; onSent: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;
  const reminder = invoice.status === "sent";
  const label = reminder ? "Email a reminder" : "Email to client";

  function close() {
    setError(null);
    setBusy(false);
    setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy(true);
    try {
      await api(`/api/invoices/${invoice.id}/email`, { to: String(form.get("to") ?? ""), message: String(form.get("message") ?? "") });
      close();
      await onSent();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : !busy && close())}>
      <Dialog.Trigger>
        <ActionButton variant="outline" color="gray">{label}</ActionButton>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="30rem">
        <Dialog.Title size="4">{label}</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {reminder ? "They get the invoice again, as a reminder." : "They get the invoice in the email, and it is marked as sent."} There is no PDF attached.
        </Dialog.Description>
        <form onSubmit={submit} noValidate>
          <Field label="To" name="to" type="email" defaultValue={invoice.client.email} autoComplete="off" required autoFocus errorId={errorId} />
          <TextAreaInput label="Message (optional)" name="message" rows={4} maxLength={2000} hint="Shown above the invoice." />
          <InlineError id={FORM_ERROR_ID} message={error} spaced />
          <Flex gap="3" mt="2" justify="end">
            <Dialog.Close>
              <RowButton type="button">Cancel</RowButton>
            </Dialog.Close>
            <ActionButton type="submit" busy={busy}>Send email</ActionButton>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Which draft field a server message is about, so it can be marked and focused (WRK-122). */
const longDate = (day: string) => formatDay(day, { day: "numeric", month: "long", year: "numeric" });

/** "Repeats every month. Next draft on November 23, 2026, until June 30, 2027." */
function repeatSummary(schedule: InvoiceSchedule) {
  const every = REPEAT_LABELS[schedule.every].toLowerCase();
  if (schedule.nextDate === null) return `Repeated ${every} until ${longDate(schedule.endDate!)}. That end date has passed.`;
  if (schedule.paused) return `Repeats ${every}, but it's paused: no drafts are made until you resume it.`;
  return `Repeats ${every}. Next draft on ${longDate(schedule.nextDate)}${schedule.endDate ? `, until ${longDate(schedule.endDate)}` : ""}.`;
}

/**
 * Repeat this invoice (WRK-42): every week, month or 3 months a new draft is made from it, for
 * someone to check and send. Shown on every invoice, since a sent one can be the pattern too.
 */
// Late-payment reminders (WRK-146): when the last one went out, when the next one will, and
// "Don't remind" for this invoice.
function ReminderSection({ invoice, days, reload }: { invoice: Invoice; days: number; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = days > 0 && !invoice.remindersOff && invoice.remindersSent < MAX_REMINDERS ? reminderDate(invoice.dueDate, days, invoice.remindersSent) : null;
  async function toggle(off: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/invoices/${invoice.id}/reminders`, { off }, "PATCH");
      await reload();
      announce(off ? "No reminders for this invoice." : "Reminders are on for this invoice.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wl-no-print" aria-label="Late-payment reminders">
      <Flex direction="column" gap="2" mt="3">
        <ErrorNote message={error} />
        {invoice.lastReminderAt && (
          <Text as="p" size="2" color="gray">
            Reminder sent on {new Date(invoice.lastReminderAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} ({invoice.remindersSent} of {MAX_REMINDERS}).
          </Text>
        )}
        <Flex wrap="wrap" align="center" gap="3">
          <CheckField
            label="Don't remind"
            checked={invoice.remindersOff}
            disabled={busy}
            onChange={(off) => void toggle(off)}
            hint={days === 0
              ? "Late-payment reminders are off for all invoices (Manage → Invoicing)."
              : next
                ? dueReminder(invoice.dueDate, days, invoice.remindersSent, localToday()) !== null
                  ? "The next reminder goes out within a few minutes."
                  : `Next reminder on ${longDate(next)}, if it's still unpaid.`
                : invoice.remindersOff ? "The client won't be reminded about this invoice." : "No more reminders will be sent."}
          />
          <HelpLink article="invoicing-and-payments/email-an-invoice" label="Help with late-payment reminders" />
        </Flex>
      </Flex>
    </section>
  );
}

function RepeatSection({ invoice, reload }: { invoice: Invoice; reload: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const schedule = invoice.schedule;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const today = localToday();
  const suggested = () => {
    const every: RepeatEvery = schedule?.every ?? "month";
    const next = schedule?.nextDate ?? occurrence(invoice.issueDate, every, 1);
    return { every, nextDate: next < today ? today : next, endDate: schedule?.endDate ?? "" };
  };
  const [form, setForm] = useState(suggested);
  const state = useSaveForm(form);

  async function act(work: () => Promise<{ made: string[] }>, done: string) {
    setError(null);
    try {
      const result = await work();
      setMade(result.made);
      await reload();
      announce(result.made.length ? `${done} ${result.made.length === 1 ? "A new draft was made." : `${result.made.length} new drafts were made.`}` : done);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const save = (e: FormEvent) => {
    e.preventDefault();
    void state.save(async () => {
      const result = await api<{ made: string[] }>(`/api/invoices/${invoice.id}/schedule`, { every: form.every, nextDate: form.nextDate, endDate: form.endDate || null }, "PUT");
      setMade(result.made);
      await reload();
      setEditing(false);
    }, "Saved.");
  };
  const setPaused = (paused: boolean) => act(() => api(`/api/invoices/${invoice.id}/schedule`, { paused }, "PATCH"), paused ? "Paused." : "Resumed.");
  async function stop() {
    const ok = await confirm({
      title: "Stop repeating this invoice?",
      description: "No more drafts are made from it. The drafts already made stay as they are.",
      confirm: "Stop repeating",
    });
    if (ok) void act(async () => { await api(`/api/invoices/${invoice.id}/schedule`, undefined, "DELETE"); return { made: [] }; }, "It no longer repeats.");
  }

  const newDrafts = made.length > 0 && (
    <Text as="p" size="2" role="status">
      {made.length === 1 ? "A new draft was made: " : `${made.length} new drafts were made, the latest: `}
      <Link to={`/invoices/${made[made.length - 1]}`} className="wl-link">open it</Link>.
    </Text>
  );

  if (!editing) {
    return (
      <section className="wl-no-print" aria-label="Repeat this invoice">
        <Flex direction="column" gap="2" mt="3">
          <ErrorNote message={error} />
          {schedule ? (
            <Flex wrap="wrap" align="center" gap="3">
              <Text size="2">{repeatSummary(schedule)}</Text>
              <Flex gap="2" align="center">
                <RowButton onClick={() => { setForm(suggested()); setEditing(true); }}>Change</RowButton>
                {schedule.nextDate !== null && <RowButton onClick={() => void setPaused(!schedule.paused)}>{schedule.paused ? "Resume" : "Pause"}</RowButton>}
                <RowButton onClick={() => void stop()}>Stop repeating</RowButton>
                <HelpLink article="invoicing-and-payments/repeat-an-invoice" label="Help with repeating invoices" />
              </Flex>
            </Flex>
          ) : (
            <Flex align="center" gap="2">
              <RowButton onClick={() => { setForm(suggested()); setEditing(true); }}>Repeat this invoice</RowButton>
              <HelpLink article="invoicing-and-payments/repeat-an-invoice" label="Help with repeating invoices" />
            </Flex>
          )}
          {newDrafts}
        </Flex>
      </section>
    );
  }
  return (
    <section className="wl-no-print wl-panel" aria-label="Repeat this invoice">
      <form onSubmit={save}>
        <Flex direction="column" gap="3">
          <Text as="p" size="2" weight="medium">Repeat this invoice</Text>
          <Grid columns={{ initial: "1", sm: "repeat(3, minmax(0, 1fr))" }} gap="3">
            <Select label="Repeats" value={form.every} onChange={(every) => setForm({ ...form, every: every as RepeatEvery })} options={REPEAT_EVERY.map((value) => ({ value, label: REPEAT_LABELS[value] }))} />
            <TextInput label="Next draft on" type="date" {...state.fieldProps("nextDate")} value={form.nextDate} onChange={(e) => setForm({ ...form, nextDate: e.target.value })} required />
            <TextInput label="Ends on (optional)" type="date" {...state.fieldProps("endDate")} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} min={form.nextDate} />
          </Grid>
          <Text as="p" size="1" color="gray">
            Each repeat is a new draft for you to check and send: nothing is sent by itself. It copies this invoice's lines, fixed fees while there's fee left, tax, discount, notes and payment terms. Time and expenses aren't copied; add new ones to each draft.
          </Text>
          <Flex align="center" justify="end" gap="3">
            <SavedNote message={state.message} />
            <RowButton type="button" onClick={() => setEditing(false)}>Cancel</RowButton>
            {/* Starting needs no change: the suggested dates are a fine answer. */}
            {schedule ? <SaveButton state={state}>Save changes</SaveButton> : <ActionButton type="submit" busy={state.busy} busyLabel="Saving…">Start repeating</ActionButton>}
          </Flex>
        </Flex>
      </form>
    </section>
  );
}

function draftFieldOf(message: string): string | null {
  if (/tax name/i.test(message)) return "taxLabel";
  if (/\btax\b/i.test(message)) return "taxPercent";
  if (/discount/i.test(message)) return "discount";
  if (/PO number/i.test(message)) return "poNumber";
  if (/subject/i.test(message)) return "subject";
  if (/notes/i.test(message)) return "notes";
  if (/due date|dates/i.test(message)) return "dueDate";
  if (/number/i.test(message)) return "number";
  return null;
}

function DraftSettings({ invoice, emailConfigured, reload }: { invoice: Invoice; emailConfigured: boolean; reload: () => Promise<unknown> }) {
  const [form, setForm] = useState({
    number: invoice.number,
    poNumber: invoice.poNumber,
    subject: invoice.subject,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    taxPercent: String(invoice.taxBasisPoints / 100),
    taxLabel: invoice.taxLabel,
    ...discountForm(invoice),
    notes: invoice.notes,
  });
  const state = useSaveForm(form, { fieldOf: draftFieldOf });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { discountKind, discount: discountText, ...fields } = form;
    const discount = discountBody(discountKind, discountText);
    if ("error" in discount) return state.fail(discount.error);
    void state.save(async () => {
      await api(`/api/invoices/${invoice.id}`, { ...fields, ...discount }, "PATCH");
      await reload();
    }, "Invoice saved.");
  };
  // A tinted panel, so editing reads apart from the invoice below it (WRK-121).
  return (
    <section className="wl-no-print wl-panel" aria-label="Invoice details">
      <form onSubmit={save}>
        <Flex direction="column" gap="3">
          <Text as="p" size="2" weight="medium">Invoice details</Text>
          <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" }} gap="3">
            <TextInput label="Number" {...state.fieldProps("number")} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} required maxLength={30} />
            <TextInput label="Issue date" type="date" value={form.issueDate} onChange={(e) => setForm(withIssueDate(form, e.target.value))} required />
            <DueDateField issueDate={form.issueDate} dueDate={form.dueDate} onChange={(dueDate) => setForm({ ...form, dueDate })} field={state.fieldProps("dueDate")} />
            <DiscountField kind={form.discountKind} value={form.discount} currency={invoice.currency} subtotal={invoice.lines.reduce((sum, l) => sum + l.amount, 0)} onChange={(discountKind, discount) => setForm({ ...form, discountKind, discount })} field={state.fieldProps("discount")} />
            <TextInput label="Tax name" {...state.fieldProps("taxLabel")} value={form.taxLabel} onChange={(e) => setForm({ ...form, taxLabel: e.target.value })} maxLength={20} placeholder="Tax" />
            <TextInput label={`${form.taxLabel.trim() || "Tax"} (%)`} {...state.fieldProps("taxPercent")} inputMode="decimal" value={form.taxPercent} onChange={(e) => setForm({ ...form, taxPercent: e.target.value })} className="wl-num" />
          </Grid>
          <Grid columns={{ initial: "1", sm: "2fr 1fr" }} gap="3">
            <TextInput label="Subject" {...state.fieldProps("subject")} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={200} placeholder="What it's for, like Website redesign" />
            <TextInput label="PO number" {...state.fieldProps("poNumber")} value={form.poNumber} onChange={(e) => setForm({ ...form, poNumber: e.target.value })} maxLength={50} />
          </Grid>
          <TextAreaInput label="Notes" {...state.fieldProps("notes")} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} maxLength={2000} />
          <Flex wrap="wrap" align="center" justify="between" gap="3">
            <Text size="1" color="gray">
              {emailConfigured ? "Email it to the client, or mark it as sent if you send it another way." : "This is a draft. Mark it as sent when it goes to the client."}
            </Text>
            <Flex align="center" gap="3">
              {state.dirty && <Text size="1" color="gray">Save changes to update the invoice below.</Text>}
              <SavedNote message={state.message} />
              <SaveButton state={state}>Save changes</SaveButton>
            </Flex>
          </Flex>
        </Flex>
      </form>
    </section>
  );
}

function LineRow({ line, invoiceId, currency, editable, run }: {
  line: InvoiceLine; invoiceId: string; currency: string; editable: boolean; run: (work: () => Promise<unknown>) => Promise<boolean>;
}) {
  const editor = useEditor();
  const confirm = useConfirm();
  const [form, setForm] = useState({ description: line.description, quantity: quantityText(line.quantity), unitPrice: moneyInput(line.unitPrice) });

  async function remove() {
    const ok = await confirm({ title: "Remove this line?", description: `${line.description}. Its time and expenses can be billed again.`, confirm: "Remove line" });
    if (ok && (await run(() => api(`/api/invoices/${invoiceId}/lines/${line.id}`, undefined, "DELETE")))) announce("Line removed.");
  }

  if (editor.editing) {
    const save = () => {
      const quantity = Math.round(Number(form.quantity.replace(",", ".")) * 1000);
      const unitPrice = parseMoney(form.unitPrice.replace(/^-/, ""));
      if (!Number.isFinite(quantity) || quantity < 0 || unitPrice === null || Number.isNaN(unitPrice)) {
        void run(async () => { throw new Error("Enter a quantity and a rate, like 1 and 500 (or -50 for a discount)."); });
        return;
      }
      const signed = form.unitPrice.trim().startsWith("-") ? -unitPrice : unitPrice;
      void run(() => api(`/api/invoices/${invoiceId}/lines/${line.id}`, { description: form.description, quantity, unitPrice: signed }, "PATCH")).then((ok) => ok && editor.close());
    };
    return (
      <Table.Row align="center" className="wl-editor">
        <Table.Cell><TextField.Root autoFocus size="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Description" /></Table.Cell>
        <Table.Cell><TextField.Root size="2" className="wl-num wl-right" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="decimal" aria-label="Quantity" /></Table.Cell>
        <Table.Cell><TextField.Root size="2" className="wl-num wl-right" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} inputMode="decimal" aria-label="Rate" /></Table.Cell>
        <Table.Cell colSpan={2} justify="end">
          <Flex gap="2" justify="end">
            <RowButton onClick={() => editor.close()}>Cancel</RowButton>
            <ActionButton onClick={save}>Save</ActionButton>
          </Flex>
        </Table.Cell>
      </Table.Row>
    );
  }
  return (
    <Table.Row align="center">
      <Table.RowHeaderCell style={{ overflowWrap: "anywhere" }}>{line.description}</Table.RowHeaderCell>
      <Table.Cell justify="end" className="wl-num">{quantityText(line.quantity)}</Table.Cell>
      <Table.Cell justify="end" className="wl-num">{formatMoney(line.unitPrice, currency)}</Table.Cell>
      <Table.Cell justify="end" className="wl-num">{formatMoney(line.amount, currency)}</Table.Cell>
      {editable && (
        <Table.Cell justify="end" className="wl-no-print">
          <Flex gap="2" justify="end">
            <RowButton ref={editor.openerRef} onClick={editor.open}>Edit<SrOnly> {line.description}</SrOnly></RowButton>
            <RowMenu label={`More actions for ${line.description}`}>
              <RowMenuItem danger onSelect={() => void remove()}>Remove line</RowMenuItem>
            </RowMenu>
          </Flex>
        </Table.Cell>
      )}
    </Table.Row>
  );
}

// A line of your own: a fixed fee, or a discount with a negative rate.
function NewLine({ invoiceId, run }: { invoiceId: string; run: (work: () => Promise<unknown>) => Promise<boolean> }) {
  const editor = useEditor();
  const [form, setForm] = useState({ description: "", quantity: "1", unitPrice: "" });
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  if (!editor.editing) {
    return (
      <div className="wl-no-print">
        <RowButton flush ref={editor.openerRef} onClick={editor.open}>Add a line</RowButton>
      </div>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const quantity = Math.round(Number(form.quantity.replace(",", ".")) * 1000);
    const negative = form.unitPrice.trim().startsWith("-");
    const price = parseMoney(form.unitPrice.replace(/^\s*-/, ""));
    if (!Number.isFinite(quantity) || quantity < 0 || !price) return setError("Enter a quantity and a rate, like 1 and 500 (or -50 for a discount).");
    setError(null);
    void run(async () => {
      await api(`/api/invoices/${invoiceId}/lines`, { description: form.description, quantity, unitPrice: negative ? -price : price });
      setForm({ description: "", quantity: "1", unitPrice: "" });
      editor.close();
    }).then((ok) => ok && announce("Line added."));
  };
  return (
    <form onSubmit={submit} className="wl-no-print">
      <Flex direction="column" gap="3">
        <Flex wrap="wrap" align="end" gap="3">
          <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
            <TextInput label="Description" autoFocus value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={500} />
          </div>
          <div style={{ width: "6rem" }}>
            <TextInput label="Quantity" className="wl-num wl-right" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="decimal" invalid={error ? true : undefined} errorId={error ? errorId : undefined} />
          </div>
          <div style={{ width: "8rem" }}>
            <TextInput label="Rate" className="wl-num wl-right" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} inputMode="decimal" placeholder="0.00" invalid={error ? true : undefined} errorId={error ? errorId : undefined} />
          </div>
        </Flex>
        <InlineError message={error} id={errorId} />
        <Flex gap="3" justify="end">
          <RowButton type="button" onClick={() => editor.close()}>Cancel</RowButton>
          <ActionButton type="submit">Add</ActionButton>
        </Flex>
      </Flex>
    </form>
  );
}

// The link a client uses to pay this invoice online.
function PayLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      announce("Copied.");
    } catch {
      setCopied(false);
    }
  }
  return (
    <Flex wrap="wrap" align="center" gap="2">
      <Text size="2" weight="medium">Pay online link</Text>
      <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
        <TextField.Root size="2" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Pay online link" className="wl-mono" />
      </div>
      <ActionButton variant="outline" color="gray" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</ActionButton>
    </Flex>
  );
}
