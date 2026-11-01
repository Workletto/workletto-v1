import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Flex, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { api, projectCurrency, type Project } from "../api.ts";
import { navigate } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { PeriodStepper } from "../WeekNav.tsx";
import { ActionButton, Card, CheckField, Empty, ErrorNote, InlineError, Loading, PageHeader, projectGroups, Row, RowActions, RowButton, RowMain, RowMenu, RowMenuItem, Rows, SaveButton, Select, SrOnly, TextInput, useConfirm } from "../ui.tsx";
import { addDays } from "../../shared/time.ts";
import { formatMoney, moneyByCurrency, moneyInput, parseMoney } from "../../shared/money.ts";

export type Expense = {
  id: string;
  date: string;
  category: string;
  amount: number;
  notes: string;
  billable: boolean;
  /** Paid by the person themselves, so it's owed back to them. */
  reimbursable: boolean;
  /** The amount is in the project's currency: its client's, or the home currency. */
  project: { id: string; name: string; client: { id: string; name: string; currency: string } | null };
  invoice: { id: string; number: string } | null;
  receipt: { fileName: string; contentType: string; size: number } | null;
};

const RECEIPT_TYPES = "image/jpeg,image/png,image/webp,application/pdf";

const AMOUNT_HELP = "Enter an amount like 42.50.";
const monthStart = (month: string) => `${month}-01`;
const monthEnd = (month: string) => addDays(`${nextMonth(month)}-01`, -1);
function nextMonth(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function previousMonth(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// Your expenses, a month at a time.
export function Expenses({ month, currency }: { month: string; currency: string }) {
  // `currency` is the home currency; each expense is in its project's.
  const currencyOf = (e: Expense) => projectCurrency(e.project, currency);
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const thisMonth = localToday().slice(0, 7);

  const load = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([
        api<{ expenses: Expense[] }>(`/api/expenses?from=${monthStart(month)}&to=${monthEnd(month)}`),
        api<{ categories: string[] }>("/api/expenses/categories"),
      ]);
      setExpenses(e.expenses);
      setCategories(c.categories);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [month]);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(expenses !== null, "Expenses loaded.");
  useEffect(() => {
    api<{ projects: Project[] }>("/api/projects").then((r) => setProjects(r.projects.filter((p) => !p.archived))).catch(() => undefined);
  }, []);

  // Totals never add currencies together: "€120.00 and $45.00".
  const sumOf = (list: Expense[]) => moneyByCurrency(list.map((e) => ({ amount: e.amount, currency: currencyOf(e) }))) || formatMoney(0, currency);
  const total = sumOf(expenses ?? []);
  const billable = sumOf(expenses?.filter((e) => e.billable) ?? []);
  const dates = [...new Set(expenses?.map((e) => e.date))];
  const monthName = formatDay(monthStart(month), { month: "long", year: "numeric" });

  return (
    <>
      <PageHeader
        title="Expenses"
        help="expenses/receipts"
        docTitle={`Expenses: ${monthName}`}
        intro={
          <>
            <span className="wl-num">{monthName}</span>
            {expenses && (
              <>
                <span aria-hidden> · </span>
                <Text weight="medium" highContrast className="wl-num">{total}</Text>
                <span className="wl-num"> · {billable} billable</span>
              </>
            )}
          </>
        }
      >
        <PeriodStepper
          unit="month"
          current={month === thisMonth}
          onStep={(by) => navigate(`/expenses/${by < 0 ? previousMonth(month) : nextMonth(month)}`)}
          onCurrent={() => navigate("/expenses")}
        />
      </PageHeader>
      <datalist id="expense-categories">
        {categories.map((c) => <option key={c} value={c} />)}
      </datalist>
      <ErrorNote message={error} />
      {/* Only once the month has loaded, so its "Expenses loaded." can never arrive after (and replace) "Expense added." */}
      {expenses !== null && projects.length > 0 && <NewExpense projects={projects} month={month} currency={currency} onAdded={load} />}

      {expenses === null ? (
        <Loading />
      ) : (
        <Card>
          {expenses.length === 0 && <Empty>No expenses this month.</Empty>}
          {dates.map((date) => {
            const day = expenses.filter((e) => e.date === date);
            return (
              <section key={date}>
                <h2 className="wl-group-title">
                  <span>{formatDay(date, { weekday: "short", day: "numeric", month: "short" })}</span>
                  <span className="wl-num">
                    <SrOnly>Total </SrOnly>
                    {sumOf(day)}
                  </span>
                </h2>
                <Rows>
                  {day.map((e) => (
                    <ExpenseRow key={e.id} expense={e} projects={projects} currency={currencyOf(e)} home={currency} onChange={load} />
                  ))}
                </Rows>
              </section>
            );
          })}
        </Card>
      )}
    </>
  );
}

type FormState = { date: string; projectId: string; category: string; amount: string; notes: string; billable: boolean; reimbursable: boolean };

// The fields of an expense, the same in the add form and in a row being edited: Date, Project,
// Category and Amount in a line, then Notes, then the two checkboxes side by side with `submit` at the end of their row.
/** `home` is the home currency: the amount is in the chosen project's currency, its client's or that. */
function ExpenseFields({ form, setForm, projects, home, autoFocus, amountErrorId, notesLabel, submit }: {
  form: FormState; setForm: (f: FormState) => void; projects: Project[]; home: string; autoFocus?: boolean; amountErrorId?: string; notesLabel: string; submit?: ReactNode;
}) {
  const currency = projectCurrency(projects.find((p) => p.id === form.projectId) ?? { client: null }, home);
  return (
    <div className="wl-expense-form">
      <TextInput label="Date" type="date" required autoFocus={autoFocus} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
      <div>
        <Select
          label="Project"
          value={form.projectId}
          onChange={(projectId) => setForm({ ...form, projectId, billable: projects.find((p) => p.id === projectId)?.billable ?? form.billable })}
          groups={projectGroups(projects)}
        />
      </div>
      <TextInput label="Category" list="expense-categories" required maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Travel" />
      <TextInput
        label={`Amount (${currency})`}
        required
        inputMode="decimal"
        value={form.amount}
        onChange={(e) => setForm({ ...form, amount: e.target.value })}
        placeholder="0.00"
        invalid={amountErrorId ? true : undefined}
        errorId={amountErrorId}
        className="wl-num"
      />
      <div className="wl-expense-notes">
        <TextInput label={notesLabel} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} />
      </div>
      <div className="wl-expense-actions">
        <div className="wl-expense-checks">
          <CheckField label="Billable" checked={form.billable} onChange={(billable) => setForm({ ...form, billable })} />
          <CheckField label="I paid for this myself" hint="Marks it as owed back to you." checked={form.reimbursable} onChange={(reimbursable) => setForm({ ...form, reimbursable })} />
        </div>
        {submit}
      </div>
    </div>
  );
}

