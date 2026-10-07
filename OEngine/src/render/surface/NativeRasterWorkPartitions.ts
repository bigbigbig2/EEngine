import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE
} from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { nativeRasterPartitionsWgsl } from "../../shaders/native_raster_partitions.js";

export interface NativeRasterPartitionInput {
  readonly work: GPUBuffer;
  readonly metadata: GPUBuffer;
  readonly publication: GpuNativeMaterialPublication;
  readonly capacity: number;
  readonly meshletWordBase: number;
  readonly generation: number;
  readonly caster?: boolean;
}

/** S1 native raster scheduling over the existing foundation algorithm, not a
 * bridge to the old Surface publication. The source queue is borrowed; this
 * owner allocates only indices/partition metadata/indirect commands. No submit,
 * per-instance CPU draws or readback. Draw commands scale with unique bins.
 * Cost: 4W+32P+alignment*P+64 bytes; two O(W) classifications, 2 global atomics/work,
 * one O(P) serial prefix, four dispatches, no shader barriers. P=8 unique bins.
 * Small-bucket empty draws are zero-count indirect commands, not geometry work.
 * For one bin, optional unpartitioned oracle/raster-foundation organization can
 * avoid this management tax; this owner never selects a second shading path.
 */
export class NativeRasterWorkPartitions {
  readonly ready: Promise<void>;
  readonly indices: GPUBuffer;
  readonly states: GPUBuffer;
  readonly draws: GPUBuffer;
  readonly partitionSettings: GPUBuffer;
  readonly partitionStride: number;
  readonly count: number;
  readonly allocatedBytes: number;
  private readonly settings: GPUBuffer;
  private readonly dispatch: GPUBuffer;
  private readonly buffers: GPUBuffer[] = [];
  private readonly group: GPUBindGroup;
  private readonly dispatchGroup: GPUBindGroup;
  private pipelines: readonly GPUComputePipeline[] | null = null;
  private destroyed = false;
  private retiring = false;

