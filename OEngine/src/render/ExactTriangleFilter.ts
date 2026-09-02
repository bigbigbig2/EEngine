import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_DISPATCH_INDIRECT_ARGS_SIZE,
  GPU_DRAW_INDIRECT_ARGS_SIZE,
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
  classifiedRasterWorkBufferByteLength,
  packClassifiedRasterWorkHeaders
} from "../gpu/GpuWorkGenerationAbi.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";
import {
  EXACT_TRIANGLE_FILTER_SETTINGS_SIZE,
  EXACT_TRIANGLE_FILTER_WGSL
} from "../shaders/exact_triangle_filter.js";

const PREPARED_EXACT_FILTER_BRAND: unique symbol = Symbol("OEngine.PreparedExactTriangleFilter");

export interface ExactTriangleFilterInputs {
  readonly camera: GPUBuffer;
  readonly candidates: GPUBuffer;
  readonly candidateCapacity: number;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly counterBuffer: GPUBuffer;
  readonly countersEnabled: boolean;
}

export interface ExactTriangleFilterOutput {
  /** Two 32 B class headers followed by OPAQUE then MASK exact records. */
  readonly rasterWork: GPUBuffer;
  readonly classCapacity: number;
  readonly totalCapacity: number;
  /** Two consecutive 16 B drawIndirect records: OPAQUE then MASK. */
  readonly drawIndirect: GPUBuffer;
  readonly opaqueDrawOffset: 0;
  readonly maskDrawOffset: 16;
}

export interface PreparedExactTriangleFilter {
  readonly [PREPARED_EXACT_FILTER_BRAND]: true;
  readonly output: ExactTriangleFilterOutput;
}

interface PreparedState {
  readonly settings: GPUBuffer;
  readonly dispatchIndirect: GPUBuffer;
  readonly rasterWork: GPUBuffer;
  readonly drawIndirect: GPUBuffer;
  readonly filterGroup: GPUBindGroup;
  readonly drawGroup: GPUBindGroup;
  readonly dispatchGroup: GPUBindGroup;
  readonly candidateCapacity: number;
  readonly countersEnabled: boolean;
  readonly buffers: readonly GPUBuffer[];
  destroyed: boolean;
}

const PREPARED_STATE = new WeakMap<object, PreparedState>();

