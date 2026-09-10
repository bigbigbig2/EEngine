import type {
  RuntimeAssetChunkV2,
  RuntimeAssetManifestV2,
  RuntimeAssetVariantV2
} from "./RuntimeAssetManifestV2.js";

export type RuntimeAssetRequestState =
  | "unrequested"
  | "requested"
  | "resident"
  | "retiring";

export interface RuntimeAssetResidentRange {
  readonly assetId: string;
  readonly chunkId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly decodedBytes: number;
  readonly expectedResidentBytes: number;
  readonly residentResourceId: string | null;
  readonly residentByteOffset: number | null;
  readonly residentByteLength: number;
  readonly state: RuntimeAssetRequestState;
}

export interface RuntimeAssetResidencyBudget {
  readonly maxUploadBytes: number;
  readonly maxResidentBytes: number;
}

export interface RuntimeAssetResidencyBudgetRequest {
  readonly assetId: string;
  readonly chunkIds: readonly string[];
  readonly uploadBytes: number;
  readonly residentBytes: number;
}

export interface RuntimeAssetResidencyBudgetHooks {
  reserve(request: RuntimeAssetResidencyBudgetRequest): boolean;
  release(request: RuntimeAssetResidencyBudgetRequest): void;
}

export interface RuntimeAssetResidencyEvidence {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly variantId: string;
  readonly requestedChunkCount: number;
  readonly residentChunkCount: number;
  readonly retiringChunkCount: number;
  readonly uploadBytes: number;
  readonly residentBytes: number;
  readonly rejectedRequestCount: number;
  readonly abortedRequestCount: number;
  readonly deviceLossResetCount: number;
}

interface MutableRange {
  readonly chunk: RuntimeAssetChunkV2;
  state: RuntimeAssetRequestState;
  residentResourceId: string | null;
  residentByteOffset: number | null;
  residentByteLength: number;
}

export interface RuntimeAssetResidencyReservation {
  readonly assetId: string;
  readonly variantId: string;
  readonly chunkIds: readonly string[];
  readonly uploadBytes: number;
  readonly residentBytes: number;
}

export interface RuntimeAssetPhysicalRange {
  readonly resourceId?: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

const RESERVATION_OWNER = new WeakMap<object, RuntimeAssetResidencyState>();

/**
 * Bounded chunk/page seam only. It deliberately contains no priority queue,
 * feedback loop, IO scheduler, or GPU resource ownership.
 */
export class RuntimeAssetResidencyState {
  private readonly ranges = new Map<string, MutableRange>();
  private readonly activeReservations = new Set<RuntimeAssetResidencyReservation>();
  private rejectedRequestCount = 0;
  private abortedRequestCount = 0;
  private deviceLossResetCount = 0;

  constructor(
    readonly manifest: RuntimeAssetManifestV2,
    readonly variant: RuntimeAssetVariantV2,
    private readonly hooks?: RuntimeAssetResidencyBudgetHooks
  ) {
    const chunks = new Map(manifest.chunks.map((chunk) => [chunk.id, chunk]));
    for (const chunkId of variant.chunkIds) {
      const chunk = chunks.get(chunkId);
      if (chunk === undefined) throw new Error(`Residency variant references missing chunk '${chunkId}'`);
      this.ranges.set(chunkId, {
        chunk,
        state: "unrequested",
        residentResourceId: null,
        residentByteOffset: null,
        residentByteLength: 0
      });
    }
  }

  request(
    chunkIds: readonly string[],
    budget: RuntimeAssetResidencyBudget
  ): RuntimeAssetResidencyReservation {
    const ids = [...new Set(chunkIds)].sort();
    if (ids.length === 0) throw new RangeError("Residency request must contain at least one chunk");
    const pending: MutableRange[] = [];
    for (const id of ids) {
      const range = this.ranges.get(id);
      if (range === undefined) throw new RangeError(`Chunk '${id}' is outside residency variant '${this.variant.id}'`);
      if (range.state !== "unrequested") throw new Error(`Chunk '${id}' is already ${range.state}`);
      pending.push(range);
    }
    const uploadBytes = pending.reduce((sum, range) => sum + range.chunk.compressedBytes, 0);
    const residentBytes = pending.reduce((sum, range) => sum + range.chunk.expectedResidentBytes, 0);
    const request = Object.freeze({
      assetId: this.manifest.assetId,
      variantId: this.variant.id,
      chunkIds: Object.freeze(ids),
      uploadBytes,
      residentBytes
    });
    if (!validBudget(budget) || uploadBytes > budget.maxUploadBytes ||
        residentBytes > budget.maxResidentBytes || this.hooks?.reserve(request) === false) {
      this.rejectedRequestCount++;
      throw new RangeError(`Residency request for '${this.manifest.assetId}' exceeds its upload/resident budget`);
    }
    for (const range of pending) range.state = "requested";
    this.activeReservations.add(request);
    RESERVATION_OWNER.set(request, this);
    return request;
  }

  commit(
    reservation: RuntimeAssetResidencyReservation,
    residentRanges: Readonly<Record<string, RuntimeAssetPhysicalRange>> = {}
  ): void {
    this.requireReservation(reservation);
    for (const chunkId of reservation.chunkIds) {
      const range = this.ranges.get(chunkId)!;
      const physical = residentRanges[chunkId];
      if (range.state !== "requested") throw new Error(`Chunk '${chunkId}' is not awaiting commit`);
      if (physical !== undefined && (!validNonNegativeInteger(physical.byteOffset) ||
          !validNonNegativeInteger(physical.byteLength))) {
        throw new RangeError(`Chunk '${chunkId}' resident range is invalid`);
      }
    }
    for (const chunkId of reservation.chunkIds) {
      const range = this.ranges.get(chunkId)!;
      const physical = residentRanges[chunkId];
      range.state = "resident";
      range.residentResourceId = physical?.resourceId ?? null;
      range.residentByteOffset = physical?.byteOffset ?? null;
      range.residentByteLength = physical?.byteLength ?? range.chunk.expectedResidentBytes;
    }
    this.activeReservations.delete(reservation);
  }

