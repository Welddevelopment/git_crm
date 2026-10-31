// Generates icons/icon{16,32,48,128}.png: blue (#006bff) rounded square with a white "G" (Git CRM).
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
// "G" glyph: an open ring (gap on the right, upper side) plus a crossbar pointing inward, plus a short stem.
// Geometry in unit square; stroke half-width grows slightly at tiny sizes for legibility.
const CX = 0.5, CY = 0.5;
function glyph(x, y, small) {
  const w = small ? 0.085 : 0.07;     // stroke half-width
  const R = small ? 0.255 : 0.245;    // ring centre-line radius
  const dx = x - CX, dy = y - CY;
  const d = Math.hypot(dx, dy);
  // angle measured from +x axis, y down => clockwise positive. Gap spans from -55deg (upper right) to ~0deg.
  const a = Math.atan2(dy, dx) * 180 / Math.PI;
  const inGap = a > -52 && a < 2;
  if (!inGap && Math.abs(d - R) <= w) return true;
  // round cap at the upper end of the ring
  const ca = -52 * Math.PI / 180;
  if (Math.hypot(x - (CX + R * Math.cos(ca)), y - (CY + R * Math.sin(ca))) <= w) return true;
  // crossbar from centre-right inward, at y = CY
  const barL = CX + 0.02, barR = CX + R + w * 0.2;
  if (x >= barL && x <= barR && Math.abs(y - (CY + 0.005)) <= w) return true;
  return false;
}
function render(size) {
  const ss = 6, out = Buffer.alloc(size * size * 4);
  const bgc = [0x00, 0x6b, 0xff]; // --blue #006bff, flat (no gradient)
  const small = size <= 16;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = (px + (sx + 0.5) / ss) / size, y = (py + (sy + 0.5) / ss) / size;
      if (inRoundRect(x, y, 0.24)) { bg++; if (glyph(x, y, small)) fg++; }
    }
    const n = ss * ss, a = bg / n, f = bg ? fg / bg : 0;
    const col = bgc.map((c) => Math.round(c + (255 - c) * f));
    const o = (py * size + px) * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = Math.round(a * 255);
  }
  return png(size, out);
}
mkdirSync(join(here, "icons"), { recursive: true });
for (const s of [16, 32, 48, 128]) { writeFileSync(join(here, "icons", `icon${s}.png`), render(s)); console.log(`icons/icon${s}.png`); }
