import type { PackedSceneRuntime } from "../gpu/GpuPackedSceneRegistry.js";
import type { PreparedExactTriangleFilter } from "./ExactTriangleFilter.js";
import type { PreparedHierarchyWork } from "./HierarchicalWorkGenerator.js";

export interface VisibilityWorkSetKey {
  readonly runtime: PackedSceneRuntime;
  readonly assetEpoch: number;
  readonly sceneResourceEpoch: number;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  readonly maxHierarchyDepth: number;
  readonly traversalCapacity: number;
  readonly visibleClusterCapacity: number;
  readonly rasterWorkCapacity: number;
}

/** Persistent GPU work resources. Camera/counter state is deliberately absent. */
export interface VisibilityWorkSet {
  readonly key: VisibilityWorkSetKey;
  readonly hierarchy: PreparedHierarchyWork;
  readonly exact: PreparedExactTriangleFilter;
  readonly exactRasterRecords: GPUBuffer;
  readonly exactDrawIndirect: GPUBuffer;
  readonly classCapacity: number;
}

export function visibilityWorkSetKey(
  input: VisibilityWorkSetKey
): VisibilityWorkSetKey {
  return Object.freeze({ ...input });
}

export function sameVisibilityWorkSetKey(
  left: VisibilityWorkSetKey,
  right: VisibilityWorkSetKey
): boolean {
  return left.runtime === right.runtime &&
    left.assetEpoch === right.assetEpoch &&
    left.sceneResourceEpoch === right.sceneResourceEpoch &&
    left.instanceBegin === right.instanceBegin &&
    left.instanceCount === right.instanceCount &&
    left.maxHierarchyDepth === right.maxHierarchyDepth &&
    left.traversalCapacity === right.traversalCapacity &&
    left.visibleClusterCapacity === right.visibleClusterCapacity &&
    left.rasterWorkCapacity === right.rasterWorkCapacity;
}

export function visibilityWorkSet(input: VisibilityWorkSet): VisibilityWorkSet {
  if (!Number.isSafeInteger(input.classCapacity) || input.classCapacity <= 0) {
    throw new RangeError("VisibilityWorkSet.classCapacity must be a positive integer");
  }
  return Object.freeze({ ...input, key: visibilityWorkSetKey(input.key) });
}
