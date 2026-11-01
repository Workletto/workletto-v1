// Color helpers shared by the server (validation) and the interface (theming).

export const COLOR_MODES = ["system", "light", "dark"] as const;
export type ColorModeName = (typeof COLOR_MODES)[number];

/** Only six-digit hex colors are stored, so nothing else can reach a style. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text color for buttons filled with the accent: whichever of white or black reads better (one always reaches 4.5:1). */
export function inkOn(hex: string): "#ffffff" | "#000000" {
  return contrast(hex, "#ffffff") >= contrast(hex, "#000000") ? "#ffffff" : "#000000";
}

// ---- Readable versions of the accent color ----
//
// The accent is used for button fills as picked (the label color is chosen to suit it),
// but also as text and as the focus outline. Those two must stand out from the page
// in each mode, so they get their own shade: same hue and saturation, lightness
// moved until the contrast is enough (WCAG 1.4.3 and 1.4.11).

export type ColorMode = "light" | "dark";

/** Text needs 4.5:1; focus outlines and other indicators need 3:1. */
export const TEXT_CONTRAST = 4.5;
export const INDICATOR_CONTRAST = 3;

/**
 * The built-in look, per mode: paper (the page), card (menus and dialogs), ink and
 * muted text, hairline dividers and the border of form controls. styles.css
 * (--wl-paper and friends) holds the same values; a test checks they match, and
 * that each one meets its contrast target.
 */
export const PALETTE = {
  light: { paper: "#ffffff", card: "#ffffff", ink: "#1b1a17", muted: "#565b64", hairline: "#dcdfe4", control: "#80858e", shell: "#eceef2", subtle: "#f6f7f9" },
  dark: { paper: "#14161a", card: "#1c1f24", ink: "#ececef", muted: "#a3a8b2", hairline: "#2d3139", control: "#737a86", shell: "#0c0e11", subtle: "#1a1d22" },
} as const;

/** The accent used until an administrator picks one: deep ink blue. */
export const DEFAULT_ACCENT = "#2b4a78";

/** The page, card, sidebar (shell) and band (subtle) colors of each mode, which accent text and outlines must stand out from. */
export const BACKGROUNDS: Record<ColorMode, readonly string[]> = {
  light: [PALETTE.light.paper, PALETTE.light.card, PALETTE.light.shell, PALETTE.light.subtle],
  dark: [PALETTE.dark.paper, PALETTE.dark.card, PALETTE.dark.shell, PALETTE.dark.subtle],
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

function toHsl(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = (t + 360) % 360;
    const v = u < 60 ? p + (q - p) * (u / 60) : u < 180 ? q : u < 240 ? p + (q - p) * ((240 - u) / 60) : p;
    return v * 255;
  };
  return toHex(channel(h + 120), channel(h), channel(h - 120));
}

/** The lowest contrast of a color against any of the backgrounds. */
const worstContrast = (color: string, backgrounds: readonly string[]) => Math.min(...backgrounds.map((bg) => contrast(color, bg)));

/**
 * The accent, adjusted so it reaches `minimum` contrast against every background
 * of the mode: darker on light backgrounds, lighter on dark ones. Unchanged if
 * it already does.
 */
export function readableOn(color: string, mode: ColorMode, minimum: number): string {
  const start = color.toLowerCase();
  const backgrounds = BACKGROUNDS[mode];
  if (worstContrast(start, backgrounds) >= minimum) return start;
  const [h, s, l] = toHsl(start);
  // Black (or white) always reaches the contrast, so search between the color and that end.
  let enough = mode === "light" ? 0 : 1;
  let short = l;
  for (let i = 0; i < 24; i++) {
    const middle = (enough + short) / 2;
    if (worstContrast(fromHsl(h, s, middle), backgrounds) >= minimum) enough = middle;
    else short = middle;
  }
  return fromHsl(h, s, enough);
}

export type AccentColors = {
  /** For text in the accent color, per mode. */
  text: Record<ColorMode, string>;
  /** For the focus outline, per mode. */
  focus: Record<ColorMode, string>;
  /** The modes in which the accent itself was not readable enough and had to change. */
  adjustedModes: ColorMode[];
};

export function accentColors(accent: string): AccentColors {
  const own = accent.toLowerCase();
  const text = { light: readableOn(own, "light", TEXT_CONTRAST), dark: readableOn(own, "dark", TEXT_CONTRAST) };
  const focus = { light: readableOn(own, "light", INDICATOR_CONTRAST), dark: readableOn(own, "dark", INDICATOR_CONTRAST) };
  const adjustedModes = (["light", "dark"] as const).filter((mode) => text[mode] !== own || focus[mode] !== own);
  return { text, focus, adjustedModes };
}
