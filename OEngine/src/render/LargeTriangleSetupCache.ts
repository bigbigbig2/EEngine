import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import {
  GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET,
  GPU_TRIANGLE_SETUP_MAX_BYTES,
  GPU_TRIANGLE_SETUP_RECORD_STRIDE
} from "../gpu/GpuExactRasterAbi.js";
import { GPU_MESHLET_RASTER_WORK_RECORD_STRIDE, GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";
import {
  LARGE_TRIANGLE_SETUP_SETTINGS_SIZE,
  LARGE_TRIANGLE_SETUP_WGSL,
  LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE
} from "../shaders/large_triangle_setup.js";

const PREPARED_LARGE_TRIANGLE_SETUP = Symbol("PreparedLargeTriangleSetup");

export interface PreparedLargeTriangleSetup {
  readonly [PREPARED_LARGE_TRIANGLE_SETUP]: true;
  readonly records: GPUBuffer;
  readonly capacity: number;
}

interface State {
  camera: GPUBuffer;
  counters: GPUBuffer;
  countersEnabled: boolean;
  readonly work: GPUBuffer;
  readonly workCapacity: number;
  readonly thresholdPixels: number;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly settings: GPUBuffer;
  readonly records: GPUBuffer;
  group: GPUBindGroup;
  readonly handles: readonly ResourceHandle[];
  destroyed: boolean;
}

const STATES = new WeakMap<object, State>();

/** OptionalOptimization owner; disabling it allocates and encodes nothing. */
export class LargeTriangleSetupCache {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly prepared = new Set<PreparedLargeTriangleSetup>();

  constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting) {
    this.layout = device.createBindGroupLayout({
      label: "ADR-0008 LargeTriangleSetup group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: LARGE_TRIANGLE_SETUP_SETTINGS_SIZE } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } },
        ...Array.from({ length: 6 }, (_, index) => ({
          binding: index + 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType }
        })),
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_TRIANGLE_SETUP_RECORD_STRIDE } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } }
      ]
    });
    const module = device.createShaderModule({
      label: "ADR-0008 LargeTriangleSetup",
      code: LARGE_TRIANGLE_SETUP_WGSL
    });
    this.pipeline = device.createComputePipeline({
      label: "ADR-0008 LargeTriangleSetup/build",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "build_large_triangle_setups" }
    });
  }

  prepare(input: {
    camera: GPUBuffer;
    counters: GPUBuffer;
    countersEnabled: boolean;
    work: GPUBuffer;
    workCapacity: number;
    thresholdPixels: number;
    maxBytes: number;
    assets: GpuAssetBindings;
    scene: GpuSceneBindings;
  }): PreparedLargeTriangleSetup {
    const requested = input.workCapacity * GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET;
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 ||
      (input.maxBytes & 3) !== 0) {
      throw new RangeError("LargeTriangleSetup maxBytes must be a non-negative aligned integer");
    }
    const capacity = Math.min(
      requested,
      Math.floor(Math.min(input.maxBytes, GPU_TRIANGLE_SETUP_MAX_BYTES) /
        GPU_TRIANGLE_SETUP_RECORD_STRIDE)
    );
    if (!Number.isSafeInteger(requested) || capacity <= 0) {
      throw new RangeError("LargeTriangleSetup capacity is invalid");
    }
    const handles: ResourceHandle[] = [];
    const settings = this.createBuffer({
      label: "ADR-0008 LargeTriangleSetup settings",
      size: LARGE_TRIANGLE_SETUP_SETTINGS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    }, handles, "uniform");
    const records = this.createBuffer({
      label: "ADR-0008 optional LargeTriangleSetup dense records",
      size: capacity * GPU_TRIANGLE_SETUP_RECORD_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    }, handles, "work-cache");
    const prepared = Object.freeze({
      [PREPARED_LARGE_TRIANGLE_SETUP]: true as const,
      records,
      capacity
    });
    const state: State = {
      camera: input.camera,
      counters: input.counters,
      countersEnabled: input.countersEnabled,
      work: input.work,
      workCapacity: input.workCapacity,
      thresholdPixels: input.thresholdPixels,
      assets: input.assets,
      scene: input.scene,
      settings,
      records,
      group: null as unknown as GPUBindGroup,
      handles,
      destroyed: false
    };
    state.group = this.createGroup(state);
    STATES.set(prepared, state);
    this.prepared.add(prepared);
    return prepared;
  }

  rebind(prepared: PreparedLargeTriangleSetup, input: {
    camera: GPUBuffer; counters: GPUBuffer; countersEnabled: boolean;
  }): void {
    const state = this.require(prepared);
    if (state.camera === input.camera && state.counters === input.counters &&
        state.countersEnabled === input.countersEnabled) return;
    state.camera = input.camera;
    state.counters = input.counters;
    state.countersEnabled = input.countersEnabled;
    state.group = this.createGroup(state);
  }

  encode(encoder: GPUCommandEncoder, prepared: PreparedLargeTriangleSetup,
    width: number, height: number): void {
    const state = this.require(prepared);
    const total = state.workCapacity * GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET;
    const linearGroups = Math.ceil(total / LARGE_TRIANGLE_SETUP_WORKGROUP_SIZE);
    const max = Number(this.device.limits.maxComputeWorkgroupsPerDimension);
    const dispatchX = Math.min(linearGroups, max);
    const dispatchY = Math.ceil(linearGroups / dispatchX);
    if (dispatchY > max) throw new RangeError("LargeTriangleSetup dispatch exceeds adapter limits");
    writeGpuBuffer(this.device.queue, "LargeTriangleSetup/settings", state.settings, 0,
      new Uint32Array([
        width, height, state.workCapacity, prepared.capacity,
        state.countersEnabled ? 1 : 0, Math.floor(state.thresholdPixels), dispatchX, 0
      ]));
    encoder.clearBuffer(state.records);
    const pass = encoder.beginComputePass({ label: "ADR-0008 LargeTriangleSetup/build" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, state.group);
    pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
    pass.end();
  }

  release(prepared: PreparedLargeTriangleSetup): void {
    const state = this.require(prepared);
    state.destroyed = true;
    state.settings.destroy();
    state.records.destroy();
    for (const handle of state.handles) this.accounting?.destroyed(handle);
    STATES.delete(prepared);
    this.prepared.delete(prepared);
  }

  destroy(): void {
    for (const prepared of [...this.prepared]) this.release(prepared);
  }

  private createGroup(state: State): GPUBindGroup {
    return this.device.createBindGroup({
      label: "ADR-0008 LargeTriangleSetup bindings",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: state.camera } },
        { binding: 1, resource: { buffer: state.settings } },
        { binding: 2, resource: { buffer: state.work } },
        { binding: 3, resource: { buffer: state.scene.instances } },
        { binding: 4, resource: { buffer: state.assets.geometryRecords } },
        { binding: 5, resource: { buffer: state.assets.meshletRecords } },
        { binding: 6, resource: { buffer: state.assets.meshletVertexIndices } },
        { binding: 7, resource: { buffer: state.assets.meshletTriangleIndices } },
        { binding: 8, resource: { buffer: state.assets.vertexStreamData } },
        { binding: 9, resource: { buffer: state.records } },
        { binding: 10, resource: { buffer: state.counters } }
      ]
    });
  }

  private createBuffer(descriptor: GPUBufferDescriptor, handles: ResourceHandle[],
    category: "uniform" | "work-cache"): GPUBuffer {
    const buffer = this.device.createBuffer(descriptor);
    const handle = this.accounting?.created({
      kind: "buffer",
      category: category === "uniform" ? "transient" : "work-cache",
      owner: "VisibilityWorkSet/LargeTriangleSetupCache",
      bytes: Number(descriptor.size),
      label: descriptor.label?.toString()
    });
    if (handle !== undefined) handles.push(handle);
    return buffer;
  }

  private require(prepared: PreparedLargeTriangleSetup): State {
    const state = STATES.get(prepared);
    if (state === undefined || state.destroyed) {
      throw new Error("LargeTriangleSetup state is stale or foreign");
    }
    return state;
  }
}
