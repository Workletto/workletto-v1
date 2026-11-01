import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Badge, Box, Card as RadixCard, Flex, Grid, Heading, RadioGroup, Table, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen } from "../a11y.tsx";
import { CustomFieldInputs, changedValues, useCustomFields, type FieldValues } from "../customFields.tsx";
import { useGroups } from "../groups.tsx";
import { api, projectCurrency, type Client, type Me, type Member, type Project, type ProjectStats, type Task } from "../api.ts";
import { DueDate, ProjectTasks, STATUS_LABELS } from "./ProjectTasks.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { Link, navigate, usePath } from "../router.tsx";
import { ActionButton, TableRegion, Select, CheckField, ErrorNote, Loading, NavTabs, PageHeader, ProgressBar, RadioOption, RowButton, SavedNote, SaveButton, SettingsSection, SrOnly, Stat, Stats, TextInput, ArticleLink, useConfirm, useSaveForm } from "../ui.tsx";
import { ClientSelect } from "./Projects.tsx";
import { addDays, formatDuration, parseBudgetHours } from "../../shared/time.ts";
import { formatMoney, moneyInput, parseMoney } from "../../shared/money.ts";
import { canManageWork } from "../../shared/roles.ts";

type Hours = { id: string; name: string; seconds: number };
type Recent = { id: string; date: string; person: { id: string; name: string }; task: string | null; notes: string; seconds: number; running: boolean };
/** A phase of a project billed per phase (WRK-151): its fee, what's invoiced and left, and its hours. */
type Phase = { taskId: string; title: string; fee: number; invoiced: number; left: number; seconds?: number };
type Loaded = { project: Project; team: { id: string; name: string }[]; stats: ProjectStats; tasks: Task[]; hours: Hours[]; recent: Recent[]; phases?: Phase[] };
export type ProjectTab = "overview" | "tasks" | "settings";
const TAB_NAMES: Record<ProjectTab, string> = { overview: "Overview", tasks: "Tasks", settings: "Settings" };

