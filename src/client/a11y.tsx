import { useEffect, useRef, useState } from "react";
import { currentPageTitle } from "./theme.ts";

// Behaviour that keeps the app usable with a keyboard and a screen reader.
// Nothing here is about how things look.

// ---- Announcements ----

let publish: ((message: string) => void) | null = null;

/** The Approvals screen fires this when a week is approved, sent back or reopened, so the sidebar count follows at once. */
export const APPROVALS_CHANGED = "wl:approvals-changed";

/** Tells screen reader users something without moving focus. It waits for them to finish what they're hearing. Use role="alert" for errors instead. */
export function announce(message: string) {
  publish?.(message);
}

/** The one polite live region. It is mounted when the app starts and stays in the page, so changes to it are reliably read out. */
export function LiveRegion() {
  const [text, setText] = useState("");
  useEffect(() => {
    let show = 0;
    let clear = 0;
    publish = (message) => {
      window.clearTimeout(show);
      window.clearTimeout(clear);
      // Emptied first, so saying the same thing twice is still heard twice.
      setText("");
      show = window.setTimeout(() => setText(message), 100);
      clear = window.setTimeout(() => setText(""), 8000);
    };
    return () => {
      publish = null;
      window.clearTimeout(show);
      window.clearTimeout(clear);
    };
  }, []);
  return <div role="status" className="wl-sr-only">{text}</div>;
}

/** Announces a message once `ready` turns true, for pages that show "Loading…" first. */
export function useAnnounceWhen(ready: boolean, message: string) {
  useEffect(() => {
    if (ready) announce(message);
    // Read when the page becomes ready, not each time its wording changes.
  }, [ready]);
}

// ---- Buttons that are busy ----

/**
 * Buttons that are busy use aria-disabled rather than disabled, so they keep
 * keyboard focus. This stops a click, or Enter in a form, from reaching them.
 */
export function installBusyGuard() {
  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest('[aria-disabled="true"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

// ---- Focus ----

/** Moves focus to the page's heading. */
export function focusMainHeading() {
  document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
}

let pageChangedAt = 0;

/** Called when the address changes. The next page heading to appear takes focus. */
export function requestPageFocus() {
  pageChangedAt = Date.now();
}

/**
 * A page heading calls this whenever it renders. After a page change it takes
 * focus, unless a control on the page itself still has it (the previous and next
 * day buttons, the tabs of a project): then focus stays put and the new title is announced.
 */
export function claimPageFocus(heading: HTMLElement | null) {
  if (!heading || !pageChangedAt || Date.now() - pageChangedAt > 3000) return;
  pageChangedAt = 0;
  const active = document.activeElement;
  if (active && active !== document.body && document.getElementById("main")?.contains(active)) {
    announce(currentPageTitle());
    return;
  }
  heading.focus({ preventScroll: true });
}

/**
 * A safety net: if the control that had focus is taken out of the page (a Stop
 * button, a row that moved to another list), focus would fall to the top of the
 * document. Put it on the page heading instead.
 */
export function installFocusRescue() {
  let last: Element | null = null;
  document.addEventListener("focusin", (event) => {
    last = event.target as Element;
  });
  document.addEventListener("focusout", (event) => {
    const left = event.target as Element;
    // Leaving on purpose (a click on empty space) is not a loss. Being removed is.
    if (!(event as FocusEvent).relatedTarget) queueMicrotask(() => last === left && left.isConnected && (last = null));
  });
  new MutationObserver(() => {
    if (!last || last.isConnected) return;
    last = null;
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) focusMainHeading();
    });
  }).observe(document.body, { childList: true, subtree: true });
}

/**
 * Open and close for an editor that replaces a row or a button. Give `openerRef`
 * to the control that opens it: closing puts focus back there. Put `autoFocus`
 * on the editor's first field.
 */
export function useEditor() {
  const [editing, setEditing] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  useEffect(() => {
    if (!editing && restore.current) {
      restore.current = false;
      openerRef.current?.focus();
    }
  }, [editing]);
  return {
    editing,
    openerRef,
    open: () => setEditing(true),
    /** Pass false when something else has taken focus (a new invite link). */
    close: (returnFocus = true) => {
      restore.current = returnFocus;
      setEditing(false);
    },
  };
}
