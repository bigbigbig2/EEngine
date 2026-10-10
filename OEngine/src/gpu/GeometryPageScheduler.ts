import {
  deduplicateGeometryPageDemandsV1,
  unpackGeometryPageDemandHeaderV1,
  unpackGeometryPageDemandV1,
  type GeometryPageDemandV1,
} from "./GeometryPageDemandAbiV1.js";
import {
  GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE,
  decodeGeometryProductPageRecordV1,
  type GeometryProductRevisionSourceV1,
  type GeometryPageProductV1,
} from "../assets/geometry-product/GeometryProductV1.js";

export type GeometryPageOperationStateV1 =
  | "absent"
  | "queued"
  | "producing-or-reading"
  | "verified"
  | "upload-queued"
  | "submitted"
  | "resident"
  | "retiring"
  | "failed";
export type GeometryPageSchedulerCameraStateV1 = "stable" | "moving" | "cut";

export interface GeometryPageUploadSinkV1 {
  /** Includes any resident expansion recorded by this upload, beyond transport bytes. */
  uploadCost?(page: GeometryPageProductV1, identity: GeometryPageDemandV1): number;
  /** False means bounded physical capacity is busy; keep the verified page queued. */
  uploadPage(page: GeometryPageProductV1, identity: GeometryPageDemandV1): boolean | void;
}

export interface GeometryPageSchedulerPressureV1 {
  readonly cameraState?: GeometryPageSchedulerCameraStateV1;
  readonly ioThroughputBytesPerSecond?: number;
  readonly gpuPressure?: number;
  readonly frameTimeMs?: number;
  readonly targetFrameTimeMs?: number;
}

export interface GeometryPageSchedulerBudgetV1 {
  readonly maxConcurrentReads: number;
  readonly maxInFlightBytes: number;
  readonly maxUploadBytesPerFrame: number;
}

export interface GeometryPageSchedulerOptionsV1 {
  /** Hard upper bound. Adaptive pressure never exceeds this value. */
  readonly maxConcurrentReads: number;
  /** Hard upper bound for source bytes in flight. */
  readonly maxInFlightBytes: number;
  /** Hard upper bound for page uploads in one frame. */
  readonly maxUploadBytesPerFrame?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly adaptive?: boolean;
  readonly minConcurrentReads?: number;
  readonly minInFlightBytes?: number;
  readonly minUploadBytesPerFrame?: number;
  readonly targetIoThroughputBytesPerSecond?: number;
}

export interface GeometryPageSchedulerAdaptiveEvidenceV1 {
  readonly enabled: boolean;
  readonly pressureSamples: number;
  readonly budgetChanges: number;
  readonly cameraCutBursts: number;
  readonly throttledFrames: number;
  readonly lastPressure: Readonly<{
    cameraState: GeometryPageSchedulerCameraStateV1;
    gpuPressure: number;
    framePressure: number;
    ioPressure: number;
  }>;
  readonly budget: GeometryPageSchedulerBudgetV1;
}

export interface GeometryPageSchedulerEvidenceV1 {
  readonly requested: number;
  readonly deduplicated: number;
  readonly stale: number;
  readonly failed: number;
  readonly resident: number;
  readonly uploadedBytes: number;
  readonly verifiedBytes: number;
  readonly peakBufferedBytes: number;
  readonly blockedUploads: number;
  readonly pending: number;
  readonly lastError: string | null;
  readonly readLatencyP50Ms: number;
  readonly readLatencyP95Ms: number;
  readonly inFlightBytes: number;
  readonly peakInFlightBytes: number;
  readonly retries: number;
  readonly cancelled: number;
  readonly lateResults: number;
  readonly uploadBudgetExhausted: number;
  readonly demandOverflow: number;
  readonly malformedReadbacks: number;
  readonly adaptive: GeometryPageSchedulerAdaptiveEvidenceV1;
}

export interface GeometryPageRegistrationOptionsV1 {
  /** Defaults to scheduler ownership. Use external when Residency owns the source. */
  readonly sourceOwnership?: "scheduler" | "external";
}

interface RegisteredProduct {
  readonly generation: number;
  readonly productTableSlot: number;
  readonly source: GeometryProductRevisionSourceV1;
  readonly pageCount: number;
  readonly ownsSource: boolean;
  readsServed: number;
  uploadsServed: number;
}
interface Operation {
  readonly key: string;
  demand: GeometryPageDemandV1;
  readonly product: RegisteredProduct;
  state: GeometryPageOperationStateV1;
  page?: GeometryPageProductV1;
  attempts: number;
  nextRetryAt: number;
  age: number;
  controller?: AbortController;
}

