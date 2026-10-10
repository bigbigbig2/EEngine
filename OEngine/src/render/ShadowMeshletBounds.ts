import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
} from "../gpu/GpuMeshletRasterWorkAbi.js";
import { SHADOW_BOUNDS_HEADER_BYTES, SHADOW_BOUNDS_STRIDE } from "../gpu/GpuVsmPairAbi.js";
import { shadowMeshletBoundsWgsl } from "../shaders/shadow_meshlet_bounds.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

/** Geometry-owned per-frame bounds of its independent shadow selection.
 * Cost: 32W+112 bytes; two dispatches, actual-count indirect, AABB affine
 * projection/work, one sequential write/work. No vertex payload/history/copy. */
export class ShadowMeshletBounds {
  readonly records: GPUBuffer;
  private readonly constants: GPUBuffer;
  private readonly dispatch: GPUBuffer;
  private readonly begin: GPUComputePipeline;
  private readonly produce: GPUComputePipeline;
  private readonly group: GPUBindGroup;
  private readonly dispatchLayout: GPUBindGroupLayout;
  private readonly dispatchGroups = new Map<GPUBuffer, GPUBindGroup>();
  private readonly handles: ResourceHandle[] = [];
  private destroyed = false;
  private readonly values = new Float32Array(20);

  constructor(
    private readonly device: GPUDevice,
    readonly work: PreparedMeshletWorkCandidate,
    instances: GPUBuffer,
    meshlets: GPUBuffer,
    private readonly accounting?: ResourceAccounting
  ) {
    const banks = work.productBanks ?? [];
    const borrowed = [
      work.queue,
      instances,
      meshlets,
      ...(work.productBindings ? [work.productBindings.metadata, ...banks] : [])
    ];
    const size = SHADOW_BOUNDS_HEADER_BYTES + work.capacity * SHADOW_BOUNDS_STRIDE;
    if (
      !Number.isSafeInteger(work.capacity) ||
      work.capacity < 1 ||
      work.capacity > 0xffffffff ||
      work.queue.size <
        GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + work.capacity * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE ||
      banks.length !== (work.productMode ? 4 : 0) ||
      !Number.isSafeInteger(size) ||
      size > device.limits.maxStorageBufferBindingSize ||
      size > Number(device.limits.maxBufferSize) ||
      device.limits.maxUniformBufferBindingSize < 80 ||
      device.limits.maxBindGroups < 2 ||
      device.limits.maxBindingsPerBindGroup < (work.productMode ? 10 : 5) ||
      device.limits.maxComputeWorkgroupSizeX < 64 ||
      device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
      device.limits.maxStorageBuffersPerShaderStage < (work.productMode ? 11 : 6) ||
      Math.ceil(work.capacity / 64) > device.limits.maxComputeWorkgroupsPerDimension ** 2 ||
      borrowed.some(
        (buffer) =>
          buffer.size > device.limits.maxStorageBufferBindingSize ||
          (buffer.usage & GPUBufferUsage.STORAGE) === 0
      )
    ) {
      throw new RangeError("Shadow Geometry bounds exceed the complete negotiated source profile");
    }
    this.records = device.createBuffer({
      label: "Shadow Geometry/meshlet bounds",
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    this.constants = device.createBuffer({
      label: "Shadow Geometry/bounds constants",
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.dispatch = device.createBuffer({
      label: "Shadow Geometry/bounds actual dispatch",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
    });
    new Uint32Array(this.values.buffer).set(
      [work.capacity, device.limits.maxComputeWorkgroupsPerDimension, 0, 0],
      16
    );
    const layout = device.createBindGroupLayout({
      label: "Shadow Geometry/bounds source layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        ...borrowed.slice(0, 3).map((_, index) => ({
          binding: index + 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as const }
        })),
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ...borrowed.slice(3).map((_, index) => ({
          binding: index + 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" as const }
        }))
      ]
    });
    this.dispatchLayout = device.createBindGroupLayout({
      label: "Shadow Geometry/bounds dispatch layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
      ]
    });
    const module = device.createShaderModule({
      label: "Shadow Geometry/tight bounds",
      code: shadowMeshletBoundsWgsl(Boolean(work.productMode))
    });
    this.begin = device.createComputePipeline({
      label: "Shadow Geometry/prepare bounds pipeline",
      layout: device.createPipelineLayout({
        label: "Shadow Geometry/prepare bounds pipeline layout",
        bindGroupLayouts: [layout, this.dispatchLayout]
      }),
      compute: { module, entryPoint: "begin" }
    });
    this.produce = device.createComputePipeline({
      label: "Shadow Geometry/produce bounds pipeline",
      layout: device.createPipelineLayout({
        label: "Shadow Geometry/produce bounds pipeline layout",
        bindGroupLayouts: [layout]
      }),
      compute: { module, entryPoint: "main" }
    });
    this.group = device.createBindGroup({
      label: "Shadow Geometry/bounds source group",
      layout,
      entries: [this.constants, ...borrowed.slice(0, 3), this.records, ...borrowed.slice(3)].map(
        (buffer, binding) => ({ binding, resource: { buffer } })
      )
    });
    for (const buffer of [this.records, this.constants, this.dispatch]) {
      if (accounting) {
        this.handles.push(
          accounting.created(
            {
              kind: "buffer",
              category: "transient",
              owner: "ShadowMeshletBounds",
              bytes: buffer.size,
              label: buffer.label
            },
            buffer
          )
        );
      }
    }
    void device.lost.then(() => this.destroy());
  }

  encode(command: ShadeGPUCommandContext, lightView: ArrayLike<number>, allocation: GPUBuffer): void {
    let dispatchGroup = this.dispatchGroups.get(allocation);
    if (!dispatchGroup) {
      dispatchGroup = this.device.createBindGroup({
        label: "Shadow Geometry/bounds dispatch group",
        layout: this.dispatchLayout,
        entries: [
          { binding: 0, resource: { buffer: this.dispatch } },
          { binding: 1, resource: { buffer: allocation } }
        ]
      });
      this.dispatchGroups.set(allocation, dispatchGroup);
    }
    this.values.set(lightView, 0);
    command.writeBuffer(this.constants, 0, this.values.buffer, 0, 80);
    const begin = command.beginComputePass({ label: "Shadow Geometry/prepare bounds" });
    begin.setPipeline(this.begin);
    begin.setBindGroup(0, this.group);
    begin.setBindGroup(1, dispatchGroup);
    begin.dispatchWorkgroups(1);
    begin.end();
    const produce = command.beginComputePass({ label: "Shadow Geometry/meshlet bounds" });
    produce.setPipeline(this.produce);
    produce.setBindGroup(0, this.group);
    produce.dispatchWorkgroupsIndirect(this.dispatch, 0);
    produce.end();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.records.destroy();
    this.constants.destroy();
    this.dispatch.destroy();
    this.dispatchGroups.clear();
    for (const handle of this.handles) {
      this.accounting?.destroyed(handle);
    }
    this.handles.length = 0;
  }

  retire(): void {
    for (const handle of this.handles) {
      this.accounting?.setRetired(handle, true);
    }
  }
}
