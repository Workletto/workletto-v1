import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { announce, APPROVALS_CHANGED, useAnnounceWhen } from "../a11y.tsx";
import { api } from "../api.ts";
import { GroupFilter, useGroups } from "../groups.tsx";
import { usePath } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { WeekNav, weekRange } from "../WeekNav.tsx";
import { ActionButton, Card, Empty, ErrorNote, InlineError, Loading, NavTabs, PageHeader, Row, RowButton, RowMain, RowMenu, RowMenuItem, Rows, Select, TextAreaInput, useConfirm } from "../ui.tsx";
import { addDays, formatDuration, formatEntryDuration, startOfWeek } from "../../shared/time.ts";

type Tab = "submitted" | "approved" | "rejected";
const TABS: { status: Tab; label: string; path: string }[] = [
  { status: "submitted", label: "Waiting", path: "/approvals" },
  { status: "approved", label: "Approved", path: "/approvals/approved" },
  { status: "rejected", label: "Sent back", path: "/approvals/rejected" },
];

type Week = {
  weekStart: string;
  status: Tab;
  decidedByName: string | null;
  note: string;
  person: { id: string; name: string };
  seconds: number;
  billableSeconds: number;
};

type Detail = {
  entries: { id: string; date: string; seconds: number; notes: string; project: { name: string; client: { name: string } | null }; task: { title: string } | null }[];
};

const keyOf = (w: Week) => `${w.person.id}|${w.weekStart}`;