// One project: its numbers, and (for admins and managers) its settings.
export function ProjectPage({ id, tab, me }: { id: string; tab: ProjectTab; me: Me }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = canManageWork(me.user.role);
  // The home currency: profitability is in it. The project's own money is in its client's currency.
  const home = me.organization.currency;

  const load = useCallback(async () => {
    try {
      setData(await api<Loaded>(`/api/projects/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(data !== null, "Project loaded.");

  if (error) {
    return (
      <>
        <ErrorNote message={error} />
        <Text as="p"><Link to="/projects" className="wl-link wl-link-alone">Back to projects</Link></Text>
      </>
    );
  }
  if (!data) return <Loading />;
  const { project } = data;

  const tabs: { key: ProjectTab; label: string; to: string }[] = [
    { key: "overview", label: "Overview", to: `/projects/${id}` },
    { key: "tasks", label: `Tasks${data.tasks.length ? ` (${data.tasks.filter((t) => t.status !== "done").length})` : ""}`, to: `/projects/${id}/tasks` },
    ...(canManage ? [{ key: "settings" as const, label: "Settings", to: `/projects/${id}/settings` }] : []),
  ];

  return (
    <>
      <PageHeader
        docTitle={tab === "overview" ? project.name : `${project.name}: ${TAB_NAMES[tab]}`}
        title={
          <>
            {project.name}
            {project.archived && (
              <>
                {" "}
                <Badge color="gray" variant="soft" size="2" style={{ verticalAlign: "middle" }}>Archived</Badge>
              </>
            )}
          </>
        }
        eyebrow={<Link to="/projects" className="wl-link">Projects</Link>}
        intro={project.client?.name ?? "No client"}
        help="projects-and-tasks/projects"
      >
        {canManage && project.client && !project.archived && (
          <ActionButton asChild variant="soft" color="gray">
            <Link to={`/invoices/new/${project.client.id}`}>New invoice<SrOnly> for {project.client.name}</SrOnly></Link>
          </ActionButton>
        )}
      </PageHeader>
      <NavTabs label="Project sections" tabs={tabs.map((t) => ({ to: t.to, label: t.label, active: tab === t.key }))} />
      {tab === "settings" && canManage ? (
        <ProjectSettings project={project} home={home} onSaved={load} tasks={data.tasks} phases={data.phases ?? []} />
      ) : tab === "tasks" ? (
        <ProjectTasks projectId={id} tasks={data.tasks} team={data.team} onChange={load} canManage={canManage} />
      ) : (
        <Overview data={data} home={home} canManage={canManage} />
      )}
    </>
  );
}

function Overview({ data: { project, team, stats, tasks, hours, recent, phases }, home, canManage }: { data: Loaded; home: string; canManage: boolean }) {
  const currency = projectCurrency(project, home);
  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done");
  const budget =
    project.budgetBy === "hours" && project.budgetSeconds
      ? { used: stats.seconds, max: project.budgetSeconds, show: (n: number) => `${formatDuration(n)} h` }
      : project.budgetBy === "fees" && project.budgetAmount && stats.billableAmount !== undefined
        ? { used: stats.billableAmount, max: project.budgetAmount, show: (n: number) => formatMoney(n, currency) }
        : null;
  const nearing = budget !== null && budget.used <= budget.max && project.budgetAlertLevel === 80;
  // The people who have time on this project, with their hours (admins and managers see everyone's; members, their own).
  const byId = new Map(hours.map((h) => [h.id, h]));
  const people = (canManage ? hours : team.map((p) => ({ ...p, seconds: byId.get(p.id)?.seconds ?? 0 }))).filter((p) => p.seconds > 0);
  const most = Math.max(1, ...hours.map((h) => h.seconds));
  return (
    <>
      <Stats band>
        <Stat label="Hours tracked" value={formatDuration(stats.seconds)}>
          <Text as="p" size="2" color="gray">{stats.billableSeconds === stats.seconds && stats.seconds > 0 ? "All billable" : `${formatDuration(stats.billableSeconds)} billable`}</Text>
        </Stat>
        {project.fixedFee != null && stats.feeInvoiced !== undefined ? (
          <Stat label="Fixed fee" value={formatMoney(project.fixedFee, currency)}>
            <ProgressBar value={stats.feeInvoiced} max={project.fixedFee} label="Fee invoiced" />
            <Text as="p" size="2" color="gray">
              {project.feeByPhase && project.fixedFee === 0
                ? "Set each phase's fee in Settings."
                : stats.feeInvoiced >= project.fixedFee
                ? "All invoiced"
                : `${formatMoney(stats.feeInvoiced, currency)} invoiced · ${formatMoney(project.fixedFee - stats.feeInvoiced, currency)} left to bill`}
            </Text>
          </Stat>
        ) : stats.billableAmount !== undefined && (
          <Stat label="Billable amount" value={formatMoney(stats.billableAmount, currency)}>
            <Text as="p" size="2" color="gray">
              {project.billable
                ? project.billBy === "person" ? "At each person's rate" : project.hourlyRate ? `At ${formatMoney(project.hourlyRate, currency)} an hour` : "No rate set yet"
                : "Non-billable"}
            </Text>
          </Stat>
        )}
        {budget && (
          <Stat label="Budget" value={`${Math.round((budget.used / budget.max) * 100)}%`}>
            <ProgressBar value={budget.used} max={budget.max} label="Budget used" budget />
            <Text as="p" size="2" color={budget.used > budget.max ? "red" : nearing ? "amber" : "gray"}>
              {budget.show(budget.used)} of {budget.show(budget.max)}
              {budget.used > budget.max ? " (over budget)" : nearing ? " (past the 80% alert)" : ""}
            </Text>
          </Stat>
        )}
        {tasks.length > 0 && (
          <Stat label="Tasks" value={`${doneTasks} of ${tasks.length}`}>
            <ProgressBar value={doneTasks} max={tasks.length} label="Tasks done" />
            <Text as="p" size="2" color="gray"><Link to={`/projects/${project.id}/tasks`} className="wl-link wl-link-alone">{tasks.length - doneTasks} still open</Link></Text>
          </Stat>
        )}
      </Stats>
      {phases && phases.length > 0 && (
        <RadixCard>
          <Heading as="h2" size="3" mb="2">Phases</Heading>
          <TableRegion label="Phases">
            <Table.Root variant="ghost" size="2">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Phase</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Fee</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Invoiced</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Left to bill</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Hours</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {phases.map((p) => (
                  <Table.Row key={p.taskId}>
                    <Table.RowHeaderCell>{p.title}</Table.RowHeaderCell>
                    <Table.Cell justify="end" className="wl-num">{formatMoney(p.fee, projectCurrency(project, home))}</Table.Cell>
                    <Table.Cell justify="end" className="wl-num">{formatMoney(p.invoiced, projectCurrency(project, home))}</Table.Cell>
                    <Table.Cell justify="end" className="wl-num">{formatMoney(p.left, projectCurrency(project, home))}</Table.Cell>
                    <Table.Cell justify="end" className="wl-num">{formatDuration(p.seconds ?? 0)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </TableRegion>
        </RadixCard>
      )}
      <div className="wl-columns">
        <div className="wl-columns-main">
          <section aria-labelledby="open-tasks">
            <Flex align="baseline" justify="between" gap="3" wrap="wrap">
              <Heading as="h2" size="3" id="open-tasks">Open tasks</Heading>
              <Link to={`/projects/${project.id}/tasks`} className="wl-link">All tasks</Link>
            </Flex>
            {open.length === 0 ? (
              <Text as="p" size="2" color="gray" mt="2">{tasks.length ? "Every task is done." : "No tasks yet."}</Text>
            ) : (
              <ul className="wl-rows wl-lined">
                {open.slice(0, 5).map((t) => (
                  <li key={t.id} className="wl-row wl-brief-row">
                    <Badge color={t.status === "in_progress" ? undefined : "gray"} variant="soft">{STATUS_LABELS[t.status]}</Badge>
                    <Text weight="medium" className="wl-brief-main">{t.title}</Text>
                    <Text size="2" color="gray">{t.assignee?.name ?? "Unassigned"}</Text>
                    <Text size="2" className="wl-brief-end"><DueDate task={t} /></Text>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="recent-time">
            <Flex align="baseline" justify="between" gap="3" wrap="wrap">
              <Heading as="h2" size="3" id="recent-time">Recent time</Heading>
              {recent.length > 0 && <Link to={`/reports?projectId=${project.id}`} className="wl-link">See this project in Reports</Link>}
            </Flex>
            <Text as="p" size="2" color="gray">{canManage ? "The latest entries on this project." : "Your latest entries on this project."}</Text>
            {recent.length === 0 ? (
              <Text as="p" size="2" color="gray" mt="2">No time on this project yet.</Text>
            ) : (
              <ul className="wl-rows wl-lined">
                {recent.map((e) => (
                  <li key={e.id} className="wl-row wl-brief-row">
                    <Text size="2" color="gray" className="wl-brief-date">{formatDay(e.date, { weekday: "short", day: "numeric", month: "short" })}</Text>
                    {canManage && <Text size="2" className="wl-brief-who">{e.person.name}</Text>}
                    <span className="wl-brief-main">
                      <Text as="span" size="2" weight="medium">{e.task ?? (e.notes || "No task or notes")}</Text>
                      {e.task && e.notes && <Text as="span" size="2" color="gray" className="wl-brief-notes">{e.notes}</Text>}
                    </span>
                    <Text size="2" weight="medium" className="wl-num wl-brief-end">{e.running && <span className="wl-pulse" aria-hidden />}{formatDuration(e.seconds)}{e.running && <SrOnly> (timer running)</SrOnly>}</Text>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside className="wl-columns-aside" aria-label="About this project">
          <section className="wl-side-panel" aria-labelledby="project-team">
            <Heading as="h2" size="3" id="project-team">Team</Heading>
            <Text as="p" size="2" color="gray" mb="3">{project.everyone === false ? "Only these people can track time here." : "Everyone can track time on this project."}</Text>
            {people.length === 0 ? (
              <Text as="p" size="2" color="gray">No time yet.</Text>
            ) : (
            <ul className="wl-team-hours">
              {people.map((p) => (
                <li key={p.id}>
                  <span className="wl-avatar" aria-hidden>{p.name.trim().charAt(0).toUpperCase()}</span>
                  <Text size="2" weight="medium" className="wl-brief-main">{p.name}</Text>
                  <Text size="2" color="gray" className="wl-num">{formatDuration(p.seconds)}</Text>
                  {canManage && <div className="wl-bar" aria-hidden><div style={{ width: `${(p.seconds / most) * 100}%` }} /></div>}
                </li>
              ))}
            </ul>
            )}
          </section>
          {canManage && <ProjectProfit projectId={project.id} currency={home} />}
        </aside>
      </div>
    </>
  );
}

// What the project has earned and cost, all time, with the Profitability report's own figures
// (cost rates from Manage → People). For admins and managers only, like that report.
function ProjectProfit({ projectId, currency }: { projectId: string; currency: string }) {
  type Totals = { revenue: number; cost: number; profit: number };
  const [data, setData] = useState<{ totals: Totals; missingCostRates: { id: string; name: string }[] } | null>(null);
  useEffect(() => {
    const today = localToday();
    // The report reaches back up to ten years.
    api<{ totals: Totals; missingCostRates: { id: string; name: string }[] }>(`/api/reports/profitability?from=${addDays(today, -3650)}&to=${today}&projectId=${projectId}`)
      .then(setData)
      .catch(() => setData(null));
  }, [projectId]);
  if (!data) return null;
  const { revenue, cost, profit } = data.totals;
  return (
    <section className="wl-side-panel" aria-labelledby="project-profit">
      <Heading as="h2" size="3" id="project-profit">Profitability</Heading>
      <Text as="p" size="2" color="gray" mb="3">All time, from billable time and expenses. Only admins and managers see this.</Text>
      {revenue === 0 && cost === 0 ? (
        <Text as="p" size="2" color="gray">No billable work or costs yet.</Text>
      ) : (
        <>
          <p className="wl-side-figure">
            <span className="wl-num">{formatMoney(profit, currency)}</span>
            <Text size="2" color={profit < 0 ? "red" : "gray"}>{profit < 0 ? "loss" : "profit"}{revenue > 0 ? ` · ${Math.round((profit / revenue) * 100)}% margin` : ""}</Text>
          </p>
          <dl className="wl-side-list">
            <div><dt>Revenue</dt><dd className="wl-num">{formatMoney(revenue, currency)}</dd></div>
            <div><dt>Cost</dt><dd className="wl-num">{formatMoney(cost, currency)}</dd></div>
          </dl>
          {data.missingCostRates.length > 0 && (
            <Text as="p" size="1" color="gray" mt="2">
              No cost rate for {data.missingCostRates.map((p) => p.name).join(", ")}, so their time counts as costing nothing. Set it in Manage → People.
            </Text>
          )}
        </>
      )}
    </section>
  );
}

function ProjectSettings({ project, home, onSaved, tasks, phases }: { project: Project; home: string; onSaved: () => Promise<void>; tasks: Task[]; phases: Phase[] }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [form, setForm] = useState({
    name: project.name,
    clientId: project.client?.id ?? "",
    billable: project.billable,
    // "fixed" stands for a fixed fee: billBy stays as it was, and fixedFee is set.
    billBy: (project.fixedFee != null ? "fixed" : project.billBy ?? "project") as "project" | "person" | "fixed",
    hourlyRate: moneyInput(project.hourlyRate),
    fixedFee: moneyInput(project.fixedFee ?? null),
    feeByPhase: project.feeByPhase ?? false,
    budgetBy: project.budgetBy ?? "none",
    budgetHours: project.budgetSeconds ? String(+(project.budgetSeconds / 3600).toFixed(2)) : "",
    budgetAmount: moneyInput(project.budgetAmount),
    everyone: project.everyone ?? true,
    memberIds: new Set(project.memberIds ?? []),
    customFields: (project.customFields ?? {}) as FieldValues,
  });
  const fields = useCustomFields("project");
  // User groups (WRK-149): add a group's people to the team in one step.
  const { groups } = useGroups();
  const [addGroup, setAddGroup] = useState("");
  // A Set doesn't serialize, so the team goes in as a sorted list.
  const state = useSaveForm({ ...form, memberIds: [...form.memberIds].sort() });
  // `field` is the input a validation message is about.
  const [problem, setProblem] = useState<{ text: string; field?: "hourlyRate" | "fixedFee" | "budgetHours" | "budgetAmount" } | null>(null);
  const messageId = useId();
  const about = (field: "hourlyRate" | "fixedFee" | "budgetHours" | "budgetAmount") =>
    problem?.field === field ? { invalid: true, errorId: messageId } : {};
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    api<{ clients: Client[] }>("/api/clients").then((r) => setClients(r.clients)).catch(() => undefined);
    api<{ members: Member[] }>("/api/members").then((r) => setPeople(r.members.filter((m) => m.active))).catch(() => undefined);
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const hourlyRate = parseMoney(form.hourlyRate);
    const fixed = form.billable && form.billBy === "fixed";
    // Per phase (WRK-151), the fee is the phases' sum and isn't sent.
    const byPhase = fixed && form.feeByPhase;
    const fixedFee = fixed && !byPhase ? parseMoney(form.fixedFee) : null;
    const budgetAmount = parseMoney(form.budgetAmount);
    const budgetSeconds = parseBudgetHours(form.budgetHours);
    if (Number.isNaN(hourlyRate)) return setProblem({ text: "Enter amounts like 120 or 95.50.", field: "hourlyRate" });
    if (fixed && !byPhase && (fixedFee === null || Number.isNaN(fixedFee) || fixedFee <= 0)) return setProblem({ text: "Enter the fixed fee, like 12000 or 9500.50.", field: "fixedFee" });
    if (fixed && form.budgetBy === "fees") return setProblem({ text: "A fixed fee project's time has no hourly value, so give it a budget in hours, or none." });
    if (Number.isNaN(budgetAmount)) return setProblem({ text: "Enter amounts like 120 or 95.50.", field: "budgetAmount" });
    if (Number.isNaN(budgetSeconds)) return setProblem({ text: "Enter the budget in hours, like 40, 12.5 or 40:30.", field: "budgetHours" });
    if (form.budgetBy === "hours" && !budgetSeconds) return setProblem({ text: "Enter the budget in hours.", field: "budgetHours" });
    if (form.budgetBy === "fees" && !budgetAmount) return setProblem({ text: "Enter the budget amount.", field: "budgetAmount" });

    const body: Record<string, unknown> = {
      name: form.name,
      billable: form.billable,
      ...(form.billBy === "fixed" ? {} : { billBy: form.billBy }),
      hourlyRate,
      ...(byPhase ? {} : { fixedFee }),
      ...(form.feeByPhase !== (project.feeByPhase ?? false) ? { feeByPhase: byPhase } : {}),
      budgetBy: form.budgetBy,
      budgetSeconds,
      budgetAmount,
      everyone: form.everyone,
      memberIds: [...form.memberIds],
    };
    const changedFields = changedValues(fields, form.customFields, project.customFields ?? {});
    if (Object.keys(changedFields).length) body.customFields = changedFields;
    if (form.clientId !== (project.client?.id ?? "")) body.clientId = form.clientId || null;
    void state.save(async () => {
      await api(`/api/projects/${project.id}`, body, "PATCH");
      await onSaved();
    }, "Project saved.");
  }

  const confirm = useConfirm();
  async function archive() {
    if (!project.archived) {
      const ok = await confirm({
        title: `Archive ${project.name}?`,
        description: "It leaves the list of projects people can track time on. Its time and invoices stay, and you can restore it any time.",
        confirm: "Archive",
        danger: false,
      });
      if (!ok) return;
    }
    try {
      await api(`/api/projects/${project.id}`, { archived: !project.archived }, "PATCH");
      await onSaved();
      announce(project.archived ? "Project restored." : "Project archived.");
    } catch (e) {
      setProblem({ text: (e as Error).message });
    }
  }
  async function remove() {
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      description: "This can't be undone. A project with time, expenses or an invoiced fee on it can't be deleted; archive it instead.",
      confirm: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${project.id}`, undefined, "DELETE");
      navigate("/projects");
    } catch (e) {
      setProblem({ text: (e as Error).message });
    }
  }

  const clientChoices = clients.filter((c) => !c.archived || c.id === project.client?.id);
  // The money is in the chosen client's currency. People's own rates are in the home currency,
  // so a client billed in another one can't use them.
  const currency = clients.find((c) => c.id === form.clientId)?.currency ?? (form.clientId ? projectCurrency(project, home) : home);
  const foreign = currency !== home;

  return (
    <form onSubmit={save}>
      <Flex direction="column" gap="5">
        <SettingsSection title="Project" description="Its name and the client it's for.">
          <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
            <TextInput label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
            <div>
              <ClientSelect clients={clientChoices} value={form.clientId} onChange={(id) => set("clientId", id)} current={project.client} />
            </div>
          </Grid>
        </SettingsSection>

        <SettingsSection
          title="Billing"
          description={
            <>
              Whether time on this project is billable, and at what rate or for what fixed fee.{" "}
              <ArticleLink article="projects-and-tasks/projects#fixed-fee-projects">About fixed fees</ArticleLink>
            </>
          }
        >
          <CheckField label="Billable (new time on this project starts out billable)" checked={form.billable} onChange={(billable) => set("billable", billable)} />
          {form.billable && (
            <Box pl="6">
              <RadioGroup.Root value={form.billBy} onValueChange={(v) => set("billBy", v as "project" | "person" | "fixed")} aria-label="How this project is billed">
                <Flex direction="column" gap="3">
                  <RadioOption value="project">One hourly rate for the whole project</RadioOption>
                  {form.billBy === "project" && (
                    <Box pl="6" maxWidth="16rem">
                      <TextInput label="Project hourly rate" value={form.hourlyRate} onChange={(e) => set("hourlyRate", e.target.value)} inputMode="decimal" placeholder="0.00" suffix={`${currency} an hour`} {...about("hourlyRate")} className="wl-num" />
                    </Box>
                  )}
                  <RadioOption
                    value="person"
                    disabled={foreign && form.billBy !== "person"}
                    hint={foreign ? `Not for a client billed in ${currency}: people's own rates are in ${home}.` : undefined}
                  >
                    Each person's own hourly rate (set in Manage → People)
                  </RadioOption>
                  <RadioOption value="fixed">A fixed fee, invoiced in full or in parts</RadioOption>
                  {form.billBy === "fixed" && (
                    <Box pl="6">
                      <Flex direction="column" gap="3">
                        {form.feeByPhase && project.feeByPhase ? (
                          <Text as="p" size="2">Fixed fee: <strong className="wl-num">{formatMoney(project.fixedFee ?? 0, currency)}</strong>, the sum of the phases below.</Text>
                        ) : (
                          !form.feeByPhase && (
                            <Box maxWidth="16rem">
                              <TextInput label="Fixed fee" value={form.fixedFee} onChange={(e) => set("fixedFee", e.target.value)} inputMode="decimal" placeholder="0.00" suffix={currency} {...about("fixedFee")} className="wl-num" />
                            </Box>
                          )
                        )}
                        {/* Fee per phase (WRK-151): only for a project that's already a fixed fee project. */}
                        {project.fixedFee != null && (
                          <CheckField
                            label="Fee per phase (a fee on each task)"
                            checked={form.feeByPhase}
                            onChange={(on) => set("feeByPhase", on)}
                            hint="Each task with a fee is a phase, billed on its own; the project's fee is their sum. You can switch only while none of the fee is on an invoice."
                          />
                        )}
                      </Flex>
                    </Box>
                  )}
                </Flex>
              </RadioGroup.Root>
            </Box>
          )}
        </SettingsSection>

        <SettingsSection
          title="Budget"
          description={
            <>
              Warns you at 80% and when it's used up.{" "}
              <ArticleLink article="projects-and-tasks/budget-alerts">About budget alerts</ArticleLink>
            </>
          }
        >
          <RadioGroup.Root value={form.budgetBy} onValueChange={(v) => set("budgetBy", v as "none" | "hours" | "fees")} aria-label="Budget">
            <Flex direction="column" gap="3">
              <RadioOption value="none">No budget</RadioOption>
              <RadioOption value="hours">Total hours</RadioOption>
              {form.budgetBy === "hours" && (
                <Box pl="6" maxWidth="16rem">
                  <TextInput label="Budget in hours" value={form.budgetHours} onChange={(e) => set("budgetHours", e.target.value)} inputMode="decimal" placeholder="40" suffix="hours" {...about("budgetHours")} className="wl-num" />
                </Box>
              )}
              {/* A fixed fee project's time has no hourly value to count against a money budget. */}
              {(form.billBy !== "fixed" || form.budgetBy === "fees") && <RadioOption value="fees">Total fees (billable amount)</RadioOption>}
              {form.budgetBy === "fees" && (
                <Box pl="6" maxWidth="16rem">
                  <TextInput label="Budget amount" value={form.budgetAmount} onChange={(e) => set("budgetAmount", e.target.value)} inputMode="decimal" placeholder="0.00" suffix={currency} {...about("budgetAmount")} className="wl-num" />
                </Box>
              )}
            </Flex>
          </RadioGroup.Root>
        </SettingsSection>

        <SettingsSection title="Team" description="Who can track time here.">
          <RadioGroup.Root value={form.everyone ? "everyone" : "chosen"} onValueChange={(v) => set("everyone", v === "everyone")} aria-label="Who can track time">
            <Flex direction="column" gap="3">
              <RadioOption value="everyone">Everyone can track time on this project</RadioOption>
              <RadioOption value="chosen">Only the people I choose (admins and managers can always track time)</RadioOption>
            </Flex>
          </RadioGroup.Root>
          {groups.length > 0 && (
            <Flex wrap="wrap" align="end" gap="3" pl="6">
              <div style={{ width: "14rem", maxWidth: "100%" }}>
                <Select label="Add a group's people" value={addGroup} onChange={setAddGroup} placeholder="Choose a group" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
              </div>
              <RowButton
                type="button"
                disabled={!addGroup}
                onClick={() => {
                  const group = groups.find((g) => g.id === addGroup);
                  if (!group) return;
                  const active = new Set(people.map((p) => p.id));
                  const next = new Set(form.memberIds);
                  for (const id of group.memberIds) if (active.has(id)) next.add(id);
                  setForm((f) => ({ ...f, everyone: false, memberIds: next }));
                  setAddGroup("");
                  announce(`${group.name} added to the team. Save the project to keep it.`);
                }}
              >
                Add group
              </RowButton>
            </Flex>
          )}
          {!form.everyone && (
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="2" pl="6">
              {people.map((p) => (
                <CheckField
                  key={p.id}
                  label={p.name}
                  checked={form.memberIds.has(p.id)}
                  onChange={(checked) => {
                    const next = new Set(form.memberIds);
                    if (checked) next.add(p.id);
                    else next.delete(p.id);
                    set("memberIds", next);
                  }}
                />
              ))}
            </Grid>
          )}
        </SettingsSection>

        {project.feeByPhase && <PhaseFees project={project} tasks={tasks} phases={phases} currency={currency} onSaved={onSaved} />}

        {fields.length > 0 && (
          <SettingsSection title="Custom fields" description="Your organization's own fields for projects (Manage → Settings).">
            <CustomFieldInputs fields={fields} values={form.customFields} onChange={(v) => set("customFields", v)} />
          </SettingsSection>
        )}

        <SaveAsTemplate project={project} />

        <Flex wrap="wrap" align="center" gap="3" className="wl-form-footer">
          <RowButton type="button" danger onClick={() => void remove()}>Delete project</RowButton>
          <RowButton type="button" onClick={() => void archive()}>{project.archived ? "Restore project" : "Archive project"}</RowButton>
          <Flex align="center" gap="3" ml="auto">
            <SavedNote message={problem ? { ok: false, text: problem.text, id: messageId } : state.message && { ...state.message, id: messageId }} />
            <SaveButton state={state}>Save project</SaveButton>
          </Flex>
        </Flex>
      </Flex>
    </form>
  );
}

// Fee per phase (WRK-151): each task's fee, saved on its own (not with Save project). Empty: not a phase.
function PhaseFees({ project, tasks, phases, currency, onSaved }: { project: Project; tasks: Task[]; phases: Phase[]; currency: string; onSaved: () => Promise<void> }) {
  const byTask = new Map(phases.map((p) => [p.taskId, p]));
  const initial = () => Object.fromEntries(tasks.map((t) => [t.id, moneyInput(byTask.get(t.id)?.fee ?? null)]));
  const [fees, setFees] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    const body: Record<string, number | null> = {};
    for (const t of tasks) {
      const text = (fees[t.id] ?? "").trim();
      const fee = text ? parseMoney(text) : null;
      if (fee !== null && (Number.isNaN(fee) || fee <= 0)) return setMessage({ ok: false, text: `Enter the ${t.title} fee as an amount, like 12000 or 9500.50, or leave it empty.` });
      body[t.id] = fee;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/projects/${project.id}/phase-fees`, { fees: body }, "PUT");
      await onSaved();
      setMessage({ ok: true, text: "Phase fees saved." });
      announce("Phase fees saved.");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Phase fees"
      description={<>Each task with a fee is a phase. The project's fee is their sum. A phase can't go below what's already invoiced of it. <ArticleLink article="projects-and-tasks/projects#fee-per-phase">About fees per phase</ArticleLink></>}
    >
      {tasks.length === 0 ? (
        <Text as="p" size="2" color="gray">Add the phases as tasks on the Tasks tab first, like Schematic Design or Construction Documents.</Text>
      ) : (
        <Flex direction="column" gap="2">
          {tasks.map((t) => {
            const phase = byTask.get(t.id);
            return (
              <Flex key={t.id} wrap="wrap" align="end" gap="3">
                <Box style={{ width: "14rem", maxWidth: "100%" }}>
                  <TextInput label={`${t.title} fee`} value={fees[t.id] ?? ""} onChange={(e) => setFees((f) => ({ ...f, [t.id]: e.target.value }))} inputMode="decimal" placeholder="Not a phase" suffix={currency} className="wl-num" />
                </Box>
                {phase && phase.invoiced > 0 && <Text size="2" color="gray">{formatMoney(phase.invoiced, currency)} invoiced</Text>}
              </Flex>
            );
          })}
          <Flex align="center" gap="3" mt="2">
            <ActionButton busy={busy} onClick={() => void save()}>Save phase fees</ActionButton>
            <SavedNote message={message} />
          </Flex>
        </Flex>
      )}
    </SettingsSection>
  );
}

// Save as template (WRK-150): the project as last saved, without its client, under a new name.
function SaveAsTemplate({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/project-templates", { projectId: project.id, name });
      setOpen(false);
      setName("");
      setMessage({ ok: true, text: `Saved as a template. Start new projects from it under Projects; manage it in Manage → Templates.` });
      announce("Saved as a template.");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Template" description="Save this project's billing, rates, budget, team and tasks, without its client, to start new projects from. Unsaved changes above aren't included.">
      {open ? (
        <Flex wrap="wrap" align="end" gap="3">
          <div style={{ flex: "1 1 16rem", maxWidth: "24rem" }}>
            <TextInput
              label="Template name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // Inside the project form: Enter saves the template, not the project.
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              maxLength={200}
              placeholder={project.name}
            />
          </div>
          <ActionButton type="button" busy={busy} onClick={() => void save()}>Save template</ActionButton>
          <RowButton type="button" onClick={() => { setOpen(false); setMessage(null); }}>Cancel</RowButton>
        </Flex>
      ) : (
        <div>
          <RowButton type="button" onClick={() => { setName(project.name); setOpen(true); setMessage(null); }}>Save as template</RowButton>
        </div>
      )}
      {message && <SavedNote message={message} />}
    </SettingsSection>
  );
}

/** Reads /projects/:id and /projects/:id/<tab> addresses. */
export function useProjectRoute(): { id: string; tab: ProjectTab } | null {
  const path = usePath();
  const m = /^\/projects\/([\w-]+)(?:\/(settings|tasks))?$/.exec(path);
  return m ? { id: m[1]!, tab: (m[2] as ProjectTab | undefined) ?? "overview" } : null;
}
