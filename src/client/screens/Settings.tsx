import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, type Me } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, CheckField, InlineError, PageHeader, RowButton, SavedNote, SaveButton, Select, SettingsSection, SrOnly, TextAreaInput, TextInput, ArticleLink, useConfirm, useSaveForm } from "../ui.tsx";
import { CURRENCIES } from "../../shared/money.ts";
import { forgetCustomFields, type CustomField } from "../customFields.tsx";

type Company = Pick<Me["organization"], "name" | "appName" | "currency" | "address">;

// Manage → Settings (admins): company details used across the app and on invoices.
export function Settings({ me, onSaved }: { me: Me; onSaved: (changes: Partial<Me["organization"]>) => void }) {
  const org = me.organization;
  const [form, setForm] = useState({ name: org.name, appName: org.appName ?? "", currency: org.currency, address: org.address });
  const state = useSaveForm(form);
  // The currency can't change once there are invoices or expenses: the list says so up front.
  const [currencyLocked, setCurrencyLocked] = useState(false);
  useEffect(() => {
    api<{ currencyLocked: boolean }>("/api/settings/company").then((r) => setCurrencyLocked(r.currencyLocked)).catch(() => undefined);
  }, []);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function save(event: FormEvent) {
    event.preventDefault();
    void state.save(async () => {
      const { organization } = await api<{ organization: Company }>("/api/settings/company", form, "PUT");
      onSaved(organization);
    }, "Settings saved.");
  }

  return (
    <>
      <PageHeader title="Settings" intro="Your company's details, used across the app and on invoices." help="customization/brand-your-app" />
      <ManageTabs role="admin" />
      <SettingsSection title="Company details" description="Your name, currency and address.">
        <form onSubmit={save}>
          <Flex direction="column" gap="4">
            <TextInput label="Company name" value={form.name} onChange={set("name")} required maxLength={100} />
            <TextInput
              label="App name"
              value={form.appName}
              onChange={set("appName")}
              maxLength={40}
              placeholder={form.name || org.name}
              hint="Shown in the header, the browser tab and the sign-in page. Leave it empty to use your organization's name."
            />
            <div>
              <Select label="Currency" value={form.currency} onChange={(currency) => setForm((f) => ({ ...f, currency }))} options={CURRENCIES.map((c) => ({ value: c, label: c }))} disabled={currencyLocked} hint={currencyLocked ? "The currency can't change once there are invoices or expenses." : "Your home currency: people's rates and costs, and new clients, use it. A client can be billed in another one."} />
            </div>
            <TextAreaInput
              label="Company address"
              value={form.address}
              onChange={set("address")}
              rows={4}
              maxLength={500}
              placeholder={"12 Example Street\nCity, Postcode\nCountry"}
              hint="Printed on your invoices."
            />
            <Flex align="center" gap="4" wrap="wrap">
              <SaveButton state={state}>Save settings</SaveButton>
              <SavedNote message={state.message} />
            </Flex>
          </Flex>
        </form>
      </SettingsSection>
      <ExchangeRates org={org} />
      <SingleSignOn />
      <RequireTwoFactor />
      <CustomFields />
      <TimesheetApprovals on={org.timesheetApprovals} onSaved={onSaved} />
    </>
  );
}

type OtherCurrency = { currency: string; clients: number; rate: string };

