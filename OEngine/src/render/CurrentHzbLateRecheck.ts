import {
  hzbLevelDimensions,
  isReverseZOccluded,
  sanitizeReverseZDepth,
  type HzbLevel
} from "./HzbReference.js";
import type { ResourceAccounting, ResourceHandle as AccountingResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import { GPU_INSTANCE_RECORD_STRIDE } from "../gpu/GpuInstanceAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY } from "../gpu/GpuVisibilityKeyAbi.js";
import type { GeometryProductGpuBindingsV1 } from "../gpu/VirtualGeometryResidency.js";
import { PACKED_CAMERA_TYPE } from "../shaders/packed_camera.js";
import { CURRENT_HZB_MESHLET_WORK_LATE_RECHECK_WGSL } from "../shaders/current_hzb_late_recheck.js";

/** Phase I bounded late-recheck hint ABI. The normal VisibilityKey ABI is unchanged. */
export const CURRENT_HZB_LATE_RECHECK_ABI_VERSION = 1;
export const CURRENT_HZB_LATE_RECHECK_RECORD_STRIDE = 32;
export const CURRENT_HZB_LATE_RECHECK_HEADER_STRIDE = 32;
/** CPU-oracle candidate ceiling; this is not the production MeshletWork ceiling. */
export const CURRENT_HZB_LATE_RECHECK_MAX_CAPACITY = 65_536;
export const CURRENT_HZB_MESHLET_WORK_MAX_CAPACITY =
  GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY;
export const CURRENT_HZB_MESHLET_SETTINGS_BYTES = 32;

const PREPARED_CURRENT_HZB_RECHECK = Symbol("PreparedCurrentHzbLateRecheck");

export interface PreparedCurrentHzbLateRecheck {
  readonly [PREPARED_CURRENT_HZB_RECHECK]: true;
  readonly sourceQueue: GPUBuffer;
  readonly queue: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly capacity: number;
  readonly generationSource: "meshlet-work-header";
}

interface CurrentHzbGpuState {
  readonly sourceQueue: GPUBuffer;
  readonly queue: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly settings: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly metadata: GPUBuffer;
  readonly banks: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
  readonly camera: GPUBuffer;
  readonly counters: GPUBuffer;
  readonly capacity: number;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
  readonly countersEnabled: boolean;
  readonly accounting: readonly AccountingResourceHandle[];
  readonly hzbGroups: WeakMap<GPUTextureView, GPUBindGroup>;
  destroyed: boolean;
}

const CURRENT_HZB_GPU_STATE = new WeakMap<object, CurrentHzbGpuState>();

export interface CurrentHzbLateRecheckGpuPrepareInput {
  readonly sourceQueue: GPUBuffer;
  readonly capacity: number;
  readonly camera: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly virtualGeometry: GeometryProductGpuBindingsV1;
  readonly productBanks: readonly GPUBuffer[];
  readonly counters: GPUBuffer;
  readonly countersEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly mipLevelCount: number;
}

/** GPU-only Product MeshletWork filter consumed by the same-frame final raster. */
export class CurrentHzbLateRecheckGpu {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: Readonly<{
    prepare: GPUComputePipeline;
    filter: GPUComputePipeline;
    finalize: GPUComputePipeline;
  }>;
  private readonly prepared = new Set<PreparedCurrentHzbLateRecheck>();
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly resourceAccounting?: ResourceAccounting
  ) {
    this.layout = device.createBindGroupLayout({
      label: "ADR-0018 current-HZB Product MeshletWork group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_INSTANCE_RECORD_STRIDE } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
        ...Array.from({ length: 4 }, (_, index) => ({
          binding: index + 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType, minBindingSize: 4 }
        })),
        { binding: 9, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: CURRENT_HZB_MESHLET_SETTINGS_BYTES } },
        { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
        { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } }
      ]
    });
    const module = device.createShaderModule({
      label: "ADR-0018 current-HZB Product MeshletWork shader",
      code: CURRENT_HZB_MESHLET_WORK_LATE_RECHECK_WGSL
    });
    const layout = device.createPipelineLayout({
      label: "ADR-0018 current-HZB Product MeshletWork layout",
      bindGroupLayouts: [this.layout]
    });
    const pipeline = (entryPoint: string): GPUComputePipeline => device.createComputePipeline({
      label: `ADR-0018 current-HZB Product MeshletWork/${entryPoint}`,
      layout,
      compute: { module, entryPoint }
    });
    this.pipelines = Object.freeze({
      prepare: pipeline("prepare_current_hzb_meshlet_recheck"),
      filter: pipeline("filter_current_hzb_meshlet_recheck"),
      finalize: pipeline("finalize_current_hzb_meshlet_recheck")
    });
  }

  prepare(input: CurrentHzbLateRecheckGpuPrepareInput): PreparedCurrentHzbLateRecheck {
    this.assertAlive();
    if (!Number.isSafeInteger(input.capacity) || input.capacity <= 0 ||
        input.capacity > CURRENT_HZB_MESHLET_WORK_MAX_CAPACITY) {
      throw new RangeError("Current HZB MeshletWork capacity is invalid");
    }
    for (const [name, value] of [["width", input.width], ["height", input.height], ["mipLevelCount", input.mipLevelCount]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
        throw new RangeError(`Current HZB ${name} is invalid`);
      }
    }
    if (input.productBanks.length !== 4) {
      throw new Error("Current HZB Product recheck requires four bound page-bank slots");
    }
    const queueBytes = gpuMeshletWorkQueueByteLength(input.capacity);
    const queueByteLimit = Math.min(
      Number(this.device.limits.maxBufferSize),
      Number(this.device.limits.maxStorageBufferBindingSize)
    );
    if (queueBytes > queueByteLimit) {
      throw new RangeError(
        `Current HZB MeshletWork queue requires ${queueBytes} bytes but the negotiated limit is ${queueByteLimit}`
      );
    }
    const accounting: AccountingResourceHandle[] = [];
    const createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = this.device.createBuffer(descriptor);
      const handle = this.resourceAccounting?.created({
        kind: "buffer",
        category: "transient",
        owner: "VisibilityWorkSet/CurrentHzbLateRecheck",
        bytes: Number(descriptor.size),
        label: descriptor.label?.toString()
      });
      if (handle !== undefined) accounting.push(handle);
      return buffer;
    };
    const queue = createBuffer({
      label: "ADR-0018 current-HZB retained MeshletWork queue",
      size: queueBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const drawIndirect = createBuffer({
      label: "ADR-0018 current-HZB retained drawIndirect",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
    });
    const settings = createBuffer({
      label: "ADR-0018 current-HZB late-recheck settings",
      size: CURRENT_HZB_MESHLET_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const bytes = new ArrayBuffer(CURRENT_HZB_MESHLET_SETTINGS_BYTES);
    const view = new DataView(bytes);
    view.setUint32(0, input.width, true);
    view.setUint32(4, input.height, true);
    view.setUint32(8, input.mipLevelCount, true);
    view.setUint32(12, input.capacity, true);
    view.setFloat32(16, 1e-6, true);
    view.setUint32(20, input.countersEnabled ? 1 : 0, true);
    this.device.queue.writeBuffer(settings, 0, bytes);
    const prepared = Object.freeze({
      [PREPARED_CURRENT_HZB_RECHECK]: true as const,
      sourceQueue: input.sourceQueue,
      queue,
      drawIndirect,
      capacity: input.capacity,
      width: input.width,
      height: input.height,
      mipLevelCount: input.mipLevelCount,
      countersEnabled: input.countersEnabled,
      generationSource: "meshlet-work-header" as const
    });
    CURRENT_HZB_GPU_STATE.set(prepared, {
      sourceQueue: input.sourceQueue,
      queue,
      drawIndirect,
      settings,
      instances: input.instances,
      metadata: input.virtualGeometry.metadata,
      banks: input.productBanks as [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer],
      camera: input.camera,
      counters: input.counters,
      capacity: input.capacity,
      width: input.width,
      height: input.height,
      mipLevelCount: input.mipLevelCount,
      countersEnabled: input.countersEnabled,
      accounting: Object.freeze(accounting),
      hzbGroups: new WeakMap(),
      destroyed: false
    });
    this.prepared.add(prepared);
    return prepared;
  }

  matches(prepared: PreparedCurrentHzbLateRecheck, input: CurrentHzbLateRecheckGpuPrepareInput): boolean {
    const state = CURRENT_HZB_GPU_STATE.get(prepared);
    return state !== undefined && !state.destroyed && state.sourceQueue === input.sourceQueue &&
      state.camera === input.camera && state.instances === input.instances &&
      state.metadata === input.virtualGeometry.metadata && state.counters === input.counters &&
      state.capacity === input.capacity && state.width === input.width &&
      state.height === input.height && state.mipLevelCount === input.mipLevelCount &&
      state.countersEnabled === input.countersEnabled &&
      state.banks.every((bank, index) => bank === input.productBanks[index]);
  }

  encode(encoder: GPUCommandEncoder, prepared: PreparedCurrentHzbLateRecheck, currentHzb: GPUTextureView): void {
    const state = this.requireState(prepared);
    let group = state.hzbGroups.get(currentHzb);
    if (group === undefined) {
      group = this.device.createBindGroup({
        label: "ADR-0018 current-HZB Product MeshletWork bindings",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: state.camera } },
          { binding: 1, resource: { buffer: state.instances } },
          { binding: 2, resource: { buffer: state.sourceQueue } },
          { binding: 3, resource: { buffer: state.queue } },
          { binding: 4, resource: { buffer: state.metadata } },
          ...state.banks.map((buffer, index) => ({ binding: index + 5, resource: { buffer } })),
          { binding: 9, resource: currentHzb },
          { binding: 10, resource: { buffer: state.settings } },
          { binding: 11, resource: { buffer: state.drawIndirect } },
          { binding: 12, resource: { buffer: state.counters } }
        ]
      });
      state.hzbGroups.set(currentHzb, group);
    }
    const pass = encoder.beginComputePass({ label: "ADR-0018 current-HZB Product MeshletWork late recheck" });
    pass.setBindGroup(0, group);
    pass.setPipeline(this.pipelines.prepare);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.filter);
    pass.dispatchWorkgroups(Math.ceil(state.capacity / 64));
    pass.setPipeline(this.pipelines.finalize);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  release(prepared: PreparedCurrentHzbLateRecheck): void {
    const state = CURRENT_HZB_GPU_STATE.get(prepared);
    if (state === undefined || state.destroyed) return;
    state.destroyed = true;
    state.queue.destroy();
    state.drawIndirect.destroy();
    state.settings.destroy();
    for (const handle of state.accounting) this.resourceAccounting?.destroyed(handle);
    CURRENT_HZB_GPU_STATE.delete(prepared);
    this.prepared.delete(prepared);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of [...this.prepared]) this.release(prepared);
    this.destroyed = true;
  }

  private requireState(prepared: PreparedCurrentHzbLateRecheck): CurrentHzbGpuState {
    this.assertAlive();
    const state = CURRENT_HZB_GPU_STATE.get(prepared);
    if (state === undefined || state.destroyed) throw new Error("Current HZB late-recheck work is stale");
    return state;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Current HZB late-recheck owner is destroyed");
  }
}

