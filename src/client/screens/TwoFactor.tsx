import { useState, type FormEvent } from "react";
import { Box, Code, Flex, Grid, Text } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api, type Me } from "../api.ts";
import { ActionButton, AuthCard, Card, InlineError, PageHeader, RowButton, SettingsSection, TextInput } from "../ui.tsx";
import { displayAppName } from "../../shared/product.ts";
import { qrMatrix, qrPath } from "../../shared/qr.ts";

// Two-factor sign-in (WRK-147): a person turns it on with an authenticator app and keeps 10
// backup codes; turning it off takes their password and a code. Better Auth's twoFactor plugin
// does the work (src/server/auth.ts).

type Step = { kind: "password" } | { kind: "scan"; uri: string; backupCodes: string[] } | { kind: "codes"; backupCodes: string[] };

/** The QR code an authenticator app scans, drawn as SVG. */
function QrCode({ text }: { text: string }) {
  const matrix = qrMatrix(text);
  const side = matrix.length + 8;
  return (
    <svg viewBox={`0 0 ${side} ${side}`} width={208} height={208} role="img" aria-label="QR code to scan with your authenticator app" shapeRendering="crispEdges" style={{ display: "block" }}>
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrPath(matrix)} fill="#000000" />
    </svg>
  );
}

/** The secret in an otpauth:// address, in groups of four for typing. */
const setupKey = (uri: string) => (new URL(uri).searchParams.get("secret") ?? "").replace(/(.{4})/g, "$1 ").trim();

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <Flex direction="column" gap="3">
      <Text as="p" size="2">
        Save these backup codes somewhere safe, like your password manager. Each one signs you in once if you don't have your phone. They aren't shown again.
      </Text>
      <Card>
        <Grid columns="2" gap="2" p="3" aria-label="Backup codes" role="list">
          {codes.map((c) => <Code key={c} size="3" variant="ghost" role="listitem">{c}</Code>)}
        </Grid>
      </Card>
      <div>
        <RowButton onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => announce("Backup codes copied."))}>Copy the codes</RowButton>
      </div>
    </Flex>
  );
}

/** Turning it on: the password, then the app, then the backup codes. */
function SetUp({ me, onDone }: { me: Me; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", { password, issuer: displayAppName(me.organization) });
      setPassword("");
      setStep({ kind: "scan", uri: r.totpURI, backupCodes: r.backupCodes });
    } catch (e) {
      setError(/password/i.test((e as Error).message) ? "That password isn't right." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== "scan") return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/two-factor/verify-totp", { code: code.replace(/\s/g, "") });
      setStep({ kind: "codes", backupCodes: step.backupCodes });
      announce("Two-factor sign-in is on.");
    } catch {
      setError("That code didn't work. Enter the code your app shows now.");
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "password") {
    return (
      <form onSubmit={start} aria-label="Set up two-factor sign-in">
        <Flex direction="column" gap="3">
          <Text as="p" size="2">You'll need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy.</Text>
          <Box maxWidth="22rem">
            <TextInput label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Box>
          <InlineError message={error} />
          <div><ActionButton type="submit" busy={busy} disabled={!password}>Set up two-factor sign-in</ActionButton></div>
        </Flex>
      </form>
    );
  }
  if (step.kind === "scan") {
    return (
      <form onSubmit={confirm} aria-label="Confirm your authenticator app">
        <Flex direction="column" gap="3">
          <Text as="p" size="2">1. In your authenticator app, add an account and scan this code.</Text>
          <QrCode text={step.uri} />
          <Text as="p" size="2" color="gray">
            Can't scan it? Type this key instead: <Code size="2">{setupKey(step.uri)}</Code>
          </Text>
          <Text as="p" size="2">2. Enter the 6-digit code the app shows.</Text>
          <Box maxWidth="12rem">
            <TextInput label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Box>
          <InlineError message={error} />
          <div><ActionButton type="submit" busy={busy} disabled={!code.trim()}>Turn on</ActionButton></div>
        </Flex>
      </form>
    );
  }
  return (
    <Flex direction="column" gap="3">
      <Text as="p" size="2" weight="medium" role="status">Two-factor sign-in is on. From now on you'll enter a code from your app after your password.</Text>
      <BackupCodes codes={step.backupCodes} />
      <div><ActionButton onClick={onDone}>I've saved my backup codes</ActionButton></div>
    </Flex>
  );
}