function NewExpense({ projects, month, currency, onAdded }: { projects: Project[]; month: string; currency: string; onAdded: () => Promise<void> }) {
  const today = localToday();
  const blank = (): FormState => ({
    date: today.startsWith(month) ? today : monthStart(month),
    projectId: projects[0]!.id,
    category: "",
    amount: "",
    notes: "",
    billable: projects[0]!.billable,
    reimbursable: false,
  });
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const amount = parseMoney(form.amount);
    if (!amount) return setError(AMOUNT_HELP);
    setBusy(true);
    setError(null);
    try {
      await api("/api/expenses", { ...form, amount });
      setForm({ ...blank(), date: form.date, projectId: form.projectId, billable: form.billable });
      await onAdded();
      announce("Expense added.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Flex direction="column" gap="3">
        <ExpenseFields
          form={form}
          setForm={setForm}
          projects={projects}
          home={currency}
          amountErrorId={error === AMOUNT_HELP ? errorId : undefined}
          notesLabel="Notes (optional)"
          submit={<ActionButton type="submit" busy={busy}>Add expense</ActionButton>}
        />
        <InlineError message={error} id={errorId} />
      </Flex>
    </form>
  );
}

function ExpenseRow({ expense, projects, currency, home, onChange }: { expense: Expense; projects: Project[]; currency: string; home: string; onChange: () => Promise<void> }) {
  const editor = useEditor();
  const confirm = useConfirm();
  const saved: FormState = {
    date: expense.date,
    projectId: expense.project.id,
    category: expense.category,
    amount: moneyInput(expense.amount),
    notes: expense.notes,
    billable: expense.billable,
    reimbursable: expense.reimbursable,
  };
  const [form, setForm] = useState<FormState>(saved);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // An expense on an archived project keeps it as a choice.
  const choices = projects.some((p) => p.id === expense.project.id)
    ? projects
    : [...projects, { ...expense.project, billable: expense.billable, archived: true, client: expense.project.client && { ...expense.project.client, archived: false } }];

  async function run(work: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await work();
      editor.close();
      await onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete this ${expense.category} expense?`,
      description: `${formatMoney(expense.amount, currency)} on ${expense.project.name}. This can't be undone.`,
      confirm: "Delete",
    });
    if (!ok) return;
    if (await run(() => api(`/api/expenses/${expense.id}`, undefined, "DELETE"))) announce("Expense deleted.");
  }

  const fileInput = useRef<HTMLInputElement>(null);
  async function attach(file: File) {
    setError(null);
    try {
      const res = await fetch(`/api/expenses/${expense.id}/receipt`, {
        method: "PUT",
        headers: { "X-File-Name": encodeURIComponent(file.name) },
        body: file,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Something went wrong. Try again.");
      }
      await onChange();
      announce("Receipt saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function removeReceipt() {
    const ok = await confirm({ title: "Remove the receipt from this expense?", description: "The file is deleted. You can attach it again later.", confirm: "Remove" });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/expenses/${expense.id}/receipt`, undefined, "DELETE");
      await onChange();
      announce("Receipt removed.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (editor.editing) {
    return (
      <Row editing>
        <form
          style={{ width: "100%" }}
          onSubmit={(e) => {
            e.preventDefault();
            const amount = parseMoney(form.amount);
            if (!amount) return setError(AMOUNT_HELP);
            const body: Record<string, unknown> = { date: form.date, category: form.category, amount, notes: form.notes, billable: form.billable, reimbursable: form.reimbursable };
            if (form.projectId !== expense.project.id) body.projectId = form.projectId;
            void run(() => api(`/api/expenses/${expense.id}`, body, "PATCH")).then((ok) => ok && announce("Expense saved."));
          }}
        >
          <Flex direction="column" gap="4">
            <ExpenseFields form={form} setForm={setForm} projects={choices} home={home} autoFocus amountErrorId={error === AMOUNT_HELP ? errorId : undefined} notesLabel="Notes" />
            <InlineError message={error} id={errorId} />
            <Flex align="center" gap="3">
              <RowButton type="button" danger onClick={() => void remove()}>Delete<SrOnly> this expense</SrOnly></RowButton>
              <Flex align="center" gap="3" ml="auto">
                <RowButton type="button" onClick={() => editor.close()}>Cancel</RowButton>
                <SaveButton state={{ dirty, busy: false }}>Save</SaveButton>
              </Flex>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  return (
    <Row>
      <RowMain>
        <Text as="p" size="2">
          <Text weight="medium">{expense.category}</Text>
          <Text color="gray"> · {expense.project.name}{expense.project.client ? ` · ${expense.project.client.name}` : ""}</Text>
          {!expense.billable && <> <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">Non-billable</Badge></>}
          {expense.reimbursable && <> <Badge color="amber" variant="soft" size="1" className="wl-inline-badge">To reimburse</Badge></>}
          {expense.invoice && (
            <>
              {" "}
              <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">
                Invoice {expense.invoice.number}
                <SrOnly>. Invoiced expenses can't be changed.</SrOnly>
              </Badge>
            </>
          )}
          {expense.receipt && (
            <>
              {" "}
              <a href={`/api/expenses/${expense.id}/receipt`} target="_blank" rel="noreferrer" className="wl-link">
                Receipt<SrOnly> for {expense.category}, {expense.project.name} (opens in a new tab)</SrOnly>
              </a>
            </>
          )}
        </Text>
        {expense.notes && <Text as="p" size="2" color="gray">{expense.notes}</Text>}
        <InlineError message={error} />
      </RowMain>
      <Text size="2" weight="medium" className="wl-num">{formatMoney(expense.amount, currency)}</Text>
      <RowActions>
        {!expense.invoice && (
          <RowButton ref={editor.openerRef} onClick={editor.open}>Edit<SrOnly> {expense.category}, {expense.project.name}</SrOnly></RowButton>
        )}
        <RowMenu label={`More actions for ${expense.category}, ${expense.project.name}`}>
          <RowMenuItem onSelect={() => fileInput.current?.click()}>{expense.receipt ? "Replace receipt" : "Attach receipt"}</RowMenuItem>
          {expense.receipt && <RowMenuItem danger onSelect={() => void removeReceipt()}>Remove receipt</RowMenuItem>}
        </RowMenu>
        <input
          ref={fileInput}
          type="file"
          accept={RECEIPT_TYPES}
          hidden
          tabIndex={-1}
          aria-label={`Receipt file for ${expense.category}, ${expense.project.name}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void attach(file);
          }}
        />
      </RowActions>
    </Row>
  );
}
