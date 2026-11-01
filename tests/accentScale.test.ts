import { describe, expect, it } from "vitest";
import { accentScale, accentVariables, hexToOklch, oklchToHex } from "../src/shared/accentScale.ts";
import { BACKGROUNDS, contrast, DEFAULT_ACCENT, HEX_COLOR, INDICATOR_CONTRAST, TEXT_CONTRAST, type ColorMode } from "../src/shared/color.ts";

const MODES: ColorMode[] = ["light", "dark"];
const ACCENTS: Record<string, string> = {
  default: DEFAULT_ACCENT,
  "pale mint": "#a7f3d0",
  "dark navy": "#0b1f3a",
  "pure red": "#ff0000",
  "pure yellow": "#ffff00",
};
const lowest = (color: string, backgrounds: readonly string[]) => Math.min(...backgrounds.map((bg) => contrast(color, bg)));
const lightness = (hex: string) => hexToOklch(hex)[0];

/** A transparent #rrggbbaa laid over an opaque #rrggbb. */
function over(alphaColor: string, background: string): string {
  const [c, b] = [alphaColor, background].map((h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)));
  const a = Number.parseInt(alphaColor.slice(7, 9), 16) / 255;
  return `#${c!.map((v, i) => Math.round(v! * a + b![i]! * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}

describe("OKLCH conversion", () => {
  it("round-trips colors", () => {
    for (const hex of ["#2b4a78", "#a7f3d0", "#0b1f3a", "#ff0000", "#ffff00", "#808080", "#ffffff", "#000000", "#7c3aed"]) {
      expect(oklchToHex(hexToOklch(hex)), hex).toBe(hex);
    }
  });

  it("lowers chroma instead of leaving the screen's colors", () => {
    expect(oklchToHex([0.9, 0.4, 150])).toMatch(HEX_COLOR);
    expect(oklchToHex([0.5, 0.6, 20])).toMatch(HEX_COLOR);
  });
});

describe("accent scale", () => {
  for (const [name, accent] of Object.entries(ACCENTS)) {
    for (const mode of MODES) {
      describe(`${name} (${accent}) in ${mode} mode`, () => {
        const scale = accentScale(accent)[mode];

        it("has twelve steps and twelve transparent steps, with the exact color as step 9", () => {
          expect(scale.steps).toHaveLength(12);
          expect(scale.alpha).toHaveLength(12);
          for (const step of scale.steps) expect(step).toMatch(HEX_COLOR);
          expect(scale.steps[8]).toBe(accent);
        });

        it("makes step 11 readable text (4.5:1) on the page, panels and the tints under it", () => {
          const around = [...BACKGROUNDS[mode], scale.steps[2]!, scale.steps[3]!];
          expect(lowest(scale.steps[10]!, around)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
          // Step 12 is the stronger of the two.
          expect(lowest(scale.steps[11]!, around)).toBeGreaterThanOrEqual(lowest(scale.steps[10]!, around));
        });

        it("makes the focus ring (3:1) and the indicator (3:1) stand out from the page and panels", () => {
          expect(lowest(scale.focus, BACKGROUNDS[mode])).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
          expect(lowest(scale.indicator, BACKGROUNDS[mode])).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
        });

        it("keeps button labels and ticks readable", () => {
          expect(contrast(scale.contrast, accent)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
          expect(contrast(scale.indicatorInk, scale.indicator)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        });

        it("orders the tints from the page toward the color", () => {
          const l = scale.steps.slice(0, 8).map(lightness);
          for (let i = 1; i < 8; i++) {
            if (mode === "light") expect(l[i], `step ${i + 1}`).toBeLessThan(l[i - 1]!);
            else expect(l[i], `step ${i + 1}`).toBeGreaterThan(l[i - 1]!);
          }
          // Text steps sit at the far end from the page.
          if (mode === "light") expect(lightness(scale.steps[11]!)).toBeLessThan(lightness(scale.steps[10]!));
          else expect(lightness(scale.steps[11]!)).toBeGreaterThan(lightness(scale.steps[10]!));
        });

        it("makes each transparent step look like its solid step on a card", () => {
          const card = BACKGROUNDS[mode][1]!;
          for (let i = 0; i < 10; i++) {
            const seen = over(scale.alpha[i]!, card);
            for (const k of [1, 3, 5]) {
              const difference = Math.abs(Number.parseInt(seen.slice(k, k + 2), 16) - Number.parseInt(scale.steps[i]!.slice(k, k + 2), 16));
              expect(difference, `step ${i + 1}`).toBeLessThanOrEqual(3);
            }
          }
        });
      });
    }
  }

  it("draws an edge around solid controls only where the fill can't be seen", () => {
    expect(accentScale("#0b1f3a").light.edge).toBeNull(); // navy on a light page is plain to see
    expect(accentScale("#0b1f3a").dark.edge).not.toBeNull(); // navy on a dark page is not
    expect(accentScale("#a7f3d0").light.edge).not.toBeNull(); // pale mint on a light page is not
    expect(accentScale("#a7f3d0").dark.edge).toBeNull();
    expect(accentScale(DEFAULT_ACCENT).light.edge).toBeNull();
  });

  it("is the same for upper and lower case", () => {
    expect(accentScale("#A7F3D0")).toEqual(accentScale("#a7f3d0"));
  });

  it("meets every target for colors across the whole range, including white, black and greys", () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const accent = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          for (const mode of MODES) {
            const scale = accentScale(accent)[mode];
            const around = [...BACKGROUNDS[mode], scale.steps[2]!, scale.steps[3]!];
            expect(lowest(scale.steps[10]!, around), `${accent} step 11 in ${mode}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
            expect(lowest(scale.focus, BACKGROUNDS[mode]), `${accent} focus in ${mode}`).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
            expect(lowest(scale.indicator, BACKGROUNDS[mode]), `${accent} indicator in ${mode}`).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
            expect(contrast(scale.contrast, accent), `${accent} label`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
          }
        }
      }
    }
  });
});

describe("accent variables for Radix Themes", () => {
  it("names every variable Radix reads for its accent", () => {
    const vars = accentVariables("#0b1f3a", "dark");
    for (let i = 1; i <= 12; i++) {
      expect(vars[`--accent-${i}`], `--accent-${i}`).toMatch(HEX_COLOR);
      expect(vars[`--accent-a${i}`], `--accent-a${i}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
    expect(vars["--accent-9"]).toBe("#0b1f3a");
    expect(vars["--accent-contrast"]).toBe("#ffffff");
    for (const name of ["--accent-surface", "--accent-indicator", "--accent-track", "--wl-focus", "--wl-edge", "--wl-indicator-ink"]) expect(vars[name], name).toBeTruthy();
  });

  it("differs between modes only where it should", () => {
    const light = accentVariables("#a7f3d0", "light");
    const dark = accentVariables("#a7f3d0", "dark");
    expect(light["--accent-9"]).toBe(dark["--accent-9"]);
    expect(light["--accent-11"]).not.toBe(dark["--accent-11"]);
    expect(light["--accent-contrast"]).toBe("#000000");
  });
});
