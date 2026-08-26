/**
 * Meshlet 绘制列表：组织可见性裁剪、工作生成和间接绘制所需的 GPU 缓冲区。
 */

import type { MeshletGpuTable } from "./MeshletGpuTable.js";
import type { SceneDatabase } from "./SceneDatabase.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import { StructType } from "../core/WgslStruct.js";
import { WGSL_u32 } from "../core/WebGPUTypes.js";
import {
  createMeshletHzbCullSecondWgsl,
  createMeshletHzbCullWgsl,
  MESHLET_HZB_CULL_SECOND_WGSL,
  MESHLET_HZB_CULL_WGSL
} from "../shaders/meshlet_hzb_cull.js";
import {
  createMeshletHzbCullDualWgsl,
  MESHLET_HZB_CULL_DUAL_WGSL
} from "../shaders/meshlet_hzb_cull_dual.js";
import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import {
  ORACLE_MESH_INSTANCE_CULL_WGSL,
  ORACLE_MESHLET_EXPAND_COMMIT_WGSL,
  ORACLE_MESHLET_EXPAND_COUNTS_WGSL,
  ORACLE_MESHLET_EXPAND_DISPATCH_WGSL,
  ORACLE_MESHLET_EXPAND_WGSL,
  ORACLE_MESHLET_PREFIX_SCAN_WGSL,
  oracleFillDispatchIndirectArgsWgsl
} from "../shaders/oracle_visibility_work_generation.js";
import { MESH_INSTANCE_CULL_DUAL_WGSL } from "../shaders/mesh_instance_cull_dual.js";
import { MESHLET_PREFIX_SCAN_TILE_SIZE } from "../shaders/meshlet_prefix_scan.js";
import {
  MESHLET_KA_BUCKET_COUNT,
  MESHLET_KA_COUNTS_BYTES,
  MESHLET_KA_EPW,
  MESHLET_KA_GA_WGSL,
  MESHLET_KA_HEADER_STRIDE_BYTES,
  MESHLET_KA_HEADERS_BYTES,
  MESHLET_KA_JA_WGSL,
  MESHLET_KA_RA_WGSL,
  MESHLET_KA_UB_WGSL
} from "../shaders/meshlet_bucket_ka.js";
import {
  MESHLET_QB_COUNT_WGSL,
  MESHLET_QB_EPW,
  MESHLET_QB_HEADERS_BYTES,
  MESHLET_QB_HEADER_STRIDE_BYTES,
  MESHLET_QB_SCATTER_WGSL,
  MESHLET_QB_SLICE_WGSL
} from "../shaders/meshlet_bucket_qb.js";

export const DRAW_INDIRECT_ARGS_BYTES = 16;
export const DRAW_INDIRECT_ARGS_U32 = 4;

export const MESHLET_DRAW_VERTEX_COUNT = 384;

export const MESHLET_INSTANCE_STRIDE_U32 = 2;
export const MESHLET_INSTANCE_STRIDE_BYTES = 8;

export const MESHLET_LIST_COUNT_OFFSET = 0;
export const MESHLET_LIST_ELEMENTS_OFFSET = 16;

const BUCKET_VALUE_PARAMS_TYPE = StructType.from({ value: WGSL_u32 });

export const FILL_DRAW_INDIRECT_ARGS_WGSL = /* wgsl */ `
struct DrawIndirectArgs {
  vertexCount: u32,
  instanceCount: u32,
  firstVertex: u32,
  firstInstance: u32,
};

@group(0) @binding(0) var<storage, read> input_count: u32;
@group(0) @binding(1) var<storage, read_write> command: DrawIndirectArgs;

@compute @workgroup_size(1)
fn main() {
  command.vertexCount = 384u;
  command.instanceCount = input_count;
  command.firstVertex = 0u;
  command.firstInstance = 0u;
}
`;

export const DISPATCH_INDIRECT_ARGS_BYTES = 12;
export const DISPATCH_INDIRECT_ARGS_U32 = 3;

export const DISPATCH_EPW_CULL = 128;

const COMPUTE = GPUShaderStage.COMPUTE;

function computeBufferGroup(
  types: readonly GPUBufferBindingType[]
): GPUBindGroupLayoutDescriptor {
  return {
    label: "",
    entries: types.map((type, binding) => ({
      binding,
      visibility: COMPUTE,
      buffer: { type }
    }))
  };
}

function computeMixedGroup(
  entries: readonly Omit<GPUBindGroupLayoutEntry, "binding" | "visibility">[]
): GPUBindGroupLayoutDescriptor {
  return {
    label: "",
    entries: entries.map((entry, binding) => ({
      binding,
      visibility: COMPUTE,
      ...entry
    }))
  };
}

