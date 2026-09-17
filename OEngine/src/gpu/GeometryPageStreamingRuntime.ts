import type { GeometryProductRevisionSourceV1 } from "../assets/geometry-product/GeometryProductV1.js";
import {
  GpuGeometryDemandReadbackRingV1,
  type GpuGeometryDemandReadbackRingOptionsV1
} from "./GeometryDemandReadbackRing.js";
import { GeometryPageSchedulerV1, type GeometryPageSchedulerEvidenceV1, type GeometryPageSchedulerOptionsV1 } from "./GeometryPageScheduler.js";
import { GEOMETRY_PAGE_LOCATION_PINNED, VirtualGeometryResidency, type VirtualGeometryResidencyEvidenceV1 } from "./VirtualGeometryResidency.js";

export interface GeometryPageStreamingRuntimeOptionsV1 {
  readonly scheduler?: GeometryPageSchedulerV1;
  readonly schedulerOptions?: GeometryPageSchedulerOptionsV1;
  readonly readback?: Omit<GpuGeometryDemandReadbackRingOptionsV1, "device">;
}

export interface GeometryPageStreamingPollEvidenceV1 {
  readonly completedFrame: number;
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
  #lastPoll: GeometryPageStreamingPollEvidenceV1 | null = null;
  #destroyed = false;

  constructor(
    device: GPUDevice,
    residency: VirtualGeometryResidency,
    options: GeometryPageStreamingRuntimeOptionsV1 = {}
  ) {
    this.#device = device;
    this.#residency = residency;
    this.#scheduler = options.scheduler ?? new GeometryPageSchedulerV1(
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

  get scheduler(): GeometryPageSchedulerV1 { return this.#scheduler; }

  /** Registers a Product source without transferring source ownership. */
  registerProduct(source: GeometryProductRevisionSourceV1): void {
    if (source.descriptor.revision !== this.#residency.descriptor.revision ||
        !sameBytes(source.descriptor.productId, this.#residency.descriptor.productId)) {
      throw new Error("Geometry page source does not match the active residency Product");
    }
    this.#scheduler.registerProduct(
      this.#residency.productTableSlot,
      this.#residency.productGeneration,
      source,
      { sourceOwnership: "external" }
    );
  }

  selectEvictionCandidates(frameIndex: number, maxBytes: number, minimumAge = 2): readonly number[] {
    this.assertAlive();
    return this.#residency.selectEvictionCandidates(frameIndex, maxBytes, minimumAge);
  }

  /**
   * Revokes mappings immediately, then releases their physical slots only
   * after the caller-provided submission boundary settles. Rejected GPU
   * completion is treated as safe because the submission did not remain live.
   */
  async retirePages(pageIds: readonly number[], completion: PromiseLike<void>): Promise<void> {
    this.assertAlive();
    const unique = [...new Set(pageIds)];
    for (const pageId of unique) {
      if (!Number.isSafeInteger(pageId) || pageId < 0) {
        throw new RangeError("Geometry page eviction pageId must be a non-negative integer");
      }
      if (pageId >= this.#residency.descriptor.pageRecords.byteLength / 32) {
        throw new RangeError("Geometry page eviction pageId exceeds the active Product");
      }
      const location = this.#residency.pageLocation(pageId);
      if (location === undefined) continue;
      if ((location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) {
        throw new Error(`Geometry page ${pageId} is pinned and cannot be evicted`);
      }
      this.#residency.beginRetirePage(pageId);
      this.#scheduler.markRetiring(this.#residency.productGeneration, pageId);
    }
    await Promise.resolve(completion).then(() => undefined, () => undefined);
    for (const pageId of unique) {
      this.#residency.completeRetirePage(pageId);
      this.#scheduler.markRetired(this.#residency.productGeneration, pageId);
    }
  }

  /** Encodes demand feedback into the current frame submission. */
  encodeDemandReadback(
    encoder: GPUCommandEncoder,
    demandBuffer: GPUBuffer,
    frameIndex: number
  ): number | undefined {
    this.assertAlive();
    return this.#readback.encode(encoder, demandBuffer, frameIndex);
  }

  /** Encodes one CSM/Product shadow demand queue into a separate delayed ring. */
  encodeShadowDemandReadback(
    encoder: GPUCommandEncoder,
    demandBuffer: GPUBuffer,
    frameIndex: number
  ): number | undefined {
    this.assertAlive();
    this.#shadowReadback ??= new GpuGeometryDemandReadbackRingV1({
      device: this.#device
    });
    return this.#shadowReadback.encode(encoder, demandBuffer, frameIndex);
  }

  /**
   * Consumes only slots older than the supplied completed frame.  The caller
   * must establish GPU completion (for example via a submission token) before
   * invoking this method; it never waits for the current frame.
   */
  async consumeCompleted(
    completedFrame: number,
    nowMs = 0
  ): Promise<GeometryPageStreamingPollEvidenceV1> {
    this.assertAlive();
    const results = await this.#readback.poll(completedFrame);
    const shadowResults = this.#shadowReadback === null
      ? []
      : await this.#shadowReadback.poll(completedFrame);
    let consumedReadbacks = 0;
    let malformedReadbacks = 0;
    for (const result of results) {
      try {
        this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        consumedReadbacks++;
      } catch {
        malformedReadbacks++;
      } finally {
        this.#readback.release(result.slotIndex);
      }
    }
    for (const result of shadowResults) {
      try {
        this.#scheduler.ingestDemandReadback(result.bytes, nowMs);
        consumedReadbacks++;
      } catch {
        malformedReadbacks++;
      } finally {
        this.#shadowReadback!.release(result.slotIndex);
      }
    }
    const uploadedBytes = this.#scheduler.drainUploadBudget(this.#residency);
    this.#lastPoll = Object.freeze({
      completedFrame,
      mappedSlots: results.length,
      consumedReadbacks,
      malformedReadbacks,
      uploadedBytes
    });
    return this.#lastPoll;
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
    return this.consumeCompleted(frameIndex + 1, nowMs);
  }

  evidence(): GeometryPageStreamingRuntimeEvidenceV1 {
    return Object.freeze({
      readback: this.#readback.evidence(),
      ...(this.#shadowReadback === null ? {} : { shadowReadback: this.#shadowReadback.evidence() }),
      scheduler: this.#scheduler.evidence(),
      residency: this.#residency.evidence(),
      lastPoll: this.#lastPoll
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // The scheduler registration is owned by this runtime.  Remove the
    // generation before dropping the readback rings so pending reads cannot
    // publish pages against a lost/released residency, including callers that
    // supplied an external scheduler.
    this.#scheduler.unregisterProduct(this.#residency.productGeneration);
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
