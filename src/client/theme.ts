import { accentVariables } from "../shared/accentScale.ts";
import { DEFAULT_ACCENT, type ColorMode, type ColorModeName } from "../shared/color.ts";
import { displayAppName, NEUTRAL_APP_NAME } from "../shared/product.ts";

// The customer's own name for the app: the app name set in Manage → Settings,
// else the organization's name, else a neutral label (never the vendor brand).
let currentAppName: string = NEUTRAL_APP_NAME;
export const appName = () => currentAppName;

// The browser tab's title: "<page> · <app name>", so every page has its own.
// While a timer runs and the tab is in the background, the tab shows the time
// instead. It is not rewritten while the tab is in view, so assistive
// technology doesn't read it out every second.
let pageTitle: string | null = null;
let timerTitle: string | null = null;
/** The current page's own title, without the app name. */
export const currentPageTitle = () => pageTitle ?? currentAppName;

function showTitle() {
  const page = pageTitle ? `${pageTitle} · ${currentAppName}` : currentAppName;
  const next = document.hidden && timerTitle ? timerTitle : page;
  if (document.title !== next) document.title = next;
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", showTitle);

export function setAppName(org: { appName: string | null; name: string | null } | null) {
  currentAppName = displayAppName(org);
  showTitle();
}
/** Each page sets its own title; null while a new page is still loading. */
export function setPageTitle(title: string | null) {
  pageTitle = title;
  showTitle();
}
export function setTimerTitle(title: string | null) {
  timerTitle = title;
  showTitle();
}

/**
 * The browser tab's icon: the organization's own logo when it has one, else a plain clock. The
 * signed-out screens read the logo from the public branding address.
 */
export function setTabIcon(logoVersion: number | null, signedIn: boolean) {
  if (typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (logoVersion) {
    link.removeAttribute("type");
    link.href = `${signedIn ? "/api/logo" : "/api/branding/logo"}?v=${logoVersion}`;
  } else {
    link.type = "image/svg+xml";
    link.href = "/icon.svg";
  }
}

export type Look = { accentColor: string | null; colorMode: ColorModeName };

// ---- The organization's look: mode and accent ----
//
// Radix Themes reads its colors from CSS variables. This file decides which mode
// is showing (the organization's choice, or the device's when it is "System"),
// puts the class "light" or "dark" on <html>, and sets the accent's variables
// there, generated from the organization's color (shared/accentScale.ts). Every
// element, including menus that open in a portal, inherits them. The values were
// checked by the server (six-digit hex only) and are set as CSS variables, never
// as markup.

let look: Look = { accentColor: null, colorMode: "system" };
let printing = false;
const darkDevice = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
// Names of the accent variables set last time, so none are left behind.
let accentNames: string[] = [];

/** The mode showing now. Printing is always light, so invoices come out as ink on white. */
function showingMode(): ColorMode {
  if (printing) return "light";
  return look.colorMode === "system" ? (darkDevice?.matches ? "dark" : "light") : look.colorMode;
}

function paint() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mode = showingMode();
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");

  const variables = accentVariables(look.accentColor ?? DEFAULT_ACCENT, mode);
  for (const name of accentNames) if (!(name in variables)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  accentNames = Object.keys(variables);
}

if (typeof document !== "undefined") {
  darkDevice?.addEventListener("change", paint);
  window.addEventListener("beforeprint", () => {
    printing = true;
    paint();
  });
  window.addEventListener("afterprint", () => {
    printing = false;
    paint();
  });
  paint();
}

/** The accent's light shades, as inline CSS variables, for a part of the page that always stays light (the invoice on screen). */
export function lightAccent(): Record<string, string> {
  return accentVariables(look.accentColor ?? DEFAULT_ACCENT, "light");
}

// Applies an organization's look to the whole interface.
export function applyLook({ accentColor, colorMode }: Look) {
  look = { accentColor, colorMode };
  const root = document.documentElement;
  if (colorMode === "system") delete root.dataset.theme;
  else root.dataset.theme = colorMode;
  // The chosen color as the organization typed it; empty while the built-in accent is used.
  if (accentColor) root.style.setProperty("--wl-brand", accentColor);
  else root.style.removeProperty("--wl-brand");
  paint();
}
