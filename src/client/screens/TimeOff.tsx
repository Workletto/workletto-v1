import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Flex, Grid, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen } from "../a11y.tsx";
import { api, type Me, type Member } from "../api.ts";
import { formatDay, localToday } from "../timer.tsx";
import { ActionButton, Card, CheckField, Empty, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowMain, Rows, SectionTitle, Select, SrOnly, TextInput } from "../ui.tsx";
import { addDays } from "../../shared/time.ts";
import { canManageOrganization, canManageWork } from "../../shared/roles.ts";

/** "Maya's", or "your" for the person looking (the list calls them You). */
const whose = (name: string) => (name === "You" ? "your" : `${name}'s`);

// Time off (WRK-138): everyone's days off for admins and managers, your own for members, and
// the company holidays. Approved time off and holidays come off capacity on the Team page.

type Kind = "vacation" | "sick" | "other";
type Day = { id: string; userId: string; name: string; date: string; half: boolean; kind: Kind; note: string; status: "approved" | "pending" };
type Holiday = { id: string; date: string; name: string };
type Loaded = { timeOff: Day[]; holidays: Holiday[]; approval: boolean };

const KIND_LABELS: Record<Kind, string> = { vacation: "Vacation", sick: "Sick", other: "Other" };
const short = (day: string) => formatDay(day, { weekday: "short", day: "numeric", month: "short" });
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

/** Days in a row (skipping weekends and holidays) for one person, of one kind, as one range. */
function ranges(days: Day[], holidays: Set<string>) {
  const out: { first: Day; last: Day; days: Day[] }[] = [];
  for (const d of [...days].sort((a, b) => a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date))) {
    const open = out[out.length - 1];
    let next = open ? addDays(open.last.date, 1) : "";
    while (open && (isWeekend(next) || holidays.has(next))) next = addDays(next, 1);
    const same = open && open.last.userId === d.userId && open.last.kind === d.kind && open.last.status === d.status && open.last.note === d.note && !open.last.half && !d.half;
    if (open && same && next === d.date) {
      open.last = d;
      open.days.push(d);
    } else out.push({ first: d, last: d, days: [d] });
  }
  return out;
}

