import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { localToday } from "../timer.tsx";
import { AuthCard, Button, InlineError, FORM_ERROR_ID } from "../ui.tsx";
import { PRODUCT_NAME } from "../../shared/product.ts";

// The demo's front door: one click makes a private workspace with sample data.
export function DemoStart({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/demo/start", { today: localToday() });
      onDone();
      // Normally the app opens and this screen goes away. If it's still here after a while, the workspace
      // exists but didn't open: say how to get in, rather than waiting forever or making another one.
      setTimeout(() => {
        if (!mounted.current) return;
        setBusy(false);
        setError("Your demo is ready but didn't open. Reload the page to go in.");
      }, 10_000);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title={`Try ${PRODUCT_NAME}`}
      docTitle="Try the demo"
      intro={
        <>
          <p>You get your own private workspace with sample data. There's no sign-up.</p>
          <p>Other visitors can't see it, and it's deleted after 2 hours.</p>
        </>
      }
      footer="This demo runs on our server, so don't enter real client data."
    >
      <InlineError id={FORM_ERROR_ID} message={error} spaced />
      <Button type="button" busy={busy} onClick={start}>Start the demo</Button>
    </AuthCard>
  );
}
