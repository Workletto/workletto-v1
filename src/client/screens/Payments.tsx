import { useEffect, useState, type FormEvent } from "react";
import { Flex } from "@radix-ui/themes";
import { announce } from "../a11y.tsx";
import { api } from "../api.ts";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, ErrorNote, InlineError, Loading, Notice, PageHeader, RowButton, SettingsSection, TextInput, useConfirm } from "../ui.tsx";

// Whether Stripe's payment notifications reach this app (see notificationsFor on the server).
type Notifications = { state: "here" | "none" | "unknown" | "unreachable" } | { state: "elsewhere"; host: string };
type Settings =
  | { connected: false; lastError?: string }
  | { connected: true; provider: "stripe"; mode: "test" | "live"; keyHint: string; webhook: boolean; lastError: string | null; notifications?: Notifications };

// Manage → Payments (admins): connect the organization's own Stripe account so clients can pay invoices online.
export function Payments() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Settings>("/api/settings/payments").then(setSettings, (e: Error) => setLoadError(e.message));
  }, []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api<Settings>("/api/settings/payments", { provider: "stripe", key }, "PUT"));
      setKey("");
      setReplacing(false);
      announce("Connected to Stripe.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect Stripe?",
      description: "Clients won't be able to pay online until you connect again.",
      confirm: "Disconnect",
      danger: true,
    });
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api<Settings>("/api/settings/payments", undefined, "DELETE"));
      setReplacing(false);
      announce("Stripe disconnected.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Sends Stripe's notifications to this app, after it moved to another address (or if they were never set up).
  async function sendHere(from: string | null) {
    if (from) {
      const ok = await confirm({
        title: "Send payment notifications here?",
        description: `Stripe stops sending them to ${from}. Do this only if this app used to be at that address. If ${from} is another copy of this app that's still in use, it would stop receiving payment notifications straight away.`,
        confirm: "Send them here",
      });
      if (!ok) return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api<Settings>("/api/settings/payments/webhook", {}, "POST"));
      announce("Stripe now sends payment notifications to this app.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connected = settings?.connected ? settings : null;
  const notifications = connected?.notifications;
  const showForm = settings && (!connected || replacing);

  return (
    <>
      <PageHeader title="Payments" help="invoicing-and-payments/online-payments" intro="Let clients pay invoices online with your own Stripe account. The money goes straight to you." />
      <ManageTabs role="admin" />
      {loadError ? (
        <ErrorNote message={loadError} />
      ) : !settings ? (
        <Loading />
      ) : (
        <>
          {!connected && settings.lastError && <Notice color="amber">{settings.lastError}</Notice>}
          <SettingsSection
            title="Stripe"
            description={
              connected
                ? `Connected to Stripe (${connected.mode === "test" ? "Test mode" : "Live mode"}), key ending ${connected.keyHint}.`
                : "In the Stripe Dashboard, create a restricted key with Checkout Sessions: Write (and Webhook Endpoints: Write, so Stripe can send this app payment notifications straight away). Paste it here."
            }
          >
            {notifications?.state === "unreachable" && <Notice color="gray">Payments are checked with Stripe every few minutes.</Notice>}
            {notifications?.state === "elsewhere" && (
              <Notice color="amber">
                Stripe sends payment notifications to {notifications.host}, so payments show up in this app within a few minutes.{" "}
                <ActionButton size="1" variant="soft" busy={busy} onClick={() => void sendHere(notifications.host)}>Send them here</ActionButton>
              </Notice>
            )}
            {notifications?.state === "none" && (
              <Notice color="gray">
                Stripe isn't set up to send this app payment notifications, so payments are checked every few minutes.{" "}
                <ActionButton size="1" variant="soft" busy={busy} onClick={() => void sendHere(null)}>Set it up</ActionButton>
              </Notice>
            )}
            {!showForm && <InlineError message={error} id="payments-error" />}
            {connected?.lastError && <Notice color="amber">{connected.lastError}</Notice>}
            {connected?.mode === "test" && <Notice color="gray">Test mode: use card 4242 4242 4242 4242 to try a payment. No real money moves.</Notice>}
            {showForm && (
              <form onSubmit={connect} noValidate>
                <Flex direction="column" gap="4">
                  <TextInput
                    label="Stripe key"
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                    placeholder="rk_… or sk_…"
                    required
                    invalid={!!error}
                    errorId={error ? "payments-error" : undefined}
                  />
                  <InlineError message={error} id="payments-error" />
                  <Flex align="center" gap="4" wrap="wrap">
                    {connected && <RowButton type="button" onClick={() => { setReplacing(false); setKey(""); setError(null); }}>Cancel</RowButton>}
                    <ActionButton type="submit" busy={busy} busyLabel="Checking the key…">{connected ? "Replace key" : "Connect"}</ActionButton>
                  </Flex>
                </Flex>
              </form>
            )}
            {connected && !replacing && (
              <Flex align="center" gap="4" wrap="wrap">
                <RowButton danger onClick={() => void disconnect()}>Disconnect</RowButton>
                <ActionButton variant="soft" onClick={() => setReplacing(true)}>Replace key</ActionButton>
              </Flex>
            )}
            {!showForm && <InlineError message={error} />}
          </SettingsSection>
        </>
      )}
    </>
  );
}
