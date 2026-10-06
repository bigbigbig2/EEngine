import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
export interface SurfaceWorkFrame {
  readonly generation: number;
}
export interface SurfaceSignalRevisions {
  readonly environment: number;
  readonly light: number;
  readonly shadow: number;
  readonly sun: number;
  readonly ao?: number;
}
export interface SurfaceLightingFrame {
  readonly clusters: {
    readonly parameters: ResourceId;
    readonly lookup: ResourceId;
    readonly data: ResourceId;
    readonly activeLightList: ResourceId;
  };
  readonly environment: {
    readonly diffuse: ResourceId;
    readonly specular: ResourceId;
    readonly dfg: ResourceId;
  };
  readonly physicalSun: { readonly parameters: ResourceId; readonly transmittance: ResourceId } | null;
  readonly shadow: {
    readonly virtualPageTable: ResourceId;
    readonly physicalAtlasDepth: ResourceId;
    readonly lightProjection: ResourceId;
    readonly contentVersion: ResourceId;
  } | null;
}
export type SurfaceWorkInput = {
  visibility: ResourceId;
  meshletWork: ResourceId;
  sourceHeap: ResourceId;
  vertexPayload: ResourceId;
  frameInstances: ResourceId;
  frameAttributes: ResourceId;
  camera: ResourceId;
  appearanceMetadata: ResourceId;
  appearanceTemporary: ResourceId;
  textureBanks: readonly (readonly ResourceId[])[];
  publication: GpuAppearancePublication;
  product: Readonly<{
    heap: ResourceId;
    banks: readonly ResourceId[];
  }> | null;
  lightRecords: ResourceId;
  clusters: SurfaceLightingFrame["clusters"];
  shadow: SurfaceLightingFrame["shadow"];
  scalarAo: ResourceId | null;
  environment: SurfaceLightingFrame["environment"];
  physicalSun: SurfaceLightingFrame["physicalSun"];
  factsMask: ResourceId;
  preExposure: ResourceId;
  width: number;
  height: number;
  historyBinding: SurfaceResourceBinding;
  revisions: SurfaceSignalRevisions;
  viewRevision: Readonly<{
    value: number;
  }>;
  nonlocalRevision: Readonly<{
    value: number;
  }>;
  diagnosticFrame: Readonly<{
    value: number;
  }>;
  frame: SurfaceWorkFrame & {
    sourceGeometry: number;
    sourceMeshlet: number;
    sourceMeshletVertices: number;
    sourceMeshletTriangles: number;
    sourceVertexData: number;
    geometryArenaHeader: number;
  };
};
