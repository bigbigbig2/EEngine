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
  scope?: "pass" | "stage" | "span";
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

type GPUTimerPage = {
  querySet: GPUQuerySet;
  resolveBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  values: BigUint64Array;
  entryCount: number;
};

export class GPUTimer {
  private readonly pages: GPUTimerPage[] = [];
  private readonly entries: GPUTimerEntry[] = [];
  private entryCount = 0;
  onAllocationChanged?: () => void;

  constructor(
    private readonly device: GPUDevice,
    private readonly pageCapacity = 1024,
  ) {
    // WebGPU limits each query set to 4096 queries, not each frame. A bounded
    // Surface batch graph can contain more passes; allocate another page rather
    // than aborting rendering or silently dropping the remaining intervals.
    if (!Number.isSafeInteger(pageCapacity) || pageCapacity < 1 || pageCapacity > 2048) {
      throw new RangeError("GPUTimer page capacity must be 1..2048 passes");
    }
    this.pages.push(this.createPage());
  }

  get capacity(): number {
    return this.pages.length * this.pageCapacity;
  }

  /** Only the ring owner resets a slot, after readback has unmapped or abort. */
  reset(): void {
    this.entryCount = 0;
    for (const page of this.pages) {
      page.entryCount = 0;
    }
  }

  get allocatedBytes(): number {
    // Query storage is opaque; report API query count separately, not guessed VRAM.
    return this.pages.length * this.pageCapacity * 32;
  }

  get queryCapacity(): number {
    return this.capacity * 2;
  }

  private createPage(): GPUTimerPage {
    const index = this.pages.length;
    const queryCount = 2 * this.pageCapacity;
    const byteLength = queryCount * BigUint64Array.BYTES_PER_ELEMENT;
    const querySet = this.device.createQuerySet({
      label: `GPUTimer/page ${index}`,
      type: "timestamp",
      count: queryCount,
    });
    const resolveBuffer = this.device.createBuffer({
      label: `GPUTimer/resolve ${index}`,
      size: byteLength,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    const readbackBuffer = this.device.createBuffer({
      label: `GPUTimer/readback ${index}`,
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    return { querySet, resolveBuffer, readbackBuffer, values: new BigUint64Array(queryCount), entryCount: 0 };
  }

  getComputeWrites(label?: string): GPUTimerTimestampWrites {
    return this.allocateWrites(label, "compute");
  }

  getRenderWrites(label?: string): GPUTimerTimestampWrites {
    return this.allocateWrites(label, "render");
  }

  get readbackByteLength(): number {
    return 2 * this.entryCount * BigUint64Array.BYTES_PER_ELEMENT;
  }

  resolve(encoder: GPUCommandEncoder): void {
    for (const page of this.pages) {
      const queryCount = 2 * page.entryCount;
      if (queryCount === 0) continue;
      const byteLength = queryCount * BigUint64Array.BYTES_PER_ELEMENT;
      encoder.resolveQuerySet(page.querySet, 0, queryCount, page.resolveBuffer, 0);
      encoder.copyBufferToBuffer(page.resolveBuffer, 0, page.readbackBuffer, 0, byteLength);
    }
  }

  async download_results(): Promise<void> {
    const downloads = await Promise.allSettled(
      this.pages.map(async (page) => {
        const byteLength = 2 * page.entryCount * BigUint64Array.BYTES_PER_ELEMENT;
        if (byteLength === 0) {
          return;
        }
        await page.readbackBuffer.mapAsync(GPUMapMode.READ, 0, byteLength);
        try {
          page.values.set(new BigUint64Array(page.readbackBuffer.getMappedRange(0, byteLength)));
        } finally {
          page.readbackBuffer.unmap();
        }
      }),
    );
    const failures = downloads.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw failures[0]!.reason;
    }
  }

  results_to_console_table(): GPUTimerResult[] {
    const results: GPUTimerResult[] = [];
    for (let index = 0; index < this.entryCount; index++) {
      const entry = this.entries[index]!;
      const page = this.pages[Math.floor(index / this.pageCapacity)]!;
      const queryIndex = 2 * (index % this.pageCapacity);
      const start = page.values[queryIndex]!;
      const end = page.values[queryIndex + 1]!;
      if (end < start) {
        throw new Error(`Invalid GPU timestamp interval '${entry.label}'`);
      }
      results.push({
        label: entry.label,
        type: entry.type,
        duration_ms: 1e-6 * Number(end - start),
        start,
        end,
      });
    }
    return results;
  }

  destroy(): void {
    for (const page of this.pages) {
      page.querySet.destroy();
      page.resolveBuffer.destroy();
      page.readbackBuffer.destroy();
    }
  }

  private allocateWrites(label: string | undefined, type: GPUTimerPassType): GPUTimerTimestampWrites {
    const pageIndex = Math.floor(this.entryCount / this.pageCapacity);
    if (pageIndex === this.pages.length) {
      this.pages.push(this.createPage());
      this.onAllocationChanged?.();
    }
    const page = this.pages[pageIndex]!;
    const index = this.entryCount++;
    this.entries[index] = { label, type };
    const queryIndex = 2 * page.entryCount++;
    return {
      querySet: page.querySet,
      beginningOfPassWriteIndex: queryIndex,
      endOfPassWriteIndex: queryIndex + 1,
    };
  }
}
