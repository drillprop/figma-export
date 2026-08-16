// Figma plugin UI (iframe). Collects settings, labels the Export button from the
// live selection, receives the serialized payload from the main thread, and
// POSTs it to the local figma-export server (the sandbox main thread has no
// `fetch`; only this iframe does).
import type {
  AssetFile,
  ExportPayload,
  ExportSummary,
  OpenResponse,
  PickFolderResponse,
  SyncResponse,
} from "../../src/shared/types";

interface SelectionNode {
  id: string;
  name: string;
  type: string;
}

// Messages from the main thread (code.ts).
type FromPlugin =
  | { type: "settings"; outputDir: string; endpoint: string }
  | { type: "selection"; nodes: SelectionNode[] }
  | { type: "progress"; message: string }
  | { type: "error"; message: string }
  | {
      type: "result";
      payload: ExportPayload;
      svgBytes: Uint8Array | null;
      pngBytes: Uint8Array | null;
      icons: { name: string; bytes: Uint8Array }[];
      images: { imageHash: string; name: string; bytes: Uint8Array }[];
    }
  | { type: "batch-progress"; index: number; total: number }
  | {
      type: "batch-item";
      name: string;
      payload: ExportPayload;
      svgBytes: Uint8Array | null;
      pngBytes: Uint8Array | null;
      icons: { name: string; bytes: Uint8Array }[];
      images: { imageHash: string; name: string; bytes: Uint8Array }[];
    }
  | { type: "batch-fail"; name: string; error: string }
  | { type: "batch-done" };

