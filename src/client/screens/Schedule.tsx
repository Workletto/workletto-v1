import { useEffect, useState } from "react";
import { Button, Flex, Heading, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen } from "../a11y.tsx";
import { api } from "../api.ts";
import { GroupFilter, useGroups } from "../groups.tsx";
import { navigate } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { PeriodStepper } from "../WeekNav.tsx";
import { ActionButton, CheckField, ErrorNote, InlineError, Loading, PageHeader, Select, SrOnly, Stat, Stats, TableRegion } from "../ui.tsx";
import { addDays, formatDuration, parseBudgetHours, startOfWeek } from "../../shared/time.ts";
import { TeamTabs } from "./Team.tsx";

// The Team page's Schedule (admins and managers, WRK-139): hours planned for each person, a week
// at a time, against the hours they have that week after time off and holidays. A cell opens a
// side panel to plan that person's week by project.

type PlanRow = { projectId: string; project: string; seconds: number };
type PersonWeek = { week: string; rows: PlanRow[]; planned: number; available: number; daysOff: number };
type SchedulePerson = { id: string; name: string; weeklyCapacity: number; weeks: PersonWeek[] };
type ScheduleData = {
  from: string;
  weeks: { week: string; holidays: { date: string; name: string }[] }[];
  projects: { id: string; name: string }[];
  people: SchedulePerson[];
};
type Draft = { projectId: string; project: string; hours: string };

const address = (week: string, thisWeek: string) => (week === thisWeek ? "/team/schedule" : `/team/schedule/${week}`);
const shortDay = (day: string) => formatDay(day, { month: "short", day: "numeric" });
const daysText = (days: number) => (days === 0.5 ? "½ day off" : `${days} ${days === 1 ? "day" : "days"} off`);
/** Hours as typed in the panel: whole hours plainly, the rest as h:mm. */
const hoursText = (seconds: number) => (seconds % 3600 === 0 ? String(seconds / 3600) : formatDuration(seconds));

type CellState = "over" | "full" | "off" | "empty" | "some";
const CELL_CLASS: Record<CellState, string> = { over: "wl-sched-over", full: "wl-sched-full", off: "wl-sched-off", empty: "wl-sched-empty", some: "wl-sched-some" };
function cellState(w: PersonWeek, weeklyCapacity: number): CellState {
  if (w.planned > w.available) return "over";
  if (w.planned === 0) return w.available === 0 && weeklyCapacity > 0 ? "off" : "empty";
  return w.planned >= w.available * 0.9 ? "full" : "some";
}

/** The line under a cell's hours: hours over, then a holiday, then days off. */
function cellNote(w: PersonWeek, holidays: { date: string }[]) {
  if (w.planned > w.available) return `${formatDuration(w.planned - w.available)} over`;
  if (holidays.length) return `Holiday ${shortDay(holidays[0]!.date)}`;
  if (w.daysOff > 0) return daysText(w.daysOff);
  return null;
}

