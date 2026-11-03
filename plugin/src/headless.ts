// Entry for the headless path: scripts/headless-code.ts bundles this into the
// code string a bot passes to the Figma MCP `use_figma` tool. Runs in the plugin
// sandbox without a UI, so it must not touch figma.ui, fetch, btoa, or Buffer.
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
