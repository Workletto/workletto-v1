import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { requestPageFocus } from "./a11y.tsx";
import { setPageTitle } from "./theme.ts";
import { confirmLeave } from "./unsaved.ts";

// A very small router: real paths (/projects, /time/week/2026-10-12) using the
// browser's history. The server sends the app for any path that isn't /api.

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

// A new page has no title yet, and the first heading that appears takes focus
// (see claimPageFocus in a11y.tsx). The Back and Forward buttons count too.
function pageChanged() {
  setPageTitle(null);
  requestPageFocus();
}
window.addEventListener("popstate", pageChanged);

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === location.pathname) return;
  // Unsaved changes in a form: ask before moving on.
  if (!confirmLeave()) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.scrollTo(0, 0);
  pageChanged();
  for (const listener of listeners) listener();
}

/** An ordinary link that changes the page without a reload. Cmd/Ctrl-click still opens a new tab. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }
  return <a href={to} onClick={follow} {...rest} />;
}
