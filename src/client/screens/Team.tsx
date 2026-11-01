import { useEffect, useMemo, useState } from "react";
import { GroupFilter, GroupsManager, useGroups } from "../groups.tsx";
import { Badge, Flex, Heading, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen } from "../a11y.tsx";
import { api } from "../api.ts";
import { Link, navigate } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { PeriodStepper, weekRange } from "../WeekNav.tsx";
import { Card, Empty, ErrorNote, Loading, NavTabs, PageHeader, Row, RowActions, RowLink, RowMain, Rows, SectionTitle, SrOnly, Stat, Stats, TextInput } from "../ui.tsx";
import { addDays, formatDuration, formatEntryDuration, startOfWeek } from "../../shared/time.ts";
import { ROLE_LABELS, isRole } from "../../shared/roles.ts";

type SheetStatus = "open" | "submitted" | "approved" | "rejected";
type Person = {
  id: string;
  name: string;
  role: string;
  active: boolean;
  weeklyCapacity: number;
  /** This week's capacity: the usual hours less time off and company holidays. */
  capacity: number;
  /** Weekdays off this week (time off and holidays); a half day is 0.5. */
  daysOff: number;
  seconds: number;
  billableSeconds: number;
  timesheet: SheetStatus | null;
};
type TeamWeekData = { week: string; approvals: boolean; people: Person[] };

const SHEET_LABELS: Record<SheetStatus, { label: string; color: "gray" | "amber" | "green" | "red" }> = {
  open: { label: "Not submitted", color: "gray" },
  submitted: { label: "Waiting for approval", color: "amber" },
  approved: { label: "Approved", color: "green" },
  rejected: { label: "Sent back", color: "red" },
};

/** Where a week's page is: this week has the short address. */
const teamAddress = (week: string, thisWeek: string) => (week === thisWeek ? "/team" : `/team/${week}`);

/** Hours the way Time and Reports write them: "35:00", "37:30". */
export const capacityText = (seconds: number) => formatDuration(seconds);

/** The share of the capacity worked, as a whole percent; null when there is no capacity to measure against. */
const utilization = (seconds: number, capacity: number) => (capacity > 0 ? Math.round((seconds / capacity) * 100) : null);

/**
 * Hours worked as parts of the hours someone usually works: billable in the accent color, the rest in gray.
 * Over capacity, the bar is full. The numbers are written beside it, so color is never the only signal.
 */
function CapacityBar({ seconds, billableSeconds, capacity }: { seconds: number; billableSeconds: number; capacity: number }) {
  const whole = Math.max(capacity, seconds);
  const share = (part: number) => (whole > 0 ? `${(part / whole) * 100}%` : "0%");
  return (
    <div
      role="img"
      aria-label={`${formatDuration(seconds)} of ${capacityText(capacity)} hours, ${formatDuration(billableSeconds)} billable`}
      className="wl-capbar"
    >
      <span className="wl-capbar-billable" style={{ width: share(billableSeconds) }} />
      <span className="wl-capbar-other" style={{ width: share(seconds - billableSeconds) }} />
    </div>
  );
}

/** The Team page's sections: hours worked, the schedule, and the Time off page. */
export function TeamTabs({ active }: { active: "hours" | "schedule" }) {
  return (
    <NavTabs
      label="Team sections"
      tabs={[
        { to: "/team", label: "Hours", active: active === "hours" },
        { to: "/team/schedule", label: "Schedule", active: active === "schedule" },
        { to: "/time-off", label: "Time off", active: false },
      ]}
    />
  );
}

