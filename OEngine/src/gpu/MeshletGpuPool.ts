/**
 * MeshletGpuPool：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { ChangeSignal } from "../core/Signal.js";
import type { MeshletsStub } from "../geometry/BoxGeometry.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  INVALID_MESHLET_ALLOCATION,
  MeshletRangeAllocator,
  type MeshletRangeAllocation
} from "./MeshletRangeAllocator.js";

const MESHLET_METADATA_WORDS = 10;
const MESHLET_METADATA_BYTES = MESHLET_METADATA_WORDS * 4;
const MESHLET_ADDRESS_WORD = 6;

const COPY_WORDS_WGSL = /* wgsl */ `
struct CopyArgs {
  src_offset: u32,
  dst_offset: u32,
  word_count: u32,
}

@group(0) @binding(0) var<storage, read_write> buffer: array<u32>;
@group(0) @binding(1) var<storage, read> args_list_node: array<CopyArgs>;

@compute @workgroup_size(64, 1, 1)
fn main(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_index) local_index: u32,
) {
  let args = args_list_node[workgroup_id.x];
  var j = local_index;
  loop {
    if (j >= args.word_count) { break; }
    buffer[args.dst_offset + j] = buffer[args.src_offset + j];
    j = j + 64u;
  }
}
`;

const PATCH_ADDRESSES_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> meshlet_metadata: array<u32>;
@group(0) @binding(1) var<storage, read> patches: array<u32>;
@group(0) @binding(2) var<uniform> patch_count: u32;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let patch_index = global_id.x;
  if (patch_index >= patch_count) { return; }
  let metadata_index = patches[patch_index * 2u];
  let address_delta = patches[patch_index * 2u + 1u];
  let address_word = metadata_index * 10u + 6u;
  meshlet_metadata[address_word] =
    meshlet_metadata[address_word] + address_delta;
}
`;

export class MeshletBatchAllocation {
  metadata!: MeshletRangeAllocation;
  data!: MeshletRangeAllocation;
  data_size = 0;
  meshlet_count = 0;
  metadata_buffer_original: ArrayBuffer = new ArrayBuffer(0);
  readonly changed = new ChangeSignal();
}

type CloneCopy = {
  source_data_offset: number;
  source_metadata_offset: number;
  new_data_offset: number;
  new_metadata_offset: number;
  data_size: number;
  meshlet_count: number;
  address_delta: number;
};

export class MeshletGpuPool {
  private dataAllocator: MeshletRangeAllocator;
  private metadataAllocator: MeshletRangeAllocator;
  private _bufferData: GPUBuffer;
  private _bufferMetadata: GPUBuffer;
  private readonly allocations: MeshletBatchAllocation[] = [];
  private readonly pendingClones: CloneCopy[] = [];
  private releasedSpace = 0;

  private copyPipeline: GPUComputePipeline | null = null;
  private patchPipeline: GPUComputePipeline | null = null;
  private readonly device: GPUDevice;

  constructor(
    private readonly graphics: GraphicsContext,
    options: {
      initial_data_capacity?: number;
      initial_metadata_capacity?: number;
    } = {}
  ) {
    const device = graphics.device;
    this.device = device;
    const initialDataCapacity =
      options.initial_data_capacity ?? 33_554_432;
    const initialMetadataCapacity =
      options.initial_metadata_capacity ?? 131_072;
    const dataWords = Math.ceil(initialDataCapacity / 4);
    this.dataAllocator = new MeshletRangeAllocator(dataWords);
    this.metadataAllocator = new MeshletRangeAllocator(
      initialMetadataCapacity
    );
    this._bufferData = device.createBuffer({
      label: "MeshletGpuPool/data",
      size: 4 * dataWords,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });
    this._bufferMetadata = device.createBuffer({
      label: "MeshletGpuPool/metadata",
      size: initialMetadataCapacity * MESHLET_METADATA_BYTES,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });
  }

  get buffer_data(): GPUBuffer {
    return this._bufferData;
  }

  get buffer_metadata(): GPUBuffer {
    return this._bufferMetadata;
  }

  get meshlet_count(): number {
    let count = 0;
    for (const allocation of this.allocations) {
      count += allocation.meshlet_count;
    }
    return count;
  }

  get data_word_count(): number {
    let count = 0;
    for (const allocation of this.allocations) {
      count += allocation.data_size;
    }
    return count;
  }

  add_batch(batch: MeshletsStub): MeshletBatchAllocation {
    const allocation = this.createBatchAllocation(batch);
    if (batch.data_buffer.byteLength > 0) {
      this.device.queue.writeBuffer(
        this._bufferData,
        allocation.data.offset << 2,
        batch.data_buffer
      );
    }
    this.writeRebasedMetadata(
      allocation.metadata_buffer_original,
      allocation.meshlet_count,
      allocation.data.offset,
      allocation.metadata.offset,
      this._bufferMetadata
    );
    return allocation;
  }

  clone_batch_allocation(
    source: MeshletBatchAllocation
  ): MeshletBatchAllocation {
    const { data, metadata } = this.allocatePair(
      source.data_size,
      source.meshlet_count
    );
    this.pendingClones.push({
      source_data_offset: source.data.offset,
      source_metadata_offset: source.metadata.offset,
      new_data_offset: data.offset,
      new_metadata_offset: metadata.offset,
      data_size: source.data_size,
      meshlet_count: source.meshlet_count,
      address_delta: (data.offset - source.data.offset) >>> 0
    });
    const clone = new MeshletBatchAllocation();
    clone.data = data;
    clone.metadata = metadata;
    clone.meshlet_count = source.meshlet_count;
    clone.data_size = source.data_size;
    clone.metadata_buffer_original = source.metadata_buffer_original;
    this.allocations.push(clone);
    return clone;
  }

  update(command: ShadeGPUCommandContext): void {
    const clones = this.pendingClones;
    if (clones.length === 0) return;
    const copyPipeline =
      this.copyPipeline ??= this.createPipeline("copy", COPY_WORDS_WGSL);

    const dataCopyArgs = new Uint32Array(clones.length * 3);
    const metadataCopyArgs = new Uint32Array(clones.length * 3);
    const metadataStrideWords = MESHLET_METADATA_WORDS;
    let patchCount = 0;
    for (let i = 0; i < clones.length; i++) {
      const clone = clones[i]!;
      const base = i * 3;
      dataCopyArgs[base] = clone.source_data_offset;
      dataCopyArgs[base + 1] = clone.new_data_offset;
      dataCopyArgs[base + 2] = clone.data_size;
      metadataCopyArgs[base] =
        clone.source_metadata_offset * metadataStrideWords;
      metadataCopyArgs[base + 1] =
        clone.new_metadata_offset * metadataStrideWords;
      metadataCopyArgs[base + 2] =
        clone.meshlet_count * metadataStrideWords;
      patchCount += clone.meshlet_count;
    }

    const dataArgsBuffer = this.createTransientBuffer(
      command,
      "data-copy-args",
      dataCopyArgs,
      GPUBufferUsage.STORAGE
    );
    this.dispatchCopy(
      command,
      "clone-data",
      this._bufferData,
      dataArgsBuffer,
      clones.length,
      copyPipeline
    );

    const metadataArgsBuffer = this.createTransientBuffer(
      command,
      "metadata-copy-args",
      metadataCopyArgs,
      GPUBufferUsage.STORAGE
    );
    this.dispatchCopy(
      command,
      "clone-metadata",
      this._bufferMetadata,
      metadataArgsBuffer,
      clones.length,
      copyPipeline
    );

    if (patchCount > 0) {
      const patchPipeline =
        this.patchPipeline ??= this.createPipeline(
          "patch-addresses",
          PATCH_ADDRESSES_WGSL,
          PATCH_ADDRESSES_GROUP
        );
      const patches = new Uint32Array(patchCount * 2);
      let cursor = 0;
      for (const clone of clones) {
        for (let i = 0; i < clone.meshlet_count; i++) {
          patches[cursor++] = clone.new_metadata_offset + i;
          patches[cursor++] = clone.address_delta;
        }
      }
      const patchBuffer = this.createTransientBuffer(
        command,
        "address-patches",
        patches,
        GPUBufferUsage.STORAGE
      );
      const countBuffer = this.createTransientBuffer(
        command,
        "patch-count",
        new Uint32Array([patchCount, 0, 0, 0]),
        GPUBufferUsage.UNIFORM
      );
      const bindGroup = this.graphics.bind_groups.obtain({
        layout: PATCH_ADDRESSES_GROUP,
        entries: [
          { buffer: this._bufferMetadata },
          { buffer: patchBuffer },
          { buffer: countBuffer }
        ]
      });
      const pass = command.beginComputePass({
        label: "MeshletGpuPool/patch-addresses"
      });
      pass.setPipeline(patchPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(patchCount / 64));
      pass.end();
    }

    clones.length = 0;
  }

  compact(): void {
    this.rebuild(
      this._bufferData.size >>> 2,
      Math.ceil(this._bufferMetadata.size / MESHLET_METADATA_BYTES)
    );
  }

  grow(dataWords: number, metadataRecords: number): void {
    if (dataWords === 0 && metadataRecords === 0) return;
    const currentDataWords = this._bufferData.size >>> 2;
    const currentMetadataRecords = Math.ceil(
      this._bufferMetadata.size / MESHLET_METADATA_BYTES
    );
    const nextDataWords =
      dataWords === 0
        ? currentDataWords
        : Math.max(
            currentDataWords + dataWords,
            currentDataWords + 16_384,
            Math.ceil(1.25 * currentDataWords)
          );
    const nextMetadataRecords =
      metadataRecords === 0
        ? currentMetadataRecords
        : Math.max(
            currentMetadataRecords + metadataRecords,
            currentMetadataRecords + 256,
            Math.ceil(1.25 * currentMetadataRecords)
          );
    this.rebuild(nextDataWords, nextMetadataRecords);
  }

  get gpu_memory_usage_occupied(): number {
    let bytes = 0;
    for (const allocation of this.allocations) {
      bytes += 4 * allocation.data_size;
    }
    return bytes;
  }

  get gpu_memory_usage(): number {
    return this._bufferData.size + this._bufferMetadata.size;
  }

  destroy(): void {
    this._bufferData.destroy();
    this._bufferMetadata.destroy();
  }

  private createBatchAllocation(
    batch: MeshletsStub
  ): MeshletBatchAllocation {
    const dataSize = Math.ceil(batch.data_buffer.byteLength / 4);
    const meshletCount = batch.count;
    const { data, metadata } = this.allocatePair(dataSize, meshletCount);
    const allocation = new MeshletBatchAllocation();
    allocation.data = data;
    allocation.metadata = metadata;
    allocation.meshlet_count = meshletCount;
    allocation.data_size = dataSize;
    allocation.metadata_buffer_original = batch.metadata_buffer;
    this.allocations.push(allocation);
    return allocation;
  }

  private allocatePair(
    dataSize: number,
    meshletCount: number
  ): { data: MeshletRangeAllocation; metadata: MeshletRangeAllocation } {
    let data = this.invalidAllocation();
    let metadata = this.invalidAllocation();
    for (let attempt = 0; attempt < 3; attempt++) {
      data = this.dataAllocator.allocate(dataSize);
      metadata = this.metadataAllocator.allocate(meshletCount);
      const hasData = data.offset !== INVALID_MESHLET_ALLOCATION;
      const hasMetadata = metadata.offset !== INVALID_MESHLET_ALLOCATION;
      if (hasData && hasMetadata) break;
      if (hasData) {
        this.dataAllocator.free(data);
        data = this.invalidAllocation();
      }
      if (hasMetadata) {
        this.metadataAllocator.free(metadata);
        metadata = this.invalidAllocation();
      }
      if (this.releasedSpace > 0) {
        this.compact();
      } else {
        this.grow(hasData ? 0 : dataSize, hasMetadata ? 0 : meshletCount);
      }
    }
    if (
      data.offset === INVALID_MESHLET_ALLOCATION ||
      metadata.offset === INVALID_MESHLET_ALLOCATION
    ) {
      throw new Error("Failed to allocate GPU memory for meshlet batch");
    }
    return { data, metadata };
  }

  private rebuild(dataWords: number, metadataRecords: number): void {
    const count = this.allocations.length;
    const nextDataAllocator = new MeshletRangeAllocator(
      dataWords,
      Math.max(2 * count, 131_072)
    );
    const oldData = this._bufferData;
    const nextData = this.device.createBuffer({
      label: oldData.label,
      usage: oldData.usage,
      size: 4 * dataWords
    });
    const nextMetadataAllocator = new MeshletRangeAllocator(
      metadataRecords,
      Math.max(2 * count, 131_072)
    );
    const oldMetadata = this._bufferMetadata;
    const nextMetadata = this.device.createBuffer({
      label: oldMetadata.label,
      usage: oldMetadata.usage,
      size: metadataRecords * MESHLET_METADATA_BYTES
    });
    const encoder = this.device.createCommandEncoder({
      label: "MeshletGpuPool/rebuild"
    });
    const changed: MeshletBatchAllocation[] = [];

    for (const allocation of this.allocations) {
      const data = nextDataAllocator.allocate(allocation.data_size);
      const metadata = nextMetadataAllocator.allocate(
        allocation.meshlet_count
      );
      encoder.copyBufferToBuffer(
        oldData,
        4 * allocation.data.offset,
        nextData,
        4 * data.offset,
        4 * allocation.data_size
      );
      const dataAddressChanged = allocation.data.offset !== data.offset;
      this.writeRebasedMetadata(
        allocation.metadata_buffer_original,
        allocation.meshlet_count,
        data.offset,
        metadata.offset,
        nextMetadata
      );
      allocation.data = data;
      allocation.metadata = metadata;
      if (dataAddressChanged) changed.push(allocation);
    }

    for (const allocation of changed) allocation.changed.send0();
    this.device.queue.submit([encoder.finish()]);
    oldData.destroy();
    oldMetadata.destroy();
    this._bufferData = nextData;
    this._bufferMetadata = nextMetadata;
    this.dataAllocator = nextDataAllocator;
    this.metadataAllocator = nextMetadataAllocator;
    this.releasedSpace = 0;
  }

  private writeRebasedMetadata(
    source: ArrayBuffer,
    meshletCount: number,
    dataOffset: number,
    metadataOffset: number,
    destination: GPUBuffer
  ): void {
    if (meshletCount === 0) return;
    const words = new Uint32Array(meshletCount * MESHLET_METADATA_WORDS);
    const sourceWords = new Uint32Array(
      source,
      0,
      meshletCount * MESHLET_METADATA_WORDS
    );
    words.set(sourceWords);
    for (let i = 0; i < meshletCount; i++) {
      const addressIndex = i * MESHLET_METADATA_WORDS + MESHLET_ADDRESS_WORD;
      words[addressIndex] = (words[addressIndex]! + dataOffset) >>> 0;
    }
    this.device.queue.writeBuffer(
      destination,
      metadataOffset * MESHLET_METADATA_BYTES,
      words
    );
  }

  private dispatchCopy(
    command: ShadeGPUCommandContext,
    label: string,
    target: GPUBuffer,
    args: GPUBuffer,
    workgroups: number,
    pipeline: GPUComputePipeline
  ): void {
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: COPY_WORDS_GROUP,
      entries: [{ buffer: target }, { buffer: args }]
    });
    const pass = command.beginComputePass({ label: `MeshletGpuPool/${label}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }

  private createTransientBuffer(
    command: ShadeGPUCommandContext,
    label: string,
    data: ArrayBufferView,
    usage: GPUBufferUsageFlags
  ): GPUBuffer {
    const byteLength = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
    const buffer = this.device.createBuffer({
      label: `MeshletGpuPool/${label}`,
      size: byteLength,
      usage,
      mappedAtCreation: true
    });
    const mapped = new Uint8Array(buffer.getMappedRange());
    mapped.set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    buffer.unmap();
    command.onFinished.addOne(() => buffer.destroy());
    return buffer;
  }

  private createPipeline(
    label: string,
    code: string,
    layout: GPUBindGroupLayoutDescriptor = COPY_WORDS_GROUP
  ): GPUComputePipeline {
    return this.graphics.compute_pipelines.obtain({
      label: `MeshletGpuPool/${label}`,
      layout: {
        label: `MeshletGpuPool/${label}-layout`,
        bindGroupLayouts: [layout]
      },
      compute: {
        module: { label: `MeshletGpuPool/${label}-module`, code },
        entryPoint: "main"
      }
    });
  }

  private invalidAllocation(): MeshletRangeAllocation {
    return {
      offset: INVALID_MESHLET_ALLOCATION,
      metadata: INVALID_MESHLET_ALLOCATION
    };
  }
}

const COPY_WORDS_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "MeshletGpuPool/copy-group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
  ]
};

const PATCH_ADDRESSES_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "MeshletGpuPool/patch-addresses-group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ]
};
