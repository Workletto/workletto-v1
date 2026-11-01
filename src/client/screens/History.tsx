import { useCallback, useEffect, useRef, useState } from "react";
import { Flex, Grid, Text } from "@radix-ui/themes";
import { useAnnounceWhen } from "../a11y.tsx";
import { api, type Member } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { formatDay } from "../timer.tsx";
import { ActionButton, Card, Empty, ErrorNote, Loading, PageHeader, Row, RowMain, Rows, Select, TextInput } from "../ui.tsx";
import { type AuditKind, type AuditValue, type Change } from "../../shared/audit.ts";
import { formatMoney } from "../../shared/money.ts";
import { ROLE_LABELS, isRole } from "../../shared/roles.ts";
import { formatDuration } from "../../shared/time.ts";

type HistoryEvent = {
  id: string;
  actorName: string;
  kind: AuditKind;
  action: "created" | "changed" | "deleted";
  label: string;
  entryDate: string | null;
  changes: Change[];
  /** The currency of its amounts, for a client billed in its own; null for the home currency. */
  currency: string | null;
  createdAt: string;
};

const KINDS: { value: "" | AuditKind; label: string }[] = [
  { value: "", label: "All" },
  { value: "time", label: "Time" },
  { value: "timesheet", label: "Timesheets" },
  { value: "expense", label: "Expenses" },
  { value: "project", label: "Projects" },
  { value: "person", label: "People" },
  { value: "invoice", label: "Invoices" },
  { value: "import", label: "Imports" },
  { value: "backup", label: "Backups" },
  { value: "settings", label: "Settings" },
];

// What each kind is called in "Ada changed a time entry".
const NOUNS: Record<AuditKind, string> = {
  time: "a time entry",
  timesheet: "a timesheet",
  expense: "an expense",
  project: "a project",
  person: "a person",
  invoice: "an invoice",
  import: "an import",
  backup: "a backup",
  settings: "settings",
};

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  client: "Client",
  project: "Project",
  task: "Task",
  date: "Date",
  seconds: "Time",
  notes: "Notes",
  note: "Note",
  repeat: "Repeats",
  requireTwoFactor: "Two-factor sign-in required",
  customField: "Custom field",
  groupMembers: "People in the group",
  team: "Team",
  twoFactor: "Two-factor sign-in",
  reminder: "Late-payment reminder",
  reminders: "Late-payment reminders",
  billable: "Billable",
  reimbursable: "To reimburse",
  billBy: "Bill by",
  hourlyRate: "Hourly rate",
  fixedFee: "Fixed fee",
  costRate: "Cost rate",
  weeklyCapacity: "Weekly capacity",
  budgetBy: "Budget by",
  budgetSeconds: "Budget hours",
  budgetAmount: "Budget amount",
  archived: "Archived",
  category: "Category",
  amount: "Amount",
  paidOnline: "Paid online",
  appName: "App name",
  currency: "Currency",
  address: "Address",
  email: "Email",
  payments: "Online payments",
  resetLink: "Password reset link",
  receipt: "Receipt",
  role: "Role",
  active: "Account",
  status: "Status",
  number: "Number",
  issueDate: "Issue date",
  dueDate: "Due date",
  taxBasisPoints: "Tax rate",
  taxLabel: "Tax name",
  discountBasisPoints: "Discount",
  discountAmount: "Discount amount",
  subtotal: "Subtotal",
  emailedTo: "Emailed to",
  line: "Line",
};

const CENTS = new Set(["amount", "hourlyRate", "fixedFee", "costRate", "budgetAmount", "discountAmount", "subtotal", "paidOnline"]);
const DURATIONS = new Set(["seconds", "budgetSeconds", "weeklyCapacity"]);
const PERCENTS = new Set(["taxBasisPoints", "discountBasisPoints"]);
const DATES = new Set(["date", "issueDate", "dueDate"]);
const YES_NO = new Set(["billable", "archived", "reimbursable"]);

const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ");

/** A recorded value in words: durations, money, percentages, dates and so on. */
export function formatValue(field: string, value: AuditValue, currency: string): string {
  if (value === null || value === "") return "none";
  if (field === "active") return value ? "On" : "Off";
  if (YES_NO.has(field) || typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (CENTS.has(field)) return formatMoney(value, currency);
    if (DURATIONS.has(field)) return `${formatDuration(value)} h`;
    if (PERCENTS.has(field)) return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
    return String(value);
  }
  if (DATES.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDay(value, { month: "short", day: "numeric", year: "numeric" });
  if (field === "role") return isRole(value) ? ROLE_LABELS[value] : value;
  if (field === "status" || field === "billBy" || field === "budgetBy") return capitalise(value);
  return value;
}

function changeText(action: HistoryEvent["action"], change: Change, currency: string) {
  const label = fieldLabel(change.field);
  const show = (v: AuditValue) => formatValue(change.field, v, currency);
  if (action === "created") return `${label}: ${show(change.to)}`;
  if (action === "deleted") return `${label}: ${show(change.from)}`;
  return `${label}: ${show(change.from)} → ${show(change.to)}`;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function forDay(event: HistoryEvent) {
  if (!event.entryDate) return null;
  if (event.kind === "timesheet") return `week of ${formatDay(event.entryDate, { month: "short", day: "numeric" })}`;
  return `for ${formatDay(event.entryDate, { weekday: "short", month: "short", day: "numeric" })}`;
}

// Local midnight of a "YYYY-MM-DD" day, plus some days, as an instant.
function localMidnight(day: string, plusDays = 0) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + plusDays).toISOString();
}

