import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge, Flex, Grid, Text, TextField } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { api } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, ArticleLink, Card, CheckField, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowMain, RowMenu, RowMenuItem, Rows, SaveButton, SectionTitle, Select, SrOnly, TextInput, actionStarted, useClearOnAction, useConfirm, CONTROL_SIZE } from "../ui.tsx";
import { ROLE_LABELS, ROLES, type RoleName } from "../../shared/roles.ts";
import { formatMoney, moneyInput, parseMoney } from "../../shared/money.ts";

type Person = { id: string; name: string; email: string; role: RoleName; active: boolean; hourlyRate: number | null; costRate: number | null; weeklyCapacity: number; joined: boolean; twoFactorEnabled: boolean };
type Invite = { id: string; name: string; email: string; role: RoleName; expiresAt: string };
type NewLink = { name: string; email?: string; link: string; kind: "invite" | "reset"; emailed?: boolean; emailError?: string };
type InviteReply = { token: string; emailed?: boolean; emailError?: string };

const inviteLink = (token: string) => `${location.origin}/invite/${token}`;
const resetLink = (token: string) => `${location.origin}/reset/${token}`;
/** Hours as typed ("35", "37.5") in seconds, rounded to whole minutes; NaN when unreadable or over a week. */
function parseHours(text: string): number {
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d+)?$/.test(t)) return Number.NaN;
  const seconds = Math.round((Number(t) * 60)) * 60;
  return seconds <= 7 * 24 * 3600 ? seconds : Number.NaN;
}
/** Seconds as hours for a box: 37800 → "37.5". */
const hoursInput = (seconds: number) => String(+(seconds / 3600).toFixed(4));

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

// Manage → People (admins only): invite people by link, change roles, turn accounts off.
export function People({ myId, currency }: { myId: string; currency: string }) {
  const confirm = useConfirm();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [newLink, setNewLink] = useState<NewLink | null>(null);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [emailLink, setEmailLink] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ people: Person[]; invites: Invite[]; emailConfigured: boolean }>("/api/people");
      setEmailConfigured(data.emailConfigured);
      setPeople(data.people);
      setInvites(data.invites);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(people !== null, "People loaded.");

  /** Runs a change and reloads the list. Says whether it worked. */
  async function run(work: () => Promise<unknown>): Promise<boolean> {
    actionStarted();
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  const renew = (invite: Invite) =>
    run(async () => {
      const { token, ...sent } = await api<InviteReply>(`/api/people/invites/${invite.id}/renew`, { emailLink });
      setNewLink({ name: invite.name, email: invite.email, link: inviteLink(token), kind: "invite", ...sent });
    });
  async function cancel(invite: Invite) {
    const ok = await confirm({
      title: `Cancel the invite for ${invite.name}?`,
      description: "Their link will stop working. You can invite them again later.",
      confirm: "Cancel invite",
      cancel: "Keep invite",
    });
    if (ok) {
      await run(() => api(`/api/people/invites/${invite.id}`, undefined, "DELETE"));
      announce("Invite cancelled.");
    }
  }

  return (
    <>
      <PageHeader
        title="People"
        help="getting-started/invite-your-team"
        intro="Invite people with a link. Admins can do everything, including people and appearance. Managers can also add and change clients and projects. Members track their own time."
      />
      <ManageTabs role="admin" />
      <ErrorNote message={error} />

      <NewInvite emailConfigured={emailConfigured} emailLink={emailLink} setEmailLink={setEmailLink} onCreated={async (link) => { setNewLink(link); await load(); }} />
      {newLink && <LinkToSend key={newLink.link} {...newLink} onClose={() => setNewLink(null)} />}

      {people === null ? (
        <Loading />
      ) : (
        <Card>
          <Rows>
            {people.map((p) => (
              <PersonRow
                key={p.id}
                person={p}
                isMe={p.id === myId}
                currency={currency}
                onChange={(body) => run(() => api(`/api/people/${p.id}`, body, "PATCH"))}
                onSaveDetails={async (body) => {
                  await api(`/api/people/${p.id}`, body, "PATCH");
                  await load();
                }}
                onInvite={(email) => run(async () => {
                  const { token, ...sent } = await api<InviteReply>(`/api/people/${p.id}/invite`, { email, emailLink });
                  setNewLink({ name: p.name, email, link: inviteLink(token), kind: "invite", ...sent });
                })}
                onResetLink={() => run(async () => {
                  const { token } = await api<{ token: string }>(`/api/people/${p.id}/reset-link`, {});
                  setNewLink({ name: p.name, link: resetLink(token), kind: "reset" });
                })}
                onResetTwoFactor={async () => {
                  const ok = await confirm({
                    title: `Reset ${p.name}'s two-factor sign-in?`,
                    description: "Use this when they've lost their phone. They sign in with their password alone, then set two-factor up again (they're asked to if your organization requires it).",
                    confirm: "Reset two-factor",
                  });
                  if (ok && (await run(() => api(`/api/two-factor/people/${p.id}`, undefined, "DELETE")))) announce(`${p.name}'s two-factor sign-in was reset.`);
                }}
              />
            ))}
          </Rows>
        </Card>
      )}

      {invites.length > 0 && (
        <section>
          <SectionTitle muted>Invited, not joined yet</SectionTitle>
          <Card>
            <Rows>
              {invites.map((i) => {
                const expired = new Date(i.expiresAt) < new Date();
                return (
                  <Row key={i.id}>
                    <RowMain>
                      <Text as="p" size="2" weight="medium">
                        {i.name} <Text color="gray" weight="regular">· {i.email}</Text>
                      </Text>
                      <Text as="p" size="2" color="gray">
                        {ROLE_LABELS[i.role]} ·{" "}
                        {expired ? "Link expired" : `Link works until ${new Date(i.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}`}
                      </Text>
                    </RowMain>
                    <RowActions>
                      <RowButton onClick={() => void renew(i)}>New link<SrOnly> for {i.name}</SrOnly></RowButton>
                      <RowMenu label={`More actions for ${i.name}`}>
                        <RowMenuItem danger onSelect={() => void cancel(i)}>Cancel invite</RowMenuItem>
                      </RowMenu>
                    </RowActions>
                  </Row>
                );
              })}
            </Rows>
          </Card>
        </section>
      )}
    </>
  );
}

