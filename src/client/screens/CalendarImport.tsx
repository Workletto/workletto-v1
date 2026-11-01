import { useEffect, useRef, useState, type FormEvent } from "react";
import { Checkbox, Flex, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, type Project, type Task } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { PeriodStepper, weekRange } from "../WeekNav.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { ActionButton, Card, Empty, ErrorNote, InlineError, Loading, PageHeader, projectGroups, Row, RowButton, RowMain, Rows, SectionTitle, Select, SettingsSection, TextInput } from "../ui.tsx";
import { addDays, formatDuration, startOfWeek } from "../../shared/time.ts";

type Choice = { projectId: string; taskId: string | null };
type CalendarEvent = { id: string; title: string; date: string; start: string; end: string; seconds: number; choice: Choice | null };
type Loaded = { events: CalendarEvent[]; skipped: { allDay: number; declined: number; imported: number } };
/** What the person picked for one event. */
type Pick = { on: boolean; projectId: string; taskId: string };

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Time → Import from calendar (WRK-105): a week of the person's own calendar events, from their
// private iCal address or an .ics file, ticked and given a project to become time entries.
export function CalendarImport({ week }: { week: string }) {
  const monday = startOfWeek(week);
  const [link, setLink] = useState<{ host: string } | null | undefined>(undefined);
  const [linksAllowed, setLinksAllowed] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // The uploaded file stays loaded while the person steps through weeks.
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<{ link: { host: string } | null; linksAllowed: boolean }>("/api/calendar").then((r) => { setLink(r.link); setLinksAllowed(r.linksAllowed); }).catch((e: Error) => setError(e.message));
    api<{ projects: Project[] }>("/api/projects").then((r) => setProjects(r.projects.filter((p) => !p.archived))).catch(() => undefined);
    api<{ tasks: Task[] }>("/api/tasks").then((r) => setTasks(r.tasks)).catch(() => undefined);
  }, []);

  async function load(source: { text: string } | null = file) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Loaded>("/api/calendar/events", { week: monday, timeZone: timeZone(), ...(source ? { ics: source.text } : {}) });
      setLoaded(result);
      setPicks(Object.fromEntries(result.events.map((e) => {
        const known = e.choice && projects.some((p) => p.id === e.choice!.projectId) ? e.choice : null;
        return [e.id, { on: known !== null, projectId: known?.projectId ?? "", taskId: known?.taskId ?? "" }];
      })));
      announce(`${result.events.length} ${result.events.length === 1 ? "event" : "events"} to import.`);
    } catch (e) {
      setLoaded(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A new week (or a new file, or the projects arriving) loads again once there is a source.
  useEffect(() => {
    setDone(null);
    if (file || link) void load();
    else setLoaded(null);
  }, [monday, file, link?.host, projects.length]);

  const ticked = loaded?.events.filter((e) => picks[e.id]?.on) ?? [];
  const missing = ticked.filter((e) => !picks[e.id]!.projectId);

  async function importTicked() {
    if (!ticked.length || missing.length) return;
    setBusy(true);
    setError(null);
    try {
      const entries = ticked.map((e) => ({ eventId: e.id, title: e.title, date: e.date, seconds: e.seconds, projectId: picks[e.id]!.projectId, taskId: picks[e.id]!.taskId || null }));
      const { added } = await api<{ added: number }>("/api/calendar/import", { entries });
      const text = `Imported ${added} ${added === 1 ? "event" : "events"} as time entries.`;
      setDone(text);
      announce(text);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (id: string, change: Partial<Pick>) => setPicks((p) => ({ ...p, [id]: { ...p[id]!, ...change } }));
  const skipped = loaded?.skipped;
  const left = skipped && [
    skipped.allDay && `${skipped.allDay} all-day`,
    skipped.declined && `${skipped.declined} declined`,
    skipped.imported && `${skipped.imported} already imported`,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        eyebrow="Time"
        title="Import from calendar"
        help="time-tracking/import-from-calendar"
        intro={<>Turn your calendar's events into time entries. <Link to={`/time/week/${monday}`} className="wl-link">Back to your timesheet</Link></>}
      >
        <PeriodStepper unit="week" current={monday === startOfWeek(localToday())} onStep={(by) => navigate(`/time/calendar/${addDays(monday, 7 * by)}`)} onCurrent={() => navigate(`/time/calendar/${startOfWeek(localToday())}`)} />
      </PageHeader>
      <ErrorNote message={error} />

      <Flex direction="column" gap="5">
        <SettingsSection title="Your calendar" description="Your own calendar's private address, or a file exported from it. Only you see your calendar here.">
          {link === undefined ? <Loading /> : <CalendarLink link={link} allowed={linksAllowed} onChange={(l) => { setLink(l); if (!l) setLoaded(null); }} />}
          <FileChooser file={file} onFile={(f) => setFile(f)} />
        </SettingsSection>

        <section aria-label="Events this week">
          <SectionTitle>{weekRange(monday)}</SectionTitle>
          {done && <Text as="p" size="2" role="status" mb="2">{done} <Link to={`/time/week/${monday}`} className="wl-link">See them on your timesheet</Link></Text>}
          {!file && !link ? (
            <Text as="p" size="2" color="gray">Add your calendar's address or choose a file to see this week's events.</Text>
          ) : loaded === null ? (
            busy ? <Loading /> : null
          ) : (
            <Flex direction="column" gap="3">
              {left && left.length > 0 && <Text as="p" size="2" color="gray">Left out: {left.join(", ")}.</Text>}
              <Card>
                {loaded.events.length === 0 ? (
                  <Empty>No events to import this week.</Empty>
                ) : (
                  <Rows>
                    {loaded.events.map((e) => (
                      <EventRow key={e.id} event={e} pick={picks[e.id]!} projects={projects} tasks={tasks} onChange={(change) => set(e.id, change)} />
                    ))}
                  </Rows>
                )}
              </Card>
              {loaded.events.length > 0 && (
                <Flex wrap="wrap" align="center" justify="end" gap="3">
                  {missing.length > 0 && <Text size="2" color="red">Choose a project for each ticked event.</Text>}
                  <ActionButton busy={busy} disabled={!ticked.length || missing.length > 0} onClick={() => void importTicked()}>
                    Import {ticked.length} {ticked.length === 1 ? "event" : "events"}
                  </ActionButton>
                </Flex>
              )}
            </Flex>
          )}
        </section>
      </Flex>
    </>
  );
}

function CalendarLink({ link, allowed, onChange }: { link: { host: string } | null; allowed: boolean; onChange: (link: { host: string } | null) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!allowed) return <Text as="p" size="2" color="gray">Calendar addresses aren't available in the demo. Upload an .ics file instead.</Text>;
  if (link) {
    return (
      <Flex wrap="wrap" align="center" gap="3">
        <Text size="2">Your calendar at <strong>{link.host}</strong> is connected. Each week loads from it when you open it here.</Text>
        <RowButton onClick={() => void api("/api/calendar/link", undefined, "DELETE").then(() => { onChange(null); announce("Calendar address removed."); }).catch((e: Error) => setError(e.message))}>Remove address</RowButton>
        <InlineError message={error} />
      </Flex>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ link: { host: string } }>("/api/calendar/link", { url }, "PUT");
      setUrl("");
      onChange(r.link);
      announce("Calendar address saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} aria-label="Calendar address">
      <Flex wrap="wrap" align="end" gap="3">
        <div style={{ flex: "1 1 20rem", maxWidth: "36rem" }}>
          <TextInput
            label="Private address in iCal format"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            hint="Google Calendar: Settings, your calendar, “Secret address in iCal format”. Outlook: Settings, Calendar, Shared calendars, Publish a calendar, the ICS link. It's kept encrypted."
          />
        </div>
        <ActionButton type="submit" busy={busy} disabled={!url.trim()}>Save address</ActionButton>
      </Flex>
      <InlineError message={error} />
    </form>
  );
}

function FileChooser({ file, onFile }: { file: { name: string } | null; onFile: (file: { name: string; text: string } | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Flex direction="column" gap="2">
      <Flex wrap="wrap" align="center" gap="3">
        <RowButton onClick={() => input.current?.click()}>{file ? "Choose another file" : "Upload an .ics file"}</RowButton>
        {file && (
          <>
            <Text size="2">Showing <strong>{file.name}</strong></Text>
            <RowButton onClick={() => onFile(null)}>Stop using the file</RowButton>
          </>
        )}
      </Flex>
      <input
        ref={input}
        type="file"
        accept=".ics,text/calendar"
        hidden
        tabIndex={-1}
        aria-label="Calendar file (.ics)"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          setError(null);
          if (!chosen) return;
          if (chosen.size > 5 * 1024 * 1024) return setError("Choose an .ics file of up to 5 MB.");
          void chosen.text().then((text) => onFile({ name: chosen.name, text }));
        }}
      />
      <InlineError message={error} />
    </Flex>
  );
}

function EventRow({ event, pick, projects, tasks, onChange }: { event: CalendarEvent; pick: Pick; projects: Project[]; tasks: Task[]; onChange: (change: Partial<Pick>) => void }) {
  const when = `${formatDay(event.date, { weekday: "short", day: "numeric", month: "short" })}, ${event.start}–${event.end}`;
  const projectTasks = tasks.filter((t) => t.projectId === pick.projectId);
  return (
    <Row>
      <RowMain>
        <Text as="label" size="2">
          <Flex gap="2" align="start">
            <Checkbox checked={pick.on} onCheckedChange={(v) => onChange({ on: v === true })} />
            <span>
              <Text weight="medium">{event.title}</Text>
              <Text as="span" size="1" color="gray" style={{ display: "block" }}>{when} · {formatDuration(event.seconds)}</Text>
            </span>
          </Flex>
        </Text>
        {pick.on && (
          <Flex wrap="wrap" gap="3" mt="2" pl="6">
            <div style={{ flex: "1 1 14rem", maxWidth: "20rem" }}>
              <Select aria-label={`Project for ${event.title}, ${when}`} placeholder="Choose a project" value={pick.projectId} onChange={(projectId) => onChange({ projectId, taskId: "" })} groups={projectGroups(projects)} />
            </div>
            {projectTasks.length > 0 && (
              <div style={{ flex: "1 1 12rem", maxWidth: "16rem" }}>
                <Select aria-label={`Task for ${event.title}, ${when}`} value={pick.taskId} onChange={(taskId) => onChange({ taskId })} options={[{ value: "", label: "No task" }, ...projectTasks.map((t) => ({ value: t.id, label: t.title }))]} />
              </div>
            )}
          </Flex>
        )}
      </RowMain>
    </Row>
  );
}
