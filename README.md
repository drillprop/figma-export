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
     styles.json         named colour, text, effect, and grid styles (if any)
     preview.svg          vector reference
     preview.png          raster reference
     preview.html         open this to view the SVG (centered, no padding)
     preview.assets/      SVG preview images, vector icons, + original IMAGE-fill files by hash (see below)
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

**Images.** Raster images behind `IMAGE` fills are exported at their *original*
bytes into `preview.assets/`, each named by its Figma image hash
(`<imageHash>.<ext>`). To place an image, read a node's `fills[].imageHash` in
`node.json` and load `preview.assets/<imageHash>.<ext>` — the join is exact. (The
`img-N.png` in the same folder are lower-fidelity copies pulled out of the SVG
*for the preview only* and not matched to nodes.) Written only when the export
uses image fills.

**Design tokens.** `variables.json` is the file's full token catalog: every
Figma **Variable** (colors, spacing, radii, etc.) in every local collection,
resolved into named tokens with per-mode values (e.g. Light/Dark) and following
alias chains — plus any remote/library tokens the export references. Nodes in
`node.json` only carry opaque `boundVariables` ids — join those ids against
`variables.json`'s `tokens[].id` to recover the token name and value, so
generated code can emit `var(--token)` instead of hard-coded hex/px. The file is
written whenever the file has any variables.

**Styles.** `styles.json` lists the file's named **styles**: every local colour,
text, effect, and grid style, plus any library style the export references.
Each carries its name (e.g. `Dark Steel`, `HD/H1`) and its values: paints, text
properties, effects, or layout grids. Nodes in `node.json` carry `fillStyleId`,
`strokeStyleId`, `textStyleId`, `effectStyleId`, and `gridStyleId`. Join those
against `styles.json`'s `styles[].id` to recover the named style. A text layer
that mixes styles has `textStyleId: "MIXED"` and a `styledTextSegments` list
giving the style ids for each run of characters. Written whenever the file has
any styles.

The path you give is the exact base; want a `figma-export/` subfolder? Include
it in the path. The server refuses to write if the folder doesn't exist.

## Headless export

A bot can write the same bundle without the Figma desktop app, the plugin, or the
server. It runs the plugin's own export code through the Figma MCP's `use_figma`
tool, which executes Plugin API JavaScript on a file and returns the code's JSON
result. The result is exactly the body the plugin POSTs to `/sync`, cut into
parts, and the writer passes it to the same file writer the server uses.

To export a node:

1. Generate the code for part 0. Pass a Figma URL that carries a `node-id`, or a
   node id plus `--file-key`. Pass the file key either way: outside a private
   plugin, `figma.fileKey` is not available, and the bundle folder is named after it.

   ```bash
   pnpm -s headless:code 'https://www.figma.com/design/<fileKey>/<name>?node-id=1-2' > part-0.js
   ```

   The code goes to stdout. The generator prints the code size and the command
   for the other parts to stderr. That command repeats `--exported-at` with the
   value from this run. Every part must use the same value.

2. Call `use_figma` on the file with the contents of `part-0.js` as the code.
   Save the result to `part-0.json`. The result is a part object:
   `{ "format": "figma-export/headless-part@1", "part": 0, "parts": 3, ... }`.
   If your client already saved the tool result to a file, pass that file to the
   writer as it is. Otherwise write the result with your file tool exactly as it
   came back. Do not shorten, reformat, or retype any part of `data`.
3. If `parts` is greater than 1, generate the code for each remaining index with
   the command from step 1, call `use_figma` with it, and save each result as
   `part-<i>.json`:

   ```bash
   pnpm -s headless:code '<same url>' --exported-at <value from step 1> --part 1 > part-1.js
   ```

4. Write the bundle:

   ```bash
   pnpm -s headless:write --out /path/to/your/repo/design part-*.json
   ```

   The writer prints the bundle folder, `<out>/<fileKey>/<node-name>/`. It
   creates `--out` when the folder does not exist.

The writer accepts each saved result in any of these forms: the part object itself, an
array of parts, the MCP content wrapper (`[{"type":"text","text":"..."}]`), or
text with the JSON inside it. It also accepts a directory of saved results.

**Parts.** A tool response has a size limit, and a preview PNG alone can exceed
it. So the code serializes the payload to JSON and returns one slice of
`--part-size` characters (default 30,000) per call. The JSON escapes every
non-ASCII character, so a slice is plain ASCII and can end anywhere. A part's
JSON is about 1.2 times its slice, so about 36,000 characters at the default.
Each call runs the whole export again and returns only its slice. Each part
carries a hash of the full JSON and a hash of its own slice. If a part is
missing, cut short, or from an export that differs, the writer stops and names
the part to fetch again.

- If a `use_figma` response comes back truncated, generate the code again with a
  smaller `--part-size` and fetch every part again.
- If the writer reports the same part as corrupt after you fetch it again, the
  saved copy differs from the tool result. Save it again without changes, or use
  a smaller `--part-size` so that each result is shorter.
- If the writer reports parts from a different export, the file changed between
  calls, or a preview rendered differently. Fetch every part again with the same
  `--exported-at`.

To try the headless path on a real file, pick a frame that has text, an
instance, and an image fill. Export it with the plugin to one folder and
headless to another, then compare the two bundles with
`diff -r <plugin-out>/<fileKey> <headless-out>/<fileKey>`. Only `exportedAt` in
`meta.json` differs, unless you pass the plugin run's timestamp as
`--exported-at`.

**Options.** `--no-remote` skips importing library masters by key, like the
plugin's **Include components from other files** checkbox. `--file-key`
overrides the file key from the URL. A bare node id accepts both `1:2` and `1-2`.

**Limits.** The generator fails when the code reaches the `use_figma` limit of
50,000 characters. The generated code calls only Plugin API methods that
`use_figma` supports: no `figma.loadAllPagesAsync`, no `setPluginData`, and no
`createImageAsync`.

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
pnpm test           # node:test suite, incl. headless vs /sync bundle equality
```

`plugin/code.js` and `plugin/ui.html` are build outputs (gitignored); run
`pnpm build:plugin` before importing the manifest. The plugin and server share
their payload contract from `src/shared/types.ts`, so the two cannot drift. The
headless path reuses the same code: `plugin/src/export-node.ts` (export core),
`plugin/src/payload.ts` (bytes to payload), and `src/bundle.ts` (bundle writer).
`test/fake-figma.ts` is the in-memory Plugin API the tests run both paths
against. After an intended change to the payload or the bundle files, run
`pnpm test:record`. It records `test/fixtures/headless-sample/` (the parts) and
`test/fixtures/headless-sample-bundle/` (the expected bundle) again.

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
