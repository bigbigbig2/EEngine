import type { GpuAppearancePublication } from "../gpu/GpuAppearancePublication.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE, GPU_MESHLET_RASTER_WORK_RECORD_STRIDE } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { rasterPartitionWgsl, RASTER_PARTITIONS_PER_PROGRAM, RASTER_PARTITION_SETTINGS_STRIDE,
  RASTER_PARTITION_STATE_STRIDE, RASTER_PARTITION_INDIRECT_STRIDE, RASTER_PARTITION_WORKGROUP_SIZE } from "../shaders/raster_work_partitions.js";

export interface PreparedRasterWorkPartitions {
  readonly indices: GPUBuffer;
  readonly states: GPUBuffer;
  readonly draws: GPUBuffer;
  readonly settings: GPUBuffer;
  readonly count: number;
  readonly byteLength: number;
}
interface State {
  readonly prepared: PreparedRasterWorkPartitions;
  readonly publication: GpuAppearancePublication;
  readonly buffers: GPUBuffer[];
  readonly handles: ResourceHandle[];
  readonly group: GPUBindGroup;
  readonly dispatchGroup: GPUBindGroup;
  readonly dispatch: GPUBuffer;
  readonly caster: boolean;
  destroyed: boolean;
}

/** Single device owner for finite raster programs' GPU count/prefix/scatter.
 * Allocations follow their source queue's GPU retirement, including late HZB.
 * No CPU work-count readback, duplicate geometry queue or additional submit. */
