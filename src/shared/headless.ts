// Wire contract for the headless export path. The `use_figma` code (built from
// plugin/src/headless.ts) returns one HeadlessPart per call; the writer
// (scripts/headless-write.ts) joins every part back into the ExportPayload the
// plugin would have POSTed to /sync. Pure: runs in the Figma sandbox and in Node.
import type { ExportPayload } from "./types";

export const HEADLESS_PART_FORMAT = "figma-export/headless-part@1";

/** One slice of `JSON.stringify(payload)`. Every call re-runs the whole export,
 * so `hash` (of the full JSON) proves all parts came from the same export, and
 * `partHash` pinpoints a slice that was truncated or mangled in transit. */
export interface HeadlessPart {
  format: typeof HEADLESS_PART_FORMAT;
  nodeId: string;
  /** 0-based index of this slice. */
  part: number;
  /** Total number of slices. Call the code once per index in [0, parts). */
  parts: number;
  /** Characters per slice; the last slice may be shorter. */
  partSize: number;
  /** Characters in the full payload JSON. */
  length: number;
  hash: string;
  partHash: string;
  data: string;
}

/** Options baked into the generated `use_figma` code string. */
export interface HeadlessConfig {
  nodeId: string;
  part: number;
  partSize: number;
  /** Fixed once at generation time so every part's export is byte-identical. */
  exportedAt: string;
  resolveRemote: boolean;
  /** Overrides `figma.fileKey` (unavailable outside private plugins). */
  fileKey?: string;
}

/** FNV-1a over UTF-16 code units, as 8 hex chars. Not cryptographic; it only
 * has to catch truncation and mismatched re-runs. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function slicePayload(
  payload: ExportPayload,
  nodeId: string,
  part: number,
  partSize: number,
): HeadlessPart {
  const json = JSON.stringify(payload);
  const parts = Math.max(1, Math.ceil(json.length / partSize));
  if (!Number.isInteger(part) || part < 0 || part >= parts) {
    throw new Error(`part ${part} is out of range: this export has ${parts} part(s), 0..${parts - 1}`);
  }
  const data = json.slice(part * partSize, (part + 1) * partSize);
  return {
    format: HEADLESS_PART_FORMAT,
    nodeId,
    part,
    parts,
    partSize,
    length: json.length,
    hash: fnv1a(json),
    partHash: fnv1a(data),
    data,
  };
}

/** Rebuild the payload from every part (any order, duplicates allowed). Throws
 * an error naming the missing, corrupt, or mismatched parts to re-fetch. */
export function joinParts(parts: HeadlessPart[]): ExportPayload {
  if (parts.length === 0) throw new Error("no headless parts found");
  const { hash, parts: total, length, partSize, nodeId } = parts[0];
  const byIndex = new Map<number, HeadlessPart>();
  for (const p of parts) {
    if (p.hash !== hash || p.parts !== total || p.length !== length || p.partSize !== partSize) {
      throw new Error(
        `part ${p.part} comes from a different export than part ${parts[0].part} (hash ${p.hash} vs ${hash}); ` +
          "the file changed between calls, so re-run every part",
      );
    }
    const expected = Math.min(partSize, length - p.part * partSize);
    if (p.data.length !== expected || fnv1a(p.data) !== p.partHash) {
      throw new Error(
        `part ${p.part} is corrupt (${p.data.length} of ${expected} chars, or its partHash does not match); re-fetch part ${p.part}`,
      );
    }
    byIndex.set(p.part, p);
  }
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length > 0) {
    throw new Error(`missing part(s) ${missing.join(", ")} of ${total} for node ${nodeId}`);
  }
  const json = Array.from({ length: total }, (_, i) => (byIndex.get(i) as HeadlessPart).data).join("");
  if (fnv1a(json) !== hash) throw new Error("joined parts do not match the export hash; re-run every part");
  return JSON.parse(json) as ExportPayload;
}
