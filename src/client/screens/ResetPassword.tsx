import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { AuthCard, Button, Field, FORM_ERROR_ID, InlineError } from "../ui.tsx";
import { MIN_PASSWORD_LENGTH } from "../../shared/limits.ts";

type Reset = { name: string; email: string; organizationName: string };

// Where a password reset link lands: the person chooses a new password and is signed straight in.
export function ResetPassword({ token, logoVersion, onDone }: { token: string; logoVersion: number | null; onDone: () => void }) {
  const [reset, setReset] = useState<Reset | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;
  const logoUrl = logoVersion ? `/api/branding/logo?v=${logoVersion}` : undefined;

  useEffect(() => {
    api<Reset>(`/api/password-reset/${encodeURIComponent(token)}`).then(setReset).catch((e: Error) => setProblem(e.message));
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("/api/password-reset", { token, password: new FormData(event.currentTarget).get("password") });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (problem) {
    return (
      <AuthCard title="This link doesn't work" intro={<p>{problem}</p>} logoUrl={logoUrl}>
        <a href="/" className="wl-link wl-link-alone">Go to sign in</a>
      </AuthCard>
    );
  }
  if (!reset) return null;
  return (
    <AuthCard
      title="Choose a new password"
      docTitle="Reset password"
      intro={<p>For {reset.email} at {reset.organizationName}. Anywhere else you're signed in will be signed out.</p>}
      logoUrl={logoUrl}
    >
      <form onSubmit={submit} noValidate>
        <Field label="Email" type="email" value={reset.email} autoComplete="username" readOnly disabled />
        <Field label="New password" name="password" type="password" autoComplete="new-password" required autoFocus hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} errorId={errorId} />
        <InlineError id={FORM_ERROR_ID} message={error} spaced />
        <Button type="submit" busy={busy}>Save password</Button>
      </form>
    </AuthCard>
  );
}
