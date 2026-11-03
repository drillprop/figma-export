// Writes an ExportPayload to disk as a bundle folder. Shared by the server's
// /sync route and the headless writer (scripts/headless-write.ts).
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportPayload } from "./shared/types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap the SVG inline in HTML so it renders from a plain file:// — inline `<svg>`
 * isn't in the browser's SVG secure-static-mode, unlike an SVG loaded as `<img>`
 * or opened directly, so any external image refs still load. No page padding; the
 * SVG is simply centered in the viewport. */
function previewHtml(title: string, svg: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)} — preview</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
      body { display: flex; align-items: center; justify-content: center; }
      svg { display: block; }
    </style>
  </head>
  <body>
${svg}
  </body>
</html>
`;
}

/** Keep an untrusted name to a safe single path segment (no traversal). */
function slug(value: unknown, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** Returns why `baseDir` can't hold bundles, or null when it can. */
export async function checkOutputDir(baseDir: string): Promise<string | null> {
  if (!path.isAbsolute(baseDir)) {
    return `Output folder must be an absolute path: ${baseDir}`;
  }
  try {
    const info = await stat(baseDir);
    if (!info.isDirectory()) {
      return `Output folder is not a directory: ${baseDir}`;
    }
  } catch {
    return `Output folder does not exist: ${baseDir}`;
  }
  return null;
}

/** Writes the bundle under `<baseDir>/<fileKey>/<node>/`. Returns that folder and
 * the best preview file written, if any. */
export async function writeBundle(
  payload: ExportPayload,
  baseDir: string,
): Promise<{ path: string; preview?: string }> {
  const fileDir = slug(payload.fileKey, "unknown-file");
  const nodeDir = slug(payload.folderName || payload.nodeName || payload.nodeId, "node");
  const outDir = path.join(baseDir, fileDir, nodeDir);

  await mkdir(outDir, { recursive: true });

  const assets = payload.assets ?? [];
  const assetSvgCount = assets.filter((a) => a.name.endsWith(".svg")).length;
  // Every export with an SVG gets an HTML wrapper: it inlines the SVG so any
  // externalized images render from file://, and centers it with no padding.
  const hasSvg = typeof payload.svg === "string";

  const meta = {
    fileKey: payload.fileKey ?? null,
    fileName: payload.fileName ?? null,
    nodeId: payload.nodeId ?? null,
    nodeName: payload.nodeName ?? null,
    exportedAt: payload.exportedAt ?? new Date().toISOString(),
    componentCount: payload.components?.length ?? 0,
    remoteMasterCount: payload.remoteMasters?.length ?? 0,
    hasSvg: typeof payload.svg === "string",
    hasPng: typeof payload.png === "string",
    assetCount: assets.length,
    assetImageCount: assets.length - assetSvgCount,
    assetSvgCount,
    hasPreviewHtml: hasSvg,
    hasVariables: Boolean(payload.variables),
    variableCount: payload.variables?.tokens.length ?? 0,
    variableCollectionCount: payload.variables?.collections.length ?? 0,
    hasStyles: Boolean(payload.styles),
    styleCount: payload.styles?.styles.length ?? 0,
    imageAssetCount: payload.images?.length ?? 0,
    summary: payload.summary ?? null,
  };

  const hasRemoteMasters = (payload.remoteMasters?.length ?? 0) > 0;
  const hasVariables = Boolean(payload.variables);
  const hasStyles = Boolean(payload.styles);
  const images = payload.images ?? [];

  // preview.assets/: rasters pulled out of the SVG + vector icon SVGs, plus the
  // original-bytes images behind IMAGE fills (named by imageHash so node.json
  // fills can be matched to the real file). One folder for every extracted file.
  if (assets.length > 0 || images.length > 0) {
    const assetsDir = path.join(outDir, "preview.assets");
    await mkdir(assetsDir, { recursive: true });
    await Promise.all([
      ...assets.map((asset) =>
        writeFile(
          path.join(assetsDir, slug(asset.name, "asset")),
          Buffer.from(asset.base64, "base64"),
        ),
      ),
      ...images.map((image) =>
        writeFile(
          path.join(assetsDir, slug(image.name, "image")),
          Buffer.from(image.base64, "base64"),
        ),
      ),
    ]);
  }

  await Promise.all([
    writeFile(path.join(outDir, "node.json"), JSON.stringify(payload.node, null, 2)),
    writeFile(
      path.join(outDir, "figma-components.json"),
      JSON.stringify(payload.components ?? [], null, 2),
    ),
    writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2)),
    hasRemoteMasters
      ? writeFile(
          path.join(outDir, "remote-masters.json"),
          JSON.stringify(payload.remoteMasters, null, 2),
        )
      : Promise.resolve(),
    hasVariables
      ? writeFile(
          path.join(outDir, "variables.json"),
          JSON.stringify(payload.variables, null, 2),
        )
      : Promise.resolve(),
    hasStyles
      ? writeFile(path.join(outDir, "styles.json"), JSON.stringify(payload.styles, null, 2))
      : Promise.resolve(),
    hasSvg
      ? writeFile(path.join(outDir, "preview.svg"), payload.svg as string)
      : Promise.resolve(),
    // preview.html always accompanies the SVG: it inlines it so external image
    // refs render, and centers it with no padding.
    hasSvg
      ? writeFile(
          path.join(outDir, "preview.html"),
          previewHtml(payload.nodeName || payload.nodeId || "preview", payload.svg as string),
        )
      : Promise.resolve(),
    typeof payload.png === "string"
      ? writeFile(path.join(outDir, "preview.png"), Buffer.from(payload.png, "base64"))
      : Promise.resolve(),
  ]);

  // Point "Open preview" at the richest preview written: the HTML wrapper when
  // an SVG exists, else the raw PNG, else nothing.
  let previewFile: string | null = null;
  if (hasSvg) previewFile = "preview.html";
  else if (typeof payload.png === "string") previewFile = "preview.png";

  console.log(`wrote ${payload.nodeName || payload.nodeId} → ${outDir}`);
  return {
    path: outDir,
    ...(previewFile ? { preview: path.join(outDir, previewFile) } : {}),
  };
}
