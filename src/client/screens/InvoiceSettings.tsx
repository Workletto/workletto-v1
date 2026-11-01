import { useEffect, useState, type FormEvent } from "react";
import { Flex, Grid, Text } from "@radix-ui/themes";
import { api, type InvoiceSettings as Saved } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { Loading, Notice, PageHeader, SavedNote, SaveButton, SettingsSection, Select, TextAreaInput, TextInput, useSaveForm } from "../ui.tsx";
import { formatInvoiceNumber, readNextNumber } from "../../shared/invoiceNumber.ts";
import { REMINDER_DAYS } from "../../shared/reminders.ts";

/** Payment terms people usually choose, in days after the issue date. */
import { TERMS } from "./Invoices.tsx";
export const termsLabel = (days: number) => (days === 0 ? "On receipt" : `${days} days after the issue date`);

type Form = { prefix: string; nextNumber: string; dueDays: number; taxPercent: string; taxLabel: string; notes: string; reminderDays: number };
export const reminderLabel = (days: number) => (days === 0 ? "Off" : `${days} days after the due date`);
const toForm = (s: Saved): Form => ({
  prefix: s.prefix,
  nextNumber: s.nextNumber,
  dueDays: s.dueDays,
  taxPercent: s.taxBasisPoints ? String(s.taxBasisPoints / 100) : "",
  taxLabel: s.taxLabel,
  notes: s.notes,
  reminderDays: s.reminderDays,
});

// Manage → Invoicing (admins): how new invoices are numbered, and the terms, tax and
// notes they start with. Each invoice can still be changed while it's a draft.
export function InvoiceSettings() {
  const [form, setForm] = useState<Form | null>(null);
  const [customTerms, setCustomTerms] = useState(false);
  const [next, setNext] = useState<{ saved: string; typed: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const state = useSaveForm(form);

  useEffect(() => {
    api<{ settings: Saved; next: string }>("/api/settings/invoices")
      .then((r) => {
        setForm(toForm(r.settings));
        state.markClean(toForm(r.settings));
        setNext({ saved: r.next, typed: formatInvoiceNumber(r.settings.prefix, ...nextOf(r.settings.nextNumber)) });
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  if (!form) {
    return (
      <>
        <PageHeader title="Invoicing" help="invoicing-and-payments/invoice-settings" />
        <ManageTabs role="admin" />
        {loadError ? <Notice color="red">{loadError}</Notice> : <Loading />}
      </>
    );
  }

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => f && { ...f, [key]: e.target.value });
  const typed = readNextNumber(form.nextNumber);
  const preview = typed ? formatInvoiceNumber(form.prefix.trim(), typed.n, typed.digits) : null;
  // After saving, the server says if that number is already used and which one comes next instead.
  const skipped = next && next.saved !== next.typed && preview === next.typed ? next : null;
  // "Custom" shows a box for any number of days; a saved custom value opens with it.
  const custom = customTerms || !TERMS.includes(form.dueDays);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    let said = "Invoice settings saved.";
    await state.save(async () => {
      const r = await api<{ settings: Saved; next: string }>("/api/settings/invoices", form, "PUT");
      const typedNext = formatInvoiceNumber(r.settings.prefix, ...nextOf(r.settings.nextNumber));
      setNext({ saved: r.next, typed: typedNext });
      if (r.next !== typedNext) said = `Invoice settings saved. ${typedNext} is already used, so the next invoice will be ${r.next}.`;
      setForm(toForm(r.settings));
      return toForm(r.settings);
    }, () => said);
  }

  return (
    <>
      <PageHeader title="Invoicing" intro="How new invoices are numbered, and what they start with." help="invoicing-and-payments/invoice-settings" />
      <ManageTabs role="admin" />
      <form onSubmit={save}>
        <Flex direction="column" gap="5">
          <SettingsSection title="Numbering" description="How invoice numbers are written.">
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <TextInput label="Prefix" value={form.prefix} onChange={set("prefix")} maxLength={20} placeholder="INV-" hint="Optional. Goes before the number, like INV- or 2026-." />
              <TextInput label="Next number" value={form.nextNumber} onChange={set("nextNumber")} maxLength={9} inputMode="numeric" required className="wl-num" hint="Leading zeros are kept: 0042, then 0043." />
            </Grid>
            <Text as="p" size="2">
              {preview ? <>Next invoice: <strong className="wl-num">{skipped ? skipped.saved : preview}</strong></> : "Enter the next number in digits, like 0001."}
              {skipped && <> ({skipped.typed} is already used.)</>}
            </Text>
          </SettingsSection>

          <SettingsSection title="Payment terms" description="When new invoices fall due.">
            <div>
              <Select
                label="New invoices are due"
                value={custom ? "custom" : String(form.dueDays)}
                onChange={(v) => {
                  setCustomTerms(v === "custom");
                  if (v !== "custom") setForm((f) => f && { ...f, dueDays: Number(v) });
                }}
                options={[...TERMS.map((d) => ({ value: String(d), label: termsLabel(d) })), { value: "custom", label: "Custom…" }]}
                hint="Sets the due date on new invoices. You can change it on each one."
              />
              {custom && (
                <TextInput
                  label="Days after the issue date"
                  type="number"
                  min={0}
                  max={365}
                  required
                  value={Number.isNaN(form.dueDays) ? "" : String(form.dueDays)}
                  onChange={(e) => setForm((f) => f && { ...f, dueDays: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                  className="wl-num"
                  hint="From 0 (on receipt) to 365."
                />
              )}
            </div>
          </SettingsSection>

          <SettingsSection title="Late-payment reminders" description="Emails your clients about sent invoices that are past due and unpaid.">
            <div>
              <Select
                label="Remind clients about unpaid invoices"
                value={String(form.reminderDays)}
                onChange={(v) => setForm((f) => f && { ...f, reminderDays: Number(v) })}
                options={REMINDER_DAYS.map((d) => ({ value: String(d), label: reminderLabel(d) }))}
                hint="Then again every 7 days, up to 3 reminders. Needs email (Manage → Email). You can turn them off for one invoice on its page."
              />
            </div>
          </SettingsSection>

          <SettingsSection title="Tax" description="The tax line new invoices start with.">
            <Grid columns={{ initial: "1", sm: "repeat(2, minmax(0, 1fr))" }} gap="3">
              <TextInput label="Name on invoices" value={form.taxLabel} onChange={set("taxLabel")} maxLength={20} placeholder="Tax" hint="Like VAT, GST or Sales tax." />
              <TextInput label="Default rate (%)" value={form.taxPercent} onChange={set("taxPercent")} inputMode="decimal" placeholder="0" className="wl-num" hint="Added after any discount." />
            </Grid>
          </SettingsSection>

          <SettingsSection title="Notes" description="These fill in new invoices. Invoices you've already made keep what they have.">
            <TextAreaInput
              label="Notes on new invoices"
              value={form.notes}
              onChange={set("notes")}
              rows={4}
              maxLength={2000}
              placeholder={"Please pay by bank transfer to:\nAccount 12345678, sort code 12-34-56"}
              hint="Payment details, thanks. Printed at the bottom of the invoice."
            />
          </SettingsSection>

          <Flex wrap="wrap" align="center" justify="end" gap="3" className="wl-form-footer">
            <SavedNote message={state.message} />
            <SaveButton state={state}>Save settings</SaveButton>
          </Flex>
        </Flex>
      </form>
    </>
  );
}

function nextOf(text: string): [number, number] {
  const n = readNextNumber(text);
  return n ? [n.n, n.digits] : [1, 4];
}
