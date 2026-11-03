import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { checkOutputDir, writeBundle } from "./bundle";
import type { ExportPayload, OpenResponse, PickFolderResponse, SyncResponse } from "./shared/types";

const execFileAsync = promisify(execFile);

export const DEFAULT_OUT = (process.env.OUT_DIR ?? "").trim();

export const app = new Hono();

// The plugin UI posts from a `null` origin (iframe), so allow any origin. This
// server binds to 127.0.0.1 only, so it is never reachable off the machine.
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

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
  const dirError = await checkOutputDir(baseDir);
  if (dirError) {
    return c.json<SyncResponse>({ error: dirError }, 400);
  }

  try {
    const written = await writeBundle(payload, baseDir);
    return c.json<SyncResponse>({ ok: true, ...written });
  } catch (error) {
    return c.json<SyncResponse>({ error: `Write failed: ${String(error)}` }, 500);
  }
});
