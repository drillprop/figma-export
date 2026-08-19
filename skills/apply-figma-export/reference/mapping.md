# Figma → code mapping

Lookup tables for translating `node.json`. The judgment (pick the layout the design *wants*,
reuse components, prefer library icons) lives in `SKILL.md`; this is the field reference.

## Node types

| `type` | Becomes |
| --- | --- |
| `FRAME`, `COMPONENT`, `INSTANCE`, `GROUP` | A container (`div` / your component). |
| `TEXT` | Text; `characters` is the content. |
| `RECTANGLE`, `ELLIPSE`, `LINE` | A styled box (background, border, radius). |
| `VECTOR`, `BOOLEAN_OPERATION` | An icon — prefer a project icon, fall back to `preview.assets/`. |

## Layout (auto-layout → flex/grid)

`layoutMode: HORIZONTAL | VERTICAL` → `display: flex`. `GRID` → `display: grid` (the export
carries only the *mode*, not columns/rows/gaps — read `preview.html` to reconstruct). `NONE`/absent
means Figma isn't driving layout — but that's *not* a cue for `position: absolute` (reserve that for
genuine overlaps); rebuild simple frames as flex/grid so they stay responsive. Figma layout grids
(column guides) aren't exported — infer columns from the preview.

| Figma field | CSS |
| --- | --- |
| `layoutMode: HORIZONTAL \| VERTICAL` | `display: flex` + `flex-direction: row \| column` |
| `layoutMode: GRID` | `display: grid` (columns/rows inferred from the preview) |
| `primaryAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`SPACE_BETWEEN`) | `justify-content` (`flex-start`/`center`/`flex-end`/`space-between`) |
| `counterAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`BASELINE`) | `align-items` |
| `itemSpacing` | `gap` (px) |
| `paddingTop/Right/Bottom/Left` | `padding` (px) |
| `layoutWrap: WRAP` | `flex-wrap: wrap` |

**A gap belongs to two nodes that are *direct siblings under one parent* — read it from
their relationship, don't flatten the tree.** Before quoting any gap: (1) identify the two
nodes that actually border the boundary; (2) check whether they share a *direct* parent. If
they don't — one is nested a level deeper — the space between them is a **group seam**, and
its value is the spacing of the frame where their two branches meet, *not* any single stored
number on some ancestor. Collapsing a nested stack into one flat list is the classic error:
you end up crediting a gap to a grandparent frame that never lays those two nodes out.

Then **reconcile the value with `absoluteBoundingBox` geometry** —
`next.absoluteBoundingBox.y − (prev.absoluteBoundingBox.y + prev.height)` (use `x`/`width` for a
row). The two measure different things: the stored field is the *intended layout* gap; the box
delta is the *rendered* spacing. They diverge when the stored field is a **phantom** — a
one-child frame reports an `itemSpacing` that never renders; `SPACE_BETWEEN`, `layoutGrow`, and
fixed / `HUG` heights detach it from the rendered gap — and there geometry wins. But they also
diverge when the box delta itself is inflated by an outside stroke or a drop-shadow/blur
(`absoluteBoundingBox` includes stroke geometry), and there the authored gap is the truer CSS
target. So don't blindly trust either: understand *why* they differ before picking.

**Only compute a gap between in-flow siblings of an auto-layout parent.** The box-subtraction
assumes children tile along one axis without overlapping — which is false for out-of-flow nodes,
and there it fabricates a bogus (often negative) "gap":

- **`layoutMode: NONE` frame** — children are freely positioned and z-ordered; they routinely
  overlap (a full-bleed background behind a content frame). There is no gap to read at all —
  reconstruct with positioning/inset (see the skill's "reserve `position: absolute` for genuine
  overlaps"), not `gap`.
- **`layoutPositioning: ABSOLUTE` child** inside an auto-layout frame — pulled out of flow, it
  overlaps its flow siblings; skip it when reading gaps (auto-layout's own `itemSpacing` already
  ignores it).

So: bail out of gap-reading on a `NONE` frame, filter out `ABSOLUTE` children, and only then —
for the remaining in-flow children, whose array order already *is* the primary-axis order — read
the gap between neighbours. If two boxes you expected to tile actually overlap, that's the signal
they're an overlay, not a stack.

## Style fields

| Figma | CSS |
| --- | --- |
| `fills[]` (SOLID) | `background` / text `color`. `color` is `{r,g,b}` in **0–1** — multiply by 255. `opacity` on the paint → alpha. |
| `fills[]` (GRADIENT_*) | `linear-gradient` / `radial-gradient` from `gradientStops`. |
| `fills[]` (IMAGE) | The image is in `preview.assets/` — use it as `background-image` / `<img>`. |
| `strokes[]` + `strokeWeight` | `border` (color from the stroke's paint). |
| `cornerRadius` / `rectangleCornerRadii` | `border-radius` (single value, or `[tl,tr,br,bl]`). |
| `effects[]` (DROP_SHADOW/INNER_SHADOW) | `box-shadow` (offset, radius, color). BLUR → `filter: blur()`. |
| `opacity` | `opacity`. |

## Text fields

`fontName.family` → `font-family`, `fontName.style` (e.g. "Bold") or `fontWeight` → `font-weight`,
`fontSize` → `font-size`, `lineHeight` → `line-height`, `letterSpacing` → `letter-spacing`,
`textAlignHorizontal` → `text-align`, `textCase` → `text-transform`.
