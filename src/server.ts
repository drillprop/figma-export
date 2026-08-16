import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ExportPayload, OpenResponse, PickFolderResponse, SyncResponse } from "./shared/types";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3579);
const DEFAULT_OUT = (process.env.OUT_DIR ?? "").trim();

const app = new Hono();

// The plugin UI posts from a `null` origin (iframe), so allow any origin. This
// server binds to 127.0.0.1 only, so it is never reachable off the machine.
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

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

app.get("/", (c) => c.text("figma-export server — POST exports to /sync"));

/**
 * Open a native OS folder-chooser and return the absolute path. The Figma plugin
 * iframe can't do this (filesystem APIs are blocked there), so the plugin calls
 * here and the server — a real OS process — shows the dialog. macOS only for now.
 */
app.get("/pick-folder", async (c) => {
  if (process.platform !== "darwin") {
    return c.json<PickFolderResponse>(
      { error: "Folder picker is macOS-only so far — type the path instead." },
      501,
    );
  }
  const script =
    'POSIX path of (choose folder with prompt "Select the output folder for figma-export")';
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return c.json<PickFolderResponse>({ path: stdout.trim() });
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message ?? error);
    if (detail.includes("User canceled") || detail.includes("-128")) {
      return c.json<PickFolderResponse>({ cancelled: true });
    }
    return c.json<PickFolderResponse>({ error: `Folder picker failed: ${detail.trim()}` }, 500);
  }
});

/**
 * Reveal a folder — or open a file (e.g. the written preview.html) — in the OS.
 * Same rationale as /pick-folder: the plugin iframe has no filesystem/`open`
 * access, so it asks the server (a real OS process) to do it. macOS only for now.
 */
app.post("/open", async (c) => {
  if (process.platform !== "darwin") {
    return c.json<OpenResponse>({ error: "Opening files is macOS-only so far." }, 501);
  }
  let target: string;
  try {
    const body = await c.req.json<{ path?: string }>();
    target = (body.path ?? "").trim();
  } catch {
    return c.json<OpenResponse>({ error: "Invalid JSON body" }, 400);
  }
  if (!target || !path.isAbsolute(target)) {
    return c.json<OpenResponse>({ error: "An absolute path is required" }, 400);
  }
  try {
    await stat(target);
  } catch {
    return c.json<OpenResponse>({ error: `Path does not exist: ${target}` }, 404);
  }
  try {
    await execFileAsync("open", [target]);
    return c.json<OpenResponse>({ ok: true });
  } catch (error) {
    return c.json<OpenResponse>({ error: `Could not open: ${String(error)}` }, 500);
  }
});

app.post("/sync", async (c) => {
  let payload: ExportPayload;
  try {
    payload = await c.req.json<ExportPayload>();
  } catch {
    return c.json<SyncResponse>({ error: "Invalid JSON body" }, 400);
  }

  if (!payload || typeof payload.node !== "object" || payload.node === null) {
    return c.json<SyncResponse>({ error: "Missing `node` in payload" }, 400);
  }

  const baseDir = (payload.outputDir || DEFAULT_OUT).trim();
  if (!baseDir) {
    return c.json<SyncResponse>(
      {
        error:
          "No output folder. Set one in the plugin's Output folder field, or start the server with OUT_DIR.",
      },
      400,
    );
  }
  if (!path.isAbsolute(baseDir)) {
    return c.json<SyncResponse>({ error: `Output folder must be an absolute path: ${baseDir}` }, 400);
  }
  try {
    const info = await stat(baseDir);
    if (!info.isDirectory()) {
      return c.json<SyncResponse>({ error: `Output folder is not a directory: ${baseDir}` }, 400);
    }
  } catch {
    return c.json<SyncResponse>({ error: `Output folder does not exist: ${baseDir}` }, 400);
  }

  const fileDir = slug(payload.fileKey, "unknown-file");
  const nodeDir = slug(payload.folderName || payload.nodeName || payload.nodeId, "node");
  const outDir = path.join(baseDir, fileDir, nodeDir);

  try {
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
      summary: payload.summary ?? null,
    };

    const hasRemoteMasters = (payload.remoteMasters?.length ?? 0) > 0;

    // preview.assets/: raster images pulled out of the SVG + vector icon SVGs.
    if (assets.length > 0) {
      const assetsDir = path.join(outDir, "preview.assets");
      await mkdir(assetsDir, { recursive: true });
      await Promise.all(
        assets.map((asset) =>
          writeFile(
            path.join(assetsDir, slug(asset.name, "asset")),
            Buffer.from(asset.base64, "base64"),
          ),
        ),
      );
    }

    await Promise.all([
      writeFile(path.join(outDir, "node.json"), JSON.stringify(payload.node, null, 2)),
      writeFile(
        path.join(outDir, "components.json"),
        JSON.stringify(payload.components ?? [], null, 2),
      ),
      writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2)),
      hasRemoteMasters
        ? writeFile(
            path.join(outDir, "remote-masters.json"),
            JSON.stringify(payload.remoteMasters, null, 2),
          )
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
    return c.json<SyncResponse>({
      ok: true,
      path: outDir,
      ...(previewFile ? { preview: path.join(outDir, previewFile) } : {}),
    });
  } catch (error) {
    return c.json<SyncResponse>({ error: `Write failed: ${String(error)}` }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`figma-export server → http://127.0.0.1:${info.port}`);
  console.log(`default output folder (OUT_DIR): ${DEFAULT_OUT || "— (set per-export in the plugin)"}`);
});
