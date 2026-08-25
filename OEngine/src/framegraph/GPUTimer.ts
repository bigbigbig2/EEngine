/**
 * GPUTimer：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

export type GPUTimerPassType = "compute" | "render";

export type GPUTimerResult = {
  label: string | undefined;
  type: GPUTimerPassType;
  duration_ms: number;
  start: bigint;
  end: bigint;
};

export type GPUTimerTimestampWrites = {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex: number;
  endOfPassWriteIndex: number;
};

type GPUTimerEntry = {
  label: string | undefined;
  type: GPUTimerPassType;
};

export class GPUTimer {
  readonly capacity: number;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private readonly values: BigInt64Array;
  private readonly entries: GPUTimerEntry[] = [];
  private entryCount = 0;

  constructor(private readonly device: GPUDevice, capacity = 1024) {
    this.capacity = capacity;
    this.querySet = device.createQuerySet({
      type: "timestamp",
      count: 2 * capacity
    });
    this.resolveBuffer = device.createBuffer({
      label: "",
      size: 2 * capacity * BigInt64Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
    this.readbackBuffer = device.createBuffer({
      label: "",
      size: 2 * capacity * BigInt64Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    this.values = new BigInt64Array(2 * capacity);
  }

  getComputeWrites(label?: string): GPUTimerTimestampWrites {
    return this.allocateWrites(label, "compute");
  }

  getRenderWrites(label?: string): GPUTimerTimestampWrites {
    return this.allocateWrites(label, "render");
  }

  resolve(encoder: GPUCommandEncoder): void {
    encoder.resolveQuerySet(
      this.querySet,
      0,
      this.querySet.count,
      this.resolveBuffer,
      0
    );
    encoder.copyBufferToBuffer(
      this.resolveBuffer,
      0,
      this.readbackBuffer,
      0
    );
  }

  async download_results(): Promise<void> {
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = this.readbackBuffer.getMappedRange(
      0,
      this.readbackBuffer.size
    );
    this.values.set(new BigInt64Array(mapped));
    this.readbackBuffer.unmap();
  }

  results_to_console_table(): GPUTimerResult[] {
    const results: GPUTimerResult[] = [];
    for (let index = 0; index < this.entryCount; index++) {
      const entry = this.entries[index]!;
      const start = this.values[index * 2]!;
      const end = this.values[index * 2 + 1]!;
      results.push({
        label: entry.label,
        type: entry.type,
        duration_ms: 1e-6 * Number(end - start),
        start,
        end
      });
    }
    return results;
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readbackBuffer.destroy();
  }

  private allocateWrites(
    label: string | undefined,
    type: GPUTimerPassType
  ): GPUTimerTimestampWrites {
    const index = this.entryCount++;
    this.entries[index] = { label, type };
    const queryIndex = 2 * index;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: queryIndex,
      endOfPassWriteIndex: queryIndex + 1
    };
  }
}
