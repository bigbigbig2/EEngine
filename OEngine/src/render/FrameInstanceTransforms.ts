import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { GPU_INSTANCE_RECORD_STRIDE } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_STRIDE } from "../gpu/GpuFrameInstanceAbi.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import { PACKED_CAMERA_TYPE } from "../shaders/packed_camera.js";
import {
  FRAME_INSTANCE_SETTINGS_SIZE,
  FRAME_INSTANCE_WORKGROUP_SIZE,
  frameInstanceTransformsWgsl,
} from "../shaders/frame_instance_transforms.js";

export interface PreparedFrameInstances {
  readonly records: GPUBuffer;
  /** GPU counters for diagnostics only; never drives same-frame CPU control. */
  readonly control: GPUBuffer;
  readonly capacity: number;
  readonly byteLength: number;
}
interface State {
  readonly prepared: PreparedFrameInstances;
  readonly source: GPUBuffer;
  readonly work: GPUBuffer;
  readonly workCapacity: number;
  readonly settings: GPUBuffer;
  readonly markers: GPUBuffer;
  readonly compact: GPUBuffer;
  readonly control: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly indirectGroup: GPUBindGroup;
  readonly buffers: readonly GPUBuffer[];
  readonly handles: readonly ResourceHandle[];
  camera: GPUBuffer;
  group: GPUBindGroup;
}
const ENTRIES = [
  "frame_instance_begin",
  "frame_instance_select",
  "frame_instance_finalize",
  "frame_instance_build",
] as const;
export const DEFAULT_FRAME_INSTANCE_MAX_BYTES = 256 * 1024 * 1024;

/** Device-owned final frame transform product. Async readiness is awaited during
 * scene publication, not in draw. Prepared resources follow VisibilityWorkSet
 * retirement and bind the authoritative scene/queue snapshot. */
