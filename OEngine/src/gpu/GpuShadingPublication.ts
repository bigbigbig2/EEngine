import type { GpuShadingGeometryProfile, GpuShadingMaterialProfile } from "./GpuShadingProgramAbi.js";

/** Scene publication records; no render plan, pipeline or GPU resource ownership. */
export interface GpuShadingMaterialPublication {
  readonly id: number;
  readonly profile: GpuShadingMaterialProfile;
  readonly generation: number;
  readonly textureGeneration: number;
}

export interface GpuShadingGeometryPublication {
  readonly id: number;
  readonly profile: GpuShadingGeometryProfile;
  readonly generation: number;
}

export interface GpuShadingInstancePublication {
  readonly id: number;
  readonly materialId: number;
  readonly geometryId: number;
  readonly active: boolean;
  readonly transparent: boolean;
  readonly generation: number;
}

export interface ActiveShadingSummary {
  readonly binRefCounts: Readonly<Uint32Array>;
  readonly activeBinMaskLo: number;
  readonly activeBinMaskHi: number;
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly transparentLitReceiverCount: number;
  readonly dependencyMask: number;
  readonly revision: number;
}

export interface GpuShadingBulkPublication {
  readonly materials: readonly GpuShadingMaterialPublication[];
  readonly geometries: readonly GpuShadingGeometryPublication[];
  readonly instances: readonly GpuShadingInstancePublication[];
}
