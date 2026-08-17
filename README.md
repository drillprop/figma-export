# figma-export

Export Figma nodes and components to JSON files in a local repo, for feeding to
AI tooling — a Figma plugin plus a small local [Hono](https://hono.dev) server
that writes the files.

## Why a server?

Figma plugins run in a sandbox with **no filesystem access** (the File System
Access API is blocked in plugin iframes). So the plugin cannot write to a folder
on your disk by itself. This local server is the piece that does — the plugin
POSTs the export to it, and it writes the files to the folder you choose. It
binds to `127.0.0.1` only, so it is never reachable off your machine.

## Why a plugin (not the REST API)?

On Figma's free plan the REST API is capped at ~6 file reads/month. A plugin
runs inside the editor with direct document access and no rate limits. The
tradeoff: it only sees the currently-open file and is run manually.

## Setup

Requires the **Figma desktop app** (needed for local plugin development) and
Node + pnpm.

```bash
pnpm install
pnpm build:plugin        # bundles plugin/src/*.ts → plugin/code.js + plugin/ui.html
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…**
and pick `plugin/manifest.json`.

## Usage

1. Start the server (optionally with a default output folder):

   ```bash
   pnpm dev                                   # http://127.0.0.1:3579
   OUT_DIR=/path/to/your/repo/design pnpm dev # default folder if the plugin field is blank
   ```

2. In Figma, run **Plugins → Development → Export to Repo**.
3. Set the **Output folder**: click **Browse…** to pick it with the native macOS
   folder dialog (the server opens it — the plugin sandbox can't), or type an
   absolute path. It's remembered between runs; blank uses the server's `OUT_DIR`.
4. **Select** a frame/component — the Export button shows its name.
5. Click **Export**. Files are written to:

   ```
   <output folder>/<fileKey>/<node-name>/
     node.json           full serialized subtree
     figma-components.json  unique components used (+ variant values, remote masters)
     meta.json           ids, timestamp, and the summary
     remote-masters.json resolved library-component definitions (if any)
     variables.json      resolved design tokens referenced by the export (if any)
     preview.svg          vector reference
     preview.png          raster reference
     preview.html         open this to view the SVG (centered, no padding)
     preview.assets/      images + vector icons pulled out of the SVG (see below)
   ```

   **Previews.** Every export always writes all three previews — `preview.svg`,
   `preview.png`, and `preview.html` — no format choice. The raster fills are
   pulled out under `preview.assets/` and referenced from the SVG
   (`href="preview.assets/img-0.png"`) — no base64, so the committed `.svg` stays
   small and diff-friendly. Because a browser blocks external images when an SVG
   is opened as a plain `file://` or `<img>` ("secure static mode"),
   **`preview.html`** inlines the SVG (centered, with no page padding) so those
   images render — open that for the truest view. Pure-vector nodes produce no
   raster assets.

   **Icons.** Vector-only components/instances are also extracted to
   `preview.assets/` as standalone SVGs, named `<name>.<key>.svg` — a readable
   name plus the component's stable key. That trailing key gives an exact node
   join: a `node.json` INSTANCE's `mainComponentKey` (or a component's key via
   `figma-components.json`; else the node id) matches the icon file's key
   segment. Deduped by key.

**Design tokens.** `variables.json` is the file's full token catalog: every
Figma **Variable** (colors, spacing, radii, etc.) in every local collection,
resolved into named tokens with per-mode values (e.g. Light/Dark) and following
alias chains — plus any remote/library tokens the export references. Nodes in
`node.json` only carry opaque `boundVariables` ids — join those ids against
`variables.json`'s `tokens[].id` to recover the token name and value, so
generated code can emit `var(--token)` instead of hard-coded hex/px. The file is
written whenever the file has any variables.

The path you give is the exact base; want a `figma-export/` subfolder? Include
it in the path. The server refuses to write if the folder doesn't exist.

## Applying an export (agent skill)

The exported JSON is meant to be fed to AI tooling. `skills/apply-figma-export/`
is an installable agent skill that teaches an agent how to read a bundle
(`node.json`, `figma-components.json`, the preview) and rebuild the design as code in
your own stack. Copy or symlink it into your project's skills directory (e.g.
`.claude/skills/apply-figma-export`) and commit the export alongside your code.

## Development

```bash
pnpm dev            # server, watch/restart (tsx)
pnpm dev:plugin     # rebuild plugin on change (esbuild watch)
pnpm check-types    # tsc --noEmit
```

`plugin/code.js` and `plugin/ui.html` are build outputs (gitignored); run
`pnpm build:plugin` before importing the manifest. The plugin and server share
their payload contract from `src/shared/types.ts`, so the two cannot drift.

## Notes / limits

- **Current file only.** It exports the selection in the open file; it can't
  read a file you haven't opened (that would need the rate-limited REST API).
- **Large selections** can crash the Figma tab (out of memory). Guards:
  serialization is capped at 40k nodes (marks the export truncated), the SVG
  preview is skipped above ~6k nodes (the PNG still stands in), and node counts
  are logged to the plugin dev console (**Plugins → Development → Open console**).
- **Remote/library components** used in the file export fully; with *Resolve
  remote library masters* on, their master definitions are imported by key
  (needs the library published + enabled in the file).