export const CURRENT_HZB_LATE_RECHECK_FLAGS = Object.freeze({
  /** Candidate was uncertain in the previous-HZB traversal. */
  Uncertain: 1 << 0,
  /** Candidate has a large projected/raster cost. */
  Expensive: 1 << 1,
  /** Bounds/depth are conservative enough to preserve image parity. */
  Conservative: 1 << 2
} as const);

export interface CurrentHzbLateRecheckCandidate {
  readonly workSlot: number;
  /** Normalized [minX, minY, maxX, maxY] in the current HZB view. */
  readonly screenRect: readonly [number, number, number, number];
  /** Reverse-Z nearest depth for the conservative candidate bounds. */
  readonly nearestDepth: number;
  /** Vertex invocations that the normal raster route would submit. */
  readonly rasterVertices: number;
  readonly flags: number;
}

export interface CurrentHzbLateRecheckView {
  readonly width: number;
  readonly height: number;
  readonly levels: readonly HzbLevel[];
}

export interface CurrentHzbLateRecheckResult {
  readonly attempted: number;
  readonly retained: number;
  readonly rejected: number;
  readonly invalid: number;
  readonly overflow: number;
  readonly rasterVerticesBefore: number;
  readonly rasterVerticesAfter: number;
  /** False means the bounded optimization must fall back to the source queue. */
  readonly published: boolean;
  readonly imageParity: "preserved" | "unknown";
  readonly records: readonly CurrentHzbLateRecheckCandidate[];
}

