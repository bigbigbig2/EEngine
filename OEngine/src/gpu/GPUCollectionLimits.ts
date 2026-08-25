/**
 * GPUCollectionLimits：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GPUBufferAllocator } from "./GPUBufferAllocator.js";
import {
  recordGpuReadback,
  submitGpuCommands,
  writeGpuBuffer
} from "./GpuQueueEvidence.js";

export enum GPUCollectionKind {
  Meshes = 0,
  Meshlets = 1,
  ObjectPropertyReference = 2
}

const COLLECTION_COUNT = 3;
const HISTORY_LENGTH = 512;
const COLLECTION_ELEMENT_BYTES: Readonly<Record<GPUCollectionKind, number>> = {
  [GPUCollectionKind.Meshes]: Uint32Array.BYTES_PER_ELEMENT,
  [GPUCollectionKind.Meshlets]: 2 * Uint32Array.BYTES_PER_ELEMENT,
  [GPUCollectionKind.ObjectPropertyReference]:
    2 * Uint32Array.BYTES_PER_ELEMENT
};

export class GPUCollectionStatistics {
  readonly stat_buffer: GPUBuffer;
  private readonly cursors: Uint32Array;
  private readonly records: Uint32Array;
  private readonly globalMax: Uint32Array;

  constructor(
    private readonly device: GPUDevice,
    readonly columns: number,
    private readonly historyLength: number
  ) {
    this.cursors = new Uint32Array(columns);
    this.records = new Uint32Array(columns * historyLength);
    this.globalMax = new Uint32Array(columns);
    this.stat_buffer = device.createBuffer({
      label: "",
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      size: columns * Uint32Array.BYTES_PER_ELEMENT * historyLength
    });
  }

  getLastRecord(column: number): number {
    const row =
      ((this.cursors[column] ?? 0) - 1 + this.historyLength) %
      this.historyLength;
    return this.records[row * this.columns + column] ?? 0;
  }

  getCurrentMax(column: number): number {
    let maximum = 0;
    for (let row = 0; row < this.historyLength; row++) {
      const value = this.records[row * this.columns + column] ?? 0;
      if (value > maximum) maximum = value;
    }
    return maximum;
  }

  getGlobalMax(column: number): number {
    return this.globalMax[column] ?? 0;
  }

  setGlobalMax(column: number, value: number): void {
    this.globalMax[column] = value >>> 0;
  }

  clearColumn(column: number): void {
    for (let row = 0; row < this.historyLength; row++) {
      this.records[row * this.columns + column] = 0;
    }
    this.globalMax[column] = 0;
    this.upload();
  }

  record(
    command: ShadeGPUCommandContext,
    column: number,
    source: GPUBuffer,
    sourceOffset = 0
  ): void {
    if (this.stat_buffer.mapState !== "unmapped") return;
    const row = this.cursors[column] ?? 0;
    this.cursors[column] = (row + 1) % this.historyLength;
    command.copyBufferToBuffer(
      source,
      sourceOffset,
      this.stat_buffer,
      (row * this.columns + column) * Uint32Array.BYTES_PER_ELEMENT,
      Uint32Array.BYTES_PER_ELEMENT
    );
  }

  async readback_explicit(
    command: ShadeGPUCommandContext,
    allocator: GPUBufferAllocator
  ): Promise<void> {
    const size = this.stat_buffer.size;
    const readback = allocator.get(
      {
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      },
      command
    );
    command.recordReadback("collection-limits", size);
    command.copyBufferToBuffer(this.stat_buffer, 0, readback, 0, size);
    await command.done;
    await readback.mapAsync(GPUMapMode.READ, 0, size);
    this.updateRecords(new Uint32Array(readback.getMappedRange(0, size)));
    readback.unmap();
    allocator.release(readback);
  }

  async readback(): Promise<void> {
    const size = this.stat_buffer.size;
    const readback = this.device.createBuffer({
      label: "",
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      mappedAtCreation: false
    });
    const encoder = this.device.createCommandEncoder({ label: "" });
    encoder.copyBufferToBuffer(this.stat_buffer, 0, readback, 0, size);
    recordGpuReadback(this.device, "collection-limits-standalone", size);
    submitGpuCommands(this.device, "GPUCollectionLimits/read", [encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ, 0, size);
    const data = readback.getMappedRange(0, size).slice(0);
    this.updateRecords(new Uint32Array(data));
    readback.destroy();
  }

  upload(): void {
    writeGpuBuffer(
      this.device.queue,
      "GPUCollectionLimits/upload",
      this.stat_buffer,
      0,
      this.records.buffer
    );
  }

  destroy(): void {
    this.stat_buffer.destroy();
  }

  private updateRecords(values: Uint32Array): void {
    this.records.set(values);
    for (let row = 0; row < this.historyLength; row++) {
      for (let column = 0; column < this.columns; column++) {
        const value = this.records[row * this.columns + column] ?? 0;
        if (value > (this.globalMax[column] ?? 0)) {
          this.globalMax[column] = value;
        }
      }
    }
  }
}

export class GPUCollectionLimits {
  readonly stats: GPUCollectionStatistics;
  private readonly previousLimits = new Uint32Array(COLLECTION_COUNT);

  constructor(private readonly device: GPUDevice) {
    this.stats = new GPUCollectionStatistics(
      device,
      COLLECTION_COUNT,
      HISTORY_LENGTH
    );
    this.stats.setGlobalMax(GPUCollectionKind.Meshes, 10_000);
    this.stats.setGlobalMax(GPUCollectionKind.Meshlets, 200_000);
    this.stats.setGlobalMax(GPUCollectionKind.ObjectPropertyReference, 1_024);
    this.snapshotLimits();
  }

  get_limit(kind: GPUCollectionKind): number {
    return this.stats.getGlobalMax(kind);
  }

  prime(kind: GPUCollectionKind, value: number): void {
    this.stats.setGlobalMax(kind, value);
    this.previousLimits[kind] = value >>> 0;
  }

  compute_buffer_size(kind: GPUCollectionKind): number {
    const requested = alignUp(
      COLLECTION_ELEMENT_BYTES[kind] * this.get_limit(kind) + 16,
      4096
    );
    const maximum = Math.min(
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize
    );
    if (requested > maximum) {
      console.warn(
        `Requesting collection buffer larger than device limit '${requested}' > '${maximum}'`
      );
    }
    return Math.min(maximum, Math.max(16, requested));
  }

  record(
    command: ShadeGPUCommandContext,
    kind: GPUCollectionKind,
    source: GPUBuffer,
    sourceOffset = 0
  ): void {
    this.stats.record(command, kind, source, sourceOffset);
  }

  async update(
    command: ShadeGPUCommandContext,
    allocator: GPUBufferAllocator
  ): Promise<void> {
    await this.stats.readback_explicit(command, allocator);
    this.resetFollowingLimitsAfterGrowth();
    this.snapshotLimits();
  }

  destroy(): void {
    this.stats.destroy();
  }

  private resetFollowingLimitsAfterGrowth(): void {
    for (let kind = 0; kind < COLLECTION_COUNT; kind++) {
      if (this.stats.getGlobalMax(kind) <= (this.previousLimits[kind] ?? 0)) {
        continue;
      }
      for (let next = kind + 1; next < COLLECTION_COUNT; next++) {
        this.stats.clearColumn(next);
        this.stats.setGlobalMax(next, this.previousLimits[next] ?? 0);
      }
      break;
    }
  }

  private snapshotLimits(): void {
    for (let kind = 0; kind < COLLECTION_COUNT; kind++) {
      this.previousLimits[kind] = this.stats.getGlobalMax(kind);
    }
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
