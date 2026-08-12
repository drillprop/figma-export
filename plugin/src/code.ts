// Figma plugin main thread. Serializes the selected node's subtree, gathers the
// components it uses (resolving remote/library masters by key), renders an
// optional SVG/PNG preview, and hands a typed payload to the UI, which POSTs it
// to the local figma-export server. Runs in the Figma sandbox (no `fetch`).
import type {
  ComponentEntry,
  ExportPayload,
  ExportSummary,
  PreviewFormat,
  SerializedNode,
  VariantAxes,
  VariantValues,
} from "../../src/shared/types";

// Guardrails against out-of-memory tab crashes on very large selections.
const MAX_NODES = 40000; // stop serializing past this; mark the export truncated
const MAX_SVG_NODES = 6000; // skip the SVG preview for trees larger than this
const MAX_MASTER_NODES = 5000; // per remote-master serialization cap

const SETTINGS_KEY = "figma-export/settings";
const DEFAULT_ENDPOINT = "http://localhost:3579/sync";

interface Settings {
  outputDir: string;
  endpoint: string;
}

interface SerializeCtx {
  count: number;
  cap: number;
  truncated: boolean;
}

// biome-ignore lint: dynamic Figma node access is inherently untyped here.
type AnyNode = any;

figma.showUI(__html__, { width: 380, height: 620 });

/** Fields copied verbatim off a node when present. `figma.mixed` becomes "MIXED". */
const NODE_FIELDS = [
  "id", "name", "type", "visible", "locked", "opacity", "blendMode", "isMask",
  "x", "y", "width", "height", "rotation", "absoluteBoundingBox", "constraints",
  "fills", "strokes", "strokeWeight", "strokeAlign", "effects", "cornerRadius",
  "rectangleCornerRadii", "backgrounds",
  "layoutMode", "layoutWrap", "layoutGrow", "layoutAlign", "layoutSizingHorizontal",
  "layoutSizingVertical", "primaryAxisSizingMode", "counterAxisSizingMode",
  "primaryAxisAlignItems", "counterAxisAlignItems", "itemSpacing", "counterAxisSpacing",
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "characters", "fontSize", "fontName", "fontWeight", "letterSpacing", "lineHeight",
  "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration", "textAutoResize",
  "componentPropertyDefinitions", "componentProperties", "variantProperties",
  "boundVariables",
];

function pickFields(node: AnyNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of NODE_FIELDS) {
    if (!(key in node)) continue;
    let value: unknown;
    try {
      value = node[key];
    } catch {
      continue;
    }
    if (value === figma.mixed) value = "MIXED";
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Parse "Style=Primary, Size=md" -> { Style: "Primary", Size: "md" }. */
function parseVariantValues(name: string | undefined): VariantValues | null {
  if (!name?.includes("=")) return null;
  const values: VariantValues = {};
  for (const part of name.split(",")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey.trim();
    const value = rest.join("=").trim();
    if (key && value) values[key] = value;
  }
  return Object.keys(values).length > 0 ? values : null;
}

/** Read a getter that may throw or be absent; returns undefined instead. */
function tryRead(node: AnyNode, key: string): unknown {
  try {
    const value = node[key];
    return value === figma.mixed ? "MIXED" : value;
  } catch {
    return undefined;
  }
}

/** Derive a component set's variant axes from its children names. */
function deriveVariantAxes(setNode: AnyNode): VariantAxes | null {
  const axes: VariantAxes = {};
  for (const child of setNode.children) {
    const values = parseVariantValues(child.name);
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      (axes[key] ??= []);
      if (!axes[key].includes(value)) axes[key].push(value);
    }
  }
  return Object.keys(axes).length > 0 ? axes : null;
}

/** Recursively serialize a node, bounded by `ctx.cap` (OOM guard). */
async function serialize(node: AnyNode, ctx: SerializeCtx): Promise<SerializedNode> {
  ctx.count += 1;
  if (ctx.count > ctx.cap) {
    ctx.truncated = true;
    return { id: node.id, name: node.name, type: node.type, truncated: true };
  }

  const data = pickFields(node) as SerializedNode;

  if (node.type === "COMPONENT_SET") {
    const defs = tryRead(node, "componentPropertyDefinitions");
    if (defs) data.componentPropertyDefinitions = defs;
    const axes = deriveVariantAxes(node);
    if (axes) data.variantProperties = axes;
  }

  if (node.type === "COMPONENT") {
    const values = parseVariantValues(node.name);
    if (values) data.variantValues = values;
    const defs = tryRead(node, "componentPropertyDefinitions") as Record<string, unknown> | undefined;
    if (defs && Object.keys(defs).length > 0) data.componentPropertyDefinitions = defs;
  }

  if (node.type === "INSTANCE") {
    const props = tryRead(node, "componentProperties");
    if (props) data.componentProperties = props;
    try {
      const main = await node.getMainComponentAsync();
      if (main) {
        data.mainComponentId = main.id;
        data.mainComponentName = main.name;
        data.mainComponentKey = main.key;
      }
    } catch {
      /* detached or unresolved instance */
    }
  }

  if ("children" in node) {
    const children: SerializedNode[] = [];
    for (const child of node.children) children.push(await serialize(child, ctx));
    data.children = children;
  }
  return data;
}

