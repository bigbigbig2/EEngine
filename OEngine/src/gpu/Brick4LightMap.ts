/**
 * Brick4LightMap：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { writeGpuBuffer } from "./GpuQueueEvidence.js";

export const BRICK4_LIGHT_MAP_INITIAL_BYTES = 1 << 20;

export class Brick4LightMap {
  private bufferValue: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    this.bufferValue = this.createBuffer(BRICK4_LIGHT_MAP_INITIAL_BYTES, false);
  }

  get buffer(): GPUBuffer {
    return this.bufferValue;
  }

  get gpu_memory_usage(): number {
    return this.bufferValue.size;
  }

  upload(source: ArrayBuffer | ArrayBufferView): void {
    const bytes = asBytes(source);
    const alignedSize = alignTo(bytes.byteLength, 4);

    if (this.bufferValue.size < alignedSize) {
      this.bufferValue.destroy();
      const next = this.createBuffer(alignedSize, true);
      new Uint8Array(next.getMappedRange(), 0, bytes.byteLength).set(bytes);
      next.unmap();
      this.bufferValue = next;
      return;
    }

    let uploadBytes = bytes;
    if ((bytes.byteLength & 3) !== 0) {
      console.warn(
        "Brick4LightMap: upload buffer size is not multiple of 4 (perf)"
      );
      uploadBytes = new Uint8Array(alignedSize);
      uploadBytes.set(bytes);
    }
    writeGpuBuffer(
      this.device.queue,
      "Brick4LightMap/upload",
      this.bufferValue,
      0,
      uploadBytes.buffer,
      uploadBytes.byteOffset,
      alignedSize
    );
  }

  destroy(): void {
    this.bufferValue.destroy();
  }

  private createBuffer(size: number, mappedAtCreation: boolean): GPUBuffer {
    return this.device.createBuffer({
      label: "",
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation
    });
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function asBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
