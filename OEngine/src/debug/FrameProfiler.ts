import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  GpuFrameCounterBuffer,
  type GpuCounterFieldName,
  type GpuCounterValues
} from "./GpuFrameCounters.js";
import { BENCHMARK_GPU_COUNTER_EVIDENCE } from "./BenchmarkCapabilityEvidence.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  classifyGpuFramePhase,
  type GpuFramePhase
} from "./GpuFramePhase.js";
import {
  MetricRegistry,
  CPU_SECTION_METRIC_IDS,
  DEFAULT_METRIC_DESCRIPTORS,
  type MetricDescriptor
} from "./profiling/MetricRegistry.js";
import type { MetricSample, MetricSampleAvailability } from "./profiling/Metric.js";
import { ProfileHistory } from "./profiling/ProfileHistory.js";
import type { ProfileFrame } from "./profiling/ProfileFrame.js";
import type { ProfileSpan } from "./profiling/ProfileSpan.js";
import type { ResourceAccounting } from "./profiling/ResourceAccounting.js";

export interface FrameProfilerOptions {
  enabled?: boolean;
  gpuSampleInterval?: number;
  gpuCounterSampleInterval?: number;
  gpuTimestampAvailable?: boolean;
  warmupFrames?: number;
  historyCapacity?: number;
  readbackRingSlots?: number;
  now?: () => number;
}

export type FrameProfilerMode = "live" | "record" | "deep-capture";

export interface FrameCountEvidence {
  count: number;
  labels: Record<string, number>;
}

export interface FrameReadbackEvidence extends FrameCountEvidence {
  bytes: number;
}

export interface FrameUploadEvidence {
  writes: number;
  bytes: number;
  labels: Record<string, number>;
}

export interface FrameGraphEvidence {
  builds: number;
  compiles: number;
  executes: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
}

export type FrameGpuPassType = "compute" | "render";

export interface FrameGpuSegment {
  label: string;
  type: FrameGpuPassType;
  phase: GpuFramePhase;
  durationMs: number;
}

export interface FrameGpuEvidence {
  available: boolean;
  sampled: boolean;
  pending: boolean;
  segments: FrameGpuSegment[];
}

export interface FrameGpuCounterEvidence {
  available: boolean;
  sampled: boolean;
  pending: boolean;
  dropped: boolean;
  schemaVersion: number;
  values: Partial<GpuCounterValues>;
}

export interface FrameProfilerDiagnostics {
  validationErrorCount: number;
  uncapturedErrorCount: number;
  deviceLostCount: number;
  uncapturedErrors: string[];
  deviceLostReasons: string[];
  failedGpuTimestampBatches: number;
  droppedGpuCounterSamples: number;
  failedGpuCounterSamples: number;
}

export interface FrameProfileSnapshot {
  frameIndex: number;
  cpuMs: Record<string, number>;
  submits: FrameCountEvidence;
  readbacks: FrameReadbackEvidence;
  uploads: FrameUploadEvidence;
  graph: FrameGraphEvidence;
  counters: Record<string, number>;
  gpu: FrameGpuEvidence;
  gpuCounters: FrameGpuCounterEvidence;
}

export interface FrameGpuTimingInput {
  label?: string;
  type: FrameGpuPassType;
  duration_ms: number;
}

export type FrameProfileListener = (snapshot: FrameProfileSnapshot) => void;

const KNOWN_RUNTIME_METRIC_IDS = Object.freeze([
  "ao.bentNormalUpsamplePasses",
  "ao.compositePasses",
  "ao.historyBytes",
  "ao.historyRevision",
  "ao.historyValid",
  "ao.internalPixels",
  "ao.pixels",
  "ao.rawPasses",
  "ao.spatialPasses",
  "ao.temporalPasses",
  "gpu.commands.bundleExecution",
  "gpu.commands.computePass",
  "gpu.commands.dispatch",
  "gpu.commands.draw",
  "gpu.commands.renderPass",
  "gpu.residentBytes",
  "hzb.computeBuilds",
  "hzb.computePasses",
  "hzb.dispatches",
  "hzb.historyInvalidations",
  "hzb.historyValid",
  "hzb.outputPixels",
  "legacy.instances.candidate",
  "legacy.instances.frustumCulled",
  "legacy.instances.frustumUnculled",
  "legacy.instances.rejected",
  "legacy.visibility.activeMaterialBuckets",
  "legacy.visibility.bucketPasses",
  "legacy.visibility.drawCount",
  "legacy.visibility.secondChance",
  "lighting.clusterCount",
  "lighting.environment.diffuseAllocatedBytes",
  "lighting.environment.specularAllocatedBytes",
  "lighting.environment.specularMipLevelCount",
  "lighting.localLightCount",
  "packed.material.activeMaterials",
  "packed.material.residentTextureBytes",
  "packed.material.residentTextures",
  "packed.material.samplerFallbacks",
  "packed.material.surfaceAttachmentBytes",
  "packed.material.surfaceBytesPerPixel",
  "packed.material.textureFallbacks",
  "packed.visibility.drawIndirect",
  "packed.visibility.hierarchy",
  "packed.visibility.keyAttachmentBytes",
  "packed.visibility.rasterWorkCapacity",
  "packed.visibility.verticesPerTriangle",
  "pipeline.compute.cacheHits",
  "pipeline.compute.cacheMisses",
  "pipeline.compute.createCount",
  "pipeline.compute.firstUseCount",
  "pipeline.compute.hostCallMs",
  "pipeline.render.cacheHits",
  "pipeline.render.cacheMisses",
  "pipeline.render.createCount",
  "pipeline.render.firstUseCount",
  "pipeline.render.hostCallMs",
  "runtime.scenePrepareCount",
  "runtime.viewPrepareCount",
  "shadow.atlasBytes",
  "shadow.atlasPixelsUpdated",
  "shadow.packedCascadeDraws",
  "ssr.compositePasses",
  "ssr.historyBytes",
  "ssr.historyRevision",
  "ssr.historyValid",
  "ssr.internalPixels",
  "ssr.prefilterPasses",
  "ssr.resolvePasses",
  "ssr.spatialPasses",
  "ssr.temporalPasses",
  "ssr.tracePasses",
  "temporal.classificationPasses",
  "temporal.drsFeedbackLatencyFrames",
  "temporal.drsGpuMs",
  "temporal.historyBytes",
  "temporal.historyInvalidations",
  "temporal.historyRevision",
  "temporal.historyValid",
  "temporal.internalPixels",
  "temporal.outputPixels",
  "temporal.taaPasses"
]);

