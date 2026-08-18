// Shared payload contract between the Figma plugin (sender) and the Hono server
// (receiver + file writer). Imported by both sides so they cannot drift.

/** Component set axes: axis name -> its possible values, e.g. { Size: ["sm","md"] }. */
export type VariantAxes = Record<string, string[]>;

/** A single variant's selections, e.g. { Style: "Primary", Size: "md" }. */
export type VariantValues = Record<string, string>;

/** One entry in figma-components.json. Base fields always present; the rest are added
 * when a remote (library) component's master is resolved via import-by-key. */
export interface ComponentEntry {
  id: string;
  name: string;
  key: string | null;
  type: string;
  description: string;
  remote: boolean;
  componentSetId: string | null;
  variantValues?: VariantValues;
  masterName?: string;
  setName?: string;
  setKey?: string;
  variantProperties?: VariantAxes;
  componentPropertyDefinitions?: unknown;
  masterError?: string;
}

/** A serialized node tree. Known keys are typed; the rest are copied verbatim
 * from the Figma node, so the index signature keeps it open. */
export interface SerializedNode {
  id: string;
  name: string;
  type: string;
  truncated?: boolean;
  children?: SerializedNode[];
  [key: string]: unknown;
}

/** A design token's value for one mode. Primitives pass through; colors become
 * a readable hex plus the raw RGBA; a reference to another variable is kept as an
 * alias (with the target's id and — once resolved — its name). */
export type TokenValue =
  | number
  | string
  | boolean
  | { hex: string; rgba: { r: number; g: number; b: number; a: number } }
  | { alias: string; name: string | null };

/** A Figma Variable, resolved into a design token. `boundVariables` ids in
 * node.json / remote-masters.json join against `id`. */
export interface DesignToken {
  id: string;
  /** Variable name, typically slash-grouped, e.g. "color/primary/500". */
  name: string;
  key: string | null;
  remote: boolean;
  /** "COLOR" | "FLOAT" | "STRING" | "BOOLEAN". */
  resolvedType: string;
  description: string;
  collectionId: string;
  collectionName: string;
  scopes?: string[];
  /** Value per mode, keyed by the mode's name (falls back to its id if unnamed). */
  valuesByMode: Record<string, TokenValue>;
}

/** A Figma variable collection: the group a token belongs to and its modes
 * (e.g. Light/Dark themes). */
export interface VariableCollectionInfo {
  id: string;
  name: string;
  key: string | null;
  remote: boolean;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
}

/** variables.json: the file's full token catalog — every Figma Variable in every
 * local collection (plus referenced library tokens), resolved to names +
 * per-mode values, with their collections. Join node.json's `boundVariables`
 * alias ids against `tokens[].id`. */
export interface VariablesExport {
  collections: VariableCollectionInfo[];
  tokens: DesignToken[];
}

export interface ExportSummary {
  target: { id: string; name: string; type: string };
  totalNodes: number;
  nodeTypes: Record<string, number>;
  textLayerCount: number;
  textSamples: string[];
  components: { total: number; local: number; remote: number };
  sets: { name: string; axes: VariantAxes }[];
  remoteMastersResolved: number;
  remoteMasterErrors: { name: string; error: string }[];
  /** Count of design tokens + collections resolved from Figma Variables, when any
   * were referenced. Absent when the selection uses no variables. */
  variables?: { collections: number; tokens: number };
  /** Count of original-bytes images exported to preview.assets/ (one per distinct
   * image fill). Absent when the export uses no image fills. */
  imageAssets?: number;
  truncated: boolean;
  truncatedAt: number | null;
  /** Every export now writes preview.svg + preview.png + preview.html. `svg`/`png`
   * record which raster/vector previews were produced; `svgSkipped` flags a tree
   * too large for an SVG preview (PNG + HTML still written). */
  preview: { svg: boolean; png: boolean; svgSkipped: boolean };
}

/** The full body POSTed to the server's /sync endpoint. */
export interface ExportPayload {
  /** Absolute path chosen in the plugin. Server falls back to OUT_DIR if absent. */
  outputDir?: string;
  fileKey: string;
  fileName: string;
  nodeId: string;
  nodeName: string;
  /** On-disk folder name override. When set (batch collision disambiguation),
   * the export writes here instead of the slugged `nodeName`; the real
   * `nodeName` is still what's stored in the metadata. */
  folderName?: string;
  exportedAt: string;
  summary: ExportSummary;
  node: SerializedNode;
  components: ComponentEntry[];
  remoteMasters: SerializedNode[];
  /** The file's design tokens (Figma Variables) as a full catalog, resolved to
   * names + per-mode values. Absent when the file has no variables. */
  variables?: VariablesExport;
  /** SVG preview as text. When `assets` carries externalized images, the SVG
   * references them as `preview.assets/<name>` (see preview.html); otherwise
   * it's self-contained with images inline. */
  svg?: string;
  /** PNG preview as base64. */
  png?: string;
  /** Files written to preview.assets/: raster images pulled out of the SVG
   * (referenced back from it) and vector icon components (as standalone SVGs). */
  assets?: AssetFile[];
  /** Original-bytes raster images behind IMAGE fills, written to preview.assets/
   * alongside `assets`. Unlike the SVG-rasterized preview rasters, these are
   * matchable to nodes via `imageHash`. Absent when the export uses no image
   * fills. */
  images?: ImageAsset[];
}

/** One raster image behind an IMAGE fill, exported at its original bytes (not the
 * SVG-rasterized preview copy) so it can be matched back to the nodes that use
 * it: join `node.json` fills' `imageHash` against this `imageHash`. Written to
 * preview.assets/<name>, alongside the preview rasters/icons. */
export interface ImageAsset {
  /** The Figma image hash — the same value carried on each IMAGE fill. */
  imageHash: string;
  /** File name written under preview.assets/, e.g. "<imageHash>.png". */
  name: string;
  /** The image bytes, base64-encoded. */
  base64: string;
}

/** One file in preview.assets/. Kind is carried by the name's extension
 * (`.svg` = icon, otherwise a raster image). */
export interface AssetFile {
  /** File name, e.g. "close.svg", "avatar.png", "img-0.jpg". */
  name: string;
  /** The file bytes, base64-encoded. */
  base64: string;
}

export interface SyncResponse {
  ok?: boolean;
  path?: string;
  /** Absolute path to the best preview file written (preview.html, else the raw
   * preview.svg/.png), so the plugin's "Open preview" can point straight at it.
   * Absent when no preview was produced. */
  preview?: string;
  error?: string;
}

/** Response from POST /open (server reveals a folder / opens a file in the OS). */
export interface OpenResponse {
  ok?: boolean;
  error?: string;
}

/** Response from GET /pick-folder (server opens a native OS folder dialog). */
export interface PickFolderResponse {
  /** Absolute path the user chose. */
  path?: string;
  /** User dismissed the dialog. */
  cancelled?: boolean;
  error?: string;
}
