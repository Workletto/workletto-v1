import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accentColors,
  BACKGROUNDS,
  contrast,
  HEX_COLOR,
  INDICATOR_CONTRAST,
  PALETTE,
  readableOn,
  TEXT_CONTRAST,
  type ColorMode,
} from "../src/shared/color.ts";

const MODES: ColorMode[] = ["light", "dark"];
const worst = (color: string, mode: ColorMode) => Math.min(...BACKGROUNDS[mode].map((bg) => contrast(color, bg)));

function hue(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("accent colors that stay readable", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  for (const accent of ["#a7f3d0", "#0b1f3a"]) {
    for (const mode of MODES) {
      it(`${accent} reaches 4.5:1 as text and 3:1 as a focus outline in ${mode} mode`, () => {
        const { text, focus } = accentColors(accent);
        expect(text[mode]).toMatch(HEX_COLOR);
        expect(worst(text[mode], mode)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        expect(worst(focus[mode], mode)).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
      });
    }
  }

  it("adjusts only the mode where the accent is not readable", () => {
    expect(accentColors("#a7f3d0").adjustedModes).toEqual(["light"]); // pale mint: fine on dark, invisible on light
    expect(accentColors("#0b1f3a").adjustedModes).toEqual(["dark"]); // near-navy: fine on light, invisible on dark
    expect(accentColors("#2f5288").adjustedModes).toEqual(["dark"]); // a mid blue: fine on light, too dim to read on dark
    expect(accentColors("#808080").adjustedModes).toEqual(["light", "dark"]); // no single grey is readable on both
  });

  it("leaves a readable accent exactly as it is", () => {
    const { text, focus } = accentColors("#0B1F3A");
    expect(text.light).toBe("#0b1f3a");
    expect(focus.light).toBe("#0b1f3a");
    expect(accentColors("#a7f3d0").text.dark).toBe("#a7f3d0");
  });

  it("keeps the hue, moving lightness only", () => {
    const light = accentColors("#a7f3d0").text.light;
    const dark = accentColors("#0b1f3a").text.dark;
    expect(light).not.toBe("#a7f3d0");
    expect(Math.abs(hue(light) - hue("#a7f3d0"))).toBeLessThan(3);
    expect(Math.abs(hue(dark) - hue("#0b1f3a"))).toBeLessThan(3);
    // Darker for light backgrounds, lighter for dark ones.
    expect(contrast(light, "#ffffff")).toBeGreaterThan(contrast("#a7f3d0", "#ffffff"));
    expect(contrast(dark, "#000000")).toBeGreaterThan(contrast("#0b1f3a", "#000000"));
  });

  it("works for any color, including white, black and greys", () => {
    const steps = [0, 51, 102, 153, 204, 255];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const accent = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const { text, focus } = accentColors(accent);
          for (const mode of MODES) {
            expect(worst(text[mode], mode), `${accent} text in ${mode}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
            expect(worst(focus[mode], mode), `${accent} outline in ${mode}`).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
          }
        }
      }
    }
  });

  it("asks for less contrast when the target is lower", () => {
    const strict = readableOn("#a7f3d0", "light", TEXT_CONTRAST);
    const relaxed = readableOn("#a7f3d0", "light", INDICATOR_CONTRAST);
    expect(contrast(relaxed, "#ffffff")).toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
    expect(contrast(relaxed, "#ffffff")).toBeLessThan(contrast(strict, "#ffffff"));
  });
});

// The palette is written twice: in the stylesheet (what people see) and in PALETTE
// (what the contrast checks use). If someone changes one, this fails until the other is updated.
describe("the palette matches the stylesheet and meets its contrast targets", () => {
  const css = readFileSync("src/client/styles.css", "utf8");
  const block = (start: string) => {
    const from = css.indexOf(start);
    return css.slice(from, css.indexOf("}", from));
  };
  const read = (source: string, name: string) => new RegExp(`--wl-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(source)![1]!.toLowerCase();
  const blocks = { light: block(":root,\n.light {"), dark: block(".dark {") };

  for (const mode of MODES) {
    it(`${mode} mode: every color is the one in PALETTE`, () => {
      for (const name of Object.keys(PALETTE[mode])) expect(read(blocks[mode], name), `${mode} ${name}`).toBe(PALETTE[mode][name as keyof (typeof PALETTE)[ColorMode]]);
    });

    it(`${mode} mode: text, hairlines and form borders are readable`, () => {
      const p = PALETTE[mode];
      for (const background of [p.paper, p.card, p.shell, p.subtle]) {
        expect(contrast(p.ink, background), "ink").toBeGreaterThanOrEqual(7);
        expect(contrast(p.muted, background), "muted text").toBeGreaterThanOrEqual(TEXT_CONTRAST);
        // Form fields and the edges of controls: 3:1 (WCAG 1.4.11).
        expect(contrast(p.control, background), "control border").toBeGreaterThanOrEqual(INDICATOR_CONTRAST);
      }
    });
  }
});
