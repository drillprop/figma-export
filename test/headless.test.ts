import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { exportNode } from "../plugin/src/export-node";
import { toPayload } from "../plugin/src/payload";
import { bytesToBase64 } from "../plugin/src/payload";
import { DEFAULT_PART_SIZE, generateCode, MAX_CODE_CHARS, parseTarget } from "../scripts/headless-code";
import { writeHeadless } from "../scripts/headless-write";
import { app } from "../src/app";
import { type HeadlessPart, joinParts, slicePayload } from "../src/shared/headless";
import type { ExportPayload, SyncResponse } from "../src/shared/types";
import { createFakeFigma } from "./fake-figma";
import { headlessParts, SAMPLE_BUNDLE_DIR, SAMPLE_DIR, SAMPLE_EXPORTED_AT } from "./sample";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SMALL_PART_SIZE = 3000;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "figma-export-headless-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pluginPathBundle(outputDir: string, exportedAt: string): Promise<string> {
  const fake = createFakeFigma();
  // The desktop plugin enables the private Plugin API, so figma.fileKey is set there.
  (fake.figma as { fileKey?: string }).fileKey = fake.fileKey;
  const scope = globalThis as { figma?: unknown };
  scope.figma = fake.figma;
  try {
    const out = await exportNode(fake.target, { resolveRemote: true, exportedAt });
    const payload = toPayload(out);
    const res = await app.request("/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, outputDir }),
    });
    const body = (await res.json()) as SyncResponse;
    assert.equal(res.status, 200, body.error);
    assert.ok(body.path, "/sync returned no bundle path");
    return body.path;
  } finally {
    delete scope.figma;
  }
}

async function saveParts(dir: string, texts: string[], ext = ".json"): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  return Promise.all(
    texts.map(async (text, i) => {
      const file = path.join(dir, `part-${i}${ext}`);
      await writeFile(file, text);
      return file;
    }),
  );
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

