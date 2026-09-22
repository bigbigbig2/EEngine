import {
  assertGeometryProductDescriptorV1,
  type GeometryPageProductV1,
  type GeometryProductDescriptorV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import {
  GEOMETRY_PAGE_LOCATION_PINNED,
  GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1,
  GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
  packGeometryProductTableRecordV1,
  type GeometryProductTableRecordV1
} from "./GeometryProductGpuAbiV1.js";
import {
  reserveGeometryProductMetadataBytes
} from "./GeometryProductGpuBudget.js";
import { VirtualGeometryResidency, type VirtualGeometryResidencyOptionsV1 } from "./VirtualGeometryResidency.js";

/** Phase E logical multi-Product table and lifecycle ABI version. */
export const GEOMETRY_PRODUCT_MULTI_RUNTIME_ABI_VERSION_V1 = 1;
/** ADR-0018's first promoted scale gate. */
export const GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1 = 64;

export type GeometryProductShardStateV1 =
  | "loading"
  | "active"
  | "dormant"
  | "retiring"
  | "released"
  | "failed";

export interface GeometryProductInstanceIdentityV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly assetRecordIndex: number;
}

export interface GeometryProductPageIdentityV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly pageId: number;
}

export interface GeometryProductShardHandleV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly descriptor: GeometryProductDescriptorV1;
  readonly residency: VirtualGeometryResidency;
  readonly state: GeometryProductShardStateV1;
}

export interface GeometryProductMultiRuntimeEvidenceV1 {
  readonly abiVersion: 1;
  readonly slotCapacity: number;
  readonly active: number;
  readonly loading: number;
  readonly dormant: number;
  readonly retiring: number;
  readonly failed: number;
  readonly replacements: number;
  readonly evictions: number;
  readonly releases: number;
  readonly acceptedDemands: number;
  readonly staleDemands: number;
  readonly acceptedCompletions: number;
  readonly staleCompletions: number;
  readonly rejectedCompletions: number;
  readonly peakActive: number;
  readonly tableBytes: number;
}

export type GeometryProductPageCompletionResultV1 =
  | "uploaded"
  | "stale"
  | "rejected";

interface ProductEntry {
  readonly slot: number;
  readonly generation: number;
  readonly source: GeometryProductRevisionSourceV1;
  readonly descriptor: GeometryProductDescriptorV1;
  readonly abort: AbortController;
  residency?: VirtualGeometryResidency;
  state: GeometryProductShardStateV1;
  ready: Promise<VirtualGeometryResidency>;
}

/**
 * Owns the scene-level Product table while each shard keeps its own Product
 * source and residency.  The table is intentionally independent from the
 * loader and from Scene objects: a slot can be replaced, made dormant, or
 * released without touching another shard.
 *
 * Product table records are the authoritative CPU/GPU lifecycle publication.
 * The existing per-Product metadata heaps remain the payload owner for the
 * current renderer; the records use the same V1 64-byte ABI and ranges as the
 * heap record so a future combined heap can consume them without translation.
 */
export class GeometryProductMultiRuntimeV1 {
  readonly #device: GPUDevice;
  readonly #residencyOptions: VirtualGeometryResidencyOptionsV1;
  readonly #slotCapacity: number;
  readonly #table: GPUBuffer;
  readonly #releaseTableReservation: () => void;
  readonly #current = new Map<number, ProductEntry>();
  readonly #retiring = new Map<string, ProductEntry>();
  readonly #records: Array<GeometryProductTableRecordV1 | undefined>;
  readonly #usedSlots: Uint8Array;
  #nextGeneration = 1;
  #destroyed = false;
  #replacements = 0;
  #evictions = 0;
  #releases = 0;
  #acceptedDemands = 0;
  #staleDemands = 0;
  #acceptedCompletions = 0;
  #staleCompletions = 0;
  #rejectedCompletions = 0;
  #peakActive = 0;

