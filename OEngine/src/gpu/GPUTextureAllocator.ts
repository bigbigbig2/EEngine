/**
 * GPUTextureAllocator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { GPUTextureContext } from "./GPUTextureContext.js";

export type GPUTexturePoolDescriptor = {
  width: number;
  height: number;
  depthOrArrayLayers?: number;
  dimension?: GPUTextureDimension;
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
  mipLevelCount?: number;
};

export class GPUTextureAllocator {
  readonly texture_cache: GPUTextureContext[] = [];
  private readonly pending = new Set<GPUTextureContext>();
  private destroyed = false;
  private readonly lastUse = new WeakMap<GPUTextureContext, number>();
  private scanIndex = 0;
  private lastScanTime = now();

  constructor(private readonly device: GPUDevice) {}

  get(descriptor: GPUTexturePoolDescriptor): GPUTextureContext {
    if (this.destroyed) {
      throw new Error("GPUTextureAllocator has been destroyed");
    }
    const normalized = normalizeDescriptor(descriptor);
    const index = this.lowerBound(normalized);
    let context: GPUTextureContext | undefined;
    if (index >= 0 && index < this.texture_cache.length) {
      const candidate = this.texture_cache[index]!;
      if (compareTexture(normalized, candidate) === 0) {
        context = candidate;
        this.texture_cache.splice(index, 1);
      }
    }
    if (!context) {
      context = new GPUTextureContext(this.device, {
        size: [
          normalized.width,
          normalized.height,
          normalized.depthOrArrayLayers
        ],
        dimension: normalized.dimension,
        format: normalized.format,
        usage: normalized.usage,
        mipLevelCount: normalized.mipLevelCount
      });
    }
    this.lastUse.set(context, now());
    return context;
  }

  release(context: GPUTextureContext, reuseAfter?: Promise<void>): void {
    if (this.pending.has(context) || this.texture_cache.includes(context)) {
      return;
    }
    void context.gpu_texture;
    if (reuseAfter !== undefined) {
      this.pending.add(context);
      void reuseAfter.then(
        () => this.finishPendingRelease(context),
        () => this.finishPendingRelease(context)
      );
      return;
    }
    this.cacheReleased(context);
  }

  private cacheReleased(context: GPUTextureContext): void {
    const descriptor = descriptorFromContext(context);
    const index = this.lowerBound(descriptor);
    this.texture_cache.splice(index, 0, context);
    this.lastUse.set(context, now());
  }

  update(): void {
    this.trimLargeCache();
    const time = now();
    if (time - this.lastScanTime > 200) this.scanExpired(16, time);
  }

  get gpu_memory_usage(): number {
    let usage = 0;
    for (const context of this.texture_cache) {
      usage += context.gpu_memory_usage;
    }
    for (const context of this.pending) {
      usage += context.gpu_memory_usage;
    }
    return usage;
  }

  get pending_count(): number {
    return this.pending.size;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const context of this.texture_cache) context.destroy();
    this.texture_cache.length = 0;
  }

  private finishPendingRelease(context: GPUTextureContext): void {
    if (!this.pending.delete(context)) return;
    if (this.destroyed) {
      context.destroy();
      return;
    }
    this.cacheReleased(context);
  }

  private lowerBound(descriptor: GPUTexturePoolDescriptor): number {
    let low = 0;
    let high = this.texture_cache.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareTexture(descriptor, this.texture_cache[mid]!) > 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private trimLargeCache(): void {
    const count = this.texture_cache.length;
    if (count <= 1024) return;
    const indices = Array.from({ length: count }, (_, index) => index);
    indices.sort(
      (a, b) =>
        (this.lastUse.get(this.texture_cache[a]!) ?? 0) -
        (this.lastUse.get(this.texture_cache[b]!) ?? 0)
    );
    const remove = indices.slice(0, count - 512).sort((a, b) => b - a);
    for (const index of remove) this.destroyAt(index);
  }

  private scanExpired(limit: number, time: number): void {
    let length = this.texture_cache.length;
    let remaining = Math.min(limit, length);
    while (remaining-- > 0 && length > 0) {
      const index = this.scanIndex % length;
      const context = this.texture_cache[index]!;
      if (time - (this.lastUse.get(context) ?? 0) > 3000) {
        this.destroyAt(index);
        length--;
      } else {
        this.scanIndex++;
      }
    }
    this.lastScanTime = time;
  }

  private destroyAt(index: number): void {
    const [context] = this.texture_cache.splice(index, 1);
    context?.destroy();
  }
}

function normalizeDescriptor(
  descriptor: GPUTexturePoolDescriptor
): Required<GPUTexturePoolDescriptor> {
  return {
    width: Math.max(1, descriptor.width | 0),
    height: Math.max(1, descriptor.height | 0),
    depthOrArrayLayers: Math.max(1, descriptor.depthOrArrayLayers ?? 1),
    dimension: descriptor.dimension ?? "2d",
    format: descriptor.format,
    usage: descriptor.usage,
    mipLevelCount: Math.max(1, descriptor.mipLevelCount ?? 1)
  };
}

function descriptorFromContext(
  context: GPUTextureContext
): Required<GPUTexturePoolDescriptor> {
  const [width, height, depthOrArrayLayers] = context.size;
  return {
    width,
    height,
    depthOrArrayLayers,
    dimension: context.descriptor.dimension ?? "2d",
    format: context.descriptor.format,
    usage: context.descriptor.usage,
    mipLevelCount: context.descriptor.mipLevelCount ?? 1
  };
}

function compareTexture(
  request: GPUTexturePoolDescriptor,
  context: GPUTextureContext
): number {
  return compareDescriptors(normalizeDescriptor(request), descriptorFromContext(context));
}

function compareDescriptors(
  a: Required<GPUTexturePoolDescriptor>,
  b: Required<GPUTexturePoolDescriptor>
): number {
  let result = a.dimension.localeCompare(b.dimension);
  if (result !== 0) return result;
  result = a.format.localeCompare(b.format);
  if (result !== 0) return result;
  result = a.usage - b.usage;
  if (result !== 0) return result;
  result = a.mipLevelCount - b.mipLevelCount;
  if (result !== 0) return result;
  result = a.width - b.width;
  if (result !== 0) return result;
  result = a.height - b.height;
  if (result !== 0) return result;
  return a.depthOrArrayLayers - b.depthOrArrayLayers;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
