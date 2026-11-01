import { useState } from "react";
import { api } from "./api.ts";
import { Button, InlineError } from "./ui.tsx";

// Single sign-on (WRK-136): the "Sign in with …" button on the sign-in and invitation pages.
// The provider sends people back to /sign-in?error=<code> when it can't sign them in; the page
// shows its own words for each code, never text from the address bar.

const MESSAGES: Record<string, (provider: string) => string> = {
  not_invited: (p) => `You're not in this organization yet. Ask an admin to invite you, then sign in with ${p}.`,
  wrong_domain: () => "That account isn't one of this organization's email addresses. Sign in with your work account.",
  finish_invite: () => "Open your invitation email first to set up your account.",
  account_off: () => "This account has been turned off. Ask an admin to turn it back on.",
  email_not_verified: (p) => `${p} hasn't verified that email address, so it can't be used here.`,
};

/** The error the provider sent people back with, read once: the address is tidied straight away. */
export function takeSsoError(provider: string | null): string | null {
  const code = new URLSearchParams(window.location.search).get("error");
  if (!code) return null;
  window.history.replaceState(null, "", "/");
  const name = provider ?? "your company account";
  return (MESSAGES[code] ?? ((p: string) => `Signing in with ${p} didn't work. Try again, or ask an admin.`))(name);
}

/** "Sign in with Google Workspace": off to the provider, and back signed in. */
export function SsoButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/auth/sign-in/social", { provider: "sso", callbackURL: "/", errorCallbackURL: "/sign-in" });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <Button type="button" busy={busy} onClick={() => void go()}>{label}</Button>
      <InlineError message={error} spaced />
    </>
  );
}