/** Owns the SelectedCluster-expanded candidate → exact OPAQUE/MASK compact stage. */
export class ExactTriangleFilter {
  private readonly filterPipeline: GPUComputePipeline;
  private readonly drawPipeline: GPUComputePipeline;
  private readonly dispatchPipeline: GPUComputePipeline;
  private readonly filterLayout: GPUBindGroupLayout;
  private readonly drawLayout: GPUBindGroupLayout;
  private readonly dispatchLayout: GPUBindGroupLayout;
  private readonly prepared = new Set<PreparedExactTriangleFilter>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({
      label: "Exact triangle filter/compact",
      code: EXACT_TRIANGLE_FILTER_WGSL
    });
    this.filterLayout = device.createBindGroupLayout({
      label: "Exact triangle filter group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: EXACT_TRIANGLE_FILTER_SETTINGS_SIZE } },
        ...Array.from({ length: 8 }, (_, index) => ({
          binding: index + 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: index === 1 ? "storage" as GPUBufferBindingType : "read-only-storage" as GPUBufferBindingType
          }
        }))
      ]
    });
    this.drawLayout = device.createBindGroupLayout({
      label: "Exact triangle filter draw preparation group1",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_CLASSIFIED_RASTER_HEADER_BYTES + GPU_RASTER_WORK_SCHEMA.stride } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DRAW_INDIRECT_ARGS_SIZE * 2 } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: EXACT_TRIANGLE_FILTER_SETTINGS_SIZE } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_RASTER_WORK_SCHEMA.stride } }
      ]
    });
    this.dispatchLayout = device.createBindGroupLayout({
      label: "Exact triangle filter dispatch preparation group2",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: EXACT_TRIANGLE_FILTER_SETTINGS_SIZE } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_RASTER_WORK_SCHEMA.stride } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_DISPATCH_INDIRECT_ARGS_SIZE } }
      ]
    });
    const empty = device.createBindGroupLayout({ label: "Exact triangle filter empty group", entries: [] });
    this.filterPipeline = device.createComputePipeline({
      label: "Exact triangle filter/compact",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.filterLayout] }),
      compute: { module, entryPoint: "exact_triangle_filter" }
    });
    this.drawPipeline = device.createComputePipeline({
      label: "Exact triangle filter prepare OPAQUE/MASK draws",
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, this.drawLayout] }),
      compute: { module, entryPoint: "prepare_classified_draws" }
    });
    this.dispatchPipeline = device.createComputePipeline({
      label: "Exact triangle filter prepare dispatch",
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, empty, this.dispatchLayout] }),
      compute: { module, entryPoint: "prepare_triangle_filter_dispatch" }
    });
  }

  prepare(inputs: ExactTriangleFilterInputs): PreparedExactTriangleFilter {
    this.assertAlive();
    assertPositiveU32(inputs.candidateCapacity, "Exact triangle candidate capacity");
    const outputBytes = classifiedRasterWorkBufferByteLength(inputs.candidateCapacity);
    validateStorageSize(this.device, outputBytes, "classified RasterWork");
    const buffers: GPUBuffer[] = [];
    try {
      const settings = this.createBuffer({
        label: "Exact triangle filter settings",
        size: EXACT_TRIANGLE_FILTER_SETTINGS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }, buffers);
      const dispatchIndirect = this.createInitializedBuffer({
        label: "Exact triangle filter dispatchIndirect",
        size: GPU_DISPATCH_INDIRECT_ARGS_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      }, new Uint8Array(new Uint32Array([0, 1, 1]).buffer), buffers);
      const rasterWork = this.createInitializedBuffer({
        label: "Exact OPAQUE/MASK RasterWork",
        size: outputBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      }, packClassifiedRasterWorkHeaders(inputs.candidateCapacity), buffers);
      const drawIndirect = this.createInitializedBuffer({
        label: "Exact OPAQUE/MASK drawIndirect",
        size: GPU_DRAW_INDIRECT_ARGS_SIZE * 2,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      }, new Uint8Array(new Uint32Array([0, 1, 0, 0, 0, 1, inputs.candidateCapacity * 3, 0]).buffer), buffers);
      const filterGroup = this.device.createBindGroup({
        label: "Exact triangle filter bindings",
        layout: this.filterLayout,
        entries: [
          { binding: 0, resource: { buffer: inputs.camera } },
          { binding: 1, resource: { buffer: settings } },
          { binding: 2, resource: { buffer: inputs.candidates } },
          { binding: 3, resource: { buffer: rasterWork } },
          { binding: 4, resource: { buffer: inputs.scene.instances } },
          { binding: 5, resource: { buffer: inputs.assets.geometryRecords } },
          { binding: 6, resource: { buffer: inputs.assets.meshletRecords } },
          { binding: 7, resource: { buffer: inputs.assets.meshletVertexIndices } },
          { binding: 8, resource: { buffer: inputs.assets.meshletTriangleIndices } },
          { binding: 9, resource: { buffer: inputs.assets.vertexStreamData } }
        ]
      });
      const drawGroup = this.device.createBindGroup({
        label: "Exact triangle draw preparation bindings",
        layout: this.drawLayout,
        entries: [
          { binding: 0, resource: { buffer: rasterWork } },
          { binding: 1, resource: { buffer: drawIndirect } },
          { binding: 2, resource: { buffer: inputs.counterBuffer } },
          { binding: 3, resource: { buffer: settings } },
          { binding: 4, resource: { buffer: inputs.candidates } }
        ]
      });
      const dispatchGroup = this.device.createBindGroup({
        label: "Exact triangle dispatch preparation bindings",
        layout: this.dispatchLayout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: inputs.candidates } },
          { binding: 2, resource: { buffer: dispatchIndirect } }
        ]
      });
      const output = Object.freeze({
        rasterWork,
        classCapacity: inputs.candidateCapacity,
        totalCapacity: inputs.candidateCapacity * 2,
        drawIndirect,
        opaqueDrawOffset: 0 as const,
        maskDrawOffset: GPU_DRAW_INDIRECT_ARGS_SIZE as 16
      });
      const prepared = Object.freeze({
        [PREPARED_EXACT_FILTER_BRAND]: true as const,
        output
      });
      PREPARED_STATE.set(prepared as object, {
        settings,
        dispatchIndirect,
        rasterWork,
        drawIndirect,
        filterGroup,
        drawGroup,
        dispatchGroup,
        candidateCapacity: inputs.candidateCapacity,
        countersEnabled: inputs.countersEnabled,
        buffers,
        destroyed: false
      });
      this.prepared.add(prepared);
      return prepared;
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    prepared: PreparedExactTriangleFilter,
    width: number,
    height: number
  ): ExactTriangleFilterOutput {
    const state = this.requirePrepared(prepared);
    assertPositiveU32(width, "Exact triangle filter width");
    assertPositiveU32(height, "Exact triangle filter height");
    const settings = new Uint32Array(8);
    settings[0] = width;
    settings[1] = height;
    settings[2] = state.candidateCapacity;
    settings[3] = state.candidateCapacity;
    settings[4] = Number(this.device.limits.maxComputeWorkgroupsPerDimension);
    settings[5] = state.countersEnabled ? 1 : 0;
    writeGpuBuffer(this.device.queue, "ExactTriangleFilter/settings", state.settings, 0, settings);
    clearQueueCounters(encoder, state.rasterWork, 0);
    clearQueueCounters(encoder, state.rasterWork, GPU_WORK_QUEUE_HEADER_SCHEMA.stride);
    encoder.clearBuffer(state.dispatchIndirect, 0, GPU_DISPATCH_INDIRECT_ARGS_SIZE);
    encoder.clearBuffer(state.drawIndirect, 0, GPU_DRAW_INDIRECT_ARGS_SIZE * 2);

    const prepareDispatch = encoder.beginComputePass({ label: "Exact triangle filter/prepare dispatch" });
    prepareDispatch.setPipeline(this.dispatchPipeline);
    prepareDispatch.setBindGroup(2, state.dispatchGroup);
    prepareDispatch.dispatchWorkgroups(1, 1, 1);
    prepareDispatch.end();

    const filter = encoder.beginComputePass({ label: "Exact triangle filter/compact OPAQUE+MASK" });
    filter.setPipeline(this.filterPipeline);
    filter.setBindGroup(0, state.filterGroup);
    filter.dispatchWorkgroupsIndirect(state.dispatchIndirect, 0);
    filter.end();

    const prepareDraws = encoder.beginComputePass({ label: "Exact triangle filter/prepare draws" });
    prepareDraws.setPipeline(this.drawPipeline);
    prepareDraws.setBindGroup(1, state.drawGroup);
    prepareDraws.dispatchWorkgroups(1, 1, 1);
    prepareDraws.end();
    return prepared.output;
  }

  release(prepared: PreparedExactTriangleFilter): void {
    const state = this.requirePrepared(prepared);
    state.destroyed = true;
    for (const buffer of state.buffers) buffer.destroy();
    PREPARED_STATE.delete(prepared as object);
    this.prepared.delete(prepared);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const prepared of [...this.prepared]) this.release(prepared);
    this.destroyed = true;
  }

  private createBuffer(descriptor: GPUBufferDescriptor, buffers: GPUBuffer[]): GPUBuffer {
    const buffer = this.device.createBuffer(descriptor);
    buffers.push(buffer);
    return buffer;
  }

  private createInitializedBuffer(
    descriptor: GPUBufferDescriptor,
    initial: Uint8Array,
    buffers: GPUBuffer[]
  ): GPUBuffer {
    const buffer = this.device.createBuffer({ ...descriptor, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(initial);
    buffer.unmap();
    buffers.push(buffer);
    return buffer;
  }

  private requirePrepared(prepared: PreparedExactTriangleFilter): PreparedState {
    this.assertAlive();
    const state = PREPARED_STATE.get(prepared as object);
    if (state === undefined || state.destroyed) {
      throw new Error("ExactTriangleFilter prepared state is stale or foreign");
    }
    return state;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("ExactTriangleFilter is destroyed");
  }
}

function clearQueueCounters(
  encoder: GPUCommandEncoder,
  buffer: GPUBuffer,
  byteOffset: number
): void {
  encoder.clearBuffer(buffer, byteOffset, GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.capacity!);
  encoder.clearBuffer(
    buffer,
    byteOffset + GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.rejected_cone!,
    GPU_WORK_QUEUE_HEADER_SCHEMA.stride - GPU_WORK_QUEUE_HEADER_SCHEMA.offsets.rejected_cone!
  );
}

function validateStorageSize(device: GPUDevice, bytes: number, label: string): void {
  const limit = Math.min(
    Number(device.limits.maxBufferSize),
    Number(device.limits.maxStorageBufferBindingSize)
  );
  if (bytes > limit) throw new RangeError(`${label} requires ${bytes} bytes but limit is ${limit}`);
}

function assertPositiveU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
}
