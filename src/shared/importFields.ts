// The columns of the time CSV the Import screen reads (Harvest's "Detailed
// time" export). Aliases match Harvest's headers automatically; any column can
// still be pointed at by hand.

export type ImportField = { key: string; label: string; required?: boolean; aliases?: string[]; hint?: string };

export const IMPORT_FIELDS: ImportField[] = [
  { key: "date", label: "Date", required: true, aliases: ["spent date", "day"] },
  { key: "person", label: "Person", aliases: ["name", "user", "team member", "employee"] },
  { key: "personEmail", label: "Person email", aliases: ["email", "user email"] },
  { key: "client", label: "Client" },
  { key: "project", label: "Project", required: true },
  { key: "task", label: "Task" },
  { key: "notes", label: "Notes", aliases: ["note", "description"] },
  { key: "hours", label: "Hours", required: true, aliases: ["duration", "time", "quantity"], hint: "1.5 or 1:30" },
  { key: "billable", label: "Billable", aliases: ["billable?"], hint: "Yes or No" },
  { key: "rate", label: "Billable rate", aliases: ["rate", "hourly rate"], hint: "Sets rates for new projects and for people without one" },
  { key: "invoiced", label: "Invoiced", aliases: ["invoiced?"], hint: "Yes for time already invoiced elsewhere" },
];

const normalize = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, " ");

/** Guesses which CSV column holds each field, by label or alias. */
export function guessMapping(headers: string[]): Record<string, number | null> {
  const mapping: Record<string, number | null> = {};
  const taken = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const names = [field.label, field.key, ...(field.aliases ?? [])].map(normalize);
    const index = headers.findIndex((h, i) => !taken.has(i) && names.includes(normalize(h)));
    mapping[field.key] = index >= 0 ? index : null;
    if (index >= 0) taken.add(index);
  }
  return mapping;
}

export const MAX_IMPORT_ROWS = 500;
