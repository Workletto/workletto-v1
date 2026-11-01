import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Badge, Flex, Heading, SegmentedControl, Text, TextField } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { CustomFieldInputs, changedValues, useCustomFields, type FieldValues } from "../customFields.tsx";
import { api, type Project, type Task, type TimeEntry } from "../api.ts";
import { addDays, formatDuration, formatEntryDuration, MAX_ENTRY_SECONDS, parseTypedDuration, startOfWeek } from "../../shared/time.ts";
import { Link, navigate } from "../router.tsx";
import { elapsed, formatDay, localToday, useNow, useTimer } from "../timer.tsx";
import { PeriodStepper, weekRange } from "../WeekNav.tsx";
import { DonationCard } from "../DonationCard.tsx";
import { ActionButton, ArticleLink, brief, Card, ProgressBar, Stat, Stats, CheckField, Clock, ErrorNote, InlineError, Loading, Notice, PageHeader, projectGroups, RowButton, SaveButton, Select, SrOnly, TextInput, useConfirm } from "../ui.tsx";

export type TimeMode = "day" | "week";

// Time opens on whichever view this person used last, in this browser.
const VIEW_KEY = "work.timeView";
export function lastTimeMode(): TimeMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "week" ? "week" : "day";
  } catch {
    return "day";
  }
}

const DURATION_HELP = "Enter a duration like 1:30 or 1.5, up to 24 hours.";
const ZERO_DURATION = "Enter a time above zero, or leave it empty to start a timer.";
const DURATION_FORMATS = "Like 1:30, 1.5 or 90m. A whole number up to 24 is hours; from 25 it's minutes.";

/** Whether the task list shows for a project: it has open tasks, or the entry already has one. */
function hasTaskChoices(tasks: Task[], projectId: string, current?: { id: string } | null) {
  return !!projectId && (tasks.some((t) => t.projectId === projectId) || !!current);
}

// What a typed duration was read as ("90" becomes "1:30"); unreadable text is left for the error.
function readable(text: string): string {
  const seconds = parseTypedDuration(text);
  return seconds === null || Number.isNaN(seconds) ? text : formatDuration(seconds);
}
const sum = (entries: TimeEntry[], now: number) => entries.reduce((total, e) => total + elapsed(e, now), 0);

