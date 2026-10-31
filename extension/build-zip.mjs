// Packages the unpacked extension into public/mainline-extension.zip. No deps (node:zlib + hand-written ZIP).
// Usage: node extension/build-zip.mjs
import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "mainline-extension.zip");
const ROOT = "mainline-extension/"; // folder name users get after unzipping
const SKIP = new Set(["build-zip.mjs", "make-icons.mjs", "README.md", ".DS_Store"]);

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    if (SKIP.has(name) || name.startsWith(".")) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// DOS time for a fixed date (reproducible zips): 2026-10-30 20:00
const DOS_TIME = (20 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 30;

const files = walk(here);
const locals = [];
const centrals = [];
let offset = 0;
for (const p of files) {
  const name = Buffer.from(ROOT + relative(here, p).split(sep).join("/"), "utf8");
  const data = readFileSync(p);
  const comp = deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data;
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, body);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);
  offset += 30 + name.length + body.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync(dirname(out), { recursive: true });
const zip = Buffer.concat([...locals, cd, end]);
writeFileSync(out, zip);
console.log(`wrote ${relative(process.cwd(), out)} (${files.length} files, ${(zip.length / 1024).toFixed(1)} KB)`);
for (const p of files) console.log("  " + ROOT + relative(here, p).split(sep).join("/"));
