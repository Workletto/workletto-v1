import { useState, type FormEvent } from "react";
import { Checkbox, Flex, Grid, Text } from "@radix-ui/themes";
import { announce, useEditor } from "../a11y.tsx";
import { api, type Task, type TaskStatus } from "../api.ts";
import { Link } from "../router.tsx";
import { formatDay, localToday } from "../timer.tsx";
import { ActionButton, Card, Empty, ErrorNote, InlineError, Row, RowActions, RowButton, RowMain, Rows, SectionTitle, Select, SrOnly, TextAreaInput, TextInput, actionStarted, useClearOnAction, useConfirm } from "../ui.tsx";

export const STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
const ORDER: TaskStatus[] = ["in_progress", "todo", "done"];
type Person = { id: string; name: string };

/** "Due 20 Oct" in red once it's past and still open. */
export function DueDate({ task }: { task: Task }) {
  if (!task.dueDate) return null;
  const late = task.status !== "done" && task.dueDate < localToday();
  return <Text color={late ? "red" : undefined}>Due {formatDay(task.dueDate, { day: "numeric", month: "short" })}{late ? " (overdue)" : ""}</Text>;
}

// A project's to-do list, grouped by status. Anyone on the project can change it.
export function ProjectTasks({ projectId, tasks, team, onChange, canManage }: {
  projectId: string; tasks: Task[]; team: Person[]; onChange: () => Promise<void>; canManage: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>) {
    actionStarted();
    setError(null);
    try {
      await work();
      await onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  return (
    <>
      <NewTask projectId={projectId} team={team} onCreated={onChange} />
      {canManage && (
        <Text as="p" size="2" color="gray">
          Tasks you use on every project live in <Link to="/manage/tasks" className="wl-link">Manage → Tasks</Link>.
        </Text>
      )}
      <ErrorNote message={error} />
      {tasks.length === 0 && (
        <Card>
          <Empty>No tasks yet. Add the first one above.</Empty>
        </Card>
      )}
      {ORDER.map((status) => {
        const group = tasks.filter((t) => t.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status}>
            <SectionTitle muted>{STATUS_LABELS[status]} <Text weight="regular">({group.length})</Text></SectionTitle>
            <Card>
              <Rows>
                {group.map((t) => (
                  <TaskRow key={t.id} task={t} team={team} run={run} />
                ))}
              </Rows>
            </Card>
          </section>
        );
      })}
    </>
  );
}

function NewTask({ projectId, team, onCreated }: {
  projectId: string; team: Person[]; onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useClearOnAction(() => setError(null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/tasks", { projectId, title, assigneeId: assigneeId || null, dueDate: dueDate || null });
      // Like the title and due date, the person starts empty for the next task.
      setTitle("");
      setAssigneeId("");
      setDueDate("");
      await onCreated();
      announce("Task added.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Flex direction="column" gap="3">
        <Grid columns={{ initial: "1", md: "minmax(0, 1fr) 11rem 10rem auto" }} gap="3" align="end">
          <TextInput label="New task" value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} required maxLength={200} placeholder="Homepage wireframes" />
          <div>
            <PersonSelect team={team} value={assigneeId} onChange={setAssigneeId} />
          </div>
          <TextInput label="Due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <ActionButton type="submit" busy={busy}>Add task</ActionButton>
        </Grid>
        <InlineError message={error} />
      </Flex>
    </form>
  );
}

function PersonSelect({ team, value, onChange }: { team: Person[]; value: string; onChange: (id: string) => void }) {
  return <Select label="Assigned to" value={value} onChange={onChange} options={[{ value: "", label: "Nobody" }, ...team.map((p) => ({ value: p.id, label: p.name }))]} />;
}

function TaskRow({ task, team, run }: {
  task: Task; team: Person[]; run: (work: () => Promise<unknown>) => Promise<boolean>;
}) {
  const editor = useEditor();
  const confirm = useConfirm();
  const [form, setForm] = useState({
    title: task.title,
    notes: task.notes,
    assigneeId: task.assignee?.id ?? "",
    dueDate: task.dueDate ?? "",
  });
  const patch = (body: Record<string, unknown>) => run(() => api(`/api/tasks/${task.id}`, body, "PATCH"));
  // Someone assigned earlier may have left the team; keep them as a choice.
  const people = task.assignee && !team.some((p) => p.id === task.assignee!.id) ? [...team, task.assignee] : team;

  async function remove() {
    const ok = await confirm({ title: `Delete the task ${task.title}?`, description: "Time tracked on it stays on the project. This can't be undone.", confirm: "Delete" });
    if (!ok) return;
    if (await run(() => api(`/api/tasks/${task.id}`, undefined, "DELETE"))) announce("Task deleted.");
  }

  if (editor.editing) {
    return (
      <Row editing>
        <form
          style={{ width: "100%" }}
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ ...form, assigneeId: form.assigneeId || null, dueDate: form.dueDate || null }).then(() => editor.close());
          }}
        >
          <Flex direction="column" gap="3">
            <TextInput label="Task" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} />
            <TextAreaInput label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} maxLength={5000} />
            <Flex wrap="wrap" align="end" gap="3">
              <div style={{ width: "12rem" }}>
                <PersonSelect team={people} value={form.assigneeId} onChange={(assigneeId) => setForm({ ...form, assigneeId })} />
              </div>
              <div style={{ width: "10rem" }}>
                <TextInput label="Due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
            </Flex>
            <Flex align="center" gap="3">
              <RowButton type="button" danger onClick={() => void remove()}>Delete<SrOnly> {task.title}</SrOnly></RowButton>
              <Flex align="center" gap="3" ml="auto">
                <RowButton type="button" onClick={() => editor.close()}>Cancel</RowButton>
                <ActionButton type="submit">Save</ActionButton>
              </Flex>
            </Flex>
          </Flex>
        </form>
      </Row>
    );
  }

  const done = task.status === "done";
  return (
    <Row>
      <Flex align="center">
        <Checkbox checked={done} onCheckedChange={() => void patch({ status: done ? "todo" : "done" })} aria-label={done ? `Mark ${task.title} as not done` : `Mark ${task.title} as done`} />
      </Flex>
      <RowMain>
        <Text as="p" size="2" weight={done ? "regular" : "medium"} color={done ? "gray" : undefined} style={done ? { textDecoration: "line-through" } : undefined}>{task.title}</Text>
        <Text as="p" size="2" color="gray">
          {task.assignee?.name ?? "Unassigned"}
          {task.dueDate && <> · <DueDate task={task} /></>}
        </Text>
        {task.notes && <Text as="p" size="1" color="gray" style={{ overflowWrap: "anywhere" }}>{task.notes}</Text>}
      </RowMain>
      <RowActions>
        {!done && (
          <Select
            aria-label={`Status of ${task.title}`}
            size="2"
            value={task.status}
            onChange={(status) => void patch({ status })}
            options={(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          />
        )}
        <RowButton ref={editor.openerRef} onClick={editor.open}>Edit<SrOnly> {task.title}</SrOnly></RowButton>
      </RowActions>
    </Row>
  );
}
