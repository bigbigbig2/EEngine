import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GeometryProductRevisionSourceV1 } from "../assets/geometry-product/GeometryProductV1.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS,
  unpackGpuMeshletWorkQueueHeader,
  type GpuMeshletWorkQueueHeaderCpu,
} from "./GpuMeshletRasterWorkAbi.js";
import {
  GpuGeometryDemandReadbackRingV1,
  type GpuGeometryDemandReadbackRingOptionsV1,
} from "./GeometryDemandReadbackRing.js";
import {
  GeometryPageSchedulerV1,
  type GeometryPageSchedulerEvidenceV1,
  type GeometryPageSchedulerOptionsV1,
  type GeometryPageSchedulerPressureV1,
  type GeometryPageSchedulerBudgetV1,
} from "./GeometryPageScheduler.js";
import {
  GEOMETRY_PAGE_LOCATION_PINNED,
  VirtualGeometryResidency,
  type VirtualGeometryResidencyEvidenceV1,
} from "./VirtualGeometryResidency.js";
import {
  GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING,
  GEOMETRY_PAGE_DEMAND_FLAG_SHADOW,
  GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE,
  GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE,
  type GeometryPageDemandBatchV1,
} from "./GeometryPageDemandAbiV1.js";

export interface GeometryPageStreamingRuntimeOptionsV1 {
  readonly scheduler?: GeometryPageSchedulerV1;
  readonly schedulerOptions?: GeometryPageSchedulerOptionsV1;
  readonly readback?: Omit<GpuGeometryDemandReadbackRingOptionsV1, "device">;
  /** Bounded mapping publications committed per frame. Staged pages that exceed
   * it stay staged and are offered again by the next frame. */
  readonly publicationBatchPages?: number;
  readonly publicationIntervalMs?: number;
  readonly maxPublicationWaitMs?: number;
}

export interface GeometryPageStreamingPollEvidenceV1 {
  readonly completedFrame: number;
  readonly cancelled?: boolean;
  readonly mappedSlots: number;
  readonly consumedReadbacks: number;
  readonly malformedReadbacks: number;
  readonly uploadedBytes: number;
  /** Payloads staged by this poll, not mapping publications. */
  readonly stagedPages: number;
}

export interface GeometryPageStreamingRuntimeEvidenceV1 {
  readonly readback: Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }>;
  readonly shadowReadback?: Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }>;
  readonly scheduler: GeometryPageSchedulerEvidenceV1;
  readonly residency: VirtualGeometryResidencyEvidenceV1;
  readonly lastPoll: GeometryPageStreamingPollEvidenceV1 | null;
  readonly lastError: string | null;
  readonly workStatus?: Readonly<{
    frameIndex: number;
    shadow: boolean;
    header: Readonly<GpuMeshletWorkQueueHeaderCpu>;
  }>;
  readonly products: readonly VirtualGeometryResidencyEvidenceV1[];
  /** Last revision observed by production consumers; sampling evidence must
   * not itself advance the source-publication identity. */
  readonly contentRevision: number;
  readonly publication: Readonly<{
    lastCommittedAtMs: number | null;
    costScale: number;
    costFrame: number;
    dirtyPages: number;
    selectedPages: number;
    casterPairs: number;
    shadowValid: boolean;
    shadowLimited: boolean;
    /** Delayed counters from the existing 72-byte publication receipt. */
    shadowStatus: Readonly<{
      allocationMisses: number;
      evictions: number;
      coarseMisses: number;
      pairExcess: number;
      rasterFailure: number;
      pairMode: number;
      pendingPages: number;
    }> | null;
  }>;
  readonly feedback: Readonly<{
    mainFrame: number;
    mainComplete: boolean;
    shadowFrame: number;
    shadowComplete: boolean;
    lastShadowAttemptedFrame: number;
    evictionSafeFrame: number;
  }>;
}

/**
 * Connects the GPU demand producer to delayed CPU scheduling and the existing
 * Product residency owner.  It has no visibility or draw-list responsibilities.
 */
