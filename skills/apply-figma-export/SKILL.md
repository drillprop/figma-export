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
| `meta.json` | Summary: node/text counts, node types, component tallies, truncation flags. |
| `preview.html` | **Open this first** — the rendered design. Your visual target. |
| `preview.svg` / `preview.png` | The raw preview (`preview.html` inlines the SVG so its images load). |
| `preview.assets/` | Raster images and vector icons pulled out of the SVG, as standalone files. |

**Read order:** `preview.html` (the goal) → `meta.json` (scale; if `truncated: true` the tree was capped and is incomplete) → `node.json` (structure).

**Multiple nodes:** one `<fileKey>/` dir can hold sibling folders — one bundle per selected node. Treat each independently — *unless* they're the same screen at different breakpoints (names like `Home/mobile`, `Home/desktop`), then build one responsive component. Trust `meta.json`'s `nodeName` for the real name, not the folder (a `-<id>` suffix avoids collisions).

## How nodes map to code

`node.json` is a tree; every node has `id`, `name`, `type`, geometry, style; containers have `children`. Use the node **`name`** for component/class names — designers name layers meaningfully. **The field-by-field Figma→CSS tables (node types, layout, style, text) are in [`reference/mapping.md`](reference/mapping.md)** — read it when translating. The judgment that isn't a lookup:

- **Layout — pick what the design *wants*, not what Figma used.** A 1-D row/stack is flex; a repeating 2-D arrangement (card gallery, equal columns) is `grid` — even if the designer built it with nested auto-layout or absolute positioning. Reserve `position: absolute` for genuine overlaps (badge on avatar); rebuild the rest as flex/grid so it stays responsive.
- **Components & variants.** One component **set** → one reusable component; variant axes → props (or a design-system component's existing props). Repeated instances of the same master → **reuse** one component, don't inline each copy.
- **Icons.** Icon nodes are `VECTOR`/`BOOLEAN_OPERATION` or icon `INSTANCE`s; the node `name` is the icon name. **Prefer a matching library icon** (`lucide`, `@heroicons`, a local set) over the `preview.assets/` SVG — it keeps the project's sizing/`currentColor`/theming. Fall back to the extracted SVG only for a custom/branded glyph.
- **Design tokens.** `boundVariables` on a node means the value is bound to a Figma variable — prefer the project's matching token (CSS var, theme value) over the raw literal.

## Workflow

1. **Locate & scope.** Find the `node.json` the user means; read `meta.json` for scale and `truncated`.
2. **See the target.** Open `preview.html` (or `preview.png`) — match a real design, not JSON.
3. **Learn the house style *and* audit the render environment.** Two things, both before writing code:
   - **House style** — how *this* project builds UI: component library, **icon set**, styling approach, token/theme source, folder conventions. Search the whole workspace (a shared `ui`/design-system package often owns the real components). Match it — the export is data, not a style mandate.
   - **Render environment** — audit base CSS before any spacing. Root `font-size`: if it isn't 16px, every `rem`-based length is scaled (a starter's `html{font-size:18px}` makes `rem` spacing 12.5% too big — e.g. Tailwind's whole scale). Check how the project's global/reset styles rank against the styles you'll write: an unscoped element rule (`h1{}`, `img{}`) can outrank utilities or scoped styles and silently drop them (in Tailwind v4, keep resets in `@layer base` so utilities win). **Systemic CSS bugs masquerade as a dozen small per-section offsets — find the one cause before pixel-tuning.**
4. **Extract the full spec in one pass** (not in waves — that's three re-do passes). One table before coding: per **TEXT** node (family/style/weight/size/lineHeight/letterSpacing/case — CTA labels often use a *different* font/weight than body); per **component/instance frame** (w×h, padding, `itemSpacing`→gap, `cornerRadius`, fills — button height/gap/icon-size live in the **frame's** `absoluteBoundingBox`+`itemSpacing`, not the text node); per **section** (padding, gaps). Map each master in `figma-components.json` to one reusable component; variant axes → props.
5. **Build outermost-in, verifying each section as you go.** Translate the root container then children (see [`reference/mapping.md`](reference/mapping.md)). Run the [visual check](#visual-check) per section — don't build the whole page blind and check once at the end.

## Visual check

Confirm your rebuild against the export — you have vision, use it. **`box-diff` (layout) is the axis you can close to zero. The pixel-diff `%` is not** — matched web fonts rasterize differently than Figma's outlines, and browser `<img>` resampling differs from Figma's PNG, flooring the diff ~10%+ even when everything is correct. Judge appearance in `compare.html` (slider/blink), never the raw %. If asked for "pixel perfect", explain this limit *before* iterating.

**Run the bundled scripts in `scripts/` — never hand-roll a `node -e` Playwright screenshot.** Each auto-installs its one dep on first run into `~/.cache/figma-export-visual-check` (project untouched; `FIGMA_EXPORT_NO_INSTALL=1` to opt out). Run in order — each writes what the next loads. From the build's dev-server URL (or a static `build.html`; a presentational render with no client handlers is enough) and the design's frame width (`node.json` root `absoluteBoundingBox.width`):

1. **`capture`** — `node scripts/capture.mjs build <build-url>` + `node scripts/capture.mjs design <bundle>/preview.html` → `build.png` + `design.png`. Scrollbar hidden, so no 15px column shift.
2. **`box-diff`** — `node scripts/box-diff.mjs <build-url> <bundle>/node.json` → Δx/Δy/Δw/Δh + `pairs.json`. Layout only; emit `data-fig-id="<node id>"` on build elements for exact pairing. Big `Δw` on text is **expected** (Figma text is fixed-width, HTML shrink-wraps) — match a line-break with `max-width` only when it matters visually.
3. **`visual-diff`** — `node scripts/visual-diff.mjs build.png design.png diff.png`. Read the map, not the %. Add `--strip out.png` to also write **one Read-able `build │ design │ diff` PNG** — each panel headed by a colour bar (blue/amber/red, that fixed order), the artifact *you* look at with vision (`--stack` for a column). Prefer this over building a montage by hand.
4. **`make-compare`** — `node scripts/make-compare.mjs build.png design.png` → `compare.html`, the artifact a *human* opens.

**Judging a region** (type, a button, one section): capture the same region on each side — build by `--selector "<css>" --scale 2`, design by `--clip x y w h` (the node's box from `node.json`) — then `visual-diff a.png b.png d.png --strip s.png` and Read the strip. One flow, no hand-cropping needed.

**Fix loop:** each `box-diff` Δ past tolerance is a placement bug — edit, re-run, repeat until only expected differences remain. Appearance is a human's call — open `compare.html`, don't chase the %.

## Related: Figma's own MCP server

Figma's [Dev Mode MCP server](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) pulls design context *live* from a selected node — the right tool when Figma is open and reachable (needs a session, a Dev/Full seat, network). This skill is for the opposite case: a bundle **saved in the repo**, rebuilt offline, in CI, or on the free plan.
