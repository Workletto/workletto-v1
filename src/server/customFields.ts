import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { readBody, readName, requireAdmin, type SignedIn } from "./http.ts";
import { recordAudit } from "./audit.ts";

// Custom fields (WRK-148): admins add their own fields to time entries, projects or clients, as
// text, a number or a list of choices, optionally required. The forms for those records fill
// them in (customFields in their bodies), reports filter and group by a list field, and the CSV
// exports add a column for each. A field is never deleted: removing it hides it and keeps its
// values, and it can be restored.

export const KINDS = ["time", "project", "client"] as const;
export type FieldKind = (typeof KINDS)[number];
const TYPES = ["text", "choice", "number"] as const;
type FieldType = (typeof TYPES)[number];

export const FIELD_SELECT = { id: true, name: true, appliesTo: true, type: true, choices: true, required: true, archivedAt: true } as const;
type FieldRow = { id: string; name: string; appliesTo: FieldKind; type: FieldType; choices: string[]; required: boolean; archivedAt: Date | null };
const toField = ({ archivedAt, ...f }: FieldRow) => ({ ...f, archived: archivedAt !== null });

const MAX_TEXT = 500;
const MAX_CHOICES = 50;
const NUMBER = /^-?\d{1,12}(\.\d{1,4})?$/;
/** Which value column a kind's records use. */
export const COLUMN = { time: "timeEntryId", project: "projectId", client: "clientId" } as const;

/** The fields in use for a kind of record, in the order they were added. */
export function activeFields(db: OrgDb, kind: FieldKind) {
  return db.customField.findMany({ where: { appliesTo: kind, archivedAt: null }, select: FIELD_SELECT, orderBy: { createdAt: "asc" } }) as Promise<FieldRow[]>;
}

/** A value as stored, or null for none, or an error about it. */
function readValue(field: FieldRow, raw: unknown): string | null | { error: string } {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && field.type === "number") raw = String(raw);
  if (typeof raw !== "string") return { error: `Enter ${field.name} as text.` };
  const value = raw.trim();
  if (!value) return null;
  if (field.type === "text") return value.length <= MAX_TEXT ? value : { error: `Keep ${field.name} to ${MAX_TEXT} characters.` };
  if (field.type === "number") return NUMBER.test(value.replace(/,/g, "")) ? value.replace(/,/g, "") : { error: `Enter ${field.name} as a number, like 12 or 12.5.` };
  return field.choices.includes(value) ? value : { error: `Choose one of the ${field.name} options.` };
}

export type FieldValues = Map<string, string | null>;

/**
 * Reads `customFields` ({ fieldId: value }) from a record's body. Only fields in use for this kind
 * count. Creating, every required field needs a value; changing, a required one can't be emptied.
 * Records made by imports don't come through here.
 */
export async function readCustomFields(db: OrgDb, kind: FieldKind, body: Record<string, unknown>, creating: boolean): Promise<FieldValues | { error: string }> {
  const raw = body.customFields;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return { error: "Custom fields must be a list of values." };
  const given = (raw ?? {}) as Record<string, unknown>;
  const values: FieldValues = new Map();
  for (const field of await activeFields(db, kind)) {
    if (!creating && !(field.id in given)) continue;
    const value = readValue(field, given[field.id]);
    if (value !== null && typeof value === "object") return value;
    if (value === null && field.required) return { error: `Fill in ${field.name}: it's required.` };
    values.set(field.id, value);
  }
  return values;
}

/** Saves the values read by readCustomFields on one record. */
export async function saveCustomFields(db: OrgDb, kind: FieldKind, recordId: string, values: FieldValues) {
  const column = COLUMN[kind];
  for (const [fieldId, value] of values) {
    if (value === null) {
      await db.customFieldValue.deleteMany({ where: { fieldId, [column]: recordId } });
      continue;
    }
    const { count } = await db.customFieldValue.updateMany({ where: { fieldId, [column]: recordId }, data: { value } });
    if (!count) {
      const row = { fieldId, [column]: recordId, value };
      await db.customFieldValue.create({ data: row as typeof row & { fieldId: string; value: string; organizationId: string }, select: { id: true } });
    }
  }
}

/** The values of the fields in use on these records: recordId → { fieldId: value }. */
export async function customValues(db: OrgDb, kind: FieldKind, ids: string[], includeArchived = false): Promise<Map<string, Record<string, string>>> {
  const column = COLUMN[kind];
  const out = new Map<string, Record<string, string>>();
  if (!ids.length) return out;
  const rows = await db.customFieldValue.findMany({
    where: { [column]: { in: ids }, ...(includeArchived ? {} : { field: { archivedAt: null } }) },
    select: { fieldId: true, value: true, timeEntryId: true, projectId: true, clientId: true },
  });
  for (const row of rows) {
    const id = row[column]!;
    out.set(id, { ...(out.get(id) ?? {}), [row.fieldId]: row.value });
  }
  return out;
}