export class RasterWorkPartitions {
  readonly ready: Promise<void>;
  private readonly states = new Map<GPUBuffer, State>();
  private readonly allocations = new Set<State>();
  private readonly layout: GPUBindGroupLayout;
  private readonly dispatchLayout: GPUBindGroupLayout;
  private pipelines: readonly (readonly GPUComputePipeline[])[] | null = null;
  private destroyed = false;
  constructor(private readonly device: GPUDevice, private readonly accounting?: ResourceAccounting,
    private readonly maxBytes = 64 * 1024 * 1024) {
    const limits = device.limits;
    if (limits.maxStorageBuffersPerShaderStage < 8 || limits.maxBindGroups < 2 ||
      RASTER_PARTITION_SETTINGS_STRIDE % limits.minUniformBufferOffsetAlignment !== 0 ||
      limits.maxComputeInvocationsPerWorkgroup < RASTER_PARTITION_WORKGROUP_SIZE || limits.maxComputeWorkgroupSizeX < RASTER_PARTITION_WORKGROUP_SIZE) {
      throw new RangeError("Raster partitions require eight storage bindings, aligned settings and 64 compute lanes");
    }
    this.layout = device.createBindGroupLayout({ label: "Raster partition data", entries: [
      ...Array.from({ length: 6 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: (binding < 3 ? "read-only-storage" : "storage") as GPUBufferBindingType } })),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.dispatchLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    const beginLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.dispatchLayout] });
    const mainLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.ready = Promise.all([false,true].map(caster => {
      const module = device.createShaderModule({ label: `Raster work partitions/${caster ? "caster" : "visibility"}`, code: rasterPartitionWgsl(caster) });
      return Promise.all(["begin", "count", "prefix", "scatter"].map((entryPoint, index) =>
      device.createComputePipelineAsync({ label: `Raster partitions/${entryPoint}`, layout: index === 0 ? beginLayout : mainLayout,
        compute: { module, entryPoint } })));
    })).then(pipelines => {
      if (this.destroyed) throw new Error("Raster partition owner stopped during preparation");
      this.pipelines = pipelines;
    });
    void this.ready.catch(() => undefined); void device.lost.then(() => this.destroy());
  }
  get allocatedBytes(): number { let bytes = 0; for (const state of this.allocations) bytes += state.prepared.byteLength; return bytes; }
  prepare(queue: GPUBuffer, capacity: number, publication: GpuAppearancePublication,
    materials: GPUBuffer, meshlets: GPUBuffer, product: boolean, caster = false): PreparedRasterWorkPartitions {
    if (!this.pipelines || this.destroyed) throw new Error("Raster partition PSOs require scene preparation");
    const existing = this.states.get(queue);
    if (existing?.publication === publication) {
      return existing.prepared;
    }
    const programs = Math.max(0, ...publication.entries.map(entry => entry.coverage.rasterProgram)) + 1;
    const count = programs * RASTER_PARTITIONS_PER_PROGRAM, limit = this.device.limits;
    const sizes = [capacity * 4, count * RASTER_PARTITION_STATE_STRIDE, count * RASTER_PARTITION_INDIRECT_STRIDE,
      count * RASTER_PARTITION_SETTINGS_STRIDE, 16, 16];
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || queue.size < (caster ? 16 : GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE) + capacity * (caster ? 32 : GPU_MESHLET_RASTER_WORK_RECORD_STRIDE) ||
      Math.ceil(capacity / RASTER_PARTITION_WORKGROUP_SIZE) > limit.maxComputeWorkgroupsPerDimension ** 2 ||
      Math.ceil(count / RASTER_PARTITION_WORKGROUP_SIZE) > limit.maxComputeWorkgroupsPerDimension ||
      sizes.some(size => !Number.isSafeInteger(size) || size > limit.maxBufferSize || size > limit.maxStorageBufferBindingSize) ||
      this.allocatedBytes + bytes > this.maxBytes) throw new RangeError("Raster partitions exceed queue, dispatch, storage or cumulative owner budget");
    const buffers: GPUBuffer[] = [], handles: ResourceHandle[] = [];
    const make = (label: string, size: number, usage: GPUBufferUsageFlags) => {
      const buffer = this.device.createBuffer({ label, size, usage }); buffers.push(buffer);
      const handle = this.accounting?.created({ kind: "buffer", category: "work-cache", owner: "RasterWorkPartitions", label, bytes: size });
      if (handle) handles.push(handle); return buffer;
    };
    try {
      const indices = make("Raster original work indices", sizes[0]!, GPUBufferUsage.STORAGE);
      const states = make("Raster finite partition states", sizes[1]!, GPUBufferUsage.STORAGE);
      const draws = make("Raster finite partition drawIndirect", sizes[2]!, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
      const settings = make("Raster partition dynamic addressing", sizes[3]!, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const computeSettings = make("Raster partition compute settings", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const dispatch = make("Raster source dispatchIndirect", 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
      const addressing = new Uint32Array(sizes[3]! / 4);
      for (let index = 0; index < count; index++) addressing[index * RASTER_PARTITION_SETTINGS_STRIDE / 4] = index;
      this.device.queue.writeBuffer(settings, 0, addressing);
      this.device.queue.writeBuffer(computeSettings, 0, new Uint32Array([capacity, count, limit.maxComputeWorkgroupsPerDimension, Number(product)]));
      const group = this.device.createBindGroup({ layout: this.layout, entries:
        [queue, materials, publication.coverageDirectory, states, indices, draws, computeSettings, meshlets]
          .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const dispatchGroup = this.device.createBindGroup({ layout: this.dispatchLayout, entries: [{ binding: 0, resource: { buffer: dispatch } }] });
      const prepared = Object.freeze({ indices, states, draws, settings, count, byteLength: bytes });
      const state: State = { prepared, publication, buffers, handles, group, dispatchGroup, dispatch, caster, destroyed: false };
      this.allocations.add(state); this.states.set(queue,state);
      publication.onDestroyed(() => {
        if (this.states.get(queue) === state) {
          if (existing && !existing.destroyed) this.states.set(queue,existing);
          else this.states.delete(queue);
        }
        this.destroyState(state);
      });
      return prepared;
    } catch (error) { for (const buffer of buffers) buffer.destroy(); for (const handle of handles) this.accounting?.destroyed(handle); throw error; }
  }
  encode(encoder: GPUCommandEncoder, queue: GPUBuffer): PreparedRasterWorkPartitions {
    const state = this.states.get(queue);
    if (!state || !this.pipelines || this.destroyed) throw new Error("Raster partitions have no prepared source queue");
    for (let stage = 0; stage < 4; stage++) {
      const pass = encoder.beginComputePass({ label: `Raster partitions/${["begin", "count", "prefix", "scatter"][stage]}` });
      pass.setPipeline(this.pipelines[Number(state.caster)]![stage]!); pass.setBindGroup(0, state.group);
      if (stage === 0) { pass.setBindGroup(1, state.dispatchGroup); pass.dispatchWorkgroups(Math.ceil(state.prepared.count / RASTER_PARTITION_WORKGROUP_SIZE)); }
      else if (stage === 2) pass.dispatchWorkgroups(1);
      else pass.dispatchWorkgroupsIndirect(state.dispatch, 0);
      pass.end();
    }
    return state.prepared;
  }
  release(queue: GPUBuffer): void {
    const state = this.states.get(queue); if (!state) return;
    this.states.delete(queue);
    this.destroyState(state);
  }
  private destroyState(state: State): void {
    if (state.destroyed) return; state.destroyed = true; this.allocations.delete(state);
    for (const buffer of state.buffers) buffer.destroy(); for (const handle of state.handles) this.accounting?.destroyed(handle);
  }
  destroy(): void { if (this.destroyed) return; this.states.clear(); for (const state of this.allocations) this.destroyState(state); this.pipelines = null; this.destroyed = true; }
}