export class GeometryPageStreamingRuntimeV1 {
  readonly #device: GPUDevice;
  readonly #readback: GpuGeometryDemandReadbackRingV1;
  #shadowReadback: GpuGeometryDemandReadbackRingV1 | null = null;
  #workReadback: GpuGeometryDemandReadbackRingV1 | null = null;
  #shadowWorkReadback: GpuGeometryDemandReadbackRingV1 | null = null;
  #workStatus: GeometryPageStreamingRuntimeEvidenceV1["workStatus"];
  readonly #scheduler: GeometryPageSchedulerV1;
  readonly #residency: VirtualGeometryResidency;
  readonly #residencies = new Map<number, VirtualGeometryResidency>();
  readonly #publicationSubscriptions = new Map<number, () => void>();
  #pollTail: Promise<unknown> = Promise.resolve();
  #lastError: string | null = null;
  #allocationBlockedPumps = 0;
  #allocationPressure: string | null = null;
  #lastPoll: GeometryPageStreamingPollEvidenceV1 | null = null;
  #mainFeedbackFrame = -1;
  #shadowFeedbackFrame = -1;
  #mainFeedbackComplete = false;
  #shadowFeedbackComplete = false;
  #lastShadowAttemptedFrame = -1;
  #destroyed = false;
  #publicationBatchPages: number;
  readonly #publicationIntervalMs: number;
  readonly #maxPublicationWaitMs: number;
  #lastPublicationAt = -Infinity;
  #costReadback: GpuGeometryDemandReadbackRingV1 | null = null;
  #costScale = 1;
  #costFrame = -1;
  #dirtyPages = 0;
  #selectedPages = 0;
  #casterPairs = 0;
  #shadowValid = false;
  #shadowLimited = false;
  #shadowStatus: GeometryPageStreamingRuntimeEvidenceV1["publication"]["shadowStatus"] = null;
  #observeConvergence = true;

