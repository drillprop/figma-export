---
name: apply-figma-export
description: Rebuild a Figma design in code from a figma-export bundle. Use when there's a figma-export folder on disk (node.json + figma-components.json + meta.json + a preview) and the user asks to implement, build, or code up that design — "implement this Figma export", "turn this export into components", "build this design".
---

# Apply a Figma Export

A [figma-export](https://github.com/drillprop/figma-export) bundle is a Figma node tree serialized to JSON so you can rebuild it in code **without** opening Figma or hitting its API.

## The bundle

One export lives at `<out>/<fileKey>/<node-name>/`:

| File | What it is |
| --- | --- |
| `node.json` | The full node subtree — source of truth for structure and style. |
| `figma-components.json` | Every component used, with variant axes/values (+ resolved library masters). |
| `variables.json` | The file's full token catalog — every Figma Variable in every local collection, resolved to names + per-mode values (+ referenced library tokens). Present only when the file has variables. |
| `meta.json` | Summary: node/text counts, node types, component tallies, truncation flags. |
| `preview.html` | **Open this first** — the rendered design. Your visual target. |
| `preview.svg` / `preview.png` | The raw preview (`preview.html` inlines the SVG so its images load). |
| `preview.assets/` | Vector icons named `<name>.<key>.svg` (trailing key matches an INSTANCE's `mainComponentKey` for an exact node join), preview rasters pulled from the SVG (`img-N.png`, preview-only, not matched to nodes), and original-bytes IMAGE-fill files named `<imageHash>.<ext>` (match a node's `fills[].imageHash`). |

**Read order:** `preview.html` (the goal) → `meta.json` (scale; if `truncated: true` the tree was capped and is incomplete) → `node.json` (structure).

**Multiple nodes:** one `<fileKey>/` dir can hold sibling folders — one bundle per selected node. Treat each independently — *unless* they're the same screen at different breakpoints (names like `Home/mobile`, `Home/desktop`), then build one responsive component. Trust `meta.json`'s `nodeName` for the real name, not the folder (a `-<id>` suffix avoids collisions).

## How nodes map to code

`node.json` is a tree; every node has `id`, `name`, `type`, geometry, style; containers have `children`. Use the node **`name`** for component/class names — designers name layers meaningfully. **The field-by-field Figma→CSS tables (node types, layout, style, text) are in [`reference/mapping.md`](reference/mapping.md)** — read it when translating. The judgment that isn't a lookup:

- **Layout — pick what the design *wants*, not what Figma used.** A 1-D row/stack is flex; a repeating 2-D arrangement (card gallery, equal columns) is `grid` — even if the designer built it with nested auto-layout or absolute positioning. Reserve `position: absolute` for genuine overlaps (badge on avatar); rebuild the rest as flex/grid so it stays responsive.
- **Components & variants.** One component **set** → one reusable component; variant axes → props (or a design-system component's existing props). Repeated instances of the same master → **reuse** one component, don't inline each copy.
- **Icons.** Icon nodes are `VECTOR`/`BOOLEAN_OPERATION` or icon `INSTANCE`s; the node `name` is the icon name. The extracted file is `preview.assets/<name>.<key>.svg`, and the `<key>` segment matches the node's `mainComponentKey` (instances) / component key (`figma-components.json`) for an exact match. **Prefer a matching library icon** (`lucide`, `@heroicons`, a local set) over the extracted SVG — it keeps the project's sizing/`currentColor`/theming. Fall back to the extracted SVG only for a custom/branded glyph.
- **Images.** A node with an `IMAGE` fill carries `fills[].imageHash`; the real asset is `preview.assets/<imageHash>.<ext>` (original bytes). Use that file — don't reach for the `img-N.png` in the same folder, which are preview-only copies not tied to any node. Copy it into the project's asset dir and set object-fit from the fill's `scaleMode` (`FILL`→`cover`, `FIT`→`contain`). `VIDEO` fills aren't exported — flag those to the user.
- **Design tokens.** `boundVariables` on a node means the value is bound to a Figma variable — its ids are opaque, so join them against `variables.json`'s `tokens[].id` to recover the token **name** (e.g. `color/primary/500`) and per-mode value. Prefer the project's matching token (CSS var, theme value) over the raw literal; multi-mode tokens (Light/Dark) map to your theme.

## Workflow

Two phases: **prototype to pixel-parity, then port to your stack** — this splits *matching the pixels* (mechanical, auto-verified) from *fitting the house style* (judgment). One small component? Skip the prototype — build it directly in-stack and [visual-check](#visual-check).

**A — Prototype: a throwaway vanilla HTML/CSS file that mirrors `node.json` 1:1.**

1. **Scope + see the target.** Find the `node.json`; read `meta.json` for scale + `truncated`. Open `preview.html` — match a real design, not JSON.
2. **Extract the spec in one pass** (not in waves — that's three re-do passes): per **TEXT** node (family/style/weight/size/lineHeight/letterSpacing/case — CTA labels often differ from body); per **frame** (w×h, padding, `itemSpacing`→gap, `cornerRadius`, fills — button height/gap/icon-size live in the frame's box + `itemSpacing`, not the text); per **section** (padding, gaps).
3. **Build outermost-in** — one element per node, `data-fig-id="<id>"` on each, absolute layout, no reuse. Ugly is fine; mirroring 1:1 is *why* box-diff pairs every node exactly.
4. **Review to zero.** Run [`review.mjs`](#visual-check) until it exits 0, reading `strip.png`/`compare.html` each pass. This file is now your pixel-verified target for phase B.

**B — Port: reimplement the verified prototype in the project's stack.**

5. **Learn the house style + audit the render environment.** How *this* project builds UI — component library, **icon set**, styling, token/theme source, folder conventions (a shared `ui`/design-system package often owns the real components). Audit base CSS before spacing: root `font-size` ≠ 16px scales every `rem`; an unscoped element rule (`h1{}`, `img{}`) can outrank utilities/scoped styles and silently drop them (Tailwind v4: keep resets in `@layer base`). **Systemic CSS bugs masquerade as a dozen per-section offsets — find the one cause first.**
6. **Reimplement**, now applying the judgment the 1:1 prototype deferred — grid vs flex, reuse components, real tokens/library icons, responsive (see [How nodes map to code](#how-nodes-map-to-code)).
7. **Re-review against the prototype** until parity — capture the stack build, `visual-diff` it against the prototype, read the strip each pass. Fidelity leaks here if unchecked.

## Visual check

Confirm your rebuild against the export — you have vision, use it. **Close `box-diff` (layout) to zero; never gate on the pixel-diff `%`** — matched web fonts rasterize differently than Figma's outlines and browser `<img>` resampling differs from Figma's PNG, flooring the *number* ~10%+ even when correct, so it never reaches 0. But **do read the diff/strip *image*** — box-diff is blind to appearance, so wrong crop, missing overlay, or off colour show up only there. Judge those in `compare.html` (slider/blink/strip). If asked for "pixel perfect", explain this limit *before* iterating.

**Run `review.mjs` — the whole check in one command, so no step (box-diff especially) gets skipped.** From the build's dev-server URL (or a static `build.html`; a presentational render with no client handlers is enough):

```
node scripts/review.mjs <build-url|build.html> <bundle-dir>
```

It runs capture (build + design) → box-diff → visual-diff `--strip` → make-compare, writes every artifact next to the bundle (`build/design/diff/strip.png`, `pairs.json`, `compare.html`), and **exits non-zero while box-diff is past tolerance**. Deps auto-install on first run into `~/.cache` (project untouched; `FIGMA_EXPORT_NO_INSTALL=1` to opt out); frame width defaults to the design's (`node.json` root `absoluteBoundingBox.width`). **Never hand-roll a `node -e` screenshot.**

- **`data-fig-id="<node id>"` is what makes box-diff pair exactly** — phase-A's 1:1 prototype puts it on every node by construction; without it box-diff falls back to a positional heuristic whose false positives you'll wrongly wave off as noise, so the review never really passes. (Phase B compares appearance vs the prototype, so it needs none.)
- Big `Δw` on text is **expected** (Figma is fixed-width, HTML shrink-wraps) — match a line-break with `max-width` only when it matters.
- Read `strip.png` (colour-tagged `build │ design │ diff`) and `compare.html` (slider/blink/box-diff overlay, strip embedded) **yourself, every pass** — they're your appearance check while you iterate, not just the human's final view.

**Judging a region** (type, a button, one section): capture the same region on each side — build by `capture build <url> out.png --selector "<css>" --scale 2`, design by `capture design <preview.html> out.png --clip x y w h` (the node's box from `node.json`) — then `visual-diff a.png b.png d.png --strip s.png` and Read the strip.

**Fix loop:** each `box-diff` Δ past tolerance is a placement bug — edit, **re-run `review.mjs` until it exits 0**, reading `strip.png`/`compare.html` each pass. **Never declare done from a downscaled full-page capture** — that resolution hides real discrepancies; verify each section at `--scale 2` (region capture above). Only once geometry is zeroed *and* you've signed off on appearance yourself do you hand off — tell the user it's complete and point them at the build URL **and** `compare.html` for a final check.

## Related: Figma's own MCP server

Figma's [Dev Mode MCP server](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) pulls design context *live* from a selected node — the right tool when Figma is open and reachable (needs a session, a Dev/Full seat, network). This skill is for the opposite case: a bundle **saved in the repo**, rebuilt offline, in CI, or on the free plan.
