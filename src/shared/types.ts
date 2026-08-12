// Shared payload contract between the Figma plugin (sender) and the Hono server
// (receiver + file writer). Imported by both sides so they cannot drift.

/** Component set axes: axis name -> its possible values, e.g. { Size: ["sm","md"] }. */
export type VariantAxes = Record<string, string[]>;

/** A single variant's selections, e.g. { Style: "Primary", Size: "md" }. */
export type VariantValues = Record<string, string>;

/** One entry in components.json. Base fields always present; the rest are added
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

export type PreviewFormat = "SVG" | "PNG" | "NONE";

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
  preview: { format: PreviewFormat; skipped: boolean; produced: boolean };
}

/** The full body POSTed to the server's /sync endpoint. */
export interface ExportPayload {
  /** Absolute path chosen in the plugin. Server falls back to OUT_DIR if absent. */
  outputDir?: string;
  fileKey: string;
  fileName: string;
  nodeId: string;
  nodeName: string;
  exportedAt: string;
  summary: ExportSummary;
  node: SerializedNode;
  components: ComponentEntry[];
  remoteMasters: SerializedNode[];
  /** SVG preview as text (self-contained, with images inline). */
  svg?: string;
  /** PNG preview as base64. */
  png?: string;
  /** Typed asset library: every classified sub-asset, written to preview.assets/. */
  assets?: AssetFile[];
}

/** One file in the typed asset library. Rasters (image fills) are exported as
 * PNG; vector-only component/instance icons as SVG. Deduped by semantic identity
 * (image hash / main component key), so one entry per distinct asset. */
export interface AssetFile {
  /** File name written under preview.assets/, e.g. "close.svg" or "avatar.png". */
  name: string;
  /** Which exporter produced it. */
  kind: "png" | "svg";
  /** The file bytes, base64-encoded. */
  base64: string;
}

export interface SyncResponse {
  ok?: boolean;
  path?: string;
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
