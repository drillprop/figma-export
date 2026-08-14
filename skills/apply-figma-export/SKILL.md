---
name: apply-figma-export
description: Turn a figma-export bundle into code. Use when a folder holds figma-export output (node.json + components.json + meta.json + a preview) and the user wants that Figma node rebuilt as components, markup, or styles in their own stack.
---

# Apply a Figma Export

A [figma-export](https://github.com/drillprop/figma-export) bundle is a Figma node tree serialized to JSON so you can rebuild it in code **without** opening Figma or hitting its API. This skill teaches you to read that bundle and translate it into the project's own components and styles.

## The bundle

One export lives at `<out>/<fileKey>/<node-name>/`:

| File | What it is |
| --- | --- |
| `node.json` | The full node subtree — your source of truth for structure and style. |
| `components.json` | Every component used, with variant axes/values (+ resolved library masters). |
| `meta.json` | Summary: node/text counts, node types, component tallies, truncation flags. |
| `remote-masters.json` | Master definitions for library components, when resolved. |
| `preview.html` | **Open this first** — the rendered design. Your visual target. |
| `preview.svg` / `preview.png` | The raw preview (`preview.html` inlines the SVG so its images load). |
| `preview.assets/` | Raster images and vector icons pulled out of the SVG, as standalone files. |

**Read order:** open `preview.html` to see the goal → skim `meta.json` for scale → walk `node.json` for structure. Check `meta.json.truncated`: if `true`, the tree was capped (huge selection) and is incomplete.

## How Figma nodes map to code

`node.json` is a tree of nodes. Every node has `id`, `name`, `type`, geometry, and style; containers have `children`. Use the node **`name`** for component/class names — designers name layers meaningfully. Map by `type`:

| `type` | Becomes |
| --- | --- |
| `FRAME`, `COMPONENT`, `INSTANCE`, `GROUP` | A container (`div` / your component). See auto-layout below. |
| `TEXT` | Text; `characters` is the content. |
| `RECTANGLE`, `ELLIPSE`, `LINE` | A styled box (background, border, radius). |
| `VECTOR`, `BOOLEAN_OPERATION` | An icon — pull the matching SVG from `preview.assets/` instead of rebuilding paths. |

### Auto-layout → flexbox

When a container has `layoutMode` set to `HORIZONTAL` or `VERTICAL`, it's flex. `NONE`/absent means children are absolutely positioned (`x`/`y` within the parent).

| Figma field | CSS |
| --- | --- |
| `layoutMode: HORIZONTAL \| VERTICAL` | `display: flex` + `flex-direction: row \| column` |
| `primaryAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`SPACE_BETWEEN`) | `justify-content` (`flex-start`/`center`/`flex-end`/`space-between`) |
| `counterAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`BASELINE`) | `align-items` |
| `itemSpacing` | `gap` (px) |
| `paddingTop/Right/Bottom/Left` | `padding` (px) |
| `layoutWrap: WRAP` | `flex-wrap: wrap` |

### Style fields

| Figma | CSS |
| --- | --- |
| `fills[]` (SOLID) | `background` / text `color`. `color` is `{r,g,b}` in **0–1** — multiply by 255. `opacity` on the paint → alpha. |
| `fills[]` (GRADIENT_*) | `linear-gradient` / `radial-gradient` from `gradientStops`. |
| `fills[]` (IMAGE) | The image is in `preview.assets/` — use it as `background-image` / `<img>`. |
| `strokes[]` + `strokeWeight` | `border` (color from the stroke's paint). |
| `cornerRadius` / `rectangleCornerRadii` | `border-radius` (single value, or `[tl,tr,br,bl]`). |
| `effects[]` (DROP_SHADOW/INNER_SHADOW) | `box-shadow` (offset, radius, color). BLUR → `filter: blur()`. |
| `opacity` | `opacity`. |

### Text fields

`fontName.family` → `font-family`, `fontName.style` (e.g. "Bold") or `fontWeight` → `font-weight`, `fontSize` → `font-size`, `lineHeight` → `line-height`, `letterSpacing` → `letter-spacing`, `textAlignHorizontal` → `text-align`, `textCase` → `text-transform`.

### Components & variants

An `INSTANCE` node points at a component via `mainComponentName`/`mainComponentKey` and carries `componentProperties`. `components.json` is the catalog: each entry has `variantProperties` (the axes, e.g. `{ Size: ["sm","md"], Style: ["Primary"] }`) and each instance's `variantValues` (its selection).

- One component **set** → one reusable component in the project.
- Variant axes → props/variants (e.g. a `variant`/`size` prop, or a design-system component's existing props).
- Repeated instances of the same master → **reuse** one component, don't inline each copy.

### Design tokens

`boundVariables` on a node means that value is bound to a Figma **variable** (a design token), not a raw literal. When present, prefer the project's matching token (Tailwind class, CSS var, theme value) over the hard-coded number/color.

## Workflow

1. **Locate the bundle.** Find the `node.json` the user means (they may point at a folder). Read `meta.json` for scale and `truncated`.
2. **See the target.** Open `preview.html` (or `preview.png`) so you're matching a real design, not guessing from JSON.
3. **Learn the house style.** Before writing anything, check how *this* project builds UI — component library, styling approach (Tailwind / CSS modules / styled), token/theme source, folder conventions. Match it; the export is data, not a style mandate.
4. **Map components first.** For each distinct master in `components.json`, decide: does an existing project component cover it, or do you build one? Turn variant axes into props.
5. **Build outermost-in.** Translate the root container (auto-layout → flex), then children, reusing icons/images from `preview.assets/` rather than reconstructing vectors.
6. **Verify against the preview.** Compare your result to `preview.html`: spacing, alignment, radius, colors. Convert 0–1 colors and px correctly. Substitute tokens where `boundVariables` appears.

## Related: Figma's own MCP server

Figma ships a [Dev Mode MCP server](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) that pulls design context *live* from a selected node (`get_design_context`, `get_variable_defs`, Code Connect, etc.). It's the right tool when Figma is open and reachable — but it needs a Figma session, a Dev/Full seat, and network. This skill is for the opposite case: a bundle **committed to the repo**, so an agent can rebuild the design offline, in CI, or on the free plan, with no Figma access. They don't compete — reach for the MCP when working against a live file, for these files when working against the snapshot.

## Install

Copy or symlink this folder into a project's skills directory (e.g. `.claude/skills/apply-figma-export`), then commit the Figma export bundle alongside the code. The agent picks it up whenever it sees an export folder.
