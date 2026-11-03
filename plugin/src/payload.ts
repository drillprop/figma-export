// Also runs in the Figma plugin sandbox, which has no btoa and may lack TextDecoder.
import type { AssetFile, ExportPayload } from "../../src/shared/types";
import type { NodeExport } from "./export-node";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Strings are built from bounded code-unit chunks: one fromCharCode call per
// chunk stays under argument limits, and joining chunks avoids quadratic
// concatenation in engines without rope strings.
const CHUNK = 0x8000;
const PAD = "=".charCodeAt(0);

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let codes: number[] = [];
  const emit = (c: number) => {
    codes.push(BASE64_ALPHABET.charCodeAt(c));
  };
  const flush = () => {
    parts.push(String.fromCharCode.apply(null, codes));
    codes = [];
  };
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    emit(n >> 18);
    emit((n >> 12) & 63);
    emit((n >> 6) & 63);
    emit(n & 63);
    if (codes.length >= CHUNK) flush();
  }
  const rest = bytes.length - whole;
  if (rest > 0) {
    const n = (bytes[whole] << 16) | (rest === 2 ? bytes[whole + 1] << 8 : 0);
    emit(n >> 18);
    emit((n >> 12) & 63);
    if (rest === 2) emit((n >> 6) & 63);
    else codes.push(PAD);
    codes.push(PAD);
  }
  flush();
  return parts.join("");
}

/** Without TextDecoder, follows the WHATWG UTF-8 decoder so invalid bytes get
 * the same U+FFFD replacements. */
export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  const parts: string[] = [];
  let codes: number[] = [];
  const push = (cp: number) => {
    if (cp > 0xffff) {
      cp -= 0x10000;
      codes.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    } else {
      codes.push(cp);
    }
    if (codes.length >= CHUNK) {
      parts.push(String.fromCharCode.apply(null, codes));
      codes = [];
    }
  };
  let cp = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) push(b);
      else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0;
        if (b === 0xed) upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90;
        if (b === 0xf4) upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else push(0xfffd);
      continue;
    }
    if (b < lower || b > upper) {
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      push(0xfffd);
      i--; // the byte that broke the sequence starts the next one
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (++seen === needed) {
      push(cp);
      cp = needed = seen = 0;
    }
  }
  if (needed !== 0) push(0xfffd);
  parts.push(String.fromCharCode.apply(null, codes));
  return parts.join("");
}

/** Pull raster images out of an SVG's inline data URIs into separate files, and
 * rewrite the references to point at `preview.assets/<name>`. Identical images
 * are deduped to one file. Pure-vector SVGs return unchanged with no assets. */
export function externalizeSvgImages(svg: string): { svg: string; assets: AssetFile[] } {
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

/** Encode a node's SVG/PNG/icon/image bytes into the payload the server takes. */
export function toPayload(out: NodeExport): ExportPayload {
  const payload: ExportPayload = { ...out.payload };
  const assets: AssetFile[] = [];

  if (out.svgBytes) {
    const raw = utf8Decode(out.svgBytes);
    // Pull raster images out to files (keeping the SVG small); the server writes
    // a preview.html that inlines the SVG so those external images still render.
    const { svg, assets: images } = externalizeSvgImages(raw);
    payload.svg = svg;
    assets.push(...images);
  }
  if (out.pngBytes) payload.png = bytesToBase64(out.pngBytes);

  // Vector icons from the node-walk share the same preview.assets/ folder.
  for (const icon of out.icons ?? []) {
    assets.push({ name: icon.name, base64: bytesToBase64(icon.bytes) });
  }
  if (assets.length) payload.assets = assets;

  // Original-bytes images behind IMAGE fills, matchable to nodes by imageHash;
  // written into preview.assets/ alongside the preview-only assets above.
  if (out.images?.length) {
    payload.images = out.images.map((img) => ({
      imageHash: img.imageHash,
      name: img.name,
      base64: bytesToBase64(img.bytes),
    }));
  }

  return payload;
}