  constructor(device: GPUDevice, options: Readonly<{
    readonly slotCapacity?: number;
    readonly residency?: VirtualGeometryResidencyOptionsV1;
  }> = {}) {
    this.#device = device;
    this.#residencyOptions = options.residency ?? {};
    const slotCapacity = options.slotCapacity ?? GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1;
    if (!Number.isSafeInteger(slotCapacity) || slotCapacity < GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1 || slotCapacity >= 0xffffffff) {
      throw new RangeError(`Geometry Product multi-runtime slotCapacity must be an integer in [${GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1}, 0xfffffffe]`);
    }
    this.#slotCapacity = slotCapacity;
    this.#records = new Array(slotCapacity);
    this.#usedSlots = new Uint8Array(slotCapacity);
    const tableBytes = slotCapacity * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1;
    const maxBufferSize = Number(device.limits.maxBufferSize);
    const maxStorageBinding = Number(device.limits.maxStorageBufferBindingSize);
    if (!Number.isFinite(maxBufferSize) || !Number.isFinite(maxStorageBinding) ||
        tableBytes > maxBufferSize || tableBytes > maxStorageBinding) {
      throw new RangeError("Geometry Product multi-runtime Product Table exceeds negotiated storage-buffer limits");
    }
    const releaseTableReservation = reserveGeometryProductMetadataBytes(device, tableBytes);
    try {
      this.#table = device.createBuffer({
        label: "OEngine Geometry Product multi-runtime Product Table V1",
        size: tableBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.#releaseTableReservation = releaseTableReservation;
    } catch (error) {
      releaseTableReservation();
      throw error;
    }
  }

