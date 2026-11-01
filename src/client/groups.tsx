import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Flex, Grid, Text } from "@radix-ui/themes";
import { announce } from "./a11y.tsx";
import { api, type Member } from "./api.ts";
import { ActionButton, ArticleLink, Card, CheckField, Empty, InlineError, Row, RowActions, RowButton, RowMain, Rows, SectionTitle, Select, SrOnly, TextInput, useConfirm } from "./ui.tsx";

// User groups (WRK-149): teams or departments that filter the Team page, the Schedule, Approvals
// and Reports. They never change what anyone can see or do.

export type Group = { id: string; name: string; memberIds: string[] };

/** The organization's groups (admins and managers), and a way to fetch them again. */
export function useGroups(): { groups: Group[]; reload: () => Promise<void> } {
  const [groups, setGroups] = useState<Group[]>([]);
  const reload = useCallback(async () => {
    setGroups((await api<{ groups: Group[] }>("/api/groups").catch(() => ({ groups: [] }))).groups);
  }, []);
  useEffect(() => void reload(), [reload]);
  return { groups, reload };
}

/** "All groups" or one group; shown only once the organization has groups. */
export function GroupFilter({ groups, value, onChange }: { groups: Group[]; value: string; onChange: (id: string) => void }) {
  if (!groups.length) return null;
  return (
    <div style={{ width: "14rem", maxWidth: "100%" }}>
      <Select label="Group" value={value} onChange={onChange} options={[{ value: "", label: "All groups" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
    </div>
  );
}

/** The Team page's Groups section, for admins: make, rename and delete groups, and choose who's in each. */
export function GroupsManager({ groups, onChange }: { groups: Group[]; onChange: () => Promise<void> }) {
  const confirm = useConfirm();
  const [people, setPeople] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; memberIds: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ members: Member[] }>("/api/members").then((r) => setPeople(r.members.filter((m) => m.active))).catch(() => undefined);
  }, []);

  async function run(work: () => Promise<unknown>, done: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChange();
      announce(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(() => api("/api/groups", { name }), `Group ${name.trim()} added.`)) setName("");
  }

  async function remove(group: Group) {
    const ok = await confirm({ title: `Delete the group ${group.name}?`, description: "Only the group is deleted. Its people stay, with their time and projects.", confirm: "Delete group" });
    if (ok) await run(() => api(`/api/groups/${group.id}`, undefined, "DELETE"), `Group ${group.name} deleted.`);
  }

  const names = new Map(people.map((p) => [p.id, p.name]));
  return (
    <section aria-label="Groups">
      <SectionTitle>Groups</SectionTitle>
      <Text as="p" size="2" color="gray" mb="2">
        Teams or departments, to filter this page, the Schedule, Approvals and Reports. They don't change what anyone can see or do.{" "}
        <ArticleLink article="team-and-permissions/user-groups">About groups</ArticleLink>
      </Text>
      <Card>
        {groups.length === 0 ? (
          <Empty>No groups yet.</Empty>
        ) : (
          <Rows>
            {groups.map((g) =>
              editing?.id === g.id ? (
                <Row key={g.id} editing>
                  <form
                    aria-label={`Change the group ${g.name}`}
                    style={{ width: "100%" }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(() => api(`/api/groups/${g.id}`, { name: editing.name, memberIds: [...editing.memberIds] }, "PATCH"), `Group ${editing.name.trim()} saved.`).then((ok) => ok && setEditing(null));
                    }}
                  >
                    <Flex direction="column" gap="3">
                      <div style={{ maxWidth: "20rem" }}><TextInput label="Group name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={60} required /></div>
                      <Grid columns={{ initial: "1", sm: "repeat(3, minmax(0, 1fr))" }} gap="2" role="group" aria-label="People in the group">
                        {people.map((p) => (
                          <CheckField
                            key={p.id}
                            label={p.name}
                            checked={editing.memberIds.has(p.id)}
                            onChange={(checked) => {
                              const next = new Set(editing.memberIds);
                              if (checked) next.add(p.id);
                              else next.delete(p.id);
                              setEditing({ ...editing, memberIds: next });
                            }}
                          />
                        ))}
                      </Grid>
                      <Flex gap="3" justify="end">
                        <RowButton onClick={() => setEditing(null)}>Cancel</RowButton>
                        <ActionButton type="submit" busy={busy}>Save group</ActionButton>
                      </Flex>
                    </Flex>
                  </form>
                </Row>
              ) : (
                <Row key={g.id}>
                  <RowMain>
                    <Text as="p" size="2" weight="medium">{g.name}</Text>
                    <Text as="p" size="1" color="gray">
                      {g.memberIds.length === 0 ? "No one yet" : g.memberIds.map((id) => names.get(id)).filter(Boolean).join(", ")}
                    </Text>
                  </RowMain>
                  <RowActions>
                    <RowButton onClick={() => setEditing({ id: g.id, name: g.name, memberIds: new Set(g.memberIds) })}>Change<SrOnly> {g.name}</SrOnly></RowButton>
                    <RowButton danger onClick={() => void remove(g)}>Delete<SrOnly> {g.name}</SrOnly></RowButton>
                  </RowActions>
                </Row>
              ),
            )}
          </Rows>
        )}
      </Card>
      <form onSubmit={add} aria-label="Add a group" style={{ marginTop: "var(--space-3)" }}>
        <Flex wrap="wrap" align="end" gap="3">
          <div style={{ flex: "1 1 14rem", maxWidth: "20rem" }}><TextInput label="New group" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Design" /></div>
          <ActionButton type="submit" busy={busy} disabled={!name.trim()}>Add group</ActionButton>
        </Flex>
      </form>
      <InlineError message={error} />
    </section>
  );
}
