import type {
  FrameProfileSnapshot, WebCookedSceneOptions, WebCookProgress, WebCookSceneCatalogSnapshot
} from "../../../../OEngine/src/index.ts";

type Distribution = { p50: number; p95: number; count: number } | null;
type PublicationTiming = Parameters<NonNullable<WebCookedSceneOptions["onProductPublicationTiming"]>>[0];
export interface AuthoredMaterialSummary {
  readonly index: number;
  readonly baseColor: readonly number[];
  readonly metallic: number;
  readonly roughness: number;
  readonly baseColorTexture: boolean;
  readonly ormTexture: boolean;
  readonly normalTexture: boolean;
  readonly emissiveTexture: boolean;
}

export class BasicTelemetry {
  readonly startedAt = performance.now();
  readonly frames = new Map<number, FrameProfileSnapshot>();
  readonly events: { atMs: number; label: string; detail: string }[] = [];
  readonly publications: PublicationTiming[] = [];
  catalog?: WebCookSceneCatalogSnapshot;
  materialDomains: AuthoredMaterialSummary[] = [];
  progress?: WebCookProgress;
  catalogAt?: number;
  firstPublishedAt?: number;
  firstSubmittedAt?: number;
  settledAt?: number;
  releasingAt?: number;
  disposedAt?: number;
  sourceCount = 0;
  assetCount = 0;
  shardCount = 0;
  materialCount = 0;
  peakOwnerBytes = 0;
  peakGpuBytes = 0;
  cook: unknown = null;
  runtime: unknown = null;
  streaming: unknown = null;
  texture: unknown = null;
  features: unknown = null;
  memory: unknown = null;
  adapter: unknown = null;
  error?: string;

  constructor(readonly sourceUrl: string) {}

  acceptMaterialCatalog(catalog: WebCookSceneCatalogSnapshot): void {
    const domains = new Map<number, AuthoredMaterialSummary>();
    for (const primitive of catalog.primitives) {
      if (domains.has(primitive.materialIndex)) continue;
      const material = primitive.material;
      const base = material.baseColorFactor;
      domains.set(primitive.materialIndex, {
        index: primitive.materialIndex,
        baseColor: Array.isArray(base) && base.length === 4 && base.every(value => typeof value === "number") ? base : [1, 1, 1, 1],
        metallic: typeof material.metallicFactor === "number" ? material.metallicFactor : 0,
        roughness: typeof material.roughnessFactor === "number" ? material.roughnessFactor : 1,
        baseColorTexture: material.baseColorTexture !== undefined,
        ormTexture: material.metallicRoughnessTexture !== undefined,
        normalTexture: material.normalTexture !== undefined,
        emissiveTexture: material.emissiveTexture !== undefined
      });
    }
    this.materialDomains = [...domains.values()].sort((left, right) => left.index - right.index);
  }

  event(label: string, detail = ""): void {
    this.events.push({ atMs: performance.now() - this.startedAt, label, detail });
    if (this.events.length > 100) this.events.shift();
  }

  acceptFrame(frame: FrameProfileSnapshot): void {
    this.frames.set(frame.frameIndex, frame);
    if (this.frames.size > 360) this.frames.delete(this.frames.keys().next().value!);
  }

  acceptMemory(value: { allocatedBytes: number }): void {
    this.memory = value;
    this.peakOwnerBytes = Math.max(this.peakOwnerBytes, value.allocatedBytes);
  }

  private distribution(values: readonly number[]): Distribution {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return { p50: sorted[Math.floor((sorted.length - 1) * 0.5)]!, p95: sorted[Math.floor((sorted.length - 1) * 0.95)]!, count: sorted.length };
  }

  frameStats(): { cpu: Distribution; gpu: Distribution; raf: Distribution } {
    const frames = [...this.frames.values()];
    return {
      cpu: this.distribution(frames.map(frame => frame.cpuMs.frame)),
      gpu: this.distribution(frames.filter(frame => frame.gpu.sampled && !frame.gpu.pending && frame.gpu.segments.length > 0)
        .map(frame => frame.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0))),
      raf: this.distribution(frames.map(frame => frame.counters["frame.rafIntervalMs"]).filter((value): value is number => value !== undefined))
    };
  }

  capture(): object {
    return {
      schema: "oengine-rendering-lab-basic-web-product-v1",
      capturedAt: new Date().toISOString(), sourceUrl: this.sourceUrl,
      catalog: this.catalog && {
        primitiveCount: this.catalog.primitiveCount,
        instanceCount: this.catalog.instances.length,
        sourceBytes: this.catalog.sourceBytes,
        sourceTransferMode: this.catalog.sourceTransferMode,
        uniqueTriangles: this.catalog.primitives.reduce((sum, item) => sum + item.triangleCount, 0)
      },
      progress: this.progress, sourceCount: this.sourceCount, assetCount: this.assetCount, shardCount: this.shardCount, materialCount: this.materialCount, materialDomains: this.materialDomains,
      times: { catalogMs: this.catalogAt, firstPublishedMs: this.firstPublishedAt, firstSubmittedMs: this.firstSubmittedAt, settledMs: this.settledAt, disposedMs: this.disposedAt },
      peaks: { ownerBytes: this.peakOwnerBytes, gpuBytes: this.peakGpuBytes },
      frameStats: this.frameStats(), frames: [...this.frames.values()], publications: this.publications,
      cook: this.cook, runtime: this.runtime, streaming: this.streaming, texture: this.texture, features: this.features,
      memory: this.memory, adapter: this.adapter, events: this.events,
      error: this.error ?? null
    };
  }
}
