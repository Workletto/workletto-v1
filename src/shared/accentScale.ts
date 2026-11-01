// A Radix-style 12-step color scale for any accent color an administrator picks.
//
// Radix Themes colors come as twelve steps per mode: 1-2 page and panel tints,
// 3-5 component backgrounds (normal, hover, pressed), 6-8 borders, 9 the solid
// color, 10 its hover, 11 low-contrast text and 12 high-contrast text. Radix only
// ships fixed hues, so for a customer's color we build the same shape ourselves.
//
// Approach: read the color in OKLCH (perceptual lightness, chroma, hue). Step 9 is
// the exact color. Steps 1-8 keep its hue and take chroma in proportion to it, on a
// fixed lightness ladder per mode (the ladder is what makes every accent look like
// part of the same family). Step 10 nudges step 9; steps 11 and 12 keep the hue and
// are moved in lightness until step 11 is readable text (4.5:1) on the page, the
// panels and the tinted backgrounds it sits on. The focus ring and the "indicator"
// (checked boxes, selected controls) use the accent where it already stands out from
// the page by 3:1, else a shade of it that does. Contrast is measured with the same
// helpers as everywhere else (color.ts).

import { BACKGROUNDS, contrast, inkOn, INDICATOR_CONTRAST, readableOn, TEXT_CONTRAST, type ColorMode } from "./color.ts";

type Oklch = [l: number, c: number, h: number];
type Rgb = [number, number, number];

// ---- Color conversion (OKLab, Björn Ottosson; sRGB) ----

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255)) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}