// The Team page (admins and managers): for one week, each person's hours against the hours they usually work.
export function Team({ week, isAdmin }: { week: string; isAdmin: boolean }) {
  const thisWeek = startOfWeek(localToday());
  const [data, setData] = useState<TeamWeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const { groups, reload: reloadGroups } = useGroups();
  const [groupId, setGroupId] = useState("");

  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    api<TeamWeekData>(`/api/team?week=${week}${groupId ? `&groupId=${groupId}` : ""}`)
      .then((r) => current && setData(r))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [week, groupId]);
  useAnnounceWhen(data !== null, "Team loaded.");

  const totals = useMemo(() => {
    const people = data?.people ?? [];
    return {
      seconds: people.reduce((s, p) => s + p.seconds, 0),
      billable: people.reduce((s, p) => s + p.billableSeconds, 0),
      capacity: people.filter((p) => p.active).reduce((s, p) => s + p.capacity, 0),
    };
  }, [data]);
  const shown = (data?.people ?? []).filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const showWeek = (w: string) => {
    navigate(teamAddress(w, thisWeek));
    announce(`Showing ${weekRange(w)}.`);
  };

  return (
    <>
      <PageHeader
        title="Team"
        intro={`Hours against the usual hours, ${weekRange(week)}`}
        help="team-and-permissions/team-page"
      >
        <PeriodStepper
          unit="week"
          current={week === thisWeek}
          onStep={(by) => showWeek(addDays(week, 7 * by))}
          onCurrent={() => showWeek(thisWeek)}
        />
      </PageHeader>
      <TeamTabs active="hours" />
      <ErrorNote message={error} />
      {data === null ? (
        !error && <Loading />
      ) : (
        <>
          <Stats>
            <Stat large label="Total hours" value={formatDuration(totals.seconds)}>
              <CapacityBar seconds={totals.seconds} billableSeconds={totals.billable} capacity={totals.capacity} />
              <Text as="p" size="2" color="gray">of {capacityText(totals.capacity)} capacity</Text>
            </Stat>
            <Stat large label="Capacity" value={capacityText(totals.capacity)} />
            <Stat large label="Billable" value={formatDuration(totals.billable)}>
              <Text as="p" size="2" color="gray">
                {totals.seconds ? Math.round((totals.billable / totals.seconds) * 100) : 0}% of total
              </Text>
            </Stat>
          </Stats>

          <section>
            <SectionTitle>People</SectionTitle>
            <Flex wrap="wrap" align="end" gap="3" className="wl-filter">
              <TextInput label="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
            </Flex>
            <Card>
              {shown.length === 0 ? (
                <Empty>{data.people.length === 0 ? "No one on the team yet." : "No one matches that name."}</Empty>
              ) : (
                <Rows>
                  {shown.map((p) => {
                    const percent = utilization(p.seconds, p.capacity);
                    const sheet = p.timesheet ? SHEET_LABELS[p.timesheet] : null;
                    return (
                      <Row key={p.id} className={p.active ? "" : "wl-off"}>
                        <RowMain>
                          <Text as="p" size="2" weight="medium">
                            {p.name}{" "}
                            <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">{isRole(p.role) ? ROLE_LABELS[p.role] : p.role}</Badge>
                            {!p.active && <> <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">Turned off</Badge></>}
                          </Text>
                          {sheet && <Badge color={sheet.color} variant="soft" size="1" highContrast>{sheet.label}</Badge>}
                        </RowMain>
                        <div className="wl-team-figures">
                          <Flex justify="between" align="baseline" gap="3">
                            <Text size="4" className="wl-num">{formatDuration(p.seconds)}</Text>
                            <Text size="2" color="gray" className="wl-num">
                              Utilization <Text weight="medium" color="gray" highContrast>{percent === null ? "—" : `${percent}%`}</Text>
                            </Text>
                          </Flex>
                          <CapacityBar seconds={p.seconds} billableSeconds={p.billableSeconds} capacity={p.capacity} />
                          <Text as="p" size="1" color="gray" className="wl-num">
                            Capacity {capacityText(p.capacity)}
                            {p.daysOff > 0 && ` (${p.daysOff === 1 ? "1 day" : `${p.daysOff} days`} off)`} · Billable {formatDuration(p.billableSeconds)}
                          </Text>
                        </div>
                        <RowActions>
                          <RowLink to={`/team/${p.id}/${week}`}>
                            Timesheet<SrOnly> for {p.name}, {weekRange(week)}</SrOnly>
                          </RowLink>
                        </RowActions>
                      </Row>
                    );
                  })}
                </Rows>
              )}
            </Card>
          </section>
          {isAdmin && <GroupsManager groups={groups} onChange={async () => { await reloadGroups(); }} />}
        </>
      )}
    </>
  );
}

