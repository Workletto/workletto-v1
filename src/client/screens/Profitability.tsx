import { useEffect, useMemo, useState } from "react";
import { Flex, Grid, Heading, SegmentedControl, Table, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, type Client, type Project } from "../api.ts";
import { Link } from "../router.tsx";
import { formatDay } from "../timer.tsx";
import { Card, Empty, ErrorNote, Loading, Notice, PageHeader, Select, Stat, Stats, TableRegion } from "../ui.tsx";
import { PeriodPicker, ReportTabs, usePeriod } from "./Reports.tsx";
import { formatMoney } from "../../shared/money.ts";

type Money = { revenue: number; invoiced: number; uninvoiced: number; timeCost: number; expenseCost: number; cost: number; profit: number };
type Row = Money & { id: string; label: string; detail: string | null };
type Step = "day" | "week" | "month";
type Bucket = Money & { start: string };
type Result = {
  totals: Money;
  clients: Row[];
  projects: Row[];
  /** Only for admins. */
  people?: Row[];
  missingCostRates: { id: string; name: string }[];
  /** Some of it came from another currency, converted to the home currency. */
  converted?: boolean;
  series: { step: Step; buckets: Bucket[] };
};

const STEP_WORD: Record<Step, string> = { day: "day", week: "week", month: "month" };
const bucketLabel = (start: string, step: Step) =>
  step === "month" ? formatDay(start, { month: "short", year: "2-digit" }) : formatDay(start, { month: "short", day: "numeric" });

/** Profit as a share of revenue, as a whole percent; a dash when there is no revenue to measure against. */
const margin = (m: Money) => (m.revenue > 0 ? `${Math.round((m.profit / m.revenue) * 100)}%` : "—");

/** Joins names as "A", "A and B" or "A, B and C". */
const nameList = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Revenue as a bar up and cost as a bar down from a zero line, with profit as a line and dots.
 * The tables below have the same figures, so the chart has a summary instead of a data table.
 */
function ProfitChart({ series, currency }: { series: Result["series"]; currency: string }) {
  const { buckets, step } = series;
  if (!buckets.length) return null;
  const W = 600;
  const H = 200;
  const top = Math.max(1, ...buckets.map((b) => Math.max(b.revenue, b.profit)));
  const bottom = Math.max(0, ...buckets.map((b) => Math.max(b.cost, -b.profit)));
  const scale = (H - 16) / (top + bottom);
  const zero = 8 + top * scale;
  const slot = W / buckets.length;
  const bw = Math.max(1, slot * (buckets.length > 40 ? 0.8 : 0.6));
  const centre = (i: number) => i * slot + slot / 2;
  const points = buckets.map((b, i) => [centre(i), zero - b.profit * scale] as const);
  const total = buckets.reduce((s, b) => ({ revenue: s.revenue + b.revenue, cost: s.cost + b.cost, profit: s.profit + b.profit }), { revenue: 0, cost: 0, profit: 0 });
  const best = buckets.reduce((a, b) => (b.profit > a.profit ? b : a), buckets[0]!);
  const summary =
    `Revenue, cost and profit per ${STEP_WORD[step]}: ${formatMoney(total.revenue, currency)} revenue, ${formatMoney(total.cost, currency)} cost and ${formatMoney(total.profit, currency)} profit in all` +
    (total.revenue || total.cost ? `, most profit in the ${STEP_WORD[step]} of ${bucketLabel(best.start, step)} (${formatMoney(best.profit, currency)}).` : ".");
  const ticks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure className="wl-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="wl-chart-svg-wide">
        <line x1="0" x2={W} y1={zero} y2={zero} className="wl-chart-zero" />
        {buckets.map((b, i) => (
          <g key={b.start}>
            <rect x={centre(i) - bw / 2} y={zero - b.revenue * scale} width={bw} height={b.revenue * scale} className="wl-chart-billable" />
            <rect x={centre(i) - bw / 2} y={zero} width={bw} height={b.cost * scale} className="wl-chart-cost" />
          </g>
        ))}
        <polyline points={points.map((p) => p.join(",")).join(" ")} className="wl-chart-profit-line" />
        {/* Dots only where something happened, so quiet days don't read as data points. */}
        {points.map(([x, y], i) =>
          buckets[i]!.revenue || buckets[i]!.cost ? <circle key={buckets[i]!.start} cx={x} cy={y} r={buckets.length > 40 ? 2 : 3.5} className="wl-chart-profit" /> : null,
        )}
      </svg>
      <div className="wl-chart-axis" aria-hidden>
        {ticks.map((i) => (
          <span key={i} style={i === 0 ? { left: 0 } : i === buckets.length - 1 ? { right: 0 } : { left: `${((i + 0.5) / buckets.length) * 100}%`, transform: "translateX(-50%)" }}>
            {bucketLabel(buckets[i]!.start, step)}
          </span>
        ))}
      </div>
      <figcaption className="wl-chart-key">
        <span><i className="wl-chart-billable" /> Revenue (up)</span>
        <span><i className="wl-chart-cost" /> Cost (down)</span>
        <span><i className="wl-chart-profit" /> Profit (line)</span>
      </figcaption>
    </figure>
  );
}

type Breakdown = "projects" | "clients" | "people";
// The same names, order and default as Reports > Time, so the two tabs read as one report (QA2-20).
const BREAKDOWN_LABELS: Record<Breakdown, string> = { clients: "Clients", projects: "Projects", people: "People" };

