// Logo checks. The file is stored exactly as uploaded: no image library ever
// decodes it on the server (image decoders are a common source of security
// holes, and customer installs can't be patched quickly). Instead we read the
// file's own header to confirm its type and size, and browsers do the decoding.

import { LOGO_TYPES, MAX_LOGO_BYTES } from "../shared/limits.ts";

export const MIN_LOGO_SIDE = 16;
export const MAX_LOGO_SIDE = 4096;

export type ImageInfo = { contentType: (typeof LOGO_TYPES)[number]; width: number; height: number };

const ascii = (b: Uint8Array, start: number, text: string) =>
  b.length >= start + text.length && [...text].every((ch, i) => b[start + i] === ch.charCodeAt(0));
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v) || !ascii(b, 12, "IHDR")) return null;
  return { contentType: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === undefined) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // markers without a length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any size
    if (i + 2 > b.length) return null;
    const length = u16be(b, i);
    if (length < 2) return null;
    // Start-of-frame markers carry the size: C0–CF except C4, C8 and CC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > b.length) return null;
      return { contentType: "image/jpeg", height: u16be(b, i + 3), width: u16be(b, i + 5) };
    }
    i += length;
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8X")) {
    return { contentType: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (ascii(b, 12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { contentType: "image/webp", width: ((b[26]! | (b[27]! << 8)) & 0x3fff), height: ((b[28]! | (b[29]! << 8)) & 0x3fff) };
  }
  if (ascii(b, 12, "VP8L") && b[20] === 0x2f) {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Identifies a PNG, JPEG or WebP file by its contents (never its name or declared type). */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

/** The image details when the logo is acceptable, otherwise a message for the person uploading. */
export function checkLogo(bytes: Uint8Array, maxBytes = MAX_LOGO_BYTES): { status: 400 | 413; error: string } | ImageInfo {
  if (bytes.length === 0) return { status: 400, error: "Choose an image file to upload." };
  if (bytes.length > maxBytes) {
    const limit = maxBytes % (1024 * 1024) === 0 ? `${maxBytes / (1024 * 1024)} MB` : `${maxBytes / 1024} KB`;
    return { status: 413, error: `That file is over ${limit}. Try a smaller or compressed image.` };
  }
  const info = inspectImage(bytes);
  if (!info) return { status: 400, error: "Upload a PNG, JPEG or WebP image. SVG and other formats aren't supported." };
  if (Math.min(info.width, info.height) < MIN_LOGO_SIDE || Math.max(info.width, info.height) > MAX_LOGO_SIDE) {
    return { status: 400, error: `Logos must be between ${MIN_LOGO_SIDE} and ${MAX_LOGO_SIDE} pixels on each side.` };
  }
  return info;
}
