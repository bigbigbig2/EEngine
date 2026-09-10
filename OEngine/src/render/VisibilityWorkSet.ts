import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import type { PreparedExactTriangleFilter } from "./ExactTriangleFilter.js";
import type { PreparedHierarchyWork } from "./HierarchicalWorkGenerator.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";

export interface VisibilityWorkSetKey {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assetEpoch: number;
  readonly sceneResourceEpoch: number;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  readonly maxHierarchyDepth: number;
  readonly traversalCapacity: number;
  readonly visibleClusterCapacity: number;
  readonly rasterWorkCapacity: number;
  readonly meshletWorkCandidateEnabled: boolean;
  readonly meshletWorkCandidateCapacity: number;
  readonly triangleSetupEnabled: boolean;
  readonly triangleSetupThresholdPixels: number;
}

/** Persistent GPU work resources. Camera/counter state is deliberately absent. */
export interface VisibilityWorkSet {
  readonly key: VisibilityWorkSetKey;
  readonly hierarchy: PreparedHierarchyWork;
  /** Step-1 GPU-only candidate seam; null in the production default. */
  readonly meshletWorkCandidate: PreparedMeshletWorkCandidate | null;
  readonly exact: PreparedExactTriangleFilter;
  readonly exactRasterRecords: GPUBuffer;
  readonly exactDrawIndirect: GPUBuffer;
  /** Null when TriangleSetup is disabled; no dedicated cache resource exists. */
  readonly setupRecords: GPUBuffer | null;
  readonly setupCapacity: number;
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
    left.rasterWorkCapacity === right.rasterWorkCapacity &&
    left.meshletWorkCandidateEnabled === right.meshletWorkCandidateEnabled &&
    left.meshletWorkCandidateCapacity === right.meshletWorkCandidateCapacity &&
    left.triangleSetupEnabled === right.triangleSetupEnabled &&
    left.triangleSetupThresholdPixels === right.triangleSetupThresholdPixels;
}

export function visibilityWorkSet(input: VisibilityWorkSet): VisibilityWorkSet {
  if (!Number.isSafeInteger(input.classCapacity) || input.classCapacity <= 0) {
    throw new RangeError("VisibilityWorkSet.classCapacity must be a positive integer");
  }
  if (!Number.isSafeInteger(input.setupCapacity) || input.setupCapacity < 0) {
    throw new RangeError("VisibilityWorkSet.setupCapacity must be a non-negative integer");
  }
  return Object.freeze({ ...input, key: visibilityWorkSetKey(input.key) });
}
