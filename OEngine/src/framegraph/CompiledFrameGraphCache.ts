import type { CompiledFrameGraph } from "./FrameGraph.js";

export type CompiledFrameGraphCacheObserver = {
  hit(): void;
  miss(): void;
  evict(): void;
};

/** Owns compiled graph reuse, LRU eviction and destruction. */
export class CompiledFrameGraphCache {
  private readonly entries = new Map<string, CompiledFrameGraph>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("CompiledFrameGraphCache capacity must be positive");
    }
  }

  getOrCreate(
    key: string,
    build: () => CompiledFrameGraph,
    observer: CompiledFrameGraphCacheObserver
  ): CompiledFrameGraph {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      observer.hit();
      return cached;
    }

    observer.miss();
    const compiled = build();
    this.entries.set(key, compiled);
    if (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        const evicted = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        evicted?.destroy();
        observer.evict();
      }
    }
    return compiled;
  }

  destroy(): void {
    for (const graph of this.entries.values()) graph.destroy();
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
