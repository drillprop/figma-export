// Re-records test/fixtures/headless-sample/ from the fake document: `tsx test/record-sample.ts`.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { headlessParts, SAMPLE_DIR, SAMPLE_EXPORTED_AT, SAMPLE_PART_SIZE } from "./sample";

const parts = await headlessParts({ exportedAt: SAMPLE_EXPORTED_AT, partSize: SAMPLE_PART_SIZE });
if (parts.length < 3) {
  throw new Error(`the sample export has only ${parts.length} part(s) at ${SAMPLE_PART_SIZE} chars; lower SAMPLE_PART_SIZE`);
}
await rm(SAMPLE_DIR, { recursive: true, force: true });
await mkdir(SAMPLE_DIR, { recursive: true });
for (const part of parts) {
  await writeFile(path.join(SAMPLE_DIR, `part-${part.part}.json`), `${JSON.stringify(part, null, 2)}\n`);
}
console.log(`recorded ${parts.length} parts to ${SAMPLE_DIR}`);
