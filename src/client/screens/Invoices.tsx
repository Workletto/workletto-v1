import { useEffect, useId, useState, type FormEvent } from "react";
import { Box, Flex, Grid, Heading, RadioGroup, Table, Text, TextField } from "@radix-ui/themes";
import { useAnnounceWhen } from "../a11y.tsx";
import { api, type Client, type Invoice, type InvoiceSettings } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { ActionButton, Card, CheckField, Empty, ErrorNote, FormSection, ArticleLink, InlineError, Loading, Notice, PageHeader, RadioOption, Row, RowActions, RowLink, RowMain, Rows, SectionTitle, Select, SrOnly, StatusBadge, TableRegion, TextAreaInput, TextInput, useControlSize } from "../ui.tsx";
import { addDays, daysBetween, formatDuration } from "../../shared/time.ts";
import { formatMoney, moneyByCurrency, moneyInput, parseMoney } from "../../shared/money.ts";
import { feeLineDescription, invoiceTotals, readPercent } from "../../shared/invoiceMath.ts";
import { InvoicePaper, PaperLine, type From, type PaperInvoice } from "./InvoicePaper.tsx";
import { REPEAT_LABELS } from "../../shared/repeat.ts";

/** fees: what's left to bill of the client's fixed fee projects. */
type Ready = { client: { id: string; name: string }; currency: string; seconds: number; amount: number; expenses: number; fees: number };


/** An invoice's status as a badge. A sent invoice past its due date reads Overdue. */
export function InvoiceStatus({ invoice }: { invoice: Pick<Invoice, "status" | "dueDate"> }) {
  const overdue = invoice.status === "sent" && invoice.dueDate < localToday();
  return <StatusBadge status={overdue ? "overdue" : invoice.status} />;
}

