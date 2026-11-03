// Imported by both the Figma plugin sandbox and Node: no platform APIs.
import type { ExportPayload } from "./types";

export const HEADLESS_PART_FORMAT = "figma-export/headless-part@1";

/** One slice of the payload JSON. Every call re-runs the whole export, so `hash`
 * (of the full JSON) proves all parts came from the same export, and `partHash`
 * pinpoints a slice that was truncated or mangled in transit. */
export interface HeadlessPart {
  format: typeof HEADLESS_PART_FORMAT;
  nodeId: string;
  part: number;
  parts: number;
  partSize: number;
  jsonLength: number;
  hash: string;
  partHash: string;
  data: string;
}

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

/** Not cryptographic: it only has to catch truncated slices and mismatched re-runs. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** JSON with every non-ASCII char as a `\uXXXX` escape. An ASCII-only string
 * can be cut anywhere: no slice ends inside a surrogate pair, and no UTF-8 hop
 * between the sandbox and the saved file can change a slice's length. */
function asciiJson(payload: ExportPayload): string {
  return JSON.stringify(payload).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function slicePayload(
  payload: ExportPayload,
  nodeId: string,
  part: number,
  partSize: number,
): HeadlessPart {
  if (!Number.isInteger(partSize) || partSize < 1) {
    throw new Error(`partSize must be a positive integer, got ${partSize}`);
  }
  const json = asciiJson(payload);
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
    jsonLength: json.length,
    hash: fnv1a(json),
    partHash: fnv1a(data),
    data,
  };
}

/** Parts may arrive in any order and repeat, since bots re-save results. */
export function joinParts(parts: HeadlessPart[]): ExportPayload {
  if (parts.length === 0) throw new Error("no headless parts found");
  const { hash, parts: total, jsonLength, partSize, nodeId } = parts[0];
  const byIndex = new Map<number, HeadlessPart>();
  for (const p of parts) {
    if (p.hash !== hash || p.parts !== total || p.jsonLength !== jsonLength || p.partSize !== partSize) {
      throw new Error(
        `part ${p.part} comes from a different export than part ${parts[0].part} (hash ${p.hash} vs ${hash}). ` +
          "The file changed between calls, or its previews rendered differently. Re-run every part with the same --exported-at",
      );
    }
    if (!Number.isInteger(p.part) || p.part < 0 || p.part >= total) {
      throw new Error(`part ${p.part} is out of range: this export has ${total} part(s), 0..${total - 1}`);
    }
    const expected = Math.min(partSize, jsonLength - p.part * partSize);
    if (p.data.length !== expected || fnv1a(p.data) !== p.partHash) {
      throw new Error(
        `part ${p.part} is corrupt (${p.data.length} of ${expected} chars, or its partHash does not match). ` +
          `Re-fetch part ${p.part} and save the tool result verbatim`,
      );
    }
    byIndex.set(p.part, p);
  }
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length > 0) {
    throw new Error(`missing part(s) ${missing.join(", ")} of ${total} for node ${nodeId}`);
  }
  const json = Array.from({ length: total }, (_, i) => (byIndex.get(i) as HeadlessPart).data).join("");
  return JSON.parse(json) as ExportPayload;
}