function NewInvite({ emailConfigured, emailLink, setEmailLink, onCreated }: {
  emailConfigured: boolean; emailLink: boolean; setEmailLink: (on: boolean) => void; onCreated: (link: NewLink) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearOnAction(() => setError(null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token, ...sent } = await api<InviteReply>("/api/people/invites", { name, email, role, emailLink });
      await onCreated({ name, email, link: inviteLink(token), kind: "invite", ...sent });
      setName("");
      setEmail("");
      setRole("member");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Flex direction="column" gap="3">
        <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))", md: "minmax(0, 1fr) minmax(0, 1fr) 10rem auto" }} gap="3" align="end">
          <TextInput label="Name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} required maxLength={200} placeholder="Maya Chen" />
          <TextInput label="Email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} required maxLength={254} placeholder="maya@yourstudio.com" />
          <div>
            <Select label="Role" value={role} onChange={(r) => { setRole(r as RoleName); setError(null); }} options={ROLE_OPTIONS} />
          </div>
          <ActionButton type="submit" busy={busy}>Invite</ActionButton>
        </Grid>
        {emailConfigured && <CheckField label="Email the link" checked={emailLink} onChange={setEmailLink} />}
        <InlineError message={error} />
      </Flex>
    </form>
  );
}

// The admin can always copy the link and send it themselves; when email is on, the app also emails it.
function LinkToSend({ name, email, link, kind, emailed, emailError, onClose }: NewLink & { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = kind === "invite" ? "Invite link" : "Reset link";
  const lasts = kind === "invite" ? "It works once, for 7 days." : "With it they choose a new password. It works once, for 24 hours.";
  // The link appears out of nowhere and is shown only once: say so, and put focus on it, ready to copy.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    announce(`${label} created for ${name}. It is selected, ready to copy.`);
  }, [label, name]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      announce("Copied.");
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="wl-linkcard">
      <Flex direction="column" gap="3">
        <Text as="p" size="3" weight="medium">Send this link to {name}</Text>
        {emailed && <Text as="p" size="2" role="status">Emailed to {email}.</Text>}
        {emailError && <InlineError message={`The email to ${email} wasn't sent: ${emailError}`} />}
        <Text as="p" size="2" color="gray">{emailed ? "You can also copy it and pass it on yourself." : "Copy it into an email or chat message."} {lasts} You won't see it again, but you can make a new one.{" "}
          <ArticleLink article={kind === "invite" ? "getting-started/invite-your-team" : "team-and-permissions/reset-a-password"}>{kind === "invite" ? "About invites" : "About reset links"}</ArticleLink>
        </Text>
        <Flex wrap="wrap" gap="2">
          <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
            <TextField.Root ref={input} size={CONTROL_SIZE} readOnly value={link} onFocus={(e) => e.target.select()} aria-label={label} className="wl-mono" />
          </div>
          <RowButton onClick={onClose}>Done</RowButton>
          <ActionButton onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</ActionButton>
        </Flex>
      </Flex>
    </div>
  );
}

