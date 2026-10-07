import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GeometryProductRevisionSourceV1 } from "../assets/geometry-product/GeometryProductV1.js";
import {
  GpuGeometryDemandReadbackRingV1,
  type GpuGeometryDemandReadbackRingOptionsV1
} from "./GeometryDemandReadbackRing.js";
import {
  GeometryPageSchedulerV1,
  type GeometryPageSchedulerEvidenceV1,
  type GeometryPageSchedulerOptionsV1,
  type GeometryPageSchedulerPressureV1,
  type GeometryPageSchedulerBudgetV1
} from "./GeometryPageScheduler.js";
import {
  GEOMETRY_PAGE_LOCATION_PINNED,
  VirtualGeometryResidency,
  type VirtualGeometryResidencyEvidenceV1
} from "./VirtualGeometryResidency.js";
import { unpackGeometryPageDemandHeaderV1, unpackGeometryPageDemandV1 } from "./GeometryPageDemandAbiV1.js";

export interface GeometryPageStreamingRuntimeOptionsV1 {
  readonly scheduler?: GeometryPageSchedulerV1;
  readonly schedulerOptions?: GeometryPageSchedulerOptionsV1;
  readonly readback?: Omit<GpuGeometryDemandReadbackRingOptionsV1, "device">;
}

export interface GeometryPageStreamingPollEvidenceV1 {
  readonly completedFrame: number;
  readonly cancelled?: boolean;
  readonly mappedSlots: number;
  readonly consumedReadbacks: number;
  readonly malformedReadbacks: number;
  readonly uploadedBytes: number;
}

export interface GeometryPageStreamingRuntimeEvidenceV1 {
  readonly readback: Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }>;
  readonly shadowReadback?: Readonly<{ submitted: number; overflow: number; inUse: number; ready: number }>;
  readonly scheduler: GeometryPageSchedulerEvidenceV1;
  readonly residency: VirtualGeometryResidencyEvidenceV1;
  readonly lastPoll: GeometryPageStreamingPollEvidenceV1 | null;
  readonly lastError: string | null;
  readonly products: readonly VirtualGeometryResidencyEvidenceV1[];
}

/**
 * Connects the GPU demand producer to delayed CPU scheduling and the existing
 * Product residency owner.  It has no visibility or draw-list responsibilities.
 */
export class GeometryPageStreamingRuntimeV1 {
  readonly #device: GPUDevice;
  readonly #readback: GpuGeometryDemandReadbackRingV1;
  #shadowReadback: GpuGeometryDemandReadbackRingV1 | null = null;
  readonly #scheduler: GeometryPageSchedulerV1;
  readonly #residency: VirtualGeometryResidency;
  readonly #residencies = new Map<number, VirtualGeometryResidency>();
  readonly #publicationSubscriptions = new Map<number, () => void>();
  #pollTail: Promise<unknown> = Promise.resolve();
  #lastError: string | null = null;
  #lastPoll: GeometryPageStreamingPollEvidenceV1 | null = null;
  #destroyed = false;

