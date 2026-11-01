import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qrMatrix, qrPath } from "../src/shared/qr.ts";

// The QR code on the two-factor setup page (WRK-147). These matrices were decoded with macOS's
// own QR reader (CoreImage) when the encoder was written; the fingerprints keep them that way.
const fingerprint = (text: string) => createHash("sha256").update(qrMatrix(text).map((r) => r.map((d) => (d ? "1" : "0")).join("")).join("\n")).digest("hex");

describe("QR codes", () => {
  it("encode as they were verified with a real reader", () => {
    expect(fingerprint("hello world")).toBe("851bd1031e2539fc5e015f26d9096341dd6514602a440a5806dd968b7c1c2355");
    expect(fingerprint("otpauth://totp/Studio%20North:ada%40studio.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Studio%20North&digits=6&period=30"))
      .toBe("0f4782fa3d1594f91b58a04f4ecdcbaa3ef378dd5e9ba49d3c4a47984cdc1170");
    expect(fingerprint("w".repeat(400))).toBe("a5250b3a1ca6936df6a854168699e6ff60f2dd138e6403f8e117008768573dff");
  });

  it("grow with the text, and refuse what doesn't fit", () => {
    expect(qrMatrix("A")).toHaveLength(21);
    expect(qrMatrix("x".repeat(128))).toHaveLength(49);
    expect(() => qrMatrix("x".repeat(500))).toThrow();
    // The three finder patterns' dark corners, and a path for every dark module.
    const m = qrMatrix("A");
    expect([m[0]![0], m[0]![20], m[20]![0]]).toEqual([true, true, true]);
    expect(qrPath(m).split("M").length - 1).toBe(m.flat().filter(Boolean).length);
  });
});