// The exchange rates for the other currencies clients are billed in (WRK-135). Only reports use
// them, to add amounts up in the home currency; invoices are never converted. Shown once a
// client is billed in another currency; its rate was asked for then, and can change here.
function ExchangeRates({ org }: { org: Me["organization"] }) {
  const [others, setOthers] = useState<OtherCurrency[] | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const state = useSaveForm(rates);
  useEffect(() => {
    api<{ otherCurrencies: OtherCurrency[] }>("/api/settings/company")
      .then((r) => {
        setOthers(r.otherCurrencies);
        setRates(Object.fromEntries(r.otherCurrencies.map((o) => [o.currency, o.rate])));
      })
      .catch(() => undefined);
  }, []);
  if (!others?.length) return null;

  function save(event: FormEvent) {
    event.preventDefault();
    void state.save(async () => {
      const company = { name: org.name, appName: org.appName ?? "", currency: org.currency, address: org.address };
      await api("/api/settings/company", { ...company, exchangeRates: rates }, "PUT");
    }, "Exchange rates saved.");
  }

  return (
    <SettingsSection title="Exchange rates" description={`Reports add up amounts from clients billed in other currencies in ${org.currency}, at these rates. Invoices are never converted.`}>
      <form onSubmit={save}>
        <Flex direction="column" gap="4" maxWidth="20rem">
          {others.map((o) => (
            <TextInput
              key={o.currency}
              label={`1 ${o.currency} is worth`}
              value={rates[o.currency] ?? ""}
              onChange={(e) => setRates((r) => ({ ...r, [o.currency]: e.target.value }))}
              inputMode="decimal"
              suffix={org.currency}
              className="wl-num"
              hint={o.clients === 1 ? `1 client is billed in ${o.currency}.` : `${o.clients} clients are billed in ${o.currency}.`}
            />
          ))}
          <Flex align="center" gap="4" wrap="wrap">
            <SaveButton state={state}>Save exchange rates</SaveButton>
            <SavedNote message={state.message} />
          </Flex>
        </Flex>
      </form>
    </SettingsSection>
  );
}

// Turning approvals on or off saves straight away, and so does choosing the time zone.
// Monday reminders go out at 9:00 in that zone. A zone nobody has chosen yet (the default,
// UTC, while approvals have never been on) starts out as this browser's zone, in plain sight.
function TimesheetApprovals({ on, onSaved }: { on: boolean; onSaved: (changes: Partial<Me["organization"]>) => void }) {
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ approvals: boolean; timeZone: string }>("/api/settings/timesheets")
      .then((r) => {
        const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setTimeZone(!r.approvals && r.timeZone === "UTC" && browser ? browser : r.timeZone);
      })
      .catch(() => undefined);
  }, []);

  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const list = new Set(["UTC", ...all]);
    if (timeZone) list.add(timeZone);
    return [...list].sort().map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
  }, [timeZone]);

  async function change(approvals: boolean, zone: string | null) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<{ approvals: boolean; timeZone: string }>("/api/settings/timesheets", { approvals, ...(zone ? { timeZone: zone } : {}) }, "PUT");
      setTimeZone(saved.timeZone);
      onSaved({ timesheetApprovals: saved.approvals });
      setMessage({ ok: true, text: "Saved." });
      announce("Timesheet approvals saved.");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Timesheet approvals" description="People submit each week. Managers and admins approve it.">
      <CheckField
        label="Ask everyone to submit their week for approval"
        checked={on}
        disabled={busy}
        onChange={(checked) => void change(checked, timeZone)}
        hint="Submitted and approved weeks can't be changed."
      />
      {timeZone && (
        <div>
          <Select
            label="Time zone"
            value={timeZone}
            onChange={(zone) => void change(on, zone)}
            options={zones}
            disabled={busy}
            hint="Monday reminders go out at 9:00 in this time zone."
          />
        </div>
      )}
      <SavedNote message={message} />
    </SettingsSection>
  );
}

const KIND_OPTIONS = [{ value: "time", label: "Time entries" }, { value: "project", label: "Projects" }, { value: "client", label: "Clients" }];
const TYPE_OPTIONS = [{ value: "choice", label: "A list of choices" }, { value: "text", label: "Text" }, { value: "number", label: "A number" }];
const KIND_TEXT = { time: "time entries", project: "projects", client: "clients" } as const;

