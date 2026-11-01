// A QR code for two-factor setup (WRK-147): the otpauth:// address an authenticator app scans.
// Byte mode, error correction level M, versions 1 to 15 (up to 412 bytes), following ISO/IEC 18004
// and the layout of Project Nayuki's reference generator. Small on purpose: no package to install.

/** Per version (index 0 = version 1): [EC codewords per block, blocks, total codewords]. Level M. */
const BLOCKS: [number, number, number][] = [
  [10, 1, 26], [16, 1, 44], [26, 1, 70], [18, 2, 100], [24, 2, 134], [16, 4, 172], [18, 4, 196], [22, 4, 242],
  [22, 5, 292], [26, 5, 346], [30, 5, 404], [22, 8, 466], [22, 9, 532], [24, 9, 581], [24, 10, 655],
];
const ALIGNMENT: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];
/** Error correction level M's two format bits. */
const LEVEL_M = 0;

const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

function gfMultiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number) {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => (result[i]! ^= gfMultiply(coefficient, factor)));
  }
  return result;
}

/** The data codewords for `bytes` in a version: mode, length, data, terminator and padding. */
function dataCodewords(bytes: Uint8Array, version: number) {
  const [ecLen, blocks, total] = BLOCKS[version - 1]!;
  const capacity = total - ecLen * blocks;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) push(pad, 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  return words;
}

/** Splits into blocks, adds each block's error correction, and interleaves them. */
function withErrorCorrection(data: number[], version: number) {
  const [ecLen, numBlocks, total] = BLOCKS[version - 1]!;
  const shortBlocks = numBlocks - (total % numBlocks);
  const shortLength = Math.floor(total / numBlocks);
  const divisor = rsDivisor(ecLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortLength - ecLen + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - ecLen || j >= shortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** How hard a symbol is to read (ISO/IEC 18004 §7.8.3): lower is better. */
function penalty(m: boolean[][]) {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
      // A finder-like 1:1:3:1:1 pattern with four light modules on one side.
      for (let j = 0; j + 11 <= size; j++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? "1" : "0")).join("");
        if (s === "10111010000" || s === "00001011101") score += 40;
      }
    }
  };
  line((i, j) => m[i]![j]!);
  line((i, j) => m[j]![i]!);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) score += 3;
    }
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/** The QR code for `text` as rows of modules (true = dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= BLOCKS.length) {
    const [ecLen, blocks, total] = BLOCKS[version - 1]!;
    if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= (total - ecLen * blocks) * 8) break;
    version++;
  }
  if (version > BLOCKS.length) throw new Error("Too long for a QR code.");
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = ALIGNMENT[version - 1]!;
  const last = positions.length - 1;
  positions.forEach((px, i) => positions.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask: number) => {
    const data = (LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  const codewords = withErrorCorrection(dataCodewords(bytes, version), version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!isFunction[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  // The mask that reads best.
  const masked = (mask: number) => {
    const copy = modules.map((row, y) => row.map((dark, x) => (isFunction[y]![x] ? dark : dark !== MASKS[mask]!(x, y))));
    return copy;
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const score = penalty(masked(mask));
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
  }
  drawFormat(best);
  return masked(best);
}

/** An SVG path drawing the dark modules, one unit each, offset by a 4-module quiet zone. */
export function qrPath(matrix: boolean[][]) {
  const parts: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  }));
  return parts.join("");
}
