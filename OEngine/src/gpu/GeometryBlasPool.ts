/**
 * GeometryBlasPool：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

export const GEOMETRY_BLAS_NODE_STRIDE_BYTES = 32;
export const GEOMETRY_BLAS_METADATA_STRIDE_BYTES = 4;

export type GeometryBlasRecord = {
  bvh: ArrayBuffer;
  slot: number;
  address: number;
};

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function growGpuBuffer(
  device: GPUDevice,
  current: GPUBuffer,
  requiredBytes: number,
  command: ShadeGPUCommandContext,
  alignment = 1024,
  minimumGrowth = 1024,
  factor = 1.2,
): GPUBuffer {
  if (current.size >= requiredBytes) return current;
  const nextSize = alignUp(
    Math.max(
      requiredBytes,
      current.size + minimumGrowth,
      current.size * factor,
    ),
    alignment,
  );
  const next = device.createBuffer({
    label: current.label,
    usage: current.usage,
    size: nextSize,
    mappedAtCreation: false,
  });
  command.copyBufferToBuffer(current, 0, next, 0, current.size);
  return next;
}

export class GeometryBlasPool {
  private _bufferMetadata: GPUBuffer;
  private _bufferData: GPUBuffer;
  private usedDataBytes = 0;
  private logicalNodeCapacity = 0;
  private readonly managed = new Map<MeshletGeometryBase, GeometryBlasRecord>();
  private readonly records: GeometryBlasRecord[] = [];
  private readonly geometryIndexRecords = new Map<number, GeometryBlasRecord>();

  constructor(private readonly device: GPUDevice) {
    this._bufferMetadata = device.createBuffer({
      label: "",
      size: 16 * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
      usage:
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.STORAGE,
    });
    this._bufferData = device.createBuffer({
      label: "",
      size: 1024,
      usage:
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.STORAGE,
    });
  }

  get buffer_metadata(): GPUBuffer {
    return this._bufferMetadata;
  }

  get buffer_data(): GPUBuffer {
    return this._bufferData;
  }

  get gpu_memory_usage(): number {
    return this._bufferMetadata.size + this._bufferData.size;
  }

  obtain(geometry: MeshletGeometryBase): GeometryBlasRecord {
    const existing = this.managed.get(geometry);
    if (existing) return existing;
    const record: GeometryBlasRecord = {
      slot: this.records.length,
      bvh: geometry.bvh,
      address: 0,
    };
    this.managed.set(geometry, record);
    this.records.push(record);
    return record;
  }

  mapGeometryIndex(
    geometryIndex: number,
    geometry: MeshletGeometryBase
  ): GeometryBlasRecord {
    const record = this.obtain(geometry);
    this.geometryIndexRecords.set(geometryIndex >>> 0, record);
    return record;
  }

  update(command: ShadeGPUCommandContext): void {
    const count = this.records.length;
    if (count === 0) return;

    let nodeCount = 0;
    let uploadBytes = 0;
    const sourceOffsets = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const record = this.records[i]!;
      sourceOffsets[i] = uploadBytes;
      const nodes = record.bvh.byteLength / GEOMETRY_BLAS_NODE_STRIDE_BYTES;
      uploadBytes += nodes * GEOMETRY_BLAS_NODE_STRIDE_BYTES;
      nodeCount += nodes;
    }

    let metadataSlotCount = 0;
    for (const geometryIndex of this.geometryIndexRecords.keys()) {
      metadataSlotCount = Math.max(metadataSlotCount, geometryIndex + 1);
    }
    const previousUsedDataBytes = this.usedDataBytes;
    const previousLogicalNodeCapacity = this.logicalNodeCapacity;
    const previousAddresses = this.records.map((record) => record.address);
    this.ensureMetadataCapacity(metadataSlotCount, command);
    this.ensureDataCapacity(this.logicalNodeCapacity + nodeCount, command);
    let dataStaging: GPUBuffer | null = null;
    if (uploadBytes > 0) {
      dataStaging = this.device.createBuffer({
        label: "",
        usage: GPUBufferUsage.COPY_SRC,
        size: uploadBytes,
        mappedAtCreation: true,
      });
      const mapped = new Uint8Array(dataStaging.getMappedRange());
      for (let i = 0; i < count; i++) {
        mapped.set(new Uint8Array(this.records[i]!.bvh), sourceOffsets[i]!);
      }
      dataStaging.unmap();
    }

    for (let i = 0; i < count; i++) {
      const record = this.records[i]!;
      const destinationOffset = this.usedDataBytes;
      record.address = destinationOffset / GEOMETRY_BLAS_NODE_STRIDE_BYTES;
      const byteLength = record.bvh.byteLength;
      this.usedDataBytes += byteLength;
      if (byteLength > 0 && dataStaging) {
        command.copyBufferToBuffer(
          dataStaging,
          sourceOffsets[i]!,
          this._bufferData,
          destinationOffset,
          byteLength,
        );
      }
    }

    console.warn(`BLAS size: ${this.usedDataBytes} bytes`);
    const metadataRecords = [...this.geometryIndexRecords.entries()].sort(
      (a, b) => a[0] - b[0]
    );
    const metadataStaging = this.device.createBuffer({
      label: "",
      usage: GPUBufferUsage.COPY_SRC,
      size: Math.max(1, metadataRecords.length)
        * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
      mappedAtCreation: true,
    });
    const metadata = new DataView(metadataStaging.getMappedRange());
    for (let i = 0; i < metadataRecords.length; i++) {
      const record = metadataRecords[i]![1];
      metadata.setUint32(
        i * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
        record.address,
        true,
      );
    }
    metadataStaging.unmap();
    for (let i = 0; i < metadataRecords.length; i++) {
      const geometryIndex = metadataRecords[i]![0];
      command.copyBufferToBuffer(
        metadataStaging,
        i * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
        this._bufferMetadata,
        geometryIndex * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
        GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
      );
    }

    const releaseStaging = () => {
      dataStaging?.destroy();
      metadataStaging.destroy();
    };
    command.onFinished.addOne(releaseStaging);
    command.onAborted.addOne(() => {
      releaseStaging();
      this.usedDataBytes = previousUsedDataBytes;
      this.logicalNodeCapacity = previousLogicalNodeCapacity;
      for (let i = 0; i < this.records.length; i++) {
        this.records[i]!.address = previousAddresses[i] ?? 0;
      }
    });
  }

  destroy(): void {
    this._bufferMetadata.destroy();
    this._bufferData.destroy();
  }

  private ensureDataCapacity(
    requiredNodes: number,
    command: ShadeGPUCommandContext
  ): void {
    if (this.logicalNodeCapacity >= requiredNodes) return;
    this.logicalNodeCapacity = requiredNodes;
    const previous = this._bufferData;
    const next = growGpuBuffer(
      this.device,
      previous,
      requiredNodes * GEOMETRY_BLAS_NODE_STRIDE_BYTES,
      command,
      1024,
      1024,
      1.2,
    );
    this._bufferData = next;
    if (next !== previous) {
      command.onFinished.addOne(() => previous.destroy());
      command.onAborted.addOne(() => {
        if (this._bufferData === next) this._bufferData = previous;
        next.destroy();
      });
    }
  }

  private ensureMetadataCapacity(
    recordCount: number,
    command: ShadeGPUCommandContext
  ): void {
    const previous = this._bufferMetadata;
    const next = growGpuBuffer(
      this.device,
      previous,
      recordCount * GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
      command,
      GEOMETRY_BLAS_METADATA_STRIDE_BYTES,
      16,
      1.2,
    );
    this._bufferMetadata = next;
    if (next !== previous) {
      command.onFinished.addOne(() => previous.destroy());
      command.onAborted.addOne(() => {
        if (this._bufferMetadata === next) this._bufferMetadata = previous;
        next.destroy();
      });
    }
  }
}
