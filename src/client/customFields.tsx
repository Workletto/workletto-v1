import { useEffect, useState } from "react";
import { Flex } from "@radix-ui/themes";
import { api } from "./api.ts";
import { Select, TextInput } from "./ui.tsx";

// Custom fields (WRK-148): an admin's own fields on time entries, projects and clients
// (Manage → Settings), filled in by the forms for those records.

export type FieldKind = "time" | "project" | "client";
export type CustomField = { id: string; name: string; appliesTo: FieldKind; type: "text" | "choice" | "number"; choices: string[]; required: boolean; archived: boolean };
/** A record's values, by field id. */
export type FieldValues = Record<string, string>;

// Fetched once per page load and shared by every form; settings changes start a new fetch.
let cache: Promise<CustomField[]> | null = null;
export function forgetCustomFields() {
  cache = null;
}

/** The fields in use for one kind of record. */
export function useCustomFields(kind: FieldKind): CustomField[] {
  const [fields, setFields] = useState<CustomField[]>([]);
  useEffect(() => {
    cache ??= api<{ fields: CustomField[] }>("/api/custom-fields").then((r) => r.fields).catch(() => {
      cache = null;
      return [];
    });
    let live = true;
    void cache.then((all) => live && setFields(all.filter((f) => f.appliesTo === kind)));
    return () => {
      live = false;
    };
  }, [kind]);
  return fields;
}

/** The values that differ from `before`, to send as `customFields` ("" empties one). */
export function changedValues(fields: CustomField[], values: FieldValues, before: FieldValues): FieldValues {
  return Object.fromEntries(fields.filter((f) => (values[f.id] ?? "") !== (before[f.id] ?? "")).map((f) => [f.id, values[f.id] ?? ""]));
}

/** One input per field: a box for text and numbers, a list for choices. */
export function CustomFieldInputs({ fields, values, onChange }: { fields: CustomField[]; values: FieldValues; onChange: (values: FieldValues) => void }) {
  if (!fields.length) return null;
  const set = (id: string, value: string) => onChange({ ...values, [id]: value });
  return (
    <Flex wrap="wrap" align="start" gap="3">
      {fields.map((f) => (
        <div key={f.id} style={{ flex: "1 1 11rem", maxWidth: "16rem" }}>
          {f.type === "choice" ? (
            <Select
              label={f.name}
              value={values[f.id] ?? ""}
              onChange={(v) => set(f.id, v)}
              placeholder="Choose…"
              options={[...(f.required ? [] : [{ value: "", label: "None" }]), ...f.choices.map((c) => ({ value: c, label: c }))]}
            />
          ) : (
            <TextInput
              label={f.name}
              value={values[f.id] ?? ""}
              onChange={(e) => set(f.id, e.target.value)}
              required={f.required}
              maxLength={f.type === "text" ? 500 : 20}
              inputMode={f.type === "number" ? "decimal" : undefined}
              className={f.type === "number" ? "wl-num" : undefined}
            />
          )}
        </div>
      ))}
    </Flex>
  );
}