/** One node's outcome within a batch run, accumulated for the end summary. */
interface BatchResult {
  name: string;
  ok: boolean;
  error?: string;
  /** On-disk node folder (successful items only) — its parent is the batch's
   * `<fileKey>/` dir that the single Open-folder button points at. */
  path?: string;
  /** One-line-stat inputs pulled from the node's summary. */
  layers?: number;
  components?: number;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = byId<HTMLDivElement>("status");
const bannerEl = byId<HTMLDivElement>("banner");
const resultEl = byId<HTMLDivElement>("result");
const controlsEl = byId<HTMLDivElement>("controls");
const connDotEl = byId<HTMLSpanElement>("connDot");
const btn = byId<HTMLButtonElement>("export");
const outputDirEl = byId<HTMLInputElement>("outputDir");
const browseEl = byId<HTMLButtonElement>("browse");
const endpointEl = byId<HTMLInputElement>("endpoint");
const resolveRemoteEl = byId<HTMLInputElement>("resolveRemote");

let selection: SelectionNode[] = [];
let busy = false;
// Accumulated per-node outcomes for an in-flight batch (2+ nodes).
let batchResults: BatchResult[] = [];

function setStatus(text: string, cls: "" | "err" | "progress" = ""): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// --- connection indicator ----------------------------------------------
// "unknown" until we've reached the server; "ok" once we have; "down" when
// the server can't be reached (decision #10: the dot flips red).
function setConnection(state: "unknown" | "ok" | "down"): void {
  const modifier = { unknown: "", ok: " ok", down: " down" }[state];
  connDotEl.className = "conn-dot" + modifier;
}

// --- error banner -------------------------------------------------------
// Red danger banner carrying a recovery action (distinct from the amber
// success-report warnings). Only one is shown at a time.
interface BannerAction {
  label: string;
  solid?: boolean;
  onClick: () => void;
}

function clearBanner(): void {
  bannerEl.textContent = "";
  bannerEl.className = "";
}

/** Dismiss the error banner and the bad-folder outline together. */
function clearErrors(): void {
  clearBanner();
  outputDirEl.classList.remove("bad");
}

function showBanner(title: string, message: string, actions: BannerAction[]): void {
  bannerEl.textContent = "";
  const head = el("div", { class: "b-title" }, [
    el("span", { text: "⚠" }),
    el("span", { text: title }),
  ]);
  const acts = el("div", { class: "b-actions" });
  for (const action of actions) {
    const b = el("button", {
      class: "b-btn" + (action.solid ? " solid" : ""),
      text: action.label,
    }) as HTMLButtonElement;
    b.onclick = action.onClick;
    acts.appendChild(b);
  }
  bannerEl.appendChild(head);
  bannerEl.appendChild(el("div", { class: "b-msg", text: message }));
  bannerEl.appendChild(acts);
  bannerEl.className = "show";
}

function copyEndpoint(): void {
  void navigator.clipboard?.writeText(endpointEl.value.trim());
}

/** Server unreachable — plain message + retry, no onboarding (decision #10). */
function showServerUnreachable(): void {
  setConnection("down");
  setStatus("");
  showBanner(
    "Can’t reach the export server",
    "The local server isn’t responding. Make sure it’s running, then try again.",
    [
      { label: "Try again", solid: true, onClick: startExport },
      { label: "Copy endpoint", onClick: copyEndpoint },
    ],
  );
}

/** Output folder missing/invalid — outline the input and offer the picker. */
function showFolderNotFound(): void {
  outputDirEl.classList.add("bad");
  setStatus("");
  showBanner(
    "That folder couldn’t be found",
    "Check the path above, or choose another folder with Browse.",
    [{ label: "Choose folder…", solid: true, onClick: () => void chooseFolder() }],
  );
}

/** The export itself failed — offer a retry, hint at a smaller frame. */
function showExportFailed(): void {
  setStatus("");
  showBanner(
    "Export didn’t finish",
    "Something went wrong while exporting this selection. Try again, and if it keeps happening, try a smaller frame.",
    [{ label: "Try again", solid: true, onClick: startExport }],
  );
}

/** Friendly, jargon-free label for a Figma node type (e.g. "Component set"). */
function typeLabel(type: string): string {
  const known: Record<string, string> = {
    COMPONENT_SET: "Component set",
    COMPONENT: "Component",
    INSTANCE: "Instance",
    FRAME: "Frame",
    GROUP: "Group",
    SECTION: "Section",
  };
  return known[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

/** Pull raster images out of an SVG's inline data URIs into separate files, and
 * rewrite the references to point at `preview.assets/<name>`. Identical images
 * are deduped to one file. Pure-vector SVGs return unchanged with no assets. */
function externalizeSvgImages(svg: string): { svg: string; assets: AssetFile[] } {
  const assets: AssetFile[] = [];
  const byData = new Map<string, string>(); // base64 data -> file name
  const extFor = (mime: string): string =>
    mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : mime === "image/png" ? "png" : "bin";

  const pattern = /(xlink:href|href)="data:(image\/[a-zA-Z0-9.+-]+);base64,([^"]+)"/g;
  const out = svg.replace(pattern, (_match, attr: string, mime: string, data: string) => {
    let name = byData.get(data);
    if (!name) {
      name = `img-${assets.length}.${extFor(mime)}`;
      byData.set(data, name);
      assets.push({ name, base64: data });
    }
    return `${attr}="preview.assets/${name}"`;
  });
  return { svg: out, assets };
}

/** Encode bytes to base64 in chunks (avoids call-stack limits on big PNGs). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- report rendering ---------------------------------------------------
interface ElOpts {
  class?: string;
  text?: string;
}
function el(tag: string, opts: ElOpts = {}, children: (Node | null)[] = []): HTMLElement {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function chip(label: string, count?: number): HTMLElement {
  const c = el("span", { class: "chip" });
  c.appendChild(el("b", { text: label }));
  if (count != null) c.appendChild(el("span", { class: "n", text: String(count) }));
  return c;
}

function section(title: string, body: Node): HTMLElement {
  return el("div", { class: "section" }, [el("div", { class: "section-title", text: title }), body]);
}

/** A paragraph mixing plain and bold runs (built as text nodes so a Figma layer
 * name can't inject markup). */
function plainLine(runs: { text: string; bold?: boolean }[]): HTMLElement {
  const p = el("div", { class: "wrote-plain" });
  for (const run of runs) {
    p.appendChild(run.bold ? el("b", { text: run.text }) : document.createTextNode(run.text));
  }
  return p;
}

/** The plain-language "what was written" line. */
function wroteLine(ctx: ReportContext, s: ExportSummary): HTMLElement {
  const name = s.target.name;
  const tail: string[] = [];
  if (s.preview.svg || s.preview.png) tail.push("a preview you can open");
  const parts: string[] = [];
  if (ctx.iconCount > 0) parts.push(`${ctx.iconCount} icon${ctx.iconCount === 1 ? "" : "s"}`);
  if (ctx.imageCount > 0) parts.push(`${ctx.imageCount} image${ctx.imageCount === 1 ? "" : "s"}`);
  if (parts.length) tail.push(`${parts.join(" and ")} as separate files`);
  return plainLine([
    { text: "Saved your " },
    { text: name, bold: true },
    { text: " as a " },
    { text: "folder of assets", bold: true },
    { text: tail.length ? ` — ${tail.join(", ")}.` : "." },
  ]);
}

/** All of today's technical stats, softened, for the collapsed Details block. */
function techDetail(s: ExportSummary): HTMLElement {
  const wrap = el("div", { class: "more-body" });

  const stats = el("div", { class: "stats" });
  const tile = (val: string | number, label: string) =>
    el("div", { class: "stat" }, [
      el("div", { class: "stat-val", text: String(val) }),
      el("div", { class: "stat-label", text: label }),
    ]);
  stats.appendChild(tile(s.totalNodes, "layers"));
  stats.appendChild(
    tile(s.components.total, `components · ${s.components.local} local / ${s.components.remote} linked`),
  );
  stats.appendChild(tile(s.textLayerCount, "text layers"));
  const previewParts = [s.preview.svg && "svg", s.preview.png && "png"].filter(Boolean);
  const previewLabel = s.preview.svgSkipped
    ? "png only"
    : previewParts.length
      ? previewParts.join(" + ")
      : "none";
  stats.appendChild(tile(previewLabel, "preview"));
  wrap.appendChild(stats);

  wrap.appendChild(section("Target", el("div", { text: `${s.target.name} · ${s.target.type}` })));

  const types = Object.entries(s.nodeTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const typeChips = el("div", { class: "chips" });
  for (const [type, n] of types) typeChips.appendChild(chip(type, n));
  wrap.appendChild(section("Layer types", typeChips));

  if (s.sets.length) {
    const setsWrap = el("div");
    for (const set of s.sets) {
      const setEl = el("div", { class: "set" }, [el("div", { class: "set-name", text: set.name })]);
      for (const [key, values] of Object.entries(set.axes)) {
        const chips = el("div", { class: "chips" });
        for (const v of values) chips.appendChild(chip(v));
        setEl.appendChild(
          el("div", { class: "axis" }, [el("div", { class: "axis-key", text: key }), chips]),
        );
      }
      setsWrap.appendChild(setEl);
    }
    wrap.appendChild(section(`Variant sets (${s.sets.length})`, setsWrap));
  }

  if (s.components.remote > 0) {
    const linked = el("div");
    const badges = el("div", { class: "chips" });
    badges.appendChild(el("span", { class: "badge ok", text: `${s.remoteMastersResolved} loaded` }));
    if (s.remoteMasterErrors.length) {
      badges.appendChild(
        el("span", { class: "badge warn", text: `${s.remoteMasterErrors.length} failed` }),
      );
    }
    linked.appendChild(badges);
    wrap.appendChild(section("Linked components", linked));
  }

  if (s.variables && s.variables.tokens > 0) {
    const badges = el("div", { class: "chips" }, [
      el("span", { class: "badge ok", text: `${s.variables.tokens} tokens` }),
      el("span", { class: "badge ok", text: `${s.variables.collections} collections` }),
    ]);
    wrap.appendChild(section("Design tokens", badges));
  }

  if (s.imageAssets && s.imageAssets > 0) {
    const badges = el("div", { class: "chips" }, [
      el("span", { class: "badge ok", text: `${s.imageAssets} files` }),
    ]);
    wrap.appendChild(section("Images", badges));
  }

  if (s.textSamples.length) {
    const list = el("div", { class: "samples" });
    for (const t of s.textSamples) list.appendChild(el("div", { class: "sample", text: `“${t}”` }));
    const extra = s.textLayerCount - s.textSamples.length;
    if (extra > 0) list.appendChild(el("div", { class: "sample", text: `+${extra} more…` }));
    wrap.appendChild(section("Text content", list));
  }

  return wrap;
}

/** Plain-language rewrites of every warning a successful export can carry
 * (decision #9). Returned in the order they should read; empty when clean. */
function warningItems(s: ExportSummary): string[] {
  const items: string[] = [];
  if (s.truncated && s.truncatedAt != null) {
    items.push(
      `Very large selection. We saved the first ${s.truncatedAt.toLocaleString()} layers — export a smaller frame to include everything.`,
    );
  }
  if (s.preview.svgSkipped) {
    items.push(
      "SVG preview skipped — this artwork was too large for a vector preview. The PNG preview and HTML wrapper were still saved.",
    );
  }
  const failed = s.remoteMasterErrors.length;
  if (failed === 1) {
    items.push(
      `1 linked component couldn't be loaded — “${s.remoteMasterErrors[0].name}” was published from another file that isn't enabled here, so it's saved as a reference only.`,
    );
  } else if (failed > 1) {
    items.push(
      `${failed} linked components couldn't be loaded — they were published from other files that aren't enabled here, so they're saved as references only.`,
    );
  }
  return items;
}

/** Collapse any issues into one amber "⚠ N things worth knowing" summary that
 * expands to the plain-language detail. Null when the export was clean. */
function renderWarnings(s: ExportSummary): HTMLElement | null {
  const items = warningItems(s);
  if (!items.length) return null;

  const details = el("details", { class: "warnings" });
  const summary = el("summary");
  summary.appendChild(el("span", { class: "caret", text: "▸" }));
  summary.appendChild(
    el("span", { text: `⚠ ${items.length} thing${items.length === 1 ? "" : "s"} worth knowing` }),
  );
  details.appendChild(summary);

  const body = el("div", { class: "warn-body" });
  for (const item of items) body.appendChild(el("div", { class: "warn-item", text: item }));
  details.appendChild(body);
  return details;
}

/** Ask the server to reveal a folder / open a file (the plugin iframe can't). */
async function openPath(target: string, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  try {
    const res = await fetch(`${serverBase()}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    setConnection("ok");
    const body = (await res.json().catch(() => ({}))) as OpenResponse;
    if (!res.ok) setStatus(body.error || "Could not open that.", "err");
  } catch (err) {
    setConnection("down");
    setStatus(`Could not reach the server to open that.\n${String(err)}`, "err");
  } finally {
    trigger.disabled = false;
  }
}

/** Return to the ready state so another export can be started. */
function resetToReady(): void {
  resultEl.textContent = "";
  resultEl.className = "";
  setStatus("");
  renderSelection();
}

/** What the calm receipt needs beyond the summary itself. */
interface ReportContext {
  path: string;
  previewPath?: string;
  iconCount: number;
  imageCount: number;
}

function renderReport(s: ExportSummary, ctx: ReportContext): void {
  resultEl.textContent = "";

  // Headline.
  resultEl.appendChild(
    el("div", { class: "r-head" }, [el("span", { class: "r-tick", text: "✓" }), el("span", { text: "Export saved" })]),
  );

  // Destination — path + Open folder.
  const openFolderBtn = el("button", { class: "mini", text: "Open folder" }) as HTMLButtonElement;
  openFolderBtn.onclick = () => void openPath(ctx.path, openFolderBtn);
  resultEl.appendChild(
    el("div", { class: "dest" }, [el("div", { class: "r-path", text: ctx.path }), openFolderBtn]),
  );

  // Actions — Open preview (when one was written) · Export another.
  const actions = el("div", { class: "actions" });
  if (ctx.previewPath) {
    const previewBtn = el("button", { class: "mini", text: "Open preview" }) as HTMLButtonElement;
    const previewPath = ctx.previewPath;
    previewBtn.onclick = () => void openPath(previewPath, previewBtn);
    actions.appendChild(previewBtn);
  }
  const anotherBtn = el("button", { class: "mini", text: "Export another" }) as HTMLButtonElement;
  anotherBtn.onclick = resetToReady;
  actions.appendChild(anotherBtn);
  resultEl.appendChild(actions);

  // Warnings — one amber, expandable summary in plain language.
  const warnings = renderWarnings(s);
  if (warnings) resultEl.appendChild(warnings);

  // Plain-language summary.
  resultEl.appendChild(wroteLine(ctx, s));

  // Everything technical, collapsed by default.
  const details = el("details", { class: "more" });
  const summary = el("summary");
  summary.appendChild(el("span", { class: "caret", text: "▸" }));
  summary.appendChild(document.createTextNode("Details"));
  details.appendChild(summary);
  details.appendChild(techDetail(s));
  resultEl.appendChild(details);

  resultEl.className = "show";
}

// --- selection + export -------------------------------------------------
function renderSelection(): void {
  const first = selection[0];
  const multi = selection.length > 1;
  const selName = byId<HTMLDivElement>("selName");
  const selMeta = byId<HTMLDivElement>("selMeta");
  const selThumb = byId<HTMLDivElement>("selThumb");
  if (!first) {
    selName.textContent = "Nothing selected";
    selMeta.textContent = "Select a layer on the canvas.";
    selThumb.textContent = "–";
  } else if (multi) {
    selName.textContent = `${selection.length} layers`;
    selMeta.textContent = "Each is exported to its own folder.";
    selThumb.textContent = String(selection.length);
  } else {
    selName.textContent = first.name;
    selMeta.textContent = typeLabel(first.type);
    selThumb.textContent = (first.name.trim()[0] ?? "?").toUpperCase();
  }
  renderSelList(multi ? selection : []);
  if (busy) return;
  btn.disabled = !first;
  if (!first) btn.textContent = "Select something to export";
  else if (multi) btn.textContent = `Export ${selection.length} layers`;
  else btn.textContent = `Export “${first.name}”`;
}

/** Peek-list of the individual layers in a multi-selection, so you can scan
 * exactly what's about to be exported. Empty list hides it (single/none). */
function renderSelList(nodes: SelectionNode[]): void {
  const list = byId<HTMLDivElement>("selList");
  list.textContent = "";
  list.hidden = nodes.length === 0;
  for (const node of nodes) {
    list.appendChild(
      el("div", { class: "sel-row" }, [
        el("span", { class: "sel-row-name", text: node.name }),
        el("span", { class: "sel-row-type", text: typeLabel(node.type) }),
      ]),
    );
  }
}

/** Derive the server base (e.g. http://localhost:3579) from the endpoint field. */
function serverBase(): string {
  return endpointEl.value.trim().replace(/\/sync\/?$/, "");
}

/** Open the native folder picker; doubles as the folder-error recovery action. */
async function chooseFolder(): Promise<void> {
  const original = browseEl.textContent;
  browseEl.disabled = true;
  browseEl.textContent = "Choosing…";
  setStatus("Opening folder picker — look for a system dialog…", "progress");
  try {
    const res = await fetch(`${serverBase()}/pick-folder`);
    setConnection("ok");
    const body = (await res.json().catch(() => ({}))) as PickFolderResponse;
    if (body.path) {
      outputDirEl.value = body.path;
      clearErrors();
      setStatus("");
    } else if (body.cancelled) {
      setStatus("");
    } else {
      setStatus(body.error || "Folder picker failed.", "err");
    }
  } catch {
    showServerUnreachable();
  } finally {
    browseEl.disabled = false;
    browseEl.textContent = original;
  }
}
browseEl.onclick = () => void chooseFolder();

/** Enter the exporting state: dim the controls, spin the button, calm status. */
function enterExporting(): void {
  busy = true;
  btn.disabled = true;
  controlsEl.classList.add("dimmed");
  resultEl.className = "";
  btn.textContent = "";
  btn.appendChild(el("span", { class: "spinner" }));
  btn.appendChild(document.createTextNode(" Exporting…"));
  // One calm line covers the whole Reading → Sending progression (decision #10).
  setStatus("Saving files to your folder…", "progress");
}

/** Leave the exporting state and restore the ready controls. */
function endExporting(): void {
  busy = false;
  controlsEl.classList.remove("dimmed");
  renderSelection();
}

function startExport(): void {
  if (!selection[0] || busy) return;
  clearErrors();
  enterExporting();
  parent.postMessage(
    {
      pluginMessage: {
        type: "export",
        resolveRemote: resolveRemoteEl.checked,
        outputDir: outputDirEl.value.trim(),
        endpoint: endpointEl.value.trim(),
      },
    },
    "*",
  );
}
btn.onclick = startExport;

/** The outcome of encoding one node's previews and POSTing it to the server. */
interface PostResult {
  ok: boolean;
  body: SyncResponse;
  iconCount: number;
  imageCount: number;
  /** The server couldn't be reached at all (network failure). */
  unreachable?: boolean;
  /** The server rejected the destination output folder. */
  folderError?: boolean;
}

/** Encode a node's SVG/PNG/icon bytes into the payload and POST it to the
 * server. Shared by the single-node and batch paths so they stay in step. */
async function postPayload(
  payload: ExportPayload,
  svgBytes: Uint8Array | null,
  pngBytes: Uint8Array | null,
  icons: { name: string; bytes: Uint8Array }[],
  images: { imageHash: string; name: string; bytes: Uint8Array }[],
): Promise<PostResult> {
  const assets: AssetFile[] = [];

  if (svgBytes) {
    const raw = new TextDecoder().decode(svgBytes);
    // Pull raster images out to files (keeping the SVG small); the server writes
    // a preview.html that inlines the SVG so those external images still render.
    const { svg, assets: images } = externalizeSvgImages(raw);
    payload.svg = svg;
    assets.push(...images);
  }
  if (pngBytes) payload.png = bytesToBase64(pngBytes);

  // Vector icons from the node-walk share the same preview.assets/ folder.
  for (const icon of icons ?? []) {
    assets.push({ name: icon.name, base64: bytesToBase64(icon.bytes) });
  }
  if (assets.length) payload.assets = assets;

  // Original-bytes images behind IMAGE fills, matchable to nodes by imageHash;
  // written to images/ (distinct from the preview-only assets above).
  if (images?.length) {
    payload.images = images.map((img) => ({
      imageHash: img.imageHash,
      name: img.name,
      base64: bytesToBase64(img.bytes),
    }));
  }

  const iconCount = assets.filter((a) => a.name.endsWith(".svg")).length;
  const imageCount = assets.length - iconCount;

  try {
    const res = await fetch(endpointEl.value.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setConnection("ok");
    const body = (await res.json().catch(() => ({}))) as SyncResponse;
    return {
      ok: res.ok,
      body,
      iconCount,
      imageCount,
      folderError: !res.ok && /output folder/i.test(body.error ?? ""),
    };
  } catch {
    setConnection("down");
    return { ok: false, body: {}, iconCount, imageCount, unreachable: true };
  }
}

/** One-line failure reason for a batch row. */
function batchError(result: PostResult): string {
  if (result.unreachable) return "server unreachable";
  return result.body.error || "export failed";
}

/** One-line "142 layers · 8 components" stat for a successful batch row. */
function batchStat(r: BatchResult): string {
  const layers = r.layers ?? 0;
  const parts = [`${layers} layer${layers === 1 ? "" : "s"}`];
  if (r.components && r.components > 0) {
    parts.push(`${r.components} component${r.components === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** Strip the trailing `/node-name` segment to get the parent `<fileKey>/` dir
 * that every node folder in the batch was written under. */
function parentDir(nodePath: string): string {
  return nodePath.replace(/[\\/][^\\/]+[\\/]?$/, "") || nodePath;
}

/** Compact end-of-run summary for a batch: one row per node (name · ✓/✗ ·
 * stat or failure reason), a single Open-folder to the parent dir, and
 * Export another. */
function renderBatchSummary(results: BatchResult[]): void {
  resultEl.textContent = "";
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;

  resultEl.appendChild(
    el("div", { class: "r-head" }, [
      el("span", { class: "r-tick", text: failed === 0 ? "✓" : "⚠" }),
      el("span", { text: `Exported ${ok} of ${results.length}` }),
    ]),
  );

  const list = el("div", { class: "batch-list" });
  for (const r of results) {
    const row = el("div", { class: "batch-row" + (r.ok ? "" : " fail") }, [
      el("span", { class: "batch-mark " + (r.ok ? "ok" : "fail"), text: r.ok ? "✓" : "✗" }),
      el("span", { class: "batch-name", text: r.name }),
      el("span", { class: "batch-stat", text: r.ok ? batchStat(r) : r.error || "export failed" }),
    ]);
    list.appendChild(row);
  }
  resultEl.appendChild(list);

  // One Open-folder → the shared parent dir where all node folders live.
  const written = results.find((r) => r.ok && r.path)?.path;
  const actions = el("div", { class: "actions" });
  if (written) {
    const dir = parentDir(written);
    const openBtn = el("button", { class: "mini", text: "Open folder" }) as HTMLButtonElement;
    openBtn.onclick = () => void openPath(dir, openBtn);
    actions.appendChild(openBtn);
  }
  const anotherBtn = el("button", { class: "mini", text: "Export another" }) as HTMLButtonElement;
  anotherBtn.onclick = resetToReady;
  actions.appendChild(anotherBtn);
  resultEl.appendChild(actions);

  resultEl.className = "show";
}

window.onmessage = async (event: MessageEvent) => {
  const msg = event.data.pluginMessage as FromPlugin | undefined;
  if (!msg) return;

  if (msg.type === "settings") {
    if (msg.outputDir) outputDirEl.value = msg.outputDir;
    if (msg.endpoint) endpointEl.value = msg.endpoint;
    return;
  }
  if (msg.type === "selection") {
    selection = msg.nodes;
    if (!busy) clearErrors();
    renderSelection();
    return;
  }
  if (msg.type === "progress") {
    // Ignore the granular technical text; the calm exporting line already shows.
    return;
  }
  if (msg.type === "error") {
    endExporting();
    showExportFailed();
    return;
  }
  if (msg.type === "batch-progress") {
    // A fresh batch starts at node 1 — reset the accumulator.
    if (msg.index === 1) batchResults = [];
    setStatus(`Exporting ${msg.index} of ${msg.total}…`, "progress");
    return;
  }
  if (msg.type === "batch-item") {
    const result = await postPayload(msg.payload, msg.svgBytes, msg.pngBytes, msg.icons, msg.images);
    const summary = msg.payload.summary;
    batchResults.push({
      name: msg.name,
      ok: result.ok,
      error: result.ok ? undefined : batchError(result),
      path: result.ok ? result.body.path : undefined,
      layers: summary.totalNodes,
      components: summary.components.total,
    });
    // Tell the plugin this node is written so it can release it and serialize
    // the next — always, even on failure, or the batch loop would stall.
    parent.postMessage({ pluginMessage: { type: "batch-ack" } }, "*");
    return;
  }
  if (msg.type === "batch-fail") {
    // Serialization itself failed — no POST happened.
    batchResults.push({ name: msg.name, ok: false, error: msg.error });
    return;
  }
  if (msg.type === "batch-done") {
    endExporting();
    setStatus("");
    renderBatchSummary(batchResults);
    return;
  }
  if (msg.type !== "result") return;

  const result = await postPayload(msg.payload, msg.svgBytes, msg.pngBytes, msg.icons, msg.images);
  endExporting();
  if (result.ok) {
    clearErrors();
    setStatus("");
    renderReport(msg.payload.summary, {
      path: result.body.path || "written",
      previewPath: result.body.preview,
      iconCount: result.iconCount,
      imageCount: result.imageCount,
    });
  } else if (result.unreachable) {
    // Network-level failure: the server couldn't be reached at all.
    showServerUnreachable();
  } else if (result.folderError) {
    // The server reached us but rejected the destination folder.
    showFolderNotFound();
  } else {
    showExportFailed();
  }
};
