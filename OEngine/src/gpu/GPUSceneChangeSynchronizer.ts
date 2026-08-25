/**
 * Scene Change Set 到 GPU Scene 增量写入的窄 seam。
 *
 * 这里决定一次 transform-only 变化需要触达哪些记录；具体 GPU table、
 * TLAS 和 command 编码仍由 GPUSceneContext 持有并实现。
 */

import type { Mesh } from "../scene/Mesh.js";
import type { Node3D } from "../scene/Node3D.js";
import type { SceneChangeSnapshot } from "../scene/SceneChangeSet.js";

export interface GPUSceneChangeTarget {
  transformRowFor(node: Node3D): number | undefined;
  meshRowFor(mesh: Mesh): number | undefined;
  hasMeshRow(row: number): boolean;
  writeTransform(
    row: number,
    node: Node3D,
    parentRow: number,
    previousGlobal: ArrayLike<number>
  ): void;
  writeMeshBounds(row: number, mesh: Mesh): void;
  updateTlas(row: number, mesh: Mesh): void;
  flush(): void;
}

export interface GPUSceneChangeApplyResult {
  readonly requiresFullRebuild: boolean;
  readonly updatedTransforms: number;
  readonly updatedMeshes: number;
}

interface ResolvedTransformChange {
  readonly node: Node3D;
  readonly nodeRow: number;
  readonly parentRow: number;
  readonly previousGlobal: ArrayLike<number>;
}

interface ResolvedMeshBoundsChange {
  readonly mesh: Mesh;
  readonly meshRow: number;
}

const REBUILD_REQUIRED: GPUSceneChangeApplyResult = Object.freeze({
  requiresFullRebuild: true,
  updatedTransforms: 0,
  updatedMeshes: 0
});

export function applySceneTransformChanges(
  changes: SceneChangeSnapshot,
  target: GPUSceneChangeTarget
): GPUSceneChangeApplyResult {
  if (
    changes.transformedNodes.length === 0 &&
    changes.changedMeshBounds.length === 0
  ) {
    return {
      requiresFullRebuild: false,
      updatedTransforms: 0,
      updatedMeshes: 0
    };
  }

  // 先完整验证 stable mapping，再产生任何写入，避免失败中途留下半个增量。
  const resolved: ResolvedTransformChange[] = [];
  for (const change of changes.transformedNodes) {
    const node = change.node;
    const nodeRow = target.transformRowFor(node);
    if (nodeRow === undefined) return REBUILD_REQUIRED;
    const parentRow = node.parent
      ? (target.transformRowFor(node.parent) ?? 0)
      : 0;
    resolved.push({
      node,
      nodeRow,
      parentRow,
      previousGlobal: change.previousGlobal
    });
  }

  const resolvedMeshBounds: ResolvedMeshBoundsChange[] = [];
  for (const mesh of changes.changedMeshBounds) {
    const meshRow = target.meshRowFor(mesh);
    if (meshRow === undefined || !target.hasMeshRow(meshRow)) {
      return REBUILD_REQUIRED;
    }
    resolvedMeshBounds.push({ mesh, meshRow });
  }

  for (const change of resolved) {
    target.writeTransform(
      change.nodeRow,
      change.node,
      change.parentRow,
      change.previousGlobal
    );
  }
  for (const change of resolvedMeshBounds) {
    target.writeMeshBounds(change.meshRow, change.mesh);
    target.updateTlas(change.meshRow, change.mesh);
  }
  target.flush();
  return {
    requiresFullRebuild: false,
    updatedTransforms: resolved.length,
    updatedMeshes: resolvedMeshBounds.length
  };
}