export function Schedule({ from }: { from: string }) {
  const thisWeek = startOfWeek(localToday());
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ person: SchedulePerson; week: PersonWeek } | null>(null);
  const [reload, setReload] = useState(0);
  const { groups } = useGroups();
  const [groupId, setGroupId] = useState("");

  useEffect(() => {
    let current = true;
    setError(null);
    api<ScheduleData>(`/api/schedule?from=${from}${groupId ? `&groupId=${groupId}` : ""}`)
      .then((r) => current && setData(r))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [from, reload, groupId]);
  useEffect(() => setOpen(null), [from]);
  useAnnounceWhen(data !== null, "Schedule loaded.");

  const lastWeek = addDays(from, 7 * 5);
  const title = `${shortDay(from)} – ${formatDay(addDays(lastWeek, 6), { month: "short", day: "numeric" })}`;
  const showWeek = (w: string) => {
    navigate(address(w, thisWeek));
    announce(`Showing ${shortDay(w)} to ${shortDay(addDays(w, 41))}.`);
  };
  // The summary is for the first week shown.
  const first = (data?.people ?? []).map((p) => p.weeks[0]!).filter(Boolean);
  const over = first.filter((w) => w.planned > w.available).length;
  const firstLabel = from === thisWeek ? "This week" : `Week of ${shortDay(from)}`;

  return (
    <>
      <PageHeader eyebrow="Team" title={title} docTitle="Schedule" intro="Planned hours a week, against each person's capacity after time off and holidays." help="team-and-permissions/schedule">
        <PeriodStepper unit="week" current={from === thisWeek} onStep={(by) => showWeek(addDays(from, 7 * by))} onCurrent={() => showWeek(thisWeek)} />
      </PageHeader>
      <TeamTabs active="schedule" />
      <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
      <ErrorNote message={error} />
      {data === null || data.from !== from ? (
        !error && <Loading />
      ) : (
        <>
          <Stats band={false}>
            <Stat label={`${firstLabel}, scheduled`} value={`${formatDuration(first.reduce((s, w) => s + w.planned, 0))} of ${formatDuration(first.reduce((s, w) => s + w.available, 0))}`} />
            <Stat label="Over capacity" value={<Text color={over ? "red" : undefined}>{over === 1 ? "1 person" : `${over} people`}</Text>} />
            <Stat label={`Free ${from === thisWeek ? "this week" : "that week"}`} value={formatDuration(first.reduce((s, w) => s + Math.max(0, w.available - w.planned), 0))} />
          </Stats>
          <div className="wl-schedule">
            <div className="wl-schedule-grid">
              <TableRegion label="Schedule" minWidth="46rem">
                <table className="wl-schedule-table">
                  <caption>Each box: hours scheduled of the hours available that week.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      {data.weeks.map((w) => (
                        <th key={w.week} scope="col" aria-current={w.week === thisWeek ? "date" : undefined}>{shortDay(w.week)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.people.map((p) => (
                      <tr key={p.id}>
                        <th scope="row">
                          {p.name}
                          <Text as="span" size="1" color="gray">{formatDuration(p.weeklyCapacity)} a week</Text>
                        </th>
                        {p.weeks.map((w, i) => {
                          const state = cellState(w, p.weeklyCapacity);
                          const note = state === "off" ? null : cellNote(w, data.weeks[i]!.holidays);
                          const selected = open?.person.id === p.id && open.week.week === w.week;
                          return (
                            <td key={w.week}>
                              <button type="button" className={`wl-sched-cell ${CELL_CLASS[state]}`} aria-pressed={selected} onClick={() => setOpen({ person: p, week: w })}>
                                <SrOnly>{p.name}, week of {shortDay(w.week)}: </SrOnly>
                                {state === "off" ? (
                                  "Off all week"
                                ) : (
                                  <span className="wl-sched-hours-line">
                                    {w.planned ? <strong>{formatDuration(w.planned)}</strong> : "–"}
                                    <span className="wl-sched-of"> / {formatDuration(w.available)}</span>
                                  </span>
                                )}
                                {note && <span className={`wl-sched-note${state === "over" ? " wl-sched-note-over" : ""}`}>{note}</span>}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableRegion>
              <Flex gap="5" wrap="wrap" mt="3" className="wl-sched-legend">
                <Text size="1" color="gray"><span aria-hidden className="wl-sched-swatch wl-sched-full" /> Full</Text>
                <Text size="1" color="gray"><span aria-hidden className="wl-sched-swatch wl-sched-over" /> Over capacity</Text>
                <Text size="1" color="gray"><span aria-hidden className="wl-sched-swatch wl-sched-empty" /> Nothing scheduled</Text>
              </Flex>
            </div>
            {open && (
              <PlanPanel
                key={`${open.person.id}/${open.week.week}`}
                person={open.person}
                week={open.week}
                holidays={data.weeks.find((w) => w.week === open.week.week)?.holidays ?? []}
                projects={data.projects}
                onClose={() => setOpen(null)}
                onSaved={() => {
                  setOpen(null);
                  setReload((n) => n + 1);
                  announce("Schedule saved.");
                }}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

function PlanPanel({ person, week, holidays, projects, onClose, onSaved }: {
  person: SchedulePerson; week: PersonWeek; holidays: { date: string; name: string }[]; projects: { id: string; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [rows, setRows] = useState<Draft[]>(week.rows.map((r) => ({ projectId: r.projectId, project: r.project, hours: hoursText(r.seconds) })));
  const [adding, setAdding] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seconds = rows.map((r) => parseBudgetHours(r.hours) ?? 0);
  const total = seconds.reduce((s, x) => s + (Number.isNaN(x) ? 0 : x), 0);
  const label = `${person.name} · week of ${shortDay(week.week)}`;
  const offText = [
    ...holidays.map((h) => `${h.name} (${shortDay(h.date)})`),
    ...(week.daysOff > 0 ? [daysText(week.daysOff)] : []),
  ];
  const left = projects.filter((p) => !rows.some((r) => r.projectId === p.id));

  async function save() {
    if (seconds.some((s) => Number.isNaN(s))) return setError("Enter hours like 24 or 7:30.");
    setBusy(true);
    setError(null);
    try {
      await api(`/api/schedule/${person.id}/${week.week}`, { rows: rows.map((r, i) => ({ projectId: r.projectId, minutes: Math.round(seconds[i]! / 60) })), repeat }, "PUT");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <aside aria-label={label} className="wl-sched-panel">
      <Flex direction="column" gap="1">
        <Heading as="h2" size="4">{label}</Heading>
        <Text as="p" size="2" color={total > week.available ? "red" : "gray"} weight={total > week.available ? "medium" : undefined}>
          {total > week.available
            ? `${formatDuration(total)} scheduled, ${formatDuration(total - week.available)} more than the ${formatDuration(week.available)} available.`
            : `${formatDuration(total)} scheduled of ${formatDuration(week.available)} available.`}
        </Text>
      </Flex>
      <Flex direction="column" gap="2">
        {rows.map((r, i) => (
          <label key={r.projectId} className="wl-sched-row">
            <Text size="2">{r.project}</Text>
            <input
              className="wl-sched-hours"
              inputMode="decimal"
              value={r.hours}
              aria-label={`Hours on ${r.project}`}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)))}
            />
          </label>
        ))}
        {rows.length === 0 && <Text size="2" color="gray">Nothing planned this week.</Text>}
        {adding ? (
          <Select
            label="Add a project"
            placeholder="Choose a project"
            value=""
            autoFocus
            options={left.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(id) => {
              const p = projects.find((x) => x.id === id);
              if (p) setRows([...rows, { projectId: p.id, project: p.name, hours: "" }]);
              setAdding(false);
            }}
          />
        ) : (
          left.length > 0 && (
            <Button variant="ghost" size="2" className="wl-sched-add" onClick={() => setAdding(true)}>+ Add a project</Button>
          )
        )}
      </Flex>
      <Text as="p" size="1" color="gray" className="wl-sched-panel-foot">
        Hours a week: {formatDuration(person.weeklyCapacity)}. {offText.length ? `Off this week: ${offText.join(", ")}.` : "No time off this week."}
      </Text>
      <CheckField label="Repeat for the next 3 weeks" checked={repeat} onChange={setRepeat} />
      <InlineError message={error} />
      <Flex gap="2">
        <ActionButton busy={busy} busyLabel="Saving…" onClick={save}>Save</ActionButton>
        <Button variant="outline" color="gray" onClick={onClose} disabled={busy}>Cancel</Button>
      </Flex>
    </aside>
  );
}