type Entry = {
  id: string;
  date: string;
  seconds: number;
  startedAt: string | null;
  notes: string;
  billable: boolean;
  project: { id: string; name: string; client: { name: string } | null };
  task: { title: string } | null;
};
type PersonWeek = {
  person: { id: string; name: string };
  week: { status: "submitted" | "approved" | "rejected"; decidedByName: string | null; note: string } | null;
  entries: Entry[];
};

// One person's week, read only (admins and managers).
export function TeamWeek({ userId, week }: { userId: string; week: string }) {
  const thisWeek = startOfWeek(localToday());
  const [data, setData] = useState<PersonWeek | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    api<PersonWeek>(`/api/timesheets/${userId}/${week}`)
      .then((r) => current && setData(r))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [userId, week]);
  useAnnounceWhen(data !== null, "Week loaded.");

  const now = Date.now();
  const secondsOf = (e: Entry) => e.seconds + (e.startedAt ? Math.max(0, Math.floor((now - new Date(e.startedAt).getTime()) / 1000)) : 0);
  const total = data?.entries.reduce((s, e) => s + secondsOf(e), 0) ?? 0;
  const sheet = data?.week ? SHEET_LABELS[data.week.status] : null;
  const title = data ? `${data.person.name}'s week` : "Week";

  return (
    <>
      <PageHeader eyebrow={<Link to={teamAddress(week, thisWeek)} className="wl-link">Team</Link>} title={title} intro={weekRange(week)} help="team-and-permissions/team-page">
        <PeriodStepper
          unit="week"
          current={week === thisWeek}
          onStep={(by) => navigate(`/team/${userId}/${addDays(week, 7 * by)}`)}
          onCurrent={() => navigate(`/team/${userId}/${thisWeek}`)}
        />
      </PageHeader>
      <ErrorNote message={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {sheet && (
            <Flex align="center" gap="2" wrap="wrap">
              <Badge color={sheet.color} variant="soft" size="2" highContrast>{sheet.label}</Badge>
              {data.week?.decidedByName && data.week.status !== "submitted" && (
                <Text size="2" color="gray">{data.week.status === "approved" ? "Approved" : "Sent back"} by {data.week.decidedByName}</Text>
              )}
              {data.week?.status === "rejected" && data.week.note && <Text size="2" color="gray">{data.week.note}</Text>}
            </Flex>
          )}
          <Card>
            {data.entries.length === 0 ? (
              <Empty>No time in this week.</Empty>
            ) : (
              <>
                {Array.from({ length: 7 }, (_, i) => addDays(week, i)).map((day) => {
                  const entries = data.entries.filter((e) => e.date === day);
                  if (!entries.length) return null;
                  const heading = formatDay(day, { weekday: "long", month: "short", day: "numeric" });
                  return (
                    <section key={day} aria-label={heading} className="wl-day-block">
                      <Flex justify="between" gap="3" px="4" pt="3">
                        <Heading as="h2" size="2" weight="medium" color="gray">{heading}</Heading>
                        <Text size="2" weight="medium" color="gray" className="wl-num">{formatDuration(entries.reduce((s, e) => s + secondsOf(e), 0))}</Text>
                      </Flex>
                      <Rows>
                        {entries.map((e) => (
                          <Row key={e.id}>
                            <RowMain>
                              <Text as="p" size="2" weight="medium">
                                {e.project.name}
                                {e.project.client && <Text color="gray" weight="regular"> · {e.project.client.name}</Text>}
                                {e.task && <Text color="gray" weight="regular"> · {e.task.title}</Text>}
                              </Text>
                              {e.notes && <Text as="p" size="2" color="gray">{e.notes}</Text>}
                            </RowMain>
                            <Badge color={e.billable ? "green" : "gray"} variant="soft" size="1" highContrast>{e.billable ? "Billable" : "Non-billable"}</Badge>
                            <Text size="3" className="wl-num">{formatEntryDuration(secondsOf(e))}{e.startedAt ? " (running)" : ""}</Text>
                          </Row>
                        ))}
                      </Rows>
                    </section>
                  );
                })}
                <p className="wl-row-total">
                  <Text weight="medium">Total</Text>
                  <Text size="4" weight="bold" className="wl-num">{formatDuration(total)}</Text>
                </p>
              </>
            )}
          </Card>
        </>
      )}
    </>
  );
}