function addComponent(map: Map<string, ComponentEntry>, node: AnyNode): void {
  if (map.has(node.id)) return;
  const entry: ComponentEntry = {
    id: node.id,
    name: node.name,
    key: node.key || null,
    type: node.type,
    description: node.description || "",
    remote: Boolean(node.remote),
    componentSetId:
      node.parent && node.parent.type === "COMPONENT_SET" ? node.parent.id : null,
  };
  const variantValues = parseVariantValues(node.name);
  if (variantValues) entry.variantValues = variantValues;
  map.set(node.id, entry);
}

/** Collect the unique components (and sets) used under a node. */
async function collectComponents(root: AnyNode): Promise<ComponentEntry[]> {
  const found = new Map<string, ComponentEntry>();

  const consider = async (node: AnyNode) => {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      addComponent(found, node);
    } else if (node.type === "INSTANCE") {
      try {
        const main = await node.getMainComponentAsync();
        if (main) addComponent(found, main);
      } catch {
        /* skip */
      }
    }
  };

  await consider(root);
  let nodes: AnyNode[] = [];
  try {
    nodes = root.findAllWithCriteria({ types: ["INSTANCE", "COMPONENT", "COMPONENT_SET"] });
  } catch {
    const walk = (n: AnyNode) => {
      nodes.push(n);
      if ("children" in n) n.children.forEach(walk);
    };
    if ("children" in root) root.children.forEach(walk);
  }
  for (const n of nodes) await consider(n);

  return [...found.values()];
}

/** Import remote (library) masters by key so their full definitions are captured. */
async function resolveRemoteMasters(
  components: ComponentEntry[],
  onProgress: (message: string) => void,
): Promise<SerializedNode[]> {
  const masters: SerializedNode[] = [];
  const serializedSets = new Set<string>();
  const remotes = components.filter((c) => c.remote && c.key);

  let done = 0;
  for (const entry of remotes) {
    done += 1;
    onProgress(`Importing remote masters ${done}/${remotes.length}…`);
    try {
      const imported: AnyNode =
        entry.type === "COMPONENT_SET"
          ? await figma.importComponentSetByKeyAsync(entry.key as string)
          : await figma.importComponentByKeyAsync(entry.key as string);

      entry.masterName = imported.name;
      if (imported.description) entry.description = imported.description;

      const defs = tryRead(imported, "componentPropertyDefinitions") as
        | Record<string, unknown>
        | undefined;
      if (defs && Object.keys(defs).length > 0) entry.componentPropertyDefinitions = defs;

      const set: AnyNode | null =
        imported.parent && imported.parent.type === "COMPONENT_SET"
          ? imported.parent
          : imported.type === "COMPONENT_SET"
            ? imported
            : null;

      if (set) {
        entry.setName = set.name;
        entry.setKey = set.key;
        const axes = deriveVariantAxes(set);
        if (axes) entry.variantProperties = axes;
        if (!serializedSets.has(set.key)) {
          serializedSets.add(set.key);
          masters.push(await serialize(set, { count: 0, cap: MAX_MASTER_NODES, truncated: false }));
        }
      } else {
        masters.push(await serialize(imported, { count: 0, cap: MAX_MASTER_NODES, truncated: false }));
      }
    } catch (err) {
      entry.masterError = String((err as Error)?.message ?? err);
    }
  }
  return masters;
}

/** Export settings for a PNG preview, bounding resolution so the raster stays small. */
function pngSettings(node: AnyNode): ExportSettings {
  const maxSide = 2048;
  const width = "width" in node ? node.width : 0;
  if (width > maxSide) {
    return { format: "PNG", constraint: { type: "WIDTH", value: maxSide } };
  }
  return { format: "PNG", constraint: { type: "SCALE", value: 2 } };
}

// --- typed asset library ------------------------------------------------
const MAX_ASSETS = 500; // stop extracting past this (huge trees / OOM guard)
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "COMPONENT", "INSTANCE", "COMPONENT_SET"]);

/** A file destined for preview.assets/. Bytes are base64-encoded later, in the UI. */
interface RawAsset {
  name: string;
  kind: "png" | "svg";
  bytes: Uint8Array;
}