  observeConvergence(enabled: boolean): void {
    this.#observeConvergence = enabled;
  }
  refinementState() {
    const scheduler = this.#scheduler.refinementState();
    return {
      ...scheduler,
      error: this.#lastError ?? scheduler.error ?? this.#allocationPressure,
      mainFrame: this.#mainFeedbackFrame,
      mainComplete: this.#mainFeedbackComplete,
      shadowFrame: this.#shadowFeedbackFrame,
      shadowComplete: this.#shadowFeedbackComplete,
      vsmFrame: this.#costFrame,
      vsmValid: this.#shadowValid,
      vsmLimited: this.#shadowLimited,
    };
  }
  #contentRevision = 0;
  readonly #observedContentRevisions = new Map<VirtualGeometryResidency, number>();
  readonly #observedPublicationStates = new Map<VirtualGeometryResidency, boolean>();
  /** Observe actual owners, including public upload/retire calls outside the scheduler.
   * No demand readback advances this identity; steady reads allocate nothing. */
  get contentRevision(): number {
    const includesPrimary = this.#residencies.has(this.#residency.productGeneration);
    const count = this.#residencies.size + (includesPrimary ? 0 : 1);
    let changed = this.#observedContentRevisions.size !== count;
    if (
      !includesPrimary &&
      (this.#observedContentRevisions.get(this.#residency) !== this.#residency.contentRevision ||
        this.#observedPublicationStates.get(this.#residency) !== this.#residency.publicationActive)
    ) {
      changed = true;
    }
    for (const residency of this.#residencies.values()) {
      if (
        this.#observedContentRevisions.get(residency) !== residency.contentRevision ||
        this.#observedPublicationStates.get(residency) !== residency.publicationActive
      ) {
        changed = true;
      }
    }
    if (changed) {
      if (this.#contentRevision >= 0xfffffffe) {
        throw new RangeError("Geometry content revision exhausted");
      }
      this.#contentRevision++;
      this.#observedContentRevisions.clear();
      this.#observedPublicationStates.clear();
      if (!includesPrimary) {
        this.#observedContentRevisions.set(this.#residency, this.#residency.contentRevision);
        this.#observedPublicationStates.set(this.#residency, this.#residency.publicationActive);
      }
      for (const residency of this.#residencies.values()) {
        this.#observedContentRevisions.set(residency, residency.contentRevision);
        this.#observedPublicationStates.set(residency, residency.publicationActive);
      }
    }
    return this.#contentRevision;
  }

  constructor(
    device: GPUDevice,
    residency: VirtualGeometryResidency,
    options: GeometryPageStreamingRuntimeOptionsV1 = {},
  ) {
    this.#device = device;
    this.#residency = residency;
    const publicationBatchPages = options.publicationBatchPages ?? 32;
    if (!Number.isInteger(publicationBatchPages) || publicationBatchPages < 1) {
      throw new RangeError("publicationBatchPages must be a positive integer");
    }
    this.#publicationBatchPages = publicationBatchPages;
    this.#publicationIntervalMs = options.publicationIntervalMs ?? 50;
    this.#maxPublicationWaitMs = options.maxPublicationWaitMs ?? 100;
    if (
      !Number.isFinite(this.#publicationIntervalMs) ||
      this.#publicationIntervalMs < 0 ||
      !Number.isFinite(this.#maxPublicationWaitMs) ||
      this.#maxPublicationWaitMs < this.#publicationIntervalMs
    ) {
      throw new RangeError("Geometry publication timing is invalid");
    }
    this.#scheduler =
      options.scheduler ??
      new GeometryPageSchedulerV1(
        options.schedulerOptions ?? {
          maxConcurrentReads: 4,
          maxInFlightBytes: 64 * 1024 * 1024,
        },
      );
    this.#readback = new GpuGeometryDemandReadbackRingV1({
      device,
      ...(options.readback ?? {}),
    });
    // Cancel IO and mapping ownership at loss, not later during replay. Source
    // ownership remains with Product residency/checkpoint for recovery retries.
    const runtime = new WeakRef(this);
    void device.lost.then(() => runtime.deref()?.destroy());
  }

  get scheduler(): GeometryPageSchedulerV1 {
    return this.#scheduler;
  }
  /** Source publications only, never a CPU visible/work list. Includes the standalone primary. */
  forEachResidency(visit: (residency: VirtualGeometryResidency) => void): void {
    this.assertAlive();
    if (!this.#residencies.has(this.#residency.productGeneration)) {
      visit(this.#residency);
    }
    for (const residency of this.#residencies.values()) {
      visit(residency);
    }
  }

  /** Applies delayed camera/IO/GPU/frame pressure without changing Product identity. */
  updatePressure(pressure: GeometryPageSchedulerPressureV1): GeometryPageSchedulerBudgetV1 {
    this.assertAlive();
    return this.#scheduler.setPressure(pressure);
  }

  /** Registers a Product source without transferring source ownership. */
  registerProduct(source: GeometryProductRevisionSourceV1, residency = this.#residency): void {
    this.assertAlive();
    if (
      source.descriptor.revision !== residency.descriptor.revision ||
      !sameBytes(source.descriptor.productId, residency.descriptor.productId)
    ) {
      throw new Error("Geometry page source does not match the active residency Product");
    }
    // Scheduling must use the descriptor captured by admission, including
    // page sizes and hashes, rather than a provider's later mutable tables.
    source = residency.sourceForStreaming();
    const generation = residency.productGeneration;
    if (this.#residencies.has(generation)) {
      throw new Error("Geometry residency generation is already registered for streaming");
    }
    const registerSource = () => {
      this.#scheduler.registerProduct(residency.productTableSlot, generation, source, {
        sourceOwnership: "external",
      });
    };
    // Validate IO budgets before publication, including dormant/candidate sources.
    registerSource();
    if (!residency.publicationActive) {
      this.#scheduler.unregisterProduct(generation);
    }
    this.#residencies.set(generation, residency);
    this.#publicationSubscriptions.set(
      generation,
      residency.publicationChanged.subscribe((state) => {
        if (state === "active") {
          registerSource();
          return;
        }
        // Cancel reads and drop verified bytes before a source/slot can retire.
        residency.releaseStagedPages(this.#scheduler.stagedPageIds(generation));
        this.#scheduler.unregisterProduct(generation);
        if (state === "destroyed") {
          this.#residencies.delete(generation);
          this.#publicationSubscriptions.get(generation)?.();
          this.#publicationSubscriptions.delete(generation);
        }
      }),
    );
  }