/**
 * CPU oracle for the GPU late-recheck policy. It is intentionally independent
 * of the runtime pass: tests can prove conservative rejection and the
 * fail-open overflow behavior without pretending to have browser PERF data.
 */
export function recheckCurrentHzbCandidates(
  candidates: readonly CurrentHzbLateRecheckCandidate[],
  view: CurrentHzbLateRecheckView,
  capacity = candidates.length,
  epsilon = 1e-6
): CurrentHzbLateRecheckResult {
  validateView(view);
  if (!Number.isSafeInteger(capacity) || capacity <= 0 ||
      capacity > CURRENT_HZB_LATE_RECHECK_MAX_CAPACITY) {
    throw new RangeError("Current HZB late-recheck capacity is invalid");
  }
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new RangeError("Current HZB late-recheck epsilon is invalid");
  }

  let attempted = 0;
  let rejected = 0;
  let invalid = 0;
  let rasterVerticesBefore = 0;
  const retained: CurrentHzbLateRecheckCandidate[] = [];
  let imageParity = true;
  for (const candidate of candidates) {
    attempted++;
    rasterVerticesBefore += normalizeRasterVertices(candidate.rasterVertices);
    if (!validCandidate(candidate)) {
      invalid++;
      retained.push(candidate);
      imageParity = false;
      continue;
    }
    const eligible = (candidate.flags &
      (CURRENT_HZB_LATE_RECHECK_FLAGS.Uncertain | CURRENT_HZB_LATE_RECHECK_FLAGS.Expensive)) !== 0;
    const paritySafe = (candidate.flags & CURRENT_HZB_LATE_RECHECK_FLAGS.Conservative) !== 0;
    const occluded = eligible && paritySafe && candidateOccluded(candidate, view, epsilon);
    if (occluded) {
      rejected++;
      continue;
    }
    retained.push(candidate);
  }

  const overflow = Math.max(0, retained.length - capacity);
  if (overflow > 0) {
    // Optional optimization must never publish a partial queue. The caller
    // keeps the source queue and records overflow for the pressure scheduler.
    return Object.freeze({
      attempted,
      retained: candidates.length,
      rejected: 0,
      invalid,
      overflow,
      rasterVerticesBefore,
      rasterVerticesAfter: rasterVerticesBefore,
      published: false,
      imageParity: "preserved",
      records: Object.freeze([...candidates])
    });
  }

  const rasterVerticesAfter = retained.reduce(
    (sum, candidate) => sum + normalizeRasterVertices(candidate.rasterVertices),
    0
  );
  return Object.freeze({
    attempted,
    retained: retained.length,
    rejected,
    invalid,
    overflow: 0,
    rasterVerticesBefore,
    rasterVerticesAfter,
    published: true,
    imageParity: imageParity ? "preserved" : "unknown",
    records: Object.freeze(retained)
  });
}

