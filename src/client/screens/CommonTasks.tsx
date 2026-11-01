import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { announce, useAnnounceWhen, useEditor } from "../a11y.tsx";
import { api } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, Card, CheckField, Empty, ErrorNote, InlineError, Loading, PageHeader, Row, RowActions, RowButton, RowMain, RowMenu, RowMenuItem, Rows, SaveButton, SectionTitle, TextInput, actionStarted, useClearOnAction, useConfirm } from "../ui.tsx";

type CommonTask = { id: string; title: string; addToNewProjects: boolean };

// Manage → Tasks (admins and managers): the kinds of work the whole team tracks time against.
// Each project has its own copy of a task, so nothing here changes a project that already exists.
export function CommonTasks({ role }: { role: string }) {
  const [tasks, setTasks] = useState<CommonTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTasks((await api<{ tasks: CommonTask[] }>("/api/common-tasks")).tasks);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAnnounceWhen(tasks !== null, "Tasks loaded.");

  const common = tasks?.filter((t) => t.addToNewProjects) ?? [];
  const other = tasks?.filter((t) => !t.addToNewProjects) ?? [];
  const say = (text: string) => {
    setMessage(text);
    announce(text);
  };
  // Starting another action clears the last one's message and error.
  const clearOr = (error: string | null) => {
    setError(error);
    if (error === null) setMessage(null);
  };

  return (
    <>
      <PageHeader
        title="Tasks"
        intro="The kinds of work your team tracks time against. Each project has its own copy, so changes here don't change existing projects."
        help="projects-and-tasks/company-wide-tasks"
      />
      <ManageTabs role={role} />
      <ErrorNote message={error} />
      <NewTask onCreated={async () => { setMessage(null); await load(); }} />
      {message && <Text as="p" size="2">{message}</Text>}
      {tasks === null ? (
        <Loading />
      ) : tasks.length === 0 ? (
        <Card>
          <Empty>No tasks yet. Add the kinds of work you do, like Design or Project management.</Empty>
        </Card>
      ) : (
        <>
          <TaskGroup title="Common tasks" description="Added to every new project." tasks={common} onChange={load} onMessage={say} onError={clearOr} />
          <TaskGroup title="Other tasks" description="Added to projects only when you choose." tasks={other} onChange={load} onMessage={say} onError={clearOr} />
        </>
      )}
    </>
  );
}

function NewTask({ onCreated }: { onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [common, setCommon] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearOnAction(() => setError(null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/common-tasks", { title, addToNewProjects: common });
      setTitle("");
      await onCreated();
      announce("Task added.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a task">
      <Flex direction="column" gap="3">
        <Flex wrap="wrap" align="end" gap="3">
          <div style={{ flex: "1 1 16rem", maxWidth: "30rem" }}>
            <TextInput label="Task name" value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} required maxLength={200} placeholder="Design" />
          </div>
          <ActionButton type="submit" busy={busy}>Add task</ActionButton>
        </Flex>
        <CheckField label="Add to new projects" checked={common} onChange={setCommon} />
        <InlineError message={error} />
      </Flex>
    </form>
  );
}

function TaskGroup({ title, description, tasks, onChange, onMessage, onError }: {
  title: string; description: string; tasks: CommonTask[]; onChange: () => Promise<void>; onMessage: (text: string) => void; onError: (message: string | null) => void;
}) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <Text as="p" size="2" color="gray" mb="2">{description}</Text>
      <Card>
        {tasks.length === 0 ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <Rows>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onChange={onChange} onMessage={onMessage} onError={onError} />
            ))}
          </Rows>
        )}
      </Card>
    </section>
  );
}

function TaskRow({ task, onChange, onMessage, onError }: { task: CommonTask; onChange: () => Promise<void>; onMessage: (text: string) => void; onError: (message: string | null) => void }) {
  const confirm = useConfirm();
  const editor = useEditor();
  const [title, setTitle] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // `rowMoves`: the row moves to the other group or goes, taking the focused menu with it,
  // so focus goes to the page heading instead of the page itself.
  async function run(work: () => Promise<void>, rowMoves = false) {
    actionStarted();
    onError(null);
    try {
      await work();
      await onChange();
      if (rowMoves) document.querySelector<HTMLElement>("main h1")?.focus();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (busy || title.trim() === task.title) return;
    actionStarted();
    setBusy(true);
    setRenameError(null);
    try {
      await api(`/api/common-tasks/${task.id}`, { title }, "PATCH");
      editor.close(false);
      await onChange();
      announce("Saved.");
    } catch (e) {
      setRenameError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addToProjects() {
    await run(async () => {
      const { added } = await api<{ added: number }>(`/api/common-tasks/${task.id}/add-to-projects`, {});
      onMessage(added === 0 ? "Every active project already has it." : `Added to ${added} ${added === 1 ? "project" : "projects"}.`);
    });
  }

  async function remove() {
    const ok = await confirm({ title: `Delete ${task.title}?`, description: "Projects keep their own copy.", confirm: "Delete" });
    if (!ok) return;
    await run(async () => {
      await api(`/api/common-tasks/${task.id}`, undefined, "DELETE");
      announce(`${task.title} deleted.`);
    }, true);
  }

  if (editor.editing) {
    return (
      <Row editing>
        <form onSubmit={rename} aria-label={`Rename ${task.title}`} style={{ width: "100%" }}>
          <Flex direction="column" gap="3">
            <TextInput label="Task name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            <InlineError message={renameError} />
            <Flex align="center" justify="end" gap="3">
              <RowButton type="button" onClick={() => editor.close(false)}>Cancel</RowButton>
              <SaveButton state={{ dirty: title.trim() !== task.title, busy }}>Save</SaveButton>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  return (
    <Row>
      <RowMain>
        <Text as="p" size="2" weight="medium">{task.title}</Text>
      </RowMain>
      <RowActions>
        <RowMenu label={`More actions for ${task.title}`}>
          <RowMenuItem onSelect={() => { setTitle(task.title); setRenameError(null); editor.open(); }}>Rename</RowMenuItem>
          <RowMenuItem onSelect={() => void run(() => api(`/api/common-tasks/${task.id}`, { addToNewProjects: !task.addToNewProjects }, "PATCH").then(() => announce(task.addToNewProjects ? "Not added to new projects." : "Added to new projects.")), true)}>
            {task.addToNewProjects ? "Stop adding to new projects" : "Make common"}
          </RowMenuItem>
          <RowMenuItem onSelect={() => void addToProjects()}>Add to all projects</RowMenuItem>
          <RowMenuItem danger onSelect={() => void remove()}>Delete</RowMenuItem>
        </RowMenu>
      </RowActions>
    </Row>
  );
}