  /** Cold publication preparation, including teleport prefetch. This requests
   * Product metadata's complete guaranteed cut through the existing scheduler;
   * it never waits for IO, publishes mappings, or submits GPU work. Residency
   * acquisition remains atomic in retainQueryGeometry after the frame has
   * published every page. Until then the caller must keep coverage unknown. */
  requestQueryCoverage(residency: VirtualGeometryResidency, nowMs = performance.now()): number {
    this.assertAlive();
    if (this.#residencies.get(residency.productGeneration) !== residency || !residency.publicationActive) {
      throw new Error("Query prefetch requires a registered active Product generation");
    }
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new RangeError("Query prefetch time must be finite and nonnegative");
    }
    const demands = [];
    for (const pageId of residency.queryCoveragePages()) {
      if (residency.pageLocation(pageId) !== undefined) {
        continue;
      }
      demands.push({
        productTableSlot: residency.productTableSlot,
        productGeneration: residency.productGeneration,
        pageId,
        priority: 0xffff,
        currentViewMissing: false,
        shadow: false,
        predictive: true,
      });
    }
    this.#scheduler.ingestDemands(demands, nowMs);
    return demands.length;
  }

  selectEvictionCandidates(frameIndex: number, maxBytes: number, minimumAge = 2): readonly number[] {
    this.assertAlive();
    return this.#residency.selectEvictionCandidates(frameIndex, maxBytes, minimumAge);
  }

  /**
   * Requests eviction. The next ordinary frame owns both mapping revocation
   * and VSM damage, then its successful GPU fence authorizes slot reuse.
   */
  retirePages(pageIds: readonly number[], residency = this.#residency): void {
    this.assertAlive();
    const unique = [...new Set(pageIds)];
    for (const pageId of unique) {
      if (!Number.isSafeInteger(pageId) || pageId < 0) {
        throw new RangeError("Geometry page eviction pageId must be a non-negative integer");
      }
      if (pageId >= residency.descriptor.pageRecords.byteLength / 32) {
        throw new RangeError("Geometry page eviction pageId exceeds the active Product");
      }
      const location = residency.pageLocation(pageId);
      if (location === undefined) continue;
      if ((location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) {
        throw new Error(`Geometry page ${pageId} is pinned and cannot be evicted`);
      }
      residency.beginRetirePage(pageId);
    }
  }

  /** Encodes demand feedback into the current frame submission. */
  encodeDemandReadback(
    command: ShadeGPUCommandContext,
    demandBuffer: GPUBuffer,
    frameIndex: number,
  ): number | undefined {
    this.assertAlive();
    const slot = this.#readback.encode(command.gpu_encoder, demandBuffer, frameIndex);
    if (slot !== undefined) {
      command.onFinished.addOne(() => this.#readback.commit(slot));
      command.onAborted.addOne(() => this.#readback.cancel(slot));
    }
    return slot;
  }

  /** Bounded work needs mandatory failure feedback, independent of optional counters.
   * Copies only the finalized header in the existing submit; never controls current work. */
  encodeWorkStatusReadback(
    command: ShadeGPUCommandContext,
    work: GPUBuffer,
    frameIndex: number,
    shadow = false,
  ): void {
    this.assertAlive();
    if (shadow) {
      this.#shadowWorkReadback ??= new GpuGeometryDemandReadbackRingV1({
        device: this.#device,
        bytesPerSlot: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
      });
    } else {
      this.#workReadback ??= new GpuGeometryDemandReadbackRingV1({
        device: this.#device,
        bytesPerSlot: GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
      });
    }
    const ring = (shadow ? this.#shadowWorkReadback : this.#workReadback)!;
    const slot = ring.encode(command.gpu_encoder, work, frameIndex, GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE);
    if (slot !== undefined) {
      command.onFinished.addOne(() => ring.commit(slot));
      command.onAborted.addOne(() => ring.cancel(slot));
    }
  }

  /** Encodes one directional/Product shadow demand queue into a separate delayed ring. */
  encodeShadowDemandReadback(
    command: ShadeGPUCommandContext,
    demandBuffer: GPUBuffer,
    frameIndex: number,
  ): number | undefined {
    this.assertAlive();
    // A full ring drops a snapshot, not the fact that shadows still consume
    // resident pages. Keep incomplete shadow feedback protective under pressure.
    this.#lastShadowAttemptedFrame = Math.max(this.#lastShadowAttemptedFrame, frameIndex);
    this.#shadowReadback ??= new GpuGeometryDemandReadbackRingV1({
      device: this.#device,
    });
    const ring = this.#shadowReadback;
    const slot = ring.encode(command.gpu_encoder, demandBuffer, frameIndex);
    if (slot !== undefined) {
      command.onFinished.addOne(() => ring.commit(slot));
      command.onAborted.addOne(() => ring.cancel(slot));
    }
    return slot;
  }

  /**
   * Encodes this frame's bounded mapping publication. Staged pages become
   * resident only when the submission carrying their encoded copies succeeds, so
   * an aborted frame leaves them staged for the next attempt.
   */
  preparePublication(command: ShadeGPUCommandContext, nowMs = performance.now()): number {
    this.assertAlive();
    let directExpired = false;
    this.forEachResidency((residency) => {
      for (const page of residency.stagedPageIds) {
        const stagedAt = residency.stagedAtMs(page);
        if (stagedAt !== undefined && nowMs - stagedAt >= this.#maxPublicationWaitMs) {
          directExpired = true;
          break;
        }
      }
    });
    const opportunity =
      directExpired ||
      nowMs - this.#lastPublicationAt >= this.#publicationIntervalMs ||
      this.#scheduler.publicationUrgent(nowMs, this.#maxPublicationWaitMs);
    const batches = opportunity
      ? this.#scheduler.selectPublicationCandidates(this.#publicationBatchPages, {
          nowMs,
          maxWaitMs: this.#maxPublicationWaitMs,
          maxDamageUnits: Math.max(1, 64 * this.#costScale),
          maxTriangleWork: Math.max(1, 2_000_000 * this.#costScale),
          hint: (generation, pageId) => {
            const residency = this.#residencies.get(generation);
            if (!residency) throw new Error("Geometry publication source disappeared");
            return residency.publicationHint(pageId);
          },
        })
      : [];
    const selected = new Map(batches.map((batch) => [batch.productGeneration, batch.pageIds]));
    let directRemaining = opportunity ? this.#publicationBatchPages : 0;
    for (const batch of batches) {
      directRemaining -= batch.pageIds.length;
    }
    let publishedPages = 0;
    this.forEachResidency((residency) => {
      if (!residency.publicationActive) {
        return;
      }
      const generation = residency.productGeneration;
      const pages = [...(selected.get(generation) ?? [])];
      // Direct public staging uses the same frame path as scheduled IO.
      for (const page of residency.stagedPageIds) {
        if (directRemaining <= 0) {
          break;
        }
        if (this.#scheduler.state(generation, page) === "absent") {
          pages.push(page);
          directRemaining--;
        }
      }
      const encoded = residency.preparePublication(command, pages);
      publishedPages += encoded.length;
      const retiring = residency.candidateRetiringPageIds;
      const scheduled = pages.filter(
        (page) => encoded.includes(page) || residency.pageLocation(page) !== undefined,
      );
      if (scheduled.length === 0 && retiring.length === 0) {
        return;
      }
      command.onFinished.addOne(() => {
        this.#scheduler.commitPublication(generation, scheduled);
        for (const page of retiring) {
          this.#scheduler.markRetiring(generation, page);
        }
        if (retiring.length > 0) {
          void command.gpuDone.then(
            () => {
              if (this.#destroyed) {
                return;
              }
              for (const page of retiring) {
                this.#scheduler.markRetired(generation, page);
              }
            },
            (error: unknown) => {
              this.#lastError = String(error);
            },
          );
        }
      });
    });
    if (publishedPages > 0) {
      command.onFinished.addOne(() => {
        this.#lastPublicationAt = nowMs;
      });
    }
    return publishedPages;
  }

  /** Delayed workload calibration; never selects this frame's GPU work on CPU. */
  encodePublicationCostReadback(
    command: ShadeGPUCommandContext,
    allocation: GPUBuffer,
    casterPairs: GPUBuffer,
    frameIndex: number,
    failures?: GPUBuffer,
  ): void {
    if (frameIndex % 8 !== 0 || (!this.#scheduler.preparingPages && !this.#observeConvergence)) return;
    this.#costReadback ??= new GpuGeometryDemandReadbackRingV1({
      device: this.#device,
      bytesPerSlot: 72,
    });
    const ring = this.#costReadback;
    const slot = ring.encodeRegions(command.gpu_encoder, frameIndex, [
      { source: allocation, sourceOffset: 0, byteLength: 8 },
      { source: casterPairs, sourceOffset: 0, byteLength: 32 },
      ...(failures ? [{ source: failures, sourceOffset: 0, byteLength: 32 }] : []),
    ]);
    if (slot !== undefined) {
      command.onFinished.addOne(() => ring.commit(slot));
      command.onAborted.addOne(() => ring.cancel(slot));
    }
  }

  async consumeCompleted(completedFrame: number, nowMs = 0): Promise<GeometryPageStreamingPollEvidenceV1> {
    this.assertAlive();
    // A frame completion is also the scheduler clock. This advances delayed
    // retries even when the GPU produced no new demand this frame.
    this.#scheduler.tick(nowMs);
    if (this.#costReadback) {
      const results = await this.#costReadback.poll(completedFrame);
      if (this.#destroyed) return this.cancelledPoll(completedFrame);
      for (const result of results) {
        try {
          const words = new Uint32Array(result.bytes);
          this.#costFrame = result.frameIndex;
          this.#dirtyPages = words[0]!;
          this.#selectedPages = words[1]!;
          this.#casterPairs = words[2]!;
          this.#shadowStatus = Object.freeze({
            allocationMisses: words[10]!,
            evictions: words[11]!,
            coarseMisses: words[13]!,
            pairExcess: words[14]!,
            rasterFailure: words[15]!,
            pairMode: words[16]!,
            pendingPages: words[17]!,
          });
          // Fine/coarse allocation failures, eviction churn, or raster failure
          // cannot be called fully valid. Explicit pair mode is not a failure.
          this.#shadowLimited = words[10] !== 0 || words[11] !== 0 || words[13] !== 0;
          this.#shadowValid = words[0] === 0 && words[1] === 0 && !this.#shadowLimited && words[15] === 0;
          const selected = Math.max(1, this.#selectedPages);
          const load = Math.max(1, this.#dirtyPages / selected, this.#casterPairs / (selected * 4096));
          const target = Math.max(0.125, 1 / Math.sqrt(load));
          // Fast decrease, slow recovery. Missing samples retain the CPU model.
          this.#costScale += (target - this.#costScale) * (target < this.#costScale ? 0.5 : 0.1);
        } finally {
          this.#costReadback.release(result.slotIndex);
        }
      }
    }
    if (this.#workReadback) {
      await this.consumeWorkStatus(this.#workReadback, completedFrame, false);
    }
    if (this.#shadowWorkReadback && !this.#destroyed) {
      await this.consumeWorkStatus(this.#shadowWorkReadback, completedFrame, true);
    }
    if (this.#destroyed) {
      return this.cancelledPoll(completedFrame);
    }
    const results = await this.#readback.poll(completedFrame);
    if (this.#destroyed) {
      return this.cancelledPoll(completedFrame);
    }
    const shadowResults =
      this.#shadowReadback === null ? [] : await this.#shadowReadback.poll(completedFrame);
    if (this.#destroyed) {
      return this.cancelledPoll(completedFrame);
    }
    let consumedReadbacks = 0;
    let malformedReadbacks = 0;
    for (const result of results) {
      this.#mainFeedbackFrame = result.frameIndex;
      this.#mainFeedbackComplete = false;
      try {
        const batch = this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        this.#mainFeedbackComplete = this.recordResidencyFeedback(batch, result.frameIndex);
        consumedReadbacks++;
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        malformedReadbacks++;
      } finally {
        this.#readback.release(result.slotIndex);
      }
    }
    for (const result of shadowResults) {
      this.#shadowFeedbackFrame = result.frameIndex;
      this.#shadowFeedbackComplete = false;
      try {
        const batch = this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        this.#shadowFeedbackComplete = this.recordResidencyFeedback(batch, result.frameIndex);
        consumedReadbacks++;
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        malformedReadbacks++;
      } finally {
        this.#shadowReadback!.release(result.slotIndex);
      }
    }
    this.#scheduler.tick(nowMs);
    const pageResidency = (identity: { productTableSlot: number; productGeneration: number }) => {
      const residency = this.#residencies.get(identity.productGeneration);
      if (
        residency === undefined ||
        !residency.publicationActive ||
        residency.productTableSlot !== identity.productTableSlot
      ) {
        throw new Error("Geometry completion targets an unregistered slot/generation");
      }
      return residency;
    };
    let stagedPages = 0;
    let blockedAllocationBytes = 0;
    let blockedAllocationPages = 0;
    const sink = {
      uploadCost: (
        page: import("../assets/geometry-product/GeometryProductV1.js").GeometryPageProductV1,
        identity: import("./GeometryPageDemandAbiV1.js").GeometryPageDemandV1,
      ) => pageResidency(identity).uploadCost(page),
      stagePage: (
        page: import("../assets/geometry-product/GeometryProductV1.js").GeometryPageProductV1,
        identity: import("./GeometryPageDemandAbiV1.js").GeometryPageDemandV1,
      ) => {
        const residency = pageResidency(identity);
        const staged = residency.tryStagePage(page) !== false;
        if (staged) {
          stagedPages++;
        } else if (!residency.allocationFrozen) {
          blockedAllocationBytes += Math.ceil(residency.uploadCost(page) / 16) * 16;
          blockedAllocationPages++;
        }
        return staged;
      },
    };
    let uploadedBytes = this.#scheduler.drainStageBudget(sink);
    const feedbackFrame = this.evictionFeedbackFrame();
    if (blockedAllocationPages > 0 && feedbackFrame >= 0) {
      // This is a frame-between pump, never a current-frame control round trip.
      // The next ordinary frame revokes mappings before its consumers run.
      // Its completion fence also covers every earlier submitted consumer.
      const candidates: Array<{ residency: VirtualGeometryResidency; pages: readonly number[] }> = [];
      let evictionBytesRemaining = blockedAllocationBytes;
      let evictionPagesRemaining = blockedAllocationPages;
      for (const residency of this.#residencies.values()) {
        if (!residency.publicationActive || evictionBytesRemaining <= 0 || evictionPagesRemaining <= 0) {
          continue;
        }
        const pages = residency.selectEvictionCandidates(
          feedbackFrame,
          evictionBytesRemaining,
          2,
          evictionPagesRemaining,
        );
        if (pages.length > 0) {
          candidates.push({ residency, pages });
          for (const pageId of pages) {
            evictionBytesRemaining -= residency.residentPagePhysicalBytes(pageId);
            evictionPagesRemaining--;
          }
        }
      }
      for (const { residency, pages } of candidates) {
        this.retirePages(pages, residency);
      }
    }
    if (stagedPages > 0) {
      this.#allocationBlockedPumps = 0;
      this.#allocationPressure = null;
    } else if (blockedAllocationPages > 0) {
      this.#allocationBlockedPumps++;
      if (this.#allocationBlockedPumps >= 120) {
        this.#allocationPressure =
          "Geometry current-view allocation remains unserviceable after 120 delayed pumps; inspect byte/node/lease/growth budget and thrash diagnostics";
      }
    } else if (this.#scheduler.refinementState().pending === 0) {
      this.#allocationBlockedPumps = 0;
      this.#allocationPressure = null;
    }
    this.#lastPoll = Object.freeze({
      completedFrame,
      mappedSlots: results.length,
      consumedReadbacks,
      malformedReadbacks,
      uploadedBytes,
      stagedPages,
    });
    return this.#lastPoll;
  }

  private evictionFeedbackFrame(): number {
    if (!this.#mainFeedbackComplete) {
      return -1;
    }
    // Compare age against observed feedback, never the newer completion clock.
    // An active shadow producer must have a complete snapshot too. Once shadow
    // work stops, historical shadow usage remains in each page's lastUsed.
    if (this.#lastShadowAttemptedFrame >= this.#mainFeedbackFrame) {
      return this.#shadowFeedbackComplete ? Math.min(this.#mainFeedbackFrame, this.#shadowFeedbackFrame) : -1;
    }
    return this.#mainFeedbackFrame;
  }

  private async consumeWorkStatus(
    ring: GpuGeometryDemandReadbackRingV1,
    completedFrame: number,
    shadow: boolean,
  ): Promise<void> {
    const statuses = await ring.poll(completedFrame);
    if (this.#destroyed) {
      return;
    }
    let failure: Error | undefined;
    for (const status of statuses) {
      try {
        const view = new DataView(status.bytes);
        const failed =
          view.getUint32(GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.overflowCount, true) !== 0 ||
          view.getUint32(GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS.invalidCount, true) !== 0;
        // Finalize zeros written_count on a rejected whole cut. Reservation
        // counters then describe failure, not the live-queue count relation.
        const header = failed
          ? (Object.freeze(
              Object.fromEntries(
                Object.entries(GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS).map(([name, offset]) => [
                  name,
                  view.getUint32(offset, true),
                ]),
              ),
            ) as Readonly<GpuMeshletWorkQueueHeaderCpu>)
          : unpackGpuMeshletWorkQueueHeader(new Uint8Array(status.bytes));
        this.#workStatus = Object.freeze({ frameIndex: status.frameIndex, shadow, header });
        if (failed) {
          failure ??= new Error(
            `${shadow ? "Shadow" : "Main"} MeshletWork frame ${status.frameIndex} rejected: attempted=${header.attemptedCount}, capacity=${header.capacity}, overflow=${header.overflowCount}, invalid=${header.invalidCount}`,
          );
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      } finally {
        ring.release(status.slotIndex);
      }
    }
    if (failure) {
      this.#lastError = failure.message;
      throw failure;
    }
  }

  private recordResidencyFeedback(batch: GeometryPageDemandBatchV1, frameIndex: number): boolean {
    const header = batch.header!;
    const words = batch.words;
    for (let index = 0; index < batch.count; index++) {
      const at = index * 4;
      const pageId = words[at + 2]!;
      const flags = words[at + 3]!;
      const residency = this.#residencies.get(words[at + 1]!);
      if (
        residency === undefined ||
        !residency.publicationActive ||
        words[at] !== residency.productTableSlot ||
        pageId >= residency.descriptor.pageRecords.byteLength / 32
      )
        continue;
      if ((flags & GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE) !== 0) {
        residency.touchPage(pageId, frameIndex);
        continue;
      }
      residency.recordDemand(
        pageId,
        frameIndex,
        (flags & (GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING | GEOMETRY_PAGE_DEMAND_FLAG_SHADOW)) !== 0,
        (flags & GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE) !== 0,
      );
    }
    return header.overflow === 0 && header.attempted <= header.capacity;
  }

  /** Couples a submission completion token to the delayed frame poll. */
  async consumeAfterCompletion(
    frameIndex: number,
    completion: PromiseLike<void>,
    nowMs = 0,
  ): Promise<GeometryPageStreamingPollEvidenceV1> {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("Geometry page streaming frame index must be non-negative");
    }
    try {
      await completion;
    } catch (error) {
      if (this.#destroyed) {
        return this.cancelledPoll(frameIndex + 1);
      }
      throw error;
    }
    if (this.#destroyed) return this.cancelledPoll(frameIndex + 1);
    const poll = this.#pollTail
      .then(() =>
        this.#destroyed ? this.cancelledPoll(frameIndex + 1) : this.consumeCompleted(frameIndex + 1, nowMs),
      )
      .catch((error) => {
        if (this.#destroyed) {
          return this.cancelledPoll(frameIndex + 1);
        }
        throw error;
      });
    this.#pollTail = poll.catch((error) => {
      this.#lastError = error instanceof Error ? error.message : String(error);
    });
    return poll;
  }

  private cancelledPoll(completedFrame: number): GeometryPageStreamingPollEvidenceV1 {
    return Object.freeze({
      completedFrame,
      cancelled: true,
      mappedSlots: 0,
      consumedReadbacks: 0,
      malformedReadbacks: 0,
      uploadedBytes: 0,
      stagedPages: 0,
    });
  }

  /** O(1) production pressure input; full evidence is a diagnostic operation. */
  get lastPoll(): GeometryPageStreamingPollEvidenceV1 | null {
    return this.#lastPoll;
  }

  evidence(): GeometryPageStreamingRuntimeEvidenceV1 {
    return Object.freeze({
      readback: this.#readback.evidence(),
      ...(this.#shadowReadback === null ? {} : { shadowReadback: this.#shadowReadback.evidence() }),
      scheduler: this.#scheduler.evidence(),
      residency: this.#residency.evidence(),
      lastPoll: this.#lastPoll,
      lastError: this.#lastError,
      ...(this.#workStatus === undefined ? {} : { workStatus: this.#workStatus }),
      products: Object.freeze([...this.#residencies.values()].map((residency) => residency.evidence())),
      contentRevision: this.#contentRevision,
      publication: Object.freeze({
        lastCommittedAtMs: Number.isFinite(this.#lastPublicationAt) ? this.#lastPublicationAt : null,
        costScale: this.#costScale,
        costFrame: this.#costFrame,
        dirtyPages: this.#dirtyPages,
        selectedPages: this.#selectedPages,
        casterPairs: this.#casterPairs,
        shadowValid: this.#shadowValid,
        shadowLimited: this.#shadowLimited,
        shadowStatus: this.#shadowStatus,
      }),
      feedback: Object.freeze({
        mainFrame: this.#mainFeedbackFrame,
        mainComplete: this.#mainFeedbackComplete,
        shadowFrame: this.#shadowFeedbackFrame,
        shadowComplete: this.#shadowFeedbackComplete,
        lastShadowAttemptedFrame: this.#lastShadowAttemptedFrame,
        evictionSafeFrame: this.evictionFeedbackFrame(),
      }),
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // The scheduler registration is owned by this runtime.  Remove the
    // generation before dropping the readback rings so pending reads cannot
    // publish pages against a lost/released residency, including callers that
    // supplied an external scheduler.
    for (const [generation, residency] of this.#residencies) {
      residency.releaseStagedPages(this.#scheduler.stagedPageIds(generation));
      this.#scheduler.unregisterProduct(generation);
    }
    for (const unsubscribe of this.#publicationSubscriptions.values()) {
      unsubscribe();
    }
    this.#publicationSubscriptions.clear();
    this.#residencies.clear();
    this.#observedContentRevisions.clear();
    this.#observedPublicationStates.clear();
    this.#readback.destroy();
    this.#shadowReadback?.destroy();
    this.#workReadback?.destroy();
    this.#shadowWorkReadback?.destroy();
    this.#costReadback?.destroy();
  }

  private assertAlive(): void {
    if (this.#destroyed) throw new Error("Geometry page streaming runtime is destroyed");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
