---
name: apply-figma-export
description: Rebuild a Figma design in code from a figma-export bundle. Use when there's a figma-export folder on disk (node.json + components.json + meta.json + a preview) and the user asks to implement, build, or code up that design — "implement this Figma export", "turn this export into components", "build this design".
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

**Multiple nodes:** one `<fileKey>/` dir can hold several sibling folders — a batch export writes one bundle per selected node. Each is independent; treat them one at a time — but if they're the same screen at different breakpoints (mobile / desktop / full HD — the node names usually say so, e.g. `Home/mobile`, `Home/desktop`), build one responsive component from them rather than separate ones. A folder name may carry a `-<id>` suffix to avoid collisions with a same-named sibling, so trust `meta.json`'s `nodeName` for the real name, not the folder.

## How Figma nodes map to code

`node.json` is a tree of nodes. Every node has `id`, `name`, `type`, geometry, and style; containers have `children`. Use the node **`name`** for component/class names — designers name layers meaningfully. Map by `type`:

| `type` | Becomes |
| --- | --- |
| `FRAME`, `COMPONENT`, `INSTANCE`, `GROUP` | A container (`div` / your component). See [Layout](#layout). |
| `TEXT` | Text; `characters` is the content. |
| `RECTANGLE`, `ELLIPSE`, `LINE` | A styled box (background, border, radius). |
| `VECTOR`, `BOOLEAN_OPERATION` | An icon — see [Icons](#icons). Prefer a matching icon from the project's icon library; fall back to the SVG in `preview.assets/`. |

### Layout

Auto-layout is Figma's flexbox: `layoutMode: HORIZONTAL | VERTICAL` → `display: flex`. `GRID` is Figma's grid auto-layout → `display: grid` (but the export only carries the *mode*, not its column/row counts or gaps — read `preview.html` to reconstruct the grid). `NONE`/absent means Figma isn't driving layout; children carry raw `x`/`y`.

| Figma field | CSS |
| --- | --- |
| `layoutMode: HORIZONTAL \| VERTICAL` | `display: flex` + `flex-direction: row \| column` |
| `layoutMode: GRID` | `display: grid` (columns/rows inferred from the preview) |
| `primaryAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`SPACE_BETWEEN`) | `justify-content` (`flex-start`/`center`/`flex-end`/`space-between`) |
| `counterAxisAlignItems` (`MIN`/`CENTER`/`MAX`/`BASELINE`) | `align-items` |
| `itemSpacing` | `gap` (px) |
| `paddingTop/Right/Bottom/Left` | `padding` (px) |
| `layoutWrap: WRAP` | `flex-wrap: wrap` |

**Pick the layout the design wants, not the one Figma happened to use.** Match the CSS to the visual arrangement in `preview.html`: a 1-D row or stack is flex; a repeating 2-D arrangement (card gallery, equal columns, a matrix) is `grid` — even if the designer built it with nested auto-layout or absolute positioning. And `layoutMode: NONE` doesn't mean "use `position: absolute`" — Figma leaves plenty of simple frames unset. Reserve absolute positioning for genuine overlaps (a badge on an avatar, an overlay); otherwise rebuild the arrangement as flex or grid so it stays responsive. Note: the designer's Figma layout grids (column guides) aren't exported — infer columns from the preview and spacing.

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

### Icons

Icons are `VECTOR`/`BOOLEAN_OPERATION` nodes or `INSTANCE`s of an icon component — the node's `name` is the icon name (`home-line`, `chevron-down`). The export always extracts the SVG to `preview.assets/`, but that's the **fallback, not the default**.

Most projects already have an icon library (`lucide-react`, `@heroicons`, a local `Icon` component or `icons/` folder). **Prefer a matching library icon** — it keeps the project's sizing, `currentColor`, and theming. Match by name, allowing for naming differences (`home-line` → `HomeIcon`/`house`), and confirm the glyph against `preview.html`. Only use the `preview.assets/` SVG when there's no match (a custom or branded glyph).

### Design tokens

`boundVariables` on a node means that value is bound to a Figma **variable** (a design token), not a raw literal. When present, prefer the project's matching token (CSS var, theme value, or whatever the project uses) over the hard-coded number/color.

## Workflow

1. **Locate the bundle.** Find the `node.json` the user means (they may point at a folder). Read `meta.json` for scale and `truncated`.
2. **See the target.** Open `preview.html` (or `preview.png`) so you're matching a real design, not guessing from JSON.
3. **Learn the house style.** Before writing anything, check how *this* project builds UI — component library, **icon library/set** (see [Icons](#icons)), styling approach, token/theme source, folder conventions. Search the whole workspace, not just the current app — a shared `ui`/design-system package or sibling monorepo package often owns the real components. Match whatever the project already uses; the export is data, not a style mandate.
4. **Map components first.** For each distinct master in `components.json`, decide: does an existing project component cover it, or do you build one? Turn variant axes into props.
5. **Build outermost-in.** Translate the root container (auto-layout → flex/grid, [Layout](#layout)), then children. For icons, prefer a matching library icon and fall back to `preview.assets/` ([Icons](#icons)); reuse extracted images from `preview.assets/` rather than reconstructing vectors.
6. **Verify against the preview.** Compare your result to `preview.html`: spacing, alignment, radius, colors. Convert 0–1 colors and px correctly. Substitute tokens where `boundVariables` appears. Then run a [Visual check](#visual-check).

## Visual check

Confirm your rebuild against the export — you have vision, use it. Render your build and the design to PNGs of the **same width**, then compare.

**Render the design from `preview.svg`, not `preview.html`.** `preview.html` wraps the SVG in `padding` + centering + `max-width` scaling, so it renders offset and shrunk — diffing against it is meaningless. Use the raw `preview.svg` (or a `preview.png`) for the true canvas.

### Getting the two PNGs

`box-diff` needs no screenshot — hand it the build's dev-server URL or built HTML and it renders internally. Only `visual-diff` / `compare` need captured PNGs, both at the design's frame width (`node.json`'s root `absoluteBoundingBox.width`, e.g. 1440):

- **Build →** screenshot your running build full-page: headless Chrome (`--headless=new --screenshot=build.png --window-size=<w>,<tall>` on the dev-server URL, then trim), or Playwright `page.screenshot({ fullPage: true })`.
- **Design →** rasterize `preview.svg` at the same width: headless Chrome (`--window-size=<w>,<svgHeight>`, the SVG carries its own `width`/`height`) or `magick preview.svg design.png`.

`visual-diff` requires **identical width _and_ height** — full-page heights rarely match, so pad both to the taller with white before diffing: `magick in.png -background white -gravity North -extent <w>x<H> out.png`.

Three bundled tools, by the question you're asking:

| Tool | Answers | Notes |
| --- | --- | --- |
| `scripts/make-compare.mjs <build.png> <design.png>` | *Does it look right?* (human review) | Writes a self-contained `compare.html` — **slider / onion-skin / blink**, plus a **Box-diff** overlay that's **on by default**: it auto-loads `./pairs.json` from box-diff (override with `--boxes <path>`, skip with `--no-boxes`). Node built-ins. |
| `scripts/box-diff.mjs <build.html> <bundle>/node.json` | *Is everything in the right place & size?* (layout) | **Playwright** (`npm i -D playwright`). Pairs rendered elements to Figma nodes; prints Δx/Δy/Δw/Δh, writes `pairs.json`. Immune to fonts/color. **Layout only.** |
| `scripts/visual-diff.mjs <build.png> <design.png> diff.png` | *Which pixels differ?* (appearance) | **pixelmatch** (`npm i -D pixelmatch`). Same-size PNGs; red = differ. Ignores anti-aliasing, but genuinely different fonts/icons still inflate the %, so **read the map, not the number**. |

**Expected to differ, don't chase:** project font vs Figma font, library icon vs exported glyph, token color vs raw hex. The rebuild wears the house style ([step 3](#workflow)) — those aren't bugs. Use **box-diff** for placement, **visual-diff/compare** for appearance, and your own eyes on `compare.html` to judge what actually matters.

For sharper box-diff pairing, have the build emit `data-fig-id="<node id>"` on elements — the script pairs those exactly, falling back to text/geometry otherwise.

### Fix loop

**Layout is yours to close.** box-diff prints text: each Δ past tolerance is a placement bug you own — edit, re-run, repeat until the only Δs left are expected differences ([above](#visual-check)).

**Appearance is not.** visual-diff/compare can't tell a real colour bug from the house style, so don't chase their %. Render `compare.html` and let a human make the final call.

## Related: Figma's own MCP server

Figma ships a [Dev Mode MCP server](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) that pulls design context *live* from a selected node (`get_design_context`, `get_variable_defs`, Code Connect, etc.). It's the right tool when Figma is open and reachable — but it needs a Figma session, a Dev/Full seat, and network. This skill is for the opposite case: a bundle **saved in the repo**, so an agent can rebuild the design offline, in CI, or on the free plan, with no Figma access. They don't compete — reach for the MCP when working against a live file, for these files when working against the snapshot.
