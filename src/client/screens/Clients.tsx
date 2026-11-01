import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Flex, Grid, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { CustomFieldInputs, changedValues, useCustomFields, type FieldValues } from "../customFields.tsx";
import { api, type Client } from "../api.ts";
import { ActionButton, Card, Empty, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowMain, RowMenu, RowMenuItem, Rows, SaveButton, Select, SrOnly, TextAreaInput, TextInput, actionStarted, useClearOnAction, useConfirm } from "../ui.tsx";
import { CURRENCIES } from "../../shared/money.ts";

// Clients (admins and managers): the companies your projects are for, and the
// currency each is billed in. `home` is the organization's currency.
export function Clients({ home }: { home: string }) {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ clients: Client[]; exchangeRates: Record<string, string> }>("/api/clients");
      setClients(r.clients);
      setRates(r.exchangeRates);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(clients !== null, "Clients loaded.");

  const active = clients?.filter((c) => !c.archived) ?? [];
  const archived = clients?.filter((c) => c.archived) ?? [];

  return (
    <>
      <PageHeader title="Clients" intro="The companies you work for." help="clients/add-and-manage-clients" />
      <ErrorNote message={error} />
      <NewClient onCreated={load} />
      {clients === null ? (
        <Loading />
      ) : (
        <>
          <Card>
            {active.length === 0 ? (
              <Empty>No clients yet. Add the first one above.</Empty>
            ) : (
              <Rows>{active.map((c) => <ClientRow key={c.id} client={c} home={home} rates={rates} onChange={load} />)}</Rows>
            )}
          </Card>
          {archived.length > 0 && (
            <details className="wl-archived">
              <summary>Archived ({archived.length})</summary>
              <Text as="p" size="2" color="gray" mb="3">Archived clients stay on their projects but can't be picked for new ones.</Text>
              <Card>
                <Rows>{archived.map((c) => <ClientRow key={c.id} client={c} home={home} rates={rates} onChange={load} />)}</Rows>
              </Card>
            </details>
          )}
        </>
      )}
    </>
  );
}

