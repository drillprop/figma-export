# Design Compare (Chrome extension)

Overlay a figma-export bundle on a live page, local or deployed, and compare
the design with the implementation by eye. No AI is involved.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `extension/` folder.
3. On any page, click the extension icon or press **Alt+Shift+D**.

After you change the extension files, click the reload icon on its card in
`chrome://extensions`. A panel that is already open on a tab removes itself
and asks you to click the icon again.

## Load a design

Click **Export folder…** and select a bundle folder, for example
`figma-exports/<fileKey>/<node-name>/`. The extension reads `preview.png` and
uses the frame width from `node.json` to size the overlay in CSS pixels. You
can also load a single PNG and set its pixel density (@1x, @2x, or @3x).

Each page (origin and path) remembers its design and settings. To unload the
design, click **✕ Remove**. You can undo for 8 seconds.

## Compare

| Mode | Use it to |
|---|---|
| Onion | Fade the design over the page with an opacity slider. |
| Swipe | Drag a divider. The design is on the left, the live page on the right. |
| Diff | Show matching pixels as black and differences as bright. |

Press **Alt+1**, **Alt+2**, or **Alt+3** to switch modes and **Alt+H** to hide
the overlay.

**Background** paints a solid colour behind the design. A Figma export can be
transparent in places, and without a background the live page shows through
those areas, so the design side of Swipe still shows the website. Choose
**Frame** for the frame's fill from `node.json` (the default), **White**, or
any colour in the picker. Clear the checkbox to see through the design again.

## Match the page size

A responsive page only lines up with the design at the frame's size.

- **Window**: type a width and height and click **Set**. The extension resizes
  the real Chrome window so the page area has exactly that size. Sizes larger
  than the screen are capped, and the panel tells you.
- **Viewport (emulated)**: pick a size. Chrome emulates it through its debugger
  protocol, so any size works. Chrome shows a debugging bar while it is on.
- **Flatten sticky & fixed**: make sticky and fixed elements scroll with the
  page, like the flat Figma frame.

## Align the design

The Navigator window holds the alignment tools.

- **🎯 Match a point**: click a sharp spot on the design, then the same spot
  on the page. The extension moves the design so the spots meet, then compares
  pixels within 12 px to correct your click.
- **Lock**: restrict all movement to one axis (**↔ only** or **↕ only**).
- **X / Y**: type an offset, or drag the X or Y label. Hold Shift for 10×.
- **Arrows and step**: move by 1, 5, 10, or 50 px. Hold an arrow to repeat.
- **Thumbnail**: drag the box to choose which part of the design is on screen.
- **✋** or hold **Space**: drag the design on the page. Hold Shift to keep the
  drag on one axis.
- **📌**: stick the design to the screen instead of scrolling with the page.
  Use it to check sticky headers while they are stuck.

**Alt+arrow keys** move the design by the step size.

## Panels

Drag the main panel and the Navigator by their title bars. Click **–** or
double-click the title bar to minimize the main panel. Hide the Navigator with
its **–** button, and show it again with **🧭** or **Alt+N**. Positions and
visibility are remembered for all pages.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the panel into the tab you click the icon on. |
| `storage`, `unlimitedStorage` | Keep each page's design image and settings. |
| `debugger` | Emulate an exact viewport size. Attached only while a Viewport size is selected, and detached when the tab navigates or reloads. |

## Known limits

- Chrome shows its strongest install warning because of the `debugger`
  permission, even if you never use Viewport emulation.
- The page you compare can read the overlay image and the panels, because they
  live in the page's DOM. Don't use the extension on sites you don't trust.
- Each page's design image stays in extension storage until you remove it.
