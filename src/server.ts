import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ExportPayload, PickFolderResponse, SyncResponse } from "./shared/types";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 3579);
const DEFAULT_OUT = (process.env.OUT_DIR ?? "").trim();

const app = new Hono();

// The plugin UI posts from a `null` origin (iframe), so allow any origin. This
// server binds to 127.0.0.1 only, so it is never reachable off the machine.
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

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
  const nodeDir = slug(payload.nodeName || payload.nodeId, "node");
  const outDir = path.join(baseDir, fileDir, nodeDir);

  try {
    await mkdir(outDir, { recursive: true });

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
      svgAssetCount: payload.svgAssets?.length ?? 0,
      summary: payload.summary ?? null,
    };

    const hasRemoteMasters = (payload.remoteMasters?.length ?? 0) > 0;
    const svgAssets = payload.svgAssets ?? [];
    if (svgAssets.length > 0) {
      const assetsDir = path.join(outDir, "preview.assets");
      await mkdir(assetsDir, { recursive: true });
      await Promise.all(
        svgAssets.map((asset) =>
          writeFile(path.join(assetsDir, slug(asset.name, "img")), Buffer.from(asset.base64, "base64")),
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
      typeof payload.svg === "string"
        ? writeFile(path.join(outDir, "preview.svg"), payload.svg)
        : Promise.resolve(),
      typeof payload.png === "string"
        ? writeFile(path.join(outDir, "preview.png"), Buffer.from(payload.png, "base64"))
        : Promise.resolve(),
    ]);

    console.log(`wrote ${payload.nodeName || payload.nodeId} → ${outDir}`);
    return c.json<SyncResponse>({ ok: true, path: outDir });
  } catch (error) {
    return c.json<SyncResponse>({ error: `Write failed: ${String(error)}` }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`figma-export server → http://127.0.0.1:${info.port}`);
  console.log(`default output folder (OUT_DIR): ${DEFAULT_OUT || "— (set per-export in the plugin)"}`);
});
