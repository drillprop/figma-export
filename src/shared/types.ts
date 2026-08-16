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
  /** SVG preview as text. When `assets` carries externalized images, the SVG
   * references them as `preview.assets/<name>` (see preview.html); otherwise
   * it's self-contained with images inline. */
  svg?: string;
  /** PNG preview as base64. */
  png?: string;
  /** Files written to preview.assets/: raster images pulled out of the SVG
   * (referenced back from it) and vector icon components (as standalone SVGs). */
  assets?: AssetFile[];
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