/** While it's on: new backup codes, or turning it off with the password and a code. */
function IsOn({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<"none" | "codes" | "off">("none");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const reset = (next: typeof mode) => { setMode(next); setPassword(""); setCode(""); setError(null); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "codes") {
        const r = await api<{ backupCodes: string[] }>("/api/auth/two-factor/generate-backup-codes", { password });
        setCodes(r.backupCodes);
        reset("none");
        announce("New backup codes made. The old ones no longer work.");
      } else {
        await api("/api/auth/two-factor/disable", { password, code: code.replace(/\s/g, "") });
        announce("Two-factor sign-in is off.");
        onChanged();
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(/password/i.test(message) ? "That password isn't right." : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Text as="p" size="2">Two-factor sign-in is on. You enter a code from your authenticator app, or a backup code, after your password.</Text>
      {codes && <BackupCodes codes={codes} />}
      {mode === "none" ? (
        <Flex gap="3" wrap="wrap">
          <RowButton onClick={() => reset("codes")}>Get new backup codes</RowButton>
          <RowButton danger onClick={() => reset("off")}>Turn off two-factor sign-in</RowButton>
        </Flex>
      ) : (
        <form onSubmit={submit} aria-label={mode === "codes" ? "Get new backup codes" : "Turn off two-factor sign-in"}>
          <Flex direction="column" gap="3">
            {mode === "codes" && <Text as="p" size="2">New codes replace all the old ones.</Text>}
            <Box maxWidth="22rem">
              <TextInput label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Box>
            {mode === "off" && (
              <Box maxWidth="22rem">
                <TextInput label="Code from your app, or a backup code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </Box>
            )}
            <InlineError message={error} />
            <Flex gap="3">
              <ActionButton type="submit" busy={busy} color={mode === "off" ? "red" : undefined} disabled={!password || (mode === "off" && !code.trim())}>
                {mode === "codes" ? "Make new codes" : "Turn off"}
              </ActionButton>
              <RowButton onClick={() => reset("none")}>Cancel</RowButton>
            </Flex>
          </Flex>
        </form>
      )}
    </Flex>
  );
}

/** Your account → Two-factor sign-in. */
export function TwoFactorPage({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const tf = me.user.twoFactor;
  return (
    <>
      <PageHeader title="Two-factor sign-in" intro="A code from your phone after your password, so a stolen password isn't enough to sign in." help="team-and-permissions/two-factor-sign-in" />
      <SettingsSection title="Your two-factor sign-in">
        {tf.enabled ? (
          <IsOn onChanged={onChanged} />
        ) : !tf.hasPassword ? (
          <Text as="p" size="2">You sign in through single sign-on, so two-factor sign-in is set up with your single sign-on provider.</Text>
        ) : (
          <SetUp me={me} onDone={onChanged} />
        )}
      </SettingsSection>
    </>
  );
}

/** At sign-in, when the organization requires two-factor and this person hasn't set it up yet. */
export function TwoFactorRequired({ me, onDone, onSignOut }: { me: Me; onDone: () => void; onSignOut: () => void }) {
  return (
    <AuthCard title="Set up two-factor sign-in" intro={<p>{displayAppName(me.organization)} asks everyone to use a code from their phone after their password. Set it up to continue.</p>}>
      <SetUp me={me} onDone={onDone} />
      <Box mt="4">
        <RowButton onClick={() => void api("/api/auth/sign-out", {}).catch(() => undefined).then(onSignOut)}>Sign out</RowButton>
      </Box>
    </AuthCard>
  );
}