// Your own time: one day with its entries, or the whole week as a grid.
// Both load the week around the chosen day; totals are added up here, from entries.
export function Time({ mode, date, canManage, admin = false, approvals, capacity }: { mode: TimeMode; date: string; canManage: boolean; admin?: boolean; approvals: boolean; capacity: number }) {
  const timer = useTimer();
  const today = localToday();
  const weekStart = startOfWeek(date);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      // Private windows may refuse; the default view is fine.
    }
  }, [mode]);

  useEffect(() => {
    let current = true;
    api<{ entries: TimeEntry[] }>(`/api/time-entries?from=${weekStart}&to=${addDays(weekStart, 6)}`)
      .then((r) => current && setEntries(r.entries))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [weekStart, timer.version]);

  useEffect(() => {
    api<{ projects: Project[] }>("/api/projects")
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, []);

  // Open tasks to pick from. Reloaded with entries, in case tasks changed.
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    api<{ tasks: Task[] }>("/api/tasks").then((r) => setTasks(r.tasks)).catch(() => undefined);
  }, [timer.version]);

  // Timesheet approvals: this week's status, and last week's for the reminder.
  const lastWeek = addDays(startOfWeek(today), -7);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  useEffect(() => {
    if (!approvals) return setSheets(null);
    let current = true;
    const from = weekStart < lastWeek ? weekStart : lastWeek;
    const to = weekStart > lastWeek ? weekStart : lastWeek;
    api<{ weeks: Sheet[] }>(`/api/timesheets/mine?from=${from}&to=${to}`)
      .then((r) => current && setSheets(r.weeks))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [approvals, weekStart, lastWeek]);
  const sheetOf = (monday: string) => sheets?.find((w) => w.weekStart === monday) ?? null;
  const sheet = sheetOf(weekStart);
  const locked = approvals && (sheet?.status === "submitted" || sheet?.status === "approved");
  const replaceSheet = (next: Sheet | null) => setSheets((all) => [...(all ?? []).filter((w) => w.weekStart !== weekStart), ...(next ? [next] : [])]);
  const lastSheet = sheetOf(lastWeek);
  const remind = approvals && sheets !== null && weekStart !== lastWeek && (!lastSheet || lastSheet.status === "rejected");

  const now = useNow(entries?.some((e) => e.startedAt) ?? false);
  const step = mode === "day" ? 1 : 7;
  const title =
    mode === "day"
      ? formatDay(date, { weekday: "long", day: "numeric", month: "long" })
      : weekRange(weekStart);
  const isCurrent = mode === "day" ? date === today : days.includes(today);
  useAnnounceWhen(entries !== null && projects !== null, mode === "day" ? "Day loaded." : "Week loaded.");

  return (
    <>
      <PageHeader
        eyebrow={mode === "day" ? "Time" : "Timesheet"}
        title={title}
        help="time-tracking/track-time"
        docTitle={`${mode === "day" ? "Time" : "Timesheet"}: ${title}`}
        intro={
          // Time off sits beside your time rather than in the sidebar, which has to fit small screens.
          <>
            {isCurrent ? `${mode === "day" ? "Today" : "This week"} · ` : ""}
            <Link to="/time-off" className="wl-link">Time off</Link>
            {" · "}
            <Link to={`/time/calendar/${weekStart}`} className="wl-link">Import from calendar</Link>
          </>
        }
      >
        <PeriodStepper unit={mode} current={isCurrent} onStep={(by) => navigate(`/time/${mode}/${addDays(date, step * by)}`)} onCurrent={() => navigate(`/time/${mode}/${today}`)} />
        <SegmentedControl.Root aria-label="View" size="2" value={mode} onValueChange={(m) => navigate(`/time/${m}/${date}`)}>
          <SegmentedControl.Item value="day">Day</SegmentedControl.Item>
          <SegmentedControl.Item value="week">Week</SegmentedControl.Item>
        </SegmentedControl.Root>
        {approvals && sheets !== null && <WeekStatus weekStart={weekStart} sheet={sheet} onChange={replaceSheet} noTime={entries !== null && sum(entries, Date.now()) === 0} />}
      </PageHeader>
      {admin && <DonationCard />}

      <ErrorNote message={error} />
      {remind && (
        <Notice>
          Last week ({weekRange(lastWeek)}) isn't submitted yet.{" "}
          <Link to={`/time/week/${lastWeek}`} className="wl-link">Go to last week</Link>{" "}
          <ArticleLink article="time-tracking/submit-your-timesheet">About submitting</ArticleLink>
        </Notice>
      )}
      {approvals && sheet?.status === "rejected" && (
        <Notice color="red" title={`Sent back by ${sheet.decidedByName ?? "a manager"}.`}>
          {sheet.note}
        </Notice>
      )}
      {locked && (
        <Notice color="gray">
          {sheet?.status === "approved" ? "This week is approved. Ask a manager to reopen it to make changes." : "This week is submitted. Withdraw it to make changes."}
        </Notice>
      )}
      {entries !== null && <WeekPlan weekStart={weekStart} entries={entries} now={now} />}
      {entries === null || projects === null ? (
        <Loading />
      ) : mode === "day" ? (
        <DayView date={date} days={days} today={today} entries={entries} projects={projects} tasks={tasks} now={now} canManage={canManage} locked={locked} />
      ) : (
        <WeekView key={weekStart} days={days} today={today} entries={entries} projects={projects} now={now} locked={locked} capacity={capacity} />
      )}
    </>
  );
}

type PlanRow = { projectId: string; project: string; seconds: number };

/**
 * "Planned for you this week" (WRK-139): the hours a manager planned for you on the Schedule, with
 * what you've tracked on each project so far. Shown only when there is a plan for the week.
 */
function WeekPlan({ weekStart, entries, now }: { weekStart: string; entries: TimeEntry[]; now: number }) {
  const [rows, setRows] = useState<PlanRow[]>([]);
  useEffect(() => {
    let current = true;
    setRows([]);
    api<{ rows: PlanRow[] }>(`/api/schedule/me?week=${weekStart}`)
      .then((r) => current && setRows(r.rows))
      .catch(() => {}); // The plan is extra: the timesheet works without it.
    return () => {
      current = false;
    };
  }, [weekStart]);
  if (!rows.length) return null;
  const tracked = (projectId: string) => sum(entries.filter((e) => e.project.id === projectId), now);
  const planned = rows.reduce((s, r) => s + r.seconds, 0);
  const trackedTotal = rows.reduce((s, r) => s + tracked(r.projectId), 0);
  const isThisWeek = weekStart === startOfWeek(localToday());
  return (
    <section aria-labelledby="plan-title" className="wl-plan">
      <Flex justify="between" align="baseline" gap="2" wrap="wrap">
        <Heading as="h2" id="plan-title" size="3">{isThisWeek ? "Planned for you this week" : "Planned for you that week"}</Heading>
        <Text size="2" color="gray" className="wl-num">{formatDuration(trackedTotal)} tracked of {formatDuration(planned)} planned</Text>
      </Flex>
      <div className="wl-plan-rows">
        {rows.map((r) => (
          <div key={r.projectId} className="wl-plan-row">
            <Text size="2">{r.project}</Text>
            <Text size="2" color="gray" className="wl-num">{formatDuration(tracked(r.projectId))} tracked</Text>
            <Text size="2" weight="medium" className="wl-num">{formatDuration(r.seconds)} planned</Text>
          </div>
        ))}
      </div>
      <Text as="p" size="1" color="gray">Your manager plans these hours on the Schedule. You can track more or fewer hours than planned.</Text>
    </section>
  );
}