// Revenue, cost and profit for a period (admins and managers). Revenue is what the work is worth
// at billing rates; cost is what the time and the expenses cost you. Only admins see each person.
export function Profitability({ currency }: { currency: string }) {
  const periodState = usePeriod();
  const { from, to } = periodState;
  const [filters, setFilters] = useState({ clientId: "", projectId: "" });
  const [result, setResult] = useState<Result | null>(null);
  const [options, setOptions] = useState<{ clients: Client[]; projects: Project[] }>({ clients: [], projects: [] });
  const [error, setError] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown>("projects");

  const query = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    for (const [key, value] of Object.entries(filters)) if (value) q.set(key, value);
    return q.toString();
  }, [from, to, filters]);

  useEffect(() => {
    let current = true;
    setError(null);
    setResult(null);
    // Dates the wrong way round: the picker says so, and there is nothing to show.
    if (from > to) return;
    api<Result>(`/api/reports/profitability?${query}`)
      .then((r) => {
        if (!current) return;
        setResult(r);
        announce(`Profitability updated: ${formatMoney(r.totals.profit, currency)} profit on ${formatMoney(r.totals.revenue, currency)} revenue.`);
      })
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [query, currency]);

  useEffect(() => {
    void Promise.all([api<{ clients: Client[] }>("/api/clients"), api<{ projects: Project[] }>("/api/projects")]).then(([c, p]) =>
      setOptions({ clients: c.clients, projects: p.projects }),
    );
  }, []);

  const set = (key: keyof typeof filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const totals = result?.totals;
  const breakdowns: Breakdown[] = result?.people ? ["clients", "projects", "people"] : ["clients", "projects"];
  const rows = result ? (breakdown === "people" ? result.people ?? [] : result[breakdown]) : [];
  const money = (cents: number) => formatMoney(cents, currency);
  const profitText = (cents: number) => <Text color={cents < 0 ? "red" : undefined}>{money(cents)}</Text>;

  return (
    <>
      <PageHeader title="Reports" docTitle="Profitability" intro="What your work earns and what it costs." help="reports/profitability" />
      <ReportTabs />

      <Flex direction="column" gap="3" className="wl-filters">
        <PeriodPicker state={periodState} />
        <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
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
        </Grid>
      </Flex>

      <ErrorNote message={error} />
      {!result && !error && <Loading />}
      {result && totals && (
        <>
          {result.converted && <Text as="p" size="2" color="gray">Amounts from clients billed in other currencies are converted to {currency} at the exchange rates in Manage → Settings.</Text>}
          {result.missingCostRates.length > 0 && (
            <Notice>
              No cost rate for {nameList(result.missingCostRates.map((p) => p.name))}, so their time counts as costing nothing. Admins set cost rates in Manage → People.
            </Notice>
          )}
          <Stats>
            <Stat large label="Revenue" value={money(totals.revenue)}>
              <Text as="p" size="2" color="gray" className="wl-num">Invoiced {money(totals.invoiced)} · Not invoiced {money(totals.uninvoiced)}</Text>
            </Stat>
            <Stat large label="Cost" value={money(totals.cost)}>
              <Text as="p" size="2" color="gray" className="wl-num">Time {money(totals.timeCost)} · Expenses {money(totals.expenseCost)}</Text>
            </Stat>
            <Stat large label="Profit" value={profitText(totals.profit)}>
              <Text as="p" size="2" color="gray">Margin {margin(totals)}</Text>
            </Stat>
          </Stats>
          <ProfitChart series={result.series} currency={currency} />

          <Card>
            <Flex px="4" py="3" gap="3" align="center" justify="between" wrap="wrap" className="wl-card-head">
              <Heading as="h2" size="3">Breakdown</Heading>
              <SegmentedControl.Root aria-label="Group results by" size="2" value={breakdown} onValueChange={(b) => setBreakdown(b as Breakdown)}>
                {breakdowns.map((b) => (
                  <SegmentedControl.Item key={b} value={b}>{BREAKDOWN_LABELS[b]}</SegmentedControl.Item>
                ))}
              </SegmentedControl.Root>
            </Flex>
            {rows.length === 0 ? (
              <Empty>No time or expenses in this period.</Empty>
            ) : (
              <TableRegion label={`${BREAKDOWN_LABELS[breakdown]} profitability`} minWidth="36rem">
                <Table.Root variant="ghost" size="2">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Revenue</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Cost</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Profit</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell justify="end">Margin</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {rows.map((r) => (
                      <Table.Row key={r.id}>
                        <Table.RowHeaderCell>
                          {breakdown === "projects" ? <Link to={`/projects/${r.id}`} className="wl-plain-link"><Text weight="medium">{r.label}</Text></Link> : <Text weight="medium">{r.label}</Text>}
                          {r.detail && <Text color="gray"> · {r.detail}</Text>}
                        </Table.RowHeaderCell>
                        <Table.Cell justify="end" className="wl-num">{money(r.revenue)}</Table.Cell>
                        <Table.Cell justify="end" className="wl-num">{money(r.cost)}</Table.Cell>
                        <Table.Cell justify="end" className="wl-num">{profitText(r.profit)}</Table.Cell>
                        <Table.Cell justify="end" className="wl-num">{margin(r)}</Table.Cell>
                      </Table.Row>
                    ))}
                    <Table.Row>
                      <Table.RowHeaderCell><Text weight="bold">Total</Text></Table.RowHeaderCell>
                      <Table.Cell justify="end" className="wl-num"><Text weight="bold">{money(totals.revenue)}</Text></Table.Cell>
                      <Table.Cell justify="end" className="wl-num"><Text weight="bold">{money(totals.cost)}</Text></Table.Cell>
                      <Table.Cell justify="end" className="wl-num"><Text weight="bold">{profitText(totals.profit)}</Text></Table.Cell>
                      <Table.Cell justify="end" className="wl-num"><Text weight="bold">{margin(totals)}</Text></Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table.Root>
              </TableRegion>
            )}
          </Card>
        </>
      )}
    </>
  );
}
