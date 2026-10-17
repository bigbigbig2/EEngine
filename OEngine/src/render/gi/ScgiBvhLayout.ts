import { SCGI_ABI } from "./ScgiAbi.js";
import { planScgiArena, scgiInteger, type ScgiBufferLimits } from "./ScgiCapacity.js";

export const SCGI_BVH_WORKGROUP_SIZE = 128;
export const SCGI_BVH_MAX_DEPTH = 64;
export const SCGI_BVH_INVALID = 0xffffffff;

/** Build scratch is batch-local. Primitive bounds contain min xyz / reference
 * and max xyz / mask. They reference shared geometry, never copied vertices. */
export function planScgiBvh(limits: ScgiBufferLimits, primitiveCapacity: number) {
  scgiInteger(primitiveCapacity, "BVH primitive capacity", 1, 0x10000000);
  const nodes = primitiveCapacity * 2 - 1;
  const blocks = Math.ceil(primitiveCapacity / SCGI_BVH_WORKGROUP_SIZE);
  const scanCounts = [blocks * 16];
  while (scanCounts[scanCounts.length - 1]! > SCGI_BVH_WORKGROUP_SIZE) {
    scanCounts.push(Math.ceil(scanCounts[scanCounts.length - 1]! / SCGI_BVH_WORKGROUP_SIZE));
  }
  const hierarchy = planScgiArena(limits, [
    ["header", 16, 4],
    ["nodes", nodes, SCGI_ABI.node.stride],
    ["links", nodes, SCGI_ABI.links.stride],
  ]);
  const scratch = planScgiArena(limits, [
    ["primitiveBounds", primitiveCapacity, 32],
    ["boundsReduction", blocks, 32],
    ["sceneBounds", 1, 32],
    ["keysA", primitiveCapacity, 8],
    ["keysB", primitiveCapacity, 8],
    ...scanCounts.flatMap((count, level) => [
      [`histogram${level}`, count, 4] as const,
      [`prefix${level}`, count, 4] as const,
    ]),
    ["parentsA", nodes, 8],
    ["parentsB", nodes, 8],
    ["depths", nodes, 4],
    ["levelCounts", SCGI_BVH_MAX_DEPTH + 1, 4],
    ["levelOffsets", SCGI_BVH_MAX_DEPTH + 1, 4],
    ["levelCursors", SCGI_BVH_MAX_DEPTH + 1, 4],
    ["levelNodes", nodes, 4],
    ["primitiveCounts", nodes, 4],
    ["control", 16, 4],
    // Refit uses one lane per node; treelet uses one workgroup per root.
    ["indirect", (SCGI_BVH_MAX_DEPTH + 1) * 2, 16],
  ]);
  return Object.freeze({ primitiveCapacity, nodes, blocks, scanCounts, hierarchy, scratch });
}

export type ScgiBvhPlan = ReturnType<typeof planScgiBvh>;
