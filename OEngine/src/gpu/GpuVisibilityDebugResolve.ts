import { GPU_INSTANCE_FLAGS } from "./GpuInstanceAbi.js";
import {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS,
  type GpuMaterialVisibilityPackedSource
} from "./GpuMaterialVisibilityAbi.js";
import type { GpuMeshletRecordCpu } from "./GpuGeometryAbi.js";
import {
  decodeVisibilityKey,
  type VisibilityKeyDecodeResult
} from "./GpuVisibilityKeyAbi.js";
import type {
  RasterWorkCpu,
  VisibleClusterRecordCpu
} from "./GpuWorkGenerationAbi.js";

export const GPU_VISIBILITY_DEBUG_RESOLVE_ABI_VERSION = 1;
export const GPU_VISIBILITY_DEBUG_SETTINGS_U32_COUNT = 8;
export const GPU_VISIBILITY_DEBUG_SETTINGS_SIZE =
  GPU_VISIBILITY_DEBUG_SETTINGS_U32_COUNT * 4;

export const GPU_VISIBILITY_DEBUG_STATUS = Object.freeze({
  Valid: 0,
  Empty: 1,
  InvalidKey: 2,
  RasterWorkOutOfRange: 3,
  VisibleClusterOutOfRange: 4,
  ClusterRecordOutOfRange: 5,
  MeshletOutOfRange: 6,
  TriangleOutOfRange: 7,
  InstanceOutOfRange: 8,
  GeometryOutOfRange: 9,
  MaterialOutOfRange: 10,
  MaterialRecordInvalid: 11,
  InactiveInstance: 12,
  IdentityMismatch: 13,
  BlendMaterial: 14
} as const);

export type GpuVisibilityDebugStatus =
  (typeof GPU_VISIBILITY_DEBUG_STATUS)[keyof typeof GPU_VISIBILITY_DEBUG_STATUS];

export const GPU_VISIBILITY_DEBUG_COLORS = Object.freeze({
  Empty: Object.freeze([0, 0, 0] as const),
  InvalidKey: Object.freeze([1, 0, 1] as const),
  RasterWorkOutOfRange: Object.freeze([1, 0, 0] as const),
  VisibleClusterOutOfRange: Object.freeze([1, 0.25, 0] as const),
  ClusterRecordOutOfRange: Object.freeze([1, 0.5, 0] as const),
  MeshletOutOfRange: Object.freeze([1, 1, 0] as const),
  TriangleOutOfRange: Object.freeze([0.5, 1, 0] as const),
  InstanceOutOfRange: Object.freeze([0, 1, 1] as const),
  GeometryOutOfRange: Object.freeze([0, 0.5, 1] as const),
  MaterialOutOfRange: Object.freeze([0.5, 0, 1] as const),
  MaterialRecordInvalid: Object.freeze([1, 1, 1] as const),
  InactiveInstance: Object.freeze([0.5, 0.5, 0.5] as const),
  IdentityMismatch: Object.freeze([1, 0.25, 0.5] as const),
  BlendMaterial: Object.freeze([1, 0.5, 1] as const)
} as const);

export const GPU_VISIBILITY_DEBUG_STATUS_WGSL = /* wgsl */ `
const OENGINE_VIS_DEBUG_VALID: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.Valid}u;
const OENGINE_VIS_DEBUG_EMPTY: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.Empty}u;
const OENGINE_VIS_DEBUG_INVALID_KEY: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.InvalidKey}u;
const OENGINE_VIS_DEBUG_RASTER_WORK_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange}u;
const OENGINE_VIS_DEBUG_VISIBLE_CLUSTER_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.VisibleClusterOutOfRange}u;
const OENGINE_VIS_DEBUG_CLUSTER_RECORD_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.ClusterRecordOutOfRange}u;
const OENGINE_VIS_DEBUG_MESHLET_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.MeshletOutOfRange}u;
const OENGINE_VIS_DEBUG_TRIANGLE_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.TriangleOutOfRange}u;
const OENGINE_VIS_DEBUG_INSTANCE_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.InstanceOutOfRange}u;
const OENGINE_VIS_DEBUG_GEOMETRY_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.GeometryOutOfRange}u;
const OENGINE_VIS_DEBUG_MATERIAL_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.MaterialOutOfRange}u;
const OENGINE_VIS_DEBUG_MATERIAL_INVALID: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.MaterialRecordInvalid}u;
const OENGINE_VIS_DEBUG_INACTIVE_INSTANCE: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.InactiveInstance}u;
const OENGINE_VIS_DEBUG_IDENTITY_MISMATCH: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.IdentityMismatch}u;
const OENGINE_VIS_DEBUG_BLEND_MATERIAL: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.BlendMaterial}u;
`;

export interface GpuVisibilityDebugInstanceRecord {
  readonly geometryRecordIndex: number;
  readonly materialHandle: number;
  readonly flags: number;
  readonly debugId: number;
}

export interface GpuVisibilityDebugResolveTables {
  readonly rasterWork: readonly RasterWorkCpu[];
  readonly visibleClusters: readonly VisibleClusterRecordCpu[];
  readonly meshlets: readonly Pick<GpuMeshletRecordCpu, "triangleCount">[];
  readonly instances: readonly GpuVisibilityDebugInstanceRecord[];
  readonly geometryRecordCount: number;
  readonly clusterRecordCount: number;
  readonly materials: readonly Pick<
    GpuMaterialVisibilityPackedSource,
    "materialId" | "alphaMode" | "flags"
  >[];
}

