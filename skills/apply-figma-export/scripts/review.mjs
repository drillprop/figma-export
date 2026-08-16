#!/usr/bin/env node
// REVIEW: the whole visual check as ONE command, so no step — box-diff especially — gets
// skipped. Runs, in order: capture build → capture design → box-diff → visual-diff --strip →
// make-compare. Writes every artifact next to the bundle (or --out DIR). Exits NON-ZERO while
// box-diff finds any element past tolerance, so "done" is measured, not eyeballed.
//
//   node review.mjs <build-url|build.html> <bundle-dir> [--width N] [--tol 4] [--out DIR] [--stack]
//
// <bundle-dir> holds node.json + preview.html. --width defaults to the design frame width
// (node.json root absoluteBoundingBox.width). Sub-scripts auto-install their deps on first run.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [buildTarget, bundleDir] = pos;
if (!buildTarget || !bundleDir) {
  console.error("Usage: node review.mjs <build-url|build.html> <bundle-dir> [--width N] [--tol 4] [--out DIR] [--stack]");
  process.exit(2);
}
const nodeJson = join(bundleDir, "node.json"), previewHtml = join(bundleDir, "preview.html");
for (const f of [nodeJson, previewHtml]) if (!existsSync(f)) { console.error(`missing ${f}`); process.exit(2); }

const root = JSON.parse(readFileSync(nodeJson, "utf8")).absoluteBoundingBox;
const width = String(opt("width", root ? Math.round(root.width) : 1440));
const tol = +opt("tol", 4);
const out = resolve(opt("out", bundleDir));
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const p = (f) => join(out, f);
const stack = args.includes("--stack") ? ["--stack"] : [];

const run = (label, script, scriptArgs) => {
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m`);
  try { execFileSync("node", [join(here, script), ...scriptArgs], { stdio: "inherit" }); }
  catch (e) { console.error(`\n\x1b[31m✗ ${label} failed (${script}) — fix the error above and re-run review.\x1b[0m`); process.exit(e.status || 2); }
};

run("1/4 capture build", "capture.mjs", ["build", buildTarget, p("build.png"), "--width", width]);
run("2/4 capture design", "capture.mjs", ["design", previewHtml, p("design.png"), "--width", width]);
run("3/4 box-diff (layout)", "box-diff.mjs", [buildTarget, nodeJson, "--width", width, "--tol", String(tol), "--out", p("pairs.json")]);
run("4/4 visual-diff + strip", "visual-diff.mjs", [p("build.png"), p("design.png"), p("diff.png"), "--strip", p("strip.png"), ...stack]);
run("    make-compare", "make-compare.mjs", [p("build.png"), p("design.png"), p("compare.html"), "--boxes", p("pairs.json")]);

// ---- gate on box-diff: the layout axis must be within tolerance to pass ----
const pairs = JSON.parse(readFileSync(p("pairs.json"), "utf8"));
const bad = pairs.filter((q) => Math.abs(q.dx) > tol || Math.abs(q.dy) > tol || Math.abs(q.dw) > tol || Math.abs(q.dh) > tol);
console.log(`\n\x1b[1m── review summary ──\x1b[0m`);
console.log(`artifacts in ${out}: build.png design.png diff.png strip.png pairs.json compare.html`);
console.log(`box-diff: ${pairs.length} paired, ${bad.length} past ±${tol}px`);
if (bad.length) {
  console.log(`\n\x1b[31m✗ layout NOT within tolerance — ${bad.length} element(s) off. Open compare.html / strip.png, fix, re-run review.\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ layout within ±${tol}px. Now judge appearance in compare.html / strip.png (font & photo diffs are expected, not bugs).\x1b[0m`);