const KNOWN_SUM_METRIC_IDS = new Set([
  "gpu.commands.bundleExecution",
  "gpu.commands.computePass",
  "gpu.commands.dispatch",
  "gpu.commands.draw",
  "gpu.commands.renderPass",
  "legacy.instances.rejected",
  "pipeline.compute.cacheHits",
  "pipeline.compute.cacheMisses",
  "pipeline.compute.createCount",
  "pipeline.compute.firstUseCount",
  "pipeline.compute.hostCallMs",
  "pipeline.render.cacheHits",
  "pipeline.render.cacheMisses",
  "pipeline.render.createCount",
  "pipeline.render.firstUseCount",
  "pipeline.render.hostCallMs",
  "runtime.scenePrepareCount",
  "runtime.viewPrepareCount"
]);

type ActiveFrame = {
  startedAt: number;
  epoch: number;
  warmup: boolean;
  snapshot: FrameProfileSnapshot;
  gpuCounterSampleEncoded: boolean;
  gpuCounterFields: Set<GpuCounterFieldName>;
  spans: ProfileSpan[];
  nextSpanId: number;
  metricSamples: Record<string, MetricSample>;
};

type GpuTimingBatch = {
  contextLabel: string;
  timings: FrameGpuTimingInput[] | null;
};

type GpuTimingBatchState = {
  sealed: boolean;
  batches: GpuTimingBatch[];
};

/**
 * CPU-side frame evidence collector. GPU timestamps are attached later because
 * readback is asynchronous. Disabled profiling does not retain frame history.
 */