function PersonRow({ person, isMe, currency, onChange, onSaveDetails, onInvite, onResetLink, onResetTwoFactor }: {
  person: Person; isMe: boolean; currency: string; onChange: (body: Record<string, unknown>) => Promise<boolean | void>;
  onSaveDetails: (body: Record<string, unknown>) => Promise<void>;
  onInvite: (email: string) => Promise<unknown>; onResetLink: () => Promise<unknown>; onResetTwoFactor: () => Promise<unknown>;
}) {
  const invite = useEditor();
  const details = useEditor();
  const initial = { name: person.name, email: person.email, costRate: moneyInput(person.costRate), hours: hoursInput(person.weeklyCapacity) };
  const [form, setForm] = useState(initial);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  // Only people who can sign in have an email to change; others get one with their invite.
  const changes: Record<string, string | number | null> = {};
  if (form.name.trim() !== person.name) changes.name = form.name;
  if (person.joined && form.email.trim().toLowerCase() !== person.email) changes.email = form.email;
  // Compared as typed, so a half-typed number still counts as a change (and is reported when saved).
  if (form.costRate.trim() !== initial.costRate) changes.costRate = parseMoney(form.costRate);
  if (form.hours.trim() !== initial.hours) changes.weeklyCapacity = parseHours(form.hours);
  function openDetails() {
    setForm(initial);
    setDetailsError(null);
    details.open();
  }
  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !Object.keys(changes).length) return;
    if (typeof changes.costRate === "number" && Number.isNaN(changes.costRate)) return setDetailsError("Enter a cost rate like 60 or 45.50.");
    if (typeof changes.weeklyCapacity === "number" && Number.isNaN(changes.weeklyCapacity)) return setDetailsError("Enter the hours a week as a number up to 168, like 40 or 37.5.");
    setBusy(true);
    setDetailsError(null);
    try {
      await onSaveDetails(changes);
      details.close();
      announce(changes.email ? `Saved. ${form.name.trim()} signs in with the new email from now on.` : "Saved.");
    } catch (e) {
      setDetailsError((e as Error).message);
    }
    setBusy(false);
  }
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(moneyInput(person.hourlyRate));
  const [rateError, setRateError] = useState(false);
  const [rateSaved, setRateSaved] = useState(false);
  const rateId = useId();
  const rateErrorId = useId();
  async function saveRate() {
    const cents = parseMoney(rate);
    if (Number.isNaN(cents)) return setRateError(true);
    setRateError(false);
    if (cents !== person.hourlyRate && (await change({ hourlyRate: cents }))) {
      setRateSaved(true);
      announce(`${person.name}'s billable rate saved.`);
    }
  }
  async function change(body: Record<string, unknown>) {
    return change2(() => onChange(body));
  }
  // One thing at a time per row.
  async function change2(work: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    const result = await work();
    setBusy(false);
    return result !== false;
  }
  async function turnOff() {
    const ok = await confirm({
      title: `Turn off ${person.name}'s account?`,
      description: "They won't be able to sign in. Their time stays, and you can turn the account back on.",
      confirm: "Turn off",
    });
    if (ok) {
      await change({ active: false });
      announce(`${person.name}'s account is turned off.`);
    }
  }

  if (details.editing) {
    return (
      <Row editing>
        <form onSubmit={saveDetails} aria-label={`Edit ${person.name}`} style={{ width: "100%" }}>
          <Flex direction="column" gap="3">
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <TextInput label="Name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
              {person.joined && (
                <TextInput
                  label="Email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                  maxLength={254}
                  hint="They sign in with this. Changing it signs them out everywhere."
                />
              )}
              <TextInput
                label="Cost rate (per hour)"
                value={form.costRate}
                onChange={(e) => setForm({ ...form, costRate: e.target.value })}
                inputMode="decimal"
                suffix={`${currency}/h`}
                hint="What an hour of their time costs you. Used for profitability; only admins see it."
              />
              <TextInput
                label="Hours a week"
                value={form.hours}
                onChange={(e) => setForm({ ...form, hours: e.target.value })}
                inputMode="decimal"
                hint="Their usual working hours, for the Team page."
              />
            </Grid>
            <InlineError message={detailsError} />
            <Flex align="center" justify="end" gap="3">
              <RowButton type="button" onClick={() => details.close()}>Cancel</RowButton>
              <SaveButton state={{ dirty: Object.keys(changes).length > 0, busy }}>Save</SaveButton>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  return (
    <Row className={person.active ? "" : "wl-off"}>
      <RowMain>
        <Text as="p" size="2" weight="medium">
          {person.name}
          {isMe && <Text color="gray" weight="regular"> (you)</Text>}
          {!person.active && <> <Badge color="gray" variant="soft" size="1" className="wl-inline-badge">Turned off</Badge></>}
        </Text>
        {person.joined ? (
          <Text as="p" size="2" color="gray">{person.email}</Text>
        ) : invite.editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // The new link takes focus, so it isn't sent back to the Invite button.
              void onInvite(email).then(() => invite.close(false));
            }}
          >
            <Flex wrap="wrap" align="center" gap="2" mt="1">
              <TextField.Root type="email" required autoFocus size="2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their email" aria-label={`${person.name}'s email`} style={{ minWidth: "14rem" }} />
              <RowButton type="button" onClick={() => invite.close()}>Cancel</RowButton>
              <ActionButton type="submit" size="2">Make invite link</ActionButton>
            </Flex>
          </form>
        ) : (
          <Flex align="center" gap="2" mt="1">
            <Text size="2" color="gray">No login yet</Text>
            <RowButton ref={invite.openerRef} onClick={invite.open}>Invite<SrOnly> {person.name}</SrOnly></RowButton>
          </Flex>
        )}
        {person.costRate !== null && <Text as="p" size="2" color="gray" className="wl-num">Cost {formatMoney(person.costRate, currency)}/h</Text>}
      </RowMain>
      <div className="wl-person-controls">
        <div className="wl-rate">
          <label htmlFor={rateId} className="wl-small-label">
            Billable rate<SrOnly> for {person.name}</SrOnly>
          </label>
          <TextField.Root
            id={rateId}
            size="2"
            className="wl-num"
            value={rate}
            onChange={(e) => {
              setRate(e.target.value);
              setRateSaved(false);
            }}
            onBlur={() => void saveRate()}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            inputMode="decimal"
            placeholder="Rate"
            aria-invalid={rateError || undefined}
            aria-describedby={rateError ? rateErrorId : undefined}
          >
            <TextField.Slot side="right">{currency}/h</TextField.Slot>
          </TextField.Root>
          {rateSaved && !rateError && (
            <Text as="p" size="1" color="green" className="wl-rate-note">
              Saved.
            </Text>
          )}
        </div>
        <Select
          size="2"
          aria-label={`Role for ${person.name}`}
          value={person.role}
          onChange={(role) => !busy && void change({ role })}
          disabled={isMe}
          options={ROLE_OPTIONS}
        />
        <RowActions>
          <RowButton ref={details.openerRef} onClick={openDetails} disabled={busy}>Edit<SrOnly> {person.name}</SrOnly></RowButton>
          {/* Your own row has no other actions, but keeps the space, so the role lists line up. */}
          {isMe ? (
            <span style={{ minWidth: "2rem" }} aria-hidden />
          ) : person.active ? (
            <RowMenu label={`More actions for ${person.name}`}>
              {person.joined && (
                <RowMenuItem disabled={busy} onSelect={() => void change2(onResetLink)}>
                  Reset link
                </RowMenuItem>
              )}
              {person.twoFactorEnabled && <RowMenuItem disabled={busy} onSelect={() => void change2(onResetTwoFactor)}>Reset two-factor</RowMenuItem>}
              <RowMenuItem danger disabled={busy} onSelect={() => void turnOff()}>Turn off</RowMenuItem>
            </RowMenu>
          ) : (
            <RowButton onClick={() => void change({ active: true })} busy={busy}>
              Turn on<SrOnly> {person.name}</SrOnly>
            </RowButton>
          )}
        </RowActions>
      </div>
      {rateError && <InlineError message="Enter a rate like 120 or 95.50." id={rateErrorId} />}
    </Row>
  );
}
