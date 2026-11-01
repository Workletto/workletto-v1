import { useEffect, useState, type FormEvent } from "react";
import { Flex, RadioGroup, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, CheckField, Loading, Notice, PageHeader, RadioOption, SavedNote, SaveButton, SettingsSection, TextInput, useSaveForm } from "../ui.tsx";

type Choice = "off" | "smtp";
type Saved = {
  provider: "smtp";
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  hasSecret: boolean;
  secretUnreadable: boolean;
  lastTestAt: string | null;
  lastError: string | null;
};
type Form = { choice: Choice; fromName: string; fromEmail: string; smtpHost: string; smtpPort: string; smtpSecure: boolean; smtpUser: string; secret: string };

const blank: Form = { choice: "off", fromName: "", fromEmail: "", smtpHost: "", smtpPort: "587", smtpSecure: false, smtpUser: "", secret: "" };
const toForm = (s: Saved | null): Form =>
  s ? { choice: s.provider, fromName: s.fromName, fromEmail: s.fromEmail, smtpHost: s.smtpHost, smtpPort: String(s.smtpPort), smtpSecure: s.smtpSecure, smtpUser: s.smtpUser, secret: "" } : blank;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// Manage → Email (admins): where the app sends email from. Nothing is sent until this is set up.
export function Email() {
  const [saved, setSaved] = useState<Saved | null | undefined>(undefined);
  const [demo, setDemo] = useState(false);
  const [form, setForm] = useState<Form>(blank);
  const state = useSaveForm(form);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function load() {
    const data = await api<{ demo?: true; settings?: Saved | null }>("/api/settings/email");
    setDemo(!!data.demo);
    setSaved(data.settings ?? null);
    return data.settings ?? null;
  }
  useEffect(() => {
    load().then((s) => { setForm(toForm(s)); state.markClean(toForm(s)); }).catch((e: Error) => { setSaved(null); state.fail(e.message); });
  }, []);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const unchanged = saved !== undefined && saved !== null && JSON.stringify(form) === JSON.stringify(toForm(saved));
  const secretWord = "password";
  const secretSaved = !!saved && saved.provider === form.choice && saved.hasSecret;

  function save(event: FormEvent) {
    event.preventDefault();
    setTestMessage(null);
    if (form.choice === "off") {
      void state.save(async () => {
        await api("/api/settings/email", undefined, "DELETE");
        setSaved(null);
        setForm(blank);
        return blank;
      }, "Email is off.", "Email is off.");
    } else {
      void state.save(async () => {
        const { settings } = await api<{ settings: Saved }>("/api/settings/email", { ...form, provider: form.choice, smtpPort: Number(form.smtpPort) }, "PUT");
        setSaved(settings);
        setForm(toForm(settings));
        return toForm(settings);
      }, "Email settings saved.");
    }
  }

  async function sendTest() {
    if (testing) return;
    setTesting(true);
    setTestMessage(null);
    try {
      await api("/api/settings/email/test", {});
      setTestMessage({ ok: true, text: "Sent. Check your inbox." });
      announce("Test email sent.");
    } catch (e) {
      setTestMessage({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
      load().catch(() => {}); // refreshes the "last test" line
    }
  }

  return (
    <>
      <PageHeader title="Email" help="hosting-and-maintenance/send-email-from-the-app" intro="Choose how your app sends email. Nothing is sent until you turn this on, and emails come from your own address." />
      <ManageTabs role="admin" />
      {saved === undefined ? (
        <Loading />
      ) : demo ? (
        <Notice color="gray">Email can't be set up in the demo.</Notice>
      ) : (
        <>
          <form onSubmit={save}>
            <Flex direction="column" gap="5">
              <SettingsSection title="Send email with" description="Nothing is sent while this is off.">
                <RadioGroup.Root value={form.choice} onValueChange={(v) => setForm((f) => ({ ...f, choice: v as Choice, secret: "" }))} aria-label="How the app sends email">
                  <Flex direction="column" gap="3">
                    <RadioOption value="off" hint="The app sends no email.">Off</RadioOption>
                    <RadioOption value="smtp" hint="Your own mail server, or one from an email service. Resend, Postmark, Amazon SES, Gmail and Microsoft 365 all work this way.">SMTP server</RadioOption>
                  </Flex>
                </RadioGroup.Root>
              </SettingsSection>

              {form.choice !== "off" && (
                <SettingsSection title="Sender" description="Who your emails come from.">
                  <TextInput label="Sender name" value={form.fromName} onChange={set("fromName")} maxLength={100} placeholder="Studio North" hint="Shown to the people who get your email. Optional." />
                  <TextInput label="Sender address" type="email" value={form.fromEmail} onChange={set("fromEmail")} required maxLength={200} placeholder="billing@yourcompany.com" />
                </SettingsSection>
              )}

              {form.choice === "smtp" && (
                <SettingsSection title="SMTP server" description="The server that sends your email.">
                  <TextInput label="Host" value={form.smtpHost} onChange={set("smtpHost")} required maxLength={200} placeholder="smtp.example.com" autoComplete="off" />
                  <TextInput label="Port" type="number" value={form.smtpPort} onChange={set("smtpPort")} required min={1} max={65535} hint="Usually 587, or 465 for a secure connection from the start." />
                  <CheckField label="Secure connection from the start (TLS)" checked={form.smtpSecure} onChange={(smtpSecure) => setForm((f) => ({ ...f, smtpSecure }))} hint="Turn this on for port 465. Otherwise the connection is upgraded to TLS when the server offers it." />
                  <TextInput label="Username" value={form.smtpUser} onChange={set("smtpUser")} maxLength={200} autoComplete="off" hint="Leave empty if the server needs no login." />
                  <SecretField label="Password" word={secretWord} form={form} set={set("secret")} saved={secretSaved} unreadable={!!saved?.secretUnreadable && saved.provider === "smtp"} />
                </SettingsSection>
              )}

              <Flex wrap="wrap" align="center" justify="end" gap="3" className="wl-form-footer">
                <SavedNote message={state.message} />
                <SaveButton state={state}>Save email settings</SaveButton>
              </Flex>
            </Flex>
          </form>

          {saved && (
            <SettingsSection title="Test" description="Check that your email arrives.">
              <Flex align="center" gap="4" wrap="wrap">
                <ActionButton type="button" variant="outline" color="gray" busy={testing} busyLabel="Sending…" disabled={!unchanged} onClick={sendTest}>Send a test email</ActionButton>
                <SavedNote message={testMessage} />
              </Flex>
              <Text as="p" size="1" color="gray">
                {unchanged ? "Sends a message to your own address, so you can check that it arrives." : "Save your changes first, then send a test email."}
              </Text>
              {saved.lastTestAt && (
                <Text as="p" size="2" color={saved.lastError ? "red" : "gray"}>
                  Last test: {when(saved.lastTestAt)}. {saved.lastError ?? "Sent."}
                </Text>
              )}
              {!saved.lastTestAt && saved.lastError && (
                <Text as="p" size="2" color="red">
                  Last send failed: {saved.lastError}
                </Text>
              )}
            </SettingsSection>
          )}
        </>
      )}
    </>
  );
}

// The saved password or key is never shown; leaving the field empty keeps it.
function SecretField({ label, word, form, set, saved, unreadable }: { label: string; word: string; form: Form; set: (e: { target: { value: string } }) => void; saved: boolean; unreadable: boolean }) {
  return (
    <TextInput
      label={label}
      type="password"
      value={form.secret}
      onChange={set}
      autoComplete="new-password"
      maxLength={500}
      placeholder={saved ? "Saved. Enter a new one to replace it." : undefined}
      hint={unreadable ? `Enter the ${word} again. It was saved before this app's secret key changed, so it can't be read.` : undefined}
    />
  );
}
