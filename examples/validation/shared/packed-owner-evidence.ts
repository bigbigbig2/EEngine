import type { RendererGpuOwnerCreationEvidence } from "../../../OEngine/src/render/Renderer.ts";

export function packedFrameHasNoLegacyGeometryOwners(
  evidence: RendererGpuOwnerCreationEvidence
): boolean {
  return evidence.scene.environmentContextCount === 1 &&
    evidence.scene.environmentPrepareCount > 0 &&
    evidence.scene.legacyGeometryContextCount === 0 &&
    evidence.scene.legacySceneDatabaseCount === 0 &&
    evidence.scene.legacySkinningContextCount === 0 &&
    !evidence.scene.legacyMeshletDrawListCreated &&
    !evidence.legacy.geometryTableCreated;
}

export function legacySceneUploadLabels(
  labels: Readonly<Record<string, number>>
): readonly string[] {
  return Object.keys(labels).filter((label) =>
    /GPUSceneContext|SceneDatabase|MeshletDrawList|skinning/i.test(label)
  );
}