function NewClient({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  // Required custom fields (WRK-148) are asked for here; the rest when the client is edited.
  const required = useCustomFields("client").filter((f) => f.required);
  const [values, setValues] = useState<FieldValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearOnAction(() => setError(null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/clients", { name, customFields: values });
      setName("");
      setValues({});
      await onCreated();
      announce("Client added.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: "30rem" }}>
      <Flex direction="column" gap="3">
        <Grid columns="minmax(0, 1fr) auto" gap="3" align="end">
          <TextInput label="Client name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} required maxLength={200} placeholder="Northwind Coffee" />
          <ActionButton type="submit" busy={busy}>Add client</ActionButton>
        </Grid>
        <CustomFieldInputs fields={required} values={values} onChange={setValues} />
        <InlineError message={error} />
      </Flex>
    </form>
  );
}

function ClientRow({ client, home, rates, onChange }: { client: Client; home: string; rates: Record<string, string>; onChange: () => Promise<void> }) {
  const editor = useEditor();
  const confirm = useConfirm();
  const [form, setForm] = useState({ name: client.name, email: client.email, address: client.address, currency: client.currency, exchangeRate: rates[client.currency] ?? "" });
  const fields = useCustomFields("client");
  const [values, setValues] = useState<FieldValues>(client.customFields ?? {});
  const changedFields = changedValues(fields, values, client.customFields ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Another currency needs its exchange rate, for reports: the one already set, or typed here.
  const foreign = form.currency !== home;
  const knownRate = rates[form.currency] ?? "";
  const dirty =
    form.name !== client.name || form.email !== client.email || form.address !== client.address || form.currency !== client.currency || (foreign && form.exchangeRate !== knownRate) ||
    Object.keys(changedFields).length > 0;

  async function run(work: () => Promise<unknown>, done?: string) {
    if (busy) return;
    actionStarted();
    setBusy(true);
    setError(null);
    try {
      await work();
      editor.close();
      await onChange();
      if (done) announce(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    const { exchangeRate, ...details } = form;
    const body = { ...details, ...(foreign && exchangeRate !== knownRate ? { exchangeRate } : {}), ...(Object.keys(changedFields).length ? { customFields: changedFields } : {}) };
    void run(() => api(`/api/clients/${client.id}`, body, "PATCH"), "Client saved.");
  };
  const restore = () => void run(() => api(`/api/clients/${client.id}`, { archived: false }, "PATCH"), `${client.name} restored.`);
  async function archive() {
    const ok = await confirm({
      title: `Archive ${client.name}?`,
      description: "Its projects keep it, but it can't be picked for new projects. You can restore it any time.",
      confirm: "Archive",
      danger: false,
    });
    if (ok) void run(() => api(`/api/clients/${client.id}`, { archived: true }, "PATCH"), `${client.name} archived.`);
  }
  async function remove() {
    const ok = await confirm({ title: `Delete ${client.name}?`, description: "This can't be undone.", confirm: "Delete" });
    if (ok) void run(() => api(`/api/clients/${client.id}`, undefined, "DELETE"), `${client.name} deleted.`);
  }

  if (editor.editing) {
    return (
      <Row editing>
        <form onSubmit={save} style={{ width: "100%" }}>
          <Flex direction="column" gap="3">
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <TextInput label="Name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} />
              <TextInput label="Billing email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={254} />
            </Grid>
            <TextAreaInput label="Address (printed on invoices)" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={3} maxLength={500} />
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <Select
                label="Billed in"
                value={form.currency}
                onChange={(currency) => setForm({ ...form, currency, exchangeRate: rates[currency] ?? "" })}
                options={CURRENCIES.map((c) => ({ value: c, label: c === home ? `${c} (your currency)` : c }))}
                hint="Its projects' rates, its expenses and its invoices are in this currency."
              />
              {foreign && (
                <TextInput
                  label={`1 ${form.currency} is worth`}
                  value={form.exchangeRate}
                  onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })}
                  inputMode="decimal"
                  placeholder="1.08"
                  suffix={home}
                  className="wl-num"
                  hint={`Reports use this to add ${form.currency} amounts to yours. Invoices aren't converted.`}
                />
              )}
            </Grid>
            <CustomFieldInputs fields={fields} values={values} onChange={setValues} />
            <InlineError message={error} />
            <Flex align="center" justify="end" gap="3">
              <RowButton type="button" onClick={() => editor.close()}>Cancel</RowButton>
              <SaveButton state={{ dirty, busy }}>Save</SaveButton>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  return (
    <Row>
      <RowMain>
        <Text as="p" size="2" weight="medium" color={client.archived ? "gray" : undefined}>{client.name}</Text>
        <Text as="p" size="2" color="gray" className="wl-wrap">
          {client.projectCount === 1 ? "1 project" : `${client.projectCount} projects`}
          {client.currency !== home && ` · Billed in ${client.currency}`}
          {client.email && ` · ${client.email}`}
        </Text>
        <InlineError message={error} />
      </RowMain>
      <RowActions>
        {client.archived ? (
          <>
            <RowButton onClick={restore} busy={busy}>Restore<SrOnly> {client.name}</SrOnly></RowButton>
            {client.projectCount === 0 && (
              <RowMenu label={`More actions for ${client.name}`}>
                <RowMenuItem danger disabled={busy} onSelect={() => void remove()}>Delete</RowMenuItem>
              </RowMenu>
            )}
          </>
        ) : (
          <>
            <RowButton ref={editor.openerRef} onClick={editor.open}>Edit<SrOnly> {client.name}</SrOnly></RowButton>
            <RowMenu label={`More actions for ${client.name}`}>
              <RowMenuItem disabled={busy} onSelect={() => void archive()}>Archive</RowMenuItem>
            </RowMenu>
          </>
        )}
      </RowActions>
    </Row>
  );
}
