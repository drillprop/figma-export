// The sample export shared by the headless tests and the fixture recorder.
import { fileURLToPath } from "node:url";
import { generateCode } from "../scripts/headless-code";
import type { HeadlessConfig, HeadlessPart } from "../src/shared/headless";
import { createFakeFigma } from "./fake-figma";

export const SAMPLE_EXPORTED_AT = "2026-11-03T12:00:00.000Z";
export const SAMPLE_PART_SIZE = 5000;
export const SAMPLE_DIR = fileURLToPath(new URL("./fixtures/headless-sample/", import.meta.url));

type AsyncFunctionConstructor = new (...params: string[]) => (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = (async () => {}).constructor as AsyncFunctionConstructor;

/** Run generated `use_figma` code the way the MCP tool does: against a fresh
 * document, with the Node globals the Figma sandbox lacks shadowed, returning
 * what the tool would hand back (the JSON of the code's return value). */
export async function runInSandbox(code: string): Promise<unknown> {
  const run = new AsyncFunction("figma", "TextDecoder", "btoa", "atob", "Buffer", "fetch", "process", "require", code);
  const result = await run(createFakeFigma().figma, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  return JSON.parse(JSON.stringify(result));
}

/** Every part of the sample export, one generated-code call per part. */
export async function headlessParts(options: { exportedAt: string; partSize: number }): Promise<HeadlessPart[]> {
  const { targetId, fileKey } = createFakeFigma();
  const config = (part: number): HeadlessConfig => ({
    nodeId: targetId,
    part,
    partSize: options.partSize,
    exportedAt: options.exportedAt,
    resolveRemote: true,
    fileKey,
  });
  const first = (await runInSandbox(await generateCode(config(0)))) as HeadlessPart;
  const parts = [first];
  for (let i = 1; i < first.parts; i++) {
    parts.push((await runInSandbox(await generateCode(config(i)))) as HeadlessPart);
  }
  return parts;
}
