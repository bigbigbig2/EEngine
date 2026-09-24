import type {
  FrameProfileSnapshot,
  OegPackProductAssetEvidenceV1,
  OegPackSceneManifestV3
} from "../../../../OEngine/src/index.ts";

export class LargeBasicTelemetry {
  readonly startedAt = performance.now();
  manifest?: OegPackSceneManifestV3;
  offline: OegPackProductAssetEvidenceV1 | null = null;
  openedAt?: number;
  firstPublishedAt?: number;
  firstSubmittedAt?: number;
  settledAt?: number;
  disposedAt?: number;
  sourceCount = 0;
  error?: string;
  readonly frames = new Map<number, FrameProfileSnapshot>();
  readonly events: { atMs: number; label: string; detail: string }[] = [];
  peakOwnerBytes = 0;
  peakGpuBytes = 0;
  runtime: unknown = null;
  streaming: unknown = null;
  memory: unknown = null;
  adapter: unknown = null;
  readonly sourceUrl = "/assets/oengine/offline-large/scene.oescene";

  event(label: string, detail = ""): void {
    this.events.push({ atMs: performance.now() - this.startedAt, label, detail });
    if (this.events.length > 200) this.events.shift();
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

  frameStats(): { cpu: ReturnType<LargeBasicTelemetry["distribution"]>; gpu: ReturnType<LargeBasicTelemetry["distribution"]>; raf: ReturnType<LargeBasicTelemetry["distribution"]> } {
    const frames = [...this.frames.values()];
    return {
      cpu: this.distribution(frames.map(frame => frame.cpuMs.frame).filter((value): value is number => value !== undefined)),
      gpu: this.distribution(frames.filter(frame => frame.gpu.sampled && !frame.gpu.pending && frame.gpu.segments.length > 0).map(frame => frame.gpu.segments.reduce((sum, part) => sum + part.durationMs, 0))),
      raf: this.distribution(frames.map(frame => frame.counters["frame.rafIntervalMs"]).filter((value): value is number => value !== undefined))
    };
  }

  capture(): object {
    return {
      schema: "oengine-large-basic-offline-demo-v1",
      capturedAt: new Date().toISOString(),
      sourceUrl: this.sourceUrl,
      manifest: this.manifest,
      offline: this.offline,
      sourceCount: this.sourceCount,
      times: { openedMs: this.openedAt, firstPublishedMs: this.firstPublishedAt, firstSubmittedMs: this.firstSubmittedAt, settledMs: this.settledAt, disposedMs: this.disposedAt },
      peaks: { ownerBytes: this.peakOwnerBytes, gpuBytes: this.peakGpuBytes },
      frameStats: this.frameStats(),
      frames: [...this.frames.values()],
      runtime: this.runtime,
      streaming: this.streaming,
      memory: this.memory,
      adapter: this.adapter,
      events: this.events,
      error: this.error ?? null
    };
  }
}
