import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { api, type ProjectTemplate } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { Card, Empty, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowMain, RowMenu, RowMenuItem, Rows, SaveButton, TextInput, actionStarted, useConfirm } from "../ui.tsx";

/** "Fixed fee · 2 tasks · 3 people", what a template sets, in a few words. */
export function templateSummary(t: ProjectTemplate) {
  const billing = !t.billable ? "Not billable" : t.fixedFee != null ? (t.feeByPhase ? "Fee per phase" : "Fixed fee") : t.billBy === "person" ? "People's own rates" : "Project hourly rate";
  const tasks = `${t.tasks.length} ${t.tasks.length === 1 ? "task" : "tasks"}`;
  const team = t.everyone ? "Everyone" : `${t.memberIds.length} ${t.memberIds.length === 1 ? "person" : "people"}`;
  return [billing, t.budgetBy === "hours" ? "Hours budget" : t.budgetBy === "fees" ? "Fees budget" : null, tasks, team].filter(Boolean).join(" · ");
}

// Manage → Templates (admins and managers, WRK-150): projects' settings saved to start new
// projects from. Saved from a project's Settings tab; used from "Start from a template".
export function ProjectTemplates({ role }: { role: string }) {
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api<{ templates: ProjectTemplate[] }>("/api/project-templates")).templates);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(templates !== null, "Templates loaded.");

  return (
    <>
      <PageHeader
        title="Templates"
        intro="Project settings saved to start new projects from. Changing or deleting a template doesn't change projects already made from it."
        help="projects-and-tasks/projects"
      />
      <ManageTabs role={role} />
      <ErrorNote message={error} />
      {templates === null ? (
        <Loading />
      ) : (
        <Card>
          {templates.length === 0 ? (
            <Empty>No templates yet. Open a project's Settings tab and choose Save as template.</Empty>
          ) : (
            <Rows>
              {templates.map((t) => (
                <TemplateRow key={t.id} template={t} onChange={load} onError={setError} />
              ))}
            </Rows>
          )}
        </Card>
      )}
    </>
  );
}

function TemplateRow({ template, onChange, onError }: { template: ProjectTemplate; onChange: () => Promise<void>; onError: (message: string | null) => void }) {
  const confirm = useConfirm();
  const editor = useEditor();
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (busy || name.trim() === template.name) return;
    actionStarted();
    setBusy(true);
    setRenameError(null);
    try {
      await api(`/api/project-templates/${template.id}`, { name }, "PATCH");
      editor.close(false);
      await onChange();
      announce("Saved.");
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete ${template.name}?`, description: "Projects made from it stay as they are.", confirm: "Delete" });
    if (!ok) return;
    actionStarted();
    onError(null);
    try {
      await api(`/api/project-templates/${template.id}`, undefined, "DELETE");
      await onChange();
      document.querySelector<HTMLElement>("main h1")?.focus();
      announce(`${template.name} deleted.`);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  if (editor.editing) {
    return (
      <Row editing>
        <form onSubmit={rename} aria-label={`Rename ${template.name}`} style={{ width: "100%" }}>
          <Flex direction="column" gap="3">
            <TextInput label="Template name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            <InlineError message={renameError} />
            <Flex align="center" justify="end" gap="3">
              <RowButton type="button" onClick={() => editor.close(false)}>Cancel</RowButton>
              <SaveButton state={{ dirty: name.trim() !== template.name, busy }}>Save</SaveButton>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  return (
    <Row>
      <RowMain>
        <Text as="p" size="2" weight="medium">{template.name}</Text>
        <Text as="p" size="1" color="gray">{templateSummary(template)}</Text>
      </RowMain>
      <RowActions>
        <RowMenu label={`More actions for ${template.name}`}>
          <RowMenuItem onSelect={() => { setName(template.name); setRenameError(null); editor.open(); }}>Rename</RowMenuItem>
          <RowMenuItem danger onSelect={() => void remove()}>Delete</RowMenuItem>
        </RowMenu>
      </RowActions>
    </Row>
  );
}
