import { useState, type FormEvent } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { api, type Sso } from "../api.ts";
import { AuthCard, Button, Field, FORM_ERROR_ID, RowButton, InlineError } from "../ui.tsx";
import { SsoButton, takeSsoError } from "../sso.tsx";

// The sign-in library's own wording, in the app's.
function signInMessage(message: string) {
  return /invalid email/i.test(message) ? "Enter a valid email address." : message;
}

export function SignIn({ organizationName, logoVersion, passwordResetByEmail, sso, onDone }: {
  organizationName: string | null; logoVersion: number | null; passwordResetByEmail: boolean; sso: Sso | null; onDone: () => void;
}) {
  // Back from the provider without being signed in: why, in the app's words.
  const [ssoError] = useState(() => takeSsoError(sso?.name ?? null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True when the server said the email and password don't match: both fields are then marked.
  const [rejected, setRejected] = useState(false);
  // Which fields were left empty.
  const [empty, setEmpty] = useState({ email: false, password: false });
  // Two-factor sign-in (WRK-147): after the password, a code from the app or a backup code.
  const [secondStep, setSecondStep] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setRejected(false);
    setEmpty({ email: false, password: false });
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const missing = { email: !String(values.email ?? "").trim(), password: !String(values.password ?? "") };
    if (missing.email || missing.password) {
      setEmpty(missing);
      setError("Enter your email and password.");
      // Focus goes to the first empty field.
      event.currentTarget.querySelector<HTMLInputElement>(missing.email ? 'input[name="email"]' : 'input[name="password"]')?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", values);
      if (result?.twoFactorRedirect) {
        setSecondStep(true);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setRejected(status === 401);
      setError(status === 401 ? "That email and password don't match." : signInMessage((e as Error).message));
      setBusy(false);
    }
  }

  if (secondStep) return <CodeStep organizationName={organizationName} logoVersion={logoVersion} onDone={onDone} onRestart={() => setSecondStep(false)} />;

  return (
    <AuthCard
      title={organizationName ? `Sign in to ${organizationName}` : "Sign in"}
      docTitle="Sign in"
      intro={<p>Welcome back.</p>}
      logoUrl={logoVersion ? `/api/branding/logo?v=${logoVersion}` : undefined}
      footer="Your data stays in this app's own database."
    >
      {sso && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <InlineError message={ssoError} spaced />
          <SsoButton label={`Sign in with ${sso.name}`} />
          <Text as="p" size="2" color="gray" mt="4">
            {sso.required ? "Admins can also sign in with their password:" : "Or sign in with your password:"}
          </Text>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus={!sso} errorId={errorId} invalid={rejected || empty.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required errorId={errorId} invalid={rejected || empty.password} />
        <InlineError id={FORM_ERROR_ID} message={error} spaced />
        <Button type="submit" busy={busy}>Sign in</Button>
      </form>
      {passwordResetByEmail ? (
        <ForgotPassword />
      ) : (
        <Text as="p" size="2" color="gray" mt="4">Forgot your password? Ask an admin for a reset link.</Text>
      )}
    </AuthCard>
  );
}

/** The second step of signing in: the 6-digit code from an authenticator app, or a backup code. */
function CodeStep({ organizationName, logoVersion, onDone, onRestart }: { organizationName: string | null; logoVersion: number | null; onDone: () => void; onRestart: () => void }) {
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\s/g, "");
    if (!code) return setError(backup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app.");
    setBusy(true);
    setError(null);
    try {
      await api(backup ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp", { code });
      onDone();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = (e as Error).message;
      // Too many wrong codes, or the 10 minutes ran out: start again with the password.
      if (status !== 401 || /too many|expired|invalid two factor cookie/i.test(message)) {
        setError("This sign-in has ended. Sign in again with your password.");
      } else {
        setError(backup ? "That backup code didn't work. Each one works once." : "That code didn't work. Enter the code your app shows now.");
      }
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={organizationName ? `Sign in to ${organizationName}` : "Sign in"}
      docTitle="Sign in: code"
      intro={<p>{backup ? "Enter one of the backup codes you saved when you set up two-factor sign-in." : "Enter the 6-digit code from your authenticator app."}</p>}
      logoUrl={logoVersion ? `/api/branding/logo?v=${logoVersion}` : undefined}
    >
      <form onSubmit={submit} noValidate key={backup ? "backup" : "app"}>
        {backup ? (
          <Field label="Backup code" name="code" autoComplete="off" autoFocus required errorId={error ? FORM_ERROR_ID : undefined} invalid={!!error} />
        ) : (
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required errorId={error ? FORM_ERROR_ID : undefined} invalid={!!error} />
        )}
        <InlineError id={FORM_ERROR_ID} message={error} spaced />
        <Button type="submit" busy={busy}>Sign in</Button>
      </form>
      <Flex direction="column" align="start" gap="2" mt="4">
        <RowButton onClick={() => { setBackup(!backup); setError(null); }}>{backup ? "Use the code from your app" : "Use a backup code instead"}</RowButton>
        <RowButton onClick={onRestart}>Start again</RowButton>
      </Flex>
    </AuthCard>
  );
}

// Asks for a reset link by email. The answer is the same whether or not the address has an
// account here, so the page never gives that away.
function ForgotPassword() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("/api/password-reset/request", { email: new FormData(event.currentTarget).get("email") });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <Text as="p" size="2" color="gray" mt="4" role="status">
        If that address has an account here, we've sent it a link. It works for 1 hour. Check your spam folder too.
      </Text>
    );
  }
  if (!open) {
    return (
      <Flex mt="4">
        <RowButton flush type="button" onClick={() => setOpen(true)}>Forgot your password?</RowButton>
      </Flex>
    );
  }
  return (
    <form onSubmit={submit} noValidate style={{ marginTop: "var(--space-4)" }} aria-label="Forgot your password">
      <Field label="Email for the reset link" name="email" type="email" autoComplete="email" required autoFocus errorId={error ? FORM_ERROR_ID : undefined} />
      <InlineError id={FORM_ERROR_ID} message={error} spaced />
      <Button type="submit" variant="outline" color="gray" busy={busy}>Send reset link</Button>
    </form>
  );
}