function oklchToLinear([L, C, H]: Oklch): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** An OKLCH color as #rrggbb. A chroma the screen can't show is lowered (same lightness and hue). */
export function oklchToHex([L, C, H]: Oklch): string {
  const inGamut = (c: number) => oklchToLinear([L, c, H]).every((v) => v >= -0.0005 && v <= 1.0005);
  let chroma = C;
  if (!inGamut(C)) {
    let [low, high] = [0, C];
    for (let i = 0; i < 20; i++) {
      const middle = (low + high) / 2;
      if (inGamut(middle)) low = middle;
      else high = middle;
    }
    chroma = low;
  }
  const [r, g, b] = oklchToLinear([Math.min(1, Math.max(0, L)), chroma, H]).map((v) => fromLinear(Math.min(1, Math.max(0, v))) * 255) as Rgb;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

// ---- The scale ----

// Lightness of steps 1-8 and their chroma as a share of the accent's own chroma.
const LADDER = {
  light: { l: [0.993, 0.978, 0.957, 0.932, 0.903, 0.868, 0.822, 0.755], c: [0.04, 0.09, 0.17, 0.27, 0.36, 0.46, 0.58, 0.72] },
  dark: { l: [0.19, 0.22, 0.26, 0.3, 0.34, 0.385, 0.44, 0.515], c: [0.1, 0.18, 0.4, 0.5, 0.58, 0.64, 0.7, 0.76] },
} as const;

export type ModeScale = {
  /** Steps 1-12 as #rrggbb. Step 9 is the administrator's exact color. */
  steps: string[];
  /** Steps 1-12 as #rrggbbaa: the transparent color that looks like the solid step on a card. */
  alpha: string[];
  /** Label color on step 9 (white or black, whichever reads better). */
  contrast: "#ffffff" | "#000000";
  /** Translucent tint for field backgrounds (Radix's --accent-surface). */
  surface: string;
  /** Fill of checked boxes, selected controls and progress: the accent where it stands out from the page (3:1), else a shade of it that does. */
  indicator: string;
  /** Mark drawn on the indicator (a tick in a checked box). */
  indicatorInk: "#ffffff" | "#000000";
  /** A 1px line drawn around solid controls whose fill barely differs from the page, else null. */
  edge: string | null;
  /** The focus ring: 3:1 against the page and panels. */
  focus: string;
};

const lowest = (color: string, backgrounds: readonly string[]) => Math.min(...backgrounds.map((bg) => contrast(color, bg)));

/** The transparent color that, over `background`, looks like the solid `target`. */
function alphaOver(target: string, background: string): string {
  const t = hexToRgb(target);
  const b = hexToRgb(background);
  // The least alpha that reaches the target with black or white as the overlay.
  const needed = t.map((v, i) => (v === b[i]! ? 0 : v < b[i]! ? (b[i]! - v) / b[i]! : (v - b[i]!) / (255 - b[i]!)));
  const alpha = Math.min(1, Math.max(2 / 255, Math.max(...needed)));
  const byte = Math.round(alpha * 255);
  const a = byte / 255;
  const overlay = t.map((v, i) => b[i]! + (v - b[i]!) / a);
  return `#${overlay.map(hex2).join("")}${byte.toString(16).padStart(2, "0")}`;
}

function buildScale(accent: string, mode: ColorMode): ModeScale {
  const nine = accent.toLowerCase();
  const [L9, C9, H] = hexToOklch(nine);
  const ladder = LADDER[mode];
  const dark = mode === "dark";
  const [paper, card] = BACKGROUNDS[mode] as [string, string];

  const steps: string[] = ladder.l.map((l, i) => oklchToHex([l, C9 * ladder.c[i]!, H]));
  steps.push(nine);
  // Step 10 is the hover of step 9: a little lighter on dark backgrounds, a little darker on light ones (lighter if it is already very dark).
  steps.push(oklchToHex([dark ? (L9 > 0.78 ? L9 - 0.05 : L9 + 0.05) : L9 > 0.4 ? L9 - 0.045 : L9 + 0.045, C9, H]));

  // Step 11 is text, so it has to read on the page, on panels and on the tints it is used over.
  const around = [paper, card, steps[2]!, steps[3]!];
  let l11 = dark ? Math.min(0.84, Math.max(L9, 0.76)) : Math.min(0.52, Math.max(L9, 0.36));
  let eleven = oklchToHex([l11, C9 * 0.9, H]);
  for (let i = 0; i < 120 && lowest(eleven, around) < TEXT_CONTRAST + 0.1; i++) {
    l11 += dark ? 0.005 : -0.005;
    eleven = oklchToHex([l11, C9 * 0.9, H]);
  }
  steps.push(eleven);
  steps.push(oklchToHex([dark ? 0.93 : Math.min(0.3, l11 - 0.08), C9 * (dark ? 0.35 : 0.6), H]));

  const alpha = steps.map((step, i) => (i >= 10 ? step : alphaOver(step, card)));
  const own = lowest(nine, BACKGROUNDS[mode]);
  const indicator = own >= INDICATOR_CONTRAST ? nine : readableOn(nine, mode, INDICATOR_CONTRAST);
  return {
    steps,
    alpha,
    contrast: inkOn(nine),
    surface: `${steps[1]}${dark ? "80" : "cc"}`,
    indicator,
    indicatorInk: inkOn(indicator),
    edge: own >= INDICATOR_CONTRAST ? null : indicator,
    focus: readableOn(nine, mode, INDICATOR_CONTRAST),
  };
}

/** The full scale for an accent, light and dark. Pure: same color in, same scale out. */
export function accentScale(accent: string): Record<ColorMode, ModeScale> {
  return { light: buildScale(accent, "light"), dark: buildScale(accent, "dark") };
}

/**
 * The CSS custom properties that make Radix Themes use this accent in one mode:
 * --accent-1…12, --accent-a1…a12, --accent-contrast, -surface, -indicator, -track
 * (what [data-accent-color] rules set for Radix's own colors), plus the app's own
 * --wl-focus, --wl-indicator-ink and --wl-edge.
 */
export function accentVariables(accent: string, mode: ColorMode): Record<string, string> {
  const scale = buildScale(accent, mode);
  const vars: Record<string, string> = {};
  scale.steps.forEach((step, i) => {
    vars[`--accent-${i + 1}`] = step;
    vars[`--accent-a${i + 1}`] = scale.alpha[i]!;
  });
  vars["--accent-contrast"] = scale.contrast;
  vars["--accent-surface"] = scale.surface;
  vars["--accent-indicator"] = scale.indicator;
  vars["--accent-track"] = scale.indicator;
  vars["--wl-indicator-ink"] = scale.indicatorInk;
  vars["--wl-edge"] = scale.edge ?? "transparent";
  vars["--wl-focus"] = scale.focus;
  return vars;
}
