import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Flex, Grid, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen } from "../a11y.tsx";
import { CustomFieldInputs, useCustomFields, type FieldValues } from "../customFields.tsx";
import { api, type Client, type Project, type ProjectTemplate, type Task } from "../api.ts";
import { templateSummary } from "./ProjectTemplates.tsx";
import { DueDate } from "./ProjectTasks.tsx";
import { Link, navigate } from "../router.tsx";
import { ActionButton, Card, CheckField, Empty, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowLink, RowMain, RowMenu, RowMenuItem, Rows, Select, SectionTitle, SrOnly, TextInput, actionStarted, useClearOnAction, useConfirm } from "../ui.tsx";

// Everyone sees the projects; admins and managers add, edit, archive and delete them.
export function Projects({ canManage }: { canManage: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  // Until the clients have loaded, an empty list means "not known yet", not "none".
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [myTasks, setMyTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, c, t] = await Promise.all([
        api<{ projects: Project[] }>("/api/projects"),
        api<{ clients: Client[] }>("/api/clients"),
        api<{ tasks: Task[] }>("/api/tasks?mine=1"),
      ]);
      setProjects(p.projects);
      setClients(c.clients);
      setClientsLoaded(true);
      setMyTasks(t.tasks);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(projects !== null, "Projects loaded.");

  const activeClients = clients.filter((c) => !c.archived);
  const active = projects?.filter((p) => !p.archived) ?? [];
  const archived = projects?.filter((p) => p.archived) ?? [];

  return (
    <>
      <PageHeader title="Projects" help="projects-and-tasks/projects" intro={canManage ? "What your team tracks time on. Billable sets the default for new entries." : "What your team tracks time on."} />
      <ErrorNote message={error} />
      {myTasks.length > 0 && (
        <section>
          <SectionTitle>Your open tasks</SectionTitle>
          <Card>
            <Rows>
              {myTasks.map((t) => (
                <Row key={t.id}>
                  <RowMain>
                    <Text as="p" size="2" weight="medium">
                      <Link to={`/projects/${t.projectId}/tasks`} className="wl-plain-link">{t.title}</Link>
                    </Text>
                    <Text as="p" size="2" color="gray">{t.project?.name}</Text>
                  </RowMain>
                  <Text size="2" color="gray"><DueDate task={t} /></Text>
                </Row>
              ))}
            </Rows>
          </Card>
        </section>
      )}
      {canManage && <NewProject clients={activeClients} clientsLoaded={clientsLoaded} />}

      {projects === null ? (
        <Loading />
      ) : (
        <>
          <Card>
            {active.length === 0 ? (
              <Empty>No projects yet.</Empty>
            ) : (
              <Rows>
                {active.map((p) => (
                  <ProjectRow key={p.id} project={p} canManage={canManage} onChange={load} />
                ))}
              </Rows>
            )}
          </Card>
          {archived.length > 0 && (
            <details className="wl-archived">
              <summary>Archived ({archived.length})</summary>
              <Card>
                <Rows>
                  {archived.map((p) => (
                    <ProjectRow key={p.id} project={p} canManage={canManage} onChange={load} />
                  ))}
                </Rows>
              </Card>
            </details>
          )}
        </>
      )}
    </>
  );
}

/** Pick a client for a project. A project whose client is archived keeps that client as a choice. */
export function ClientSelect({ clients, value, onChange, current, label = "Client" }: {
  clients: Client[]; value: string; onChange: (id: string) => void; current?: Project["client"]; label?: string;
}) {
  const list = current && !clients.some((c) => c.id === current.id) ? [...clients, { ...current, projectCount: 0 }] : clients;
  return (
    <Select
      label={label}
      value={value}
      onChange={onChange}
      options={[{ value: "", label: "No client" }, ...list.map((c) => ({ value: c.id, label: `${c.name}${c.archived ? " (archived)" : ""}` }))]}
    />
  );
}

function NewProject({ clients, clientsLoaded }: { clients: Client[]; clientsLoaded: boolean }) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [billable, setBillable] = useState(true);
  // Start from a template (WRK-150): its settings, team and tasks; the name and client are chosen here.
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const template = templates.find((t) => t.id === templateId) ?? null;
  // Required custom fields (WRK-148) are asked for here; the rest on the project's Settings.
  const required = useCustomFields("project").filter((f) => f.required);
  const [values, setValues] = useState<FieldValues>({});
  useEffect(() => {
    api<{ templates: ProjectTemplate[] }>("/api/project-templates").then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearOnAction(() => setError(null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fromTemplate = template && {
        templateId: template.id, billBy: template.billBy, hourlyRate: template.hourlyRate, fixedFee: template.fixedFee, feeByPhase: template.feeByPhase, budgetBy: template.budgetBy,
        budgetSeconds: template.budgetSeconds, budgetAmount: template.budgetAmount, everyone: template.everyone, memberIds: template.memberIds,
      };
      const { project } = await api<{ project: Project }>("/api/projects", { name, clientId: clientId || null, billable, ...fromTemplate, customFields: { ...(template?.customFields ?? {}), ...values } });
      navigate(`/projects/${project.id}/settings`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Flex direction="column" gap="3">
        <Grid columns={{ initial: "1", sm: "minmax(0, 1fr) minmax(0, 14rem) auto" }} gap="3" align="end">
          <TextInput label="Project name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} required maxLength={200} placeholder="Brand refresh" />
          <div>
            <ClientSelect clients={clients} value={clientId} onChange={setClientId} />
          </div>
          <ActionButton type="submit" busy={busy}>Add project</ActionButton>
        </Grid>
        {templates.length > 0 && (
          <div style={{ maxWidth: "24rem" }}>
            <Select
              label="Start from a template"
              value={templateId}
              onChange={(id) => {
                setTemplateId(id);
                const chosen = templates.find((t) => t.id === id);
                if (chosen) setBillable(chosen.billable);
              }}
              options={[{ value: "", label: "No template" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
              hint={template ? templateSummary(template) : "Its billing, rates, budget, team and tasks. You choose the name and client."}
            />
          </div>
        )}
        <CustomFieldInputs fields={required} values={{ ...(template?.customFields ?? {}), ...values }} onChange={setValues} />
        <Flex wrap="wrap" align="center" justify="between" gap="2">
          <CheckField label="Billable" checked={billable} onChange={setBillable} />
          <Text size="1" color="gray">
            {clientsLoaded && <Link to="/clients" className="wl-link wl-link-alone">{clients.length === 0 ? "No clients yet. Add one" : "Add or change clients"}</Link>}
          </Text>
        </Flex>
        {/* Found in the first real install: a billable project made without a client can't be invoiced. */}
        {clientsLoaded && billable && !clientId && (
          <Text size="1" color="gray">Billable time goes on a client's invoice, so choose a client for this project.</Text>
        )}
        <InlineError message={error} />
      </Flex>
    </form>
  );
}

function ProjectRow({ project, canManage, onChange }: { project: Project; canManage: boolean; onChange: () => Promise<void> }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>, done: string) {
    if (busy) return;
    actionStarted();
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChange();
      announce(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const restore = () => run(() => api(`/api/projects/${project.id}`, { archived: false }, "PATCH"), `${project.name} restored.`);
  async function archive() {
    const ok = await confirm({
      title: `Archive ${project.name}?`,
      description: "It leaves the list of projects people can track time on. Its time and invoices stay, and you can restore it any time.",
      confirm: "Archive",
      danger: false,
    });
    if (ok) void run(() => api(`/api/projects/${project.id}`, { archived: true }, "PATCH"), `${project.name} archived.`);
  }
  async function remove() {
    const ok = await confirm({
      title: `Delete ${project.name}?`,
      description: "This can't be undone. A project with time or expenses on it can't be deleted; archive it instead.",
      confirm: "Delete",
    });
    if (ok) void run(() => api(`/api/projects/${project.id}`, undefined, "DELETE"), `${project.name} deleted.`);
  }

  return (
    <Row>
      <RowMain>
        <Text as="p" size="2" weight="medium">
          <Link to={`/projects/${project.id}`} className="wl-plain-link">{project.name}</Link>
          {project.budgetAlertLevel === 80 && <> <Badge color="amber" variant="soft" size="1" className="wl-inline-badge">Over 80% of budget</Badge></>}
          {project.budgetAlertLevel === 100 && <> <Badge color="red" variant="soft" size="1" className="wl-inline-badge">Budget used</Badge></>}
        </Text>
        <Text as="p" size="2" color="gray">
          {project.client?.name ?? "No client"} · {project.billable ? "Billable" : "Non-billable"}
          {project.everyone === false && " · Chosen team"}
        </Text>
        <InlineError message={error} />
      </RowMain>
      {canManage && (
        <RowActions>
          {project.archived ? (
            <>
              <RowButton onClick={() => void restore()} busy={busy}>Restore<SrOnly> {project.name}</SrOnly></RowButton>
              <RowMenu label={`More actions for ${project.name}`}>
                <RowMenuItem danger disabled={busy} onSelect={() => void remove()}>Delete</RowMenuItem>
              </RowMenu>
            </>
          ) : (
            <>
              <RowLink to={`/projects/${project.id}/settings`}>Settings<SrOnly> for {project.name}</SrOnly></RowLink>
              <RowMenu label={`More actions for ${project.name}`}>
                <RowMenuItem disabled={busy} onSelect={() => void archive()}>Archive</RowMenuItem>
              </RowMenu>
            </>
          )}
        </RowActions>
      )}
    </Row>
  );
}
