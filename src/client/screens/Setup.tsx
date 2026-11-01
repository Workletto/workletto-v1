import { useState, type FormEvent } from "react";
import { RowButton } from "../ui.tsx";
import { Code, Flex } from "@radix-ui/themes";
import { api } from "../api.ts";
import { AuthCard, Button, Field, FORM_ERROR_ID, InlineError, SrOnly } from "../ui.tsx";
import { MIN_PASSWORD_LENGTH } from "../../shared/limits.ts";

// On Render, which makes the setup code itself, the page in Render's dashboard where it is.
function CodeLink({ url }: { url: string }) {
  return (
    <Button asChild variant="soft" color="gray" mb="5">
      <a href={url} target="_blank" rel="noreferrer">
        Open Render to copy your setup code<SrOnly> (opens in a new tab)</SrOnly>
      </a>
    </Button>
  );
}

export function Setup({ codeConfigured, codeUrl, onDone }: { codeConfigured: boolean; codeUrl: string | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;

  if (!codeConfigured) {
    return (
      <AuthCard
        title="One more step at your host"
        intro={
          <>
            <p>This install has no setup code yet, so nobody can claim it.</p>
            {codeUrl ? (
              <p>
                In Render, open this app's Environment page, add <Code>SETUP_CODE</Code> with at least 16
                characters, and click Save, rebuild, and deploy. When it's live, reload this page.
              </p>
            ) : (
              <p>
                In your hosting dashboard, add an environment variable named <Code>SETUP_CODE</Code> with
                at least 16 characters, redeploy, then reload this page.
              </p>
            )}
          </>
        }
      >
        {codeUrl && <CodeLink url={codeUrl} />}
        <Button type="button" onClick={() => location.reload()}>Reload</Button>
      </AuthCard>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("/api/setup", Object.fromEntries(new FormData(event.currentTarget)));
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Set up"
      intro={
        codeUrl ? (
          <p>
            Render made a setup code for this app. Open Render and click the copy icon next to{" "}
            <Code>SETUP_CODE</Code>. Paste the code below, then create the first admin account.
          </p>
        ) : (
          <p>Enter the setup code from when you deployed, then create the first admin account.</p>
        )
      }
      footer="Everything you enter stays in this app's database, on your hosting account."
    >
      {codeUrl && <CodeLink url={codeUrl} />}
      <form onSubmit={submit} noValidate>
        <Field label="Setup code" name="setupCode" autoComplete="off" required autoFocus spellCheck={false} errorId={errorId} />
        <Field label="Organization name" name="organizationName" placeholder="Studio North" required errorId={errorId} />
        <Field label="Your name" name="name" autoComplete="name" required errorId={errorId} />
        <Field label="Email" name="email" type="email" autoComplete="email" required errorId={errorId} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} required errorId={errorId} />
        <InlineError id={FORM_ERROR_ID} message={error} spaced />
        <Button type="submit" busy={busy}>Create admin account</Button>
      </form>
      <Restore />
    </AuthCard>
  );
}

// Instead of starting fresh: restore a backup downloaded from another install.
function Restore() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("backup");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose the backup file to restore.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/setup/restore", {
        method: "POST",
        headers: { "X-Setup-Code": String(form.get("setupCode") ?? ""), "Content-Type": "application/gzip" },
        body: file,
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Something went wrong. Try again.");
      }
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={{ marginTop: "var(--space-5)" }} role="status">
        <p>Restored. Sign in with the email and password you used before.</p>
        <p><a href="/" className="wl-link wl-link-alone" onClick={(e) => { e.preventDefault(); location.assign("/"); }}>Go to sign-in</a></p>
      </div>
    );
  }
  if (!open) {
    return (
      <Flex mt="4">
        <RowButton flush type="button" onClick={() => setOpen(true)}>Restoring from another install? Restore a backup</RowButton>
      </Flex>
    );
  }
  return (
    <form onSubmit={submit} noValidate aria-label="Restore a backup" style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--wl-hairline)" }}>
      <Field label="Setup code" name="setupCode" autoComplete="off" required spellCheck={false} errorId={errorId} />
      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="restore-file" className="wl-label">Backup file</label>
        <input id="restore-file" name="backup" type="file" accept=".gz,application/gzip" aria-describedby={errorId} />
        <p className="rt-Text rt-r-size-1" style={{ color: "var(--gray-11)", marginTop: 4 }}>The file you downloaded from Manage → Security &amp; data.</p>
      </div>
      {busy && <p role="status">Restoring… this can take a minute for a large backup.</p>}
      <InlineError id={FORM_ERROR_ID} message={error} spaced />
      <Button type="submit" busy={busy} busyLabel="Restoring…">Restore</Button>
    </form>
  );
}
