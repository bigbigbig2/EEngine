import type {
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";

/**
 * GPUStagingBufferAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export class GPUStagingBufferAllocator {
  private readonly cache: GPUBuffer[] = [];
  private readonly buffers = new Set<GPUBuffer>();
  private readonly accountingHandles = new Map<GPUBuffer, AccountingResourceHandle>();

  constructor(
    private readonly device: GPUDevice,
    private readonly resourceAccounting?: ResourceAccounting
  ) {}

  get gpu_memory_usage(): number {
    let bytes = 0;
    for (const buffer of this.cache) bytes += buffer.size;
    return bytes;
  }

  get(size: number): GPUBuffer {
    const resolvedSize = Math.max(4, Math.ceil(size / 4) * 4);
    const index = this.lowerBound(resolvedSize);
    const cached = index < this.cache.length
      ? this.cache.splice(index, 1)[0]
      : undefined;
    if (cached !== undefined) return cached;
    const buffer = this.device.createBuffer({
      label: "",
      size: resolvedSize,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
      mappedAtCreation: true
    });
    this.buffers.add(buffer);
    if (this.resourceAccounting !== undefined) {
      this.accountingHandles.set(buffer, this.resourceAccounting.created({
        kind: "buffer",
        category: "upload",
        owner: "GPUStagingBufferAllocator",
        bytes: resolvedSize
      }));
    }
    return buffer;
  }

  release(buffer: GPUBuffer): void {
    const state = buffer.mapState;
    if (state === "mapped") {
      this.insert(buffer);
      return;
    }
    if (state !== "unmapped") {
      throw new Error(`Invalid map state: ${state}`);
    }
    buffer.mapAsync(GPUMapMode.WRITE).then(
      () => this.insert(buffer),
      (error) => console.error(error)
    );
  }

  destroy(): void {
    for (const buffer of this.buffers) {
      buffer.destroy();
      const handle = this.accountingHandles.get(buffer);
      if (handle !== undefined) this.resourceAccounting!.destroyed(handle);
    }
    this.cache.length = 0;
    this.buffers.clear();
    this.accountingHandles.clear();
  }

  private lowerBound(size: number): number {
    let low = 0;
    let high = this.cache.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.cache[mid]!.size < size) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private insert(buffer: GPUBuffer): boolean {
    this.cache.splice(this.lowerBound(buffer.size), 0, buffer);
    return true;
  }
}
