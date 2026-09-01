/**
 * GPUBufferAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export type GPUBufferPoolDescriptor = {
  size: number;
  usage: GPUBufferUsageFlags;
  ensure_cleared?: readonly [offset: number, size: number];
};

export type GPUBufferClearEncoder = {
  clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
};

type CachedBuffer = {
  buffer: GPUBuffer;
  last_use_time: number;
};

export interface GPUBufferAllocatorEvidence {
  readonly allocatedBytes: number;
  readonly activeBytes: number;
  readonly pendingBytes: number;
  readonly cachedBytes: number;
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly cachedCount: number;
  readonly creationCount: number;
}

export class GPUBufferAllocator {
  private recent: CachedBuffer[] = [];
  private recentBytes = 0;
  private aged: CachedBuffer[] = [];
  private agedBytes = 0;
  private readonly active = new Set<GPUBuffer>();
  private readonly pending = new Set<GPUBuffer>();
  private destroyed = false;
  private time = 0;
  private scanIndex = 0;
  private creationCount = 0;
  private readonly recentAge = 4;

  constructor(private device: GPUDevice) {}

  increment_time(): void {
    this.time++;
  }

  get(
    descriptor: GPUBufferPoolDescriptor,
    encoder?: GPUBufferClearEncoder
  ): GPUBuffer {
    if (this.destroyed) {
      throw new Error("GPUBufferAllocator has been destroyed");
    }
    const request = normalizeDescriptor(descriptor);
    let buffer = this.takeCompatible(this.recent, request, true);
    if (!buffer) buffer = this.takeCompatible(this.aged, request, false);

    if (!buffer) {
      if (request.size > this.device.limits.maxBufferSize) {
        throw new Error(
          `Buffer size ${request.size} is larger than max buffer size ${this.device.limits.maxBufferSize}`
        );
      }
      buffer = this.device.createBuffer({
        label: "",
        size: request.size,
        usage: request.usage
      });
      this.creationCount++;
    } else {
      const clear = request.ensure_cleared;
      if (clear && clear[1] > 0) {
        if (!encoder) {
          throw new Error(
            "GPUBufferAllocator: ensure_cleared requires a command encoder"
          );
        }
        encoder.clearBuffer(buffer, clear[0], clear[1]);
      }
    }

    this.active.add(buffer);
    return buffer;
  }

  release(buffer: GPUBuffer, reuseAfter?: Promise<void>): boolean {
    if (!this.active.has(buffer)) return false;
    this.active.delete(buffer);
    if (reuseAfter !== undefined) {
      this.pending.add(buffer);
      void reuseAfter.then(
        () => this.finishPendingRelease(buffer),
        () => this.finishPendingRelease(buffer)
      );
      return true;
    }
    this.cacheReleased(buffer);
    return true;
  }

  update(): void {
    this.ageRecent();
    this.trimAged();
  }

  get gpu_memory_usage(): number {
    let bytes = this.recentBytes + this.agedBytes;
    for (const buffer of this.active) bytes += buffer.size;
    for (const buffer of this.pending) bytes += buffer.size;
    return bytes;
  }

  get active_count(): number {
    return this.active.size;
  }

  get cached_count(): number {
    return this.recent.length + this.aged.length;
  }

  get pending_count(): number {
    return this.pending.size;
  }

  evidence(): GPUBufferAllocatorEvidence {
    let activeBytes = 0;
    let pendingBytes = 0;
    for (const buffer of this.active) activeBytes += buffer.size;
    for (const buffer of this.pending) pendingBytes += buffer.size;
    const cachedBytes = this.recentBytes + this.agedBytes;
    return Object.freeze({
      allocatedBytes: activeBytes + pendingBytes + cachedBytes,
      activeBytes,
      pendingBytes,
      cachedBytes,
      activeCount: this.active.size,
      pendingCount: this.pending.size,
      cachedCount: this.recent.length + this.aged.length,
      creationCount: this.creationCount
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const buffer of this.active) buffer.destroy();
    this.active.clear();
    for (const entry of this.recent) entry.buffer.destroy();
    this.recent.length = 0;
    for (const entry of this.aged) entry.buffer.destroy();
    this.aged.length = 0;
    this.recentBytes = 0;
    this.agedBytes = 0;
  }

  private cacheReleased(buffer: GPUBuffer): void {
    const entry: CachedBuffer = { buffer, last_use_time: this.time };
    insertSorted(this.recent, entry);
    this.recentBytes += buffer.size;
  }

  private finishPendingRelease(buffer: GPUBuffer): void {
    if (!this.pending.delete(buffer)) return;
    if (this.destroyed) {
      buffer.destroy();
      return;
    }
    this.cacheReleased(buffer);
  }

  private takeCompatible(
    cache: CachedBuffer[],
    request: GPUBufferPoolDescriptor,
    recent: boolean
  ): GPUBuffer | null {
    const index = findCompatible(cache, request);
    if (index < 0) return null;
    const [entry] = cache.splice(index, 1);
    if (!entry) return null;
    if (recent) this.recentBytes -= entry.buffer.size;
    else this.agedBytes -= entry.buffer.size;
    return entry.buffer;
  }

  private ageRecent(minimumIterations = 4): void {
    let length = this.recent.length;
    if (length === 0) return;
    let iterations = Math.min(
      length,
      Math.max(Math.ceil(1.1 * this.creationCount), minimumIterations)
    );
    let moved = 0;
    while (iterations-- > 0 && this.recent.length > 0) {
      const index = this.scanIndex++ % this.recent.length;
      const entry = this.recent[index]!;
      if (this.time - entry.last_use_time > this.recentAge) {
        this.recent.splice(index, 1);
        this.recentBytes -= entry.buffer.size;
        insertSorted(this.aged, entry);
        this.agedBytes += entry.buffer.size;
        this.scanIndex--;
        moved++;
      }
    }
    this.creationCount += moved;
    this.creationCount = Math.floor(0.9 * this.creationCount);
  }

  private trimAged(): void {
    const byteLimit = Math.max(0, 16384, 0.2 * this.recentBytes);
    const countLimit = Math.max(
      0,
      16,
      Math.ceil(0.5 * this.recent.length)
    );
    while (
      this.agedBytes > byteLimit ||
      this.aged.length > countLimit
    ) {
      if (!this.destroyOldestAged()) break;
    }
  }

  private destroyOldestAged(): boolean {
    let oldestTime = Number.POSITIVE_INFINITY;
    let oldestIndex = -1;
    for (let index = 0; index < this.aged.length; index++) {
      const entry = this.aged[index]!;
      if (entry.last_use_time < oldestTime) {
        oldestTime = entry.last_use_time;
        oldestIndex = index;
      }
    }
    if (oldestIndex < 0) return false;
    const [entry] = this.aged.splice(oldestIndex, 1);
    if (!entry) return false;
    this.agedBytes -= entry.buffer.size;
    entry.buffer.destroy();
    return true;
  }
}

export class GPUNativeBufferAllocator {
  constructor(private readonly device: GPUDevice) {}

  get(descriptor: GPUBufferDescriptor): GPUBuffer {
    return this.device.createBuffer(descriptor);
  }

  release(buffer: GPUBuffer): boolean {
    buffer.destroy();
    return true;
  }

  destroy(): void {}
}

function normalizeDescriptor(
  descriptor: GPUBufferPoolDescriptor
): GPUBufferPoolDescriptor {
  return {
    size: Math.max(4, Math.ceil(descriptor.size / 4) * 4),
    usage: descriptor.usage,
    ensure_cleared: descriptor.ensure_cleared
  };
}

function findCompatible(
  cache: CachedBuffer[],
  request: GPUBufferPoolDescriptor
): number {
  let index = lowerBound(cache, request);
  for (; index < cache.length; index++) {
    const buffer = cache[index]!.buffer;
    if (
      buffer.size > 2 * request.size &&
      buffer.size - request.size > 1024
    ) {
      break;
    }
    if (
      buffer.size >= request.size &&
      (buffer.usage & request.usage) === request.usage
    ) {
      return index;
    }
  }
  return -1;
}

function insertSorted(cache: CachedBuffer[], entry: CachedBuffer): void {
  cache.splice(lowerBound(cache, entry.buffer), 0, entry);
}

function lowerBound(
  cache: CachedBuffer[],
  value: Pick<GPUBuffer, "size" | "usage"> | GPUBufferPoolDescriptor
): number {
  let low = 0;
  let high = cache.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareBuffer(cache[mid]!.buffer, value) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function compareBuffer(
  a: Pick<GPUBuffer, "size" | "usage">,
  b: Pick<GPUBuffer, "size" | "usage">
): number {
  const size = a.size - b.size;
  if (size !== 0) return size;
  const usageBits = popcount(a.usage) - popcount(b.usage);
  if (usageBits !== 0) return usageBits;
  return a.usage - b.usage;
}

function popcount(value: number): number {
  let x = value >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