type Filters = { kind: string; actorId: string; from: string; to: string };

function query(filters: Filters, before?: string) {
  const q = new URLSearchParams();
  if (filters.kind) q.set("kind", filters.kind);
  if (filters.actorId) q.set("actorId", filters.actorId);
  if (filters.from) q.set("since", localMidnight(filters.from));
  if (filters.to) q.set("until", localMidnight(filters.to, 1));
  if (before) q.set("before", before);
  const text = q.toString();
  return text ? `?${text}` : "";
}

// Manage → History: who changed what, and when. Admins only.
export function History({ currency }: { currency: string }) {
  const [filters, setFilters] = useState<Filters>({ kind: "", actorId: "", from: "", to: "" });
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // The latest request wins, so a slow answer to an old filter can't replace a newer list.
  const latest = useRef(0);

  useEffect(() => {
    api<{ members: Member[] }>("/api/members").then((r) => setMembers(r.members)).catch(() => undefined);
  }, []);

  const load = useCallback(async (before?: string) => {
    const id = ++latest.current;
    setError(null);
    if (before) setMore(true);
    else setEvents(null);
    try {
      const page = await api<{ events: HistoryEvent[]; next: string | null }>(`/api/history${query(filters, before)}`);
      if (id !== latest.current) return;
      setEvents((old) => (before ? [...(old ?? []), ...page.events] : page.events));
      setNext(page.next);
    } catch (e) {
      if (id === latest.current) {
        setError((e as Error).message);
        setEvents((old) => old ?? []);
      }
    } finally {
      if (id === latest.current) setMore(false);
    }
  }, [filters]);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(events !== null, "History loaded.");

  const filtered = Boolean(filters.kind || filters.actorId || filters.from || filters.to);
  const set = (change: Partial<Filters>) => setFilters({ ...filters, ...change });

  return (
    <>
      <PageHeader
        title="History"
        intro="Who changed time, expenses, rates, budgets, invoices, people and settings, and when. Only admins can see this."
        help="team-and-permissions/audit-history"
      />
      <ManageTabs role="admin" />
      <Flex direction="column" gap="3">
        <Grid columns={{ initial: "1", sm: "repeat(4, minmax(0, 1fr))" }} gap="3" align="end">
          <Select label="Kind" value={filters.kind} onChange={(kind) => set({ kind })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
          <Select
            label="Person"
            value={filters.actorId}
            onChange={(actorId) => set({ actorId })}
            options={[{ value: "", label: "All" }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
          />
          <TextInput label="From" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <TextInput label="To" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </Grid>
        <Flex>
          <ActionButton asChild variant="outline" color="gray">
            <a href={`/api/history/export${query(filters)}`} download>Download CSV</a>
          </ActionButton>
        </Flex>
      </Flex>
      <ErrorNote message={error} />

      {events === null ? (
        <Loading />
      ) : (
        <Card>
          {events.length === 0 ? (
            <Empty>{filtered ? "No changes match these filters." : "Nothing has changed yet."}</Empty>
          ) : (
            <Rows>
              {events.map((e) => {
                const day = forDay(e);
                return (
                  <Row key={e.id}>
                    <RowMain>
                      <Text as="p" size="2">
                        <Text weight="medium">{e.kind === "import" ? e.actorName : `${e.actorName} ${e.action} ${NOUNS[e.kind]}`}</Text>
                        <Text color="gray"> · {e.label}{day ? ` · ${day}` : ""}</Text>
                      </Text>
                      {e.changes.map((c, i) => (
                        <Text key={i} as="p" size="2" color="gray">{changeText(e.action, c, e.currency ?? currency)}</Text>
                      ))}
                    </RowMain>
                    <Text size="2" color="gray" className="wl-num">{when(e.createdAt)}</Text>
                  </Row>
                );
              })}
            </Rows>
          )}
          {next && (
            <Flex p="3" justify="center">
              <ActionButton variant="outline" color="gray" busy={more} onClick={() => void load(next)}>Show more</ActionButton>
            </Flex>
          )}
        </Card>
      )}
    </>
  );
}