type Sheet = { weekStart: string; status: "submitted" | "approved" | "rejected"; decidedByName: string | null; note: string };

// Submit, withdraw and the week's decision, in the page header (only while approvals are on).
function WeekStatus({ weekStart, sheet, onChange, noTime }: { weekStart: string; sheet: Sheet | null; onChange: (sheet: Sheet | null) => void; noTime: boolean }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useTimer();

  async function act(action: "submit" | "withdraw") {
    if (busy) return;
    // The server allows it; the person is asked once, in case it is a slip.
    if (action === "submit" && noTime && !(await confirm({ title: "Submit a week with no time?", description: "Do this only if you didn't work that week.", confirm: "Submit", danger: false }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ week?: Sheet }>(`/api/timesheets/mine/${weekStart}/${action}`, {});
      onChange(action === "submit" ? r.week ?? null : null);
      await timer.changed();
      announce(action === "submit" ? "Week submitted." : "Week withdrawn.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = sheet?.status ?? "open";
  // In the page header: the week's state and its one next step. A sent-back week's note is shown under the header.
  return (
    <Flex direction="column" gap="1" align="end">
      <Flex align="center" gap="3" wrap="wrap">
        {(status === "open" || status === "rejected") && (
          <ActionButton size="2" busy={busy} busyLabel="Submitting…" onClick={() => void act("submit")}>
            {status === "rejected" ? "Submit again" : "Submit week"}
          </ActionButton>
        )}
        {status === "submitted" && (
          <>
            <Badge color="amber" variant="soft" size="2">Submitted</Badge>
            <RowButton onClick={() => void act("withdraw")} busy={busy}>Withdraw</RowButton>
          </>
        )}
        {status === "approved" && (
          <>
            <Badge color="green" variant="soft" size="2">Approved</Badge>
            {sheet?.decidedByName && <Text size="2" color="gray">by {sheet.decidedByName}</Text>}
          </>
        )}
      </Flex>
      <InlineError message={error} />
    </Flex>
  );
}

function DayView({ date, days, today, entries, projects, tasks, now, canManage, locked }: {
  date: string; days: string[]; today: string; entries: TimeEntry[]; projects: Project[]; tasks: Task[]; now: number; canManage: boolean; locked: boolean;
}) {
  const timer = useTimer();
  const active = projects.filter((p) => !p.archived);
  const dayEntries = entries.filter((e) => e.date === date);

  return (
    <>
      <div className="wl-weekstrip-frame">
        <nav aria-label="Days of this week" className="wl-weekstrip">
          {days.map((d) => (
            <Link key={d} to={`/time/day/${d}`} aria-current={d === date ? "date" : undefined}>
              <span className={`wl-weekstrip-day ${d === today ? "wl-weekstrip-today" : ""}`}>
                <span aria-hidden>{formatDay(d, { weekday: "short" })}</span>
                <SrOnly>{formatDay(d, { weekday: "long", day: "numeric", month: "long" })}, </SrOnly>
              </span>
              <span className="wl-num">{formatDuration(sum(entries.filter((e) => e.date === d), now))}</span>
            </Link>
          ))}
          <div className="wl-weekstrip-week">
            <span className="wl-weekstrip-day">Week</span>
            <span className="wl-num" style={{ fontWeight: 600 }}>{formatDuration(sum(entries, now))}</span>
          </div>
        </nav>
      </div>

      {timer.running && <RunningCard entry={timer.running} />}

      {locked ? null : active.length === 0 ? (
        <div>
          <Flex direction="column" align="start" gap="2">
            <Text weight="medium">No projects to track time on yet.</Text>
            {canManage ? (
              <ActionButton asChild>
                <Link to="/projects">Add a project</Link>
              </ActionButton>
            ) : (
              <Text color="gray">Ask an admin or manager to add a project.</Text>
            )}
          </Flex>
        </div>
      ) : (
        <NewEntry date={date} projects={active} tasks={tasks} lastProjectId={entries.at(-1)?.project.id} />
      )}

      {sum(dayEntries, now) > MAX_ENTRY_SECONDS && (
        <Notice>This day adds up to more than 24 hours. Check for a time typed in the wrong unit.</Notice>
      )}

      <Card>
        {dayEntries.length === 0 ? (
          <Text as="p" color="gray" align="center" style={{ padding: "var(--space-6) var(--space-4)" }}>No time on this day yet.</Text>
        ) : (
          <ul className="wl-rows">
            {dayEntries.map((e) => (
              <EntryRow key={e.id} entry={e} now={now} today={today} projects={active} tasks={tasks} locked={locked} canManage={canManage} />
            ))}
          </ul>
        )}
        <p className="wl-row-total">
          <Text weight="medium">Total</Text>
          <span className="wl-total wl-num">{formatDuration(sum(dayEntries, now))}</span>
        </p>
      </Card>
    </>
  );
}

// The timer that is running now, large, with the one Stop button for it.
function RunningCard({ entry }: { entry: TimeEntry }) {
  const timer = useTimer();
  const now = useNow(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await timer.stop();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="wl-running" role="group" aria-label="Timer in progress">
      <div style={{ minWidth: 0 }}>
        <Text as="p" size="1" weight="medium" color="gray" className="wl-eyebrow">
          <span className="wl-pulse" aria-hidden /> Running now
        </Text>
        <Text as="p" size="4" weight="medium" mt="1">
          {entry.project.name}
          {entry.project.client && <Text color="gray" weight="regular"> · {entry.project.client.name}</Text>}
        </Text>
        {entry.task && <Text as="p" size="2">{entry.task.title}</Text>}
        {entry.notes && <Text as="p" size="2" color="gray">{entry.notes}</Text>}
        <InlineError message={error} />
      </div>
      <Flex align="center" gap="5">
        <Clock time={formatDuration(elapsed(entry, now), true)} />
        <ActionButton onClick={() => void stop()} busy={busy}>Stop timer</ActionButton>
      </Flex>
    </div>
  );
}

// The task list appears when the chosen project has open tasks (or the entry already has one); the link to edit them is always there.
function TaskPicker({ tasks, projectId, value, onChange, current }: {
  tasks: Task[]; projectId: string; value: string; onChange: (id: string) => void; current?: { id: string; title: string } | null;
}) {
  const choices: { id: string; title: string }[] = tasks.filter((t) => t.projectId === projectId);
  if (current && !choices.some((t) => t.id === current.id)) choices.push(current);
  if (!projectId) return null;
  return (
    <Flex direction="column" align="start" gap="1" className="wl-task-picker">
      {choices.length > 0 && (
        <Select
          label="Task"
          value={value}
          onChange={onChange}
          groups={[{ choices: [{ value: "", label: "No task" }, ...choices.map((t) => ({ value: t.id, label: t.title }))] }]}
        />
      )}
      <Text size="1">
        {/* A new tab, so an entry being typed here isn't lost. */}
        <a href={`/projects/${projectId}/tasks`} target="_blank" rel="noopener" className="wl-link wl-link-alone">
          Edit this project's tasks<SrOnly> (opens in a new tab)</SrOnly>
        </a>
      </Text>
    </Flex>
  );
}

// Leave the duration empty to start a timer, or type one to save a finished entry.
function NewEntry({ date, projects, tasks, lastProjectId }: { date: string; projects: Project[]; tasks: Task[]; lastProjectId?: string }) {
  const timer = useTimer();
  const fields = useCustomFields("time");
  const [values, setValues] = useState<FieldValues>({});
  const [projectId, setProjectId] = useState(() => projects.find((p) => p.id === lastProjectId)?.id ?? projects[0]!.id);
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState("");
  const [billable, setBillable] = useState(() => projects.find((p) => p.id === projectId)?.billable ?? true);
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seconds = parseTypedDuration(duration);
  const errorId = useId();

  function chooseProject(id: string) {
    setProjectId(id);
    setTaskId("");
    setBillable(projects.find((p) => p.id === id)?.billable ?? true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (Number.isNaN(seconds)) return setError(DURATION_HELP);
    if (seconds === 0) return setError(ZERO_DURATION);
    setBusy(true);
    setError(null);
    try {
      const projectName = projects.find((p) => p.id === projectId)?.name ?? "the project";
      if (seconds === null) {
        await timer.start({ projectId, taskId: taskId || null, date, notes, billable, customFields: values });
        announce(`Timer started for ${projectName}.`);
      } else {
        await api("/api/time-entries", { projectId, taskId: taskId || null, date, seconds, notes, billable, customFields: values });
        await timer.changed();
        announce(`Saved ${formatDuration(seconds)} for ${projectName}.`);
      }
      setNotes("");
      setDuration("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hintId = useId();
  const durationError = error === DURATION_HELP || error === ZERO_DURATION;
  return (
    <form onSubmit={submit} className="wl-entry-form">
      <div style={{ gridArea: "project" }}>
        <Select label="Project" value={projectId} onChange={chooseProject} groups={projectGroups(projects)} />
      </div>
      <div style={{ gridArea: "notes" }}>
        <TextInput label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="What are you working on?" />
      </div>
      <div style={{ gridArea: "duration" }}>
        <TextInput
          label="Duration"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onBlur={() => setDuration(readable(duration))}
          placeholder="0:00"
          inputMode="decimal"
          invalid={durationError}
          errorId={durationError ? `${hintId} ${errorId}` : hintId}
          className="wl-num"
        />
      </div>
      <Text as="p" id={hintId} size="1" color="gray" className="wl-entry-hint">Leave empty to start a timer. {DURATION_FORMATS}</Text>
      <ActionButton type="submit" busy={busy} style={{ gridArea: "submit" }}>
        {seconds === null ? "Start timer" : "Save entry"}
      </ActionButton>
      <Flex wrap="wrap" align="start" gap="5" style={{ gridArea: "extras" }}>
        <TaskPicker tasks={tasks} projectId={projectId} value={taskId} onChange={setTaskId} />
        <div className={hasTaskChoices(tasks, projectId) ? "wl-check-aligned" : undefined}>
          <CheckField label="Billable" checked={billable} onChange={setBillable} />
        </div>
      </Flex>
      {fields.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <CustomFieldInputs fields={fields} values={values} onChange={setValues} />
        </div>
      )}
      {error && <Text as="p" id={errorId} role="alert" size="2" color="red" style={{ gridColumn: "1 / -1" }}>{error}</Text>}
    </form>
  );
}

// An entry's notes, cut after four lines with a button to read the rest (and to fold it up again).
function ClampedNotes({ text }: { text: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => {
      // While open the box isn't cut, so the answer from when it was closed stands.
      if (!open) setLong(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [text, open]);
  return (
    <>
      <Text ref={box} as="p" size="2" color="gray" className={open ? "wl-notes" : "wl-notes wl-notes-clamped"}>{text}</Text>
      {(long || open) && (
        <RowButton
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            announce(open ? "Showing fewer lines." : "Showing all of the notes.");
          }}
        >
          {open ? "Show less" : "Show all"}
        </RowButton>
      )}
    </>
  );
}

function EntryRow({ entry, now, today, projects, tasks, locked, canManage }: { entry: TimeEntry; now: number; today: string; projects: Project[]; tasks: Task[]; locked: boolean; canManage: boolean }) {
  const timer = useTimer();
  const editor = useEditor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = entry.startedAt !== null;
  const name = [entry.project.name, entry.task?.title, entry.notes && brief(entry.notes)].filter(Boolean).join(", ");
  // Timers restart only on today's entries, like a paper timesheet.
  const canRestart = !locked && !running && entry.date === today && !entry.project.archived && !entry.invoice;

  async function restart() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await timer.start({ entryId: entry.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editor.editing) return <EntryEditor entry={entry} now={now} projects={projects} tasks={tasks} onClose={editor.close} />;
  return (
    <li className="wl-row wl-row-top" data-running={running}>
      <div className="wl-row-main">
        <Text as="p" size="2">
          <Text weight="medium">{entry.project.name}</Text>
          {entry.project.client && <Text color="gray"> · {entry.project.client.name}</Text>}
          {!entry.billable && <> <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">Non-billable</Badge></>}
        </Text>
        {entry.task && <Text as="p" size="2">{entry.task.title}</Text>}
        {entry.notes && <ClampedNotes text={entry.notes} />}
        <InlineError message={error} />
      </div>
      <div className="wl-row-time">
        {running && <Badge color="green" variant="soft" size="1">Running</Badge>}
        <Text size="2" weight="medium" className="wl-num">{running ? formatDuration(elapsed(entry, now), true) : formatEntryDuration(elapsed(entry, now))}</Text>
      </div>
      <div className="wl-row-actions">
        {canRestart && (
          <RowButton onClick={() => void restart()} busy={busy}>
            Start<SrOnly> {name}</SrOnly>
          </RowButton>
        )}
        {locked ? null : entry.invoice ? (
          <Text size="1" color="gray" title="Invoiced time can't be changed">
            {/* Members never see invoices, so they are not told which one. */}
            {canManage ? `Invoice ${entry.invoice.number}` : "Invoiced"}<SrOnly>. Invoiced time can't be changed.</SrOnly>
          </Text>
        ) : (
          <RowButton ref={editor.openerRef} onClick={editor.open}>
            Edit<SrOnly> {name}</SrOnly>
          </RowButton>
        )}
      </div>
    </li>
  );
}

function EntryEditor({ entry, now, projects, tasks, onClose }: { entry: TimeEntry; now: number; projects: Project[]; tasks: Task[]; onClose: (returnFocus?: boolean) => void }) {
  const timer = useTimer();
  const confirm = useConfirm();
  const [initialDuration] = useState(() => formatDuration(elapsed(entry, now)));
  const [projectId, setProjectId] = useState(entry.project.id);
  const [notes, setNotes] = useState(entry.notes);
  const [date, setDate] = useState(entry.date);
  const [duration, setDuration] = useState(initialDuration);
  const [billable, setBillable] = useState(entry.billable);
  const [taskId, setTaskId] = useState(entry.task?.id ?? "");
  const fields = useCustomFields("time");
  const [values, setValues] = useState<FieldValues>(entry.customFields ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const changedFields = changedValues(fields, values, entry.customFields ?? {});
  const dirty =
    projectId !== entry.project.id || taskId !== (entry.task?.id ?? "") || notes !== entry.notes || date !== entry.date || billable !== entry.billable || duration.trim() !== initialDuration ||
    Object.keys(changedFields).length > 0;

  // An entry on an archived project keeps it as a choice.
  const choices = projects.some((p) => p.id === entry.project.id)
    ? projects
    : [...projects, { ...entry.project, billable: entry.billable, client: entry.project.client && { ...entry.project.client, archived: false } }];

  function chooseProject(id: string) {
    setProjectId(id);
    setTaskId("");
    setBillable(choices.find((p) => p.id === id)?.billable ?? billable);
  }

  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await timer.changed();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    if (projectId !== entry.project.id) body.projectId = projectId;
    if (taskId !== (entry.task?.id ?? "") || projectId !== entry.project.id) body.taskId = taskId || null;
    if (notes !== entry.notes) body.notes = notes;
    if (date !== entry.date) body.date = date;
    if (billable !== entry.billable) body.billable = billable;
    if (Object.keys(changedFields).length) body.customFields = changedFields;
    if (duration !== initialDuration) {
      const seconds = parseTypedDuration(duration);
      if (seconds === null || Number.isNaN(seconds)) return setError(DURATION_HELP);
      if (seconds === 0) return setError(ZERO_DURATION);
      body.seconds = seconds;
    }
    if (Object.keys(body).length === 0) return onClose();
    void run(() => api(`/api/time-entries/${entry.id}`, body, "PATCH"));
  }

  async function remove() {
    if (!(await confirm({ title: "Delete this entry?", description: "This can't be undone.", confirm: "Delete" }))) return;
    void run(() => api(`/api/time-entries/${entry.id}`, undefined, "DELETE"));
  }

  return (
    <li className="wl-row wl-editor">
      <form onSubmit={save} style={{ width: "100%", display: "grid", gap: "var(--space-4)" }}>
        <div className="wl-editor-top">
          <Select label="Project" autoFocus value={projectId} onChange={chooseProject} groups={projectGroups(choices)} />
          <TextInput label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </div>
        <Flex wrap="wrap" align="start" gap="3">
          <TextInput label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <TextInput
            label="Duration"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={() => setDuration(readable(duration))}
            inputMode="decimal"
            invalid={error === DURATION_HELP || error === ZERO_DURATION}
            errorId={error === DURATION_HELP || error === ZERO_DURATION ? errorId : undefined}
            className="wl-num"
            style={{ width: "6.5rem" }}
          />
          <TaskPicker tasks={tasks} projectId={projectId} value={taskId} onChange={setTaskId} current={projectId === entry.project.id ? entry.task : null} />
          <div className="wl-check-aligned">
            <CheckField label="Billable" checked={billable} onChange={setBillable} />
          </div>
        </Flex>
        <Text as="p" size="1" color="gray" style={{ marginTop: "calc(var(--space-3) * -1)" }}>{DURATION_FORMATS}</Text>
        <CustomFieldInputs fields={fields} values={values} onChange={setValues} />
        {entry.startedAt && <Text as="p" size="1" color="gray">The timer keeps running from the duration you save.</Text>}
        <InlineError message={error} id={errorId} />
        <Flex align="center" gap="3">
          <RowButton type="button" danger onClick={() => void remove()} busy={busy}>Delete<SrOnly> this entry</SrOnly></RowButton>
          <Flex align="center" gap="3" ml="auto">
            <RowButton type="button" onClick={() => onClose()}>Cancel</RowButton>
            <SaveButton state={{ dirty, busy }}>Save</SaveButton>
          </Flex>
        </Flex>
      </form>
    </li>
  );
}

// Same order as the Projects page: by client, projects without one last.
type RowProject = TimeEntry["project"];
const byClientThenProject = (a: { project: RowProject }, b: { project: RowProject }) =>
  Number(!a.project.client) - Number(!b.project.client) ||
  (a.project.client?.name ?? "").localeCompare(b.project.client?.name ?? "") ||
  a.project.name.localeCompare(b.project.name);

// The week as a timesheet: one row per project, a box per day. Type a duration
// into a box to add or change time. Boxes holding several entries or a running
// timer are added up here and edited in the day view.
// Under a row's project: its client, and "Non-billable" when none of the week's time on it is billable.
function RowMeta({ client, entries }: { client?: string; entries: TimeEntry[] }) {
  const nonBillable = entries.length > 0 && entries.every((e) => !e.billable);
  if (!client && !nonBillable) return null;
  return <span className="wl-week-meta">{[client, nonBillable && "Non-billable"].filter(Boolean).join(" · ")}</span>;
}

function WeekView({ days, today, entries, projects, now, locked, capacity }: {
  days: string[]; today: string; entries: TimeEntry[]; projects: Project[]; now: number; locked: boolean; capacity: number;
}) {
  // Projects added as rows this week that have no time yet.
  const [added, setAdded] = useState<string[]>([]);
  const [choice, setChoice] = useState("");
  const [cellError, setCellError] = useState<string | null>(null);

  // On a phone the grid scrolls sideways; fade its right edge while more days are hidden.
  const scroller = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, []);

  const rows = new Map<string, { project: RowProject; cells: TimeEntry[][] }>();
  const addRow = (project: RowProject) => {
    if (!rows.has(project.id)) rows.set(project.id, { project, cells: days.map(() => []) });
    return rows.get(project.id)!;
  };
  for (const e of entries) addRow(e.project).cells[days.indexOf(e.date)]?.push(e);
  for (const id of added) {
    const p = projects.find((p) => p.id === id);
    if (p) addRow({ id: p.id, name: p.name, archived: p.archived, client: p.client && { id: p.client.id, name: p.client.name } });
  }
  const addable = locked ? [] : projects.filter((p) => !p.archived && !rows.has(p.id));
  // Last week's projects as empty rows, so a regular week starts with its usual rows (no hours).
  const [copying, setCopying] = useState(false);
  async function copyLastWeek() {
    if (copying) return;
    setCopying(true);
    try {
      const { entries: last } = await api<{ entries: TimeEntry[] }>(`/api/time-entries?from=${addDays(days[0]!, -7)}&to=${addDays(days[0]!, -1)}`);
      const open = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
      const ids = [...new Set(last.map((e) => e.project.id))].filter((id) => open.has(id) && !rows.has(id));
      setAdded((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
      announce(ids.length ? `Added ${ids.length === 1 ? "1 row" : `${ids.length} rows`} from last week.` : "Nothing new to copy from last week.");
    } catch (e) {
      setCellError((e as Error).message);
    }
    setCopying(false);
  }

  const dayTotals = days.map((d) => sum(entries.filter((e) => e.date === d), now));
  const total = sum(entries, now);
  const billable = sum(entries.filter((e) => e.billable), now);

  return (
    <>
      <Stats band>
        <Stat label="Total" value={formatDuration(total)}>
          {capacity > 0 && (
            <>
              <ProgressBar value={total} max={capacity} label="Hours this week of the hours expected" />
              <Text as="p" size="2" color="gray">of {formatDuration(capacity)} expected</Text>
            </>
          )}
        </Stat>
        <Stat label="Billable" value={formatDuration(billable)}>
          <Text as="p" size="2" color="gray">{total > 0 ? `${Math.round((billable / total) * 100)}% of the week` : "No time yet"}</Text>
        </Stat>
        <Stat label="Non-billable" value={formatDuration(total - billable)}>
          <Text as="p" size="2" color="gray">Internal work, and time not billed</Text>
        </Stat>
      </Stats>
      <div style={{ position: "relative" }}>
        <div>
          <div ref={scroller} role="region" aria-label="Week timesheet" tabIndex={0} className="wl-scroller">
            <table className="wl-grid">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  {days.map((d) => (
                    <th key={d} scope="col" data-today={d === today}>
                      <Link to={`/time/day/${d}`} aria-current={d === today ? "date" : undefined}>
                        <span className="wl-day-name" aria-hidden>{formatDay(d, { weekday: "short" })}</span>
                        <span className="wl-day-num" aria-hidden>{formatDay(d, { day: "numeric" })}</span>
                        <SrOnly>{formatDay(d, { weekday: "long", day: "numeric", month: "long" })}</SrOnly>
                      </Link>
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.size === 0 && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: "center", padding: "var(--space-6) var(--space-4)", color: "var(--wl-muted)" }}>
                      No time this week. Add a project row below to fill in your week.
                    </td>
                  </tr>
                )}
                {[...rows.values()].sort(byClientThenProject).map(({ project, cells }) => (
                  <tr key={project.id}>
                    <th scope="row">
                      <span className="wl-week-project">{project.name}</span>
                      <RowMeta client={project.client?.name} entries={cells.flat()} />
                    </th>
                    {cells.map((cell, i) => (
                      <td key={days[i]} data-today={days[i] === today}>
                        <WeekCell entries={cell} project={project} date={days[i]!} now={now} locked={locked} onError={setCellError} />
                      </td>
                    ))}
                    <td className="wl-num wl-week-total">{formatDuration(sum(cells.flat(), now))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  {dayTotals.map((s, i) => (
                    <td key={days[i]} className="wl-num" data-today={days[i] === today}>{s ? formatDuration(s) : <span className="wl-zero">0:00</span>}</td>
                  ))}
                  <td className="wl-num"><span className="wl-total">{formatDuration(total)}</span></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        {moreRight && <div aria-hidden className="wl-scroll-fade" />}
      </div>
      <Text as="p" size="1" color="gray" className="wl-scroll-hint" style={{ visibility: moreRight ? "visible" : "hidden" }} aria-hidden={!moreRight}>Swipe for more days</Text>
      <Text as="p" size="1" color="gray">Days with more than one entry open in the day view.</Text>
      <InlineError message={cellError} id="week-error" />

      <Flex wrap="wrap" align="center" justify="between" gap="3">
        {addable.length > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (choice) {
                setAdded((ids) => [...ids, choice]);
                announce("Row added.");
              }
              setChoice("");
            }}
          >
            <Flex wrap="wrap" align="center" gap="2">
              <Select
                aria-label="Project to add as a row"
                size="2"
                value={choice}
                onChange={setChoice}
                placeholder="Choose a project…"
                groups={projectGroups(addable)}
              />
              <ActionButton type="submit" variant="soft" color="gray" size="2" disabled={!choice}>Add row</ActionButton>
              <RowButton type="button" onClick={() => void copyLastWeek()} busy={copying}>Copy last week's rows</RowButton>
            </Flex>
          </form>
        ) : null}
      </Flex>
    </>
  );
}

// One project's time on one day. Saves when you leave the box or press Enter
// (focus stays in the box); Escape puts the old value back. Clearing a box
// removes its entry.
function WeekCell({ entries, project, date, now, locked, onError }: {
  entries: TimeEntry[]; project: RowProject; date: string; now: number; locked: boolean; onError: (message: string | null) => void;
}) {
  const timer = useTimer();
  const total = sum(entries, now);
  const single = entries.length === 1 && !entries[0]!.startedAt && !entries[0]!.invoice ? entries[0]! : null;
  const editable = !locked && (entries.length === 0 ? !project.archived : single !== null);
  // Nothing tracked shows an empty box, whether it never had time or was typed back to 0.
  const shown = total > 0 ? formatDuration(total) : "";
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [error, setErrorHere] = useState<string | null>(null);
  const setError = (message: string | null) => {
    setErrorHere(message);
    onError(message);
  };
  // What was last sent, until the box shows the saved time. Pressing Enter and then
  // leaving the box sends it once.
  const sent = useRef<string | null>(null);
  const dayName = formatDay(date, { weekday: "long", day: "numeric", month: "long" });

  // Show fresh totals whenever the box isn't being typed in, or holds what was just saved.
  useEffect(() => {
    if (!editing || sent.current === text.trim()) {
      setText(shown);
      sent.current = null;
    }
    // Only a new total or leaving the box should reset it, not each keystroke.
  }, [shown, editing]);

  // An empty day reads "No time" to a screen reader, not "dash".
  const none = (
    <>
      <span aria-hidden>–</span>
      <SrOnly>No time</SrOnly>
    </>
  );
  if (!editable && locked) return <span className="wl-num wl-cell-link">{shown || none}</span>;
  if (!editable) {
    const several = entries.length > 1;
    const why = entries.some((e) => e.invoice) ? "Invoiced time can't be changed." : entries.some((e) => e.startedAt) ? "A timer is running here." : "";
    const title = several
      ? `${entries.length} entries. Open the day to edit them.${why && ` ${why}`}`
      : entries.length ? `${why} Edit in the day view.` : "This project is archived.";
    return (
      <Link to={`/time/day/${date}`} title={title} className="wl-cell-link" data-several={several} data-running={entries.some((e) => e.startedAt) || undefined}>
        {several && (
          <>
            <span className="wl-sr-only">{entries.length} entries, </span>
            <span aria-hidden style={{ fontSize: "var(--font-size-1)" }}>×{entries.length}</span>
          </>
        )}
        {entries.some((e) => e.startedAt) && <span className="wl-pulse" aria-hidden />}
        {shown || none}
        {why && <span className="wl-sr-only">. {why}</span>}
      </Link>
    );
  }

  async function commit() {
    const value = text.trim();
    if (value === shown || value === sent.current) return;
    const seconds = parseTypedDuration(value);
    if (Number.isNaN(seconds)) return setError(DURATION_HELP);
    setError(null);
    // Nothing to change: the same time in other words ("1.5" for 1:30), or zero in an empty box.
    if (single ? seconds === single.seconds : !seconds) return setText(shown);
    sent.current = value;
    try {
      if (single) {
        // An emptied box (or a 0) removes the entry, unless it has notes worth keeping.
        if (!seconds && !single.notes) await api(`/api/time-entries/${single.id}`, undefined, "DELETE");
        else await api(`/api/time-entries/${single.id}`, { seconds: seconds ?? 0 }, "PATCH");
      } else {
        await api("/api/time-entries", { projectId: project.id, date, seconds });
      }
      await timer.changed();
      announce(seconds ? `Saved ${formatDuration(seconds)} for ${project.name}, ${dayName}.` : `Cleared ${project.name}, ${dayName}.`);
    } catch (e) {
      sent.current = null;
      setError((e as Error).message);
    }
  }

  return (
    <TextField.Root
      size="2"
      className="wl-cell"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        setEditing(true);
        e.target.select();
      }}
      onBlur={() => {
        setEditing(false);
        void commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        }
        if (e.key === "Escape") setText(shown);
      }}
      inputMode="decimal"
      aria-label={`${project.name}, ${dayName}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? "week-error" : undefined}
    />
  );
}
