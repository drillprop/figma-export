// Bundled into use_figma code, which runs in the plugin sandbox with no UI iframe.
// test/sample.ts runInSandbox shadows the Node globals that sandbox lacks.
import { type HeadlessConfig, type HeadlessPart, slicePayload } from "../../src/shared/headless";
import { exportNode } from "./export-node";
import { toPayload } from "./payload";

export async function run(config: HeadlessConfig): Promise<HeadlessPart> {
  const node = await figma.getNodeByIdAsync(config.nodeId);
  if (!node) {
    throw new Error(`figma-export: node ${config.nodeId} not found in this file`);
  }
  const out = await exportNode(node, {
    resolveRemote: config.resolveRemote,
    exportedAt: config.exportedAt,
    fileKey: config.fileKey,
  });
  return slicePayload(toPayload(out), config.nodeId, config.part, config.partSize);
}
