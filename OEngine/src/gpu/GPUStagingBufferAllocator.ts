import type {
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle,
} from "../debug/profiling/ResourceAccounting.js";

/**
 * GPUStagingBufferAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export class GPUStagingBufferAllocator {
  private readonly cache: GPUBuffer[] = [];
  private readonly pending = new Set<GPUBuffer>();
  private readonly buffers = new Set<GPUBuffer>();
  private readonly accountingHandles = new Map<GPUBuffer, AccountingResourceHandle>();
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly resourceAccounting?: ResourceAccounting,
  ) {}

  get gpu_memory_usage(): number {
    let bytes = 0;
    for (const buffer of this.buffers) bytes += buffer.size;
    return bytes;
  }

  get(size: number): GPUBuffer {
    if (this.destroyed) throw new Error("GPUStagingBufferAllocator is destroyed");
    const resolvedSize = Math.max(4, Math.ceil(size / 4) * 4);
    const index = this.lowerBound(resolvedSize);
    const cached = index < this.cache.length ? this.cache.splice(index, 1)[0] : undefined;
    if (cached !== undefined) return cached;
    const buffer = this.device.createBuffer({
      label: "",
      size: resolvedSize,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.buffers.add(buffer);
    if (this.resourceAccounting !== undefined) {
      this.accountingHandles.set(
        buffer,
        this.resourceAccounting.created({
          kind: "buffer",
          category: "upload",
          owner: "GPUStagingBufferAllocator",
          bytes: resolvedSize,
        }),
      );
    }
    return buffer;
  }

  release(buffer: GPUBuffer, reuseAfter?: Promise<unknown>): void {
    if (this.destroyed) return;
    if (reuseAfter !== undefined) {
      if (this.pending.has(buffer)) return;
      this.pending.add(buffer);
      void reuseAfter.then(
        () => {
          if (this.destroyed) return;
          this.pending.delete(buffer);
          this.insert(buffer);
        },
        () => {
          if (this.destroyed) return;
          this.pending.delete(buffer);
          this.insert(buffer);
        },
      );
      return;
    }
    this.insert(buffer);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const buffer of this.buffers) {
      buffer.destroy();
      const handle = this.accountingHandles.get(buffer);
      if (handle !== undefined) this.resourceAccounting!.destroyed(handle);
    }
    this.cache.length = 0;
    this.pending.clear();
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