/** Each file as text when it is valid UTF-8, else as base64, so a mismatch diffs readably. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const rel of await filesUnder(dir)) {
    const bytes = await readFile(path.join(dir, rel));
    const text = bytes.toString("utf8");
    tree[rel] = Buffer.from(text, "utf8").equals(bytes) ? text : `base64:${bytes.toString("base64")}`;
  }
  return tree;
}

async function assertSameTree(actualDir: string, expectedDir: string): Promise<void> {
  const [actual, expected] = await Promise.all([snapshotTree(actualDir), snapshotTree(expectedDir)]);
  assert.ok(Object.keys(expected).length > 0, `nothing was written under ${expectedDir}`);
  assert.deepEqual(actual, expected);
}

const namesPart = (index: number) => new RegExp(String.raw`\bpart(\(s\))? ${index}\b`);

test("generated code for a sample node is under 50,000 characters", async () => {
  const { targetId, fileKey } = createFakeFigma();
  const code = await generateCode({
    nodeId: targetId,
    part: 0,
    partSize: DEFAULT_PART_SIZE,
    exportedAt: SAMPLE_EXPORTED_AT,
    resolveRemote: true,
    fileKey,
  });
  console.log(`generated use_figma code: ${code.length} chars`);
  assert.ok(code.length < MAX_CODE_CHARS, `${code.length} >= MAX_CODE_CHARS (${MAX_CODE_CHARS})`);
  assert.ok(code.length < 50_000, `${code.length} >= the use_figma limit of 50,000`);
});

test("headless parts and the plugin's /sync path write identical bundles", async (t) => {
  const tmp = await tempDir(t);
  const serverDir = path.join(tmp, "server");
  const headlessDir = path.join(tmp, "headless");
  await mkdir(serverDir);
  const bundle = await pluginPathBundle(serverDir, SAMPLE_EXPORTED_AT);

  const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SMALL_PART_SIZE });
  assert.ok(parts[0].parts > 1, `expected several parts at ${SMALL_PART_SIZE} chars, got ${parts[0].parts}`);
  assert.deepEqual(
    parts.map((p) => p.part),
    Array.from({ length: parts[0].parts }, (_, i) => i),
  );
  const files = await saveParts(path.join(tmp, "parts"), parts.map((p) => JSON.stringify(p)));

  const cli = spawnSync(TSX, ["scripts/headless-write.ts", "--out", headlessDir, ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, `headless-write exited ${cli.status}: ${cli.stderr}`);

  await assertSameTree(headlessDir, serverDir);

  const fake = createFakeFigma();
  const { pngFill, jpgFill } = fake.bytes;
  assert.deepEqual(await filesUnder(bundle), [
    "figma-components.json",
    "meta.json",
    "node.json",
    `preview.assets/${pngFill.imageHash}.png`,
    `preview.assets/${jpgFill.imageHash}.jpg`,
    "preview.assets/Name-Close.icon-close-key.svg",
    "preview.assets/Star.star-key.svg",
    "preview.assets/img-0.png",
    "preview.assets/img-1.jpg",
    "preview.html",
    "preview.png",
    "preview.svg",
    "remote-masters.json",
    "styles.json",
    "variables.json",
  ]);
  const read = (rel: string) => readFile(path.join(bundle, rel));
  assert.deepEqual(new Uint8Array(await read("preview.png")), fake.bytes.previewPng);
  assert.deepEqual(new Uint8Array(await read("preview.assets/img-0.png")), fake.bytes.embeddedPng);
  assert.deepEqual(new Uint8Array(await read(`preview.assets/${pngFill.imageHash}.png`)), pngFill.bytes);
  assert.deepEqual(new Uint8Array(await read(`preview.assets/${jpgFill.imageHash}.jpg`)), jpgFill.bytes);
  const svg = (await read("preview.svg")).toString("utf8");
  assert.match(svg, /<title>Zażółć 🎨<\/title>/);
  assert.match(svg, /href="preview\.assets\/img-0\.png"/);
  assert.doesNotMatch(svg, /data:image/);
  assert.ok((await read("preview.html")).toString("utf8").includes(svg), "preview.html inlines preview.svg");
});

test("recorded sample result writes the same files as the server path", async (t) => {
  const tmp = await tempDir(t);
  const serverDir = path.join(tmp, "server");
  await mkdir(serverDir);
  await pluginPathBundle(serverDir, SAMPLE_EXPORTED_AT);

  const fixtureFiles = (await readdir(SAMPLE_DIR)).filter((name) => /^part-\d+\.json$/.test(name));
  assert.ok(fixtureFiles.length >= 3, `expected 3+ recorded parts in ${SAMPLE_DIR}, found ${fixtureFiles.length}`);
  const headlessDir = path.join(tmp, "headless");
  const result = await writeHeadless([SAMPLE_DIR], headlessDir);
  assert.equal(result.parts, fixtureFiles.length);

  await assertSameTree(headlessDir, serverDir);
});

test("writer reads results saved as MCP content wrappers", async (t) => {
  const tmp = await tempDir(t);
  const serverDir = path.join(tmp, "server");
  await mkdir(serverDir);
  await pluginPathBundle(serverDir, SAMPLE_EXPORTED_AT);

  const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SMALL_PART_SIZE });
  assert.ok(parts.length >= 3, `need 3+ parts to cover every wrapper, got ${parts.length}`);
  const texts = parts.map((part, i) => {
    const json = JSON.stringify(part);
    if (i === 0) return `Result:\n${json}`;
    if (i === 1) return JSON.stringify({ content: [{ type: "text", text: json }] });
    return JSON.stringify([{ type: "text", text: json }]);
  });
  const files = await saveParts(path.join(tmp, "parts"), texts, ".txt");

  const headlessDir = path.join(tmp, "headless");
  const result = await writeHeadless(files, headlessDir);
  assert.equal(result.parts, parts.length);
  await assertSameTree(headlessDir, serverDir);
});

test("writer names a truncated part", async (t) => {
  const tmp = await tempDir(t);
  const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SMALL_PART_SIZE });
  assert.ok(parts.length >= 3, `need 3+ parts, got ${parts.length}`);
  const chopped: HeadlessPart[] = parts.map((p) => (p.part === 2 ? { ...p, data: p.data.slice(0, -100) } : p));
  const files = await saveParts(path.join(tmp, "parts"), chopped.map((p) => JSON.stringify(p)));

  const outDir = path.join(tmp, "out");
  await assert.rejects(writeHeadless(files, outDir), namesPart(2));
  assert.deepEqual(await filesUnder(outDir), [], "a truncated export writes no files");
});

test("writer names missing parts", async (t) => {
  const tmp = await tempDir(t);
  const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SMALL_PART_SIZE });
  assert.ok(parts.length >= 3, `need 3+ parts, got ${parts.length}`);
  const files = await saveParts(
    path.join(tmp, "parts"),
    parts.filter((p) => p.part !== 2).map((p) => JSON.stringify(p)),
  );

  const outDir = path.join(tmp, "out");
  await assert.rejects(writeHeadless(files, outDir), namesPart(2));
  assert.deepEqual(await filesUnder(outDir), [], "an incomplete export writes no files");
});

test("parts from different exports are rejected", async (t) => {
  const tmp = await tempDir(t);
  const first = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SMALL_PART_SIZE });
  const second = await headlessParts({ exportedAt: "2026-11-04T09:30:00.000Z", partSize: SMALL_PART_SIZE });
  assert.equal(first.length, second.length);
  const mixed = [first[0], ...second.slice(1)];
  const files = await saveParts(path.join(tmp, "parts"), mixed.map((p) => JSON.stringify(p)));

  const outDir = path.join(tmp, "out");
  await assert.rejects(writeHeadless(files, outDir), /different export/);
  assert.deepEqual(await filesUnder(outDir), [], "mismatched parts write no files");
});

test("the /sync bundle matches the recorded golden files", async (t) => {
  const serverDir = await tempDir(t);
  await pluginPathBundle(serverDir, SAMPLE_EXPORTED_AT);
  await assertSameTree(serverDir, SAMPLE_BUNDLE_DIR);
});

test("bytesToBase64 matches Node's base64, padding included", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 1000, 0x8000 * 3 + 1]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `length ${length}`);
  }
});

test("parseTarget reads node ids and Figma URLs", () => {
  assert.deepEqual(parseTarget("12:34"), { nodeId: "12:34" });
  assert.deepEqual(parseTarget("12-34"), { nodeId: "12:34" });
  assert.deepEqual(parseTarget("I1:2;3:4"), { nodeId: "I1:2;3:4" });
  assert.deepEqual(parseTarget("https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x"), {
    nodeId: "12:34",
    fileKey: "AbC123",
  });
  assert.deepEqual(parseTarget("https://www.figma.com/file/KeY9/x?node-id=I1-2%3B3-4"), {
    nodeId: "I1:2;3:4",
    fileKey: "KeY9",
  });
  assert.throws(() => parseTarget("https://www.figma.com/design/AbC123/My-File"), /no node-id/);
  assert.throws(() => parseTarget("frame"), /not a node id/);
});

test("non-ASCII text survives slicing at every boundary", () => {
  const payload = { node: { id: "1:1", name: "Zażółć 🎨🎨🎨", type: "TEXT" } } as unknown as ExportPayload;
  for (let partSize = 1; partSize <= 12; partSize++) {
    const first = slicePayload(payload, "1:1", 0, partSize);
    const parts = Array.from({ length: first.parts }, (_, i) => slicePayload(payload, "1:1", i, partSize));
    assert.ok(parts.every((p) => /^[\x00-\x7f]*$/.test(p.data)), "every slice is ASCII");
    const viaUtf8 = parts.map((p) => ({ ...p, data: Buffer.from(p.data, "utf8").toString("utf8") }));
    assert.deepEqual(joinParts(viaUtf8), payload, `partSize ${partSize}`);
  }
});