// Custom fields (WRK-148): the organization's own fields on time entries, projects and clients.
// Removing one hides it and keeps its values; it can be restored.
function CustomFields() {
  const confirm = useConfirm();
  const [fields, setFields] = useState<CustomField[] | null>(null);
  const [form, setForm] = useState({ name: "", appliesTo: "time", type: "choice", choices: "", required: false });
  const [editing, setEditing] = useState<{ id: string; name: string; choices: string; required: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api<{ fields: CustomField[] }>("/api/custom-fields?all=1").then((r) => setFields(r.fields)).catch(() => undefined);
  useEffect(() => void load(), []);

  async function run(work: () => Promise<unknown>, done: string) {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    try {
      await work();
      forgetCustomFields();
      await load();
      setMessage({ ok: true, text: done });
      announce(done);
      return true;
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => api("/api/custom-fields", { ...form, choices: form.type === "choice" ? form.choices : undefined }), `${form.name.trim()} added.`);
    if (ok) setForm({ name: "", appliesTo: form.appliesTo, type: "choice", choices: "", required: false });
  }

  async function remove(field: CustomField) {
    const ok = await confirm({
      title: `Remove ${field.name}?`,
      description: `It disappears from forms, reports and exports. What was filled in is kept, and you can restore it here.`,
      confirm: "Remove",
    });
    if (ok) await run(() => api(`/api/custom-fields/${field.id}`, { archived: true }, "PATCH"), `${field.name} removed.`);
  }

  return (
    <SettingsSection
      title="Custom fields"
      description={<>Your own fields on time entries, projects or clients, like Phase, Department or PO. <ArticleLink article="customization/custom-fields">About custom fields</ArticleLink></>}
    >
      {fields && fields.length > 0 && (
        <Flex asChild direction="column" gap="2">
          <ul aria-label="Custom fields" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {fields.map((f) => (
              <li key={f.id}>
                {editing?.id === f.id ? (
                  <form
                    aria-label={`Change ${f.name}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(() => api(`/api/custom-fields/${f.id}`, { name: editing.name, required: editing.required, ...(f.type === "choice" ? { choices: editing.choices } : {}) }, "PATCH"), "Saved.").then((ok) => ok && setEditing(null));
                    }}
                  >
                    <Flex direction="column" gap="2">
                      <TextInput label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={60} required />
                      {f.type === "choice" && <TextAreaInput label="Choices, one per line" value={editing.choices} onChange={(e) => setEditing({ ...editing, choices: e.target.value })} rows={4} />}
                      <CheckField label="Required" checked={editing.required} onChange={(required) => setEditing({ ...editing, required })} />
                      <Flex gap="3">
                        <ActionButton type="submit" busy={busy}>Save</ActionButton>
                        <RowButton onClick={() => setEditing(null)}>Cancel</RowButton>
                      </Flex>
                    </Flex>
                  </form>
                ) : (
                  <Flex wrap="wrap" align="center" gap="3">
                    <Text size="2" color={f.archived ? "gray" : undefined}>
                      <strong>{f.name}</strong> on {KIND_TEXT[f.appliesTo]}: {f.type === "choice" ? f.choices.join(", ") : f.type === "number" ? "a number" : "text"}
                      {f.required ? ", required" : ""}{f.archived ? " (removed)" : ""}
                    </Text>
                    {f.archived ? (
                      <RowButton onClick={() => void run(() => api(`/api/custom-fields/${f.id}`, { archived: false }, "PATCH"), `${f.name} restored.`)}>Restore<SrOnly> {f.name}</SrOnly></RowButton>
                    ) : (
                      <>
                        <RowButton onClick={() => setEditing({ id: f.id, name: f.name, choices: f.choices.join("\n"), required: f.required })}>Change<SrOnly> {f.name}</SrOnly></RowButton>
                        <RowButton danger onClick={() => void remove(f)}>Remove<SrOnly> {f.name}</SrOnly></RowButton>
                      </>
                    )}
                  </Flex>
                )}
              </li>
            ))}
          </ul>
        </Flex>
      )}
      <form onSubmit={add} aria-label="Add a custom field">
        <Flex direction="column" gap="3">
          <Flex wrap="wrap" gap="3" align="start">
            <div style={{ flex: "1 1 12rem" }}><TextInput label="Field name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} placeholder="Phase" required /></div>
            <div style={{ flex: "1 1 10rem" }}><Select label="On" value={form.appliesTo} onChange={(appliesTo) => setForm({ ...form, appliesTo })} options={KIND_OPTIONS} /></div>
            <div style={{ flex: "1 1 10rem" }}><Select label="Type" value={form.type} onChange={(type) => setForm({ ...form, type })} options={TYPE_OPTIONS} /></div>
          </Flex>
          {form.type === "choice" && (
            <TextAreaInput label="Choices, one per line" value={form.choices} onChange={(e) => setForm({ ...form, choices: e.target.value })} rows={4} placeholder={"Discovery\nDesign\nBuild"} />
          )}
          <CheckField label="Required" checked={form.required} onChange={(required) => setForm({ ...form, required })} hint="New records can't be saved without it." />
          <div><ActionButton type="submit" busy={busy} disabled={!form.name.trim()}>Add field</ActionButton></div>
        </Flex>
      </form>
      <SavedNote message={message} />
    </SettingsSection>
  );
}

// Two-factor sign-in (WRK-147): whether everyone who signs in with a password must use it.
function RequireTwoFactor() {
  const [state, setState] = useState<{ required: boolean; enabled: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ required: boolean; enabled: number }>("/api/two-factor/settings").then(setState).catch(() => undefined);
  }, []);

  async function change(required: boolean) {
    if (busy || !state) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/two-factor/settings", { required }, "PUT");
      setState({ ...state, required });
      setMessage({ ok: true, text: "Saved." });
      announce("Two-factor sign-in saved.");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Two-factor sign-in"
      description={<>A code from a phone app after the password. Each person sets it up from the menu with their name. <ArticleLink article="team-and-permissions/two-factor-sign-in">About two-factor sign-in</ArticleLink></>}
    >
      {state && (
        <>
          <CheckField
            label="Require two-factor for everyone"
            checked={state.required}
            disabled={busy}
            onChange={(checked) => void change(checked)}
            hint="People who sign in with a password and haven't set it up are asked to at their next sign-in. People who sign in with single sign-on aren't asked; two-factor sign-in for them is set up with your single sign-on provider."
          />
          <Text as="p" size="2" color="gray">{state.enabled === 1 ? "1 person uses it." : `${state.enabled} people use it.`}</Text>
        </>
      )}
      <SavedNote message={message} />
    </SettingsSection>
  );
}

type SsoSettings = { providerName: string; issuer: string; clientId: string; domain: string; allowJoin: boolean; requireSso: boolean; hasSecret: boolean; secretUnreadable: boolean };

// Single sign-on (WRK-136): people sign in with their company account through the organization's
// own identity provider (Google Workspace, Microsoft Entra ID, Okta). The provider needs the
// address shown here; it gives back an issuer, a client ID and a secret.
function SingleSignOn() {
  const [loaded, setLoaded] = useState<{ settings: SsoSettings | null; callbackUrl: string; available: boolean } | null>(null);
  const [form, setForm] = useState({ providerName: "Google Workspace", issuer: "", clientId: "", clientSecret: "", domain: "", allowJoin: false, requireSso: false });
  const state = useSaveForm(form);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  // The form as saved: the secret field is empty, since the saved one is never sent back.
  const formOf = (s: SsoSettings) => ({ providerName: s.providerName, issuer: s.issuer, clientId: s.clientId, clientSecret: "", domain: s.domain, allowJoin: s.allowJoin, requireSso: s.requireSso });
  const load = () =>
    api<{ settings: SsoSettings | null; callbackUrl: string; available: boolean }>("/api/settings/sso")
      .then((r) => {
        setLoaded(r);
        if (r.settings) setForm(formOf(r.settings));
        return r;
      })
      .catch(() => null);
  useEffect(() => void load(), []);
  if (!loaded?.available) return null;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const saved = loaded.settings;

  function save(event: FormEvent) {
    event.preventDefault();
    const announcement = `Single sign-on saved. The sign-in page now offers “Sign in with ${form.providerName}”.`;
    void state.save(async () => {
      await api("/api/settings/sso", form, "PUT");
      const r = await load();
      return r?.settings ? formOf(r.settings) : undefined;
    }, announcement, announcement);
  }
  async function turnOff() {
    const ok = await confirm({ title: "Turn off single sign-on?", description: "Everyone signs in with their password again. People who joined through the provider ask an admin for a password reset link.", confirm: "Turn off" });
    if (!ok) return;
    try {
      await api("/api/settings/sso", undefined, "DELETE");
      setForm({ providerName: "Google Workspace", issuer: "", clientId: "", clientSecret: "", domain: "", allowJoin: false, requireSso: false });
      await load();
      announce("Single sign-on turned off.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function copy() {
    await navigator.clipboard.writeText(loaded!.callbackUrl);
    setCopied(true);
  }

  return (
    <SettingsSection
      title="Single sign-on"
      description={
        <>
          Let people sign in with their company account (Google Workspace, Microsoft Entra ID or Okta).{" "}
          <ArticleLink article="team-and-permissions/single-sign-on">How to set it up</ArticleLink>
        </>
      }
    >
      <form onSubmit={save}>
        <Flex direction="column" gap="4" maxWidth="34rem">
          <div>
            <TextInput label="Redirect address for your provider" value={loaded.callbackUrl} readOnly hint="Add this as an allowed redirect (callback) address when you register the app with your provider." />
            <RowButton type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy address"}</RowButton>
          </div>
          <TextInput label="Provider name, for the button" value={form.providerName} onChange={(e) => set("providerName", e.target.value)} maxLength={60} required hint="Shown as “Sign in with Google Workspace”." />
          <TextInput
            label="Issuer"
            value={form.issuer}
            onChange={(e) => set("issuer", e.target.value)}
            required
            placeholder="https://accounts.google.com"
            hint="Google: https://accounts.google.com · Microsoft: https://login.microsoftonline.com/your-tenant-id/v2.0 · Okta: https://your-org.okta.com"
          />
          <TextInput label="Client ID" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} required maxLength={500} />
          <TextInput
            label="Client secret"
            type="password"
            autoComplete="off"
            value={form.clientSecret}
            onChange={(e) => set("clientSecret", e.target.value)}
            placeholder={saved?.hasSecret && !saved.secretUnreadable ? "Saved. Type a new one to replace it." : ""}
            hint={saved?.secretUnreadable ? "The saved secret can't be read any more (the app's secret key changed). Enter it again." : undefined}
          />
          <TextInput label="Email domain" value={form.domain} onChange={(e) => set("domain", e.target.value)} required placeholder="yourstudio.com" hint="Only addresses at this domain can sign in this way." />
          <CheckField label={`Let anyone with an @${form.domain || "yourstudio.com"} address join as a member`} checked={form.allowJoin} onChange={(v) => set("allowJoin", v)} hint="Off: only people already here, or invited, can sign in." />
          <CheckField label="Require it for everyone but admins" checked={form.requireSso} onChange={(v) => set("requireSso", v)} hint="Admins keep their password, so you can still get in if the provider is down." />
          <InlineError message={error} />
          <Flex align="center" gap="4" wrap="wrap">
            <SaveButton state={state}>{saved ? "Save single sign-on" : "Turn on single sign-on"}</SaveButton>
            {saved && <ActionButton type="button" variant="outline" color="gray" onClick={() => void turnOff()}>Turn off</ActionButton>}
            <SavedNote message={state.message} />
          </Flex>
        </Flex>
      </form>
    </SettingsSection>
  );
}