export type GpuVisibilityDebugResolveResult = Readonly<{
  kind: "empty" | "invalid" | "valid";
  status: GpuVisibilityDebugStatus;
  reason: string;
  rasterWorkSlot?: number;
  visibleClusterSlot?: number;
  meshletRecordIndex?: number;
  localTriangle?: number;
  instanceRecordIndex?: number;
  instanceDebugId?: number;
  geometryRecordIndex?: number;
  clusterRecordIndex?: number;
  materialHandle?: number;
  alphaMode?: number;
  materialFlags?: number;
}>;

export function resolveVisibilityDebugReference(
  key: number,
  tables: GpuVisibilityDebugResolveTables
): GpuVisibilityDebugResolveResult {
  const decoded = decodeVisibilityKey(key);
  if (decoded.kind === "empty") {
    return result("empty", GPU_VISIBILITY_DEBUG_STATUS.Empty, "empty");
  }
  if (decoded.kind === "invalid") {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InvalidKey, decoded.reason);
  }
  const rasterWork = tables.rasterWork[decoded.rasterWorkSlot];
  if (rasterWork === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.RasterWorkOutOfRange,
      "raster-work-out-of-range"
    );
  }
  const visible = tables.visibleClusters[rasterWork.visibleClusterSlot];
  if (visible === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.VisibleClusterOutOfRange,
      "visible-cluster-out-of-range",
      rasterWork
    );
  }
  if (visible.clusterRecordIndex >= tables.clusterRecordCount) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.ClusterRecordOutOfRange,
      "cluster-record-out-of-range",
      rasterWork,
      visible
    );
  }
  const meshlet = tables.meshlets[rasterWork.meshletRecordIndex];
  if (meshlet === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.MeshletOutOfRange,
      "meshlet-out-of-range",
      rasterWork,
      visible
    );
  }
  if (decoded.localTriangle >= meshlet.triangleCount) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.TriangleOutOfRange,
      "triangle-out-of-range",
      rasterWork,
      visible
    );
  }
  const instance = tables.instances[visible.instanceRecordIndex];
  if (instance === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.InstanceOutOfRange,
      "instance-out-of-range",
      rasterWork,
      visible
    );
  }
  if ((instance.flags & GPU_INSTANCE_FLAGS.Active) === 0) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.InactiveInstance,
      "inactive-instance",
      rasterWork,
      visible,
      instance
    );
  }
  if (visible.geometryRecordIndex >= tables.geometryRecordCount) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.GeometryOutOfRange,
      "geometry-out-of-range",
      rasterWork,
      visible,
      instance
    );
  }
  if (
    instance.geometryRecordIndex !== visible.geometryRecordIndex ||
    instance.materialHandle !== visible.materialHandle
  ) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.IdentityMismatch,
      "visible-instance-identity-mismatch",
      rasterWork,
      visible,
      instance
    );
  }
  const material = tables.materials[visible.materialHandle];
  if (material === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.MaterialOutOfRange,
      "material-out-of-range",
      rasterWork,
      visible,
      instance
    );
  }
  if (
    material.materialId !== visible.materialHandle ||
    (material.flags & GPU_MATERIAL_VISIBILITY_FLAGS.Valid) === 0
  ) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.MaterialRecordInvalid,
      "material-record-invalid",
      rasterWork,
      visible,
      instance
    );
  }
  if (material.alphaMode === GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.BlendMaterial,
      "blend-material-in-opaque-visibility",
      rasterWork,
      visible,
      instance
    );
  }
  return result("valid", GPU_VISIBILITY_DEBUG_STATUS.Valid, "valid", {
    rasterWorkSlot: decoded.rasterWorkSlot,
    visibleClusterSlot: rasterWork.visibleClusterSlot,
    meshletRecordIndex: rasterWork.meshletRecordIndex,
    localTriangle: decoded.localTriangle,
    instanceRecordIndex: visible.instanceRecordIndex,
    instanceDebugId: instance.debugId,
    geometryRecordIndex: visible.geometryRecordIndex,
    clusterRecordIndex: visible.clusterRecordIndex,
    materialHandle: visible.materialHandle,
    alphaMode: material.alphaMode,
    materialFlags: material.flags
  });
}

function invalid(
  decoded: Exclude<VisibilityKeyDecodeResult, { kind: "empty" }>,
  status: GpuVisibilityDebugStatus,
  reason: string,
  rasterWork?: RasterWorkCpu,
  visible?: VisibleClusterRecordCpu,
  instance?: GpuVisibilityDebugInstanceRecord
): GpuVisibilityDebugResolveResult {
  return result("invalid", status, reason, {
    rasterWorkSlot: decoded.rasterWorkSlot,
    localTriangle: decoded.localTriangle,
    visibleClusterSlot: rasterWork?.visibleClusterSlot,
    meshletRecordIndex: rasterWork?.meshletRecordIndex,
    instanceRecordIndex: visible?.instanceRecordIndex,
    instanceDebugId: instance?.debugId,
    geometryRecordIndex: visible?.geometryRecordIndex,
    clusterRecordIndex: visible?.clusterRecordIndex,
    materialHandle: visible?.materialHandle
  });
}

function result(
  kind: GpuVisibilityDebugResolveResult["kind"],
  status: GpuVisibilityDebugStatus,
  reason: string,
  fields: Omit<GpuVisibilityDebugResolveResult, "kind" | "status" | "reason"> = {}
): GpuVisibilityDebugResolveResult {
  return Object.freeze({ kind, status, reason, ...fields });
}
