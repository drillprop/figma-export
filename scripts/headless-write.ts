// Joins the HeadlessPart results a bot saved from `use_figma` calls back into the
// ExportPayload and writes the same bundle the server's /sync writes.
// Usage: pnpm -s headless:write --out <dir> <file-or-dir>...
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { writeBundle } from "../src/bundle";
import { HEADLESS_PART_FORMAT, joinParts, type HeadlessPart } from "../src/shared/headless";

const USAGE = "usage: pnpm -s headless:write --out <dir> <file-or-dir>...";

const partSchema = z.object({
  format: z.literal(HEADLESS_PART_FORMAT),
  nodeId: z.string(),
  part: z.number().int().nonnegative(),
  parts: z.number().int().positive(),
  partSize: z.number().int().positive(),
  length: z.number().int().nonnegative(),
  hash: z.string(),
  partHash: z.string(),
  data: z.string(),
});

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parse text the way a bot may have saved it: plain JSON (possibly a JSON
 * string holding more JSON), or JSON embedded in surrounding prose (first `{`
 * to last `}`). */
function parseLenient(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const parsed = tryJson(trimmed);
  if (parsed.ok) return parsed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? tryJson(trimmed.slice(start, end + 1)) : { ok: false };
}

/** Collect every envelope inside `value`, unwrapping arrays, MCP content
 * wrappers and JSON-in-a-string at any depth. An envelope's own `data` is never
 * searched: part 0's slice is itself the start of a JSON object. */
function collectParts(value: unknown, file: string, found: HeadlessPart[]): void {
  if (typeof value === "string") {
    const parsed = parseLenient(value);
    if (parsed.ok) collectParts(parsed.value, file, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectParts(item, file, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const format = (value as { format?: unknown }).format;
  if (typeof format === "string" && format.startsWith("figma-export/headless-part")) {
    const result = partSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`${file}: invalid headless part\n${z.prettifyError(result.error)}`);
    }
    found.push(result.data);
    return;
  }
  for (const child of Object.values(value)) collectParts(child, file, found);
}

async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    let info;
    try {
      info = await stat(input);
    } catch {
      throw new Error(`${input}: no such file or directory`);
    }
    if (!info.isDirectory()) {
      files.push(input);
      continue;
    }
    const names = (await readdir(input))
      .filter((name) => /\.(json|txt)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (names.length === 0) throw new Error(`${input}: no .json or .txt files in this directory`);
    files.push(...names.map((name) => path.join(input, name)));
  }
  return files;
}

export async function readParts(inputs: string[]): Promise<HeadlessPart[]> {
  const parts: HeadlessPart[] = [];
  for (const file of await expandInputs(inputs)) {
    const found: HeadlessPart[] = [];
    collectParts(await readFile(file, "utf8"), file, found);
    if (found.length === 0) {
      throw new Error(`${file}: no headless part found (expected a "${HEADLESS_PART_FORMAT}" object)`);
    }
    parts.push(...found);
  }
  return parts;
}

export async function writeHeadless(
  inputs: string[],
  outDir: string,
): Promise<{ path: string; preview?: string; parts: number }> {
  const parts = await readParts(inputs);
  const payload = joinParts(parts);
  const baseDir = path.resolve(outDir);
  await mkdir(baseDir, { recursive: true });
  const written = await writeBundle(payload, baseDir);
  return { ...written, parts: parts[0].parts };
}

async function main(argv: string[]): Promise<void> {
  let out: string | undefined;
  let inputs: string[];
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { out: { type: "string", short: "o" } },
      allowPositionals: true,
    });
    out = values.out;
    inputs = positionals;
  } catch (error) {
    console.error(`figma-export: ${(error as Error).message}\n${USAGE}`);
    process.exit(1);
  }
  if (!out || inputs.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }
  // `pnpm headless:write` runs from the package root; resolve the caller's
  // relative paths against the directory pnpm was invoked from instead.
  const cwd = process.env.npm_lifecycle_event === "headless:write" ? (process.env.INIT_CWD ?? process.cwd()) : process.cwd();
  try {
    const result = await writeHeadless(
      inputs.map((input) => path.resolve(cwd, input)),
      path.resolve(cwd, out),
    );
    console.log(`bundle: ${result.path}`);
    if (result.preview) console.log(`preview: ${result.preview}`);
  } catch (error) {
    console.error(`figma-export: ${(error as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
