import { useEffect, useMemo, useState } from "react";
import { Flex, Grid, Heading, SegmentedControl, Table, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import type { CustomField } from "../customFields.tsx";
import type { Group as UserGroup } from "../groups.tsx";
import { api, type Client, type Member, type Project } from "../api.ts";
import { Link, usePath } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { ActionButton, Card, Empty, ErrorNote, InlineError, NavTabs, PageHeader, ProgressBar, SectionTitle, Select, Stat, Stats, TableRegion, TextInput } from "../ui.tsx";
import { addDays, formatDuration, startOfWeek } from "../../shared/time.ts";
import { formatMoney } from "../../shared/money.ts";
import { toCsv } from "../../shared/csv.ts";

/** Stands for "no value" in a field filter: the list can't use an empty value for it. */
const NO_VALUE = "__no_value__";
/** A built-in grouping, or "field:<id>" for a list custom field (WRK-148). */
type Group = "client" | "project" | "person" | "task" | `field:${string}`;
type Row = { id: string; label: string; detail: string | null; seconds: number; billableSeconds: number; billableAmount?: number };
type Bucket = { start: string; seconds: number; billableSeconds: number };
type Summary = {
  totals: { seconds: number; billableSeconds: number; billableAmount?: number };
  rows: Row[];
  expenses: { amount: number; billableAmount: number };
  series: { step: "day" | "week" | "month"; buckets: Bucket[] };
  /** Some of the money came from another currency, converted to the home currency. */
  converted?: boolean;
};

const STEP_WORD = { day: "day", week: "week", month: "month" } as const;
/** "12 days with time", under the period's hours. */
const daysWith = (buckets: Bucket[]) => {
  const n = buckets.filter((b) => b.seconds > 0).length;
  return n === 1 ? "1 day with time" : `${n} days with time`;
};
/** Months read "Jan", "Feb"; the year is added only when the range spans more than one calendar year. Days and weeks read "Oct 14". */
const bucketLabel = (b: Bucket, step: "day" | "week" | "month", withYear = false) =>
  step === "month" ? formatDay(b.start, withYear ? { month: "short", year: "numeric" } : { month: "short" }) : formatDay(b.start, { month: "short", day: "numeric" });
/** How the summary names the busiest bucket: "on Oct 14", "in the week of Oct 12", "in September 2026". */
const busiestPhrase = (b: Bucket, step: "day" | "week" | "month") =>
  step === "month" ? `in ${formatDay(b.start, { month: "long", year: "numeric" })}` : step === "week" ? `in the week of ${bucketLabel(b, step)}` : `on ${bucketLabel(b, step)}`;

/** Hours over the period as bars: billable in the accent color, the rest in gray. The table below has the same figures. */
function HoursChart({ series }: { series: Summary["series"] }) {
  const { buckets, step } = series;
  if (!buckets.length) return null;
  const max = Math.max(1, ...buckets.map((b) => b.seconds));
  const W = 100;
  const H = 40;
  const gap = buckets.length > 40 ? 0.2 : 0.6;
  const bw = W / buckets.length - gap;
  const busiest = buckets.reduce((a, b) => (b.seconds > a.seconds ? b : a), buckets[0]!);
  const total = buckets.reduce((s, b) => s + b.seconds, 0);
  const summaryText = `Hours per ${STEP_WORD[step]}: ${formatDuration(total)} in all${total ? `, most ${busiestPhrase(busiest, step)} (${formatDuration(busiest.seconds)})` : ""}.`;
  const withYear = step === "month" && buckets[0]!.start.slice(0, 4) !== buckets[buckets.length - 1]!.start.slice(0, 4);
  const ticks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  // Day by day, a line marks the end of today's bar (between today and tomorrow) when today is in the period.
  const todayIndex = step === "day" ? buckets.findIndex((b) => b.start === localToday()) : -1;
  return (
    <figure className="wl-chart">
      {todayIndex >= 0 && (
        <span
          className="wl-chart-today"
          aria-hidden
          data-edge={todayIndex === buckets.length - 1 ? "end" : undefined}
          style={{ left: `${((todayIndex + 1) / buckets.length) * 100}%` }}
        >
          Today
        </span>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summaryText} className="wl-chart-svg">
        {buckets.map((b, i) => {
          const x = i * (W / buckets.length) + gap / 2;
          const h = (b.seconds / max) * H;
          const hb = (b.billableSeconds / max) * H;
          return (
            <g key={b.start}>
              <rect x={x} y={H - h} width={bw} height={h - hb} className="wl-chart-other" />
              <rect x={x} y={H - hb} width={bw} height={hb} className="wl-chart-billable" />
            </g>
          );
        })}
      </svg>
      <div className="wl-chart-axis" aria-hidden>
        {ticks.map((i) => (
          // The first and last labels sit against the edges, so none runs off the page.
          <span key={i} style={i === 0 ? { left: 0 } : i === buckets.length - 1 ? { right: 0 } : { left: `${((i + 0.5) / buckets.length) * 100}%`, transform: "translateX(-50%)" }}>
            {bucketLabel(buckets[i]!, step, withYear)}
          </span>
        ))}
      </div>
      <figcaption className="wl-chart-key">
        <span><i className="wl-chart-billable" /> Billable</span>
        <span><i className="wl-chart-other" /> Non-billable</span>
        <span className="wl-num">Tallest bar: {formatDuration(max)}</span>
      </figcaption>
    </figure>
  );
}
/** currency: a money budget is in its project's currency. */
type Budget = { id: string; name: string; client: string | null; budgetBy: "hours" | "fees"; budget: number; used: number; currency: string };
type ExportEntry = {
  date: string; person: string; client: string; project: string; task: string; notes: string;
  seconds: number; billable: boolean; rate?: number | null; amount?: number; currency?: string;
  customFields: Record<string, string>;
  groups?: string;
};

export const PERIODS = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
  "this-year": "This year",
  "last-year": "Last year",
  custom: "Custom dates",
} as const;
export type Period = keyof typeof PERIODS;

export function periodDates(period: Exclude<Period, "custom">, today: string): [string, string] {
  const week = startOfWeek(today);
  const month = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  const monthEnd = (start: string) => addDays(addDays(start, 32).slice(0, 8) + "01", -1);
  switch (period) {
    case "this-week": return [week, addDays(week, 6)];
    case "last-week": return [addDays(week, -7), addDays(week, -1)];
    case "this-month": return [`${month}-01`, monthEnd(`${month}-01`)];
    case "last-month": {
      const start = addDays(`${month}-01`, -1).slice(0, 8) + "01";
      return [start, addDays(`${month}-01`, -1)];
    }
    case "this-year": return [`${year}-01-01`, `${year}-12-31`];
    case "last-year": return [`${year - 1}-01-01`, `${year - 1}-12-31`];
  }
}

const GROUP_LABELS: Record<Group, string> = { client: "Clients", project: "Projects", person: "People", task: "Tasks" };
// Four decimals, so a 20-minute entry (0.3333) is read back as 1200 seconds.
const hours = (seconds: number) => String(+(seconds / 3600).toFixed(4));

/** The chosen period of a report and its first and last day. */
export function usePeriod() {
  const today = localToday();
  const [period, setPeriod] = useState<Period>("this-month");
  const [custom, setCustom] = useState<[string, string]>(() => periodDates("this-month", today));
  const [from, to] = period === "custom" ? custom : periodDates(period, today);
  return { period, setPeriod, custom, setCustom, from, to };
}

/** The Period list, with the two dates (or the dates the period covers) beside it. Shared by the report pages. */
export function PeriodPicker({ state }: { state: ReturnType<typeof usePeriod> }) {
  const { period, setPeriod, custom, setCustom, from, to } = state;
  const reversed = from > to;
  const longDate = (d: string) => formatDay(d, { day: "numeric", month: "short", year: "numeric" });
  return (
    <Flex direction="column" gap="2">
    <Flex wrap="wrap" align="end" gap="3">
      <div style={{ width: "12rem", maxWidth: "100%" }}>
        <Select label="Period" value={period} onChange={(p) => setPeriod(p as Period)} options={(Object.keys(PERIODS) as Period[]).map((p) => ({ value: p, label: PERIODS[p] }))} />
      </div>
      {period === "custom" ? (
        <>
          <TextInput label="From" type="date" value={custom[0]} invalid={reversed} errorId={reversed ? "period-error" : undefined} onChange={(e) => e.target.value && setCustom([e.target.value, custom[1]])} />
          <TextInput label="To" type="date" value={custom[1]} invalid={reversed} errorId={reversed ? "period-error" : undefined} onChange={(e) => e.target.value && setCustom([custom[0], e.target.value])} />
        </>
      ) : (
        <Text size="2" color="gray" style={{ paddingBlock: "var(--space-2)" }}>
          {longDate(from)} – {longDate(to)}
        </Text>
      )}
    </Flex>
    <InlineError id="period-error" message={reversed ? "The start date is after the end date." : null} />
    </Flex>
  );
}

/** Time and Profitability, for admins and managers. Members have one report and no tabs. */
export function ReportTabs() {
  const path = usePath();
  return (
    <NavTabs
      label="Report types"
      tabs={[
        { to: "/reports", label: "Time", active: path === "/reports" },
        { to: "/reports/profitability", label: "Profitability", active: path === "/reports/profitability" },
      ]}
    />
  );
}

// Time and expenses for a period. Admins and managers see everyone's, with money;
// members see their own.
export function Reports({ canManage, currency }: { canManage: boolean; currency: string }) {
  const periodState = usePeriod();
  const { from, to } = periodState;
  const [group, setGroup] = useState<Group>("project");
  // A link can open the report on one project: /reports?projectId=… (from a project's Recent time).
  const [filters, setFilters] = useState(() => ({ clientId: "", projectId: new URLSearchParams(location.search).get("projectId") ?? "", userId: "", billable: "", groupId: "" }));
  // User groups (WRK-149), for admins and managers.
  const [userGroups, setUserGroups] = useState<UserGroup[]>([]);
  // List custom fields (WRK-148) to group and filter by: on time entries, and for admins and managers on projects and clients too.
  const [listFields, setListFields] = useState<CustomField[]>([]);
  // One field filter at a time: the field and its value ("" for none).
  const [fieldFilter, setFieldFilter] = useState<{ fieldId: string; value: string } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [options, setOptions] = useState<{ clients: Client[]; projects: Project[]; people: Member[] }>({ clients: [], projects: [], people: [] });
  const [error, setError] = useState<string | null>(null);
  // While new results load, the old ones are dimmed and marked busy, and export waits (outside QA-01).
  const [updating, setUpdating] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value);
    if (fieldFilter) {
      q.set("fieldId", fieldFilter.fieldId);
      q.set("fieldValue", fieldFilter.value);
    }
    return q.toString();
  }, [from, to, filters, fieldFilter]);

  useEffect(() => {
    let current = true;
    setError(null);
    // Dates the wrong way round show a message of their own and no results: nothing stale stays, nothing is announced.
    if (from > to) {
      setSummary(null);
      setUpdating(false);
      return;
    }
    setUpdating(true);
    api<Summary>(`/api/reports/summary?${query}&groupBy=${group}`)
      .then((r) => {
        if (!current) return;
        setSummary(r);
        setUpdating(false);
        // Choosing a period, filter or grouping swaps the results without moving focus: say what is now shown.
        announce(`Report updated: ${formatDuration(r.totals.seconds)} hours in ${r.rows.length} ${r.rows.length === 1 ? "row" : "rows"}.`);
      })
      .catch((e: Error) => {
        if (!current) return;
        setError(e.message);
        setUpdating(false);
      });
    return () => {
      current = false;
    };
  }, [query, group]);

  useEffect(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ projects: Project[] }>("/api/projects"),
      canManage ? api<{ members: Member[] }>("/api/members") : Promise.resolve({ members: [] }),
    ]).then(([c, p, m]) => setOptions({ clients: c.clients, projects: p.projects, people: m.members }));
    if (canManage) api<{ budgets: Budget[] }>("/api/reports/budgets").then((r) => setBudgets(r.budgets)).catch(() => undefined);
    if (canManage) api<{ groups: UserGroup[] }>("/api/groups").then((r) => setUserGroups(r.groups)).catch(() => undefined);
    api<{ fields: CustomField[] }>("/api/custom-fields")
      .then((r) => setListFields(r.fields.filter((f) => f.type === "choice" && (canManage || f.appliesTo === "time"))))
      .catch(() => undefined);
  }, [canManage]);

  async function exportCsv() {
    if (from > to) return setError("The start date is after the end date.");
    const { entries, fields } = await api<{ entries: ExportEntry[]; fields: { id: string; name: string }[] }>(`/api/reports/entries?${query}`);
    // Each entry's rate and amount are in its project's own currency, as they'd be invoiced.
    // Time-entry custom fields (WRK-148) come last.
    const header = ["Date", "Person", "Client", "Project", "Task", "Notes", "Hours", "Billable", ...(canManage ? ["Rate", "Amount", "Currency", "Groups"] : []), ...fields.map((f) => f.name)];
    const rows = entries.map((e) => [
      e.date, e.person, e.client, e.project, e.task, e.notes, hours(e.seconds), e.billable ? "Yes" : "No",
      ...(canManage ? [e.rate == null ? "" : (e.rate / 100).toFixed(2), ((e.amount ?? 0) / 100).toFixed(2), e.currency ?? currency, e.groups ?? ""] : []),
      ...fields.map((f) => e.customFields[f.id] ?? ""),
    ]);
    const blob = new Blob([toCsv([header, ...rows])], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `time-${from}-to-${to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const set = (key: keyof typeof filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const maxSeconds = Math.max(1, ...(summary?.rows.map((r) => r.seconds) ?? [1]));
  const totals = summary?.totals;
  const groups: Group[] = [...(canManage ? ["client", "project", "person", "task"] as const : ["client", "project", "task"] as const), ...listFields.map((f) => `field:${f.id}` as const)];
  const groupLabel = (g: Group) => (g.startsWith("field:") ? listFields.find((f) => `field:${f.id}` === g)?.name ?? "Field" : GROUP_LABELS[g as keyof typeof GROUP_LABELS]);

  return (
    <>
      <PageHeader title="Reports" docTitle="Reports" intro={canManage ? "Everyone's time and expenses." : "Your time and expenses."} help="reports/time-reports">
        <ActionButton variant="soft" color="gray" onClick={() => void exportCsv()} disabled={updating || !summary}>Export CSV</ActionButton>
      </PageHeader>
      {canManage && <ReportTabs />}

      <Flex direction="column" gap="3" className="wl-filters">
        <PeriodPicker state={periodState} />
        <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))", md: canManage ? "repeat(4, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))" }} gap="3">
          <div>
            <Select
              label="Client"
              value={filters.clientId}
              onChange={set("clientId")}
              options={[{ value: "", label: "All clients" }, { value: "none", label: "No client" }, ...options.clients.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </div>
          <div>
            <Select
              label="Project"
              value={filters.projectId}
              onChange={set("projectId")}
              options={[{ value: "", label: "All projects" }, ...options.projects.map((p) => ({ value: p.id, label: `${p.client ? `${p.client.name} · ` : ""}${p.name}` }))]}
            />
          </div>
          {canManage && (
            <div>
              <Select label="Person" value={filters.userId} onChange={set("userId")} options={[{ value: "", label: "Everyone" }, ...options.people.map((p) => ({ value: p.id, label: p.name }))]} />
            </div>
          )}
          {userGroups.length > 0 && (
            <div>
              <Select label="Group" value={filters.groupId} onChange={set("groupId")} options={[{ value: "", label: "All groups" }, ...userGroups.map((g) => ({ value: g.id, label: g.name }))]} />
            </div>
          )}
          <div>
            <Select
              label="Billable"
              value={filters.billable}
              onChange={set("billable")}
              options={[{ value: "", label: "Billable and non-billable" }, { value: "true", label: "Billable only" }, { value: "false", label: "Non-billable only" }]}
            />
          </div>
          {listFields.map((f) => (
            <div key={f.id}>
              <Select
                label={f.name}
                value={fieldFilter?.fieldId === f.id ? (fieldFilter.value === "" ? NO_VALUE : fieldFilter.value) : ""}
                onChange={(v) => setFieldFilter(v ? { fieldId: f.id, value: v === NO_VALUE ? "" : v } : null)}
                options={[{ value: "", label: `Any ${f.name}` }, { value: NO_VALUE, label: `No ${f.name}` }, ...f.choices.map((c) => ({ value: c, label: c }))]}
              />
            </div>
          ))}
        </Grid>
      </Flex>

      <ErrorNote message={error} />
      {updating && summary && <Text as="p" size="2" color="gray" role="status">Updating…</Text>}
      {totals && summary && (
        <div aria-busy={updating} className={updating ? "wl-stack wl-updating" : "wl-stack"}>
          <Stats band>
            <Stat large label="Hours" value={formatDuration(totals.seconds)}>
              {summary.series?.step === "day" && (
                <Text as="p" size="2" color="gray">{daysWith(summary.series.buckets)}</Text>
              )}
            </Stat>
            <Stat large label="Billable hours" value={formatDuration(totals.billableSeconds)}>
              <Text as="p" size="2" color="gray">{totals.seconds ? Math.round((totals.billableSeconds / totals.seconds) * 100) : 0}% of all hours</Text>
            </Stat>
            {totals.billableAmount !== undefined && <Stat large label="Billable amount" value={formatMoney(totals.billableAmount, currency)} />}
            <Stat large label="Expenses" value={formatMoney(summary.expenses.amount, currency)}>
              <Text as="p" size="2" color="gray">{formatMoney(summary.expenses.billableAmount, currency)} billable</Text>
            </Stat>
          </Stats>
          {summary.converted && <Text as="p" size="2" color="gray">Amounts from clients billed in other currencies are converted to {currency} at the exchange rates in Manage → Settings.</Text>}
          {summary.series && totals.seconds > 0 && <HoursChart series={summary.series} />}

          <Card>
            <Flex px="4" py="3" gap="3" align="center" justify="between" wrap="wrap" className="wl-card-head">
              <Heading as="h2" size="3">Breakdown</Heading>
              <SegmentedControl.Root aria-label="Group results by" size="2" value={group} onValueChange={(g) => setGroup(g as Group)}>
                {groups.map((g) => (
                  <SegmentedControl.Item key={g} value={g}>{groupLabel(g)}</SegmentedControl.Item>
                ))}
              </SegmentedControl.Root>
            </Flex>
            {summary.rows.length === 0 ? (
              <Empty>No time in this period.</Empty>
            ) : (
              <TableRegion label={`${groupLabel(group)} report`}>
                <Table.Root variant="ghost" size="2">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Hours</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Billable</Table.ColumnHeaderCell>
                      {totals.billableAmount !== undefined && <Table.ColumnHeaderCell justify="end">Amount</Table.ColumnHeaderCell>}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {summary.rows.map((r) => (
                      <Table.Row key={r.id}>
                        <Table.RowHeaderCell>
                          {group === "project" ? <Link to={`/projects/${r.id}`} className="wl-plain-link"><Text weight="medium">{r.label}</Text></Link> : <Text weight="medium">{r.label}</Text>}
                          {r.detail && <Text color="gray"> · {r.detail}</Text>}
                          <div className="wl-bar" aria-hidden><div style={{ width: `${(r.seconds / maxSeconds) * 100}%` }} /></div>
                        </Table.RowHeaderCell>
                        <Table.Cell justify="end" className="wl-num">{formatDuration(r.seconds)}</Table.Cell>
                        <Table.Cell justify="end" className="wl-num">{formatDuration(r.billableSeconds)}</Table.Cell>
                        {r.billableAmount !== undefined && <Table.Cell justify="end" className="wl-num">{formatMoney(r.billableAmount, currency)}</Table.Cell>}
                      </Table.Row>
                    ))}
                    <Table.Row className="wl-table-total">
                      <Table.RowHeaderCell>Total</Table.RowHeaderCell>
                      <Table.Cell justify="end" className="wl-num">{formatDuration(totals.seconds)}</Table.Cell>
                      <Table.Cell justify="end" className="wl-num">{formatDuration(totals.billableSeconds)}</Table.Cell>
                      {totals.billableAmount !== undefined && <Table.Cell justify="end" className="wl-num">{formatMoney(totals.billableAmount, currency)}</Table.Cell>}
                    </Table.Row>
                  </Table.Body>
                </Table.Root>
              </TableRegion>
            )}
          </Card>
        </div>
      )}

      {canManage && budgets.length > 0 && (
        <section>
          <SectionTitle>Budgets <Text weight="regular" color="gray">(all time)</Text></SectionTitle>
          <Text as="p" size="2" color="gray" mb="3">Totals for projects with a budget, since each project began. They don't change with the period above.</Text>
          <Card>
            <ul className="wl-rows">
              {budgets.map((b) => {
                const show = (n: number) => (b.budgetBy === "hours" ? `${formatDuration(n)} h` : formatMoney(n, b.currency));
                const over = b.used > b.budget;
                const near = !over && b.budget > 0 && b.used / b.budget >= 0.8;
                return (
                  <li key={b.id} className="wl-row wl-budget">
                    <div className="wl-row-main">
                      <Text as="p" size="2" weight="medium">
                        <Link to={`/projects/${b.id}`} className="wl-plain-link">{b.name}</Link>
                        {b.client && <Text color="gray" weight="regular"> · {b.client}</Text>}
                      </Text>
                      <Text as="p" size="2" color={over ? "red" : near ? "amber" : "gray"}>
                        {show(b.used)} of {show(b.budget)} ({b.budget ? Math.round((b.used / b.budget) * 100) : 0}%){over ? " · over budget" : ""}
                      </Text>
                    </div>
                    <div>
                      <ProgressBar value={b.used} max={b.budget} label={`${b.name} budget used`} budget />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}
    </>
  );
}