/** The choices of a list field, cleaned up: trimmed, without blanks or repeats. */
function readChoices(value: unknown): string[] | { error: string } {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n|,/) : null;
  if (!list || !list.every((c) => typeof c === "string")) return { error: "Enter the choices, one per line." };
  const choices = [...new Set((list as string[]).map((c) => c.trim()).filter(Boolean))];
  if (!choices.length) return { error: "Enter at least one choice, one per line." };
  if (choices.length > MAX_CHOICES || choices.some((c) => c.length > 100)) return { error: `Keep it to ${MAX_CHOICES} choices of up to 100 characters.` };
  return choices;
}

const KIND_LABEL = { time: "time entries", project: "projects", client: "clients" } as const;
const describe = (f: FieldRow) => `${f.name} (${f.type === "choice" ? `list: ${f.choices.join(", ")}` : f.type}, on ${KIND_LABEL[f.appliesTo]}${f.required ? ", required" : ""})`;

async function nameTaken(db: OrgDb, kind: FieldKind, name: string, exceptId?: string) {
  return !!(await db.customField.findFirst({ where: { appliesTo: kind, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));
}

export const customFieldRoutes = new Hono<SignedIn>()
  // Everyone fills in the fields in use; admins also see removed ones (?all=1) to restore them.
  .get("/", async (c) => {
    const all = c.req.query("all") === "1" && c.get("user").role === "admin";
    const rows = await c.get("db").customField.findMany({ where: all ? {} : { archivedAt: null }, select: FIELD_SELECT, orderBy: { createdAt: "asc" } });
    return c.json({ fields: (rows as FieldRow[]).map(toField) });
  })
  // { name, appliesTo, type, choices?, required }
  .post("/", requireAdmin("add custom fields"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const name = readName(body.name);
    if (!name || name.length > 60) return c.json({ error: "Enter a field name of up to 60 characters." }, 400);
    if (!KINDS.includes(body.appliesTo as FieldKind)) return c.json({ error: "Choose where the field goes: time entries, projects or clients." }, 400);
    if (!TYPES.includes(body.type as FieldType)) return c.json({ error: "Choose text, a number or a list of choices." }, 400);
    const kind = body.appliesTo as FieldKind;
    const type = body.type as FieldType;
    const choices = type === "choice" ? readChoices(body.choices) : [];
    if (!Array.isArray(choices)) return c.json(choices, 400);
    if (body.required !== undefined && typeof body.required !== "boolean") return c.json({ error: "Say whether the field is required." }, 400);
    if (await nameTaken(db, kind, name)) return c.json({ error: `There's already a field called ${name} on ${KIND_LABEL[kind]}.` }, 409);
    const field = await db.$transaction(async (tx) => {
      const data = { name, appliesTo: kind, type, choices, required: body.required === true };
      const row = (await tx.customField.create({ data: data as typeof data & { organizationId: string }, select: FIELD_SELECT })) as FieldRow;
      await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "created", label: "Custom field", changes: [{ field: "customField", from: null, to: describe(row) }] });
      return row;
    });
    return c.json({ field: toField(field) }, 201);
  })
  // { name?, choices?, required?, archived? }. The type and where it goes stay as they are.
  .patch("/:id", requireAdmin("change custom fields"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const field = (await db.customField.findFirst({ where: { id: c.req.param("id") }, select: FIELD_SELECT })) as FieldRow | null;
    if (!field) return c.json({ error: "Field not found." }, 404);
    const data: { name?: string; choices?: string[]; required?: boolean; archivedAt?: Date | null } = {};
    if ("name" in body) {
      const name = readName(body.name);
      if (!name || name.length > 60) return c.json({ error: "Enter a field name of up to 60 characters." }, 400);
      if (await nameTaken(db, field.appliesTo, name, field.id)) return c.json({ error: `There's already a field called ${name} on ${KIND_LABEL[field.appliesTo]}.` }, 409);
      data.name = name;
    }
    if ("choices" in body) {
      if (field.type !== "choice") return c.json({ error: "Only a list field has choices." }, 400);
      const choices = readChoices(body.choices);
      if (!Array.isArray(choices)) return c.json(choices, 400);
      // A choice already used on records stays, so their values keep making sense.
      const used = await db.customFieldValue.findMany({ where: { fieldId: field.id, value: { notIn: choices } }, select: { value: true }, distinct: ["value"] });
      if (used.length) return c.json({ error: `${used.map((u) => u.value).join(", ")} is still used. Keep it in the list.` }, 409);
      data.choices = choices;
    }
    if ("required" in body) {
      if (typeof body.required !== "boolean") return c.json({ error: "Say whether the field is required." }, 400);
      data.required = body.required;
    }
    if ("archived" in body) {
      if (typeof body.archived !== "boolean") return c.json({ error: "Say whether the field is removed." }, 400);
      if (body.archived !== (field.archivedAt !== null)) data.archivedAt = body.archived ? new Date() : null;
    }
    const updated = await db.$transaction(async (tx) => {
      await tx.customField.updateMany({ where: { id: field.id }, data });
      const row = (await tx.customField.findFirstOrThrow({ where: { id: field.id }, select: FIELD_SELECT })) as FieldRow;
      const status = (f: FieldRow) => `${describe(f)}${f.archivedAt ? ", removed" : ""}`;
      if (status(row) !== status(field)) {
        await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "changed", label: "Custom field", changes: [{ field: "customField", from: status(field), to: status(row) }] });
      }
      return row;
    });
    return c.json({ field: toField(updated) });
  });