export class FrameProfiler {
  private enabledValue: boolean;
  private gpuSampleIntervalValue: number;
  private gpuCounterSampleIntervalValue: number;
  private configuredGpuSampleIntervalValue: number;
  private configuredGpuCounterSampleIntervalValue: number;
  private configuredWarmupFramesValue: number;
  private gpuCounterSamplingEnabledValue = false;
  private gpuTimestampAvailableValue: boolean;
  private historyCapacityValue: number;
  private readbackRingSlotsValue: number;
  private readonly now: () => number;
  readonly metricRegistry = new MetricRegistry();
  private profileHistoryValue: ProfileHistory | null = null;
  private modeValue: FrameProfilerMode = "live";
  private active: ActiveFrame | null = null;
  private readonly frames: FrameProfileSnapshot[] = [];
  private readonly listeners = new Set<FrameProfileListener>();
  private gpuDevice: GPUDevice | null = null;
  private gpuFrameCounters: GpuFrameCounterBuffer | null = null;
  private resourceAccounting: ResourceAccounting | undefined;
  private validationErrorCount = 0;
  private uncapturedErrorCount = 0;
  private deviceLostCount = 0;
  private readonly uncapturedErrors: string[] = [];
  private readonly deviceLostReasons: string[] = [];
  private failedGpuTimestampBatches = 0;
  private droppedGpuCounterSamples = 0;
  private failedGpuCounterSamples = 0;
  private readonly gpuCounterFieldsByFrame = new Map<
    number,
    GpuCounterFieldName[]
  >();
  private readonly gpuTimingBatchesByFrame = new Map<
    number,
    GpuTimingBatchState
  >();
  private readonly metricSamplesByFrame = new Map<number, Readonly<Record<string, MetricSample>>>();
  private readonly failedGpuTimingFrames = new Set<number>();
  private epochValue = 0;
  private warmupRemainingValue = 0;
  private deviceEpoch = 0;
  private readonly onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    const error = event.error;
    const name = error.constructor?.name || "GPUError";
    this.uncapturedErrorCount++;
    if (name === "GPUValidationError") this.validationErrorCount++;
    appendBounded(this.uncapturedErrors, `${name}: ${error.message}`);
  };

  constructor(options: FrameProfilerOptions = {}) {
    this.enabledValue = options.enabled ?? false;
    this.gpuSampleIntervalValue = positiveInteger(
      options.gpuSampleInterval ?? 60,
      "gpuSampleInterval"
    );
    this.gpuCounterSampleIntervalValue = positiveInteger(
      options.gpuCounterSampleInterval ?? 60,
      "gpuCounterSampleInterval"
    );
    this.configuredGpuSampleIntervalValue = this.gpuSampleIntervalValue;
    this.configuredGpuCounterSampleIntervalValue = this.gpuCounterSampleIntervalValue;
    this.configuredWarmupFramesValue = nonNegativeInteger(
      options.warmupFrames ?? 0,
      "warmupFrames"
    );
    this.gpuCounterSamplingEnabledValue = options.gpuCounterSampleInterval !== undefined;
    this.gpuTimestampAvailableValue = options.gpuTimestampAvailable ?? false;
    this.historyCapacityValue = positiveInteger(
      options.historyCapacity ?? 2048,
      "historyCapacity"
    );
    this.readbackRingSlotsValue = positiveInteger(
      options.readbackRingSlots ?? 3,
      "readbackRingSlots"
    );
    if (this.readbackRingSlotsValue < 3) {
      throw new RangeError("readbackRingSlots must be at least 3");
    }
    this.now = options.now ?? (() => performance.now());
    for (const descriptor of DEFAULT_METRIC_DESCRIPTORS) this.metricRegistry.register(descriptor);
    for (const id of KNOWN_RUNTIME_METRIC_IDS) {
      this.ensureMetric(id, "counted", KNOWN_SUM_METRIC_IDS.has(id) ? "sum" : "last");
    }
    for (const field of GPU_COUNTER_FIELDS) this.ensureMetric(`gpu.counter.${field.name}`, "counted", "last");
    if (this.enabledValue) this.profileHistoryValue = new ProfileHistory(this.historyCapacityValue);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get gpuTimestampAvailable(): boolean {
    return this.gpuTimestampAvailableValue;
  }

  get gpuSampleInterval(): number {
    return this.gpuSampleIntervalValue;
  }

  get gpuCounterSampleInterval(): number {
    return this.gpuCounterSampleIntervalValue;
  }

  get readbackRingSlots(): number {
    return this.readbackRingSlotsValue;
  }

  get mode(): FrameProfilerMode {
    return this.modeValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  get warmupRemaining(): number {
    return this.warmupRemainingValue;
  }

  startEpoch(warmupFrames = 0, epoch = this.epochValue + 1): void {
    if (this.active !== null) throw new Error("Cannot change profiler epoch during a frame");
    if (!Number.isInteger(epoch) || epoch < 0) throw new RangeError("epoch must be a non-negative integer");
    if (!Number.isInteger(warmupFrames) || warmupFrames < 0) throw new RangeError("warmupFrames must be a non-negative integer");
    this.epochValue = epoch;
    this.warmupRemainingValue = warmupFrames;
  }

  setMode(mode: FrameProfilerMode): void {
    if (this.active !== null) throw new Error("Cannot change FrameProfiler mode during a frame");
    this.modeValue = mode;
    if (mode === "live") {
      this.gpuCounterSamplingEnabledValue = false;
      const configuredInterval = this.configuredGpuSampleIntervalValue;
      this.gpuSampleIntervalValue = Math.max(4, configuredInterval);
      this.gpuCounterSampleIntervalValue = this.configuredGpuCounterSampleIntervalValue;
    } else if (mode === "record") {
      this.gpuCounterSamplingEnabledValue = true;
      this.gpuSampleIntervalValue = 1;
      this.gpuCounterSampleIntervalValue = this.configuredGpuCounterSampleIntervalValue;
    } else if (mode === "deep-capture") {
      this.gpuCounterSamplingEnabledValue = true;
      this.gpuSampleIntervalValue = 1;
      this.gpuCounterSampleIntervalValue = 1;
    }
    this.startEpoch(this.configuredWarmupFramesValue);
  }

  get historyStore(): ProfileHistory | null {
    return this.profileHistoryValue;
  }

  get metricCatalog(): readonly MetricDescriptor[] {
    return this.metricRegistry.values();
  }

  registerMetric(descriptor: MetricDescriptor): MetricDescriptor {
    return this.metricRegistry.register(descriptor);
  }

  recordMetric(id: string, value: number | null, availability: MetricSampleAvailability = "available"): void {
    const descriptor = this.metricRegistry.require(id);
    if (this.active === null) return;
    if (availability === "available") {
      if (value === null) throw new TypeError(`Available metric '${id}' requires a number`);
      const validated = nonNegativeFinite(value, id);
      this.active.snapshot.counters[id] = validated;
      this.active.metricSamples[id] = sample(
        id,
        validated,
        this.active.snapshot.frameIndex,
        descriptor.source,
        descriptor.cost === "instrumented"
      );
    } else {
      if (value !== null) throw new TypeError(`Unavailable metric '${id}' requires a null value`);
      this.active.metricSamples[id] = sample(
        id,
        null,
        this.active.snapshot.frameIndex,
        descriptor.source,
        descriptor.cost === "instrumented",
        availability
      );
    }
  }

  get diagnostics(): FrameProfilerDiagnostics {
    const ring = this.gpuFrameCounters?.stats;
    return {
      validationErrorCount: this.validationErrorCount,
      uncapturedErrorCount: this.uncapturedErrorCount,
      deviceLostCount: this.deviceLostCount,
      uncapturedErrors: [...this.uncapturedErrors],
      deviceLostReasons: [...this.deviceLostReasons],
      failedGpuTimestampBatches: this.failedGpuTimestampBatches,
      droppedGpuCounterSamples: Math.max(
        this.droppedGpuCounterSamples,
        ring?.dropped ?? 0
      ),
      failedGpuCounterSamples: Math.max(
        this.failedGpuCounterSamples,
        ring?.failed ?? 0
      )
    };
  }

  get gpuCounterBuffer(): GPUBuffer | null {
    return this.gpuFrameCounters?.buffer ?? null;
  }

  subscribe(listener: FrameProfileListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(options: Omit<FrameProfilerOptions, "now">): void {
    if (this.active !== null) throw new Error("Cannot configure FrameProfiler during a frame");
    if (options.enabled !== undefined) {
      this.enabledValue = options.enabled;
      if (this.enabledValue) this.profileHistoryValue ??= new ProfileHistory(this.historyCapacityValue);
    }
    if (options.gpuTimestampAvailable !== undefined) {
      this.gpuTimestampAvailableValue = options.gpuTimestampAvailable;
    }
    if (options.gpuSampleInterval !== undefined) {
      const interval = positiveInteger(
        options.gpuSampleInterval,
        "gpuSampleInterval"
      );
      this.configuredGpuSampleIntervalValue = interval;
      this.gpuSampleIntervalValue = this.modeValue === "deep-capture" || this.modeValue === "record"
        ? 1
        : this.modeValue === "live" ? Math.max(4, interval) : interval;
    }
    if (options.warmupFrames !== undefined) {
      this.configuredWarmupFramesValue = nonNegativeInteger(
        options.warmupFrames,
        "warmupFrames"
      );
    }
    if (options.gpuCounterSampleInterval !== undefined) {
      const interval = positiveInteger(
        options.gpuCounterSampleInterval,
        "gpuCounterSampleInterval"
      );
      this.configuredGpuCounterSampleIntervalValue = interval;
      this.gpuCounterSampleIntervalValue = this.modeValue === "deep-capture"
        ? 1
        : interval;
    }
    if (options.historyCapacity !== undefined) {
      this.historyCapacityValue = positiveInteger(
        options.historyCapacity,
        "historyCapacity"
      );
      this.trimHistory();
      this.profileHistoryValue?.setCapacity(this.historyCapacityValue);
    }
    if (options.readbackRingSlots !== undefined) {
      const slots = positiveInteger(options.readbackRingSlots, "readbackRingSlots");
      if (slots < 3) throw new RangeError("readbackRingSlots must be at least 3");
      if (slots !== this.readbackRingSlotsValue) {
        this.readbackRingSlotsValue = slots;
        this.destroyGpuCounterResources();
      }
    }
    if (!this.enabledValue) this.destroyGpuCounterResources();
  }

  attachGpuDevice(device: GPUDevice): void {
    if (this.gpuDevice === device) return;
    this.detachGpuDevice();
    this.gpuDevice = device;
    const epoch = ++this.deviceEpoch;
    device.addEventListener("uncapturederror", this.onUncapturedError);
    void device.lost.then((info) => {
      if (this.gpuDevice !== device || this.deviceEpoch !== epoch) return;
      this.deviceLostCount++;
      appendBounded(this.deviceLostReasons, `${info.reason}: ${info.message}`);
    });
  }

  attachResourceAccounting(accounting: ResourceAccounting | undefined): void {
    if (this.resourceAccounting === accounting) return;
    this.destroyGpuCounterResources();
    this.resourceAccounting = accounting;
  }

  detachGpuDevice(device?: GPUDevice): void {
    if (device !== undefined && this.gpuDevice !== device) return;
    const current = this.gpuDevice;
    if (current !== null) {
      current.removeEventListener("uncapturederror", this.onUncapturedError);
    }
    this.gpuDevice = null;
    this.deviceEpoch++;
    this.destroyGpuCounterResources();
  }

  beginFrame(frameIndex: number): void {
    if (!this.enabledValue) return;
    if (this.active !== null) {
      throw new Error(`FrameProfiler frame ${this.active.snapshot.frameIndex} is still active`);
    }
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("frameIndex must be a non-negative integer");
    }
    const sampled =
      this.gpuTimestampAvailableValue &&
      frameIndex % this.gpuSampleIntervalValue === 0;
    this.active = {
      startedAt: this.now(),
      epoch: this.epochValue,
      warmup: this.warmupRemainingValue > 0,
      gpuCounterSampleEncoded: false,
      gpuCounterFields: new Set(),
      spans: [],
      nextSpanId: 1,
      metricSamples: {},
      snapshot: {
        frameIndex,
        cpuMs: {},
        submits: { count: 0, labels: {} },
        readbacks: { count: 0, bytes: 0, labels: {} },
        uploads: { writes: 0, bytes: 0, labels: {} },
        graph: {
          builds: 0,
          compiles: 0,
          executes: 0,
          cacheHits: 0,
          cacheMisses: 0,
          cacheEvictions: 0
        },
        counters: {},
        gpu: {
          available: this.gpuTimestampAvailableValue,
          sampled,
          pending: sampled,
          segments: []
        },
        gpuCounters: {
          available: this.gpuDevice !== null,
          sampled: false,
          pending: false,
          dropped: false,
          schemaVersion: GPU_COUNTER_SCHEMA_VERSION,
          values: {}
        }
      }
    };
    if (this.warmupRemainingValue > 0) this.warmupRemainingValue--;
    const counters = this.active.snapshot.gpuCounters;
    counters.sampled = this.gpuCounterSamplingEnabledValue && counters.available &&
      frameIndex % this.gpuCounterSampleIntervalValue === 0;
    counters.pending = counters.sampled;
  }

  beginCpuSection(label: string): () => void {
    const active = this.active;
    if (active === null) return () => {};
    const startedAt = this.now();
    const spanId = active.nextSpanId++;
    const span: ProfileSpan = {
      id: spanId,
      parentId: null,
      frameIndex: active.snapshot.frameIndex,
      name: label,
      category: "cpu",
      clockDomain: "cpu-main",
      start: startedAt,
      duration: null,
      availability: "pending",
      instrumented: false
    };
    active.spans.push(span);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const elapsed = Math.max(0, this.now() - startedAt);
      active.snapshot.cpuMs[label] =
        (active.snapshot.cpuMs[label] ?? 0) + elapsed;
      const index = active.spans.indexOf(span);
      active.spans[index] = Object.freeze({
        ...span,
        duration: elapsed,
        availability: "available"
      });
    };
  }

  measure<T>(label: string, callback: () => T): T {
    const finish = this.beginCpuSection(label);
    try {
      return callback();
    } finally {
      finish();
    }
  }

  shouldSampleGpu(): boolean {
    return this.active?.snapshot.gpu.sampled ?? false;
  }

  /**
   * 将采样帧内所有 OEngine CommandContext 登记为一个异步 timing batch。
   * batch 最终按注册顺序合并，readback 的完成顺序不会改变 artifact。
   */
  attachGpuTimingContext(
    command: ShadeGPUCommandContext,
    contextLabel: string
  ): void {
    const active = this.active;
    if (
      active === null ||
      !active.snapshot.gpu.sampled ||
      !command.device.features.has("timestamp-query")
    ) {
      return;
    }
    const frameIndex = active.snapshot.frameIndex;
    let state = this.gpuTimingBatchesByFrame.get(frameIndex);
    if (state === undefined) {
      state = { sealed: false, batches: [] };
      this.gpuTimingBatchesByFrame.set(frameIndex, state);
    }
    const batchIndex = state.batches.length;
    state.batches.push({ contextLabel, timings: null });
    command.enable_debug_timers(
      (timings) => {
        this.completeGpuTimingBatch(frameIndex, batchIndex, timings);
      },
      (error) => {
        this.failGpuTimingBatch(frameIndex, batchIndex, error);
      }
    );
  }

  shouldSampleGpuCounters(): boolean {
    return this.active?.snapshot.gpuCounters.sampled ?? false;
  }

  encodeGpuCounterClear(command: ShadeGPUCommandContext): void {
    if (!this.shouldSampleGpuCounters() || this.gpuDevice === null) return;
    this.ensureGpuFrameCounters().clear(command.gpu_encoder);
  }

  copyGpuCounter(
    command: ShadeGPUCommandContext,
    field: GpuCounterFieldName,
    source: GPUBuffer,
    sourceOffset = 0
  ): void {
    if (!this.shouldSampleGpuCounters() || this.gpuDevice === null) return;
    assertSupportedGpuCounter(field);
    this.ensureGpuFrameCounters().copyField(
      command.gpu_encoder,
      field,
      source,
      sourceOffset
    );
    this.registerGpuCounterFields([field]);
  }

  registerGpuCounterFields(fields: readonly GpuCounterFieldName[]): void {
    const active = this.active;
    if (active === null || !active.snapshot.gpuCounters.sampled) return;
    for (const field of fields) {
      assertSupportedGpuCounter(field);
      active.gpuCounterFields.add(field);
    }
  }

  encodeGpuCounterReadback(command: ShadeGPUCommandContext): void {
    const active = this.active;
    if (active === null || !active.snapshot.gpuCounters.sampled) return;
    const counters = this.ensureGpuFrameCounters();
    const ticket = counters.encodeReadback(
      command.gpu_encoder,
      active.snapshot.frameIndex
    );
    active.gpuCounterSampleEncoded = true;
    if (ticket === null) {
      active.snapshot.gpuCounters.pending = false;
      active.snapshot.gpuCounters.dropped = true;
      this.droppedGpuCounterSamples++;
      return;
    }
    command.recordReadback("gpu-counters", GPU_COUNTER_BYTE_SIZE);
    this.gpuCounterFieldsByFrame.set(
      active.snapshot.frameIndex,
      [...active.gpuCounterFields]
    );
    command.onFinished.addOne(() => counters.markSubmitted(ticket));
    command.onAborted?.addOne((_context: ShadeGPUCommandContext, cause: unknown) => {
      counters.cancel(ticket, cause);
    });
  }

  recordSubmit(label: string): void {
    const evidence = this.active?.snapshot.submits;
    if (evidence === undefined) return;
    evidence.count++;
    increment(evidence.labels, label);
  }

  recordReadback(label: string, bytes: number): void {
    const evidence = this.active?.snapshot.readbacks;
    if (evidence === undefined) return;
    evidence.count++;
    evidence.bytes += nonNegativeFinite(bytes, "readback bytes");
    increment(evidence.labels, label);
  }

  recordUpload(label: string, bytes: number): void {
    const evidence = this.active?.snapshot.uploads;
    if (evidence === undefined) return;
    const validated = nonNegativeFinite(bytes, "upload bytes");
    evidence.writes++;
    evidence.bytes += validated;
    evidence.labels[label] = (evidence.labels[label] ?? 0) + validated;
  }

  recordGraphBuild(): void {
    if (this.active !== null) this.active.snapshot.graph.builds++;
  }

  recordGraphCompile(): void {
    if (this.active !== null) this.active.snapshot.graph.compiles++;
  }

  recordGraphExecute(): void {
    if (this.active !== null) this.active.snapshot.graph.executes++;
  }

  recordGraphCacheHit(): void {
    if (this.active !== null) this.active.snapshot.graph.cacheHits++;
  }

  recordGraphCacheMiss(): void {
    if (this.active !== null) this.active.snapshot.graph.cacheMisses++;
  }

  recordGraphCacheEviction(): void {
    if (this.active !== null) this.active.snapshot.graph.cacheEvictions++;
  }

  recordCounter(label: string, value: number): void {
    this.metricRegistry.require(label);
    if (this.active === null) return;
    this.active.snapshot.counters[label] = nonNegativeFinite(value, label);
  }

  addCounter(label: string, value: number): void {
    this.metricRegistry.require(label);
    if (this.active === null) return;
    const validated = nonNegativeFinite(value, label);
    this.active.snapshot.counters[label] =
      (this.active.snapshot.counters[label] ?? 0) + validated;
  }

  /** Records commands actually encoded through ShadeGPUCommandContext. */
  recordGpuCommand(
    kind: "renderPass" | "computePass" | "draw" | "dispatch" | "bundleExecution",
    amount = 1
  ): void {
    this.addCounter(`gpu.commands.${kind}`, amount);
  }

  endFrame(): FrameProfileSnapshot | undefined {
    const active = this.active;
    if (active === null) return undefined;
    if (
      active.snapshot.gpuCounters.sampled &&
      !active.gpuCounterSampleEncoded
    ) {
      active.snapshot.gpuCounters.pending = false;
      active.snapshot.gpuCounters.dropped = true;
      this.droppedGpuCounterSamples++;
    }
    if (active.snapshot.gpu.sampled) {
      const timingState = this.gpuTimingBatchesByFrame.get(
        active.snapshot.frameIndex
      );
      if (timingState !== undefined) {
        timingState.sealed = true;
        this.finalizeGpuTimingBatches(active.snapshot.frameIndex, timingState);
      }
    }
    active.snapshot.cpuMs.frame = Math.max(0, this.now() - active.startedAt);
    this.active = null;
    this.frames.push(active.snapshot);
    this.trimHistory();
    this.metricSamplesByFrame.set(active.snapshot.frameIndex, Object.freeze({ ...active.metricSamples }));
    this.ensureProfileHistory().add(toProfileFrame(
      active.snapshot,
      active.spans,
      active.metricSamples,
      active.gpuCounterFields,
      active.epoch,
      active.warmup
    ));
    const completed = cloneSnapshot(active.snapshot);
    this.notify(completed);
    return completed;
  }

  recordGpuTimings(
    frameIndex: number,
    timings: readonly FrameGpuTimingInput[]
  ): void {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (frame === undefined || !frame.gpu.sampled) return;
    frame.gpu.segments = timings.map((timing, index) => ({
      label: timing.label ?? `unnamed-${index}`,
      type: timing.type,
      phase: classifyGpuFramePhase(timing.label ?? `unnamed-${index}`),
      durationMs: nonNegativeFinite(timing.duration_ms, "GPU duration")
    }));
    frame.gpu.pending = false;
    this.failedGpuTimingFrames.delete(frameIndex);
    const profileFrame = this.profileHistoryValue?.get(frameIndex);
    this.profileHistoryValue?.patch(frameIndex, {
      samples: profileSamples(frame, this.metricSamplesByFrame.get(frameIndex), this.gpuCounterFieldsByFrame.get(frameIndex), this.latestFrameIndex(), false),
      spans: Object.freeze([
        ...(profileFrame?.spans.filter((span) => span.clockDomain === "cpu-main") ?? []),
        ...profileGpuSpans(frame)
      ])
    });
    this.notify(cloneSnapshot(frame));
  }

  recordGpuCounters(frameIndex: number, values: GpuCounterValues): void {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (frame === undefined || !frame.gpuCounters.sampled) return;
    const fields = this.gpuCounterFieldsByFrame.get(frameIndex) ?? [];
    const supported: Partial<GpuCounterValues> = {};
    for (const field of fields) supported[field] = values[field];
    frame.gpuCounters.values = supported;
    frame.gpuCounters.pending = false;
    frame.gpuCounters.dropped = false;
    const fieldsForFrame = this.gpuCounterFieldsByFrame.get(frameIndex);
    this.profileHistoryValue?.patch(frameIndex, {
      samples: profileSamples(frame, this.metricSamplesByFrame.get(frameIndex), fieldsForFrame, this.latestFrameIndex())
    });
    this.notify(cloneSnapshot(frame));
  }

  get latest(): FrameProfileSnapshot | undefined {
    const frame = this.frames[this.frames.length - 1];
    return frame === undefined ? undefined : cloneSnapshot(frame);
  }

  get history(): FrameProfileSnapshot[] {
    return this.frames.map(cloneSnapshot);
  }

  getFrame(frameIndex: number): FrameProfileSnapshot | undefined {
    const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    return frame === undefined ? undefined : cloneSnapshot(frame);
  }

  clear(): void {
    if (this.active !== null) throw new Error("Cannot clear FrameProfiler during a frame");
    this.frames.length = 0;
    this.gpuCounterFieldsByFrame.clear();
    this.gpuTimingBatchesByFrame.clear();
    this.metricSamplesByFrame.clear();
    this.failedGpuTimingFrames.clear();
    this.profileHistoryValue?.clear();
  }

  destroy(): void {
    this.detachGpuDevice();
    this.listeners.clear();
    this.frames.length = 0;
    this.profileHistoryValue?.clear();
    this.gpuTimingBatchesByFrame.clear();
    this.metricSamplesByFrame.clear();
    this.failedGpuTimingFrames.clear();
  }

  private ensureGpuFrameCounters(): GpuFrameCounterBuffer {
    const device = this.gpuDevice;
    if (device === null) throw new Error("FrameProfiler has no attached GPUDevice");
    this.gpuFrameCounters ??= new GpuFrameCounterBuffer(device, {
      slotCount: this.readbackRingSlotsValue,
      resourceAccounting: this.resourceAccounting,
      onResult: (frameIndex, values) => this.recordGpuCounters(frameIndex, values),
      onError: (frameIndex, error) => {
        this.failedGpuCounterSamples++;
        const frame = this.frames.find((candidate) => candidate.frameIndex === frameIndex);
        if (frame !== undefined) {
          frame.gpuCounters.pending = false;
          frame.gpuCounters.dropped = true;
          this.profileHistoryValue?.patch(frameIndex, {
            samples: profileSamples(frame, this.metricSamplesByFrame.get(frameIndex), this.gpuCounterFieldsByFrame.get(frameIndex), this.latestFrameIndex())
          });
          this.notify(cloneSnapshot(frame));
        }
        console.error("GPU counter readback failed", error);
      }
    });
    return this.gpuFrameCounters;
  }

  private ensureProfileHistory(): ProfileHistory {
    return this.profileHistoryValue ??= new ProfileHistory(this.historyCapacityValue);
  }

  private ensureMetric(
    id: string,
    measurement: MetricDescriptor["measurement"],
    aggregation: MetricDescriptor["aggregation"]
  ): void {
    if (this.metricRegistry.has(id)) return;
    this.metricRegistry.register({
      id,
      label: id,
      group: id.split(".", 1)[0] ?? "runtime",
      unit: inferMetricUnit(id),
      source: inferMetricSource(id),
      measurement,
      cost: "none",
      scope: "frame",
      aggregation,
      description: `Runtime evidence for ${id}`
    });
  }

  private destroyGpuCounterResources(): void {
    this.gpuFrameCounters?.destroy();
    this.gpuFrameCounters = null;
    this.gpuCounterFieldsByFrame.clear();
  }

  private completeGpuTimingBatch(
    frameIndex: number,
    batchIndex: number,
    timings: readonly FrameGpuTimingInput[]
  ): void {
    const state = this.gpuTimingBatchesByFrame.get(frameIndex);
    const batch = state?.batches[batchIndex];
    if (state === undefined || batch === undefined || batch.timings !== null) {
      return;
    }
    batch.timings = timings.map((timing) => ({ ...timing }));
    this.finalizeGpuTimingBatches(frameIndex, state);
  }

  private failGpuTimingBatch(
    frameIndex: number,
    batchIndex: number,
    error: unknown
  ): void {
    const state = this.gpuTimingBatchesByFrame.get(frameIndex);
    const batch = state?.batches[batchIndex];
    if (state === undefined || batch === undefined || batch.timings !== null) {
      return;
    }
    this.failedGpuTimestampBatches++;
    batch.timings = [];
    this.finalizeGpuTimingBatches(frameIndex, state);
    console.error("GPU timestamp readback failed", error);
  }

  private finalizeGpuTimingBatches(
    frameIndex: number,
    state: GpuTimingBatchState
  ): void {
    if (!state.sealed || state.batches.some((batch) => batch.timings === null)) {
      return;
    }
    const snapshot =
      this.active?.snapshot.frameIndex === frameIndex
        ? this.active.snapshot
        : this.frames.find((candidate) => candidate.frameIndex === frameIndex);
    if (snapshot === undefined) {
      this.gpuTimingBatchesByFrame.delete(frameIndex);
      return;
    }
    snapshot.gpu.segments = state.batches.flatMap((batch) =>
      batch.timings!.map((timing, index) => {
        const label = qualifyGpuTimingLabel(
          batch.contextLabel,
          timing.label,
          index
        );
        return {
          label,
          type: timing.type,
          phase: classifyGpuFramePhase(label),
          durationMs: nonNegativeFinite(timing.duration_ms, "GPU duration")
        };
      })
    );
    snapshot.gpu.pending = false;
    if (state.batches.some((batch) => batch.timings!.length === 0)) this.failedGpuTimingFrames.add(frameIndex);
    this.gpuTimingBatchesByFrame.delete(frameIndex);
    if (this.active?.snapshot !== snapshot) {
      this.profileHistoryValue?.patch(frameIndex, {
        samples: profileSamples(snapshot, this.metricSamplesByFrame.get(frameIndex), this.gpuCounterFieldsByFrame.get(frameIndex), this.latestFrameIndex(), this.failedGpuTimingFrames.has(frameIndex)),
        spans: Object.freeze([
          ...(this.profileHistoryValue?.get(frameIndex)?.spans.filter((span) => span.clockDomain === "cpu-main") ?? []),
          ...profileGpuSpans(snapshot)
        ])
      });
      this.notify(cloneSnapshot(snapshot));
    }
  }

  private trimHistory(): void {
    const excess = this.frames.length - this.historyCapacityValue;
    if (excess <= 0) return;
    const removed = this.frames.splice(0, excess);
    for (const frame of removed) {
      this.gpuTimingBatchesByFrame.delete(frame.frameIndex);
      this.gpuCounterFieldsByFrame.delete(frame.frameIndex);
      this.metricSamplesByFrame.delete(frame.frameIndex);
      this.failedGpuTimingFrames.delete(frame.frameIndex);
    }
  }

  private notify(snapshot: FrameProfileSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneSnapshot(snapshot));
      } catch (error) {
        console.error("FrameProfiler listener failed", error);
      }
    }
  }

  private latestFrameIndex(): number {
    return this.frames.at(-1)?.frameIndex ?? 0;
  }
}