  constructor(
    private readonly device: GPUDevice,
    readonly input: NativeRasterPartitionInput
  ) {
    const limits = device.limits;
    this.count = input.publication.bins.length * 8;
    this.partitionStride = Math.max(16, limits.minUniformBufferOffsetAlignment);
    const sizes = [
      input.capacity * 4,
      this.count * 16 + 16,
      this.count * 16,
      this.count * this.partitionStride,
      32,
      16
    ];
    if (
      !Number.isSafeInteger(input.capacity) ||
      input.capacity < 1 ||
      this.count < 1 ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.generation > 0xffffffff ||
      !Number.isSafeInteger(input.meshletWordBase) ||
      input.meshletWordBase < 0 ||
      input.meshletWordBase > 0xffffffff ||
      limits.maxStorageBuffersPerShaderStage < 7 ||
      limits.maxUniformBufferBindingSize < 32 ||
      limits.maxComputeWorkgroupSizeX < 64 ||
      limits.maxComputeInvocationsPerWorkgroup < 64 ||
      limits.maxBindGroups < 2 ||
      Math.ceil(input.capacity / 64) > limits.maxComputeWorkgroupsPerDimension ** 2 ||
      Math.ceil(this.count / 64) > limits.maxComputeWorkgroupsPerDimension ||
      input.work.size <
        (input.caster ? 16 : GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE) +
          input.capacity * (input.caster ? 32 : GPU_MESHLET_RASTER_WORK_RECORD_STRIDE) ||
      sizes.some((size) => !Number.isSafeInteger(size) || size < 4 || size > Number(limits.maxBufferSize)) ||
      sizes.filter((_size, index) => index !== 3).some((size) => size > limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError("Native raster partitions exceed complete queue, dispatch or resource capacity");
    }
    for (const buffer of [input.work, input.metadata, input.publication.directory]) {
      if (
        (buffer.usage & GPUBufferUsage.STORAGE) === 0 ||
        buffer.size < 4 ||
        buffer.size > limits.maxStorageBufferBindingSize
      ) {
        throw new RangeError("Native raster borrowed buffers exceed negotiated storage capacity/usage");
      }
    }
    const make = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = device.createBuffer({ label, size, usage });
      this.buffers.push(buffer);
      return buffer;
    };
    const layout = device.createBindGroupLayout({
      entries: [
        ...Array.from({ length: 6 }, (_, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: (binding < 3 ? "read-only-storage" : "storage") as GPUBufferBindingType }
        })),
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
      ]
    });
    const dispatchLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }]
    });
    try {
      this.indices = make("Native raster/indices", sizes[0]!, GPUBufferUsage.STORAGE);
      this.states = make(
        "Native raster/states and diagnostics",
        sizes[1]!,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      );
      this.draws = make("Native raster/draws", sizes[2]!, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
      this.partitionSettings = make(
        "Native raster/partition uniforms",
        sizes[3]!,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      );
      this.settings = make("Native raster/settings", 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.dispatch = make(
        "Native raster/source dispatch",
        16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
      );
      const values = new Uint32Array(sizes[3]! / 4);
      for (let partition = 0; partition < this.count; partition++) {
        values[(partition * this.partitionStride) / 4] = partition;
      }
      device.queue.writeBuffer(this.partitionSettings, 0, values);
      device.queue.writeBuffer(
        this.settings,
        0,
        new Uint32Array([
          input.capacity,
          this.count,
          limits.maxComputeWorkgroupsPerDimension,
          input.generation,
          input.meshletWordBase,
          0,
          0,
          0
        ])
      );
      this.group = device.createBindGroup({
        layout,
        entries: [
          input.work,
          input.publication.directory,
          input.metadata,
          this.states,
          this.indices,
          this.draws,
          this.settings
        ].map((buffer, binding) => ({ binding, resource: { buffer } }))
      });
      this.dispatchGroup = device.createBindGroup({
        layout: dispatchLayout,
        entries: [{ binding: 0, resource: { buffer: this.dispatch } }]
      });
      const module = device.createShaderModule({ code: nativeRasterPartitionsWgsl(input.caster) });
      const mainLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const beginLayout = device.createPipelineLayout({ bindGroupLayouts: [layout, dispatchLayout] });
      this.ready = Promise.all(
        ["begin", "count", "prefix", "scatter"].map((entryPoint, index) =>
          device.createComputePipelineAsync({
            layout: index === 0 ? beginLayout : mainLayout,
            compute: { module, entryPoint }
          })
        )
      )
        .then((pipelines) => {
          if (this.destroyed) {
            throw new Error("Native raster partitions stopped during readiness");
          }
          this.pipelines = pipelines;
        })
        .catch((error: unknown) => {
          this.destroy();
          throw error;
        });
      void this.ready.catch(() => undefined);
    } catch (error) {
      this.destroy();
      throw error;
    }
    this.allocatedBytes = sizes.reduce((total, size) => total + size, 0);
    void device.lost.then(() => this.destroy());
  }

  updateGeneration(generation: number): void {
    if (
      this.destroyed ||
      this.retiring ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > 0xffffffff
    ) {
      throw new RangeError("Native raster generation must be a live u32");
    }
    this.device.queue.writeBuffer(this.settings, 12, new Uint32Array([generation]));
  }

  encode(encoder: GPUCommandEncoder): void {
    if (this.destroyed || this.retiring || this.pipelines === null) {
      throw new Error("Native raster partitions are not ready");
    }
    for (let stage = 0; stage < 4; stage++) {
      const pass = encoder.beginComputePass({
        label: `Native raster/${["begin", "count", "prefix", "scatter"][stage]}`
      });
      pass.setPipeline(this.pipelines[stage]!);
      pass.setBindGroup(0, this.group);
      if (stage === 0) {
        pass.setBindGroup(1, this.dispatchGroup);
        pass.dispatchWorkgroups(Math.ceil(this.count / 64));
      } else if (stage === 2) {
        pass.dispatchWorkgroups(1);
      } else {
        pass.dispatchWorkgroupsIndirect(this.dispatch, 0);
      }
      pass.end();
    }
  }

  retire(completion: Promise<void>): Promise<void> {
    this.retiring = true;
    return completion.then(
      () => this.destroy(),
      () => this.destroy()
    );
  }

  /** Only unsubmitted candidate cancellation or device loss may destroy immediately. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.pipelines = null;
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
  }
}
