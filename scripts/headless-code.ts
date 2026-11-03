import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as esbuild from "esbuild";
import type { HeadlessConfig } from "../src/shared/headless";

/** `use_figma` rejects longer code. */
export const MAX_CODE_CHARS = 50_000;
export const DEFAULT_PART_SIZE = 30_000;

const ENTRY = fileURLToPath(new URL("../plugin/src/headless.ts", import.meta.url));

export async function generateCode(config: HeadlessConfig): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    globalName: "figmaExportHeadless",
    target: "es2017",
    logLevel: "silent",
  });
  // A "use strict" prologue is a SyntaxError in a function body with non-simple
  // parameters, and we don't control how use_figma wraps the code.
  const bundle = result.outputFiles[0].text.replace(/^"use strict";\s*/, "");
  const code = `${bundle}\nreturn await figmaExportHeadless.run(${JSON.stringify(config)});`;
  if (code.length >= MAX_CODE_CHARS) {
    throw new Error(`generated code is ${code.length} chars; use_figma accepts under ${MAX_CODE_CHARS}`);
  }
  return code;
}

const NODE_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/;

export function parseTarget(arg: string): { nodeId: string; fileKey?: string } {
  if (/^https?:\/\//.test(arg)) {
    const url = new URL(arg);
    const fileKey = url.pathname.match(/\/(?:file|design|proto|board)\/([^/]+)/)?.[1];
    const raw = url.searchParams.get("node-id");
    if (!raw) throw new Error(`no node-id in ${arg}`);
    return { nodeId: normalizeNodeId(raw), ...(fileKey ? { fileKey } : {}) };
  }
  return { nodeId: normalizeNodeId(arg) };
}

function normalizeNodeId(raw: string): string {
  // Figma URLs spell node ids with "-" instead of ":".
  const id = raw.includes(":") ? raw : raw.replace(/-/g, ":");
  if (!NODE_ID.test(id)) throw new Error(`not a node id: ${raw}`);
  return id;
}

const USAGE =
  "usage: pnpm -s headless:code <node-id | figma-url> [--part N] [--part-size N] " +
  "[--exported-at ISO] [--file-key KEY] [--no-remote]";

function intFlag(flag: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got ${value}`);
  return n;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function main(argv: string[]): Promise<void> {
  let config: HeadlessConfig;
  let nextPartCommand: string;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        part: { type: "string" },
        "part-size": { type: "string" },
        "exported-at": { type: "string" },
        "file-key": { type: "string" },
        "no-remote": { type: "boolean" },
      },
    });
    if (positionals.length !== 1) throw new Error("expected exactly one node id or Figma URL");
    const target = parseTarget(positionals[0]);
    const exportedAt = values["exported-at"] ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(exportedAt))) throw new Error(`--exported-at is not a date: ${exportedAt}`);
    const fileKey = values["file-key"] ?? target.fileKey;
    config = {
      nodeId: target.nodeId,
      part: intFlag("--part", values.part, 0, 0),
      partSize: intFlag("--part-size", values["part-size"], DEFAULT_PART_SIZE, 1),
      exportedAt,
      resolveRemote: !values["no-remote"],
      ...(fileKey ? { fileKey } : {}),
    };
    nextPartCommand = [
      "pnpm -s headless:code",
      shellQuote(positionals[0]),
      `--exported-at ${exportedAt}`,
      values["part-size"] !== undefined ? `--part-size ${config.partSize}` : "",
      values["file-key"] !== undefined ? `--file-key ${shellQuote(values["file-key"])}` : "",
      values["no-remote"] ? "--no-remote" : "",
      "--part <i>",
    ]
      .filter(Boolean)
      .join(" ");
  } catch (err) {
    process.stderr.write(`figma-export: ${(err as Error).message}\n${USAGE}\n`);
    process.exit(1);
  }
  const code = await generateCode(config);
  process.stdout.write(code);
  process.stderr.write(`figma-export: ${code.length} chars. For part i run: ${nextPartCommand}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main(process.argv.slice(2));
