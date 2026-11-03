import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeHeadless } from "../scripts/headless-write";
import { headlessParts, SAMPLE_BUNDLE_DIR, SAMPLE_DIR, SAMPLE_EXPORTED_AT, SAMPLE_PART_SIZE } from "./sample";

const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SAMPLE_PART_SIZE });
if (parts.length < 3) {
  throw new Error(`the sample export has only ${parts.length} part(s) at ${SAMPLE_PART_SIZE} chars; lower SAMPLE_PART_SIZE`);
}
await rm(SAMPLE_DIR, { recursive: true, force: true });
await mkdir(SAMPLE_DIR, { recursive: true });
for (const part of parts) {
  await writeFile(path.join(SAMPLE_DIR, `part-${part.part}.json`), `${JSON.stringify(part, null, 2)}\n`);
}
await rm(SAMPLE_BUNDLE_DIR, { recursive: true, force: true });
const bundle = await writeHeadless([SAMPLE_DIR], SAMPLE_BUNDLE_DIR);
console.log(`recorded ${parts.length} parts to ${SAMPLE_DIR} and their bundle to ${bundle.path}`);