/** Keep an untrusted node name to a safe, readable single path segment. */
function slugName(value: unknown, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** The first visible IMAGE paint's hash, or null when the node has no image fill. */
function imageHashOf(node: AnyNode): string | null {
  const fills = tryRead(node, "fills");
  if (!Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill && fill.type === "IMAGE" && fill.visible !== false) return fill.imageHash ?? "image";
  }
  return null;
}

/** True when the subtree is vector-only: no TEXT and no image fills anywhere.
 * Invisible descendants are ignored (they don't render into the icon). */
function isVectorOnly(node: AnyNode): boolean {
  if (node.visible === false) return true;
  if (node.type === "TEXT") return false;
  if (imageHashOf(node) !== null) return false;
  if (Array.isArray(node.children)) {
    for (const child of node.children) if (!isVectorOnly(child)) return false;
  }
  return true;
}

/** The dedup key + readable name for an icon (main component identity). */
async function iconIdentity(node: AnyNode): Promise<{ key: string; name: string }> {
  if (node.type === "COMPONENT") return { key: node.key || node.id, name: node.name };
  if (node.type === "INSTANCE") {
    try {
      const main = await node.getMainComponentAsync();
      if (main) return { key: main.key || main.id, name: main.name };
    } catch {
      /* detached / unresolved */
    }
  }
  return { key: node.id, name: node.name };
}

/**
 * Walk the tree and extract a typed asset library. Each node is classified:
 * raster (image fill) → PNG, icon (vector-only component/instance) → SVG, else
 * descend. Shape nodes stop the walk; a container with an image background is
 * still exported but its children are traversed (so icons on a photo survive).
 * Deduped by image hash / component key; invisible and zero-area nodes skipped.
 */
async function collectAssets(root: AnyNode): Promise<RawAsset[]> {
  const assets: RawAsset[] = [];
  const seen = new Set<string>(); // dedup keys: "img:<hash>" / "icon:<key>"
  const usedNames = new Set<string>();

  const uniqueName = (base: string, ext: string): string => {
    let name = `${base}.${ext}`;
    for (let i = 2; usedNames.has(name); i++) name = `${base}-${i}.${ext}`;
    usedNames.add(name);
    return name;
  };

  const walk = async (node: AnyNode): Promise<void> => {
    if (!node || node.visible === false || assets.length >= MAX_ASSETS) return;
    const width = tryRead(node, "width");
    const height = tryRead(node, "height");
    if ((typeof width === "number" && width <= 0) || (typeof height === "number" && height <= 0)) {
      return;
    }

    const hash = imageHashOf(node);
    if (hash !== null && "exportAsync" in node) {
      const isContainer = CONTAINER_TYPES.has(node.type);
      if (!seen.has(`img:${hash}`)) {
        seen.add(`img:${hash}`);
        try {
          const bytes = (await node.exportAsync(pngSettings(node))) as Uint8Array;
          assets.push({ name: uniqueName(slugName(node.name, "img"), "png"), kind: "png", bytes });
        } catch (err) {
          console.warn(`[figma-export] PNG asset export failed for "${node.name}":`, err);
        }
      }
      if (!isContainer) return; // shape node: stop; container: fall through to descend
    } else if (
      (node.type === "COMPONENT" || node.type === "INSTANCE") &&
      "exportAsync" in node &&
      isVectorOnly(node)
    ) {
      const { key, name } = await iconIdentity(node);
      if (!seen.has(`icon:${key}`)) {
        seen.add(`icon:${key}`);
        try {
          const bytes = (await node.exportAsync({ format: "SVG" })) as Uint8Array;
          assets.push({ name: uniqueName(slugName(name, "icon"), "svg"), kind: "svg", bytes });
        } catch (err) {
          console.warn(`[figma-export] SVG asset export failed for "${name}":`, err);
        }
      }
      return; // icon: stop descending
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) await walk(child);
    }
  };

  await walk(root);
  return assets;
}