export const FILL_ARGS_GROUP = computeBufferGroup(["read-only-storage", "storage"]);
const HZB_CULL_GROUPS = [
  computeMixedGroup([
    { buffer: { type: "uniform" } },
    { buffer: { type: "uniform" } },
    { buffer: { type: "read-only-storage" } },
    { buffer: { type: "read-only-storage" } },
    { texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
  ]),
  computeBufferGroup(["read-only-storage", "storage"])
] as const;
const HZB_CULL_SECOND_GROUPS = [
  computeMixedGroup([
    { buffer: { type: "uniform" } },
    { buffer: { type: "read-only-storage" } },
    { buffer: { type: "read-only-storage" } },
    { texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
  ]),
  computeBufferGroup(["read-only-storage"]),
  computeBufferGroup(["storage"])
] as const;
const HZB_CULL_DUAL_GROUPS = [
  computeMixedGroup([
    { buffer: { type: "uniform" } },
    { buffer: { type: "uniform" } },
    { buffer: { type: "uniform" } },
    { buffer: { type: "read-only-storage" } },
    { buffer: { type: "read-only-storage" } },
    { texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
  ]),
  computeBufferGroup(["read-only-storage", "storage", "storage"])
] as const;
const HZB_COUNTER_GROUP = computeBufferGroup(["storage"]);
const HZB_CULL_COUNTER_GROUPS = [...HZB_CULL_GROUPS, HZB_COUNTER_GROUP] as const;
const HZB_CULL_SECOND_COUNTER_GROUPS = [
  ...HZB_CULL_SECOND_GROUPS,
  HZB_COUNTER_GROUP
] as const;
const HZB_CULL_DUAL_COUNTER_GROUPS = [
  ...HZB_CULL_DUAL_GROUPS,
  HZB_COUNTER_GROUP
] as const;
const REJECTED_HZB_COUNTER_INDEX =
  counterByteOffset("rejectedHzb") / Uint32Array.BYTES_PER_ELEMENT;
const MESHLET_HZB_CULL_COUNTER_WGSL = createMeshletHzbCullWgsl({
  counterGroup: 2,
  rejectedHzbIndex: REJECTED_HZB_COUNTER_INDEX
});
const MESHLET_HZB_CULL_SECOND_COUNTER_WGSL = createMeshletHzbCullSecondWgsl({
  counterGroup: 3,
  rejectedHzbIndex: REJECTED_HZB_COUNTER_INDEX
});
const MESHLET_HZB_CULL_DUAL_COUNTER_WGSL = createMeshletHzbCullDualWgsl({
  counterGroup: 2,
  rejectedHzbIndex: REJECTED_HZB_COUNTER_INDEX
});
const EXPAND_GROUPS = [
  computeBufferGroup(["read-only-storage"]),
  computeBufferGroup(["read-only-storage", "read-only-storage"]),
  computeBufferGroup(["read-only-storage", "storage"])
] as const;
const INSTANCE_CULL_GROUPS = [computeMixedGroup([
  { buffer: { type: "read-only-storage" } },
  { buffer: { type: "storage" } },
  { buffer: { type: "uniform" } },
  { buffer: { type: "read-only-storage" } },
  { texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
])] as const;
const INSTANCE_CULL_DUAL_GROUPS = [
  computeBufferGroup(["uniform", "read-only-storage"]),
  computeMixedGroup([
    { buffer: { type: "uniform" } },
    { texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
  ]),
  computeBufferGroup(["read-only-storage"]),
  computeBufferGroup(["storage", "storage"])
] as const;
const KA_RA_GROUPS = [
  computeBufferGroup(["read-only-storage", "read-only-storage"]),
  computeBufferGroup(["read-only-storage", "storage"])
] as const;
const KA_GA_GROUPS = [computeBufferGroup(["storage"])] as const;
const KA_JA_GROUPS = [
  computeBufferGroup(["read-only-storage", "read-only-storage"]),
  computeBufferGroup(["read-only-storage", "read-only-storage", "storage"])
] as const;
const KA_UB_GROUPS = [computeBufferGroup([
  "uniform",
  "read-only-storage",
  "storage"
])] as const;
const QB_COUNT_GROUPS = [computeBufferGroup([
  "read-only-storage",
  "read-only-storage",
  "read-only-storage",
  "storage"
])] as const;
const QB_SCATTER_GROUPS = [computeBufferGroup([
  "read-only-storage",
  "read-only-storage",
  "read-only-storage",
  "read-only-storage",
  "storage"
])] as const;
const QB_SLICE_GROUPS = [computeBufferGroup([
  "uniform",
  "read-only-storage",
  "storage"
])] as const;
const EXPAND_COUNTS_GROUPS = [
  computeBufferGroup(["read-only-storage", "read-only-storage"]),
  computeBufferGroup(["read-only-storage", "storage"])
] as const;
const PREFIX_SCAN_GROUPS = [computeBufferGroup(["storage", "storage"])] as const;
const EXPAND_DISPATCH_GROUPS = [
  computeBufferGroup(["read-only-storage", "storage"])
] as const;
const EXPAND_COMMIT_GROUPS = [
  computeBufferGroup(["read-only-storage", "storage"])
] as const;

function fillDispatchIndirectArgsWgsl(
  elementsPerWorkgroup: number,
  maxWorkgroups: number
): string {
  return oracleFillDispatchIndirectArgsWgsl(
    elementsPerWorkgroup,
    maxWorkgroups
  );
}

export const FILL_DISPATCH_INDIRECT_ARGS_WGSL =
  fillDispatchIndirectArgsWgsl(DISPATCH_EPW_CULL, 65535);

const fillDispatchPipelines = new WeakMap<
  GPUDevice,
  Map<number, GPUComputePipeline>
>();

export function obtainFillDispatchPipeline(
  device: GPUDevice,
  elementsPerWorkgroup: number,
  graphics: GraphicsContext
): GPUComputePipeline {
  let devicePipelines = fillDispatchPipelines.get(device);
  if (devicePipelines === undefined) {
    devicePipelines = new Map<number, GPUComputePipeline>();
    fillDispatchPipelines.set(device, devicePipelines);
  }
  const key = Math.max(1, elementsPerWorkgroup) >>> 0;
  const existing = devicePipelines.get(key);
  if (existing !== undefined) return existing;
  const code = fillDispatchIndirectArgsWgsl(
    key,
    device.limits.maxComputeWorkgroupsPerDimension
  );
  const pipeline = graphics.compute_pipelines.obtain({
    label: "",
    layout: { label: "", bindGroupLayouts: [FILL_ARGS_GROUP] },
    compute: { module: { label: "", code } }
  });
  devicePipelines.set(key, pipeline);
  return pipeline;
}

export function transformAabbLocalToWorld(
  outMinMax: Float32Array,
  localMinMax: ArrayLike<number>,
  m: ArrayLike<number>
): void {
  const x0 = localMinMax[0]!;
  const y0 = localMinMax[1]!;
  const z0 = localMinMax[2]!;
  const x1 = localMinMax[3]!;
  const y1 = localMinMax[4]!;
  const z1 = localMinMax[5]!;

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? x1 : x0;
    const ly = i & 2 ? y1 : y0;
    const lz = i & 4 ? z1 : z0;
    const wx = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
    const wy = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
    const wz = m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!;
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wz < minZ) minZ = wz;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
    if (wz > maxZ) maxZ = wz;
  }
  outMinMax[0] = minX;
  outMinMax[1] = minY;
  outMinMax[2] = minZ;
  outMinMax[3] = maxX;
  outMinMax[4] = maxY;
  outMinMax[5] = maxZ;
}

export function aabbIntersectsFrustum(
  minMax: ArrayLike<number>,
  frustum24: ArrayLike<number>
): boolean {
  const x0 = minMax[0]!;
  const y0 = minMax[1]!;
  const z0 = minMax[2]!;
  const x1 = minMax[3]!;
  const y1 = minMax[4]!;
  const z1 = minMax[5]!;

  for (let p = 0; p < 6; p++) {
    const o = p * 4;
    const nx = frustum24[o]!;
    const ny = frustum24[o + 1]!;
    const nz = frustum24[o + 2]!;
    const d = frustum24[o + 3]!;
    const fx = nx > 0 ? x1 : x0;
    const fy = ny > 0 ? y1 : y0;
    const fz = nz > 0 ? z1 : z0;
    if (nx * fx + ny * fy + nz * fz + d < 0) {
      return false;
    }
  }
  return true;
}

function sceneMeshGeometryMeta(
  table: MeshletGpuTable,
  sceneDb: SceneDatabase | null,
  row: number
) {
  const geometryIndex = sceneDb?.getMeshGeometry(row);
  return geometryIndex === undefined
    ? null
    : table.getGeometryMeta(geometryIndex);
}

export const MESH_LIST_ELEMENTS_OFFSET = MESHLET_LIST_ELEMENTS_OFFSET;

/**
 * GPU 驱动绘制的工作列表。
 *
 * 它保存实例与 Meshlet 的候选、可见和待复检列表，并生成计算调度与间接绘制参数。
 */
export class MeshletDrawList {
  constructor(private readonly graphics: GraphicsContext) {}

  private resourceCommand: ShadeGPUCommandContext | null = null;

  private obtainComputePipeline(
    device: GPUDevice,
    code: string,
    bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
    entryPoint: string | null = "main"
  ): GPUComputePipeline {
    const descriptor: CachedComputePipelineDescriptor = {
      label: "",
      layout: { label: "", bindGroupLayouts },
      compute: {
        module: { label: "", code },
        ...(entryPoint === null ? {} : { entryPoint })
      }
    };
    return this.graphics.compute_pipelines.obtain(descriptor);
  }

  private obtainBindGroup(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    groupIndex: number,
    layout: GPUBindGroupLayoutDescriptor,
    entries: readonly GPUBindGroupEntry[]
  ): GPUBindGroup {
    const resources = entries
      .slice()
      .sort((left, right) => left.binding - right.binding)
      .map((entry) => entry.resource);
    return this.graphics.bind_groups.obtain({ layout, entries: resources });
  }
  private _count = 0;
  private _capacity = 0;
  private _lastUnculled = 0;
  private _lastCulled = 0;
  private _hzbActive = false;
  private _expandedListBuffer: GPUBuffer | null = null;
  lastHzbCullRan = false;
  private _instanceCullActive = false;
  lastInstanceCullRan = false;
  lastExpandRan = false;
  lastDispatchIndirectUsed = false;
  lastSecondChancePrepared = false;
  lastDualMaybeRan = false;
  lastMeshletDualMaybeRan = false;
  lastGpuSpRan = false;
  lastBlellochScanRan = false;
  lastBucketExtractRan = false;
  lastBucketScatterRan = false;
  lastBucketSliceRan = false;
  lastMeshletBucketScatterRan = false;
  lastMeshletBucketSliceRan = false;
  private _meshListCount = 0;
  private _meshListCapacity = 0;
  private _meshletCapacityBound = 0;

  private readonly cullResolutionData = new Uint32Array(2);

  listBuffer: GPUBuffer | null = null;
  positiveBuffer: GPUBuffer | null = null;
  meshletMaybeBuffer: GPUBuffer | null = null;
  argsBuffer: GPUBuffer | null = null;
  private cullResolutionBuffer: GPUBuffer | null = null;
  meshListBuffer: GPUBuffer | null = null;
  meshPositiveBuffer: GPUBuffer | null = null;
  meshMaybeBuffer: GPUBuffer | null = null;
  meshExtractBuffer: GPUBuffer | null = null;
  bucketCountsBuffer: GPUBuffer | null = null;
  bucketDataBuffer: GPUBuffer | null = null;
  meshletBucketDataBuffer: GPUBuffer | null = null;
  countsBuffer: GPUBuffer | null = null;
  spineBuffer: GPUBuffer | null = null;
  dispatchArgsBuffer: GPUBuffer | null = null;
  private dispatchCountScratchBuffer: GPUBuffer | null = null;

  private fillArgsPipeline: GPUComputePipeline | null = null;
  private fillArgsBindGroup: GPUBindGroup | null = null;
  private hzbCullPipeline: GPUComputePipeline | null = null;
  private hzbCullSecondPipeline: GPUComputePipeline | null = null;
  private hzbCullDualPipeline: GPUComputePipeline | null = null;
  private hzbCullCounterPipeline: GPUComputePipeline | null = null;
  private hzbCullSecondCounterPipeline: GPUComputePipeline | null = null;
  private hzbCullDualCounterPipeline: GPUComputePipeline | null = null;
  private expandPipeline: GPUComputePipeline | null = null;
  private instanceCullPipeline: GPUComputePipeline | null = null;
  private instanceCullDualPipeline: GPUComputePipeline | null = null;
  private expandCountsPipeline: GPUComputePipeline | null = null;
  private prefixScanPipeline: GPUComputePipeline | null = null;
  private expandDispatchPipeline: GPUComputePipeline | null = null;
  private expandCommitPipeline: GPUComputePipeline | null = null;
  private kaRaPipeline: GPUComputePipeline | null = null;
  private kaGaPipeline: GPUComputePipeline | null = null;
  private kaJaPipeline: GPUComputePipeline | null = null;
  private kaUbPipeline: GPUComputePipeline | null = null;
  private meshletQbPipeline: GPUComputePipeline | null = null;
  private meshletJbPipeline: GPUComputePipeline | null = null;
  private meshletBucketSlicePipeline: GPUComputePipeline | null = null;
  private _maybeActive = false;
  private _bucketExtractActive = false;
  private _bucketScatterReady = false;
  private _meshletBucketScatterReady = false;


  get count(): number {
    return this._count;
  }

  get lastUnculledCount(): number {
    return this._lastUnculled;
  }

  get lastCulledCount(): number {
    return this._lastCulled;
  }

  get hzbCullActive(): boolean {
    return this._hzbActive;
  }

  get instanceCullActive(): boolean {
    return this._instanceCullActive;
  }

  get maybeActive(): boolean {
    return this._maybeActive;
  }

  get meshListCount(): number {
    return this._meshListCount;
  }

  get meshletCapacityBound(): number {
    return this._meshletCapacityBound;
  }

  get elementsByteOffset(): number {
    return MESHLET_LIST_ELEMENTS_OFFSET;
  }

  get elementsByteSize(): number {
    return Math.max(MESHLET_INSTANCE_STRIDE_BYTES, this._count * MESHLET_INSTANCE_STRIDE_BYTES);
  }

  clear(): void {
    this._count = 0;
    this._lastUnculled = 0;
    this._lastCulled = 0;
    this._hzbActive = false;
    this._expandedListBuffer = null;
    this.lastHzbCullRan = false;
    this._instanceCullActive = false;
    this.lastInstanceCullRan = false;
    this.lastExpandRan = false;
    this.lastDispatchIndirectUsed = false;
    this.lastSecondChancePrepared = false;
    this.lastDualMaybeRan = false;
    this.lastMeshletDualMaybeRan = false;
    this.lastGpuSpRan = false;
    this.lastBlellochScanRan = false;
    this.lastBucketExtractRan = false;
    this.lastBucketScatterRan = false;
    this.lastBucketSliceRan = false;
    this.lastMeshletBucketScatterRan = false;
    this.lastMeshletBucketSliceRan = false;
    this._maybeActive = false;
    this._bucketExtractActive = false;
    this._bucketScatterReady = false;
    this._meshletBucketScatterReady = false;
    this._meshListCount = 0;
    this._meshletCapacityBound = 0;
  }

  beginVisibilityCycle(
    command: ShadeGPUCommandContext,
    table: MeshletGpuTable,
    sceneDb: SceneDatabase
  ): void {
    this.beginResourceCycle(command);
    const encoder = command.gpu_encoder;
    const device = command.device;
    let meshletUpperBound = 0;
    const rows = sceneDb.meshCount;
    for (let row = 0; row < rows; row++) {
      const metadata = sceneMeshGeometryMeta(table, sceneDb, row);
      if (
        !metadata ||
        metadata.meshlet_count <= 0 ||
        (metadata.flags & 1) === 0
      ) {
        continue;
      }
      meshletUpperBound += metadata.meshlet_count;
    }
    this.reserveMeshCapacity(Math.max(rows, 1));
    this.reserveMeshletCapacity(Math.max(meshletUpperBound, 1));
    this.ensureBuffers(device, "MeshletDrawList/visibility-cycle");
    if (this.meshMaybeBuffer) {
      encoder.clearBuffer(this.meshMaybeBuffer, 0, MESH_LIST_ELEMENTS_OFFSET);
    }
    if (this.meshletMaybeBuffer) {
      encoder.clearBuffer(
        this.meshletMaybeBuffer,
        0,
        MESHLET_LIST_ELEMENTS_OFFSET
      );
    }
    this.lastDualMaybeRan = false;
    this.lastMeshletDualMaybeRan = false;
    this._maybeActive = false;
  }

  /** 准备遮挡不确定对象的二次可见性检测，复用首轮裁剪产生的候选列表。 */
  prepareSecondChance(cmd: {
    device: GPUDevice;
    insertDebugMarker?: (label: string) => void;
  }): boolean {
    this.lastSecondChancePrepared = false;
    this.ensureBuffers(cmd.device, "MeshletDrawList/second-chance");
    cmd.insertDebugMarker?.("MeshletDrawList/second-chance-prepare");

    this._hzbActive = false;
    this._expandedListBuffer = null;
    this.lastHzbCullRan = false;
    this._instanceCullActive = false;
    this.lastInstanceCullRan = false;
    this.lastExpandRan = false;
    this.lastDispatchIndirectUsed = false;
    this.lastBucketExtractRan = false;
    this.lastBucketScatterRan = false;
    this.lastBucketSliceRan = false;
    this.lastMeshletBucketScatterRan = false;
    this.lastMeshletBucketSliceRan = false;
    this._bucketExtractActive = false;
    this._meshletBucketScatterReady = false;
    this.fillArgsBindGroup = null;

    this._maybeActive = !!this.meshMaybeBuffer;

    this._count = this._meshletCapacityBound;

    this.lastSecondChancePrepared = true;
    return true;
  }

  /** 为场景网格过滤阶段分配并清理输出缓冲区。 */
  prepareGpuMeshFilterOutput(
    table: MeshletGpuTable,
    sceneDb: SceneDatabase,
    meshCount: number,
    device: GPUDevice,
    encoder: GPUCommandEncoder
  ): GPUBuffer | null {
    let meshletUpperBound = 0;
    for (let row = 0; row < meshCount; row++) {
      const metadata = sceneMeshGeometryMeta(table, sceneDb, row);
      if (!metadata || metadata.meshlet_count <= 0 || (metadata.flags & 1) === 0) {
        continue;
      }
      meshletUpperBound += metadata.meshlet_count;
    }

    this._meshListCount = meshCount;
    this._count = meshletUpperBound;
    this._meshletCapacityBound = meshletUpperBound;
    this._lastUnculled = meshCount;
    this._lastCulled = 0;
    this._hzbActive = false;
    this._expandedListBuffer = null;
    this.lastHzbCullRan = false;
    this._instanceCullActive = false;
    this.lastInstanceCullRan = false;
    this.lastExpandRan = false;
    this.lastDispatchIndirectUsed = false;
    this.lastSecondChancePrepared = false;
    this.lastDualMaybeRan = false;
    this.lastMeshletDualMaybeRan = false;
    this.lastGpuSpRan = false;
    this.lastBlellochScanRan = false;
    this.lastBucketExtractRan = false;
    this.lastBucketScatterRan = false;
    this.lastBucketSliceRan = false;
    this.lastMeshletBucketScatterRan = false;
    this.lastMeshletBucketSliceRan = false;
    this._maybeActive = false;
    this._bucketExtractActive = false;
    this._bucketScatterReady = false;
    this._meshletBucketScatterReady = false;

    this.reserveMeshCapacity(Math.max(meshCount, 1));
    this.reserveMeshletCapacity(Math.max(meshletUpperBound, 1));
    this.ensureBuffers(device, "MeshletDrawList/gpu-mesh-filter");
    if (!this.meshListBuffer) return null;
    encoder.clearBuffer(this.meshListBuffer, 0, MESH_LIST_ELEMENTS_OFFSET);
    return this.meshListBuffer;
  }

  private reserveMeshletCapacity(n: number): void {
    if (n <= this._capacity) return;
    this._capacity = Math.max(n, 16, this._capacity * 2);
  }

  private reserveMeshCapacity(n: number): void {
    if (n <= this._meshListCapacity) return;
    this._meshListCapacity = Math.max(n, 16, this._meshListCapacity * 2);
  }

  private beginResourceCycle(command: ShadeGPUCommandContext): void {
    if (this.resourceCommand === command) {
      this.releaseResourceBuffers();
      return;
    }
    this.releaseResourceBuffers();
    this.resourceCommand = command;
    command.onFinished.addOne(() => {
      if (this.resourceCommand !== command) return;
      this.releaseResourceBuffers();
      this.resourceCommand = null;
    });
  }

  private ensureBuffer(
    current: GPUBuffer | null,
    size: number,
    usage: GPUBufferUsageFlags
  ): GPUBuffer {
    if (
      current !== null &&
      current.size >= size &&
      (current.usage & usage) === usage
    ) {
      return current;
    }
    if (current !== null) {
      this.graphics.buffer_allocator_main.release(current);
    }
    return this.graphics.buffer_allocator_main.get({ size, usage });
  }

  private releaseResourceBuffers(): void {
    const allocator = this.graphics.buffer_allocator_main;
    const buffers = [
      this.listBuffer,
      this.positiveBuffer,
      this.meshletMaybeBuffer,
      this.argsBuffer,
      this.cullResolutionBuffer,
      this.meshListBuffer,
      this.meshPositiveBuffer,
      this.meshMaybeBuffer,
      this.meshExtractBuffer,
      this.bucketCountsBuffer,
      this.bucketDataBuffer,
      this.meshletBucketDataBuffer,
      this.countsBuffer,
      this.spineBuffer,
      this.dispatchArgsBuffer,
      this.dispatchCountScratchBuffer
    ];
    for (const buffer of buffers) {
      if (buffer !== null) allocator.release(buffer);
    }
    this.listBuffer = null;
    this.positiveBuffer = null;
    this.meshletMaybeBuffer = null;
    this.argsBuffer = null;
    this.cullResolutionBuffer = null;
    this.meshListBuffer = null;
    this.meshPositiveBuffer = null;
    this.meshMaybeBuffer = null;
    this.meshExtractBuffer = null;
    this.bucketCountsBuffer = null;
    this.bucketDataBuffer = null;
    this.meshletBucketDataBuffer = null;
    this.countsBuffer = null;
    this.spineBuffer = null;
    this.dispatchArgsBuffer = null;
    this.dispatchCountScratchBuffer = null;
    this._expandedListBuffer = null;
    this.fillArgsBindGroup = null;
  }

  private ensureBuffers(_device: GPUDevice, _labelPrefix: string): void {
    const listBytes = Math.max(
      MESHLET_LIST_ELEMENTS_OFFSET + MESHLET_INSTANCE_STRIDE_BYTES,
      MESHLET_LIST_ELEMENTS_OFFSET +
        Math.max(this._count, this._capacity) * MESHLET_INSTANCE_STRIDE_BYTES
    );
    const listUsage =
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC;
    this.listBuffer = this.ensureBuffer(this.listBuffer, listBytes, listUsage);
    this.positiveBuffer = this.ensureBuffer(
      this.positiveBuffer,
      listBytes,
      listUsage
    );
    this.meshletMaybeBuffer = this.ensureBuffer(
      this.meshletMaybeBuffer,
      listBytes,
      listUsage
    );
    this.argsBuffer = this.ensureBuffer(
      this.argsBuffer,
      DRAW_INDIRECT_ARGS_BYTES,
      GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE
    );
    this.cullResolutionBuffer = this.ensureBuffer(
      this.cullResolutionBuffer,
      8,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );

    const meshListBytes = Math.max(
      MESH_LIST_ELEMENTS_OFFSET + 4,
      MESH_LIST_ELEMENTS_OFFSET +
        Math.max(this._meshListCount, this._meshListCapacity) * 4
    );
    this.meshListBuffer = this.ensureBuffer(
      this.meshListBuffer,
      meshListBytes,
      listUsage
    );
    this.meshPositiveBuffer = this.ensureBuffer(
      this.meshPositiveBuffer,
      meshListBytes,
      listUsage
    );
    this.meshMaybeBuffer = this.ensureBuffer(
      this.meshMaybeBuffer,
      meshListBytes,
      listUsage
    );
    this.meshExtractBuffer = this.ensureBuffer(
      this.meshExtractBuffer,
      meshListBytes,
      listUsage
    );
    const scratchUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.bucketCountsBuffer = this.ensureBuffer(
      this.bucketCountsBuffer,
      MESHLET_KA_COUNTS_BYTES,
      scratchUsage
    );
    const kaElementCapacity = Math.max(
      1,
      this._meshListCount,
      this._meshListCapacity
    );
    const kaDataBytes = MESHLET_KA_HEADERS_BYTES + kaElementCapacity * 4;
    this.bucketDataBuffer = this.ensureBuffer(
      this.bucketDataBuffer,
      kaDataBytes,
      scratchUsage | GPUBufferUsage.COPY_SRC
    );
    const qbElementCapacity = Math.max(
      1,
      this._count,
      this._capacity,
      this._meshletCapacityBound
    );
    const qbDataBytes =
      MESHLET_QB_HEADERS_BYTES +
      qbElementCapacity * MESHLET_INSTANCE_STRIDE_BYTES;
    this.meshletBucketDataBuffer = this.ensureBuffer(
      this.meshletBucketDataBuffer,
      qbDataBytes,
      scratchUsage | GPUBufferUsage.COPY_SRC
    );
    const scanElementCapacity = Math.max(
      1,
      this._meshListCapacity,
      this._meshListCount
    );
    const countsBytes =
      MESH_LIST_ELEMENTS_OFFSET +
      Math.ceil(scanElementCapacity / 4) * 16;
    this.countsBuffer = this.ensureBuffer(
      this.countsBuffer,
      countsBytes,
      scratchUsage
    );
    const scanTileCapacity = Math.max(
      1,
      Math.ceil(scanElementCapacity / MESHLET_PREFIX_SCAN_TILE_SIZE)
    );
    const spineBytes =
      Math.ceil((scanTileCapacity * 8) / 1024) * 1024;
    this.spineBuffer = this.ensureBuffer(
      this.spineBuffer,
      spineBytes,
      scratchUsage
    );
    this.dispatchArgsBuffer = this.ensureBuffer(
      this.dispatchArgsBuffer,
      DISPATCH_INDIRECT_ARGS_BYTES,
      GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE
    );
    this.dispatchCountScratchBuffer = this.ensureBuffer(
      this.dispatchCountScratchBuffer,
      4,
      scratchUsage
    );
  }

  private activeMeshListBuffer(): GPUBuffer | null {
    if (this._instanceCullActive && this.meshPositiveBuffer) {
      return this.meshPositiveBuffer;
    }
    if (this._maybeActive && this.meshMaybeBuffer) {
      return this.meshMaybeBuffer;
    }
    if (this._bucketExtractActive && this.meshExtractBuffer) {
      return this.meshExtractBuffer;
    }
    return this.meshListBuffer;
  }

  private instanceCullInputBuffer(inputFromMaybe?: boolean): GPUBuffer | null {
    if (inputFromMaybe && this.meshMaybeBuffer) {
      return this.meshMaybeBuffer;
    }
    if (this._bucketExtractActive && this.meshExtractBuffer) {
      return this.meshExtractBuffer;
    }
    return this.meshListBuffer;
  }

  private activeListBuffer(): GPUBuffer | null {
    if (this._hzbActive && this.positiveBuffer) return this.positiveBuffer;
    return this._expandedListBuffer ?? this.listBuffer;
  }

  get elementsBuffer(): GPUBuffer | null {
    return this.activeListBuffer();
  }

  get elementsBufferSize(): number {
    const b = this.activeListBuffer();
    return b?.size ?? 0;
  }


  private ensureFillPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.fillArgsPipeline) return this.fillArgsPipeline;
    this.fillArgsPipeline = this.obtainComputePipeline(
      device,
      FILL_DRAW_INDIRECT_ARGS_WGSL,
      [FILL_ARGS_GROUP]
    );
    return this.fillArgsPipeline;
  }

  private dispatchFillDispatchArgs(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    countBuffer: GPUBuffer,
    countOffset: number,
    elementsPerWorkgroup: number,
    _writeBuffer?: (
      buffer: GPUBuffer,
      offset: number,
      data: ArrayBuffer | ArrayBufferView
    ) => void
  ): boolean {
    if (!this.dispatchArgsBuffer) {
      this.ensureBuffers(device, "MeshletDrawList");
    }
    if (!this.dispatchArgsBuffer) return false;

    let alignedCountBuffer = countBuffer;
    let alignedCountOffset = countOffset;
    const storageAlignment = device.limits.minStorageBufferOffsetAlignment;
    if (countOffset % storageAlignment !== 0) {
      if (!this.dispatchCountScratchBuffer) return false;
      encoder.copyBufferToBuffer(
        countBuffer,
        countOffset,
        this.dispatchCountScratchBuffer,
        0,
        4
      );
      alignedCountBuffer = this.dispatchCountScratchBuffer;
      alignedCountOffset = 0;
    }

    const pipeline = obtainFillDispatchPipeline(
      device,
      elementsPerWorkgroup,
      this.graphics
    );
    const bg = this.obtainBindGroup(device, pipeline, 0, FILL_ARGS_GROUP, [
      {
        binding: 0,
        resource: {
          buffer: alignedCountBuffer,
          offset: alignedCountOffset,
          size: 4
        }
      },
      {
        binding: 1,
        resource: {
          buffer: this.dispatchArgsBuffer,
          offset: 0,
          size: DISPATCH_INDIRECT_ARGS_BYTES
        }
      }
    ]);
    const pass = encoder.beginComputePass({
      label: "MeshletDrawList/fill_dispatch_eg"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
    return true;
  }

  private dispatchIndirectFromCount(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    countBuffer: GPUBuffer,
    countOffset: number,
    elementsPerWorkgroup: number,
    passLabel: string
  ): boolean {
    const usedIndirect = this.dispatchFillDispatchArgs(
      encoder,
      device,
      countBuffer,
      countOffset,
      elementsPerWorkgroup
    );
    if (!usedIndirect || !this.dispatchArgsBuffer) return false;
    const pass = encoder.beginComputePass({ label: passLabel });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  private ensureHzbCullPipeline(
    device: GPUDevice,
    withCounters: boolean
  ): GPUComputePipeline {
    if (withCounters) {
      if (this.hzbCullCounterPipeline) return this.hzbCullCounterPipeline;
      this.hzbCullCounterPipeline = this.obtainComputePipeline(
        device,
        MESHLET_HZB_CULL_COUNTER_WGSL,
        HZB_CULL_COUNTER_GROUPS
      );
      return this.hzbCullCounterPipeline;
    }
    if (this.hzbCullPipeline) return this.hzbCullPipeline;
    this.hzbCullPipeline = this.obtainComputePipeline(
      device,
      MESHLET_HZB_CULL_WGSL,
      HZB_CULL_GROUPS
    );
    return this.hzbCullPipeline;
  }

  private ensureHzbCullSecondPipeline(
    device: GPUDevice,
    withCounters: boolean
  ): GPUComputePipeline {
    if (withCounters) {
      if (this.hzbCullSecondCounterPipeline) {
        return this.hzbCullSecondCounterPipeline;
      }
      this.hzbCullSecondCounterPipeline = this.obtainComputePipeline(
        device,
        MESHLET_HZB_CULL_SECOND_COUNTER_WGSL,
        HZB_CULL_SECOND_COUNTER_GROUPS
      );
      return this.hzbCullSecondCounterPipeline;
    }
    if (this.hzbCullSecondPipeline) return this.hzbCullSecondPipeline;
    this.hzbCullSecondPipeline = this.obtainComputePipeline(
      device,
      MESHLET_HZB_CULL_SECOND_WGSL,
      HZB_CULL_SECOND_GROUPS
    );
    return this.hzbCullSecondPipeline;
  }

  private ensureHzbCullDualPipeline(
    device: GPUDevice,
    withCounters: boolean
  ): GPUComputePipeline {
    if (withCounters) {
      if (this.hzbCullDualCounterPipeline) {
        return this.hzbCullDualCounterPipeline;
      }
      this.hzbCullDualCounterPipeline = this.obtainComputePipeline(
        device,
        MESHLET_HZB_CULL_DUAL_COUNTER_WGSL,
        HZB_CULL_DUAL_COUNTER_GROUPS
      );
      return this.hzbCullDualCounterPipeline;
    }
    if (this.hzbCullDualPipeline) return this.hzbCullDualPipeline;
    this.hzbCullDualPipeline = this.obtainComputePipeline(
      device,
      MESHLET_HZB_CULL_DUAL_WGSL,
      HZB_CULL_DUAL_GROUPS
    );
    return this.hzbCullDualPipeline;
  }

  private ensureExpandPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.expandPipeline) return this.expandPipeline;
    this.expandPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESHLET_EXPAND_WGSL,
      EXPAND_GROUPS,
      null
    );
    return this.expandPipeline;
  }

  private ensureInstanceCullPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.instanceCullPipeline) return this.instanceCullPipeline;
    this.instanceCullPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESH_INSTANCE_CULL_WGSL,
      INSTANCE_CULL_GROUPS,
      null
    );
    return this.instanceCullPipeline;
  }

  private ensureInstanceCullDualPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.instanceCullDualPipeline) return this.instanceCullDualPipeline;
    this.instanceCullDualPipeline = this.obtainComputePipeline(
      device,
      MESH_INSTANCE_CULL_DUAL_WGSL,
      INSTANCE_CULL_DUAL_GROUPS
    );
    return this.instanceCullDualPipeline;
  }

  private ensureKaRaPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.kaRaPipeline) return this.kaRaPipeline;
    this.kaRaPipeline = this.obtainComputePipeline(device, MESHLET_KA_RA_WGSL, KA_RA_GROUPS);
    return this.kaRaPipeline;
  }

  private ensureKaGaPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.kaGaPipeline) return this.kaGaPipeline;
    this.kaGaPipeline = this.obtainComputePipeline(device, MESHLET_KA_GA_WGSL, KA_GA_GROUPS);
    return this.kaGaPipeline;
  }

  private ensureKaJaPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.kaJaPipeline) return this.kaJaPipeline;
    this.kaJaPipeline = this.obtainComputePipeline(device, MESHLET_KA_JA_WGSL, KA_JA_GROUPS);
    return this.kaJaPipeline;
  }

  private ensureKaUbPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.kaUbPipeline) return this.kaUbPipeline;
    this.kaUbPipeline = this.obtainComputePipeline(device, MESHLET_KA_UB_WGSL, KA_UB_GROUPS);
    return this.kaUbPipeline;
  }

  private ensureMeshletQbPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.meshletQbPipeline) return this.meshletQbPipeline;
    this.meshletQbPipeline = this.obtainComputePipeline(device, MESHLET_QB_COUNT_WGSL, QB_COUNT_GROUPS);
    return this.meshletQbPipeline;
  }

  private ensureMeshletJbPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.meshletJbPipeline) return this.meshletJbPipeline;
    this.meshletJbPipeline = this.obtainComputePipeline(device, MESHLET_QB_SCATTER_WGSL, QB_SCATTER_GROUPS);
    return this.meshletJbPipeline;
  }

  private ensureMeshletBucketSlicePipeline(
    device: GPUDevice
  ): GPUComputePipeline {
    if (this.meshletBucketSlicePipeline) {
      return this.meshletBucketSlicePipeline;
    }
    this.meshletBucketSlicePipeline = this.obtainComputePipeline(
      device,
      MESHLET_QB_SLICE_WGSL,
      QB_SLICE_GROUPS
    );
    return this.meshletBucketSlicePipeline;
  }

  dispatchBucketScatter(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      sceneDatabaseBuffer: GPUBuffer;
      materialsBuffer: GPUBuffer;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastBucketScatterRan = false;
    this._bucketScatterReady = false;
    if (
      this._meshListCount <= 0 ||
      !this.meshListBuffer ||
      !opts.materialsBuffer
    ) {
      return false;
    }

    this.ensureBuffers(device, "MeshletDrawList");
    if (
      !this.bucketCountsBuffer ||
      !this.bucketDataBuffer
    ) {
      return false;
    }

    encoder.clearBuffer(this.bucketCountsBuffer, 0, MESHLET_KA_COUNTS_BYTES);
    encoder.clearBuffer(this.bucketDataBuffer, 0, MESHLET_KA_HEADERS_BYTES);
    const ra = this.ensureKaRaPipeline(device);
    const raGroup0 = this.obtainBindGroup(device, ra, 0, KA_RA_GROUPS[0], [
        { binding: 0, resource: { buffer: opts.sceneDatabaseBuffer } },
        { binding: 1, resource: { buffer: opts.materialsBuffer } },
    ]);
    const raGroup1 = this.obtainBindGroup(device, ra, 1, KA_RA_GROUPS[1], [
        { binding: 0, resource: { buffer: this.meshListBuffer } },
        { binding: 1, resource: { buffer: this.bucketCountsBuffer } }
    ]);
    const raDispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      this.meshListBuffer,
      0,
      MESHLET_KA_EPW,
      opts.writeBuffer
    );
    if (!raDispatchReady || !this.dispatchArgsBuffer) return false;
    const raPass = encoder.beginComputePass({ label: "MeshletDrawList/ka_ra" });
    raPass.setPipeline(ra);
    raPass.setBindGroup(0, raGroup0);
    raPass.setBindGroup(1, raGroup1);
    raPass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    raPass.end();

    const ga = this.ensureKaGaPipeline(device);
    const gaBg = this.obtainBindGroup(device, ga, 0, KA_GA_GROUPS[0], [
      { binding: 0, resource: { buffer: this.bucketCountsBuffer } }
    ]);
    const gaPass = encoder.beginComputePass({
      label: "MeshletDrawList/ka_ga"
    });
    gaPass.setPipeline(ga);
    gaPass.setBindGroup(0, gaBg);
    gaPass.dispatchWorkgroups(1);
    gaPass.end();

    const ja = this.ensureKaJaPipeline(device);
    const jaGroup0 = this.obtainBindGroup(device, ja, 0, KA_JA_GROUPS[0], [
        { binding: 0, resource: { buffer: opts.sceneDatabaseBuffer } },
        { binding: 1, resource: { buffer: opts.materialsBuffer } }
    ]);
    const jaGroup1 = this.obtainBindGroup(device, ja, 1, KA_JA_GROUPS[1], [
        { binding: 0, resource: { buffer: this.meshListBuffer } },
        { binding: 1, resource: { buffer: this.bucketCountsBuffer } },
        { binding: 2, resource: { buffer: this.bucketDataBuffer } }
    ]);
    const jaPass = encoder.beginComputePass({ label: "MeshletDrawList/ka_ja" });
    jaPass.setPipeline(ja);
    jaPass.setBindGroup(0, jaGroup0);
    jaPass.setBindGroup(1, jaGroup1);
    jaPass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    jaPass.end();

    this._bucketScatterReady = true;
    this.lastBucketScatterRan = true;
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  prepareBucketPassFromScatter(): void {
    this._hzbActive = false;
    this._expandedListBuffer = null;
    this.lastHzbCullRan = false;
    this._instanceCullActive = false;
    this.lastInstanceCullRan = false;
    this.lastExpandRan = false;
    this.lastDispatchIndirectUsed = false;
    this.lastDualMaybeRan = false;
    this.lastMeshletDualMaybeRan = false;
    this.lastGpuSpRan = false;
    this.lastBlellochScanRan = false;
    this._maybeActive = false;
    this._bucketExtractActive = false;
    this.fillArgsBindGroup = null;

  }

  dispatchBucketSlice(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      command: ShadeGPUCommandContext;
      bucketId: number;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastBucketSliceRan = false;
    this._bucketExtractActive = false;
    if (
      !this._bucketScatterReady ||
      !this.bucketDataBuffer ||
      !this.meshExtractBuffer
    ) {
      return false;
    }

    this.ensureBuffers(device, "MeshletDrawList");
    if (
      !this.meshExtractBuffer ||
      !this.bucketDataBuffer
    ) {
      return false;
    }

    this.prepareBucketPassFromScatter();

    const bucketParamsBuffer = opts.command.allocateTransientValueBuffer(
      BUCKET_VALUE_PARAMS_TYPE,
      { value: opts.bucketId >>> 0 }
    );

    encoder.clearBuffer(this.meshExtractBuffer, 0, MESH_LIST_ELEMENTS_OFFSET);

    const pipeline = this.ensureKaUbPipeline(device);
    const bg = this.obtainBindGroup(device, pipeline, 0, KA_UB_GROUPS[0], [
        { binding: 0, resource: { buffer: bucketParamsBuffer } },
        { binding: 1, resource: { buffer: this.bucketDataBuffer } },
        { binding: 2, resource: { buffer: this.meshExtractBuffer } }
    ]);

    const dispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      this.bucketDataBuffer,
      opts.bucketId * MESHLET_KA_HEADER_STRIDE_BYTES,
      MESHLET_KA_EPW,
      opts.writeBuffer
    );
    if (!dispatchReady || !this.dispatchArgsBuffer) return false;
    const pass = encoder.beginComputePass({
      label: `MeshletDrawList/ka_ub_b${opts.bucketId}`
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();

    this._bucketExtractActive = true;
    this.lastBucketSliceRan = true;
    this.lastBucketExtractRan = true;
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  dispatchMeshletBucketScatter(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      sceneDatabaseBuffer: GPUBuffer;
      materialsBuffer: GPUBuffer;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastMeshletBucketScatterRan = false;
    this._meshletBucketScatterReady = false;
    this.ensureBuffers(device, "MeshletDrawList/second-buckets");

    const inputBuffer = this.activeListBuffer();
    if (
      !inputBuffer ||
      !this.bucketCountsBuffer ||
      !this.meshletBucketDataBuffer
    ) {
      return false;
    }

    encoder.clearBuffer(this.bucketCountsBuffer, 0, MESHLET_KA_COUNTS_BYTES);
    encoder.clearBuffer(
      this.meshletBucketDataBuffer,
      0,
      MESHLET_QB_HEADERS_BYTES
    );

    const dispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      inputBuffer,
      0,
      MESHLET_QB_EPW,
      opts.writeBuffer
    );
    if (!dispatchReady || !this.dispatchArgsBuffer) return false;

    const qb = this.ensureMeshletQbPipeline(device);
    const qbGroup = this.obtainBindGroup(device, qb, 0, QB_COUNT_GROUPS[0], [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: opts.sceneDatabaseBuffer } },
        { binding: 2, resource: { buffer: opts.materialsBuffer } },
        { binding: 3, resource: { buffer: this.bucketCountsBuffer } }
    ]);
    const qbPass = encoder.beginComputePass({
      label: "MeshletDrawList/qb_count"
    });
    qbPass.setPipeline(qb);
    qbPass.setBindGroup(0, qbGroup);
    qbPass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    qbPass.end();

    const ga = this.ensureKaGaPipeline(device);
    const gaGroup = this.obtainBindGroup(device, ga, 0, KA_GA_GROUPS[0], [
        { binding: 0, resource: { buffer: this.bucketCountsBuffer } }
    ]);
    const gaPass = encoder.beginComputePass({
      label: "MeshletDrawList/qb_ga"
    });
    gaPass.setPipeline(ga);
    gaPass.setBindGroup(0, gaGroup);
    gaPass.dispatchWorkgroups(1);
    gaPass.end();

    const jb = this.ensureMeshletJbPipeline(device);
    const jbGroup = this.obtainBindGroup(device, jb, 0, QB_SCATTER_GROUPS[0], [
        { binding: 0, resource: { buffer: opts.sceneDatabaseBuffer } },
        { binding: 1, resource: { buffer: opts.materialsBuffer } },
        { binding: 2, resource: { buffer: inputBuffer } },
        { binding: 3, resource: { buffer: this.bucketCountsBuffer } },
        { binding: 4, resource: { buffer: this.meshletBucketDataBuffer } }
    ]);
    const jbPass = encoder.beginComputePass({
      label: "MeshletDrawList/jb_scatter"
    });
    jbPass.setPipeline(jb);
    jbPass.setBindGroup(0, jbGroup);
    jbPass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    jbPass.end();

    this._meshletBucketScatterReady = true;
    this.lastMeshletBucketScatterRan = true;
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  dispatchMeshletBucketSlice(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      command: ShadeGPUCommandContext;
      bucketId: number;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastMeshletBucketSliceRan = false;
    if (
      !this._meshletBucketScatterReady ||
      !this.meshletBucketDataBuffer ||
      !this.listBuffer
    ) {
      return false;
    }

    const bucketParamsBuffer = opts.command.allocateTransientValueBuffer(
      BUCKET_VALUE_PARAMS_TYPE,
      { value: opts.bucketId >>> 0 }
    );
    encoder.clearBuffer(this.listBuffer, 0, MESHLET_LIST_ELEMENTS_OFFSET);

    const dispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      this.meshletBucketDataBuffer,
      opts.bucketId * MESHLET_QB_HEADER_STRIDE_BYTES,
      MESHLET_QB_EPW,
      opts.writeBuffer
    );
    if (!dispatchReady || !this.dispatchArgsBuffer) return false;

    const pipeline = this.ensureMeshletBucketSlicePipeline(device);
    const group = this.obtainBindGroup(device, pipeline, 0, QB_SLICE_GROUPS[0], [
        { binding: 0, resource: { buffer: bucketParamsBuffer } },
        { binding: 1, resource: { buffer: this.meshletBucketDataBuffer } },
        { binding: 2, resource: { buffer: this.listBuffer } }
    ]);
    const pass = encoder.beginComputePass({
      label: `MeshletDrawList/meshlet_ub_b${opts.bucketId}`
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();

    this._hzbActive = false;
    this._expandedListBuffer = this.listBuffer;
    this._instanceCullActive = false;
    this.fillArgsBindGroup = null;
    this.lastMeshletBucketSliceRan = true;
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  dispatchInstanceCullDual(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      command: ShadeGPUCommandContext;
      bucketId: number;
      previousCameraBuffer: GPUBuffer;
      sceneDatabaseBuffer: GPUBuffer;
      hzbView: GPUTextureView;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastInstanceCullRan = false;
    this.lastDualMaybeRan = false;
    if (
      this._meshListCount <= 0 ||
      !this._bucketScatterReady ||
      !this.bucketDataBuffer ||
      !this.meshPositiveBuffer ||
      !this.meshMaybeBuffer
    ) {
      return false;
    }

    this.ensureBuffers(device, "MeshletDrawList");
    if (!this.bucketDataBuffer) return false;

    const bucketParamsBuffer = opts.command.allocateTransientValueBuffer(
      BUCKET_VALUE_PARAMS_TYPE,
      { value: opts.bucketId >>> 0 }
    );

    encoder.clearBuffer(
      this.meshPositiveBuffer,
      0,
      MESH_LIST_ELEMENTS_OFFSET
    );

    const pipeline = this.ensureInstanceCullDualPipeline(device);
    const group0 = this.obtainBindGroup(device, pipeline, 0, INSTANCE_CULL_DUAL_GROUPS[0], [
        { binding: 0, resource: { buffer: bucketParamsBuffer } },
        { binding: 1, resource: { buffer: this.bucketDataBuffer } }
    ]);
    const group1 = this.obtainBindGroup(device, pipeline, 1, INSTANCE_CULL_DUAL_GROUPS[1], [
        { binding: 0, resource: { buffer: opts.previousCameraBuffer } },
        { binding: 1, resource: opts.hzbView }
    ]);
    const group2 = this.obtainBindGroup(device, pipeline, 2, INSTANCE_CULL_DUAL_GROUPS[2], [
        { binding: 0, resource: { buffer: opts.sceneDatabaseBuffer } }
    ]);
    const group3 = this.obtainBindGroup(device, pipeline, 3, INSTANCE_CULL_DUAL_GROUPS[3], [
        { binding: 0, resource: { buffer: this.meshPositiveBuffer } },
        { binding: 1, resource: { buffer: this.meshMaybeBuffer } }
    ]);

    const dispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      this.bucketDataBuffer,
      opts.bucketId * MESHLET_KA_HEADER_STRIDE_BYTES,
      DISPATCH_EPW_CULL,
      opts.writeBuffer
    );
    if (!dispatchReady || !this.dispatchArgsBuffer) return false;
    const pass = encoder.beginComputePass({
      label: "MeshletDrawList/instance_cull_dual_hb"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.setBindGroup(2, group2);
    pass.setBindGroup(3, group3);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();

    this._instanceCullActive = true;
    this._maybeActive = false;
    this.lastInstanceCullRan = true;
    this.lastDualMaybeRan = true;
    this.lastDispatchIndirectUsed = true;
    return true;
  }

  dispatchInstanceCull(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      cameraBuffer: GPUBuffer;
      sceneDatabaseBuffer: GPUBuffer;
      hzbView: GPUTextureView;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      inputFromMaybe?: boolean;
    }
  ): boolean {
    this.lastInstanceCullRan = false;
    this.ensureBuffers(device, "MeshletDrawList");
    const inputBuf = this.instanceCullInputBuffer(opts.inputFromMaybe === true);
    if (!inputBuf || !this.meshPositiveBuffer) {
      return false;
    }

    encoder.clearBuffer(
      this.meshPositiveBuffer,
      0,
      MESH_LIST_ELEMENTS_OFFSET
    );

    const pipeline = this.ensureInstanceCullPipeline(device);
    const bg = this.obtainBindGroup(device, pipeline, 0, INSTANCE_CULL_GROUPS[0], [
      { binding: 0, resource: { buffer: inputBuf } },
      { binding: 1, resource: { buffer: this.meshPositiveBuffer } },
      { binding: 2, resource: { buffer: opts.cameraBuffer } },
      { binding: 3, resource: { buffer: opts.sceneDatabaseBuffer } },
      { binding: 4, resource: opts.hzbView }
    ]);

    const dispatched = this.dispatchIndirectFromCount(
      encoder,
      device,
      pipeline,
      bg,
      inputBuf,
      0,
      DISPATCH_EPW_CULL,
      opts.inputFromMaybe
        ? "MeshletDrawList/instance_cull_hg_maybe"
        : "MeshletDrawList/instance_cull_ug"
    );
    if (!dispatched) return false;

    this._instanceCullActive = true;
    if (opts.inputFromMaybe) {
      this._maybeActive = false;
    }
    this.lastInstanceCullRan = true;
    return true;
  }

  private ensureExpandCountsPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.expandCountsPipeline) return this.expandCountsPipeline;
    this.expandCountsPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESHLET_EXPAND_COUNTS_WGSL,
      EXPAND_COUNTS_GROUPS,
      null
    );
    return this.expandCountsPipeline;
  }

  private ensurePrefixScanPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.prefixScanPipeline) return this.prefixScanPipeline;
    this.prefixScanPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESHLET_PREFIX_SCAN_WGSL,
      PREFIX_SCAN_GROUPS,
      null
    );
    return this.prefixScanPipeline;
  }

  private ensureExpandDispatchPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.expandDispatchPipeline) return this.expandDispatchPipeline;
    this.expandDispatchPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESHLET_EXPAND_DISPATCH_WGSL,
      EXPAND_DISPATCH_GROUPS,
      null
    );
    return this.expandDispatchPipeline;
  }

  private ensureExpandCommitPipeline(device: GPUDevice): GPUComputePipeline {
    if (this.expandCommitPipeline) return this.expandCommitPipeline;
    this.expandCommitPipeline = this.obtainComputePipeline(
      device,
      ORACLE_MESHLET_EXPAND_COMMIT_WGSL,
      EXPAND_COMMIT_GROUPS,
      null
    );
    return this.expandCommitPipeline;
  }

  dispatchExpandGpuSp(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    sceneDatabaseBuffer: GPUBuffer,
    meshMetaBuffer: GPUBuffer,
    writeBuffer?: (
      buffer: GPUBuffer,
      offset: number,
      data: ArrayBuffer | ArrayBufferView
    ) => void,
    opts?: { appendToMeshletMaybe?: boolean }
  ): boolean {
    this.lastGpuSpRan = false;
    this.lastBlellochScanRan = false;
    this.lastExpandRan = false;

    this.ensureBuffers(device, "MeshletDrawList");
    const meshSrc = this.activeMeshListBuffer();
    if (!meshSrc) {
      return false;
    }
    if (
      !this.countsBuffer ||
      !this.spineBuffer ||
      !this.dispatchArgsBuffer
    ) {
      return false;
    }
    const outputBuffer = opts?.appendToMeshletMaybe
      ? this.meshletMaybeBuffer
      : this.listBuffer;
    if (!outputBuffer) return false;

    encoder.clearBuffer(this.countsBuffer);
    encoder.clearBuffer(this.spineBuffer);
    if (!opts?.appendToMeshletMaybe) {
      encoder.clearBuffer(outputBuffer, 0, MESHLET_LIST_ELEMENTS_OFFSET);
    }

    const epDispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      meshSrc,
      0,
      DISPATCH_EPW_CULL,
      writeBuffer
    );
    if (!epDispatchReady) {
      return false;
    }

    const countsPipeline = this.ensureExpandCountsPipeline(device);
    const countsGroup0 = this.obtainBindGroup(device, countsPipeline, 0, EXPAND_COUNTS_GROUPS[0], [
      { binding: 0, resource: { buffer: sceneDatabaseBuffer } },
      { binding: 1, resource: { buffer: meshMetaBuffer } }
    ]);
    const countsGroup1 = this.obtainBindGroup(device, countsPipeline, 1, EXPAND_COUNTS_GROUPS[1], [
      { binding: 0, resource: { buffer: meshSrc } },
      { binding: 1, resource: { buffer: this.countsBuffer } }
    ]);
    {
      const pass = encoder.beginComputePass({
        label: "MeshletDrawList/ep-counts"
      });
      pass.setPipeline(countsPipeline);
      pass.setBindGroup(0, countsGroup0);
      pass.setBindGroup(1, countsGroup1);
      pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
      pass.end();
    }

    const scanDispatchReady = this.dispatchFillDispatchArgs(
      encoder,
      device,
      this.countsBuffer,
      0,
      MESHLET_PREFIX_SCAN_TILE_SIZE,
      writeBuffer
    );
    if (!scanDispatchReady) {
      return false;
    }
    const scanPipeline = this.ensurePrefixScanPipeline(device);
    const scanGroup = this.obtainBindGroup(device, scanPipeline, 0, PREFIX_SCAN_GROUPS[0], [
      { binding: 0, resource: { buffer: this.countsBuffer } },
      { binding: 1, resource: { buffer: this.spineBuffer } }
    ]);
    {
      const pass = encoder.beginComputePass({
        label: "MeshletDrawList/og-prefix"
      });
      pass.setPipeline(scanPipeline);
      pass.setBindGroup(0, scanGroup);
      pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
      pass.end();
    }

    const dispatchPipeline = this.ensureExpandDispatchPipeline(device);
    const dispatchGroup = this.obtainBindGroup(device, dispatchPipeline, 0, EXPAND_DISPATCH_GROUPS[0], [
      { binding: 0, resource: { buffer: this.countsBuffer } },
      { binding: 1, resource: { buffer: this.dispatchArgsBuffer } }
    ]);
    {
      const pass = encoder.beginComputePass({
        label: "MeshletDrawList/rp-dispatch"
      });
      pass.setPipeline(dispatchPipeline);
      pass.setBindGroup(0, dispatchGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    const expandPipeline = this.ensureExpandPipeline(device);
    const expandGroup0 = this.obtainBindGroup(device, expandPipeline, 0, EXPAND_GROUPS[0], [
      { binding: 0, resource: { buffer: this.countsBuffer } }
    ]);
    const expandGroup1 = this.obtainBindGroup(device, expandPipeline, 1, EXPAND_GROUPS[1], [
      { binding: 0, resource: { buffer: sceneDatabaseBuffer } },
      { binding: 1, resource: { buffer: meshMetaBuffer } }
    ]);
    const expandGroup2 = this.obtainBindGroup(device, expandPipeline, 2, EXPAND_GROUPS[2], [
      { binding: 0, resource: { buffer: meshSrc } },
      { binding: 1, resource: { buffer: outputBuffer } }
    ]);
    {
      const pass = encoder.beginComputePass({
        label: "MeshletDrawList/$g-expand"
      });
      pass.setPipeline(expandPipeline);
      pass.setBindGroup(0, expandGroup0);
      pass.setBindGroup(1, expandGroup1);
      pass.setBindGroup(2, expandGroup2);
      pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
      pass.end();
    }

    const commitPipeline = this.ensureExpandCommitPipeline(device);
    const commitGroup = this.obtainBindGroup(device, commitPipeline, 0, EXPAND_COMMIT_GROUPS[0], [
      { binding: 0, resource: { buffer: this.countsBuffer } },
      {
        binding: 1,
        resource: { buffer: outputBuffer, offset: 0, size: 4 }
      }
    ]);
    {
      const pass = encoder.beginComputePass({
        label: "MeshletDrawList/Yg-commit"
      });
      pass.setPipeline(commitPipeline);
      pass.setBindGroup(0, commitGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    this.lastExpandRan = true;
    this.lastGpuSpRan = true;
    this.lastBlellochScanRan = true;
    this.lastDispatchIndirectUsed = true;
    this._hzbActive = false;
    this._expandedListBuffer = outputBuffer;
    this.fillArgsBindGroup = null;
    this._count = this._meshletCapacityBound;
    return true;
  }

  dispatchExpand(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    sceneDatabaseBuffer: GPUBuffer,
    meshMetaBuffer: GPUBuffer,
    writeBuffer?: (
      buffer: GPUBuffer,
      offset: number,
      data: ArrayBuffer | ArrayBufferView
    ) => void,
    opts?: { appendToMeshletMaybe?: boolean }
  ): boolean {
    return this.dispatchExpandGpuSp(
      encoder,
      device,
      sceneDatabaseBuffer,
      meshMetaBuffer,
      writeBuffer,
      opts
    );
  }

  dispatchHzbCullDual(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      currentCameraBuffer: GPUBuffer;
      previousCameraBuffer: GPUBuffer;
      viewBuffer: GPUBuffer;
      sceneDatabaseBuffer: GPUBuffer;
      meshletHeaders: GPUBuffer;
      hzbView: GPUTextureView;
      gpuCounterBuffer?: GPUBuffer | null;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
    }
  ): boolean {
    this.lastHzbCullRan = false;
    this.lastMeshletDualMaybeRan = false;
    const inputBuffer = this._expandedListBuffer ?? this.listBuffer;
    if (
      this._count <= 0 ||
      !inputBuffer ||
      !this.positiveBuffer ||
      !this.meshletMaybeBuffer
    ) {
      return false;
    }

    this.ensureBuffers(device, "MeshletDrawList");

    encoder.clearBuffer(this.positiveBuffer, 0, MESHLET_LIST_ELEMENTS_OFFSET);

    const withCounters = opts.gpuCounterBuffer !== null &&
      opts.gpuCounterBuffer !== undefined;
    const pipeline = this.ensureHzbCullDualPipeline(device, withCounters);
    const group0 = this.obtainBindGroup(device, pipeline, 0, HZB_CULL_DUAL_GROUPS[0], [
        { binding: 0, resource: { buffer: opts.currentCameraBuffer } },
        { binding: 1, resource: { buffer: opts.previousCameraBuffer } },
        { binding: 2, resource: { buffer: opts.viewBuffer } },
        { binding: 3, resource: { buffer: opts.sceneDatabaseBuffer } },
        { binding: 4, resource: { buffer: opts.meshletHeaders } },
        { binding: 5, resource: opts.hzbView }
    ]);
    const group1 = this.obtainBindGroup(device, pipeline, 1, HZB_CULL_DUAL_GROUPS[1], [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: this.positiveBuffer } },
        { binding: 2, resource: { buffer: this.meshletMaybeBuffer } }
    ]);
    const counterGroup = withCounters
      ? this.obtainBindGroup(
          device,
          pipeline,
          2,
          HZB_CULL_DUAL_COUNTER_GROUPS[2],
          [{ binding: 0, resource: { buffer: opts.gpuCounterBuffer! } }]
        )
      : null;

    const usedIndirect = this.dispatchFillDispatchArgs(
      encoder,
      device,
      inputBuffer,
      0,
      DISPATCH_EPW_CULL,
      opts.writeBuffer
    );
    if (!usedIndirect || !this.dispatchArgsBuffer) return false;
    const pass = encoder.beginComputePass({
      label: "MeshletDrawList/hzb_cull_dual_yb"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    if (counterGroup) pass.setBindGroup(2, counterGroup);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();

    this._hzbActive = true;
    this.lastHzbCullRan = true;
    this.lastMeshletDualMaybeRan = true;
    this.lastDispatchIndirectUsed = true;
    this.fillArgsBindGroup = null;
    return true;
  }

  dispatchHzbCull(
    encoder: GPUCommandEncoder,
    device: GPUDevice,
    opts: {
      cameraBuffer: GPUBuffer;
      sceneDatabaseBuffer: GPUBuffer;
      resolutionW: number;
      resolutionH: number;
      meshletHeaders: GPUBuffer;
      hzbView: GPUTextureView;
      gpuCounterBuffer?: GPUBuffer | null;
      writeBuffer: (
        buffer: GPUBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView
      ) => void;
      secondChance?: boolean;
    }
  ): boolean {
    this.lastHzbCullRan = false;
    const inputBuffer = this._expandedListBuffer ?? this.listBuffer;
    if (
      this._count <= 0 ||
      !inputBuffer ||
      !this.positiveBuffer
    ) {
      return false;
    }

    this.ensureBuffers(device, "MeshletDrawList");
    if (!opts.secondChance) {
      if (!this.cullResolutionBuffer) return false;
      this.cullResolutionData[0] = opts.resolutionW >>> 0;
      this.cullResolutionData[1] = opts.resolutionH >>> 0;
      opts.writeBuffer(
        this.cullResolutionBuffer,
        0,
        this.cullResolutionData
      );
    }

    encoder.clearBuffer(this.positiveBuffer, 0, MESHLET_LIST_ELEMENTS_OFFSET);

    const withCounters = opts.gpuCounterBuffer !== null &&
      opts.gpuCounterBuffer !== undefined;
    const pipeline = opts.secondChance
      ? this.ensureHzbCullSecondPipeline(device, withCounters)
      : this.ensureHzbCullPipeline(device, withCounters);
    const usedIndirect = this.dispatchFillDispatchArgs(
      encoder,
      device,
      inputBuffer,
      0,
      DISPATCH_EPW_CULL,
      opts.writeBuffer
    );
    if (!usedIndirect || !this.dispatchArgsBuffer) return false;

    const activeGroups = opts.secondChance
      ? HZB_CULL_SECOND_GROUPS
      : HZB_CULL_GROUPS;
    const group0 = this.obtainBindGroup(device, pipeline, 0, activeGroups[0], opts.secondChance
        ? [
            { binding: 0, resource: { buffer: opts.cameraBuffer } },
            {
              binding: 1,
              resource: { buffer: opts.sceneDatabaseBuffer }
            },
            { binding: 2, resource: { buffer: opts.meshletHeaders } },
            { binding: 3, resource: opts.hzbView }
          ]
        : [
            { binding: 0, resource: { buffer: opts.cameraBuffer } },
            {
              binding: 1,
              resource: { buffer: this.cullResolutionBuffer! }
            },
            {
              binding: 2,
              resource: { buffer: opts.sceneDatabaseBuffer }
            },
            { binding: 3, resource: { buffer: opts.meshletHeaders } },
            { binding: 4, resource: opts.hzbView }
          ]);
    const group1 = this.obtainBindGroup(device, pipeline, 1, activeGroups[1], opts.secondChance
        ? [{ binding: 0, resource: { buffer: inputBuffer } }]
        : [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: this.positiveBuffer } }
          ]);
    const group2 = opts.secondChance
      ? this.obtainBindGroup(device, pipeline, 2, HZB_CULL_SECOND_GROUPS[2], [
          { binding: 0, resource: { buffer: this.positiveBuffer } }
        ])
      : null;
    const counterGroupIndex = opts.secondChance ? 3 : 2;
    const counterGroups = opts.secondChance
      ? HZB_CULL_SECOND_COUNTER_GROUPS
      : HZB_CULL_COUNTER_GROUPS;
    const counterGroup = withCounters
      ? this.obtainBindGroup(
          device,
          pipeline,
          counterGroupIndex,
          counterGroups[counterGroupIndex]!,
          [{ binding: 0, resource: { buffer: opts.gpuCounterBuffer! } }]
        )
      : null;
    const pass = encoder.beginComputePass({
      label: opts.secondChance
        ? "MeshletDrawList/hzb_cull_ob"
        : "MeshletDrawList/hzb_cull_ig"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    if (group2) pass.setBindGroup(2, group2);
    if (counterGroup) pass.setBindGroup(counterGroupIndex, counterGroup);
    pass.dispatchWorkgroupsIndirect(this.dispatchArgsBuffer, 0);
    pass.end();

    this._hzbActive = true;
    this.lastHzbCullRan = true;
    this.lastDispatchIndirectUsed = true;
    this.fillArgsBindGroup = null;
    return true;
    return true;
  }

  dispatchFillDrawIndirectArgs(encoder: GPUCommandEncoder, device: GPUDevice): void {
    const list = this.activeListBuffer();
    if (!list || !this.argsBuffer) return;
    const pipeline = this.ensureFillPipeline(device);
    const bg = this.obtainBindGroup(device, pipeline, 0, FILL_ARGS_GROUP, [
      {
        binding: 0,
        resource: { buffer: list, offset: 0, size: 4 }
      },
      {
        binding: 1,
        resource: {
          buffer: this.argsBuffer,
          offset: 0,
          size: DRAW_INDIRECT_ARGS_BYTES
        }
      }
    ]);
    this.fillArgsBindGroup = bg;
    const pass = encoder.beginComputePass({
      label: "MeshletDrawList/fill_draw_indirect_args"
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  destroy(): void {
    this.releaseResourceBuffers();
    this.resourceCommand = null;
    this.fillArgsPipeline = null;
    this.fillArgsBindGroup = null;
    this.hzbCullPipeline = null;
    this.hzbCullSecondPipeline = null;
    this.hzbCullDualPipeline = null;
    this.hzbCullCounterPipeline = null;
    this.hzbCullSecondCounterPipeline = null;
    this.hzbCullDualCounterPipeline = null;
    this.expandPipeline = null;
    this.instanceCullPipeline = null;
    this.instanceCullDualPipeline = null;
    this.expandCountsPipeline = null;
    this.prefixScanPipeline = null;
    this.expandDispatchPipeline = null;
    this.expandCommitPipeline = null;
    this.kaRaPipeline = null;
    this.kaGaPipeline = null;
    this.kaJaPipeline = null;
    this.kaUbPipeline = null;
    this.meshletQbPipeline = null;
    this.meshletJbPipeline = null;
    this.meshletBucketSlicePipeline = null;
    this.clear();
  }
}
