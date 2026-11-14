// A small QR code maker for join links: byte mode, error correction level M, versions 1–10
// (up to 213 bytes, plenty for a PickleHeat link). No dependencies.
// qrMatrix(text) -> array of rows of booleans (true = dark). qrSvg(text) -> an <svg> string.

// Level M: error-correction codewords per block, then [blocks, data codewords per block] groups.
const BLOCKS = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) tables for Reed–Solomon.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data, ecLen) {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], f);
  }
  return rem;
}

const dataCapacity = (v) => BLOCKS[v].slice(1).reduce((s, [n, k]) => s + n * k, 0);

function codewords(bytes, v) {
  const total = dataCapacity(v);
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction, then interleave.
  const [ecLen, ...groups] = BLOCKS[v];
  const dataBlocks = [], ecBlocks = [];
  let at = 0;
  for (const [n, k] of groups) {
    for (let i = 0; i < n; i++) {
      const block = data.slice(at, at + k);
      at += k;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, ecLen));
    }
  }
  const out = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/** Appends BCH error-correction bits: `poly` is the generator, `degree` its degree. */
function bch(value, poly, degree) {
  let v = value << degree;
  for (let i = 20; i >= degree; i--) if ((v >> i) & 1) v ^= poly << (i - degree);
  return (value << degree) | v;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function build(words, v, mask) {
  const n = 17 + 4 * v;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, dark) => { m[r][c] = dark; fixed[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, ring !== 2 && ring !== 4);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const centers = ALIGN[v];
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(n - 8, 8, true); // the always-dark module

  // Format information (level M = 00, then the mask), around the finders.
  const format = bch(mask, 0x537, 10) ^ 0x5412;
  const fbit = (i) => ((format >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
  set(7, 8, fbit(6)); set(8, 8, fbit(7)); set(8, 7, fbit(8));
  for (let i = 9; i <= 14; i++) set(8, 14 - i, fbit(i));
  for (let i = 0; i <= 7; i++) set(8, n - 1 - i, fbit(i));
  for (let i = 8; i <= 14; i++) set(n - 15 + i, 8, fbit(i));

  // Version information for versions 7 and up.
  if (v >= 7) {
    const info = bch(v, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1, a = Math.floor(i / 3), b = n - 11 + (i % 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Data, zig-zagging up and down in two-module columns from the bottom right.
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  let k = 0, up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the timing column
    for (let step = 0; step < n; step++) {
      const r = up ? n - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (fixed[r][c]) continue;
        const bit = k < bits.length ? bits[k] === 1 : false;
        k++;
        m[r][c] = bit !== MASKS[mask](r, c);
      }
    }
    up = !up;
  }
  return m;
}

// A light version of the standard scoring: long runs and big blocks are harder to scan.
function penalty(m) {
  const n = m.length;
  let score = 0, dark = 0;
  for (let r = 0; r < n; r++) {
    let runR = 1, runC = 1;
    for (let c = 0; c < n; c++) {
      if (m[r][c]) dark++;
      if (c > 0) {
        if (m[r][c] === m[r][c - 1]) { if (++runR === 5) score += 3; else if (runR > 5) score++; } else runR = 1;
        if (m[c][r] === m[c - 1][r]) { if (++runC === 5) score += 3; else if (runC > 5) score++; } else runC = 1;
      }
      if (r > 0 && c > 0 && m[r][c] === m[r - 1][c] && m[r][c] === m[r][c - 1] && m[r][c] === m[r - 1][c - 1]) score += 3;
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  while (v <= 10 && bytes.length > dataCapacity(v) - (v < 10 ? 2 : 3)) v++;
  if (v > 10) throw new Error("That's too long for a QR code");
  const words = codewords(bytes, v);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(words, v, mask), s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

/** A crisp, scalable QR code with the standard 4-module quiet border. Dark modules on white. */
export function qrSvg(text, { size = 220, label = "QR code" } = {}) {
  const m = qrMatrix(text), n = m.length, q = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="${size}" height="${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
