// Figma plugin main thread. Serializes the selected node's subtree, gathers the
// components it uses (resolving remote/library masters by key), renders the
// SVG + PNG previews, and hands a typed payload to the UI, which POSTs it
// to the local figma-export server. Runs in the Figma sandbox (no `fetch`).
import type {
  ComponentEntry,
  DesignToken,
  ExportPayload,
  ExportSummary,
  SerializedNode,
  TokenValue,
  VariableCollectionInfo,
  VariablesExport,
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

// --- design tokens (Figma Variables) -----------------------------------
// `boundVariables` on a node only records opaque VariableIDs. This dumps the
// file's full token catalog — every variable in every local collection — into
// named tokens with per-mode values, plus any remote/library tokens the export
// references (so bound ids from imported components still resolve). An agent can
// then build a token layer and map any bound id -> a real token name + value.

/** Figma's bound-variable alias marker: { type: "VARIABLE_ALIAS", id }. */
function isVariableAlias(value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** Recursively gather every VariableID referenced (via VARIABLE_ALIAS) under a
 * serialized value — i.e. anything a node's `boundVariables` points at. */
function collectVariableIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (isVariableAlias(value)) {
    ids.add(value.id);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVariableIds(item, ids);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectVariableIds(item, ids);
  }
}

/** 0..1 channel -> two-digit hex. */
function hexChannel(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n * 255)));
  return v.toString(16).padStart(2, "0");
}

/** Figma RGB/RGBA (0..1 floats) -> "#rrggbb" or "#rrggbbaa" (alpha only when <1). */
function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const base = `#${hexChannel(c.r)}${hexChannel(c.g)}${hexChannel(c.b)}`;
  return c.a === undefined || c.a >= 1 ? base : base + hexChannel(c.a);
}

/** Convert one raw variable value (for a mode) into a readable TokenValue.
 * Aliases keep their target id (name is backfilled once all tokens are known). */
function toTokenValue(raw: unknown, resolvedType: string): TokenValue {
  if (isVariableAlias(raw)) return { alias: raw.id, name: null };
  if (
    resolvedType === "COLOR" &&
    typeof raw === "object" &&
    raw !== null &&
    "r" in (raw as Record<string, unknown>)
  ) {
    const c = raw as { r: number; g: number; b: number; a?: number };
    return { hex: rgbaToHex(c), rgba: { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 } };
  }
  return raw as TokenValue;
}

/**
 * Dump the file's design tokens. Seeds from every variable in every local
 * collection (the full catalog) plus the VariableIDs referenced in the tree +
 * remote masters (to pull in library tokens used by imported components), then
 * resolves each variable and its collection, following alias chains. Returns
 * null only when the file has no variables at all.
 */
async function resolveVariables(
  node: SerializedNode,
  remoteMasters: SerializedNode[],
): Promise<VariablesExport | null> {
  const rootIds = new Set<string>();
  collectVariableIds(node, rootIds);
  for (const master of remoteMasters) collectVariableIds(master, rootIds);

  // Full catalog: seed with every variable in every local collection.
  try {
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
    for (const collection of localCollections) {
      for (const variableId of collection.variableIds) rootIds.add(variableId);
    }
  } catch {
    /* variables API unavailable in this context */
  }

  if (rootIds.size === 0) return null;

  const tokens = new Map<string, DesignToken>();
  const collections = new Map<string, VariableCollectionInfo>();
  const seen = new Set<string>();
  const queue = [...rootIds];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);

    let variable: AnyNode;
    try {
      variable = await figma.variables.getVariableByIdAsync(id);
    } catch {
      continue; // unknown / inaccessible variable id — skip
    }
    if (!variable) continue;

    let collection: AnyNode = null;
    try {
      collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    } catch {
      /* collection unavailable (e.g. unpublished remote) */
    }
    if (collection && !collections.has(collection.id)) {
      collections.set(collection.id, {
        id: collection.id,
        name: collection.name,
        key: collection.key || null,
        remote: Boolean(collection.remote),
        defaultModeId: collection.defaultModeId,
        modes: collection.modes.map((m: AnyNode) => ({ modeId: m.modeId, name: m.name })),
      });
    }
    const modeName = (modeId: string): string =>
      collection?.modes.find((m: AnyNode) => m.modeId === modeId)?.name ?? modeId;

    const valuesByMode: Record<string, TokenValue> = {};
    for (const [modeId, raw] of Object.entries(variable.valuesByMode ?? {})) {
      if (isVariableAlias(raw) && !seen.has(raw.id)) queue.push(raw.id);
      valuesByMode[modeName(modeId)] = toTokenValue(raw, variable.resolvedType);
    }

    tokens.set(id, {
      id,
      name: variable.name,
      key: variable.key || null,
      remote: Boolean(variable.remote),
      resolvedType: variable.resolvedType,
      description: variable.description || "",
      collectionId: variable.variableCollectionId,
      collectionName: collection?.name ?? "",
      scopes: Array.isArray(variable.scopes) ? variable.scopes : undefined,
      valuesByMode,
    });
  }

  // Backfill alias target names now that every reachable token is resolved.
  for (const token of tokens.values()) {
    for (const value of Object.values(token.valuesByMode)) {
      if (value && typeof value === "object" && "alias" in value) {
        value.name = tokens.get(value.alias)?.name ?? null;
      }
    }
  }

  return { collections: [...collections.values()], tokens: [...tokens.values()] };
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

