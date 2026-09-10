import { GPU_INSTANCE_FLAGS } from "./GpuInstanceAbi.js";
import {
  GPU_MATERIAL_VISIBILITY_ALPHA_MODE,
  GPU_MATERIAL_VISIBILITY_FLAGS,
  type GpuMaterialVisibilityPackedSource
} from "./GpuMaterialVisibilityAbi.js";
import type { GpuMeshletRecordCpu } from "./GpuGeometryAbi.js";
import type { GpuMeshletRasterWorkCpu } from "./GpuMeshletRasterWorkAbi.js";
import {
  decodeVisibilityKey,
  type VisibilityKeyDecodeResult
} from "./GpuVisibilityKeyAbi.js";

export const GPU_VISIBILITY_DEBUG_RESOLVE_ABI_VERSION = 3;
export const GPU_VISIBILITY_DEBUG_SETTINGS_U32_COUNT = 8;
export const GPU_VISIBILITY_DEBUG_SETTINGS_SIZE =
  GPU_VISIBILITY_DEBUG_SETTINGS_U32_COUNT * 4;

export const GPU_VISIBILITY_DEBUG_STATUS = Object.freeze({
  Valid: 0,
  Empty: 1,
  InvalidKey: 2,
  MeshletWorkOutOfRange: 3,
  MeshletOutOfRange: 4,
  TriangleOutOfRange: 5,
  InstanceOutOfRange: 6,
  GeometryOutOfRange: 7,
  MaterialOutOfRange: 8,
  MaterialRecordInvalid: 9,
  InactiveInstance: 10,
  IdentityMismatch: 11,
  BlendMaterial: 12
} as const);

export type GpuVisibilityDebugStatus =
  (typeof GPU_VISIBILITY_DEBUG_STATUS)[keyof typeof GPU_VISIBILITY_DEBUG_STATUS];

export const GPU_VISIBILITY_DEBUG_COLORS = Object.freeze({
  Empty: Object.freeze([0, 0, 0] as const),
  InvalidKey: Object.freeze([1, 0, 1] as const),
  MeshletWorkOutOfRange: Object.freeze([1, 0, 0] as const),
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
const OENGINE_VIS_DEBUG_RASTER_WORK_OOB: u32 = ${GPU_VISIBILITY_DEBUG_STATUS.MeshletWorkOutOfRange}u;
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
  readonly meshletWork: readonly GpuMeshletRasterWorkCpu[];
  readonly visibilityGeneration: number;
  readonly meshletWorkGeneration: number;
  readonly partition: number;
  readonly meshlets: readonly Pick<GpuMeshletRecordCpu, "triangleCount">[];
  readonly instances: readonly GpuVisibilityDebugInstanceRecord[];
  readonly geometryRecordCount: number;
  readonly materials: readonly Pick<
    GpuMaterialVisibilityPackedSource,
    "kernelClass" | "alphaMode" | "flags"
  >[];
}

export type GpuVisibilityDebugResolveResult = Readonly<{
  kind: "empty" | "invalid" | "valid";
  status: GpuVisibilityDebugStatus;
  reason: string;
  meshletWorkSlot?: number;
  meshletRecordIndex?: number;
  localTriangle?: number;
  instanceRecordIndex?: number;
  instanceDebugId?: number;
  geometryRecordIndex?: number;
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
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InvalidKey, "reserved-key");
  }
  if (tables.visibilityGeneration === 0 ||
      tables.visibilityGeneration !== tables.meshletWorkGeneration ||
      tables.partition !== 0) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InvalidKey, "queue-context-mismatch");
  }
  const work = tables.meshletWork[decoded.meshletWorkSlot];
  if (work === undefined) {
    return invalid(
      decoded,
      GPU_VISIBILITY_DEBUG_STATUS.MeshletWorkOutOfRange,
      "meshlet-work-out-of-range"
    );
  }
  if ((work.packedProfileLod >>> 24) !== tables.partition) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InvalidKey, "partition-mismatch", work);
  }
  const meshlet = tables.meshlets[work.meshletSlot];
  if (meshlet === undefined) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.MeshletOutOfRange, "meshlet-out-of-range", work);
  }
  if (decoded.localPrimitive >= meshlet.triangleCount) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.TriangleOutOfRange, "triangle-out-of-range", work);
  }
  const instance = tables.instances[work.instanceSlot];
  if (instance === undefined) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InstanceOutOfRange, "instance-out-of-range", work);
  }
  if ((instance.flags & GPU_INSTANCE_FLAGS.Active) === 0) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.InactiveInstance, "inactive-instance", work, instance);
  }
  if (work.geometrySlot >= tables.geometryRecordCount) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.GeometryOutOfRange, "geometry-out-of-range", work, instance);
  }
  if (instance.geometryRecordIndex !== work.geometrySlot ||
      instance.materialHandle !== work.materialSlotOrRange) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.IdentityMismatch, "meshlet-work-instance-identity-mismatch", work, instance);
  }
  const material = tables.materials[work.materialSlotOrRange];
  if (material === undefined) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.MaterialOutOfRange, "material-out-of-range", work, instance);
  }
  if ((material.flags & GPU_MATERIAL_VISIBILITY_FLAGS.Valid) === 0) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.MaterialRecordInvalid, "material-record-invalid", work, instance);
  }
  if (material.alphaMode === GPU_MATERIAL_VISIBILITY_ALPHA_MODE.Blend) {
    return invalid(decoded, GPU_VISIBILITY_DEBUG_STATUS.BlendMaterial, "blend-material-in-opaque-visibility", work, instance);
  }
  return result("valid", GPU_VISIBILITY_DEBUG_STATUS.Valid, "valid", {
    meshletWorkSlot: decoded.meshletWorkSlot,
    meshletRecordIndex: work.meshletSlot,
    localTriangle: decoded.localPrimitive,
    instanceRecordIndex: work.instanceSlot,
    instanceDebugId: instance.debugId,
    geometryRecordIndex: work.geometrySlot,
    materialHandle: work.materialSlotOrRange,
    alphaMode: material.alphaMode,
    materialFlags: material.flags
  });
}

function invalid(
  decoded: Exclude<VisibilityKeyDecodeResult, { kind: "empty" }>,
  status: GpuVisibilityDebugStatus,
  reason: string,
  work?: GpuMeshletRasterWorkCpu,
  instance?: GpuVisibilityDebugInstanceRecord
): GpuVisibilityDebugResolveResult {
  return result("invalid", status, reason, {
    meshletWorkSlot: decoded.kind === "valid" ? decoded.meshletWorkSlot : undefined,
    localTriangle: decoded.kind === "valid" ? decoded.localPrimitive : undefined,
    meshletRecordIndex: work?.meshletSlot,
    instanceRecordIndex: work?.instanceSlot,
    instanceDebugId: instance?.debugId,
    geometryRecordIndex: work?.geometrySlot,
    materialHandle: work?.materialSlotOrRange
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
