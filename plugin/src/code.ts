// Figma plugin main thread. Drives the export core (export-node.ts) for the
// selection and hands each typed payload to the UI, which POSTs it to the local
// figma-export server. Runs in the Figma sandbox (no `fetch`).
import { type AnyNode, exportNode, slugName } from "./export-node";

const SETTINGS_KEY = "figma-export/settings";
const DEFAULT_ENDPOINT = "http://localhost:3579/sync";

interface Settings {
  outputDir: string;
  endpoint: string;
}

figma.showUI(__html__, { width: 380, height: 620 });

function postSelection(): void {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "selection",
    nodes: selection.map((node) => ({ id: node.id, name: node.name, type: node.type })),
  });
}

async function loadSettings(): Promise<Settings> {
  const saved = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Partial<Settings> | undefined;
  return {
    outputDir: saved?.outputDir ?? "",
    endpoint: saved?.endpoint ?? DEFAULT_ENDPOINT,
  };
}

interface ExportMessage {
  type: "export";
  resolveRemote: boolean;
  outputDir: string;
  endpoint: string;
}

/** A short, path-safe suffix derived from a node id, to disambiguate colliding
 * folder names (e.g. "123:456" -> "3456"). */
function shortNodeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.slice(-4) || cleaned || "id";
}

/** Assign a collision-free on-disk folder name to each batch node. The first
 * node with a given (slugged) name keeps the bare name; each later same-named
 * node gets a short node-id suffix. Returns node.id -> folder name only for the
 * disambiguated ones, so unique names fall through to the server's default. */
function batchFolderNames(targets: AnyNode[]): Map<string, string> {
  const taken = new Set<string>();
  const overrides = new Map<string, string>();
  for (const node of targets) {
    const base = slugName(node.name, "node");
    if (!taken.has(base)) {
      taken.add(base);
      continue; // bare name is free — server derives it from nodeName
    }
    let candidate = `${base}-${shortNodeId(node.id)}`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${shortNodeId(node.id)}-${n}`;
    taken.add(candidate);
    overrides.set(node.id, candidate);
  }
  return overrides;
}

/** Drop any selected node that lives inside another selected node — its content
 * is already captured by the ancestor's export (de-nest). */
function deNest(nodes: AnyNode[]): AnyNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.filter((node) => {
    let parent = node.parent;
    while (parent) {
      if (ids.has(parent.id)) return false;
      parent = parent.parent;
    }
    return true;
  });
}

// Batch export serializes one node at a time and waits for the UI to POST it
// before moving on (serialize → write → release → next). This resolver bridges
// that wait: it's fulfilled when the UI acknowledges a written node.
let resolveBatchAck: (() => void) | null = null;

function waitForBatchAck(): Promise<void> {
  return new Promise((resolve) => {
    resolveBatchAck = resolve;
  });
}

/** Run the export for the current selection: single node keeps today's report;
 * 2+ nodes stream sequentially, best-effort, each to its own folder. */
async function handleExport(msg: ExportMessage): Promise<void> {
  await figma.clientStorage.setAsync(SETTINGS_KEY, {
    outputDir: msg.outputDir,
    endpoint: msg.endpoint,
  } satisfies Settings);

  const targets = deNest([...figma.currentPage.selection] as AnyNode[]);
  if (targets.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message: "Nothing selected. Select a layer on the canvas, then Export.",
    });
    return;
  }

  const exportOne = async (target: AnyNode) => {
    const out = await exportNode(target, {
      resolveRemote: msg.resolveRemote,
      onProgress: (message) => figma.ui.postMessage({ type: "progress", message }),
    });
    out.payload.outputDir = msg.outputDir;
    return out;
  };

  if (targets.length === 1) {
    const out = await exportOne(targets[0]);
    figma.ui.postMessage({
      type: "result",
      payload: out.payload,
      svgBytes: out.svgBytes,
      pngBytes: out.pngBytes,
      icons: out.icons,
      images: out.images,
    });
    return;
  }

  // 2+ nodes: serialize → hand to UI → wait for it to write → release → next.
  // A single node failing never discards the rest (best-effort). Same-named
  // nodes get collision-free folder names so they don't overwrite each other.
  const folderNames = batchFolderNames(targets);
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    figma.ui.postMessage({
      type: "batch-progress",
      index: i + 1,
      total: targets.length,
    });
    try {
      const out = await exportOne(target);
      const folderName = folderNames.get(target.id);
      if (folderName) out.payload.folderName = folderName;
      figma.ui.postMessage({
        type: "batch-item",
        name: target.name,
        payload: out.payload,
        svgBytes: out.svgBytes,
        pngBytes: out.pngBytes,
        icons: out.icons,
        images: out.images,
      });
      await waitForBatchAck();
    } catch (err) {
      figma.ui.postMessage({
        type: "batch-fail",
        name: target.name,
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  figma.ui.postMessage({ type: "batch-done" });
}

type UiToPlugin = ExportMessage | { type: "batch-ack" };

figma.on("selectionchange", postSelection);

(async () => {
  const settings = await loadSettings();
  figma.ui.postMessage({ type: "settings", ...settings });
  postSelection();
})();

figma.ui.onmessage = async (msg: UiToPlugin) => {
  if (msg.type === "batch-ack") {
    const resolve = resolveBatchAck;
    resolveBatchAck = null;
    resolve?.();
    return;
  }
  if (msg.type !== "export") return;

  try {
    await handleExport(msg);
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: String((err as Error)?.message ?? err) });
  }
};
