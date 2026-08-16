#!/usr/bin/env node
// LAYOUT box-diff (Playwright): compares WHERE elements are, not how they look.
// Design truth = absoluteBoundingBox in node.json. Render truth = getBoundingClientRect (Playwright).
// Immune to fonts / anti-aliasing / image content — answers "is each box in the right place & size?".
//
// Playwright is auto-installed on first run (see ensure-deps.mjs); it uses your system Chrome
// via channel:"chrome", so no browser download is needed. Usage:
//   node box-diff.mjs <build-url|file.html> <node.json> [--width 1440] [--tol 4] [--out pairs.json]
//
// Addresses the known matching gaps:
//   #1 repeats  — repeated texts/buttons are paired by document ORDER, not dropped.
//   #2 non-text — icons (<svg>) and images (<img>) are matched (by data-fig-id if present, else nearest box).
//   hidden      — display:none / visibility:hidden / opacity:0 / zero-size / off-canvas (x<0) are skipped.
// NOT covered (by design): colour, font, shadow — appearance. Use make-compare.mjs / visual-diff.mjs for that.
// Most reliable pairing: have the build emit  data-fig-id="<figma node id>"  on elements; this script
// pairs those exactly and only falls back to text/geometry for the rest.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDep } from "./ensure-deps.mjs";
const { chromium } = await loadDep("playwright"); // loadDep unwraps CJS .default

