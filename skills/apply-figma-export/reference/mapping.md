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
