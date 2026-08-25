/**
 * GPUStagingBufferAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export class GPUStagingBufferAllocator {
  private readonly cache: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {}

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
    return cached ?? this.device.createBuffer({
      label: "",
      size: resolvedSize,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
      mappedAtCreation: true
    });
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
    for (const buffer of this.cache) buffer.destroy();
    this.cache.length = 0;
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
