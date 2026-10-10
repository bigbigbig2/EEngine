import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { GeometryProductGpuBindingsV1 } from "../gpu/VirtualGeometryResidency.js";
import { gpuStorageRange } from "../gpu/GpuStorageRange.js";
import { GPU_INSTANCE_RECORD_STRIDE } from "../gpu/GpuInstanceAbi.js";
import { gpuMeshletWorkQueueByteLength } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY } from "../gpu/GpuVisibilityKeyAbi.js";
import { PACKED_CAMERA_TYPE } from "../shaders/packed_camera.js";
import { TEMPORAL_OCCLUSION_WORK_WGSL } from "../shaders/temporal_occlusion_work.js";

export interface TemporalOcclusionInputs {
  readonly sourceQueue: GPUBuffer;
  readonly capacity: number;
  readonly camera: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly virtualGeometry: GeometryProductGpuBindingsV1;
  readonly productBanks: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
}
export interface PreparedTemporalOcclusion {
  /** Borrowed authoritative namespace, never replaced or compacted. */
  readonly queue: GPUBuffer;
  readonly capacity: number;
  /** Header: deferred/early/recovered/rejected, dispatch xyz, generation; u32 indices. */
  readonly deferred: GPUBuffer;
}
interface State {
  readonly input: TemporalOcclusionInputs;
  readonly prepared: PreparedTemporalOcclusion;
  readonly settings: GPUBuffer;
  readonly initialDispatch: GPUBuffer;
  readonly dispatchGroup: GPUBindGroup;
  readonly groups: WeakMap<GPUTextureView, GPUBindGroup>;
  readonly handles: readonly ResourceHandle[];
}

/** Same-frame occlusion owner. No GPU readback, extra submit, work copy or
 * cross-frame visible identity cache. Queue completion fences belong to caller. */
