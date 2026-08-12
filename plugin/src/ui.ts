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
  PreviewFormat,
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
      library: boolean;
    };

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = byId<HTMLDivElement>("status");
const resultEl = byId<HTMLDivElement>("result");
const btn = byId<HTMLButtonElement>("export");
const outputDirEl = byId<HTMLInputElement>("outputDir");
const browseEl = byId<HTMLButtonElement>("browse");
const endpointEl = byId<HTMLInputElement>("endpoint");
const skipPreviewEl = byId<HTMLButtonElement>("skipPreview");
const resolveRemoteEl = byId<HTMLInputElement>("resolveRemote");
const previewSegs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".seg[data-preview]"),
);
const outputSegs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".seg[data-output]"),
);

let selection: SelectionNode[] = [];
let busy = false;
// Preview: Vector (SVG) | Image (PNG), with Skip (NONE) as a quiet secondary.
let previewFormat: PreviewFormat = "SVG";
// Output: a folder of assets (library on) vs a single self-contained SVG file.
let outputMode: "folder" | "single" = "folder";

function setStatus(text: string, cls: "" | "err" | "progress" = ""): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// --- segmented controls -------------------------------------------------
function renderPreviewChoice(): void {
  for (const seg of previewSegs) {
    seg.setAttribute("aria-pressed", String(seg.dataset.preview === previewFormat));
  }
  const skipped = previewFormat === "NONE";
  skipPreviewEl.classList.toggle("on", skipped);
  skipPreviewEl.textContent = skipped ? "Preview skipped" : "Export without a preview";
}

for (const seg of previewSegs) {
  seg.onclick = () => {
    previewFormat = (seg.dataset.preview as PreviewFormat) ?? "SVG";
    renderPreviewChoice();
  };
}
skipPreviewEl.onclick = () => {
  // Toggle skip; leaving skip returns to the default Vector preview.
  previewFormat = previewFormat === "NONE" ? "SVG" : "NONE";
  renderPreviewChoice();
};

function renderOutputChoice(): void {
  for (const seg of outputSegs) {
    seg.setAttribute("aria-pressed", String(seg.dataset.output === outputMode));
  }
}
for (const seg of outputSegs) {
  seg.onclick = () => {
    outputMode = seg.dataset.output === "single" ? "single" : "folder";
    renderOutputChoice();
  };
}

renderPreviewChoice();
renderOutputChoice();

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