// --- icon library -------------------------------------------------------
// Raster images are handled by externalizing the SVG preview (in the UI); this
// walk extracts the *vector* icons the SVG can't give us as reusable files.
const MAX_ASSETS = 500; // stop extracting past this (huge trees / OOM guard)

/** A file destined for preview.assets/. Bytes are base64-encoded later, in the UI. */
interface RawAsset {
  name: string;
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

/** True when the node (or a descendant) carries a visible IMAGE paint. */
function hasImageFill(node: AnyNode): boolean {
  const fills = tryRead(node, "fills");
  if (!Array.isArray(fills)) return false;
  return fills.some((fill) => fill && fill.type === "IMAGE" && fill.visible !== false);
}

/** True when the subtree is vector-only: no TEXT and no image fills anywhere.
 * Invisible descendants are ignored (they don't render into the icon). */
function isVectorOnly(node: AnyNode): boolean {
  if (node.visible === false) return true;
  if (node.type === "TEXT") return false;
  if (hasImageFill(node)) return false;
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
 * Walk the tree and export every vector-only component/instance as a reusable
 * SVG icon. The topmost qualifying node wins (we stop descending into it);
 * otherwise we keep descending, so icons sitting on a photographic background
 * are still found. Deduped by main component key; invisible/zero-area skipped.
 */
async function collectIcons(root: AnyNode): Promise<RawAsset[]> {
  const assets: RawAsset[] = [];
  const seen = new Set<string>(); // dedup by "icon:<component key>"
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

    if (
      (node.type === "COMPONENT" || node.type === "INSTANCE") &&
      "exportAsync" in node &&
      isVectorOnly(node)
    ) {
      const { key, name } = await iconIdentity(node);
      if (!seen.has(`icon:${key}`)) {
        seen.add(`icon:${key}`);
        try {
          const bytes = (await node.exportAsync({ format: "SVG" })) as Uint8Array;
          assets.push({ name: uniqueName(slugName(name, "icon"), "svg"), bytes });
        } catch (err) {
          console.warn(`[figma-export] SVG icon export failed for "${name}":`, err);
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
    preview: { svg: false, png: false, svgSkipped: false },
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
  resolveRemote: boolean;
  outputDir: string;
  endpoint: string;
}

/** Everything one node's export produces, ready for the UI to POST. */
interface NodeExport {
  payload: ExportPayload;
  svgBytes: Uint8Array | null;
  pngBytes: Uint8Array | null;
  icons: RawAsset[];
}

/** Serialize one node, gather its components, render its preview/icons, and
 * build the payload. The reusable unit both the single-node and batch paths
 * drive; throws on failure so the caller decides how to report it. */
async function exportNode(target: AnyNode, msg: ExportMessage): Promise<NodeExport> {
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

  // Every export renders both previews (SVG + PNG); the server also derives an
  // HTML wrapper from the SVG. The SVG is skipped only for trees too large to
  // render — the PNG still stands in.
  let svgBytes: Uint8Array | null = null;
  let pngBytes: Uint8Array | null = null;
  let svgSkipped = false;

  if ("exportAsync" in target) {
    if (ctx.count > MAX_SVG_NODES) {
      svgSkipped = true;
    } else {
      try {
        svgBytes = await target.exportAsync({ format: "SVG" });
      } catch (err) {
        console.warn("[figma-export] SVG preview failed:", err);
      }
    }
    try {
      pngBytes = await target.exportAsync(pngSettings(target));
    } catch (err) {
      console.warn("[figma-export] PNG preview failed:", err);
    }
  }

  let icons: RawAsset[] = [];
  if ("exportAsync" in target) {
    figma.ui.postMessage({ type: "progress", message: "Extracting icons…" });
    icons = await collectIcons(target);
    console.log(`[figma-export] extracted ${icons.length} icon(s)`);
  }

  figma.ui.postMessage({ type: "progress", message: "Resolving design tokens…" });
  const variables = await resolveVariables(node, remoteMasters);
  if (variables) {
    console.log(
      `[figma-export] resolved ${variables.tokens.length} token(s) across ${variables.collections.length} collection(s)`,
    );
  }

  const summary = summarize(node, components, remoteMasters);
  summary.truncated = ctx.truncated;
  summary.truncatedAt = ctx.truncated ? MAX_NODES : null;
  summary.preview = { svg: Boolean(svgBytes), png: Boolean(pngBytes), svgSkipped };
  if (variables) {
    summary.variables = {
      collections: variables.collections.length,
      tokens: variables.tokens.length,
    };
  }

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
    ...(variables ? { variables } : {}),
  };

  return { payload, svgBytes, pngBytes, icons };
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

  if (targets.length === 1) {
    const out = await exportNode(targets[0], msg);
    figma.ui.postMessage({
      type: "result",
      payload: out.payload,
      svgBytes: out.svgBytes,
      pngBytes: out.pngBytes,
      icons: out.icons,
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
      const out = await exportNode(target, msg);
      const folderName = folderNames.get(target.id);
      if (folderName) out.payload.folderName = folderName;
      figma.ui.postMessage({
        type: "batch-item",
        name: target.name,
        payload: out.payload,
        svgBytes: out.svgBytes,
        pngBytes: out.pngBytes,
        icons: out.icons,
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
