/**
 * GPUIndexedRecordTable：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { BitSet } from "../core/BitSet.js";
import { WGSL_u32, type WebGPUType } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { readWgslValue } from "../core/WgslBufferIO.js";
import { BinaryReader } from "../loaders/BinaryReader.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";

const GPU_INDEXED_RECORD_UPLOAD_WGSL = `struct Struct_48{
    count : u32,
    record_size : u32,
}
@group(0) @binding(0) var<uniform> settings : Struct_48;
@group(0) @binding(1) var<storage, read> shift : array< u32 >;
@group(0) @binding(2) var<storage, read_write> destination : array< u32 >;

@compute @workgroup_size(128,1,1)
fn main(@builtin(global_invocation_id) traced_harmonics : vec3<u32>){
    let shader_sdf_distance_sqr = traced_harmonics.x;
${"    "}
    if(shader_sdf_distance_sqr >= settings.count){
        return;
    }
${"    "}
    let optimized_move_x = shader_sdf_distance_sqr * ( settings.record_size + 1u );
${"    "}
    let j = shift[optimized_move_x];
${"    "}
    let cursor = optimized_move_x + 1u;
    let t3 = j * settings.record_size;
${"    "}

    for(var gi_radiance = 0u; gi_radiance < settings.record_size; gi_radiance++){

        destination[t3 + gi_radiance] = shift[cursor + gi_radiance];
    }
}
` + "       ";

export const GPU_INDEXED_RECORD_UPLOAD_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    }
  ]
};

export const GPU_INDEXED_RECORD_UPLOAD_PIPELINE: CachedComputePipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [GPU_INDEXED_RECORD_UPLOAD_LAYOUT]
  },
  compute: {
    module: { label: "", code: GPU_INDEXED_RECORD_UPLOAD_WGSL },
    constants: {}
  }
};

const GPU_INDEXED_RECORD_UPLOAD_SETTINGS_TYPE = StructType.from({
  count: WGSL_u32,
  record_size: WGSL_u32
}).pack();

export type GPUIndexedRecordTableOptions<T> = {
  device: GPUDevice;
  type: WebGPUType;
  recordSizeBytes: number;
  pack: (value: T, target: ArrayBuffer, byteOffset: number) => void;
  unpack?: (source: ArrayBuffer, byteOffset: number) => T;
  initialSizeBytes?: number;
};

export class GPUIndexedRecordTable<T> {
  readonly occupancy = new BitSet();
  readonly type: WebGPUType;
  buffer: GPUBuffer;

  private uploadBuffer = new ArrayBuffer(4096);
  private uploadSize = 0;
  private readonly uploadRecordSize: number;

  constructor(private readonly options: GPUIndexedRecordTableOptions<T>) {
    if (
      options.recordSizeBytes <= 0 ||
      options.recordSizeBytes % Uint32Array.BYTES_PER_ELEMENT !== 0
    ) {
      throw new RangeError("GPU indexed record size must be a positive u32 multiple");
    }
    if (options.recordSizeBytes !== options.type.aligned_size) {
      throw new RangeError(
        "GPU indexed record size must equal the WGSL type aligned size"
      );
    }
    this.uploadRecordSize =
      Uint32Array.BYTES_PER_ELEMENT + options.recordSizeBytes;
    this.type = options.type;
    const initialSize = alignUp(
      Math.max(1, options.initialSizeBytes ?? 4096),
      options.recordSizeBytes
    );
    this.buffer = options.device.createBuffer({
      size: initialSize,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      mappedAtCreation: false
    });
  }

  get gpu_memory_usage(): number {
    return this.buffer.size;
  }

  next(): number {
    return this.occupancy.nextClearBit(0);
  }

  remove(index: number): void {
    this.occupancy.set(index, false);
  }

  set(index: number, value: T): void {
    const destinationIndex = index >>> 0;
    this.occupancy.set(destinationIndex, true);
    this.ensureUploadCapacity(this.uploadSize + this.uploadRecordSize);
    const view = new DataView(this.uploadBuffer);
    view.setUint32(this.uploadSize, destinationIndex, true);
    this.options.pack(
      value,
      this.uploadBuffer,
      this.uploadSize + Uint32Array.BYTES_PER_ELEMENT
    );
    this.uploadSize += this.uploadRecordSize;
  }

  update(command: ShadeGPUCommandContext): void {
    if (this.uploadSize === 0) return;

    this.ensureDestinationCapacity(command, this.occupancy.size());
    const count = this.uploadSize / this.uploadRecordSize;
    const settings = command.allocateTransientValueBuffer(
      GPU_INDEXED_RECORD_UPLOAD_SETTINGS_TYPE,
      {
        count,
        record_size:
          this.options.recordSizeBytes / Uint32Array.BYTES_PER_ELEMENT
      }
    );
    const records = command.allocateTransientBufferAndLoad(
      this.uploadBuffer,
      GPUBufferUsage.STORAGE,
      0,
      this.uploadSize
    );
    const pass = command.constructComputePass({
      pipeline: GPU_INDEXED_RECORD_UPLOAD_PIPELINE,
      bindings: [[
        { buffer: settings },
        { buffer: records },
        { buffer: this.buffer }
      ]]
    });
    pass.dispatchWorkgroups(Math.ceil(count / 128), 1, 1);
    pass.end();

    this.uploadSize = 0;
    if (this.uploadBuffer.byteLength > 65536) {
      this.uploadBuffer = new ArrayBuffer(65536);
    }
  }

  async read(index: number): Promise<ArrayBuffer> {
    const size = this.options.recordSizeBytes;
    return this.readBytes(index * size, size);
  }

  async get(index: number): Promise<T> {
    return this.decodeRecord(await this.read(index), 0);
  }

  async debug_dump(): Promise<T[]> {
    const count = this.occupancy.size();
    if (count === 0) return [];
    const stride = this.options.recordSizeBytes;
    const bytes = await this.readBytes(0, count * stride);
    const output = new Array<T>(count);
    for (let index = 0; index < count; index++) {
      output[index] = this.decodeRecord(bytes, index * stride);
    }
    return output;
  }

  private async readBytes(offset: number, size: number): Promise<ArrayBuffer> {
    const readback = this.options.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const encoder = this.options.device.createCommandEncoder({ label: "" });
    encoder.copyBufferToBuffer(this.buffer, offset, readback, 0, size);
    this.options.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = readback.getMappedRange(0, size).slice(0);
    readback.unmap();
    readback.destroy();
    return result;
  }

  private decodeRecord(source: ArrayBuffer, byteOffset: number): T {
    if (this.options.unpack !== undefined) {
      return this.options.unpack(source, byteOffset);
    }
    const reader = BinaryReader.fromArrayBuffer(source);
    reader.position = byteOffset;
    return readWgslValue(reader, this.type) as T;
  }

  destroy(): void {
    this.buffer.destroy();
    this.occupancy.reset();
    this.uploadSize = 0;
    this.uploadBuffer = new ArrayBuffer(0);
  }

  private ensureDestinationCapacity(
    command: ShadeGPUCommandContext,
    slotCount: number
  ): void {
    const recordSize = this.options.recordSizeBytes;
    const requiredSize = slotCount * recordSize;
    const previous = this.buffer;
    if (previous.size >= requiredSize) return;

    const nextSize = Math.max(
      requiredSize,
      alignUp(1.25 * previous.size, recordSize)
    );
    const next = this.options.device.createBuffer({
      size: nextSize,
      usage: previous.usage,
      mappedAtCreation: false
    });
    command.copyBufferToBuffer(previous, 0, next, 0, previous.size);
    command.onFinished.addOne(() => {
      previous.destroy();
    });
    this.buffer = next;
  }

  private ensureUploadCapacity(required: number): void {
    if (required <= this.uploadBuffer.byteLength) return;
    let capacity = Math.max(256, this.uploadBuffer.byteLength);
    while (capacity < required) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(
      new Uint8Array(this.uploadBuffer, 0, this.uploadSize)
    );
    this.uploadBuffer = next;
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
