#!/usr/bin/env node
// Anti-aliasing-aware pixel diff for two PNGs, via pixelmatch.
// PNG decode/encode is hand-rolled (Node built-ins); pixelmatch does the comparison only.
//
// Requires pixelmatch:  npm i -D pixelmatch   (tiny, pure-JS, no deps of its own).
// Usage: node visual-diff.mjs <a.png> <b.png> [diff.png] [threshold=0.1]
//   threshold is pixelmatch's 0..1 colour distance (default 0.1). Anti-aliased edges are
//   detected and NOT counted (includeAA:false), so font hinting / AA no longer inflate the %.
//   Genuinely different fonts/icons/colours still differ — that's real, read the map.
// Exit 0 if run OK (see printed %), 2 on bad args / size mismatch / unsupported PNG.
// Supports 8-bit non-interlaced PNG, color types 0/2/4/6 (gray, RGB, gray+A, RGBA).
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { loadDep } from "./ensure-deps.mjs";
const pixelmatch = await loadDep("pixelmatch"); // loadDep unwraps CJS .default

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  const chunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString("ascii", off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decode a PNG to a flat RGBA Uint8 buffer.
function decodePNG(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const chByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  if (!(colorType in chByType)) throw new Error(`unsupported color type ${colorType}`);
  const ch = chByType[colorType];
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const v = raw[p++];
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      cur[x] = (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b
        : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c)
        : (() => { throw new Error(`bad filter ${filter}`); })()) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) { out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3]; }
      else if (colorType === 2) { out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { const g = cur[x]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255; }
      else { const g = cur[x * 2]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = cur[x * 2 + 1]; }
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
// Encode a flat RGBA buffer to a PNG (color type 6, filter none).
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const [, , aPath, bPath, outPath = "diff.png", thrArg] = process.argv;
if (!aPath || !bPath) {
  console.error("Usage: node visual-diff.mjs <a.png> <b.png> [diff.png] [threshold=0.1]");
  process.exit(2);
}
const threshold = Number(thrArg ?? 0.1);
let A = decodePNG(readFileSync(aPath)), B = decodePNG(readFileSync(bPath));
// pixelmatch needs identical dimensions. Build vs design almost always differ in
// height (rebuild page ≠ Figma frame). Pad both onto a white W×H canvas, content
// anchored top-left, so nothing is ever cropped — no ImageMagick needed.
const width = Math.max(A.width, B.width), height = Math.max(A.height, B.height);
function padWhite(img) {
  if (img.width === width && img.height === height) return img.data;
  const buf = Buffer.alloc(width * height * 4, 0xff); // opaque white
  for (let y = 0; y < img.height; y++)
    img.data.copy(buf, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
  return buf;
}
if (A.width !== width || A.height !== height || B.width !== width || B.height !== height)
  console.error(`Padded to ${width}x${height} (a:${A.width}x${A.height} b:${B.width}x${B.height}).`);
const aData = padWhite(A), bData = padWhite(B), out = Buffer.alloc(width * height * 4);
// includeAA:false → anti-aliased edges are detected and left uncounted (drawn faded, not red),
// so font hinting / AA don't inflate the %. Real content differences still count and show red.
const diff = pixelmatch(aData, bData, out, width, height, { threshold, includeAA: false });
writeFileSync(outPath, encodePNG(width, height, out));
const total = width * height;
console.log(`${diff}/${total} px differ (${(diff / total * 100).toFixed(2)}%, anti-aliasing ignored) — wrote ${outPath}`);