// Invoices (admins and managers): what's ready to bill, and every invoice so far.
export function Invoices() {
  const [ready, setReady] = useState<Ready[]>([]);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<{ clients: Ready[] }>("/api/invoices/unbilled"), api<{ invoices: Invoice[] }>("/api/invoices")])
      .then(([r, i]) => {
        setReady(r.clients);
        setInvoices(i.invoices);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useAnnounceWhen(invoices !== null, "Invoices loaded.");
  // Each invoice is in its client's currency; what's waiting is shown per currency.
  const outstanding = moneyByCurrency(invoices?.filter((i) => i.status === "sent").map((i) => ({ amount: i.total, currency: i.currency })) ?? []);

  return (
    <>
      <PageHeader title="Invoices" help="invoicing-and-payments/create-an-invoice" intro={outstanding ? `${outstanding} waiting to be paid.` : "Bill your clients for their time and expenses."}>
        <ActionButton asChild>
          <Link to="/invoices/new">New invoice</Link>
        </ActionButton>
      </PageHeader>
      <ErrorNote message={error} />

      {ready.length > 0 && (
        <section>
          <SectionTitle>Ready to invoice</SectionTitle>
          <Card>
            <Rows>
              {ready.map((r) => (
                <Row key={r.client.id}>
                  <RowMain>
                    <Text as="p" size="2" weight="medium">{r.client.name}</Text>
                    <Text as="p" size="2" color="gray">
                      {[
                        r.seconds > 0 && `${formatDuration(r.seconds)} billable hours`,
                        r.expenses > 0 && `${formatMoney(r.expenses, r.currency)} in expenses`,
                        r.fees > 0 && `${formatMoney(r.fees, r.currency)} of fixed fees left to bill`,
                      ].filter(Boolean).join(" · ")}
                    </Text>
                  </RowMain>
                  <Text size="2" weight="medium" className="wl-num">{formatMoney(r.amount + r.expenses + r.fees, r.currency)}</Text>
                  <RowActions>
                    <RowLink to={`/invoices/new/${r.client.id}`}>Create invoice<SrOnly> for {r.client.name}</SrOnly></RowLink>
                  </RowActions>
                </Row>
              ))}
            </Rows>
          </Card>
        </section>
      )}

      {invoices !== null && invoices.some((i) => i.status !== "draft") && <AccountingExport />}

      <section>
        <SectionTitle>All invoices</SectionTitle>
        <Card>
          {invoices === null ? (
            <Empty>Loading…</Empty>
          ) : invoices.length === 0 ? (
            <Empty action={ready.length === 0 ? <ActionButton asChild><Link to="/invoices/new">Create the first invoice</Link></ActionButton> : undefined}>No invoices yet.</Empty>
          ) : (
            <TableRegion label="All invoices" minWidth="36rem">
              <Table.Root variant="ghost" size="2">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Number</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Client</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Issued</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Due</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end">Total</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell justify="end">Status</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {invoices.map((i) => (
                    <Table.Row key={i.id} align="center">
                      <Table.RowHeaderCell>
                        <Link to={`/invoices/${i.id}`} className="wl-plain-link"><Text weight="medium" className="wl-num">{i.number}</Text></Link>
                        {i.schedule?.nextDate && <Text as="div" size="1" color="gray">{i.schedule.paused ? "Repeat paused" : REPEAT_LABELS[i.schedule.every]}</Text>}
                      </Table.RowHeaderCell>
                      <Table.Cell>{i.client.name}</Table.Cell>
                      <Table.Cell><Text color="gray">{formatDay(i.issueDate, { day: "numeric", month: "short", year: "numeric" })}</Text></Table.Cell>
                      <Table.Cell><Text color="gray">{formatDay(i.dueDate, { day: "numeric", month: "short", year: "numeric" })}</Text></Table.Cell>
                      <Table.Cell justify="end" className="wl-num">{formatMoney(i.total, i.currency)}</Table.Cell>
                      <Table.Cell justify="end"><InvoiceStatus invoice={i} /></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </TableRegion>
          )}
        </Card>
      </section>
    </>
  );
}

// Sent and paid invoices as a file QuickBooks Online or Xero imports (WRK-137). The period is
// by issue date and starts as last month.
function AccountingExport() {
  const today = localToday();
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  const [from, setFrom] = useState(`${addDays(firstOfThisMonth, -1).slice(0, 7)}-01`);
  const [to, setTo] = useState(addDays(firstOfThisMonth, -1));
  const reversed = !!from && !!to && from > to;
  const link = (format: "quickbooks" | "xero") => `/api/invoices/export/${format}?from=${from}&to=${to}`;
  return (
    <section>
      <SectionTitle>Export for accounting</SectionTitle>
      <Card>
        <Flex direction="column" gap="3" p="4">
          <Text as="p" size="2" color="gray">
            Sent and paid invoices issued in a period, as a file your accounting software imports. Drafts stay out.{" "}
            <ArticleLink article="invoicing-and-payments/export-to-quickbooks-or-xero">How to import it</ArticleLink>
          </Text>
          <Flex wrap="wrap" gap="3" align="end">
            <TextInput label="Issued from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} invalid={reversed} errorId={reversed ? "export-dates" : undefined} />
            {!reversed && from && to && (
              <>
                <ActionButton asChild variant="outline"><a href={link("quickbooks")} download>Download for QuickBooks</a></ActionButton>
                <ActionButton asChild variant="outline"><a href={link("xero")} download>Download for Xero</a></ActionButton>
              </>
            )}
          </Flex>
          {reversed && <InlineError id="export-dates" message="The start date is after the end date." />}
        </Flex>
      </Card>
    </section>
  );
}

export type DiscountKind = "percent" | "amount";
/** A field's link to a form error (from useSaveForm's fieldProps). */
type FieldLink = { name: string; invalid: boolean; errorId?: string };

/** The discount on an invoice, as the form shows it. */
export const discountForm = (invoice: Pick<Invoice, "discountBasisPoints" | "discountAmount">) =>
  invoice.discountAmount
    ? { discountKind: "amount" as DiscountKind, discount: moneyInput(invoice.discountAmount) }
    : { discountKind: "percent" as DiscountKind, discount: invoice.discountBasisPoints ? String(invoice.discountBasisPoints / 100) : "" };

/** What the form's discount sends to the server, or an error to show. Either key replaces the whole discount. */
export function discountBody(kind: DiscountKind, text: string): { discountPercent: string } | { discountAmount: number } | { error: string } {
  if (kind === "percent") return { discountPercent: text.trim() };
  const cents = parseMoney(text);
  if (Number.isNaN(cents)) return { error: "Enter the discount as an amount, like 50 or 49.50." };
  return { discountAmount: cents ?? 0 };
}

/** A discount: a number, and whether it's a percentage or an amount in the invoice's currency. */
export function DiscountField({ kind, value, currency, subtotal, onChange, field }: { kind: DiscountKind; value: string; currency: string; /** What the discount comes off, in cents. */ subtotal?: number; onChange: (kind: DiscountKind, value: string) => void; field?: FieldLink }) {
  const id = useId();
  const noteId = `${id}-note`;
  const size = useControlSize();
  // A discount can't be more than the subtotal: the server reduces it, and this says so.
  const typed = kind === "amount" ? parseMoney(value) : null;
  const tooBig = typed !== null && !Number.isNaN(typed) && subtotal !== undefined && typed > Math.max(subtotal, 0);
  // One label over both controls, so the row starts where its neighbours do, whatever sits under them.
  return (
    <Box minWidth="0">
      <label htmlFor={id} className="wl-label">
        Discount
      </label>
      <Flex gap="2" align="start">
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <TextField.Root id={id} name={field?.name} size={size} inputMode="decimal" value={value} onChange={(e) => onChange(kind, e.target.value)} placeholder="0" className="wl-num" aria-invalid={field?.invalid || undefined} aria-describedby={[tooBig ? noteId : null, field?.errorId].filter(Boolean).join(" ") || undefined} />
        </div>
        <Select
          aria-label="Discount as"
          value={kind}
          onChange={(k) => onChange(k as DiscountKind, value)}
          options={[{ value: "percent", label: "%" }, { value: "amount", label: currency }]}
        />
      </Flex>
      {tooBig && (
        <Text as="p" id={noteId} size="1" color="gray" mt="1" role="status">
          The discount is more than the subtotal, so it's reduced to {formatMoney(Math.max(subtotal!, 0), currency)}.
        </Text>
      )}
    </Box>
  );
}

/** The usual payment terms, in days after the issue date. */
export const TERMS = [0, 7, 14, 15, 30, 45, 60, 90];
const shortTerms = (days: number) => (days === 0 ? "On receipt" : `${days} days`);

/**
 * The due date, with a "Due in" menu beside it: choosing 60 days sets the date for you, and a
 * date picked by hand shows which term it is (or "Other date").
 */
export function DueDateField({ issueDate, dueDate, onChange, field }: { issueDate: string; dueDate: string; onChange: (dueDate: string) => void; field?: FieldLink }) {
  const id = useId();
  const size = useControlSize();
  const days = issueDate && dueDate ? daysBetween(issueDate, dueDate) : null;
  // A custom default (say 21 days) shows as itself rather than as "Other date".
  const terms = days !== null && days > 0 && days <= 365 && !TERMS.includes(days) ? [...TERMS, days].sort((a, b) => a - b) : TERMS;
  return (
    <Box minWidth="0">
      <label htmlFor={id} className="wl-label">
        Due date
      </label>
      <Flex gap="2" align="start">
        {/* A new set of options gets a new menu: the menu picks its first option when its value
            arrives before the option it names. */}
        <Select
          key={terms.join()}
          aria-label="Due in"
          value={days !== null && terms.includes(days) ? String(days) : "other"}
          onChange={(v) => (v === "other" ? document.getElementById(id)?.focus() : issueDate && onChange(addDays(issueDate, Number(v))))}
          options={[...terms.map((d) => ({ value: String(d), label: shortTerms(d) })), { value: "other", label: "Other date" }]}
        />
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <TextField.Root id={id} name={field?.name} size={size} type="date" required value={dueDate} onChange={(e) => onChange(e.target.value)} aria-invalid={field?.invalid || undefined} aria-describedby={field?.errorId} />
        </div>
      </Flex>
    </Box>
  );
}

/** A new issue date keeps the same terms: the due date moves by as many days. */
export function withIssueDate<T extends { issueDate: string; dueDate: string }>(form: T, issueDate: string): T {
  if (!issueDate || !form.issueDate || !form.dueDate) return { ...form, issueDate };
  return { ...form, issueDate, dueDate: addDays(issueDate, daysBetween(form.issueDate, form.dueDate)) };
}

const GROUPINGS = {
  project: "One line per project",
  person: "One line per person on each project",
  task: "One line per task",
  entry: "One line per time entry",
} as const;

type FixedFee = {
  projectId: string; name: string; fee: number; invoiced: number; left: number;
  /** A project billed per phase (WRK-151): its phases with something left, each billed on its own. */
  phases: { taskId: string; title: string; fee: number; invoiced: number; left: number }[] | null;
};
/** One fee to bill: a project's, or one phase's. */
type Billable = { key: string; projectId: string; taskId: string | null; name: string; projectName: string; phase: string | null; fee: number; left: number };
const billables = (fees: FixedFee[]): Billable[] =>
  fees.flatMap((f): Billable[] =>
    f.phases
      ? f.phases.map((p) => ({ key: `${f.projectId}:${p.taskId}`, projectId: f.projectId, taskId: p.taskId, name: `${f.name} – ${p.title}`, projectName: f.name, phase: p.title, fee: p.fee, left: p.left }))
      : [{ key: f.projectId, projectId: f.projectId, taskId: null, name: f.name, projectName: f.name, phase: null, fee: f.fee, left: f.left }],
  );
type Preview = {
  /** The client's currency: the whole invoice is in it. */
  currency: string;
  number: string; seconds: number; lines: { kind: "time" | "expense" | "fee"; description: string; quantity: number; unitPrice: number; amount: number }[]; from: From;
  /** The client's fixed fee projects with something left to bill. */
  fixedFees: FixedFee[];
};

/** A part of a fixed fee chosen to bill: its amount as typed, or nothing yet. */
type FeeChoice = { on: boolean; amount: string };

// A new invoice on one page: what goes on it on one side, and the invoice as the client will
// see it on the other, updated as you go. Creating it saves a draft that can still be changed.
export function NewInvoice({ clientId, currency: home }: { clientId?: string; currency: string }) {
  const today = localToday();
  const [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState({
    clientId: clientId ?? "",
    allTime: true,
    from: `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 8)}01`,
    to: addDays(`${today.slice(0, 7)}-01`, -1),
    issueDate: today,
    dueDate: addDays(today, 30),
    poNumber: "",
    subject: "",
    groupBy: "project" as keyof typeof GROUPINGS,
    includeExpenses: true,
    taxPercent: "",
    taxLabel: "Tax",
    discountKind: "percent" as DiscountKind,
    discount: "",
    notes: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Fixed fees to bill, by project. Nothing is billed until it's ticked; the amount starts as what's left.
  const [fees, setFees] = useState<Record<string, FeeChoice>>({});
  useEffect(() => setFees({}), [form.clientId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    api<{ clients: Client[] }>("/api/clients").then((r) => setClients(r.clients.filter((c) => !c.archived))).catch(() => undefined);
    // The invoice starts with the defaults from Manage → Invoicing; the due date keeps its
    // distance from the issue date.
    api<{ settings: InvoiceSettings; next: string }>("/api/settings/invoices")
      .then(({ settings }) => {
        setForm((f) => ({
          ...f,
          dueDate: addDays(f.issueDate, settings.dueDays),
          taxPercent: settings.taxBasisPoints ? String(settings.taxBasisPoints / 100) : "",
          taxLabel: settings.taxLabel,
          notes: settings.notes,
        }));
      })
      .catch(() => undefined);
  }, []);
  const setIssueDate = (issueDate: string) => setForm((f) => withIssueDate(f, issueDate));

  // A start date after the end date has no lines to show: say so, and keep no old result on screen.
  const reversed = !form.allTime && !!form.from && !!form.to && form.from > form.to;

  // The lines come from the server, a moment after the choices that change them stop changing.
  useEffect(() => {
    if (!form.clientId || reversed) {
      setPreviewError(null);
      return setPreview(null);
    }
    const query = new URLSearchParams({ clientId: form.clientId, groupBy: form.groupBy, includeExpenses: String(form.includeExpenses) });
    if (!form.allTime) {
      query.set("from", form.from);
      query.set("to", form.to);
    }
    let current = true;
    const timer = setTimeout(() => {
      api<Preview>(`/api/invoices/preview?${query}`)
        .then((r) => {
          if (!current) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: Error) => current && setPreviewError(e.message));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [form.clientId, form.allTime, form.from, form.to, form.groupBy, form.includeExpenses, reversed]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !form.clientId || reversed) return;
    const discount = discountBody(form.discountKind, form.discount);
    if ("error" in discount) return setError(discount.error);
    if (feeProblem) return setError(feeProblem);
    setBusy(true);
    setError(null);
    try {
      const { invoice } = await api<{ invoice: { id: string } }>("/api/invoices", {
        clientId: form.clientId,
        from: form.allTime ? null : form.from,
        to: form.allTime ? null : form.to,
        issueDate: form.issueDate,
        dueDate: form.dueDate,
        poNumber: form.poNumber,
        subject: form.subject,
        groupBy: form.groupBy,
        includeExpenses: form.includeExpenses,
        taxPercent: form.taxPercent || 0,
        taxLabel: form.taxLabel,
        ...discount,
        notes: form.notes,
        fees: feeLines.map((l) => ({ projectId: l.projectId, taskId: l.taskId, amount: l.amount })),
      });
      navigate(`/invoices/${invoice.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // The preview's money, worked out the same way as the server's. A discount or tax still
  // being typed counts as none until it reads as a number.
  const client = clients.find((c) => c.id === form.clientId);
  // Everything on it is in the client's currency.
  const currency = preview?.currency ?? client?.currency ?? home;
  // Fees ticked with an amount that reads as money go first, as the invoice will have them.
  const toBill = billables(preview?.fixedFees ?? []);
  const feeLines = toBill.flatMap((f) => {
    const choice = fees[f.key];
    const amount = choice?.on ? parseMoney(choice.amount) : NaN;
    return amount && amount > 0 && amount <= f.left
      ? [{ kind: "fee" as const, projectId: f.projectId, taskId: f.taskId, description: feeLineDescription(f.projectName, f.phase), quantity: 1000, unitPrice: amount, amount }]
      : [];
  });
  const feeProblem = toBill.map((f) => {
    const choice = fees[f.key];
    if (!choice?.on) return null;
    const amount = parseMoney(choice.amount);
    if (!amount || Number.isNaN(amount) || amount <= 0) return `Enter how much of the ${f.name} fee to bill, like 1500 or 750.50.`;
    return amount > f.left ? `That's more than what's left of the ${f.name} fee to bill (${formatMoney(f.left, currency)}).` : null;
  }).find(Boolean) ?? null;
  const lines = [...feeLines, ...(preview?.lines ?? [])];
  const discount = discountBody(form.discountKind, form.discount);
  const discountBasisPoints = "discountPercent" in discount ? (readPercent(discount.discountPercent) ?? 0) : 0;
  const discountAmount = "discountAmount" in discount ? discount.discountAmount : 0;
  const taxBasisPoints = readPercent(form.taxPercent) ?? 0;
  const totals = invoiceTotals(lines.map((l) => l.amount), { discountBasisPoints, discountAmount, taxBasisPoints });
  const timeAmount = lines.filter((l) => l.kind === "time").reduce((sum, l) => sum + l.amount, 0);
  const expenseAmount = lines.filter((l) => l.kind === "expense").reduce((sum, l) => sum + l.amount, 0);
  const paper: PaperInvoice = {
    number: preview?.number ?? "",
    issueDate: form.issueDate,
    dueDate: form.dueDate,
    poNumber: form.poNumber.trim(),
    subject: form.subject.trim(),
    periodFrom: form.allTime ? null : form.from || null,
    periodTo: form.allTime ? null : form.to || null,
    currency,
    notes: form.notes.trim(),
    ...totals,
    discountBasisPoints,
    taxBasisPoints,
    taxLabel: form.taxLabel.trim() || "Tax",
    client: { name: client?.name ?? "", address: client?.address ?? "", email: client?.email ?? "" },
  };

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/invoices" className="wl-link">Invoices</Link>}
        title="New invoice"
        intro="Unbilled, billable time and expenses for the client go on it. The preview shows the invoice as your client will see it."
        help="invoicing-and-payments/create-an-invoice"
      />
      <div className="wl-new-invoice">
        <form onSubmit={submit} aria-label="New invoice">
          <Flex direction="column" gap="5">
            <Select label="Client" value={form.clientId} onChange={(id) => set("clientId", id)} placeholder="Choose a client…" options={clients.map((c) => ({ value: c.id, label: c.name }))} />

            <FormSection title="Time and expenses from">
              <RadioGroup.Root value={form.allTime ? "all" : "between"} onValueChange={(v) => set("allTime", v === "all")} aria-label="Time and expenses from">
                <Flex direction="column" gap="3">
                  <RadioOption value="all">Everything not yet invoiced</RadioOption>
                  <RadioOption value="between">Only between two dates</RadioOption>
                </Flex>
              </RadioGroup.Root>
              {!form.allTime && (
                <Flex wrap="wrap" gap="3" pl="6">
                  <TextInput label="From" type="date" value={form.from} onChange={(e) => set("from", e.target.value)} />
                  <TextInput label="To" type="date" value={form.to} onChange={(e) => set("to", e.target.value)} invalid={reversed} errorId={reversed ? "dates-error" : undefined} />
                </Flex>
              )}
              {reversed && <InlineError id="dates-error" message="The start date is after the end date." />}
            </FormSection>

            {preview && (
              <Notice color="gray">
                {preview.seconds || expenseAmount ? (
                  <>
                    Includes <strong>{formatDuration(preview.seconds)}</strong> hours ({formatMoney(timeAmount, currency)})
                    {expenseAmount > 0 && <> and {formatMoney(expenseAmount, currency)} of expenses</>}.
                  </>
                ) : (
                  "Nothing to bill for this client in that period. You can still make the invoice and add lines yourself."
                )}
              </Notice>
            )}

            {preview && preview.fixedFees.length > 0 && (
              <FormSection title="Fixed fees">
                <Flex direction="column" gap="3">
                  {toBill.map((f) => {
                    const choice = fees[f.key] ?? { on: false, amount: moneyInput(f.left) };
                    const setChoice = (next: Partial<FeeChoice>) => setFees((all) => ({ ...all, [f.key]: { ...choice, ...next } }));
                    return (
                      <div key={f.key}>
                        <CheckField label={`Bill the ${f.name} fee`} checked={choice.on} onChange={(on) => setChoice({ on })} />
                        {choice.on && (
                          <Box pl="6" mt="2" maxWidth="16rem">
                            <TextInput
                              label="Amount to bill"
                              value={choice.amount}
                              onChange={(e) => setChoice({ amount: e.target.value })}
                              inputMode="decimal"
                              suffix={currency}
                              className="wl-num"
                              hint={`${formatMoney(f.left, currency)} left of ${formatMoney(f.fee, currency)}. Bill part now and the rest later.`}
                            />
                          </Box>
                        )}
                      </div>
                    );
                  })}
                </Flex>
              </FormSection>
            )}

            <div>
              <Select
                label="Lines"
                value={form.groupBy}
                onChange={(g) => set("groupBy", g as keyof typeof GROUPINGS)}
                options={Object.entries(GROUPINGS).map(([key, text]) => ({ value: key, label: text }))}
                hint={form.groupBy === "project" ? "Projects billed at each person's own rate get one line per person." : undefined}
              />
            </div>
            <CheckField label="Include billable expenses" checked={form.includeExpenses} onChange={(v) => set("includeExpenses", v)} />

            <Grid columns={{ initial: "1", xs: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <TextInput label="Issue date" type="date" required value={form.issueDate} onChange={(e) => setIssueDate(e.target.value)} />
              <TextInput label="PO number" value={form.poNumber} onChange={(e) => set("poNumber", e.target.value)} maxLength={50} />
            </Grid>
            <DueDateField issueDate={form.issueDate} dueDate={form.dueDate} onChange={(dueDate) => set("dueDate", dueDate)} />
            <TextInput label="Subject" value={form.subject} onChange={(e) => set("subject", e.target.value)} maxLength={200} placeholder="What it's for, like Website redesign" />
            <Flex direction="column" gap="3">
              <DiscountField kind={form.discountKind} value={form.discount} currency={currency} subtotal={totals.subtotal} onChange={(discountKind, discount) => setForm((f) => ({ ...f, discountKind, discount }))} />
              <TextInput label={`${form.taxLabel} (%)`} inputMode="decimal" value={form.taxPercent} onChange={(e) => set("taxPercent", e.target.value)} placeholder="0" className="wl-num" hint="Added after the discount." />
            </Flex>
            <TextAreaInput label="Notes (payment details, thanks)" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} maxLength={2000} />
            <InlineError message={error} />
            <Flex direction="column" gap="2">
              <ActionButton type="submit" busy={busy} disabled={!form.clientId || reversed} busyLabel="Creating…" style={{ alignSelf: "flex-start" }}>Create invoice</ActionButton>
              {preview && (
                <Text size="2" color="gray">
                  Total <span className="wl-num">{formatMoney(totals.total, currency)}</span>. It will be number <span className="wl-num">{preview.number}</span>.
                </Text>
              )}
              <Text size="1" color="gray">It's saved as a draft: you can still change it before it goes to the client.</Text>
            </Flex>
          </Flex>
        </form>

        <section aria-label="Invoice preview">
          {!form.clientId ? (
            <Notice color="gray">Choose a client to see the invoice.</Notice>
          ) : reversed ? (
            <Notice color="gray">Fix the dates to see the invoice.</Notice>
          ) : previewError ? (
            <Notice color="red">{previewError}</Notice>
          ) : !preview ? (
            <Loading />
          ) : (
            <InvoicePaper
              invoice={paper}
              from={preview.from}
              heading={<Heading as="h2" size="8" mb="3">Invoice</Heading>}
              lines={lines.map((line, i) => <PaperLine key={i} line={line} currency={currency} />)}
              lineCount={lines.length}
              empty="No lines yet. You can add your own after creating it."
            />
          )}
        </section>
      </div>
    </>
  );
}