export function candidateOccludedByCurrentHzb(
  candidate: CurrentHzbLateRecheckCandidate,
  view: CurrentHzbLateRecheckView,
  epsilon = 1e-6
): boolean {
  validateView(view);
  if (!validCandidate(candidate)) return false;
  return candidateOccluded(candidate, view, epsilon);
}

function candidateOccluded(
  candidate: CurrentHzbLateRecheckCandidate,
  view: CurrentHzbLateRecheckView,
  epsilon: number
): boolean {
  const [minX, minY, maxX, maxY] = candidate.screenRect;
  const footprint = Math.max(
    (maxX - minX) * view.width,
    (maxY - minY) * view.height,
    1
  );
  const mip = Math.min(
    Math.max(0, Math.ceil(Math.log2(footprint))),
    view.levels.length - 1
  );
  const [levelWidth, levelHeight] = hzbLevelDimensions(view.width, view.height, mip);
  const level = view.levels[mip]!;
  const points: readonly [number, number][] = [
    [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]
  ];
  let occluderFarthest = 1;
  for (const [x, y] of points) {
    const ix = Math.max(0, Math.min(levelWidth - 1, Math.floor(x * levelWidth)));
    const iy = Math.max(0, Math.min(levelHeight - 1, Math.floor(y * levelHeight)));
    const offset = (iy * levelWidth + ix) * 2;
    occluderFarthest = Math.min(occluderFarthest, sanitizeReverseZDepth(level.minMax[offset]!));
  }
  return isReverseZOccluded(candidate.nearestDepth, occluderFarthest, epsilon);
}

function validCandidate(candidate: CurrentHzbLateRecheckCandidate): boolean {
  if (!Number.isSafeInteger(candidate.workSlot) || candidate.workSlot < 0 ||
      candidate.workSlot > 0xffffffff || !Number.isSafeInteger(candidate.flags) ||
      candidate.flags < 0 || candidate.flags > 0xffffffff ||
      !Number.isFinite(candidate.nearestDepth) ||
      !Number.isFinite(candidate.rasterVertices) || candidate.rasterVertices < 0) {
    return false;
  }
  const [minX, minY, maxX, maxY] = candidate.screenRect;
  return [minX, minY, maxX, maxY].every(Number.isFinite) &&
    minX >= 0 && minY >= 0 && maxX <= 1 && maxY <= 1 &&
    minX < maxX && minY < maxY;
}

function normalizeRasterVertices(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateView(view: CurrentHzbLateRecheckView): void {
  if (!Number.isSafeInteger(view.width) || view.width <= 0 ||
      !Number.isSafeInteger(view.height) || view.height <= 0 ||
      view.levels.length === 0) {
    throw new RangeError("Current HZB late-recheck view is invalid");
  }
  for (const level of view.levels) {
    if (!Number.isSafeInteger(level.width) || level.width <= 0 ||
        !Number.isSafeInteger(level.height) || level.height <= 0 ||
        level.minMax.length < level.width * level.height * 2) {
      throw new RangeError("Current HZB late-recheck level is invalid");
    }
  }
}
