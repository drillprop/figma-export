#!/usr/bin/env node
// CAPTURE (Playwright): the two PNGs the visual check compares — your BUILD and the DESIGN —
// so nobody hand-rolls a one-off screenshot script. Uses system Chrome (channel:"chrome"), no
// download; Playwright auto-installs on first run (ensure-deps.mjs).
//
//   node capture.mjs build  <url|file.html> [out=build.png]  [--width 1440] [--scale 1]
//   node capture.mjs design <preview.html>  [out=design.png] [--width 1440]
//   ...either mode also takes [--selector <css>] or [--clip x y w h] to grab ONE region
//      (e.g. a 2× button crop: --selector ".btn" --scale 2).
//
// build  — full-page shot at the frame width, scrollbars HIDDEN so layout uses the full width
//          (a visible scrollbar steals ~15px and shifts every column). deviceScaleFactor = --scale.
// design — rasterises preview.html by screenshotting its inlined <svg> element directly: exact 1:1
//          bounds with raster fills intact (opening preview.svg raw loses the externalised images).
import { loadDep } from "./ensure-deps.mjs";
const { chromium } = await loadDep("playwright"); // loadDep unwraps CJS .default

const args = process.argv.slice(2);
const mode = args[0];
const pos = args.slice(1).filter((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (mode !== "build" && mode !== "design") {
  console.error("Usage:\n  node capture.mjs build <url|file.html> [out.png] [--width 1440] [--scale 1] [--selector css | --clip x y w h]\n  node capture.mjs design <preview.html> [out.png] [--width 1440] [--selector css | --clip x y w h]");
  process.exit(2);
}
const width = +opt("width", 1440), scale = +opt("scale", 1);
const target = pos[0], out = pos[1] || (mode === "build" ? "build.png" : "design.png");
if (!target) { console.error("missing target file/url"); process.exit(2); }
const url = /^https?:|^file:/.test(target) ? target : "file://" + (target.startsWith("/") ? target : process.cwd() + "/" + target);
const selector = opt("selector", null);
const ci = args.indexOf("--clip");
const clip = ci >= 0 ? args.slice(ci + 1, ci + 5).map(Number) : null;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width, height: 1024 }, deviceScaleFactor: scale });
await page.goto(url, { waitUntil: "networkidle" }).catch(() => page.goto(url, { waitUntil: "load" }));
await page.addStyleTag({ content: "html{scrollbar-width:none} ::-webkit-scrollbar{display:none}" });
await page.waitForTimeout(300);

// region precedence: --selector > --clip > design's inlined <svg> > full page
let shot = null;
if (selector) shot = page.locator(selector).first();
else if (!clip && mode === "design") shot = page.locator("svg").first();

if (shot) await shot.screenshot({ path: out });
else if (clip) await page.screenshot({ path: out, clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } });
else await page.screenshot({ path: out, fullPage: true });

const box = shot ? await shot.boundingBox() : null;
await browser.close();
console.log(`wrote ${out}${box ? ` (${Math.round(box.width)}×${Math.round(box.height)} @${scale}x)` : ` (w=${width} @${scale}x)`}`);