/** Build a human/AI-readable summary of what an export contains. */
function summarize(
  node: SerializedNode,
  components: ComponentEntry[],
  remoteMasters: SerializedNode[],
): ExportSummary {
  const nodeTypes: Record<string, number> = {};
  const textSamples: string[] = [];
  let totalNodes = 0;

  const walk = (n: SerializedNode) => {
    totalNodes += 1;
    nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1;
    if (n.type === "TEXT" && typeof n.characters === "string") {
      const text = n.characters.trim().replace(/\s+/g, " ");
      if (text && textSamples.length < 15) {
        textSamples.push(text.length > 60 ? `${text.slice(0, 60)}…` : text);
      }
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);

  const setsByName: Record<string, VariantAxes> = {};
  for (const c of components) {
    if (c.type === "COMPONENT_SET" && c.variantProperties) setsByName[c.name] = c.variantProperties;
    else if (c.setName && c.variantProperties) setsByName[c.setName] = c.variantProperties;
  }
  const sets = Object.entries(setsByName).map(([name, axes]) => ({ name, axes }));
  const remote = components.filter((c) => c.remote);

  return {
    target: { id: node.id, name: node.name, type: node.type },
    totalNodes,
    nodeTypes,
    textLayerCount: nodeTypes.TEXT ?? 0,
    textSamples,
    components: {
      total: components.length,
      local: components.length - remote.length,
      remote: remote.length,
    },
    sets,
    remoteMastersResolved: remoteMasters.length,
    remoteMasterErrors: remote
      .filter((c) => c.masterError)
      .map((c) => ({ name: c.name, error: c.masterError as string })),
    truncated: false,
    truncatedAt: null,
    preview: { format: "NONE", skipped: false, produced: false },
  };
}

/** File key for output naming; falls back to the file name when unavailable. */
function currentFileKey(): string {
  const key = tryRead(figma, "fileKey");
  return (typeof key === "string" && key) || figma.root.name || "current";
}

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
  preview: PreviewFormat;
  resolveRemote: boolean;
  library: boolean;
  outputDir: string;
  endpoint: string;
}

figma.on("selectionchange", postSelection);

(async () => {
  const settings = await loadSettings();
  figma.ui.postMessage({ type: "settings", ...settings });
  postSelection();
})();

figma.ui.onmessage = async (msg: ExportMessage) => {
  if (msg.type !== "export") return;

  try {
    await figma.clientStorage.setAsync(SETTINGS_KEY, {
      outputDir: msg.outputDir,
      endpoint: msg.endpoint,
    } satisfies Settings);

    const target = figma.currentPage.selection[0] as AnyNode | undefined;
    if (!target) {
      figma.ui.postMessage({
        type: "error",
        message: "Nothing selected. Select a layer on the canvas, then Export.",
      });
      return;
    }

    figma.ui.postMessage({ type: "progress", message: `Serializing "${target.name}"…` });

    const ctx: SerializeCtx = { count: 0, cap: MAX_NODES, truncated: false };
    const node = await serialize(target, ctx);
    console.log(`[figma-export] serialized ${ctx.count} nodes from "${target.name}"`);
    if (ctx.truncated) {
      console.warn(`[figma-export] truncated at ${MAX_NODES} nodes (selection too large)`);
    }

    const components = await collectComponents(target);
    console.log(`[figma-export] collected ${components.length} components`);

    let remoteMasters: SerializedNode[] = [];
    if (msg.resolveRemote) {
      remoteMasters = await resolveRemoteMasters(components, (message) =>
        figma.ui.postMessage({ type: "progress", message }),
      );
    }

    const format: PreviewFormat =
      msg.preview === "PNG" || msg.preview === "SVG" ? msg.preview : "NONE";
    let svgBytes: Uint8Array | null = null;
    let pngBytes: Uint8Array | null = null;
    let previewSkipped = false;

    if (format !== "NONE" && "exportAsync" in target) {
      if (format === "SVG" && ctx.count > MAX_SVG_NODES) {
        previewSkipped = true;
      } else {
        try {
          svgBytes =
            format === "SVG" ? await target.exportAsync({ format: "SVG" }) : null;
          pngBytes =
            format === "PNG" ? await target.exportAsync(pngSettings(target)) : null;
        } catch (err) {
          console.warn(`[figma-export] ${format} preview failed:`, err);
        }
      }
    }

    let assets: RawAsset[] = [];
    if (msg.library && "exportAsync" in target) {
      figma.ui.postMessage({ type: "progress", message: "Extracting typed assets…" });
      assets = await collectAssets(target);
      console.log(`[figma-export] extracted ${assets.length} typed asset(s)`);
    }

    const summary = summarize(node, components, remoteMasters);
    summary.truncated = ctx.truncated;
    summary.truncatedAt = ctx.truncated ? MAX_NODES : null;
    summary.preview = { format, skipped: previewSkipped, produced: Boolean(svgBytes || pngBytes) };

    const payload: ExportPayload = {
      outputDir: msg.outputDir,
      fileKey: currentFileKey(),
      fileName: figma.root.name,
      nodeId: target.id,
      nodeName: target.name,
      exportedAt: new Date().toISOString(),
      summary,
      node,
      components,
      remoteMasters,
    };

    figma.ui.postMessage({ type: "result", payload, svgBytes, pngBytes, assets });
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: String((err as Error)?.message ?? err) });
  }
};