export class TemporalOcclusionWork {
  readonly ready: Promise<void>;
  private readonly layout: GPUBindGroupLayout;
  private readonly dispatchLayout: GPUBindGroupLayout;
  private readonly states = new Map<PreparedTemporalOcclusion, State>();
  private pipelines: readonly GPUComputePipeline[] | null = null;
  private stopped = false;
  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new RangeError("Invalid temporal occlusion owner budget");
    const l = device.limits;
    if (
      l.maxStorageBuffersPerShaderStage < 9 ||
      l.maxBindingsPerBindGroup < 11 ||
      l.maxComputeInvocationsPerWorkgroup < 64 ||
      l.maxComputeWorkgroupSizeX < 64 ||
      l.maxBindGroups < 2
    ) {
      throw new RangeError("Temporal occlusion requires its complete storage/dispatch profile");
    }
    this.layout = device.createBindGroupLayout({
      entries: [
        ...Array.from({ length: 8 }, (_, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: (binding === 0 || binding === 7 ? "storage" : "read-only-storage") as GPUBufferBindingType,
          },
        })),
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 80 } },
        {
          binding: 9,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size },
        },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.dispatchLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
    });
    const module = device.createShaderModule({
      label: "Visibility/temporal occlusion",
      code: TEMPORAL_OCCLUSION_WORK_WGSL,
    });
    const main = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const begin = device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.dispatchLayout] });
    this.ready = Promise.all(
      ["begin_prediction", "predict", "begin_recovery", "recover"].map((entryPoint, index) =>
        device.createComputePipelineAsync({
          label: `Visibility/${entryPoint}`,
          layout: index % 2 === 0 ? begin : main,
          compute: { module, entryPoint },
        }),
      ),
    ).then((pipelines) => {
      if (this.stopped) throw new Error("Temporal occlusion stopped during readiness");
      this.pipelines = pipelines;
    });
    void this.ready.catch(() => undefined);
    void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number {
    let bytes = 0;
    for (const state of this.states.values())
      bytes += state.prepared.deferred.size + state.settings.size + state.initialDispatch.size;
    return bytes;
  }
  matches(prepared: PreparedTemporalOcclusion, input: TemporalOcclusionInputs): boolean {
    const old = this.states.get(prepared)?.input;
    return (
      !!old &&
      old.sourceQueue === input.sourceQueue &&
      old.capacity === input.capacity &&
      old.camera === input.camera &&
      old.instances === input.instances &&
      old.virtualGeometry.metadata === input.virtualGeometry.metadata &&
      old.productBanks.every((bank, index) => bank === input.productBanks[index])
    );
  }
  prepare(input: TemporalOcclusionInputs): PreparedTemporalOcclusion {
    this.assertReady();
    const l = this.device.limits,
      bytes = 32 + input.capacity * 4;
    if (
      !Number.isSafeInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY ||
      input.capacity > l.maxComputeWorkgroupsPerDimension ** 2 ||
      bytes > l.maxStorageBufferBindingSize ||
      bytes > Number(l.maxBufferSize) ||
      this.allocatedBytes + bytes + 112 > this.maxBytes ||
      input.productBanks.length !== 4 ||
      input.sourceQueue.size < gpuMeshletWorkQueueByteLength(input.capacity)
    ) {
      throw new RangeError("Temporal occlusion cannot admit its complete queue capacity");
    }
    for (const buffer of [input.sourceQueue, input.virtualGeometry.metadata, ...input.productBanks])
      gpuStorageRange(buffer, l, 4, "Occlusion source");
    gpuStorageRange(input.instances, l, GPU_INSTANCE_RECORD_STRIDE, "Occlusion instances");
    if (input.camera.size < PACKED_CAMERA_TYPE.size || !(input.camera.usage & GPUBufferUsage.UNIFORM))
      throw new RangeError("Occlusion camera is not a complete uniform");
    const buffers: GPUBuffer[] = [],
      handles: ResourceHandle[] = [];
    const make = (label: string, size: number, usage: GPUBufferUsageFlags) => {
      const buffer = this.device.createBuffer({ label, size, usage });
      buffers.push(buffer);
      const handle = this.accounting?.created(
        { kind: "buffer", category: "work-cache", owner: "Visibility/TemporalOcclusion", bytes: size, label },
        buffer,
      );
      if (handle) handles.push(handle);
      return buffer;
    };
    try {
      const deferred = make(
        "Visibility/deferred indices",
        bytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const settings = make(
        "Visibility/prediction view",
        80,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      const initialDispatch = make(
        "Visibility/prediction dispatch",
        32,
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
      );
      this.device.queue.writeBuffer(
        settings,
        0,
        new Uint32Array([input.capacity, l.maxComputeWorkgroupsPerDimension, 0, 0]),
      );
      const prepared = Object.freeze({ queue: input.sourceQueue, capacity: input.capacity, deferred });
      this.states.set(prepared, {
        input,
        prepared,
        settings,
        initialDispatch,
        handles,
        groups: new WeakMap(),
        dispatchGroup: this.device.createBindGroup({
          layout: this.dispatchLayout,
          entries: [{ binding: 0, resource: { buffer: initialDispatch } }],
        }),
      });
      return prepared;
    } catch (error) {
      buffers.forEach((buffer) => buffer.destroy());
      handles.forEach((handle) => this.accounting?.destroyed(handle));
      throw error;
    }
  }
  predict(
    encoder: GPUCommandEncoder,
    prepared: PreparedTemporalOcclusion,
    hzb: GPUTextureView,
    previousClip: ArrayLike<number> | null,
  ): void {
    const state = this.require(prepared);
    const data = new ArrayBuffer(80),
      words = new Uint32Array(data),
      floats = new Float32Array(data);
    words.set([
      prepared.capacity,
      this.device.limits.maxComputeWorkgroupsPerDimension,
      Number(previousClip !== null),
      0,
    ]);
    if (previousClip) {
      if (previousClip.length !== 16 || !Array.from(previousClip).every(Number.isFinite))
        throw new RangeError("Occlusion prediction matrix must be finite mat4");
      floats.set(Array.from(previousClip), 4);
    }
    this.device.queue.writeBuffer(state.settings, 0, data);
    this.encode(encoder, state, hzb, 0);
  }
  recover(encoder: GPUCommandEncoder, prepared: PreparedTemporalOcclusion, hzb: GPUTextureView): void {
    this.encode(encoder, this.require(prepared), hzb, 2);
  }
  private encode(encoder: GPUCommandEncoder, state: State, hzb: GPUTextureView, begin: 0 | 2): void {
    let group = state.groups.get(hzb);
    if (!group) {
      const input = state.input;
      group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          ...[
            input.sourceQueue,
            input.instances,
            input.virtualGeometry.metadata,
            ...input.productBanks,
            state.prepared.deferred,
          ].map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 8, resource: { buffer: state.settings } },
          { binding: 9, resource: { buffer: input.camera } },
          { binding: 10, resource: hzb },
        ],
      });
      state.groups.set(hzb, group);
    }
    for (let index = begin; index < begin + 2; index++) {
      const pass = encoder.beginComputePass({
        label: `Visibility/${["prediction begin", "previous-HZB predict", "recovery begin", "current-HZB recover"][index]}`,
      });
      pass.setPipeline(this.pipelines![index]!);
      pass.setBindGroup(0, group);
      if (index % 2 === 0) pass.setBindGroup(1, state.dispatchGroup);
      if (index === begin) pass.dispatchWorkgroups(1);
      else pass.dispatchWorkgroupsIndirect(state.initialDispatch, begin === 0 ? 0 : 16);
      pass.end();
    }
  }
  release(prepared: PreparedTemporalOcclusion): void {
    const state = this.states.get(prepared);
    if (!state) return;
    state.prepared.deferred.destroy();
    state.settings.destroy();
    state.initialDispatch.destroy();
    state.handles.forEach((handle) => this.accounting?.destroyed(handle));
    this.states.delete(prepared);
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const prepared of this.states.keys()) this.release(prepared);
    this.pipelines = null;
  }
  private assertReady(): void {
    if (this.stopped || !this.pipelines) throw new Error("Temporal occlusion is not ready");
  }
  private require(prepared: PreparedTemporalOcclusion): State {
    this.assertReady();
    const state = this.states.get(prepared);
    if (!state) throw new Error("Temporal occlusion is stale or foreign");
    return state;
  }
}
