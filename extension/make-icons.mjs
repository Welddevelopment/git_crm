// Generates icons/icon{16,32,48,128}.png: violet rounded square with a white branch glyph.
// No deps: rasterize with supersampling, encode PNG with node:zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Shapes in a 0..1 unit square.
const dSeg = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
// Branch glyph: main line (left), a branch curving off to a node (right), merge node at top.
const W = 0.085; // stroke half-width
const A = [0.36, 0.24], B = [0.36, 0.76], C = [0.66, 0.36];
function glyph(x, y, small) {
  const w = small ? W * 1.25 : W;
  const nodeR = small ? 0.13 : 0.115;
  // trunk
  if (dSeg(x, y, A[0], A[1], B[0], B[1]) <= w) return true;
  // branch: quadratic curve from C down to trunk at ~0.62
  for (let i = 0; i < 24; i++) {
    const t0 = i / 24, t1 = (i + 1) / 24;
    const q = (t) => { const p0 = C, p1 = [0.66, 0.6], p2 = [0.36, 0.64]; const u = 1 - t; return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]; };
    const a = q(t0), b = q(t1);
    if (dSeg(x, y, a[0], a[1], b[0], b[1]) <= w) return true;
  }
  for (const [nx, ny] of [A, B, C]) if (Math.hypot(x - nx, y - ny) <= nodeR) return true;
  return false;
}
function render(size) {
  const ss = 6, out = Buffer.alloc(size * size * 4);
  const top = [0x8f, 0x6b, 0xff], bot = [0x6a, 0x4c, 0xf0];
  const small = size <= 16;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = (px + (sx + 0.5) / ss) / size, y = (py + (sy + 0.5) / ss) / size;
      if (inRoundRect(x, y, 0.22)) { bg++; if (glyph(x, y, small)) fg++; }
    }
    const n = ss * ss, a = bg / n, f = bg ? fg / bg : 0, ty = py / size;
    const base = top.map((c, i) => Math.round(c + (bot[i] - c) * ty));
    const col = base.map((c) => Math.round(c + (255 - c) * f));
    const o = (py * size + px) * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = Math.round(a * 255);
  }
  return png(size, out);
}
mkdirSync(join(here, "icons"), { recursive: true });
for (const s of [16, 32, 48, 128]) { writeFileSync(join(here, "icons", `icon${s}.png`), render(s)); console.log(`icons/icon${s}.png`); }