const args = process.argv.slice(2);
const [buildTarget, nodeFile] = args.filter((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!buildTarget || !nodeFile) { console.error("Usage: node box-diff.mjs <build-url|file.html> <node.json> [--width 1440] [--tol 4] [--out pairs.json]"); process.exit(2); }
const width = +opt("width", 1440), tol = +opt("tol", 4), outFile = opt("out", "pairs.json");
const url = /^https?:|^file:/.test(buildTarget) ? buildTarget : "file://" + (buildTarget.startsWith("/") ? buildTarget : process.cwd() + "/" + buildTarget);
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

// ---- design side: leaves from node.json (page-relative boxes) ----
const tree = JSON.parse(readFileSync(nodeFile, "utf8"));
const root = tree.absoluteBoundingBox;
const design = [];
(function walk(n) {
  const b = n.absoluteBoundingBox;
  if (b && n.visible !== false) {
    const box = { id: n.id, name: n.name, x: Math.round(b.x - root.x), y: Math.round(b.y - root.y), w: Math.round(b.width), h: Math.round(b.height) };
    if (n.type === "TEXT" && norm(n.characters)) design.push({ ...box, kind: "text", key: norm(n.characters) });
    else if (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION") { if (Math.min(box.w, box.h) >= 16) design.push({ ...box, kind: "icon" }); }
    else if (Array.isArray(n.fills) && n.fills.some((f) => f && f.type === "IMAGE")) design.push({ ...box, kind: "image" });
  }
  for (const c of n.children ?? []) walk(c);
})(tree);

// ---- render side: visible element boxes via Playwright ----
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width, height: 1024 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle" }).catch(() => page.goto(url, { waitUntil: "load" }));
const dom = await page.evaluate(() => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const directText = (el) => { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent; return t; };
  const pageW = document.documentElement.scrollWidth, out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0) continue;
    const x = Math.round(r.left + scrollX), y = Math.round(r.top + scrollY);
    if (x < -1 || x >= pageW) continue;                                   // off-canvas (e.g. hidden mega-menus)
    const figId = el.getAttribute("data-fig-id") || el.getAttribute("data-figma-id");
    const t = norm(directText(el));
    let kind = null, key = null;
    if (t.length >= 2) { kind = "text"; key = t; }
    else if (el.tagName === "IMG") kind = "image";
    else if (el.tagName === "svg" || (el.children.length === 1 && el.firstElementChild?.tagName === "svg")) kind = "icon";
    if (!kind && !figId) continue;
    out.push({ kind: kind || "box", key, figId: figId || null, x, y, w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
});
await browser.close();

// ---- matching ----
const claimed = new Set(), pairs = [];
const push = (d, m, how) => pairs.push({ how, kind: d.kind, name: d.name, id: d.id, key: d.key, figma: { x: d.x, y: d.y, w: d.w, h: d.h }, dom: { x: m.x, y: m.y, w: m.w, h: m.h }, dx: m.x - d.x, dy: m.y - d.y, dw: m.w - d.w, dh: m.h - d.h });

// phase 0 — exact by data-fig-id
const domById = new Map(); dom.forEach((m, i) => { if (m.figId && !domById.has(m.figId)) domById.set(m.figId, i); });
const usedDesign = new Set();
design.forEach((d, di) => { const i = domById.get(d.id); if (i != null && !claimed.has(i)) { claimed.add(i); usedDesign.add(di); push(d, dom[i], "id"); } });

const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// phase 1 — text: pair each design text to the NEAREST unclaimed DOM node with the same text, within
// maxText px. Nearest (not order-zip), so repeats / differing counts don't create false pairs (#1).
// Genuinely-moved elements beyond maxText stay UNMATCHED (reported) rather than mis-paired.
const maxText = +opt("maxtext", 300);
const domTextByKey = {};
dom.forEach((m, i) => { if (m.kind === "text") (domTextByKey[m.key] ??= []).push(i); });
design.forEach((d, di) => {
  if (usedDesign.has(di) || d.kind !== "text") return;
  const [cx, cy] = center(d); let best = -1, bd = Infinity;
  for (const i of domTextByKey[d.key] || []) { if (claimed.has(i)) continue; const [mx, my] = center(dom[i]); const dist = Math.hypot(mx - cx, my - cy); if (dist < bd) { bd = dist; best = i; } }
  if (best >= 0 && bd <= maxText) { claimed.add(best); usedDesign.add(di); push(design[di], dom[best], "text"); }
});

// phase 2 — icons & images by nearest box (non-text: #2). Guarded by a size-ratio sanity check so a
// small <img> can't get matched to a big background image just because it's the closest.
const sizeOk = (a, b) => Math.max(a.w / b.w, b.w / a.w) <= 3 && Math.max(a.h / b.h, b.h / a.h) <= 3;
for (const kind of ["image", "icon"]) {
  const maxDist = kind === "image" ? 400 : 120;
  design.forEach((d, di) => {
    if (usedDesign.has(di) || d.kind !== kind) return;
    const [cx, cy] = center(d); let best = -1, bd = Infinity;
    dom.forEach((m, i) => { if (claimed.has(i) || m.kind !== kind || !sizeOk(d, m)) return; const [mx, my] = center(m); const dist = Math.hypot(mx - cx, my - cy); if (dist < bd) { bd = dist; best = i; } });
    if (best >= 0 && bd <= maxDist) { claimed.add(best); usedDesign.add(di); push(d, dom[best], "geom"); }
  });
}

// ---- report ----
pairs.sort((a, b) => a.figma.y - b.figma.y);
writeFileSync(outFile, JSON.stringify(pairs, null, 2));
const bad = pairs.filter((p) => Math.abs(p.dx) > tol || Math.abs(p.dy) > tol || Math.abs(p.dw) > tol || Math.abs(p.dh) > tol);
const unDom = dom.filter((_, i) => !claimed.has(i)).length;
console.log(`paired ${pairs.length} nodes (${pairs.filter(p=>p.how==="id").length} id, ${pairs.filter(p=>p.how==="text").length} text, ${pairs.filter(p=>p.how==="geom").length} geom) — ${bad.length} off >${tol}px; unmatched: ${design.length - usedDesign.size} design / ${unDom} dom\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("kind", 7) + pad("Δx", 6) + pad("Δy", 6) + pad("Δw", 6) + pad("Δh", 6) + "y" .padEnd(7) + "what");
console.log("-".repeat(78));
for (const p of bad.slice(0, 40)) {
  const label = p.kind === "text" ? `"${p.key.slice(0, 30)}"` : `${p.name || p.kind} (${p.how})`;
  console.log(pad(p.kind, 7) + pad(p.dx, 6) + pad(p.dy, 6) + pad(p.dw, 6) + pad(p.dh, 6) + pad(p.figma.y, 7) + label);
}
console.log(`\nwrote ${outFile}. NOTE: layout only — colour/font/shadow are NOT checked (use make-compare.mjs / visual-diff.mjs).`);
