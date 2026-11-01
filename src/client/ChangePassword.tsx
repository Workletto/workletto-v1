import { useState, type FormEvent } from "react";
import { Dialog, Flex } from "@radix-ui/themes";
import { announce } from "./a11y.tsx";
import { api } from "./api.ts";
import { ActionButton, Field, FORM_ERROR_ID, RowButton, InlineError } from "./ui.tsx";
import { MIN_PASSWORD_LENGTH } from "../shared/limits.ts";

const PASSWORD_LENGTH_MESSAGE = "Choose a password of 10 to 128 characters.";

// Change your own password (account menu). Everywhere else the person is signed in is
// signed out, so a session someone else got hold of doesn't outlive the change.
export function ChangePasswordDialog({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; /** Where focus goes when the dialog closes: the control that opened it. */ returnFocus: () => HTMLElement | null }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = error ? FORM_ERROR_ID : undefined;

  function close() {
    setError(null);
    setBusy(false);
    onOpenChange(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword.length < 10 || newPassword.length > 128) return setError(PASSWORD_LENGTH_MESSAGE);
    if (newPassword !== form.get("again")) return setError("The new passwords don't match.");
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/change-password", { currentPassword: form.get("currentPassword"), newPassword, revokeOtherSessions: true });
      close();
      announce("Password changed.");
    } catch (e) {
      const message = (e as Error).message;
      setError(/invalid password/i.test(message) ? "That isn't your current password." : /too (short|long)/i.test(message) ? PASSWORD_LENGTH_MESSAGE : message);
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && close()}>
      <Dialog.Content
        maxWidth="26rem"
        onCloseAutoFocus={(event) => {
          // Back to the account menu (or the phone's Menu button), not the page heading.
          event.preventDefault();
          returnFocus()?.focus();
        }}
      >
        <Dialog.Title size="4">Change password</Dialog.Title>
        <Dialog.Description size="2" mb="4">You stay signed in here; everywhere else is signed out.</Dialog.Description>
        <form onSubmit={submit} noValidate>
          <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required autoFocus errorId={errorId} />
          <Field label="New password" name="newPassword" type="password" autoComplete="new-password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} errorId={errorId} />
          <Field label="New password again" name="again" type="password" autoComplete="new-password" required errorId={errorId} />
          <InlineError id={FORM_ERROR_ID} message={error} spaced />
          <Flex gap="3" mt="2" justify="end">
            <Dialog.Close>
              <RowButton type="button" size="2">Cancel</RowButton>
            </Dialog.Close>
            <ActionButton type="submit" size="2" busy={busy}>Change password</ActionButton>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