/** Delayed CPU demand consumer. It never builds final visible work and never waits for GPU completion. */
export class GeometryPageSchedulerV1 {
  readonly #options: Required<
    Pick<
      GeometryPageSchedulerOptionsV1,
      "maxConcurrentReads" | "maxInFlightBytes" | "maxUploadBytesPerFrame" | "maxRetries" | "retryBaseDelayMs"
    >
  > & {
    adaptive: boolean;
    minConcurrentReads: number;
    minInFlightBytes: number;
    minUploadBytesPerFrame: number;
    targetIoThroughputBytesPerSecond: number;
  };
  readonly #products = new Map<number, RegisteredProduct>();
  readonly #operations = new Map<string, Operation>();
  readonly #inFlight = new Set<Promise<void>>();
  #budget: GeometryPageSchedulerBudgetV1;
  #minimumPageBytes = 0;
  #requested = 0;
  #deduplicated = 0;
  #stale = 0;
  #failed = 0;
  #resident = 0;
  #uploadedBytes = 0;
  #inFlightBytes = 0;
  #verifiedBytes = 0;
  #blockedUploads = 0;
  #peakBufferedBytes = 0;
  #lastError: string | null = null;
  readonly #readLatencies: number[] = [];
  #peakInFlightBytes = 0;
  #retries = 0;
  #cancelled = 0;
  #lateResults = 0;
  #uploadBudgetExhausted = 0;
  #demandOverflow = 0;
  #malformedReadbacks = 0;
  #pressureSamples = 0;
  #budgetChanges = 0;
  #cameraCutBursts = 0;
  #throttledFrames = 0;
  #lastPressure: GeometryPageSchedulerAdaptiveEvidenceV1["lastPressure"] = Object.freeze({
    cameraState: "moving",
    gpuPressure: 0,
    framePressure: 0,
    ioPressure: 0,
  });

  constructor(options: GeometryPageSchedulerOptionsV1) {
    const maxUploadBytesPerFrame = options.maxUploadBytesPerFrame ?? 8 * 1024 * 1024;
    const maxRetries = options.maxRetries ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    const adaptive = options.adaptive ?? true;
    const minConcurrentReads = options.minConcurrentReads ?? 1;
    const minInFlightBytes = options.minInFlightBytes ?? 0;
    const minUploadBytesPerFrame = options.minUploadBytesPerFrame ?? 0;
    const targetIoThroughputBytesPerSecond = options.targetIoThroughputBytesPerSecond ?? 64 * 1024 * 1024;
    if (
      !Number.isInteger(options.maxConcurrentReads) ||
      options.maxConcurrentReads <= 0 ||
      !Number.isInteger(options.maxInFlightBytes) ||
      options.maxInFlightBytes <= 0 ||
      !Number.isInteger(maxUploadBytesPerFrame) ||
      maxUploadBytesPerFrame <= 0 ||
      !Number.isInteger(maxRetries) ||
      maxRetries < 0 ||
      !Number.isFinite(retryBaseDelayMs) ||
      retryBaseDelayMs < 0 ||
      !Number.isInteger(minConcurrentReads) ||
      minConcurrentReads <= 0 ||
      minConcurrentReads > options.maxConcurrentReads ||
      !Number.isInteger(minInFlightBytes) ||
      minInFlightBytes < 0 ||
      minInFlightBytes > options.maxInFlightBytes ||
      !Number.isInteger(minUploadBytesPerFrame) ||
      minUploadBytesPerFrame < 0 ||
      minUploadBytesPerFrame > maxUploadBytesPerFrame ||
      !Number.isFinite(targetIoThroughputBytesPerSecond) ||
      targetIoThroughputBytesPerSecond <= 0
    ) {
      throw new RangeError("Geometry page scheduler budgets/retry options are invalid");
    }
    this.#options = Object.freeze({
      maxConcurrentReads: options.maxConcurrentReads,
      maxInFlightBytes: options.maxInFlightBytes,
      maxUploadBytesPerFrame,
      maxRetries,
      retryBaseDelayMs,
      adaptive,
      minConcurrentReads,
      minInFlightBytes,
      minUploadBytesPerFrame,
      targetIoThroughputBytesPerSecond,
    });
    this.#budget = this.#makeBudget(1);
  }

  registerProduct(
    productTableSlot: number,
    generation: number,
    source: GeometryProductRevisionSourceV1,
    options: GeometryPageRegistrationOptionsV1 = {},
  ): void {
    const pageCount = source.descriptor.pageRecords.byteLength / GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE;
    const pageBytes = source.descriptor.decodedPageBytes;
    if (
      !Number.isInteger(productTableSlot) ||
      productTableSlot < 0 ||
      !Number.isInteger(generation) ||
      generation <= 0 ||
      generation === 0xffffffff ||
      !Number.isInteger(pageCount) ||
      pageCount <= 0 ||
      !Number.isInteger(pageBytes) ||
      pageBytes <= 0 ||
      pageBytes > this.#options.maxInFlightBytes ||
      pageBytes > this.#options.maxUploadBytesPerFrame
    ) {
      throw new RangeError("invalid Geometry Product scheduler registration or page budget");
    }
    if (this.#products.has(generation))
      throw new Error(`product generation ${generation} is already registered`);
    if (
      options.sourceOwnership !== undefined &&
      options.sourceOwnership !== "scheduler" &&
      options.sourceOwnership !== "external"
    ) {
      throw new RangeError("invalid Geometry Product source ownership");
    }
    this.#products.set(generation, {
      productTableSlot,
      generation,
      source,
      pageCount,
      ownsSource: options.sourceOwnership !== "external",
      readsServed: 0,
      uploadsServed: 0,
    });
    this.#minimumPageBytes = Math.max(this.#minimumPageBytes, pageBytes);
    this.#budget = this.#makeBudget(this.#currentScale());
  }

  unregisterProduct(generation: number): void {
    const product = this.#products.get(generation);
    if (!product) return;
    for (const [key, operation] of this.#operations) {
      if (operation.product.generation === generation) {
        operation.controller?.abort();
        this.dropVerified(operation);
        operation.state = "failed";
        this.#operations.delete(key);
        this.#cancelled++;
      }
    }
    this.#products.delete(generation);
    this.#minimumPageBytes = [...this.#products.values()].reduce(
      (max, candidate) => Math.max(max, candidate.source.descriptor.decodedPageBytes),
      0,
    );
    this.#budget = this.#makeBudget(this.#currentScale());
    if (product.ownsSource) product.source.release();
  }

  /** Updates bounded budgets from delayed camera/IO/GPU/frame pressure. */
  setPressure(pressure: GeometryPageSchedulerPressureV1 = {}): GeometryPageSchedulerBudgetV1 {
    const cameraState = pressure.cameraState ?? "moving";
    if (cameraState !== "stable" && cameraState !== "moving" && cameraState !== "cut") {
      throw new RangeError("Geometry page scheduler camera state is invalid");
    }
    const gpuPressure = clampPressure(pressure.gpuPressure ?? 0, "gpuPressure");
    const targetFrameTimeMs = pressure.targetFrameTimeMs ?? 16.67;
    if (!Number.isFinite(targetFrameTimeMs) || targetFrameTimeMs <= 0)
      throw new RangeError("Geometry page scheduler target frame time is invalid");
    const frameTimeMs = pressure.frameTimeMs ?? targetFrameTimeMs;
    if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0)
      throw new RangeError("Geometry page scheduler frame time is invalid");
    const framePressure = clamp01((frameTimeMs / targetFrameTimeMs - 1) / 0.75);
    const throughput = pressure.ioThroughputBytesPerSecond;
    if (throughput !== undefined && (!Number.isFinite(throughput) || throughput < 0))
      throw new RangeError("Geometry page scheduler IO throughput is invalid");
    const ioPressure =
      throughput === undefined ? 0 : clamp01(1 - throughput / this.#options.targetIoThroughputBytesPerSecond);
    const load = Math.max(gpuPressure, framePressure, ioPressure);
    const scale = cameraState === "cut" ? 1 : (cameraState === "stable" ? 0.7 : 0.9) * (1 - 0.55 * load);
    this.#lastPressure = Object.freeze({ cameraState, gpuPressure, framePressure, ioPressure });
    this.#pressureSamples++;
    if (cameraState === "cut") this.#cameraCutBursts++;
    if (load > 0.35 && cameraState !== "cut") this.#throttledFrames++;
    const next = this.#options.adaptive ? this.#makeBudget(scale) : this.#makeBudget(1);
    if (!sameBudget(next, this.#budget)) this.#budgetChanges++;
    this.#budget = next;
    this.pump(0);
    return this.#budget;
  }

  budget(): GeometryPageSchedulerBudgetV1 {
    return this.#budget;
  }

  /** Consumes a delayed GPU demand readback; it never rebuilds visible work. */
  ingestDemandReadback(bytes: ArrayBuffer | Uint8Array, nowMs = 0): void {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      const header = unpackGeometryPageDemandHeaderV1(view);
      if (header.overflow !== 0) this.#demandOverflow++;
      const count = Math.min(header.attempted, header.capacity);
      const required = 16 + count * 16;
      if (required > view.byteLength) throw new RangeError("GeometryPageDemand readback is truncated");
      const records: GeometryPageDemandV1[] = [];
      for (let index = 0; index < count; index++)
        records.push(unpackGeometryPageDemandV1(view, 16 + index * 16));
      this.ingestDemands(records, nowMs);
    } catch (error) {
      this.#malformedReadbacks++;
      throw error;
    }
  }

  ingestDemands(demands: readonly GeometryPageDemandV1[], nowMs = 0): void {
    const unique = deduplicateGeometryPageDemandsV1(demands);
    this.#requested += demands.reduce((count, demand) => count + (demand.residentUsage ? 0 : 1), 0);
    this.#deduplicated += demands.length - unique.length;
    for (const demand of unique) {
      if (demand.residentUsage) {
        continue;
      }
      const product = this.#products.get(demand.productGeneration);
      if (
        !product ||
        product.productTableSlot !== demand.productTableSlot ||
        demand.pageId >= product.pageCount
      ) {
        this.#stale++;
        continue;
      }
      const key = operationKey(demand);
      const existing = this.#operations.get(key);
      if (existing) {
        existing.age++;
        if (priority(demand) > priority(existing.demand)) existing.demand = demand;
        continue;
      }
      this.#operations.set(key, {
        key,
        demand,
        product,
        state: "queued",
        attempts: 0,
        nextRetryAt: nowMs,
        age: 0,
      });
    }
    this.pump(nowMs);
  }

  /** Advances retry eligibility without requiring a new GPU demand record. */
  tick(nowMs = 0, pressure?: GeometryPageSchedulerPressureV1): void {
    if (!Number.isFinite(nowMs) || nowMs < 0)
      throw new RangeError("Geometry page scheduler time must be non-negative");
    for (const operation of this.#operations.values()) {
      if (operation.state === "queued" || operation.state === "upload-queued") operation.age++;
    }
    if (pressure !== undefined) this.setPressure(pressure);
    this.pump(nowMs);
  }

  pump(nowMs = 0): void {
    while (this.#inFlight.size < this.#budget.maxConcurrentReads) {
      const operation = [...this.#operations.values()]
        .filter((candidate) => candidate.state === "queued" && candidate.nextRetryAt <= nowMs)
        .sort(
          (a, b) =>
            a.product.readsServed - b.product.readsServed ||
            priority(b.demand) + b.age - priority(a.demand) - a.age,
        )[0];
      if (!operation) break;
      operation.state = "producing-or-reading";
      operation.controller = new AbortController();
      const bytes = this.#readReservationBytes(operation);
      if (this.#inFlightBytes + this.#verifiedBytes + bytes > this.#budget.maxInFlightBytes) {
        operation.state = "queued";
        operation.controller = undefined;
        break;
      }
      operation.product.readsServed++;
      this.#inFlightBytes += bytes;
      this.#peakBufferedBytes = Math.max(this.#peakBufferedBytes, this.#inFlightBytes + this.#verifiedBytes);
      this.#peakInFlightBytes = Math.max(this.#peakInFlightBytes, this.#inFlightBytes);
      const task = this.produce(operation, nowMs);
      this.#inFlight.add(task);
      void task.then(
        () => {
          this.#inFlight.delete(task);
          this.#inFlightBytes -= bytes;
          this.pump(nowMs);
        },
        (error) => {
          this.#lastError = String(error);
          this.#inFlight.delete(task);
          this.#inFlightBytes -= bytes;
          this.pump(nowMs);
        },
      );
    }
  }

  async drainReads(): Promise<void> {
    await Promise.all([...this.#inFlight]);
  }

  drainUploadBudget(sink: GeometryPageUploadSinkV1, availableBytes?: number): number {
    this.#blockedUploads = 0;
    let remaining = availableBytes ?? this.#budget.maxUploadBytesPerFrame,
      uploaded = 0;
    const ready = [...this.#operations.values()]
      .filter((operation) => operation.state === "upload-queued" && operation.page)
      .sort(
        (a, b) =>
          a.product.uploadsServed - b.product.uploadsServed ||
          priority(b.demand) + b.age - priority(a.demand) - a.age,
      );
    while (ready.length > 0) {
      ready.sort(
        (a, b) =>
          a.product.uploadsServed - b.product.uploadsServed ||
          priority(b.demand) + b.age - priority(a.demand) - a.age,
      );
      const operation = ready.shift()!;
      const page = operation.page!;
      const cost = sink.uploadCost?.(page, operation.demand) ?? page.bytes.byteLength;
      if (!Number.isSafeInteger(cost) || cost < 0 || cost > this.#options.maxUploadBytesPerFrame) {
        this.#lastError = "Geometry page expanded upload exceeds the hard per-frame budget";
        throw new RangeError(this.#lastError);
      }
      // One indivisible page may exceed the adaptive target, never the hard cap.
      if (cost > remaining && (uploaded !== 0 || availableBytes !== undefined)) {
        this.#uploadBudgetExhausted++;
        continue;
      }
      if (sink.uploadPage(page, operation.demand) === false) {
        this.#blockedUploads++;
        this.#uploadBudgetExhausted++;
        continue;
      }
      operation.state = "resident";
      this.dropVerified(operation);
      operation.product.uploadsServed++;
      this.#resident++;
      this.#uploadedBytes += cost;
      uploaded += cost;
      remaining -= cost;
    }
    this.pump(0);
    return uploaded;
  }

  markRetiring(productGeneration: number, pageId: number): void {
    const operation = this.#operations.get(`${productGeneration}:${pageId}`);
    if (operation?.state === "resident") operation.state = "retiring";
  }
  markRetired(productGeneration: number, pageId: number): void {
    const key = `${productGeneration}:${pageId}`,
      operation = this.#operations.get(key);
    if (operation?.state === "retiring") {
      operation.state = "absent";
      this.#operations.delete(key);
    }
  }
  cancelGeneration(productGeneration: number): void {
    for (const [key, operation] of this.#operations)
      if (operation.product.generation === productGeneration && operation.state !== "resident") {
        operation.controller?.abort();
        this.dropVerified(operation);
        operation.state = "failed";
        this.#operations.delete(key);
        this.#cancelled++;
      }
  }
  state(productGeneration: number, pageId: number): GeometryPageOperationStateV1 {
    return this.#operations.get(`${productGeneration}:${pageId}`)?.state ?? "absent";
  }

  get blockedUploads(): number {
    return this.#blockedUploads;
  }

  evidence(): GeometryPageSchedulerEvidenceV1 {
    return Object.freeze({
      requested: this.#requested,
      deduplicated: this.#deduplicated,
      stale: this.#stale,
      failed: this.#failed,
      resident: this.#resident,
      uploadedBytes: this.#uploadedBytes,
      blockedUploads: this.#blockedUploads,
      verifiedBytes: this.#verifiedBytes,
      peakBufferedBytes: this.#peakBufferedBytes,
      pending: [...this.#operations.values()].filter(
        (operation) =>
          operation.state === "queued" ||
          operation.state === "upload-queued" ||
          operation.state === "producing-or-reading",
      ).length,
      lastError: this.#lastError,
      readLatencyP50Ms: percentile(this.#readLatencies, 0.5),
      readLatencyP95Ms: percentile(this.#readLatencies, 0.95),
      inFlightBytes: this.#inFlightBytes,
      peakInFlightBytes: this.#peakInFlightBytes,
      retries: this.#retries,
      cancelled: this.#cancelled,
      lateResults: this.#lateResults,
      uploadBudgetExhausted: this.#uploadBudgetExhausted,
      demandOverflow: this.#demandOverflow,
      malformedReadbacks: this.#malformedReadbacks,
      adaptive: Object.freeze({
        enabled: this.#options.adaptive,
        pressureSamples: this.#pressureSamples,
        budgetChanges: this.#budgetChanges,
        cameraCutBursts: this.#cameraCutBursts,
        throttledFrames: this.#throttledFrames,
        lastPressure: this.#lastPressure,
        budget: this.#budget,
      }),
    });
  }

  #readReservationBytes(operation: Operation): number {
    return operation.product.source.descriptor.decodedPageBytes;
  }

  #currentScale(): number {
    if (this.#pressureSamples === 0) return 1;
    const load = Math.max(
      this.#lastPressure.gpuPressure,
      this.#lastPressure.framePressure,
      this.#lastPressure.ioPressure,
    );
    if (this.#lastPressure.cameraState === "cut") return 1;
    return (this.#lastPressure.cameraState === "stable" ? 0.7 : 0.9) * (1 - 0.55 * load);
  }

  #makeBudget(scale: number): GeometryPageSchedulerBudgetV1 {
    const bounded = Math.max(0.25, Math.min(1, scale));
    const maxConcurrentReads = Math.max(
      this.#options.minConcurrentReads,
      Math.min(this.#options.maxConcurrentReads, Math.floor(this.#options.maxConcurrentReads * bounded)),
    );
    const maxInFlightBytes = Math.max(
      this.#minimumPageBytes,
      this.#options.minInFlightBytes,
      Math.min(this.#options.maxInFlightBytes, Math.floor(this.#options.maxInFlightBytes * bounded)),
    );
    const maxUploadBytesPerFrame = Math.max(
      this.#minimumPageBytes,
      this.#options.minUploadBytesPerFrame,
      Math.min(
        this.#options.maxUploadBytesPerFrame,
        Math.floor(this.#options.maxUploadBytesPerFrame * bounded),
      ),
    );
    return Object.freeze({ maxConcurrentReads, maxInFlightBytes, maxUploadBytesPerFrame });
  }

  private dropVerified(operation: Operation): void {
    if (operation.page !== undefined) {
      this.#verifiedBytes -= operation.page.bytes.byteLength;
      operation.page = undefined;
    }
  }

  private async produce(operation: Operation, nowMs: number): Promise<void> {
    const startedAt = performance.now();
    try {
      const page = await operation.product.source.readPage(
        operation.demand.pageId,
        operation.controller?.signal,
      );
      const descriptor = operation.product.source.descriptor;
      const expected = decodeGeometryProductPageRecordV1(descriptor, operation.demand.pageId);
      if (
        page.revision !== descriptor.revision ||
        page.pageId !== operation.demand.pageId ||
        !sameBytes(page.productId, descriptor.productId) ||
        page.bytes.byteLength !== descriptor.decodedPageBytes ||
        !sameBytes(page.decodedHash128, expected.decodedHash128)
      )
        throw new Error("page key/size/identity mismatch");
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", page.bytes));
      if (!sameBytes(digest.subarray(0, 16), page.decodedPageHash128))
        throw new Error("page integrity hash mismatch");
      if (
        this.#products.get(operation.product.generation) !== operation.product ||
        operation.controller?.signal.aborted
      ) {
        this.#lateResults++;
        operation.state = "failed";
        this.#failed++;
        return;
      }
      operation.page = Object.freeze({
        ...page,
        productId: page.productId.slice(),
        decodedHash128: page.decodedHash128.slice(),
        decodedPageHash128: page.decodedPageHash128.slice(),
        bytes: page.bytes.slice(0),
      });
      this.#verifiedBytes += operation.page.bytes.byteLength;
      operation.state = "verified";
      operation.state = "upload-queued";
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      if (
        this.#products.get(operation.product.generation) !== operation.product ||
        operation.controller?.signal.aborted
      ) {
        this.#lateResults++;
        operation.state = "failed";
        return;
      }
      operation.attempts++;
      const deterministic = /hash|size|key|profile|corrupt|unsupported|identity|integrity/i.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!deterministic && operation.attempts <= this.#options.maxRetries) {
        operation.state = "queued";
        operation.nextRetryAt = nowMs + this.#options.retryBaseDelayMs * 2 ** (operation.attempts - 1);
        this.#retries++;
      } else {
        operation.state = "failed";
        this.#failed++;
      }
    } finally {
      this.#readLatencies.push(performance.now() - startedAt);
      if (this.#readLatencies.length > 64) this.#readLatencies.shift();
    }
  }
}

function operationKey(demand: GeometryPageDemandV1): string {
  return `${demand.productGeneration}:${demand.pageId}`;
}
function priority(demand: GeometryPageDemandV1): number {
  return (
    demand.priority +
    (demand.currentViewMissing ? 0x1000000 : 0) +
    (demand.shadow ? 0x800000 : 0) +
    (demand.predictive ? 0x400000 : 0)
  );
}
function sameBudget(a: GeometryPageSchedulerBudgetV1, b: GeometryPageSchedulerBudgetV1): boolean {
  return (
    a.maxConcurrentReads === b.maxConcurrentReads &&
    a.maxInFlightBytes === b.maxInFlightBytes &&
    a.maxUploadBytesPerFrame === b.maxUploadBytesPerFrame
  );
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function clampPressure(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`Geometry page scheduler ${label} is invalid`);
  return value;
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}