/** The plain-language "what was written" line, adapting to the Output choice. */
function wroteLine(ctx: ReportContext, s: ExportSummary): HTMLElement {
  const name = s.target.name;
  if (ctx.outputMode === "single") {
    return plainLine([
      { text: "Saved your " },
      { text: name, bold: true },
      { text: " as a " },
      { text: "single SVG file", bold: true },
      { text: " — everything bundled into one file." },
    ]);
  }
  const tail: string[] = [];
  if (s.preview.produced) tail.push("a preview you can open");
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
  const previewLabel = s.preview.skipped
    ? "skipped"
    : s.preview.produced
      ? s.preview.format.toLowerCase()
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

    if (s.remoteMasterErrors.length) {
      const list = el("div", { class: "unresolved-list" });
      const shown = s.remoteMasterErrors.slice(0, 30);
      for (const e of shown) {
        list.appendChild(
          el("div", { class: "error-item" }, [
            el("span", { class: "error-name", text: e.name }),
            el("span", { class: "error-msg", text: e.error }),
          ]),
        );
      }
      const extra = s.remoteMasterErrors.length - shown.length;
      if (extra > 0) list.appendChild(el("div", { class: "error-msg", text: `+${extra} more…` }));
      linked.appendChild(list);
    }

    wrap.appendChild(section("Linked components", linked));
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

/** Ask the server to reveal a folder / open a file (the plugin iframe can't). */
async function openPath(target: string, trigger: HTMLButtonElement): Promise<void> {
  const original = trigger.textContent;
  trigger.disabled = true;
  try {
    const res = await fetch(`${serverBase()}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    const body = (await res.json().catch(() => ({}))) as OpenResponse;
    if (!res.ok) setStatus(body.error || "Could not open that.", "err");
  } catch (err) {
    setStatus(`Could not reach the server to open that.\n${String(err)}`, "err");
  } finally {
    trigger.disabled = false;
    trigger.textContent = original;
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
  outputMode: "folder" | "single";
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

  if (s.truncated) {
    resultEl.appendChild(
      el("div", {
        class: "warn-note",
        text: `⚠ Selection too large — truncated at ${s.truncatedAt} nodes. Export a smaller frame for a complete tree.`,
      }),
    );
  }
  if (s.preview.skipped) {
    resultEl.appendChild(
      el("div", {
        class: "warn-note",
        text: "⚠ SVG preview skipped (tree too large). Try PNG instead.",
      }),
    );
  }

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
  const selName = byId<HTMLDivElement>("selName");
  const selMeta = byId<HTMLDivElement>("selMeta");
  const selThumb = byId<HTMLDivElement>("selThumb");
  if (!first) {
    selName.textContent = "Nothing selected";
    selMeta.textContent = "Select a layer on the canvas.";
    selThumb.textContent = "–";
  } else {
    const extra = selection.length - 1;
    selName.textContent = first.name;
    selMeta.textContent =
      typeLabel(first.type) + (extra > 0 ? ` · +${extra} more (first is exported)` : "");
    selThumb.textContent = (first.name.trim()[0] ?? "?").toUpperCase();
  }
  if (busy) return;
  btn.disabled = !first;
  btn.textContent = first ? `Export “${first.name}”` : "Select something to export";
}

/** Derive the server base (e.g. http://localhost:3579) from the endpoint field. */
function serverBase(): string {
  return endpointEl.value.trim().replace(/\/sync\/?$/, "");
}

browseEl.onclick = async () => {
  const original = browseEl.textContent;
  browseEl.disabled = true;
  browseEl.textContent = "Choosing…";
  setStatus("Opening folder picker — look for a system dialog…", "progress");
  try {
    const res = await fetch(`${serverBase()}/pick-folder`);
    const body = (await res.json().catch(() => ({}))) as PickFolderResponse;
    if (body.path) {
      outputDirEl.value = body.path;
      setStatus("");
    } else if (body.cancelled) {
      setStatus("");
    } else {
      setStatus(body.error || "Folder picker failed.", "err");
    }
  } catch (err) {
    setStatus(`Could not reach the server for the picker.\n${String(err)}`, "err");
  } finally {
    browseEl.disabled = false;
    browseEl.textContent = original;
  }
};

btn.onclick = () => {
  if (!selection[0]) return;
  busy = true;
  btn.disabled = true;
  resultEl.className = "";
  setStatus("Reading document…", "progress");
  parent.postMessage(
    {
      pluginMessage: {
        type: "export",
        preview: previewFormat,
        resolveRemote: resolveRemoteEl.checked,
        library: outputMode === "folder",
        outputDir: outputDirEl.value.trim(),
        endpoint: endpointEl.value.trim(),
      },
    },
    "*",
  );
};

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
    renderSelection();
    return;
  }
  if (msg.type === "progress") {
    setStatus(msg.message, "progress");
    return;
  }
  if (msg.type === "error") {
    setStatus(msg.message, "err");
    busy = false;
    renderSelection();
    return;
  }
  if (msg.type !== "result") return;

  const payload = msg.payload;
  const assets: AssetFile[] = [];

  if (msg.svgBytes) {
    const raw = new TextDecoder().decode(msg.svgBytes);
    // With the library on, pull raster images out to files (small SVG + a
    // preview.html wrapper on the server side); otherwise keep it self-contained.
    if (msg.library) {
      const { svg, assets: images } = externalizeSvgImages(raw);
      payload.svg = svg;
      assets.push(...images);
    } else {
      payload.svg = raw;
    }
  }
  if (msg.pngBytes) payload.png = bytesToBase64(msg.pngBytes);

  // Vector icons from the node-walk share the same preview.assets/ folder.
  for (const icon of msg.icons ?? []) {
    assets.push({ name: icon.name, base64: bytesToBase64(icon.bytes) });
  }
  if (assets.length) payload.assets = assets;

  const iconCount = assets.filter((a) => a.name.endsWith(".svg")).length;
  const imageCount = assets.length - iconCount;

  setStatus("Sending to server…", "progress");
  try {
    const res = await fetch(endpointEl.value.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as SyncResponse;
    if (res.ok) {
      setStatus("");
      renderReport(payload.summary, {
        path: body.path || "written",
        previewPath: body.preview,
        outputMode,
        iconCount,
        imageCount,
      });
    } else {
      setStatus(`Server ${res.status}: ${body.error || "write failed"}`, "err");
    }
  } catch (err) {
    setStatus(
      `Could not reach the server. Is it running on the endpoint above?\n${String(err)}`,
      "err",
    );
  } finally {
    busy = false;
    renderSelection();
  }
};