  get slotCapacity(): number { return this.#slotCapacity; }
  get table(): GPUBuffer { return this.#table; }
  get tableBytes(): number { return this.#slotCapacity * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1; }

  /** Loads one independent shard. A failed shard never changes another slot. */
  async load(
    source: GeometryProductRevisionSourceV1,
    options: Readonly<{ readonly productTableSlot?: number }> = {}
  ): Promise<GeometryProductShardHandleV1> {
    this.assertAlive();
    assertGeometryProductDescriptorV1(source.descriptor);
    const slot = options.productTableSlot ?? this.findFreeSlot();
    this.assertSlot(slot);
    if (this.slotOccupied(slot)) throw new Error(`Geometry Product table slot ${slot} is already occupied`);
    const entry = this.createEntry(slot, source);
    this.#current.set(slot, entry);
    this.#usedSlots[slot] = 1;
    try {
      const residency = await entry.ready;
      if (this.#destroyed) {
        residency.destroy();
        throw new Error("Geometry Product multi-runtime is destroyed");
      }
      this.publishActive(entry, residency);
      return this.handle(entry);
    } catch (error) {
      this.#current.delete(slot);
      this.#usedSlots[slot] = 0;
      entry.state = "failed";
      entry.residency?.destroy();
      if (!this.#destroyed) this.clearRecord(slot);
      throw error;
    }
  }

  /**
   * Builds a replacement in the same slot. The old generation remains owned
   * and stale until retire(), while the table switches only after the new
   * activation cut has completed.
   */
  async replace(
    productTableSlot: number,
    source: GeometryProductRevisionSourceV1
  ): Promise<GeometryProductShardHandleV1> {
    this.assertAlive();
    this.assertSlot(productTableSlot);
    const previous = this.#current.get(productTableSlot);
    if (!previous || (previous.state !== "active" && previous.state !== "dormant")) {
      throw new Error(`Geometry Product table slot ${productTableSlot} has no replaceable active shard`);
    }
    assertGeometryProductDescriptorV1(source.descriptor);
    const replacement = this.createEntry(productTableSlot, source);
    this.#current.set(productTableSlot, replacement);
    try {
      const residency = await replacement.ready;
      if (this.#destroyed) {
        residency.destroy();
        throw new Error("Geometry Product multi-runtime is destroyed");
      }
      this.publishActive(replacement, residency);
      previous.state = "retiring";
      this.#retiring.set(entryKey(previous.slot, previous.generation), previous);
      this.#replacements++;
      return this.handle(replacement);
    } catch (error) {
      this.#current.set(productTableSlot, previous);
      replacement.state = "failed";
      replacement.abort.abort(error);
      replacement.residency?.destroy();
      throw error;
    }
  }

  /** Marks an active shard dormant without releasing its source or pages. */
  setDormant(productTableSlot: number, productGeneration: number, dormant = true): void {
    this.assertAlive();
    const entry = this.requireCurrent(productTableSlot, productGeneration);
    if (dormant) {
      if (entry.state === "dormant") return;
      if (entry.state !== "active") throw new Error("Only an active Product can become dormant");
      entry.residency!.deactivatePublication();
      entry.state = "dormant";
      this.clearRecord(entry.slot);
      return;
    }
    if (entry.state !== "dormant") {
      if (entry.state === "active") return;
      throw new Error("Only a dormant Product can become active");
    }
    entry.residency!.activatePublication();
    entry.state = "active";
    this.writeRecord(entry.slot, productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1));
  }

  /**
   * Revokes and completes page eviction for one shard. The completion token is
   * supplied by the renderer; the runtime never waits for the GPU itself.
   */
  async evictPage(
    identity: GeometryProductPageIdentityV1,
    completion: PromiseLike<void> = Promise.resolve()
  ): Promise<boolean> {
    this.assertAlive();
    const entry = this.currentEntry(identity.productTableSlot, identity.productGeneration);
    if (!entry || entry.state !== "active") { this.#staleDemands++; return false; }
    const location = entry.residency!.pageLocation(identity.pageId);
    if (!location || (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) return false;
    entry.residency!.beginRetirePage(identity.pageId);
    if (entry.residency!.pageLocation(identity.pageId) !== undefined) return false;
    await Promise.resolve(completion).then(() => undefined, () => undefined);
    entry.residency!.completeRetirePage(identity.pageId);
    this.#evictions++;
    return true;
  }

  /** Revokes a whole shard and releases it after the submission boundary. */
  async release(
    productTableSlot: number,
    productGeneration: number,
    completion: PromiseLike<void> = Promise.resolve()
  ): Promise<boolean> {
    this.assertAlive();
    const entry = this.currentEntry(productTableSlot, productGeneration);
    if (!entry) return false;
    this.clearRecord(entry.slot);
    this.#current.delete(entry.slot);
    entry.state = "retiring";
    await Promise.resolve(completion).then(() => undefined, () => undefined);
    entry.residency?.destroy();
    entry.state = "released";
    if (!this.slotHasRetiring(entry.slot)) this.#usedSlots[entry.slot] = 0;
    this.#releases++;
    return true;
  }

  /** Finishes a replacement after its old GPU submission is safe to retire. */
  async retire(productTableSlot: number, productGeneration: number, completion: PromiseLike<void> = Promise.resolve()): Promise<boolean> {
    this.assertAlive();
    const key = entryKey(productTableSlot, productGeneration);
    const entry = this.#retiring.get(key);
    if (!entry) return false;
    await Promise.resolve(completion).then(() => undefined, () => undefined);
    entry.residency?.destroy();
    entry.state = "released";
    this.#retiring.delete(key);
    if (!this.#current.has(entry.slot)) this.#usedSlots[entry.slot] = 0;
    this.#releases++;
    return true;
  }

  /** Validates a GPU demand against the current slot and generation. */
  acceptDemand(identity: GeometryProductPageIdentityV1): boolean {
    this.assertAlive();
    const entry = this.currentEntry(identity.productTableSlot, identity.productGeneration);
    if (!entry || entry.state !== "active" || !validPageId(entry.descriptor, identity.pageId)) {
      this.#staleDemands++;
      return false;
    }
    this.#acceptedDemands++;
    return true;
  }

  /**
   * Publishes a completed page only when the exact current generation owns it.
   * No stale completion may consume a physical slot.
   */
  completePage(
    identity: GeometryProductPageIdentityV1,
    page: GeometryPageProductV1
  ): GeometryProductPageCompletionResultV1 {
    this.assertAlive();
    const entry = this.currentEntry(identity.productTableSlot, identity.productGeneration);
    if (!entry || entry.state !== "active" || identity.pageId !== page.pageId || !validPageId(entry.descriptor, identity.pageId)) {
      this.#staleCompletions++;
      return "stale";
    }
    try {
      entry.residency!.uploadPage(page);
    } catch {
      this.#rejectedCompletions++;
      return "rejected";
    }
    this.#acceptedCompletions++;
    return "uploaded";
  }

  /** Product-local instance identity used by the GPU instance publication. */
  instanceIdentity(productTableSlot: number, productGeneration: number, assetRecordIndex: number): GeometryProductInstanceIdentityV1 | undefined {
    const entry = this.currentEntry(productTableSlot, productGeneration);
    if (!entry || entry.state !== "active" || !validAssetIndex(entry.descriptor, assetRecordIndex)) return undefined;
    return Object.freeze({ productTableSlot, productGeneration, assetRecordIndex });
  }

  shard(productTableSlot: number): GeometryProductShardHandleV1 | undefined {
    const entry = this.#current.get(productTableSlot);
    return entry?.residency === undefined ? undefined : this.handle(entry);
  }

  tableRecord(productTableSlot: number): GeometryProductTableRecordV1 | undefined {
    this.assertSlot(productTableSlot);
    return this.#records[productTableSlot];
  }

  evidence(): GeometryProductMultiRuntimeEvidenceV1 {
    let active = 0, loading = 0, dormant = 0, failed = 0;
    for (const entry of this.#current.values()) {
      if (entry.state === "active") active++;
      else if (entry.state === "loading") loading++;
      else if (entry.state === "dormant") dormant++;
      else if (entry.state === "failed") failed++;
    }
    return Object.freeze({
      abiVersion: GEOMETRY_PRODUCT_MULTI_RUNTIME_ABI_VERSION_V1,
      slotCapacity: this.#slotCapacity,
      active,
      loading,
      dormant,
      retiring: this.#retiring.size + [...this.#current.values()].filter((entry) => entry.state === "retiring").length,
      failed,
      replacements: this.#replacements,
      evictions: this.#evictions,
      releases: this.#releases,
      acceptedDemands: this.#acceptedDemands,
      staleDemands: this.#staleDemands,
      acceptedCompletions: this.#acceptedCompletions,
      staleCompletions: this.#staleCompletions,
      rejectedCompletions: this.#rejectedCompletions,
      peakActive: this.#peakActive,
      tableBytes: this.tableBytes
    });
  }

  /** Synchronous teardown used by Renderer destruction; no GPU await is needed. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.clearAllRecords();
    for (const entry of this.#current.values()) {
      entry.abort.abort(new Error("Geometry Product multi-runtime was destroyed"));
      entry.residency?.destroy();
    }
    for (const entry of this.#retiring.values()) entry.residency?.destroy();
    this.#current.clear();
    this.#retiring.clear();
    this.#table.destroy();
    this.#releaseTableReservation();
  }

  private createEntry(slot: number, source: GeometryProductRevisionSourceV1): ProductEntry {
    const generation = this.allocateGeneration();
    const abort = new AbortController();
    const entry: ProductEntry = {
      slot,
      generation,
      source,
      descriptor: source.descriptor,
      abort,
      state: "loading",
      ready: Promise.resolve(undefined as never)
    };
    entry.ready = VirtualGeometryResidency.create(
      this.#device,
      source,
      generation,
      slot,
      abort.signal,
      this.#residencyOptions
    ).then((residency) => {
      entry.residency = residency;
      return residency;
    }, (error) => {
      entry.state = "failed";
      throw error;
    });
    return entry;
  }

  private publishActive(entry: ProductEntry, residency: VirtualGeometryResidency): void {
    residency.activatePublication();
    entry.state = "active";
    this.writeRecord(entry.slot, productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1));
    this.#peakActive = Math.max(this.#peakActive, [...this.#current.values()].filter((candidate) => candidate.state === "active").length);
  }

  private currentEntry(slot: number, generation: number): ProductEntry | undefined {
    const entry = this.#current.get(slot);
    if (!entry || entry.generation !== generation) return undefined;
    return entry;
  }

  private requireCurrent(slot: number, generation: number): ProductEntry {
    const entry = this.currentEntry(slot, generation);
    if (!entry) throw new Error("Geometry Product identity is stale or not active");
    return entry;
  }

  private handle(entry: ProductEntry): GeometryProductShardHandleV1 {
    if (!entry.residency) throw new Error("Geometry Product shard has no residency");
    return Object.freeze({
      productTableSlot: entry.slot,
      productGeneration: entry.generation,
      descriptor: entry.descriptor,
      residency: entry.residency,
      get state() { return entry.state; }
    });
  }

  private findFreeSlot(): number {
    for (let slot = 0; slot < this.#slotCapacity; slot++) if (!this.slotOccupied(slot)) return slot;
    throw new RangeError(`Geometry Product multi-runtime has no free ProductTableSlot (capacity ${this.#slotCapacity})`);
  }

  private slotOccupied(slot: number): boolean {
    if (this.#usedSlots[slot] !== 0 || this.#current.has(slot)) return true;
    return this.slotHasRetiring(slot);
  }

  private slotHasRetiring(slot: number): boolean {
    for (const entry of this.#retiring.values()) if (entry.slot === slot) return true;
    return false;
  }

  private allocateGeneration(): number {
    const live = new Set<number>([
      ...[...this.#current.values()].map((entry) => entry.generation),
      ...[...this.#retiring.values()].map((entry) => entry.generation)
    ]);
    for (let attempt = 0; attempt < 0xfffffffe; attempt++) {
      const generation = this.#nextGeneration;
      this.#nextGeneration = generation >= 0xfffffffe ? 1 : generation + 1;
      if (generation !== 0 && generation !== 0xffffffff && !live.has(generation)) return generation;
    }
    throw new Error("Geometry Product generation space exhausted");
  }

  private writeRecord(slot: number, record: GeometryProductTableRecordV1): void {
    this.#records[slot] = Object.freeze({ ...record });
    this.#device.queue.writeBuffer(this.#table, slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1, packGeometryProductTableRecordV1(record));
  }

  private clearRecord(slot: number): void {
    this.#records[slot] = undefined;
    this.#device.queue.writeBuffer(this.#table, slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1, new Uint8Array(GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1));
  }

  private clearAllRecords(): void {
    for (let slot = 0; slot < this.#slotCapacity; slot++) {
      if (this.#records[slot] !== undefined) this.clearRecord(slot);
    }
  }

  private assertSlot(slot: number): void {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.#slotCapacity) {
      throw new RangeError(`Geometry Product table slot ${slot} is outside [0, ${this.#slotCapacity})`);
    }
  }

  private assertAlive(): void {
    if (this.#destroyed) throw new Error("Geometry Product multi-runtime is destroyed");
  }
}

function productRecord(
  descriptor: GeometryProductDescriptorV1,
  generation: number,
  flags: number
): GeometryProductTableRecordV1 {
  return Object.freeze({
    productGeneration: generation,
    flags,
    assetBegin: 0,
    assetCount: descriptor.assetRecords.byteLength / 128,
    rootBegin: 0,
    rootCount: descriptor.rootNodeIds.length,
    hierarchyBegin: 0,
    hierarchyCount: descriptor.hierarchyNodes.byteLength / 48,
    groupBegin: 0,
    groupCount: descriptor.groupDirectory.byteLength / 16,
    pageBegin: 0,
    pageCount: descriptor.pageRecords.byteLength / 32,
    vertexFormatBegin: 0,
    vertexFormatCount: descriptor.vertexFormats.byteLength / 16
  });
}

function validAssetIndex(descriptor: GeometryProductDescriptorV1, assetRecordIndex: number): boolean {
  return Number.isSafeInteger(assetRecordIndex) && assetRecordIndex >= 0 && assetRecordIndex < descriptor.assetRecords.byteLength / 128;
}

function validPageId(descriptor: GeometryProductDescriptorV1, pageId: number): boolean {
  return Number.isSafeInteger(pageId) && pageId >= 0 && pageId < descriptor.pageRecords.byteLength / 32;
}

function entryKey(slot: number, generation: number): string {
  return `${slot}:${generation}`;
}
