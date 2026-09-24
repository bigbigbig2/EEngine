import type {
  FrameProfileSnapshot,
  WebCookProductTaskTraceEventV1,
  WebCookProgress,
  WebCookSceneCatalogSnapshot,
  WebCookedSceneOptions
} from "../../../../OEngine/src/index.ts";

export type PublicationTiming = Parameters<NonNullable<WebCookedSceneOptions["onProductPublicationTiming"]>>[0];
export type ProductRow = {
  ordinal: number;
  primitive: string;
  assets: number;
  triangles: number;
  pages: number;
  phase: string;
  elapsedMs: number;
  canonicalizeMs: number;
  wasmPlanMs: number;
  spillMs: number;
  publishMs: number;
  spillBytes: number;
  error?: string;
};

export class PineForestTelemetry {
  readonly startedAt = performance.now();
  catalog?: WebCookSceneCatalogSnapshot;
  catalogAt?: number;
  firstPublishedAt?: number;
  firstSubmittedAt?: number;
  settledAt?: number;
  releasingAt?: number;
  disposedAt?: number;
  progress?: WebCookProgress;
  error?: string;
  readonly products = new Map<number, ProductRow>();
  readonly publications: PublicationTiming[] = [];
  readonly covered = new Set<number>();
  readonly frames = new Map<number, FrameProfileSnapshot>();
  readonly events: { atMs: number; label: string; detail: string }[] = [];
  peakOwnerBytes = 0;
  peakHeapBytes = 0;
  peakGpuBytes = 0;
  runtime: unknown = null;
  streaming: unknown = null;
  memory: unknown = null;
  cook: unknown = null;
  adapter: unknown = null;
  readonly sourceUrl = "/assets/oengine/pine-forest/pine_forest_render_geometry.glb";

  event(label: string, detail = ""): void {
    this.events.push({ atMs: performance.now() - this.startedAt, label, detail });
    if (this.events.length > 200) this.events.shift();
  }

  acceptTrace(trace: WebCookProductTaskTraceEventV1): void {
    const task = trace.task;
    if (trace.kind === "completed") for (const index of task.sceneAssetIndices) this.covered.add(index);
    this.products.set(task.productOrdinal, {
      ordinal: task.productOrdinal,
      primitive: task.primitive,
      assets: task.sceneAssetIndices.length,
      triangles: task.triangles,
      pages: trace.metrics.pageCount,
      phase: trace.phase ?? trace.kind,
      elapsedMs: trace.elapsedMs ?? 0,
      canonicalizeMs: trace.metrics.canonicalizeMs,
      wasmPlanMs: trace.metrics.wasmPlanMs,
      spillMs: trace.metrics.spillMs,
      publishMs: trace.metrics.publishMs,
      spillBytes: trace.metrics.spillBytes,
      ...(trace.error ? { error: trace.error } : {})
    });
    this.peakHeapBytes = Math.max(this.peakHeapBytes, trace.metrics.spillPeakBytes);
    if (trace.kind === "failed" || trace.kind === "cancelled") this.event(trace.kind, `${task.primitive.slice(0, 80)}: ${trace.error ?? ""}`);
  }

  acceptFrame(snapshot: FrameProfileSnapshot): void {
    this.frames.set(snapshot.frameIndex, snapshot);
    if (this.frames.size > 360) this.frames.delete(this.frames.keys().next().value!);
  }

  acceptMemory(memory: { allocatedBytes: number }): void {
    this.memory = memory;
    this.peakOwnerBytes = Math.max(this.peakOwnerBytes, memory.allocatedBytes);
  }

  distribution(values: readonly number[]): { p50: number; p95: number; count: number } | null {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { p50: sorted[Math.floor((sorted.length - 1) * 0.5)]!, p95: sorted[Math.floor((sorted.length - 1) * 0.95)]!, count: sorted.length };
  }

  frameStats(): { cpu: ReturnType<PineForestTelemetry["distribution"]>; gpu: ReturnType<PineForestTelemetry["distribution"]>; raf: ReturnType<PineForestTelemetry["distribution"]> } {
    const frames = [...this.frames.values()];
    return {
      cpu: this.distribution(frames.map(frame => frame.cpuMs.frame).filter((value): value is number => value !== undefined)),
      gpu: this.distribution(frames.filter(frame => frame.gpu.sampled && !frame.gpu.pending && frame.gpu.segments.length > 0).map(frame => frame.gpu.segments.reduce((sum, part) => sum + part.durationMs, 0))),
      raf: this.distribution(frames.map(frame => frame.counters["frame.rafIntervalMs"]).filter((value): value is number => value !== undefined))
    };
  }

  capture(): object {
    return {
      schema: "oengine-pine-forest-demo-v1", capturedAt: new Date().toISOString(), sourceUrl: this.sourceUrl,
      catalog: this.catalog && {
        primitiveCount: this.catalog.primitiveCount,
        instanceCount: this.catalog.instances.length,
        sourceBytes: this.catalog.sourceBytes,
        sourceTransferMode: this.catalog.sourceTransferMode,
        uniqueTriangles: this.catalog.primitives.reduce((sum, item) => sum + item.triangleCount, 0),
        logicalTriangles: this.catalog.primitives.reduce((sum, item) => sum + item.triangleCount * item.instanceNodeIndices.length, 0),
        primitives: this.catalog.primitives.map(item => ({ catalogIndex: item.catalogIndex, meshIndex: item.meshIndex,
          primitiveIndex: item.primitiveIndex, triangleCount: item.triangleCount, instanceCount: item.instanceNodeIndices.length }))
      }, progress: this.progress, products: [...this.products.values()],
      publicationTimings: this.publications, coverage: [...this.covered].sort((a, b) => a - b),
      times: { catalogMs: this.catalogAt, firstPublishedMs: this.firstPublishedAt, firstSubmittedMs: this.firstSubmittedAt, settledMs: this.settledAt, disposedMs: this.disposedAt },
      peaks: { ownerBytes: this.peakOwnerBytes, spillBytes: this.peakHeapBytes, gpuBytes: this.peakGpuBytes },
      frameStats: this.frameStats(), frames: [...this.frames.values()], runtime: this.runtime,
      streaming: this.streaming, memory: this.memory, cook: this.cook, adapter: this.adapter,
      events: this.events, error: this.error ?? null
    };
  }
}
