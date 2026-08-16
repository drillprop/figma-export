#!/usr/bin/env node
// Anti-aliasing-aware pixel diff for two PNGs, via pixelmatch.
// PNG decode/encode is hand-rolled (Node built-ins); pixelmatch does the comparison only.
//
// Requires pixelmatch:  npm i -D pixelmatch   (tiny, pure-JS, no deps of its own).
// Usage: node visual-diff.mjs <a.png> <b.png> [diff.png] [threshold=0.1]
//               [--strip [strip.png]] [--stack] [--labels A,B,C] [--view-scale 0.3]
//   threshold is pixelmatch's 0..1 colour distance (default 0.1). Anti-aliased edges are
//   detected and NOT counted (includeAA:false), so font hinting / AA no longer inflate the %.
//   Genuinely different fonts/icons/colours still differ — that's real, read the map.
//   --strip writes ONE Read-able PNG: a:build | b:design | diff, panels labelled on-image
//   (side-by-side; --stack for a column). --view-scale shrinks tall full-page shots. Reuses
//   this file's own PNG codec — no ImageMagick/sharp — so it works in any project.
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

// ---- args: positional a,b,[out],[threshold] + flags ----
const argv = process.argv.slice(2), pos = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--strip") flags.strip = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "strip.png";
  else if (a === "--stack") flags.stack = true;
  else if (a === "--labels") flags.labels = argv[++i];
  else if (a === "--view-scale") flags.viewScale = Number(argv[++i]);
  else if (!a.startsWith("--")) pos.push(a);
}
const [aPath, bPath, outPath = "diff.png", thrArg] = pos;
if (!aPath || !bPath) {
  console.error("Usage: node visual-diff.mjs <a.png> <b.png> [diff.png] [threshold=0.1] [--strip [out]] [--stack] [--labels A,B,C] [--view-scale n]");
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

// ---- optional --strip: one Read-able build|design|diff PNG (labelled, no extra deps) ----
if (flags.strip) {
  const F = {}, def = (c, ...r) => (F[c] = r); // 5x7 uppercase bitmap font, on-image labels
  def(" ","     ","     ","     ","     ","     ","     ","     ");
  def("A"," ### ","#   #","#   #","#####","#   #","#   #","#   #"); def("B","#### ","#   #","#   #","#### ","#   #","#   #","#### ");
  def("C"," ### ","#   #","#    ","#    ","#    ","#   #"," ### "); def("D","#### ","#   #","#   #","#   #","#   #","#   #","#### ");
  def("E","#####","#    ","#    ","#### ","#    ","#    ","#####"); def("F","#####","#    ","#    ","#### ","#    ","#    ","#    ");
  def("G"," ### ","#   #","#    ","# ###","#   #","#   #"," ### "); def("H","#   #","#   #","#   #","#####","#   #","#   #","#   #");
  def("I","#####","  #  ","  #  ","  #  ","  #  ","  #  ","#####"); def("J","#####","    #","    #","    #","#   #","#   #"," ### ");
  def("K","#   #","#  # ","# #  ","##   ","# #  ","#  # ","#   #"); def("L","#    ","#    ","#    ","#    ","#    ","#    ","#####");
  def("M","#   #","## ##","# # #","# # #","#   #","#   #","#   #"); def("N","#   #","##  #","# # #","# # #","#  ##","#   #","#   #");
  def("O"," ### ","#   #","#   #","#   #","#   #","#   #"," ### "); def("P","#### ","#   #","#   #","#### ","#    ","#    ","#    ");
  def("Q"," ### ","#   #","#   #","#   #","# # #","#  # "," ## #"); def("R","#### ","#   #","#   #","#### ","# #  ","#  # ","#   #");
  def("S"," ####","#    ","#    "," ### ","    #","    #","#### "); def("T","#####","  #  ","  #  ","  #  ","  #  ","  #  ","  #  ");
  def("U","#   #","#   #","#   #","#   #","#   #","#   #"," ### "); def("V","#   #","#   #","#   #","#   #","#   #"," # # ","  #  ");
  def("W","#   #","#   #","#   #","# # #","# # #","## ##","#   #"); def("X","#   #","#   #"," # # ","  #  "," # # ","#   #","#   #");
  def("Y","#   #","#   #"," # # ","  #  ","  #  ","  #  ","  #  "); def("Z","#####","    #","   # ","  #  "," #   ","#    ","#####");
  def("0"," ### ","#   #","#  ##","# # #","##  #","#   #"," ### "); def("1","  #  "," ##  ","  #  ","  #  ","  #  ","  #  ","#####");
  def("2"," ### ","#   #","    #","   # ","  #  "," #   ","#####"); def("3","#####","   # ","  #  ","   # ","    #","#   #"," ### ");
  def("4","   # ","  ## "," # # ","#  # ","#####","   # ","   # "); def("5","#####","#    ","#### ","    #","    #","#   #"," ### ");
  def("6"," ### ","#    ","#    ","#### ","#   #","#   #"," ### "); def("7","#####","    #","   # ","  #  "," #   "," #   "," #   ");
  def("8"," ### ","#   #","#   #"," ### ","#   #","#   #"," ### "); def("9"," ### ","#   #","#   #"," ####","    #","    #"," ### ");
  def("-","     ","     ","     ","#####","     ","     ","     "); def(".","     ","     ","     ","     ","     "," ##  "," ##  ");
  def(":","     ","  ## ","  ## ","     ","  ## ","  ## ","     ");

  const drawText = (dst, dw, dh, x, y, text, col, s) => {
    let cx = x;
    for (const ch of text.toUpperCase()) {
      const g = F[ch] || F[" "];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === "#")
        for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) {
          const X = cx + c * s + px, Y = y + r * s + py;
          if (X >= 0 && X < dw && Y >= 0 && Y < dh) { const o = (Y * dw + X) * 4; dst[o] = col[0]; dst[o + 1] = col[1]; dst[o + 2] = col[2]; dst[o + 3] = 255; }
        }
      cx += 6 * s;
    }
  };
  const resize = (img, sc) => {
    if (sc === 1) return img;
    const w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc)), o = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) { const sy = Math.min(img.height - 1, Math.floor(y / sc)); for (let x = 0; x < w; x++) { const sx = Math.min(img.width - 1, Math.floor(x / sc)); img.data.copy(o, (y * w + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4); } }
    return { width: w, height: h, data: o };
  };
  const blit = (dst, dw, dx, dy, src, sw, sh) => { for (let y = 0; y < sh; y++) src.copy(dst, ((dy + y) * dw + dx) * 4, y * sw * 4, (y + 1) * sw * 4); };

  const labels = (flags.labels ? flags.labels.split(",") : ["A: BUILD", "B: DESIGN", "DIFF"]).map((s) => s.trim());
  const vs = flags.viewScale || 1;
  const panels = [aData, bData, out].map((data, i) => ({ label: labels[i] || "", img: resize({ width, height, data }, vs) }));
  const bg = [24, 27, 34], fg = [232, 234, 238], ls = 3, barH = 7 * ls + 12, gap = 8;
  const pw = panels[0].img.width, ph = panels[0].img.height;
  const W = flags.stack ? pw : panels.length * pw + (panels.length - 1) * gap;
  const H = flags.stack ? panels.length * (barH + ph) + (panels.length - 1) * gap : barH + ph;
  const cv = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { cv[i * 4] = bg[0]; cv[i * 4 + 1] = bg[1]; cv[i * 4 + 2] = bg[2]; cv[i * 4 + 3] = 255; }
  panels.forEach((p, i) => {
    const [lx, ly, px, py] = flags.stack
      ? [4, i * (barH + ph + gap) + 6, 0, i * (barH + ph + gap) + barH]
      : [i * (pw + gap) + 4, 6, i * (pw + gap), barH];
    drawText(cv, W, H, lx, ly, p.label, fg, ls);
    blit(cv, W, px, py, p.img.data, p.img.width, p.img.height);
  });
  writeFileSync(flags.strip, encodePNG(W, H, cv));
  console.log(`wrote ${flags.strip} — ${flags.stack ? "stacked" : "side-by-side"} ${panels.map((p) => p.label).join(" | ")}${vs !== 1 ? ` @${vs}x` : ""}`);
}
