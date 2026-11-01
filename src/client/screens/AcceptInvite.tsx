import { useEffect, useState, type FormEvent } from "react";
import { Text } from "@radix-ui/themes";
import { api, type Sso } from "../api.ts";
import { AuthCard, Button, Field, FORM_ERROR_ID, InlineError } from "../ui.tsx";
import { SsoButton } from "../sso.tsx";
import { MIN_PASSWORD_LENGTH } from "../../shared/limits.ts";

/** sso: join through the organization's provider; `required` means that's the only way. */
type Invite = { name: string; email: string; organizationName: string; sso: Sso | null };

// Where an invite link lands: the person picks a password and is signed straight in.
export function AcceptInvite({ token, logoVersion, onDone }: { token: string; logoVersion: number | null; onDone: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;
  const logoUrl = logoVersion ? `/api/branding/logo?v=${logoVersion}` : undefined;

  useEffect(() => {
    api<Invite>(`/api/invites/${encodeURIComponent(token)}`).then(setInvite).catch((e: Error) => setProblem(e.message));
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      await api("/api/invites/accept", { token, name: form.get("name"), password: form.get("password") });
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
  if (!invite) return null;
  return (
    <AuthCard
      title={`Join ${invite.organizationName}`}
      docTitle="Join"
      intro={<p>You've been invited as {invite.email}. {invite.sso?.required ? `Join with your ${invite.sso.name} account to finish.` : "Choose a password to finish."}</p>}
      logoUrl={logoUrl}
    >
      {invite.sso && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <SsoButton label={`Join with ${invite.sso.name}`} />
          {!invite.sso.required && <Text as="p" size="2" color="gray" mt="4">Or choose a password:</Text>}
        </div>
      )}
      {!invite.sso?.required && <form onSubmit={submit} noValidate>
        <Field label="Your name" name="name" defaultValue={invite.name} autoComplete="name" required maxLength={200} errorId={errorId} />
        <Field label="Email" type="email" value={invite.email} autoComplete="username" readOnly disabled />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          errorId={errorId}
        />
        <InlineError id={FORM_ERROR_ID} message={error} spaced />
        <Button type="submit" busy={busy}>Join</Button>
      </form>}
    </AuthCard>
  );
}