  abort(reservation: RuntimeAssetResidencyReservation): void {
    this.requireReservation(reservation);
    for (const chunkId of reservation.chunkIds) {
      const range = this.ranges.get(chunkId)!;
      if (range.state === "requested") range.state = "unrequested";
    }
    this.activeReservations.delete(reservation);
    this.hooks?.release(reservation);
    this.abortedRequestCount++;
  }

  retire(chunkIds: readonly string[]): void {
    for (const chunkId of [...new Set(chunkIds)]) {
      const range = this.requireRange(chunkId);
      if (range.state !== "resident") throw new Error(`Chunk '${chunkId}' is not resident`);
      range.state = "retiring";
    }
  }

  completeRetire(chunkIds: readonly string[]): void {
    const ids = [...new Set(chunkIds)];
    let uploadBytes = 0;
    let residentBytes = 0;
    for (const chunkId of ids) {
      const range = this.requireRange(chunkId);
      if (range.state !== "retiring") throw new Error(`Chunk '${chunkId}' is not retiring`);
      uploadBytes += range.chunk.compressedBytes;
      residentBytes += range.chunk.expectedResidentBytes;
      range.state = "unrequested";
      range.residentResourceId = null;
      range.residentByteOffset = null;
      range.residentByteLength = 0;
    }
    this.hooks?.release(Object.freeze({
      assetId: this.manifest.assetId,
      variantId: this.variant.id,
      chunkIds: Object.freeze(ids.sort()),
      uploadBytes,
      residentBytes
    }));
  }

  resetAfterDeviceLoss(): void {
    for (const reservation of this.activeReservations) this.hooks?.release(reservation);
    this.activeReservations.clear();
    const committed = [...this.ranges.values()].filter(
      (range) => range.state === "resident" || range.state === "retiring"
    );
    if (committed.length > 0) {
      this.hooks?.release(Object.freeze({
        assetId: this.manifest.assetId,
        variantId: this.variant.id,
        chunkIds: Object.freeze(committed.map((range) => range.chunk.id).sort()),
        uploadBytes: committed.reduce((sum, range) => sum + range.chunk.compressedBytes, 0),
        residentBytes: committed.reduce(
          (sum, range) => sum + range.chunk.expectedResidentBytes,
          0
        )
      }));
    }
    for (const range of this.ranges.values()) {
      range.state = "unrequested";
      range.residentResourceId = null;
      range.residentByteOffset = null;
      range.residentByteLength = 0;
    }
    this.deviceLossResetCount++;
  }

  range(chunkId: string): RuntimeAssetResidentRange {
    const range = this.requireRange(chunkId);
    return freezeRange(this.manifest.assetId, range);
  }

  snapshot(): readonly RuntimeAssetResidentRange[] {
    return Object.freeze([...this.ranges.values()]
      .sort((left, right) => left.chunk.id.localeCompare(right.chunk.id))
      .map((range) => freezeRange(this.manifest.assetId, range)));
  }

  evidence(): RuntimeAssetResidencyEvidence {
    const ranges = [...this.ranges.values()];
    return Object.freeze({
      schemaVersion: 1,
      assetId: this.manifest.assetId,
      variantId: this.variant.id,
      requestedChunkCount: ranges.filter((range) => range.state === "requested").length,
      residentChunkCount: ranges.filter((range) => range.state === "resident").length,
      retiringChunkCount: ranges.filter((range) => range.state === "retiring").length,
      uploadBytes: ranges.filter((range) => range.state === "resident" || range.state === "retiring")
        .reduce((sum, range) => sum + range.chunk.compressedBytes, 0),
      residentBytes: ranges.filter((range) => range.state === "resident" || range.state === "retiring")
        .reduce((sum, range) => sum + range.residentByteLength, 0),
      rejectedRequestCount: this.rejectedRequestCount,
      abortedRequestCount: this.abortedRequestCount,
      deviceLossResetCount: this.deviceLossResetCount
    });
  }

  private requireReservation(reservation: RuntimeAssetResidencyReservation): void {
    if (RESERVATION_OWNER.get(reservation as object) !== this || !this.activeReservations.has(reservation)) {
      throw new Error("Residency reservation is stale or owned by another asset");
    }
  }

  private requireRange(chunkId: string): MutableRange {
    const range = this.ranges.get(chunkId);
    if (range === undefined) throw new RangeError(`Unknown residency chunk '${chunkId}'`);
    return range;
  }
}

function freezeRange(assetId: string, range: MutableRange): RuntimeAssetResidentRange {
  return Object.freeze({
    assetId,
    chunkId: range.chunk.id,
    byteOffset: range.chunk.byteOffset,
    byteLength: range.chunk.compressedBytes,
    decodedBytes: range.chunk.decodedBytes,
    expectedResidentBytes: range.chunk.expectedResidentBytes,
    residentResourceId: range.residentResourceId,
    residentByteOffset: range.residentByteOffset,
    residentByteLength: range.residentByteLength,
    state: range.state
  });
}

function validBudget(budget: RuntimeAssetResidencyBudget): boolean {
  return Number.isFinite(budget.maxUploadBytes) && budget.maxUploadBytes >= 0 &&
    Number.isFinite(budget.maxResidentBytes) && budget.maxResidentBytes >= 0;
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