export class FrameInstanceTransforms {
  readonly ready: Promise<void>;
  private readonly states = new Map<PreparedFrameInstances, State>();
  private readonly layout: GPUBindGroupLayout;
  private readonly indirectLayout: GPUBindGroupLayout;
  private pipelines: readonly GPUComputePipeline[] | null = null;
  private destroyed = false;
  constructor(
    private readonly device: GPUDevice,
    private readonly accounting?: ResourceAccounting,
    observe = false,
    private readonly maxBytes = DEFAULT_FRAME_INSTANCE_MAX_BYTES,
  ) {
    const l = device.limits;
    if (
      l.maxStorageBuffersPerShaderStage < 7 ||
      l.maxBindingsPerBindGroup < 8 ||
      l.maxBindGroups < 2 ||
      l.maxComputeInvocationsPerWorkgroup < FRAME_INSTANCE_WORKGROUP_SIZE ||
      l.maxComputeWorkgroupSizeX < FRAME_INSTANCE_WORKGROUP_SIZE
    ) {
      throw new RangeError("Frame instance transforms require seven storage bindings and 64 lanes");
    }
    this.layout = device.createBindGroupLayout({
      label: "Frame instance transforms",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: FRAME_INSTANCE_SETTINGS_SIZE },
        },
        ...[2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as GPUBufferBindingType },
        })),
        ...[4, 5, 6, 7].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType },
        })),
      ],
    });
    this.indirectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
      ],
    });
    const module = device.createShaderModule({
      label: "Frame selected-instance transforms",
      code: frameInstanceTransformsWgsl(observe),
    });
    const ordinary = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const finalize = device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.indirectLayout] });
    this.ready = Promise.all(
      ENTRIES.map((entryPoint, i) =>
        device.createComputePipelineAsync({
          label: `Geometry/${entryPoint}`,
          layout: i % 2 === 0 ? finalize : ordinary,
          compute: { module, entryPoint },
        }),
      ),
    ).then((pipelines) => {
      if (this.destroyed) throw new Error("Frame instance transforms stopped during preparation");
      this.pipelines = pipelines;
    });
    // The owner retains readiness failure; publication awaits the same promise.
    void this.ready.catch(() => undefined);
    void device.lost.then(() => this.destroy());
  }

  get allocatedBytes(): number {
    let bytes = 0;
    for (const state of this.states.values()) bytes += state.prepared.byteLength;
    return bytes;
  }

  prepare(input: {
    readonly camera: GPUBuffer;
    readonly source: GPUBuffer;
    readonly work: GPUBuffer;
    readonly workCapacity: number;
    readonly instanceCapacity: number;
  }): PreparedFrameInstances {
    this.requireReady();
    const { instanceCapacity: capacity, workCapacity } = input,
      l = this.device.limits;
    if (
      ![capacity, workCapacity].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff) ||
      input.source.size < capacity * GPU_INSTANCE_RECORD_STRIDE ||
      input.work.size <
        GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + workCapacity * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
    ) {
      throw new RangeError("Frame instance inputs do not cover the published capacities");
    }
    const sizes = [
      capacity * GPU_FRAME_INSTANCE_STRIDE,
      capacity * 4,
      capacity * 4,
      16,
      16,
      FRAME_INSTANCE_SETTINGS_SIZE,
    ] as const;
    const byteLength = sizes.reduce((a, b) => a + b, 0);
    if (
      byteLength + this.allocatedBytes > this.maxBytes ||
      sizes.some((size) => size > l.maxBufferSize) ||
      sizes.slice(0, 5).some((size) => size > l.maxStorageBufferBindingSize) ||
      [input.source, input.work].some((b) => b.size > l.maxStorageBufferBindingSize) ||
      Math.ceil(Math.max(capacity, workCapacity) / FRAME_INSTANCE_WORKGROUP_SIZE) >
        l.maxComputeWorkgroupsPerDimension ** 2
    ) {
      throw new RangeError("Frame instance resources exceed negotiated buffer/dispatch limits");
    }
    const buffers: GPUBuffer[] = [],
      handles: ResourceHandle[] = [];
    const make = (label: string, size: number, usage: GPUBufferUsageFlags) => {
      const b = this.device.createBuffer({ label, size, usage });
      buffers.push(b);
      const h = this.accounting?.created({
        kind: "buffer",
        category: "work-cache",
        owner: "Geometry/FrameInstanceTransforms",
        bytes: size,
        label,
      });
      if (h) handles.push(h);
      return b;
    };
    try {
      const records = make(
        "Geometry shared frame instances",
        sizes[0],
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const markers = make(
        "Geometry selected-instance markers",
        sizes[1],
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      const compact = make("Geometry selected-instance work", sizes[2], GPUBufferUsage.STORAGE);
      const control = make(
        "Geometry selected-instance control",
        sizes[3],
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      const indirect = make(
        "Geometry selected-instance indirect",
        sizes[4],
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
      );
      const settings = make(
        "Geometry frame instance settings",
        sizes[5],
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      writeGpuBuffer(
        this.device.queue,
        "Geometry/frame-instance-settings",
        settings,
        0,
        new Uint32Array([capacity, workCapacity, l.maxComputeWorkgroupsPerDimension, 0]),
      );
      const indirectGroup = this.device.createBindGroup({
        layout: this.indirectLayout,
        entries: [{ binding: 0, resource: { buffer: indirect } }],
      });
      const prepared = Object.freeze({ records, control, capacity, byteLength });
      const state: State = {
        prepared,
        source: input.source,
        work: input.work,
        workCapacity,
        settings,
        markers,
        compact,
        control,
        indirect,
        indirectGroup,
        buffers,
        handles,
        camera: input.camera,
        group: null!,
      };
      state.group = this.createGroup(state);
      this.states.set(prepared, state);
      return prepared;
    } catch (error) {
      for (const b of buffers) b.destroy();
      for (const h of handles) this.accounting?.destroyed(h);
      throw error;
    }
  }
  rebind(prepared: PreparedFrameInstances, camera: GPUBuffer): void {
    const state = this.require(prepared);
    if (state.camera === camera) return;
    const group = this.createGroup({ ...state, camera });
    state.camera = camera;
    state.group = group;
  }
  encode(encoder: GPUCommandEncoder, prepared: PreparedFrameInstances): void {
    const pipelines = this.requireReady(),
      s = this.require(prepared);
    encoder.clearBuffer(s.markers);
    encoder.clearBuffer(s.control);
    for (let i = 0; i < ENTRIES.length; i++) {
      const pass = encoder.beginComputePass({ label: `Geometry/${ENTRIES[i]}` });
      pass.setPipeline(pipelines[i]!);
      pass.setBindGroup(0, s.group);
      if (i % 2 === 0) {
        pass.setBindGroup(1, s.indirectGroup);
        pass.dispatchWorkgroups(1);
      } else pass.dispatchWorkgroupsIndirect(s.indirect, 0);
      pass.end();
    }
  }
  release(prepared: PreparedFrameInstances): void {
    // Queue-retirement callbacks can arrive after device-loss disposal.
    if (this.destroyed) return;
    const s = this.require(prepared);
    this.states.delete(prepared);
    for (const b of s.buffers) b.destroy();
    for (const h of s.handles) this.accounting?.destroyed(h);
  }
  destroy(): void {
    if (this.destroyed) return;
    for (const p of this.states.keys()) this.release(p);
    this.destroyed = true;
    this.pipelines = null;
  }
  private createGroup(s: State): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        s.camera,
        s.settings,
        s.source,
        s.work,
        s.markers,
        s.compact,
        s.prepared.records,
        s.control,
      ].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }
  private require(p: PreparedFrameInstances): State {
    const s = this.states.get(p);
    if (!s) throw new Error("Frame instance allocation is stale or foreign");
    return s;
  }
  private requireReady(): readonly GPUComputePipeline[] {
    if (this.destroyed || !this.pipelines)
      throw new Error("Frame instance transforms require completed scene preparation");
    return this.pipelines;
  }
}