// Weeks people have submitted, for admins and managers to approve, send back or reopen.
export function Approvals({ myId }: { myId: string }) {
  const path = usePath();
  const tab = TABS.find((t) => t.path === path) ?? TABS[0]!;
  const confirm = useConfirm();
  const [weeks, setWeeks] = useState<Week[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  // Which weeks to list: all of them, or one Monday. And whose.
  const thisWeek = startOfWeek(localToday());
  const [week, setWeek] = useState<string | null>(null);
  const [personId, setPersonId] = useState("");
  const { groups } = useGroups();
  const [groupId, setGroupId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);

  // Only the latest request's answer is shown: a slow one for another week or tab mustn't
  // replace it, or "Approve all shown" would approve weeks that aren't the ones chosen.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const r = await api<{ weeks: Week[] }>(`/api/timesheets?status=${tab.status}${week ? `&week=${week}` : ""}${groupId ? `&groupId=${groupId}` : ""}`);
      if (request === latest.current) setWeeks(r.weeks);
    } catch (e) {
      if (request !== latest.current) return;
      setError((e as Error).message);
      setWeeks((old) => old ?? []);
    }
  }, [tab.status, week, groupId]);

  useEffect(() => {
    setWeeks(null);
    setError(null);
    setStatus(null);
    setOpen(null);
    setSendingBack(null);
    void load();
  }, [load]);
  useAnnounceWhen(weeks !== null, "Approvals loaded.");

  async function decide(week: Week, decision: "approve" | "reject" | "reopen", note = "") {
    setError(null);
    try {
      await api(`/api/timesheets/${week.person.id}/${week.weekStart}/${decision}`, decision === "reject" ? { note } : {});
      announce(decision === "approve" ? "Week approved." : decision === "reject" ? "Week sent back." : "Week reopened.");
      setSendingBack(null);
      setOpen(null);
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reopen(week: Week) {
    const ok = await confirm({
      title: `Reopen ${week.person.name}'s week?`,
      description: "They can change their time again and submit it once more.",
      confirm: "Reopen",
      danger: false,
    });
    if (ok) await decide(week, "reopen");
  }

  const people = [...new Map((weeks ?? []).map((w) => [w.person.id, w.person.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const personShown = people.some(([id]) => id === personId) ? personId : "";
  const shown = (weeks ?? []).filter((w) => !personShown || w.person.id === personShown);
  const approvable = tab.status === "submitted" ? shown.filter((w) => w.person.id !== myId) : [];
  const sum = (pick: (w: Week) => number) => shown.reduce((total, w) => total + pick(w), 0);

  async function approveAll() {
    if (approvingAll || !approvable.length) return;
    const ok = await confirm({
      title: `Approve ${approvable.length} ${approvable.length === 1 ? "timesheet" : "timesheets"}?`,
      description: "Each person's week is locked until someone reopens it.",
      confirm: "Approve",
      danger: false,
    });
    if (!ok) return;
    setApprovingAll(true);
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ approved: number; skipped: number }>("/api/timesheets/approve", {
        weeks: approvable.map((w) => ({ userId: w.person.id, weekStart: w.weekStart })),
      });
      const text = `Approved ${r.approved}.${r.skipped > 0 ? ` ${r.skipped} skipped: no longer waiting.` : ""}`;
      setStatus(text);
      announce(text);
      setOpen(null);
      setSendingBack(null);
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApprovingAll(false);
    }
  }

  const empty = tab.status === "submitted" ? "No weeks waiting for approval." : "Nothing here yet.";
  return (
    <>
      <PageHeader title="Approvals" intro="Weeks people have submitted. Approving locks a week; reopening unlocks it." help="team-and-permissions/approve-timesheets" />
      <NavTabs label="Approval status" tabs={TABS.map((t) => ({ to: t.path, label: t.label, active: t.status === tab.status }))} />
      <Flex wrap="wrap" align="end" gap="3">
        <div style={{ width: "12rem", maxWidth: "100%" }}>
          <Select
            label="Week"
            value={week === null ? "all" : "one"}
            onChange={(v) => setWeek(v === "all" ? null : addDays(thisWeek, -7))}
            options={[{ value: "all", label: "All weeks" }, { value: "one", label: "One week" }]}
          />
        </div>
        {week !== null && <WeekNav week={week} thisWeek={thisWeek} onChange={setWeek} />}
        <GroupFilter groups={groups} value={groupId} onChange={setGroupId} />
        {people.length > 1 && (
          <div style={{ width: "14rem", maxWidth: "100%" }}>
            <Select label="Person" value={personShown} onChange={setPersonId} options={[{ value: "", label: "Everyone" }, ...people.map(([id, name]) => ({ value: id, label: name }))]} />
          </div>
        )}
      </Flex>
      <ErrorNote message={error} />
      {status && <Text as="p" size="2" role="status">{status}</Text>}
      {weeks !== null && shown.length > 0 && (
        <Flex wrap="wrap" align="center" justify="between" gap="3">
          <Text as="p" size="2" color="gray" className="wl-num">
            {shown.length} {shown.length === 1 ? "timesheet" : "timesheets"} · {formatDuration(sum((w) => w.seconds))}, {formatDuration(sum((w) => w.billableSeconds))} billable
          </Text>
          {approvable.length > 0 && (
            <ActionButton size="2" busy={approvingAll} busyLabel="Approving…" onClick={() => void approveAll()}>
              Approve all shown ({approvable.length})
            </ActionButton>
          )}
        </Flex>
      )}
      {weeks === null ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <Card>
          <Rows>
            {shown.map((w) => {
              const key = keyOf(w);
              const mine = w.person.id === myId;
              const label = `${w.person.name}, ${weekRange(w.weekStart)}`;
              return (
                <Row key={key} editing={open === key || sendingBack === key} style={open === key || sendingBack === key ? { flexWrap: "wrap" } : undefined}>
                  <RowMain>
                    <Text as="p" weight="medium">{w.person.name}</Text>
                    <Text as="p" size="2" color="gray">
                      {weekRange(w.weekStart)}
                      {w.decidedByName && tab.status === "approved" && ` · Approved by ${w.decidedByName}`}
                      {w.decidedByName && tab.status === "rejected" && ` · Sent back by ${w.decidedByName}`}
                    </Text>
                    {tab.status === "rejected" && w.note && <Text as="p" size="2" color="gray">{w.note}</Text>}
                  </RowMain>
                  <div className="wl-row-time wl-approval-hours">
                    <Text size="4" className="wl-num">{formatDuration(w.seconds)}</Text>
                    <Text as="p" size="1" color="gray" className="wl-num">{formatDuration(w.billableSeconds)} billable</Text>
                  </div>
                  <div className="wl-row-actions wl-approval-actions">
                    {mine ? (
                      <Text size="1" color="gray">Someone else approves your week</Text>
                    ) : (
                      <>
                        {tab.status === "submitted" && (
                          <RowButton onClick={() => void decide(w, "approve")}>
                            Approve<span className="wl-sr-only"> {label}</span>
                          </RowButton>
                        )}
                        {tab.status !== "rejected" && (
                          <RowMenu label={`More actions for ${label}`}>
                            {tab.status === "submitted" && <RowMenuItem onSelect={() => { setSendingBack(key); setOpen(null); }}>Send back…</RowMenuItem>}
                            {tab.status === "approved" && <RowMenuItem onSelect={() => void reopen(w)}>Reopen</RowMenuItem>}
                            <RowMenuItem onSelect={() => { setOpen(open === key ? null : key); setSendingBack(null); }}>View entries</RowMenuItem>
                          </RowMenu>
                        )}
                        {tab.status === "rejected" && (
                          <RowButton onClick={() => setOpen(open === key ? null : key)}>
                            View entries<span className="wl-sr-only"> {label}</span>
                          </RowButton>
                        )}
                      </>
                    )}
                    {mine && <RowButton onClick={() => setOpen(open === key ? null : key)}>View entries<span className="wl-sr-only"> {label}</span></RowButton>}
                  </div>
                  {open === key && <Entries week={w} />}
                  {sendingBack === key && <SendBack week={w} onCancel={() => setSendingBack(null)} onSend={(note) => decide(w, "reject", note)} />}
                </Row>
              );
            })}
          </Rows>
        </Card>
      )}
    </>
  );
}

function SendBack({ week, onCancel, onSend }: { week: Week; onCancel: () => void; onSend: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    await onSend(note.trim());
    setBusy(false);
  }
  return (
    <form onSubmit={submit} style={{ flexBasis: "100%", display: "grid", gap: "var(--space-3)" }}>
      <TextAreaInput label={`Note for ${week.person.name} (optional)`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} autoFocus />
      <Flex align="center" justify="end" gap="3">
        <RowButton type="button" onClick={onCancel}>Cancel</RowButton>
        <ActionButton type="submit" size="2" busy={busy} busyLabel="Sending…">Send back</ActionButton>
      </Flex>
    </form>
  );
}

// One person's week, by day.
function Entries({ week }: { week: Week }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/api/timesheets/${week.person.id}/${week.weekStart}`).then(setDetail).catch((e: Error) => setError(e.message));
  }, [week.person.id, week.weekStart]);

  return (
    <div style={{ flexBasis: "100%", display: "grid", gap: "var(--space-3)" }}>
      <InlineError message={error} />
      {!detail && !error && <Loading />}
      {detail && detail.entries.length === 0 && <Text size="2" color="gray">No time in this week.</Text>}
      {detail &&
        Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i)).map((d) => {
          const entries = detail.entries.filter((e) => e.date === d);
          if (!entries.length) return null;
          return (
            <section key={d} aria-label={formatDay(d, { weekday: "long", month: "short", day: "numeric" })}>
              <Flex justify="between" gap="3">
                <Text size="2" weight="medium">{formatDay(d, { weekday: "long", month: "short", day: "numeric" })}</Text>
                <Text size="2" weight="medium" className="wl-num">{formatDuration(entries.reduce((t, e) => t + e.seconds, 0))}</Text>
              </Flex>
              {entries.map((e) => (
                <Flex key={e.id} justify="between" gap="3">
                  <div style={{ minWidth: 0 }}>
                    <Text as="p" size="2">
                      {e.project.name}
                      {e.project.client && ` · ${e.project.client.name}`}
                    </Text>
                    {e.task && <Text as="p" size="2">{e.task.title}</Text>}
                    {e.notes && <Text as="p" size="2" color="gray" style={{ overflowWrap: "anywhere" }}>{e.notes}</Text>}
                  </div>
                  <Text size="2" className="wl-num">{formatEntryDuration(e.seconds)}</Text>
                </Flex>
              ))}
            </section>
          );
        })}
    </div>
  );
}