export function TimeOff({ me }: { me: Me }) {
  const manager = canManageWork(me.user.role);
  const admin = canManageOrganization(me.user.role);
  const today = localToday();
  const [data, setData] = useState<Loaded | null>(null);
  const [people, setPeople] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Loaded>(`/api/time-off?from=${addDays(today, -60)}&to=${addDays(today, 365)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [today]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (manager) api<{ members: Member[] }>("/api/members").then((r) => setPeople(r.members.filter((m) => m.active))).catch(() => undefined);
  }, [manager]);
  useAnnounceWhen(data !== null, "Time off loaded.");

  async function act(work: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await work();
      await load();
      announce(done);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const holidays = new Set(data?.holidays.map((h) => h.date) ?? []);
  const pending = ranges(data?.timeOff.filter((d) => d.status === "pending") ?? [], holidays);
  const upcoming = ranges(data?.timeOff.filter((d) => d.date >= today && d.status === "approved") ?? [], holidays);

  return (
    <>
      <PageHeader
        title="Time off"
        help="team-and-permissions/time-off"
        intro={manager ? "Days off and company holidays. They come off people's capacity on the Team page." : "Your days off, and the company holidays."}
      />
      <ErrorNote message={error} />
      <AddTimeOff me={me} people={manager ? people : []} approval={!!data?.approval && !manager} onAdded={load} />
      {!data ? (
        <Loading />
      ) : (
        <>
          {manager && pending.length > 0 && (
            <section>
              <SectionTitle>Waiting for approval</SectionTitle>
              <Card>
                <Rows>
                  {pending.map((r) => (
                    <RangeRow key={r.first.id} range={r} showName>
                      <RowButton onClick={() => void act(() => Promise.all(r.days.map((d) => api(`/api/time-off/${d.id}/approve`, {}))), "Time off approved.")}>
                        Approve<SrOnly> {whose(r.first.name)} time off</SrOnly>
                      </RowButton>
                      <RowButton onClick={() => void act(() => Promise.all(r.days.map((d) => api(`/api/time-off/${d.id}/decline`, {}))), "Time off turned down.")}>
                        Decline<SrOnly> {whose(r.first.name)} time off</SrOnly>
                      </RowButton>
                    </RangeRow>
                  ))}
                </Rows>
              </Card>
            </section>
          )}
          {!manager && data.timeOff.some((d) => d.status === "pending") && (
            <Text as="p" size="2" color="gray">Some of your time off is waiting for an admin or manager to approve it.</Text>
          )}
          <section>
            <SectionTitle>Coming up</SectionTitle>
            <Card>
              {upcoming.length === 0 ? (
                <Empty>No time off coming up.</Empty>
              ) : (
                <Rows>
                  {upcoming.map((r) => (
                    <RangeRow key={r.first.id} range={r} showName={manager}>
                      {(manager || r.first.userId === me.user.id) && (
                        <RowButton onClick={() => void act(() => Promise.all(r.days.map((d) => api(`/api/time-off/${d.id}`, undefined, "DELETE"))), "Time off removed.")}>
                          Remove<SrOnly> {whose(r.first.name)} time off from {short(r.first.date)}</SrOnly>
                        </RowButton>
                      )}
                    </RangeRow>
                  ))}
                </Rows>
              )}
            </Card>
          </section>
          <Holidays holidays={data.holidays.filter((h) => h.date >= addDays(today, -30))} admin={admin} onChange={load} />
          {admin && <ApprovalSetting on={data.approval} onChange={load} />}
        </>
      )}
    </>
  );
}

function RangeRow({ range, showName, children }: { range: { first: Day; last: Day; days: Day[] }; showName: boolean; children?: React.ReactNode }) {
  const { first, last, days } = range;
  const when = first.date === last.date ? short(first.date) : `${short(first.date)} – ${short(last.date)}`;
  const length = first.half ? "Half day" : days.length === 1 ? "1 day" : `${days.length} days`;
  return (
    <Row>
      <RowMain>
        <Text as="p" size="2" weight="medium">
          {showName ? `${first.name} · ` : ""}{when}
        </Text>
        <Text as="p" size="2" color="gray">
          {KIND_LABELS[first.kind]} · {length}{first.note ? ` · ${first.note}` : ""}{" "}
          {first.status === "pending" && <Badge color="amber" variant="soft" size="1" highContrast>Waiting for approval</Badge>}
        </Text>
      </RowMain>
      {children && <RowActions>{children}</RowActions>}
    </Row>
  );
}

function AddTimeOff({ me, people, approval, onAdded }: { me: Me; people: Member[]; approval: boolean; onAdded: () => Promise<void> }) {
  const today = localToday();
  const [form, setForm] = useState({ userId: me.user.id, from: today, to: today, half: false, kind: "vacation" as Kind, note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const single = form.from === form.to;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api<{ added: number; status: string }>("/api/time-off", { ...form, half: single && form.half });
      const days = r.added === 1 ? (single && form.half ? "Half a day" : "1 day") : `${r.added} days`;
      const text = r.status === "pending" ? `${days} sent for approval.` : `${days} off added.`;
      setMessage(text);
      announce(text);
      await onAdded();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <section>
      <SectionTitle>Add time off</SectionTitle>
      <Card>
        <form onSubmit={submit} style={{ padding: "var(--space-4)" }}>
          <Flex direction="column" gap="3">
            <Grid columns={{ initial: "1", sm: "repeat(4, minmax(0, 1fr))" }} gap="3" align="end">
              {people.length > 0 && (
                <Select label="Person" value={form.userId} onChange={(userId) => setForm({ ...form, userId })} options={people.map((p) => ({ value: p.id, label: p.id === me.user.id ? `${p.name} (you)` : p.name }))} />
              )}
              <TextInput label="First day" type="date" required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, to: e.target.value > form.to ? e.target.value : form.to })} />
              <TextInput label="Last day" type="date" required value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
              <Select label="Kind" value={form.kind} onChange={(kind) => setForm({ ...form, kind: kind as Kind })} options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} />
            </Grid>
            {single && <CheckField label="Half a day" checked={form.half} onChange={(half) => setForm({ ...form, half })} />}
            <TextInput label="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={200} />
            <InlineError message={error} />
            <Flex align="center" gap="3" wrap="wrap">
              <ActionButton type="submit" busy={busy}>{approval ? "Ask for time off" : "Add time off"}</ActionButton>
              {message && <Text size="2" color="gray">{message}</Text>}
            </Flex>
            <Text size="1" color="gray">Weekends and company holidays are skipped.</Text>
          </Flex>
        </form>
      </Card>
    </section>
  );
}

function Holidays({ holidays, admin, onChange }: { holidays: Holiday[]; admin: boolean; onChange: () => Promise<void> }) {
  const [form, setForm] = useState({ date: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await work();
      await onChange();
      announce(done);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section>
      <SectionTitle>Company holidays</SectionTitle>
      <Card>
        {holidays.length === 0 ? (
          <Empty>No company holidays yet.</Empty>
        ) : (
          <Rows>
            {holidays.map((h) => (
              <Row key={h.id}>
                <RowMain>
                  <Text as="p" size="2" weight="medium">{h.name}</Text>
                  <Text as="p" size="2" color="gray">{formatDay(h.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</Text>
                </RowMain>
                {admin && (
                  <RowActions>
                    <RowButton onClick={() => void run(() => api(`/api/settings/time-off/holidays/${h.id}`, undefined, "DELETE"), "Holiday removed.")}>
                      Remove<SrOnly> {h.name}</SrOnly>
                    </RowButton>
                  </RowActions>
                )}
              </Row>
            ))}
          </Rows>
        )}
        {admin && (
          <form
            style={{ padding: "var(--space-4)" }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/settings/time-off/holidays", form);
                setForm({ date: "", name: "" });
              }, "Holiday added.");
            }}
          >
            <Grid columns={{ initial: "1", sm: "minmax(0, 1fr) minmax(0, 2fr) auto" }} gap="3" align="end">
              <TextInput label="Date" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              <TextInput label="Holiday" required maxLength={100} placeholder="New Year's Day" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <ActionButton type="submit" variant="outline">Add holiday</ActionButton>
            </Grid>
          </form>
        )}
        <InlineError message={error} />
      </Card>
    </section>
  );
}

function ApprovalSetting({ on, onChange }: { on: boolean; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section>
      <SectionTitle>Approval</SectionTitle>
      <Card>
        <Flex direction="column" gap="2" p="4">
          <CheckField
            label="Members' time off waits for an admin or manager to approve it"
            checked={on}
            hint="Admins' and managers' own time off never waits."
            onChange={(approval) =>
              void api("/api/settings/time-off", { approval }, "PUT")
                .then(onChange)
                .then(() => announce(approval ? "Time off now waits for approval." : "Time off no longer waits for approval."))
                .catch((e: Error) => setError(e.message))
            }
          />
          <InlineError message={error} />
        </Flex>
      </Card>
    </section>
  );
}