function assertSupportedGpuCounter(field: GpuCounterFieldName): void {
  const declaration = BENCHMARK_GPU_COUNTER_EVIDENCE[field];
  if (declaration.status === "unsupported") {
    throw new Error(
      `GPU counter '${field}' is unsupported; implement its real producer under ${declaration.blockerTaskId} before registration`
    );
  }
}

function increment(labels: Record<string, number>, label: string): void {
  labels[label] = (labels[label] ?? 0) + 1;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function qualifyGpuTimingLabel(
  contextLabel: string,
  passLabel: string | undefined,
  index: number
): string {
  const context = contextLabel.trim() || "unlabeled-command-context";
  const pass = passLabel?.trim() || `unnamed-${index}`;
  return `${context}/${pass}`;
}

function cloneSnapshot(snapshot: FrameProfileSnapshot): FrameProfileSnapshot {
  return {
    frameIndex: snapshot.frameIndex,
    cpuMs: { ...snapshot.cpuMs },
    submits: {
      count: snapshot.submits.count,
      labels: { ...snapshot.submits.labels }
    },
    readbacks: {
      count: snapshot.readbacks.count,
      bytes: snapshot.readbacks.bytes,
      labels: { ...snapshot.readbacks.labels }
    },
    uploads: {
      writes: snapshot.uploads.writes,
      bytes: snapshot.uploads.bytes,
      labels: { ...snapshot.uploads.labels }
    },
    graph: { ...snapshot.graph },
    counters: { ...snapshot.counters },
    gpu: {
      available: snapshot.gpu.available,
      sampled: snapshot.gpu.sampled,
      pending: snapshot.gpu.pending,
      segments: snapshot.gpu.segments.map((segment) => ({ ...segment }))
    },
    gpuCounters: {
      available: snapshot.gpuCounters.available,
      sampled: snapshot.gpuCounters.sampled,
      pending: snapshot.gpuCounters.pending,
      dropped: snapshot.gpuCounters.dropped,
      schemaVersion: snapshot.gpuCounters.schemaVersion,
      values: { ...snapshot.gpuCounters.values }
    }
  };
}

function appendBounded(values: string[], value: string, capacity = 64): void {
  if (values.length < capacity) values.push(value);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function toProfileFrame(
  snapshot: FrameProfileSnapshot,
  spans: readonly ProfileSpan[],
  customSamples: Readonly<Record<string, MetricSample>> = {},
  gpuCounterFields: ReadonlySet<GpuCounterFieldName> = new Set(),
  epoch = 0,
  warmup = false
): ProfileFrame {
  return Object.freeze({
    schemaVersion: 1,
    frameIndex: snapshot.frameIndex,
    epoch,
    warmup,
    visibilityState: "visible",
    samples: profileSamples(snapshot, customSamples, gpuCounterFields),
    spans: Object.freeze([...spans, ...profileGpuSpans(snapshot)]),
    gpuCounterSchemaVersion: snapshot.gpuCounters.schemaVersion,
    timestampInstrumented: snapshot.gpu.sampled,
    counterInstrumented: snapshot.gpuCounters.sampled,
    complete: !snapshot.gpu.pending && !snapshot.gpuCounters.pending
  });
}

function profileSamples(
  snapshot: FrameProfileSnapshot,
  customSamples: Readonly<Record<string, MetricSample>> = {},
  gpuCounterFields: readonly GpuCounterFieldName[] | ReadonlySet<GpuCounterFieldName> = [],
  resolvedAtFrameIndex = snapshot.frameIndex,
  gpuTimingFailed = false
): Readonly<Record<string, MetricSample>> {
  const samples: Record<string, MetricSample> = { ...customSamples };
  for (const [label, value] of Object.entries(snapshot.cpuMs)) {
    const id = label === "frame" ? "cpu.frameMs" : CPU_SECTION_METRIC_IDS[label];
    if (id === undefined) continue;
    if (samples[id] === undefined) {
      samples[id] = sample(id, value, snapshot.frameIndex, "cpu-clock", false, "available", resolvedAtFrameIndex);
    }
  }
  for (const [label, value] of Object.entries(snapshot.counters)) {
    if (samples[label] === undefined) {
      samples[label] = sample(label, value, snapshot.frameIndex, "engine-accounting", false, "available", resolvedAtFrameIndex);
    }
  }
  addDerivedSample(samples, "queue.submitCount", snapshot.submits.count, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "io.uploadBytes", snapshot.uploads.bytes, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "io.readbackBytes", snapshot.readbacks.bytes, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "framegraph.buildCount", snapshot.graph.builds, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "framegraph.compileCount", snapshot.graph.compiles, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "framegraph.executeCount", snapshot.graph.executes, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "framegraph.cache.hitCount", snapshot.graph.cacheHits, snapshot.frameIndex, resolvedAtFrameIndex);
  addDerivedSample(samples, "framegraph.cache.missCount", snapshot.graph.cacheMisses, snapshot.frameIndex, resolvedAtFrameIndex);
  const gpuPassSum = snapshot.gpu.segments.reduce((total, segment) => total + segment.durationMs, 0);
  const gpuAvailability: MetricSampleAvailability = !snapshot.gpu.available || !snapshot.gpu.sampled
    ? "unsupported"
    : snapshot.gpu.pending
      ? "pending"
      : gpuTimingFailed
        ? "invalid"
      : "available";
  samples["gpu.passSumMs"] = sample(
    "gpu.passSumMs",
    gpuAvailability === "available" ? gpuPassSum : null,
    snapshot.frameIndex,
    "gpu-timestamp",
    snapshot.gpu.sampled,
    gpuAvailability,
    resolvedAtFrameIndex
  );
  const fields = [...gpuCounterFields];
  for (const field of fields) {
    const value = snapshot.gpuCounters.values[field];
    const availability: MetricSampleAvailability = value !== undefined
      ? "available"
      : snapshot.gpuCounters.pending
        ? "pending"
        : snapshot.gpuCounters.dropped
          ? "dropped"
          : "invalid";
    samples[`gpu.counter.${field}`] = sample(
      `gpu.counter.${field}`,
      value ?? null,
      snapshot.frameIndex,
      "gpu-counter",
      snapshot.gpuCounters.sampled,
      availability,
      resolvedAtFrameIndex
    );
  }
  return Object.freeze(samples);
}

function addDerivedSample(
  samples: Record<string, MetricSample>,
  metricId: string,
  value: number,
  frameIndex: number,
  resolvedAtFrameIndex: number
): void {
  if (samples[metricId] === undefined) {
    samples[metricId] = sample(metricId, value, frameIndex, "engine-accounting", false, "available", resolvedAtFrameIndex);
  }
}

function profileGpuSpans(snapshot: FrameProfileSnapshot): readonly ProfileSpan[] {
  return Object.freeze(snapshot.gpu.segments.map((segment, index) => ({
    id: 100000 + index,
    parentId: null,
    frameIndex: snapshot.frameIndex,
    name: segment.label,
    category: segment.phase,
    clockDomain: "gpu-device" as const,
    start: null,
    duration: segment.durationMs,
    availability: snapshot.gpu.pending ? "pending" as const : "available" as const,
    instrumented: snapshot.gpu.sampled
  })));
}

function sample(
  metricId: string,
  value: number | null,
  frameIndex: number,
  source: MetricDescriptor["source"],
  instrumented: boolean,
  availability: MetricSampleAvailability = "available",
  resolvedAtFrameIndex = frameIndex
): MetricSample {
  return Object.freeze({
    metricId,
    value,
    availability,
    sourceFrameIndex: frameIndex,
    resolvedAtFrameIndex: availability === "available" ? resolvedAtFrameIndex : null,
    instrumented
  });
}

function inferMetricUnit(id: string): MetricDescriptor["unit"] {
  if (/ms$/i.test(id)) return "ms";
  if (/bytes$/i.test(id)) return "bytes";
  if (/pixels?/i.test(id)) return "pixels";
  if (/triangles?/i.test(id)) return "triangles";
  if (/ratio|rate|fraction/i.test(id)) return "ratio";
  return "count";
}

function inferMetricSource(id: string): MetricDescriptor["source"] {
  if (id.startsWith("gpu.counter.")) return "gpu-counter";
  if (id.startsWith("cpu.")) return "cpu-clock";
  return "engine-accounting";
}