  constructor(
    device: GPUDevice,
    residency: VirtualGeometryResidency,
    options: GeometryPageStreamingRuntimeOptionsV1 = {}
  ) {
    this.#device = device;
    this.#residency = residency;
    this.#scheduler =
      options.scheduler ??
      new GeometryPageSchedulerV1(
        options.schedulerOptions ?? {
          maxConcurrentReads: 2,
          maxInFlightBytes: 4 * 1024 * 1024
        }
      );
    this.#readback = new GpuGeometryDemandReadbackRingV1({
      device,
      ...(options.readback ?? {})
    });
  }

  get scheduler(): GeometryPageSchedulerV1 {
    return this.#scheduler;
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
    const generation = residency.productGeneration;
    if (this.#residencies.has(generation)) {
      throw new Error("Geometry residency generation is already registered for streaming");
    }
    const registerSource = () => {
      this.#scheduler.registerProduct(residency.productTableSlot, generation, source, {
        sourceOwnership: "external"
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
        this.#scheduler.unregisterProduct(generation);
        if (state === "destroyed") {
          this.#residencies.delete(generation);
          this.#publicationSubscriptions.get(generation)?.();
          this.#publicationSubscriptions.delete(generation);
        }
      })
    );
  }

  selectEvictionCandidates(frameIndex: number, maxBytes: number, minimumAge = 2): readonly number[] {
    this.assertAlive();
    return this.#residency.selectEvictionCandidates(frameIndex, maxBytes, minimumAge);
  }

  /**
   * Revokes mappings immediately, then releases their physical slots only
   * after the caller-provided submission boundary completes. Device loss uses
   * explicit teardown; a rejected completion never authorizes live slot reuse.
   */
  async retirePages(
    pageIds: readonly number[],
    completion: PromiseLike<void>,
    residency = this.#residency
  ): Promise<void> {
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
      this.#scheduler.markRetiring(residency.productGeneration, pageId);
    }
    await completion;
    for (const pageId of unique) {
      residency.completeRetirePage(pageId);
      this.#scheduler.markRetired(residency.productGeneration, pageId);
    }
  }

  /** Encodes demand feedback into the current frame submission. */
  encodeDemandReadback(
    command: ShadeGPUCommandContext,
    demandBuffer: GPUBuffer,
    frameIndex: number
  ): number | undefined {
    this.assertAlive();
    const slot = this.#readback.encode(command.gpu_encoder, demandBuffer, frameIndex);
    if (slot !== undefined) {
      command.onFinished.addOne(() => this.#readback.commit(slot));
      command.onAborted.addOne(() => this.#readback.cancel(slot));
    }
    return slot;
  }

  /** Encodes one directional/Product shadow demand queue into a separate delayed ring. */
  encodeShadowDemandReadback(
    command: ShadeGPUCommandContext,
    demandBuffer: GPUBuffer,
    frameIndex: number
  ): number | undefined {
    this.assertAlive();
    this.#shadowReadback ??= new GpuGeometryDemandReadbackRingV1({
      device: this.#device
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
   * Consumes only slots older than the supplied completed frame.  The caller
   * must establish GPU completion (for example via a submission token) before
   * invoking this method; it never waits for the current frame.
   */
  async consumeCompleted(completedFrame: number, nowMs = 0): Promise<GeometryPageStreamingPollEvidenceV1> {
    this.assertAlive();
    // A frame completion is also the scheduler clock. This advances delayed
    // retries even when the GPU produced no new demand this frame.
    this.#scheduler.tick(nowMs);
    const results = await this.#readback.poll(completedFrame);
    const shadowResults =
      this.#shadowReadback === null ? [] : await this.#shadowReadback.poll(completedFrame);
    let consumedReadbacks = 0;
    let malformedReadbacks = 0;
    for (const result of results) {
      try {
        this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        this.recordResidencyFeedback(result.bytes, result.frameIndex);
        consumedReadbacks++;
      } catch (error) {
        this.#lastError = error instanceof Error ? error.message : String(error);
        malformedReadbacks++;
      } finally {
        this.#readback.release(result.slotIndex);
      }
    }
    for (const result of shadowResults) {
      try {
        this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        this.recordResidencyFeedback(result.bytes, result.frameIndex);
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
    const sink = {
      uploadCost: (
        page: import("../assets/geometry-product/GeometryProductV1.js").GeometryPageProductV1,
        identity: import("./GeometryPageDemandAbiV1.js").GeometryPageDemandV1
      ) => pageResidency(identity).uploadCost(page),
      uploadPage: (
        page: import("../assets/geometry-product/GeometryProductV1.js").GeometryPageProductV1,
        identity: import("./GeometryPageDemandAbiV1.js").GeometryPageDemandV1
      ) => pageResidency(identity).tryUploadPage(page)
    };
    let uploadedBytes = this.#scheduler.drainUploadBudget(sink);
    if (this.#scheduler.evidence().blockedUploads > 0) {
      // This is a frame-between pump, never a current-frame control round trip.
      // Revocation is enqueued before the real queue fence captures ALL submitted
      // consumers, including newer frames than this delayed feedback.
      const candidates: Array<{ residency: VirtualGeometryResidency; pages: readonly number[] }> = [];
      for (const residency of this.#residencies.values()) {
        if (!residency.publicationActive) {
          continue;
        }
        const pages = residency.selectEvictionCandidates(
          completedFrame,
          this.#scheduler.budget().maxUploadBytesPerFrame,
          2
        );
        if (pages.length > 0) candidates.push({ residency, pages });
      }
      if (candidates.length > 0) {
        const retired = candidates.map(({ residency, pages }) => {
          for (const page of pages) {
            residency.beginRetirePage(page);
            this.#scheduler.markRetiring(residency.productGeneration, page);
          }
          return { residency, pages };
        });
        await this.#device.queue.onSubmittedWorkDone();
        if (this.#destroyed)
          return (
            this.#lastPoll ??
            Object.freeze({
              completedFrame,
              mappedSlots: results.length,
              consumedReadbacks,
              malformedReadbacks,
              uploadedBytes
            })
          );
        for (const { residency, pages } of retired) {
          if (this.#residencies.get(residency.productGeneration) !== residency) {
            continue; // Whole-Product destruction already reclaimed these pages.
          }
          for (const page of pages) {
            residency.completeRetirePage(page);
            this.#scheduler.markRetired(residency.productGeneration, page);
          }
        }
        uploadedBytes += this.#scheduler.drainUploadBudget(
          sink,
          Math.max(0, this.#scheduler.budget().maxUploadBytesPerFrame - uploadedBytes)
        );
      }
    }
    this.#lastPoll = Object.freeze({
      completedFrame,
      mappedSlots: results.length,
      consumedReadbacks,
      malformedReadbacks,
      uploadedBytes
    });
    return this.#lastPoll;
  }

  private recordResidencyFeedback(bytes: ArrayBuffer, frameIndex: number): void {
    const view = new Uint8Array(bytes);
    const header = unpackGeometryPageDemandHeaderV1(view);
    for (let index = 0; index < Math.min(header.attempted, header.capacity); index++) {
      const demand = unpackGeometryPageDemandV1(view, 16 + index * 16);
      const residency = this.#residencies.get(demand.productGeneration);
      if (
        residency === undefined ||
        !residency.publicationActive ||
        demand.productTableSlot !== residency.productTableSlot ||
        demand.pageId >= residency.descriptor.pageRecords.byteLength / 32
      )
        continue;
      residency.recordDemand(
        demand.pageId,
        frameIndex,
        demand.currentViewMissing || demand.shadow,
        demand.predictive
      );
    }
  }

  /** Couples a submission completion token to the delayed frame poll. */
  async consumeAfterCompletion(
    frameIndex: number,
    completion: PromiseLike<void>,
    nowMs = 0
  ): Promise<GeometryPageStreamingPollEvidenceV1> {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError("Geometry page streaming frame index must be non-negative");
    }
    await completion;
    const cancelled = (): GeometryPageStreamingPollEvidenceV1 =>
      Object.freeze({
        completedFrame: frameIndex + 1,
        cancelled: true,
        mappedSlots: 0,
        consumedReadbacks: 0,
        malformedReadbacks: 0,
        uploadedBytes: 0
      });
    if (this.#destroyed) return cancelled();
    const poll = this.#pollTail.then(() =>
      this.#destroyed ? cancelled() : this.consumeCompleted(frameIndex + 1, nowMs)
    );
    this.#pollTail = poll.catch((error) => {
      this.#lastError = error instanceof Error ? error.message : String(error);
    });
    return poll;
  }

  evidence(): GeometryPageStreamingRuntimeEvidenceV1 {
    return Object.freeze({
      readback: this.#readback.evidence(),
      ...(this.#shadowReadback === null ? {} : { shadowReadback: this.#shadowReadback.evidence() }),
      scheduler: this.#scheduler.evidence(),
      residency: this.#residency.evidence(),
      lastPoll: this.#lastPoll,
      lastError: this.#lastError,
      products: Object.freeze([...this.#residencies.values()].map((residency) => residency.evidence()))
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // The scheduler registration is owned by this runtime.  Remove the
    // generation before dropping the readback rings so pending reads cannot
    // publish pages against a lost/released residency, including callers that
    // supplied an external scheduler.
    for (const generation of this.#residencies.keys()) this.#scheduler.unregisterProduct(generation);
    for (const unsubscribe of this.#publicationSubscriptions.values()) {
      unsubscribe();
    }
    this.#publicationSubscriptions.clear();
    this.#residencies.clear();
    this.#readback.destroy();
    this.#shadowReadback?.destroy();
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
