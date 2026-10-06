import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import type { PreparedHierarchyWork } from "./HierarchicalWorkGenerator.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";
import type { PreparedFrameInstances } from "./FrameInstanceTransforms.js";
import type { PreparedFrameGeometryArena } from "./FrameGeometryArena.js";
import type { PreparedFrameVertices } from "./FrameGeometryVertices.js";
import type { FrameGeometryArenaBudget } from "../gpu/GpuFrameGeometryArenaAbi.js";

export interface VisibilityWorkSetKey {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assetEpoch: number;
  readonly sceneResourceEpoch: number;
  readonly instanceBegin: number;
  readonly instanceCount: number;
  readonly maxHierarchyDepth: number;
  readonly traversalCapacity: number;
  readonly visibleClusterCapacity: number;
  /** Product identity/bank shape participates in prepared bind-group lifetime. */
  readonly virtualProductGeneration: number;
  readonly virtualProductBankCount: number;
  readonly meshletWorkCandidateCapacity: number;
  readonly meshletWorkCompactionPath: "auto" | "portable" | "subgroup";
  readonly frameGeometryBudget: FrameGeometryArenaBudget;
}

/** Persistent GPU work resources. Camera/counter state is deliberately absent. */
export interface VisibilityWorkSet {
  readonly key: VisibilityWorkSetKey;
  readonly hierarchy: PreparedHierarchyWork;
  readonly frameInstances: PreparedFrameInstances;
  readonly frameGeometry: PreparedFrameGeometryArena;
  readonly frameVertices: PreparedFrameVertices;
  /** Step-4 normal MeshletWork producer; nullable only during allocation rollback. */
  readonly meshletWorkCandidate: PreparedMeshletWorkCandidate | null;
}

export function visibilityWorkSetKey(input: VisibilityWorkSetKey): VisibilityWorkSetKey {
  return Object.freeze({ ...input, frameGeometryBudget: Object.freeze({ ...input.frameGeometryBudget }) });
}

export function sameVisibilityWorkSetKey(left: VisibilityWorkSetKey, right: VisibilityWorkSetKey): boolean {
  return (
    left.runtime === right.runtime &&
    left.assetEpoch === right.assetEpoch &&
    left.sceneResourceEpoch === right.sceneResourceEpoch &&
    left.instanceBegin === right.instanceBegin &&
    left.instanceCount === right.instanceCount &&
    left.maxHierarchyDepth === right.maxHierarchyDepth &&
    left.traversalCapacity === right.traversalCapacity &&
    left.visibleClusterCapacity === right.visibleClusterCapacity &&
    left.virtualProductGeneration === right.virtualProductGeneration &&
    left.virtualProductBankCount === right.virtualProductBankCount &&
    left.meshletWorkCandidateCapacity === right.meshletWorkCandidateCapacity &&
    left.meshletWorkCompactionPath === right.meshletWorkCompactionPath &&
    left.frameGeometryBudget.workCapacity === right.frameGeometryBudget.workCapacity &&
    left.frameGeometryBudget.filteredWorkCapacity === right.frameGeometryBudget.filteredWorkCapacity &&
    left.frameGeometryBudget.vertexCapacity === right.frameGeometryBudget.vertexCapacity &&
    left.frameGeometryBudget.triangleCapacity === right.frameGeometryBudget.triangleCapacity &&
    left.frameGeometryBudget.maxBytes === right.frameGeometryBudget.maxBytes
  );
}

export function visibilityWorkSet(input: VisibilityWorkSet): VisibilityWorkSet {
  return Object.freeze({ ...input, key: visibilityWorkSetKey(input.key) });
}
