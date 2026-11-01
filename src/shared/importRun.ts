import { MAX_IMPORT_ROWS } from "./importFields.ts";
import { planRates, type PlanInput } from "./importPlan.ts";

// The browser's side of the Harvest time import, kept here so the tests run exactly what the
// Import screen runs: turning a CSV's cells into rows for the server, and
// sending them in batches while keeping what the server says in one result.

export type DateFormat = "ymd" | "dmy" | "mdy";

/** A date as typed in the file, in the chosen order, as YYYY-MM-DD. Anything unreadable passes through for the server to report. */
export function toIsoDate(value: string, format: DateFormat): string {
  const parts = value.trim().split(/[-/.]/).map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return value;
  let [y, m, d] = format === "ymd" ? parts : format === "dmy" ? [parts[2]!, parts[1]!, parts[0]!] : [parts[2]!, parts[0]!, parts[1]!];
  if (y!.length === 2) y = `20${y}`;
  return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

/** Guesses the date order from the first few dates in the file. */
export function guessDateFormat(samples: string[]): DateFormat {
  for (const s of samples) {
    const parts = s.trim().split(/[-/.]/);
    if (parts.length !== 3) continue;
    if (parts[0]!.length === 4) return "ymd";
    if (Number(parts[0]) > 12) return "dmy";
    if (Number(parts[1]) > 12) return "mdy";
  }
  return "ymd";
}

export type CsvFile = { headers: string[]; rows: string[][] };
export type Mapping = Record<string, number | null>;

/** One CSV row as { field: text } for the server. Harvest keeps first and last names in separate columns. */
export function buildRow(file: CsvFile, cells: string[], mapping: Mapping, dateFormat: DateFormat): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [key, index] of Object.entries(mapping)) {
    if (index == null) continue;
    const value = cells[index] ?? "";
    row[key] = key === "date" && value.trim() ? toIsoDate(value, dateFormat) : value;
  }
  if (!row.person) {
    const at = (name: string) => file.headers.findIndex((h) => h.trim().toLowerCase() === name);
    row.person = [cells[at("first name")] ?? "", cells[at("last name")] ?? ""].join(" ").trim();
  }
  return row;
}

export type ImportResult = {
  ok: number;
  /** Rows that were already here (duplicates left out). */
  skipped: number;
  errors: { row: number; error: string }[];
  created: { clients: number; projects: number; people: number; tasks: number };
  /** Time equal to entries that were here before the import began (in "skipped" unless told to import them anyway). */
  duplicates: number;
  /** Time the file marks as already invoiced, and how many of those were left out. */
  invoiced: number;
  leftOut: number;
  ratesSet: number;
  /** Billable time whose billable amount will be 0 because no rate applies to it. */
  noRate: { row: number; project: string }[];
  /** Billable time whose rate in the file isn't the rate this app will use. */
  rateDiffers: { row: number; person: string; project: string; file: number; work: number }[];
  warnings: string[];
  startedAt?: string;
};

export type ImportOptions = { dryRun: boolean; createMissing: boolean; skipDuplicates: boolean; invoiced: "not-billable" | "skip" };

export const emptyResult = (): ImportResult => ({
  ok: 0, skipped: 0, errors: [], created: { clients: 0, projects: 0, people: 0, tasks: 0 },
  duplicates: 0, invoiced: 0, leftOut: 0, ratesSet: 0, noRate: [], rateDiffers: [], warnings: [],
});

/**
 * Sends rows in batches and adds up the answers. Rates are worked out from the whole file
 * first (not per batch), and every batch is told when the import began so that rows saved by
 * earlier batches aren't mistaken for duplicates.
 */
export async function runImport(
  rows: Record<string, string>[],
  options: ImportOptions,
  post: (body: Record<string, unknown>) => Promise<ImportResult>,
  progress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const plan = planRates(rows as PlanInput[]);
  const total = emptyResult();
  let since: string | undefined;
  for (let offset = 0; offset < rows.length; offset += MAX_IMPORT_ROWS) {
    progress?.(offset, rows.length);
    const r = await post({ rows: rows.slice(offset, offset + MAX_IMPORT_ROWS), offset, plan, since, ...options });
    since ??= r.startedAt;
    total.ok += r.ok;
    total.skipped += r.skipped;
    total.duplicates += r.duplicates;
    total.invoiced += r.invoiced;
    total.leftOut += r.leftOut;
    total.ratesSet += r.ratesSet;
    total.errors.push(...r.errors);
    total.noRate.push(...r.noRate);
    total.rateDiffers.push(...r.rateDiffers);
    for (const w of r.warnings) if (!total.warnings.includes(w)) total.warnings.push(w);
    for (const k of Object.keys(total.created) as (keyof ImportResult["created"])[]) total.created[k] += r.created[k];
  }
  return total;
}
