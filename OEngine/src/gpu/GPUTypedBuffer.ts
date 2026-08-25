/**
 * GPUTypedBuffer：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { WebGPUType } from "../core/WebGPUTypes.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";

const TYPED_BUFFER_SCRATCH = new ArrayBuffer(1024);

export type GPUTypedBufferCreateOptions<T> = {
  label?: string;
  device: GPUDevice;
  type: WebGPUType;
  usage: GPUBufferUsageFlags;
  mappedAtCreation?: boolean;
  initial_value?: T;
};

export class GPUTypedBuffer<T = unknown> {
  private readonly gpuType: WebGPUType;
  private readonly gpuBuffer: GPUBuffer;

  constructor(
    type: WebGPUType,
    buffer: GPUBuffer
  ) {
    this.gpuType = type;
    this.gpuBuffer = buffer;
  }

  get isGPUTypedBuffer(): true {
    return true;
  }

  get buffer(): GPUBuffer {
    return this.gpuBuffer;
  }

  get type(): WebGPUType {
    return this.gpuType;
  }

  get size(): number {
    return this.buffer.size;
  }

  static create<T>(
    options: GPUTypedBufferCreateOptions<T>
  ): GPUTypedBuffer<T> {
    let mappedAtCreation = options.mappedAtCreation ?? false;
    let unmapAfterInitialValue = false;
    if (options.initial_value !== undefined && !mappedAtCreation) {
      mappedAtCreation = true;
      unmapAfterInitialValue = true;
    }
    const buffer = options.device.createBuffer({
      label: options.label ?? options.type.wgsl_ref,
      size: options.type.size,
      usage: options.usage,
      mappedAtCreation
    });
    if (options.initial_value !== undefined) {
      writeWgslToBuffer(
        options.initial_value,
        options.type,
        buffer.getMappedRange()
      );
      if (unmapAfterInitialValue) buffer.unmap();
    }
    return new GPUTypedBuffer<T>(options.type, buffer);
  }

  upload(newValue: T, queue: GPUQueue): void {
    const size = this.type.size;
    const data =
      size <= TYPED_BUFFER_SCRATCH.byteLength
        ? TYPED_BUFFER_SCRATCH
        : new ArrayBuffer(size);
    writeWgslToBuffer(newValue, this.type, data);
    queue.writeBuffer(this.buffer, 0, data, 0, size);
  }

  destroy(): void {
    this.buffer.destroy();
  }

  toString(): string {
    return `GPUTypedBuffer:{\n            type: ${this.type},\n            buffer: ${this.buffer}\n        }`;
  }
}
