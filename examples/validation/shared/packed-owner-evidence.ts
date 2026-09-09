import type { RendererGpuOwnerCreationEvidence } from "../../../OEngine/src/render/Renderer.ts";

export function packedFrameHasNoLegacyGeometryOwners(
  evidence: RendererGpuOwnerCreationEvidence
): boolean {
  return evidence.scene.environmentContextCount === 1 &&
    evidence.scene.environmentPrepareCount > 0;
}

export function legacySceneUploadLabels(
  labels: Readonly<Record<string, number>>
): readonly string[] {
  return Object.keys(labels).filter((label) =>
    /GPUSceneContext|SceneDatabase|MeshletDrawList|skinning/i.test(label)
  );
}

export function shadowFeatureIsCold(
  evidence: RendererGpuOwnerCreationEvidence
): boolean {
  return evidence.shadow.featureCount === 0 &&
    evidence.shadow.atlasCount === 0 &&
    evidence.shadow.atlasAllocatedBytes === 0 &&
    evidence.shadow.rasterPassCount === 0 &&
    evidence.shadow.workSetCount === 0 &&
    evidence.shadow.workBytes === 0 &&
    evidence.shadow.shadowViewOwnerCount === 0 &&
    evidence.shadow.directionalCameraRevision === 0;
}
