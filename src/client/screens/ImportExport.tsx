import { useMemo, useState } from "react";
import { Flex, Grid, Heading, RadioCards, Table, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, downloadFile } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { localToday } from "../timer.tsx";
import { ActionButton, ArticleLink, CheckField, FileButton, InlineError, Notice, PageHeader, Select, SettingsSection, TableRegion, TextInput } from "../ui.tsx";
import { parseCsv } from "../../shared/csv.ts";
import { guessMapping, IMPORT_FIELDS, MAX_IMPORT_ROWS } from "../../shared/importFields.ts";
import { parseYesNo } from "../../shared/importPlan.ts";
import { buildRow, guessDateFormat, runImport, type DateFormat, type ImportResult, type Mapping } from "../../shared/importRun.ts";

const EXPORTS = { clients: "Clients", projects: "Projects", tasks: "Tasks", time: "Time entries", expenses: "Expenses" } as const;
const DATE_FORMATS: Record<DateFormat, string> = { ymd: "2026-10-15 (year first)", dmy: "15/10/2026 (day first)", mdy: "10/15/2026 (month first)" };
type Result = ImportResult;
const PREVIEW_ROWS = 5;

// Manage → Import & export (admins and managers).
export function ImportExport({ role }: { role: string }) {
  const year = localToday().slice(0, 4);
  const [range, setRange] = useState({ from: `${year}-01-01`, to: `${year}-12-31` });
  const [error, setError] = useState<string | null>(null);
  const reversed = !!range.from && !!range.to && range.from > range.to;

  // A file is saved only when the server sends one; an error is shown here instead.
  async function download(path: string, said: string) {
    setError(null);
    try {
      await downloadFile(path);
      announce(said);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const dated = (type: "time" | "expenses") => {
    if (reversed || !range.from || !range.to) return setError(reversed ? "The start date is after the end date." : "Choose a start and an end date.");
    void download(`/api/data/export/${type}?from=${range.from}&to=${range.to}`, `${EXPORTS[type]} exported.`);
  };

  return (
    <>
      <PageHeader title="Import & export" intro="Bring your time in from Harvest, or take your data out as spreadsheets." help="import-and-export/export-your-data" />
      <ManageTabs role={role} />
      <SettingsSection title="Export" description="CSV files that open in any spreadsheet.">
        <Flex wrap="wrap" gap="2">
          {(["clients", "projects", "tasks"] as const).map((t) => (
            <ActionButton key={t} variant="outline" color="gray" onClick={() => void download(`/api/data/export/${t}`, `${EXPORTS[t]} exported.`)}>{EXPORTS[t]}</ActionButton>
          ))}
        </Flex>
        <Flex wrap="wrap" align="end" gap="3">
          <TextInput label="From" type="date" value={range.from} onChange={(e) => { setRange({ ...range, from: e.target.value }); setError(null); }} invalid={reversed} errorId={error ? "export-error" : undefined} />
          <TextInput label="To" type="date" value={range.to} onChange={(e) => { setRange({ ...range, to: e.target.value }); setError(null); }} invalid={reversed} errorId={error ? "export-error" : undefined} />
          <Flex gap="2" align="center">
            {(["time", "expenses"] as const).map((t) => (
              <ActionButton key={t} variant="outline" color="gray" onClick={() => dated(t)}>{EXPORTS[t]}</ActionButton>
            ))}
          </Flex>
        </Flex>
        <InlineError id="export-error" message={error} />
      </SettingsSection>
      <Importer />
    </>
  );
}

function Importer() {
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [dateFormat, setDateFormat] = useState<DateFormat>("ymd");
  const [createMissing, setCreateMissing] = useState(true);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [invoiced, setInvoiced] = useState<"not-billable" | "skip">("not-billable");
  const [check, setCheck] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fields = IMPORT_FIELDS;

  function reset() {
    setCheck(null);
    setDone(null);
    setError(null);
  }

  async function choose(chosen: File) {
    reset();
    const [headers, ...rows] = parseCsv(await chosen.text());
    if (!headers || rows.length === 0) return setError("That file has no rows. Choose a CSV file with a header row.");
    setFile({ name: chosen.name, headers, rows });
    const guessed = guessMapping(headers);
    setMapping(guessed);
    setDateFormat(guessed.date == null ? "ymd" : guessDateFormat(rows.slice(0, 50).map((r) => r[guessed.date!] ?? "")));
  }

  // The rows exactly as they'll be sent: the preview, the invoiced count and the import all use these.
  const rows = useMemo(
    () => (file ? file.rows.map((cells) => buildRow(file, cells, mapping, dateFormat)) : []),
    [file, mapping, dateFormat],
  );
  const invoicedRows = mapping.invoiced != null ? rows.filter((r) => parseYesNo(r.invoiced) === true).length : 0;
  const ignored = useMemo(() => {
    if (!file) return [];
    const used = new Set(Object.values(mapping).filter((i): i is number => i != null));
    if (mapping.person == null) {
      file.headers.forEach((h, i) => ["first name", "last name"].includes(h.trim().toLowerCase()) && used.add(i));
    }
    return file.headers.filter((h, i) => h.trim() && !used.has(i));
  }, [file, mapping]);
  const previewFields = fields.filter((f) => mapping[f.key] != null || f.key === "person");

  async function send(dryRun: boolean) {
    if (busy) return;
    setBusy(dryRun ? "Checking…" : "Importing…");
    announce(dryRun ? "Checking the file." : "Importing.");
    setError(null);
    try {
      const total = await runImport(
        rows,
        { dryRun, createMissing, skipDuplicates, invoiced },
        (body) => api<Result>("/api/data/import/time", body),
        (offset, all) => setBusy(`${dryRun ? "Checking" : "Importing"} rows ${offset + 1}–${Math.min(offset + MAX_IMPORT_ROWS, all)} of ${all}…`),
      );
      if (dryRun) setCheck(total);
      else setDone(total);
      announce(summaryText(total, dryRun, created(total)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const missingRequired = fields.filter((f) => f.required && mapping[f.key] == null && f.key !== "person");
  const created = (r: Result) =>
    Object.entries(r.created).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "").replace("people", "person") : k}`).join(", ");
  const summaryOptions = { skipDuplicates, invoiced };

  return (
    <SettingsSection
      title="Import from Harvest"
      description={
        <>
          In Harvest, export your time from Reports → Detailed time → Export → CSV, then choose that file here. It is checked first; nothing is saved until you import.{" "}
          <ArticleLink article="import-and-export/import-from-harvest">About importing</ArticleLink>
        </>
      }
    >
      <Flex wrap="wrap" align="end" gap="3">
        <FileButton accept=".csv,text/csv" onFile={(f) => void choose(f)}>
          {file ? "Choose another file" : "Choose a CSV file"}
        </FileButton>
        {file && <Text size="2" color="gray" style={{ paddingBlock: "var(--space-3)" }}>{file.name} · {file.rows.length} rows</Text>}
      </Flex>

      {file && !done && (
        <>
          <div>
            <Heading as="h3" size="3" weight="medium" mb="3">Match the columns</Heading>
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              {fields.map((f) => (
                <div key={f.key}>
                  {f.key === "person" && mapping.person == null ? (
                    <>
                      <span className="wl-label">{f.label}{f.required && <Text color="red"> *</Text>}</span>
                      <Text as="p" size="2" color="gray" style={{ paddingBlock: "var(--space-2)" }}>First name + Last name</Text>
                    </>
                  ) : (
                    <Select
                      size="2"
                      label={`${f.label}${f.required ? " *" : ""}`}
                      value={mapping[f.key] == null ? "" : String(mapping[f.key])}
                      onChange={(v) => {
                        reset();
                        setMapping({ ...mapping, [f.key]: v === "" ? null : Number(v) });
                      }}
                      hint={f.hint}
                      options={[{ value: "", label: "Not in the file" }, ...file.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))]}
                    />
                  )}
                </div>
              ))}
            </Grid>
            {ignored.length > 0 && (
              <Text as="p" size="2" color="gray" mt="3">
                Not imported, because there's nowhere to put {ignored.length === 1 ? "it" : "them"}: {ignored.join(", ")}.
                {" Amounts are worked out from hours and rates, so Billable Amount isn't needed."}
              </Text>
            )}
          </div>
          <div style={{ maxWidth: "20rem" }}>
            <Select
              label="Dates look like"
              value={dateFormat}
              onChange={(d) => {
                reset();
                setDateFormat(d as DateFormat);
              }}
              options={(Object.keys(DATE_FORMATS) as DateFormat[]).map((d) => ({ value: d, label: DATE_FORMATS[d] }))}
            />
          </div>
          <Preview fields={previewFields} rows={rows.slice(0, PREVIEW_ROWS)} total={rows.length} />
          <Flex direction="column" gap="3">
            <CheckField
              checked={createMissing}
              onChange={(v) => { reset(); setCreateMissing(v); }}
              label="Add clients, projects, tasks and people that aren't here yet (people are added without a login; invite them later)"
            />
            <CheckField
              checked={skipDuplicates}
              onChange={(v) => { reset(); setSkipDuplicates(v); }}
              label="Skip rows that are already here (same date, person, project, task, time and notes)"
            />
            {invoicedRows > 0 && (
              <div>
                <Text as="p" size="2" weight="medium" id="invoiced-question" mb="2">
                  {invoicedRows} {invoicedRows === 1 ? "row is" : "rows are"} marked as already invoiced. What should happen to {invoicedRows === 1 ? "it" : "them"}?
                </Text>
                <RadioCards.Root
                  aria-labelledby="invoiced-question"
                  columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }}
                  size="2"
                  value={invoiced}
                  onValueChange={(v) => { reset(); setInvoiced(v as "not-billable" | "skip"); }}
                >
                  <RadioCards.Item value="not-billable">
                    <Flex direction="column" gap="1" align="start">
                      <Text weight="medium">Import as not billable</Text>
                      <Text size="2" color="gray">The hours stay in your time reports, but they can't be invoiced a second time. They won't count in billable hours or amounts.</Text>
                    </Flex>
                  </RadioCards.Item>
                  <RadioCards.Item value="skip">
                    <Flex direction="column" gap="1" align="start">
                      <Text weight="medium">Leave them out</Text>
                      <Text size="2" color="gray">They are not imported at all.</Text>
                    </Flex>
                  </RadioCards.Item>
                </RadioCards.Root>
              </div>
            )}
          </Flex>
          {missingRequired.length > 0 && <Notice color="amber">Match a column for: {missingRequired.map((f) => f.label).join(", ")}.</Notice>}

          <Flex wrap="wrap" align="center" gap="3">
            <ActionButton variant={check ? "outline" : "solid"} color={check ? "gray" : undefined} onClick={() => void send(true)} disabled={!!busy || missingRequired.length > 0}>Check file</ActionButton>
            {check && check.ok > 0 && (
              <ActionButton onClick={() => void send(false)} disabled={!!busy}>
                Import {check.ok} {check.ok === 1 ? "row" : "rows"}
              </ActionButton>
            )}
            {busy && <Text size="2" color="gray">{busy}</Text>}
          </Flex>
          {check && <Summary result={check} created={created(check)} preview options={summaryOptions} />}
        </>
      )}
      {done && (
        <Flex direction="column" gap="3" align="start">
          <Summary result={done} created={created(done)} options={summaryOptions} />
          <ActionButton variant="outline" color="gray" onClick={() => { setFile(null); reset(); }}>Import another file</ActionButton>
        </Flex>
      )}
      <InlineError message={error} />
    </SettingsSection>
  );
}

/** The first few rows as they'll be sent, so a wrong column or date order shows up before the check. */
function Preview({ fields, rows, total }: { fields: { key: string; label: string }[]; rows: Record<string, string>[]; total: number }) {
  if (rows.length === 0 || fields.length === 0) return null;
  return (
    <div>
      <Heading as="h3" size="3" weight="medium" mb="2">First {rows.length === total ? "" : `${rows.length} of ${total} `}{rows.length === 1 ? "row" : "rows"}, as they'll be imported</Heading>
      <div className="wl-framed">
        <TableRegion label="Preview of the first rows">
          <Table.Root variant="ghost" size="1">
            <Table.Header>
              <Table.Row>
                {fields.map((f) => <Table.ColumnHeaderCell key={f.key} style={{ whiteSpace: "nowrap" }}>{f.label}</Table.ColumnHeaderCell>)}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r, i) => (
                <Table.Row key={i}>
                  {fields.map((f) => <Table.Cell key={f.key} className="wl-clip" title={r[f.key]}>{r[f.key]}</Table.Cell>)}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </TableRegion>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "will be" in a check, "was" for one thing done, "were" for several. */
const been = (n: number, preview?: boolean) => (preview ? "will be" : n === 1 ? "was" : "were");

/** The headline of a check or import, also read out when it finishes. */
function summaryHeadline(result: Result, preview?: boolean) {
  return (
    (preview ? `${result.ok} ${result.ok === 1 ? "row is" : "rows are"} ready to import.` : `Imported ${result.ok} ${result.ok === 1 ? "row" : "rows"}.`) +
    (result.skipped > 0 ? ` ${result.skipped} already here and ${been(result.skipped, preview)} skipped.` : "") +
    (result.leftOut > 0 ? ` ${plural(result.leftOut, "invoiced row")} ${been(result.leftOut, preview)} left out.` : "")
  );
}

function summaryText(result: Result, preview: boolean, created: string) {
  const problems = result.errors.length;
  return [
    summaryHeadline(result, preview),
    created && `${preview ? "Will add" : "Added"} ${created}.`,
    problems > 0 && `${problems} ${problems === 1 ? "row has a problem" : "rows have problems"}.`,
    result.noRate.length > 0 && `${plural(result.noRate.length, "billable row")} without a rate.`,
  ].filter(Boolean).join(" ");
}

const rowList = (rows: number[], max = 12) => rows.slice(0, max).map((r) => r + 1).join(", ") + (rows.length > max ? `, and ${rows.length - max} more` : "");
const dollars = (cents: number) => (cents / 100).toFixed(2);

function Summary({ result, created, preview, options }: { result: Result; created: string; preview?: boolean; options: { skipDuplicates: boolean; invoiced: "not-billable" | "skip" } }) {
  const noRateProjects = [...new Set(result.noRate.map((n) => n.project))];
  return (
    <Flex direction="column" gap="3" p="4" className="wl-summary">
      <Text as="p" weight="medium">{summaryHeadline(result, preview)}</Text>
      {created && <Text as="p" size="2" color="gray">{preview ? "Will add" : "Added"} {created}.</Text>}
      {result.ratesSet > 0 && <Text as="p" size="2" color="gray">{preview ? "Will set" : "Set"} an hourly rate for {plural(result.ratesSet, "person", "people")}, taken from their most common billable rate in the file.</Text>}
      {result.duplicates > 0 && (
        <Text as="p" size="2" color="gray">
          {plural(result.duplicates, "row")} matched time already here (same date, person, project and notes).{" "}
          {options.skipDuplicates ? `${result.duplicates === 1 ? "It" : "They"} ${been(result.duplicates, preview)} skipped.` : `${result.duplicates === 1 ? "It" : "They"} ${been(result.duplicates, preview)} added again, because you chose not to skip them.`}
        </Text>
      )}
      {result.invoiced > 0 && (
        <Notice color="amber">
          {plural(result.invoiced, "row")} {result.invoiced === 1 ? "is" : "are"} marked as already invoiced.{" "}
          {options.invoiced === "skip"
            ? `${result.invoiced === 1 ? "It" : "They"} ${been(result.invoiced, preview)} left out.`
            : `${result.invoiced === 1 ? "It" : "They"} ${been(result.invoiced, preview)} imported as not billable, so ${result.invoiced === 1 ? "it" : "they"} can't be invoiced again.`}
        </Notice>
      )}
      {result.noRate.length > 0 && (
        <Notice color="amber">
          <span className="wl-block">{plural(result.noRate.length, "billable row")} {preview ? "has" : "had"} no rate to charge, so {result.noRate.length === 1 ? "its" : "their"} billable amount is 0 until you set one.</span>
          <span className="wl-block">
            Set an hourly rate on {noRateProjects.slice(0, 5).join(", ")}{noRateProjects.length > 5 ? ` and ${noRateProjects.length - 5} more` : ""}, or on the people who worked on {noRateProjects.length === 1 ? "it" : "them"}. Rows: {rowList(result.noRate.map((n) => n.row))}.
          </span>
        </Notice>
      )}
      {result.rateDiffers.length > 0 && (
        <Notice color="amber">
          <span className="wl-block">{plural(result.rateDiffers.length, "billable row")} will be charged at a different rate than the file says.</span>
          <span className="wl-block">A project is billed at one rate, or at each person's own rate, so a different rate for one person on one project can't be kept.</span>
          <ul tabIndex={0} aria-label="Rows charged at a different rate" className="wl-scroll-list">
            {result.rateDiffers.slice(0, 50).map((d) => (
              <li key={d.row}>Row {d.row + 1}: {d.person} on {d.project}, {dollars(d.file)} in the file, {dollars(d.work)} here.</li>
            ))}
          </ul>
        </Notice>
      )}
      {result.warnings.length > 0 && (
        <Notice color="amber">
          <ul className="wl-plain-list">{result.warnings.slice(0, 20).map((w) => <li key={w}>{w}</li>)}</ul>
        </Notice>
      )}
      {result.errors.length > 0 && (
        <Notice color="red">
          <span className="wl-block">{result.errors.length} {result.errors.length === 1 ? "row has a problem" : "rows have problems"}{preview ? " and will be left out" : ` and ${been(result.errors.length)} left out`}:</span>
          <ul tabIndex={0} aria-label="Rows with problems" className="wl-scroll-list">
            {result.errors.slice(0, 100).map((e) => <li key={e.row}>Row {e.row + 1}: {e.error}</li>)}
          </ul>
        </Notice>
      )}
    </Flex>
  );
}
