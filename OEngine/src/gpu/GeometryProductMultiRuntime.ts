import {
  assertGeometryProductDescriptorV1,
  type GeometryPageProductV1,
  type GeometryProductDescriptorV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import {
  GEOMETRY_PAGE_LOCATION_STRIDE,
  GEOMETRY_PAGE_LOCATION_PINNED,
  GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1,
  GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
  encodeGeometryProductGpuLocationV1,
  packGeometryProductAssetReferenceV1,
  packGeometryProductMetadataHeapHeaderV1,
  packGeometryProductTableRecordV1,
  GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1,
  type GeometryProductTableRecordV1
} from "./GeometryProductGpuAbiV1.js";
import {
  selectGeometryProductResidencyProfileV1,
  type GeometryProductResidencyProfilePlanV1
} from "./GeometryProductResidencyProfile.js";
import { reserveGeometryProductMetadataBytes } from "./GeometryProductGpuBudget.js";
import {
  VirtualGeometryResidency,
  type GeometryPageLocationV1,
  type GeometryProductGpuBindingsV1,
  type GeometryProductPageLocationSinkV1,
  type VirtualGeometryResidencyOptionsV1
} from "./VirtualGeometryResidency.js";

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
  /** First global asset-reference index consumed by GpuScene instances. */
  readonly assetReferenceBegin: number;
  readonly assetCount: number;
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
  readonly metadataBytes: number;
  readonly lastError: string | null;
}

export type GeometryProductPageCompletionResultV1 = "uploaded" | "stale" | "rejected";

interface ProductEntry {
  readonly slot: number;
  readonly generation: number;
  readonly source: GeometryProductRevisionSourceV1;
  readonly descriptor: GeometryProductDescriptorV1;
  readonly abort: AbortController;
  residency?: VirtualGeometryResidency;
  allocation?: ProductMetadataAllocation;
  state: GeometryProductShardStateV1;
  ready: Promise<VirtualGeometryResidency>;
}

interface ProductMetadataAllocation {
  readonly assetBegin: number;
  readonly assetCount: number;
  readonly rootBegin: number;
  readonly rootCount: number;
  readonly hierarchyBegin: number;
  readonly hierarchyCount: number;
  readonly groupBegin: number;
  readonly groupCount: number;
  readonly pageBegin: number;
  readonly pageCount: number;
  readonly vertexFormatBegin: number;
  readonly vertexFormatCount: number;
}

interface MultiMetadataLayout {
  readonly byteLength: number;
  readonly productTable: number;
  readonly assetReferences: number;
  readonly assetRecords: number;
  readonly rootNodeIds: number;
  readonly hierarchyNodes: number;
  readonly groupDirectory: number;
  readonly pageLocations: number;
  readonly vertexFormats: number;
  readonly assetCapacity: number;
  readonly rootCapacity: number;
  readonly hierarchyCapacity: number;
  readonly groupCapacity: number;
  readonly pageCapacity: number;
  readonly vertexFormatCapacity: number;
}

/**
 * Owns the scene-level Product table while each shard keeps its own Product
 * source and residency.  The table is intentionally independent from the
 * loader and from Scene objects: a slot can be replaced, made dormant, or
 * released without touching another shard.
 *
 * Product table records are the authoritative CPU/GPU lifecycle publication.
 * The scene metadata heap relocates immutable shard tables into fence-reclaimed
 * global ranges while each residency continues to own source and page life.
 */
export class GeometryProductMultiRuntimeV1 implements GeometryProductPageLocationSinkV1 {
  readonly #device: GPUDevice;
  readonly #residencyOptions: VirtualGeometryResidencyOptionsV1;
  readonly #profile: GeometryProductResidencyProfilePlanV1;
  readonly #slotCapacity: number;
  readonly #metadata: GPUBuffer;
  readonly #metadataLayout: MultiMetadataLayout;
  readonly #releaseMetadataReservation: () => void;
  readonly #candidates = new Map<number, ProductEntry>();
  readonly #ranges: Record<string, MetadataRanges>;
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
  #lastError: string | null = null;
  #peakActive = 0;
  #pageCursor = 0;

  constructor(
    device: GPUDevice,
    options: Readonly<{
      readonly slotCapacity?: number;
      readonly residency?: VirtualGeometryResidencyOptionsV1;
      /** Fixed scene-level metadata heap; ranges never move after publication. */
      readonly metadataBytes?: number;
    }> = {}
  ) {
    this.#device = device;
    this.#residencyOptions = options.residency ?? {};
    this.#profile = selectGeometryProductResidencyProfileV1(
      {
        maxBufferSize: Number(device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
        maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage ?? 16
      },
      this.#residencyOptions
    );
    if (!this.#profile.enabled) {
      throw new RangeError(`Geometry Product residency is unavailable: ${this.#profile.reason}`);
    }
    const slotCapacity = options.slotCapacity ?? GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1;
    if (
      !Number.isSafeInteger(slotCapacity) ||
      slotCapacity < GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1 ||
      slotCapacity >= 0xffffffff
    ) {
      throw new RangeError(
        `Geometry Product multi-runtime slotCapacity must be an integer in [${GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1}, 0xfffffffe]`
      );
    }
    this.#slotCapacity = slotCapacity;
    this.#records = new Array(slotCapacity);
    this.#usedSlots = new Uint8Array(slotCapacity);
    const tableBytes = slotCapacity * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1;
    const maxBufferSize = Number(device.limits.maxBufferSize);
    const maxStorageBinding = Number(device.limits.maxStorageBufferBindingSize);
    if (
      !Number.isFinite(maxBufferSize) ||
      !Number.isFinite(maxStorageBinding) ||
      tableBytes > maxBufferSize ||
      tableBytes > maxStorageBinding
    ) {
      throw new RangeError(
        "Geometry Product multi-runtime Product Table exceeds negotiated storage-buffer limits"
      );
    }

    const metadataBytes =
      options.metadataBytes ??
      Math.min(
        64 * 1024 * 1024,
        Number(device.limits.maxBufferSize),
        Number(device.limits.maxStorageBufferBindingSize)
      );
    if (
      !Number.isSafeInteger(metadataBytes) ||
      metadataBytes <= 0 ||
      metadataBytes > maxBufferSize ||
      metadataBytes > maxStorageBinding
    ) {
      throw new RangeError(
        "Geometry Product multi-runtime metadata heap exceeds negotiated storage-buffer limits"
      );
    }
    this.#metadataLayout = createMultiMetadataLayout(metadataBytes, slotCapacity);
    const releaseMetadataReservation = reserveGeometryProductMetadataBytes(
      device,
      this.#metadataLayout.byteLength
    );
    this.#ranges = {};
    for (const name of ["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const) {
      this.#ranges[name] = new MetadataRanges(this.#metadataLayout[`${name}Capacity`]);
    }
    let metadata: GPUBuffer | undefined;
    try {
      this.#metadata = metadata = device.createBuffer({
        label: "OEngine Geometry Product multi-runtime metadata heap V1",
        size: this.#metadataLayout.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.#releaseMetadataReservation = releaseMetadataReservation;
      device.queue.writeBuffer(
        this.#metadata,
        0,
        packGeometryProductMetadataHeapHeaderV1({
          slotsPerBank: this.#profile.slotsPerBank,
          productCount: slotCapacity,
          productCapacity: slotCapacity,
          totalWords: this.#metadataLayout.byteLength / 4,
          productTableWordOffset: this.#metadataLayout.productTable / 4,
          assetReferenceWordOffset: this.#metadataLayout.assetReferences / 4,
          assetRecordWordOffset: this.#metadataLayout.assetRecords / 4,
          rootNodeIdWordOffset: this.#metadataLayout.rootNodeIds / 4,
          hierarchyWordOffset: this.#metadataLayout.hierarchyNodes / 4,
          groupDirectoryWordOffset: this.#metadataLayout.groupDirectory / 4,
          pageLocationWordOffset: this.#metadataLayout.pageLocations / 4,
          vertexFormatWordOffset: this.#metadataLayout.vertexFormats / 4
        })
      );
    } catch (error) {
      metadata?.destroy();
      releaseMetadataReservation();
      throw error;
    }
  }

  get slotCapacity(): number {
    return this.#slotCapacity;
  }
  get metadata(): GPUBuffer {
    return this.#metadata;
  }
  get productTableByteOffset(): number {
    return this.#metadataLayout.productTable;
  }
  get tableBytes(): number {
    return this.#slotCapacity * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1;
  }

  /** Unified production binding consumed by hierarchy, raster and shading. */
  bindings(): GeometryProductGpuBindingsV1 {
    this.assertAlive();
    const active = [...this.#current.values()].find(
      (entry) => entry.state === "active" && entry.residency !== undefined
    );
    if (!active?.residency) throw new Error("Geometry Product multi-runtime has no active Product bindings");
    const banks = [0, 1, 2, 3].map((bank) => active.residency!.bank(bank));
    return Object.freeze({
      productTableSlot: active.slot,
      productGeneration: active.generation,
      pageCount: this.#pageCursor,
      metadata: this.#metadata,
      metadataByteLength: this.#metadataLayout.byteLength,
      productTableByteOffset: this.#metadataLayout.productTable,
      pageLocationByteOffset: this.#metadataLayout.pageLocations,
      productTable: this.#metadata,
      banks: Object.freeze([...banks])
    });
  }

  publishPageLocation(
    productTableSlot: number,
    productGeneration: number,
    pageId: number,
    location: GeometryPageLocationV1 | undefined
  ): void {
    this.assertAlive();
    const entry =
      this.currentEntry(productTableSlot, productGeneration) ?? this.#candidates.get(productTableSlot);
    if (entry?.generation !== productGeneration) {
      return;
    }
    const allocation = entry?.allocation;
    if (!entry || !allocation || pageId < 0 || pageId >= allocation.pageCount) return;
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.pageLocations + (allocation.pageBegin + pageId) * GEOMETRY_PAGE_LOCATION_STRIDE,
      encodeGeometryProductGpuLocationV1(location)
    );
  }

  /** Loads one independent shard. A failed shard never changes another slot. */
  async load(
    source: GeometryProductRevisionSourceV1,
    options: Readonly<{
      readonly productTableSlot?: number;
      /** Recovery preserves published instance identity and asset-reference range. */
      readonly productGeneration?: number;
      readonly assetReferenceBegin?: number;
    }> = {}
  ): Promise<GeometryProductShardHandleV1> {
    this.assertAlive();
    assertGeometryProductDescriptorV1(source.descriptor);
    const slot = options.productTableSlot ?? this.findFreeSlot();
    this.assertSlot(slot);
    if (this.slotOccupied(slot)) throw new Error(`Geometry Product table slot ${slot} is already occupied`);
    const entry = this.createEntry(slot, source, options.productGeneration, options.assetReferenceBegin);
    this.#current.set(slot, entry);
    this.#usedSlots[slot] = 1;
    try {
      const residency = await entry.ready;
      if (this.#destroyed || entry.abort.signal.aborted || this.#current.get(slot) !== entry) {
        residency.destroy();
        throw new Error("Geometry Product multi-runtime is destroyed");
      }
      this.publishActive(entry, residency);
      return this.handle(entry);
    } catch (error) {
      if (this.#current.get(slot) === entry) {
        this.#current.delete(slot);
        if (!this.slotHasRetiring(slot)) this.#usedSlots[slot] = 0;
      }
      entry.state = "failed";
      entry.residency?.destroy();
      if (!this.#retiring.has(entryKey(slot, entry.generation))) this.freeMetadata(entry);
      if (!this.#destroyed && !this.#current.has(slot)) this.clearRecord(slot);
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
    if (this.#candidates.has(productTableSlot)) {
      throw new Error("Geometry Product replacement already in progress");
    }
    const replacement = this.createEntry(productTableSlot, source);
    this.#candidates.set(productTableSlot, replacement);
    try {
      const residency = await replacement.ready;
      if (
        this.#destroyed ||
        replacement.abort.signal.aborted ||
        this.#current.get(productTableSlot) !== previous
      ) {
        residency.destroy();
        throw new Error("Geometry Product multi-runtime is destroyed");
      }
      this.#current.set(productTableSlot, replacement);
      this.publishActive(replacement, residency);
      this.#candidates.delete(productTableSlot);
      previous.residency!.deactivatePublication();
      previous.state = "retiring";
      this.#retiring.set(entryKey(previous.slot, previous.generation), previous);
      this.#replacements++;
      return this.handle(replacement);
    } catch (error) {
      this.#candidates.delete(productTableSlot);
      if (!this.#destroyed && this.#current.get(productTableSlot) === replacement) {
        this.#current.set(productTableSlot, previous);
        if (previous.state === "active") {
          this.writeRecord(
            previous.slot,
            productRecord(previous.descriptor, previous.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1)
          );
        } else {
          this.clearRecord(previous.slot);
        }
      }
      this.freeMetadata(replacement);
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
    this.writeRecord(
      entry.slot,
      productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1)
    );
  }

  /**
   * Revokes and completes page eviction for one shard. The completion token is
   * supplied by the renderer; the runtime never waits for the GPU itself.
   */
  async evictPage(identity: GeometryProductPageIdentityV1, completion?: PromiseLike<void>): Promise<boolean> {
    this.assertAlive();
    const entry = this.currentEntry(identity.productTableSlot, identity.productGeneration);
    if (!entry || entry.state !== "active") {
      this.#staleDemands++;
      return false;
    }
    const location = entry.residency!.pageLocation(identity.pageId);
    if (!location || (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) return false;
    entry.residency!.beginRetirePage(identity.pageId);
    if (entry.residency!.pageLocation(identity.pageId) !== undefined) return false;
    await (completion ?? this.#device.queue.onSubmittedWorkDone());
    entry.residency!.completeRetirePage(identity.pageId);
    this.#evictions++;
    return true;
  }

  /** Revokes a whole shard and releases it after the submission boundary. */
  async release(
    productTableSlot: number,
    productGeneration: number,
    completion?: PromiseLike<void>
  ): Promise<boolean> {
    this.assertAlive();
    const entry = this.currentEntry(productTableSlot, productGeneration);
    if (!entry) return false;
    this.clearRecord(entry.slot);
    this.#current.delete(entry.slot);
    entry.residency?.deactivatePublication();
    entry.state = "retiring";
    entry.abort.abort(new Error("Geometry Product released"));
    this.#candidates.get(entry.slot)?.abort.abort(new Error("Product released during replacement"));
    this.#retiring.set(entryKey(entry.slot, entry.generation), entry);
    await (completion ?? this.#device.queue.onSubmittedWorkDone());
    if (entry.residency === undefined) {
      await entry.ready.catch(() => undefined); // create() owns failed admission/source cleanup.
    }
    entry.residency?.destroy();
    this.freeMetadata(entry);
    entry.state = "released";
    this.#retiring.delete(entryKey(entry.slot, entry.generation));
    if (!this.#current.has(entry.slot) && !this.slotHasRetiring(entry.slot)) this.#usedSlots[entry.slot] = 0;
    this.#releases++;
    return true;
  }

  /** Finishes a replacement after its old GPU submission is safe to retire. */
  async retire(
    productTableSlot: number,
    productGeneration: number,
    completion?: PromiseLike<void>
  ): Promise<boolean> {
    this.assertAlive();
    const key = entryKey(productTableSlot, productGeneration);
    const entry = this.#retiring.get(key);
    if (!entry) return false;
    await (completion ?? this.#device.queue.onSubmittedWorkDone());
    if (entry.residency === undefined) {
      await entry.ready.catch(() => undefined); // create() owns failed admission/source cleanup.
    }
    entry.residency?.destroy();
    this.freeMetadata(entry);
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
    if (
      !entry ||
      entry.state !== "active" ||
      identity.pageId !== page.pageId ||
      !validPageId(entry.descriptor, identity.pageId)
    ) {
      this.#staleCompletions++;
      return "stale";
    }
    try {
      entry.residency!.uploadPage(page);
    } catch (error) {
      this.#lastError = String(error);
      this.#rejectedCompletions++;
      return "rejected";
    }
    this.#acceptedCompletions++;
    return "uploaded";
  }

  /** Product-local instance identity used by the GPU instance publication. */
  instanceIdentity(
    productTableSlot: number,
    productGeneration: number,
    assetRecordIndex: number
  ): GeometryProductInstanceIdentityV1 | undefined {
    const entry = this.currentEntry(productTableSlot, productGeneration);
    if (!entry || entry.state !== "active" || !validAssetIndex(entry.descriptor, assetRecordIndex))
      return undefined;
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
    let active = 0,
      loading = 0,
      dormant = 0,
      failed = 0;
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
      retiring:
        this.#retiring.size +
        [...this.#current.values()].filter((entry) => entry.state === "retiring").length,
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
      tableBytes: this.tableBytes,
      metadataBytes: this.#metadataLayout.byteLength,
      lastError: this.#lastError
    });
  }

  /** Transfers every active source after loss; no live-device retirement shortcut. */
  checkpointForDeviceLoss() {
    this.assertAlive();
    const products = [...this.#current.values()]
      .filter((entry) => entry.state === "active" || entry.state === "dormant")
      .map((entry) => ({
        source: entry.source,
        productTableSlot: entry.slot,
        productGeneration: entry.generation,
        assetReferenceBegin: entry.allocation!.assetBegin,
        dormant: entry.state === "dormant"
      }));
    for (const entry of this.#current.values()) {
      if (entry.state === "active" || entry.state === "dormant") {
        entry.residency!.abandonForDeviceLoss();
      }
    }
    const checkpoint = {
      products,
      options: {
        slotCapacity: this.#slotCapacity,
        metadataBytes: this.#metadataLayout.byteLength,
        residency: { ...this.#residencyOptions, configuredCapacityBytes: this.#profile.capacityBytes }
      }
    };
    this.destroy();
    return checkpoint;
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
    for (const entry of this.#candidates.values()) {
      entry.abort.abort(new Error("Geometry Product runtime destroyed"));
      entry.residency?.destroy();
    }
    this.#candidates.clear();
    this.#current.clear();
    this.#retiring.clear();
    this.#metadata.destroy();
    this.#releaseMetadataReservation();
  }

  private createEntry(
    slot: number,
    source: GeometryProductRevisionSourceV1,
    preservedGeneration?: number,
    assetReferenceBegin?: number
  ): ProductEntry {
    const generation = preservedGeneration ?? this.allocateGeneration();
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      generation >= 0xffffffff ||
      [...this.#current.values(), ...this.#retiring.values(), ...this.#candidates.values()].some(
        (entry) => entry.generation === generation
      )
    ) {
      throw new RangeError("Geometry Product generation is invalid or already owned");
    }
    this.#nextGeneration = generation >= 0xfffffffe ? 1 : Math.max(this.#nextGeneration, generation + 1);
    const abort = new AbortController();
    const entry: ProductEntry = {
      slot,
      generation,
      source,
      allocation: this.allocateMetadata(source.descriptor, assetReferenceBegin),
      descriptor: source.descriptor,
      abort,
      state: "loading",
      ready: Promise.resolve(undefined as never)
    };
    entry.ready = VirtualGeometryResidency.create(this.#device, source, generation, slot, abort.signal, {
      ...this.#residencyOptions,
      directory: this
    }).then(
      (residency) => {
        entry.residency = residency;
        return residency;
      },
      (error) => {
        entry.state = "failed";
        throw error;
      }
    );
    return entry;
  }

  private publishActive(entry: ProductEntry, residency: VirtualGeometryResidency): void {
    entry.allocation = entry.allocation ?? this.allocateMetadata(entry.descriptor);
    this.publishStaticMetadata(entry, entry.allocation);
    residency.attachPageLocationSink(this);
    residency.activatePublication();
    entry.state = "active";
    this.writeRecord(
      entry.slot,
      productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1)
    );
    this.#peakActive = Math.max(
      this.#peakActive,
      [...this.#current.values()].filter((candidate) => candidate.state === "active").length
    );
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
    if (!entry.residency || !entry.allocation)
      throw new Error("Geometry Product shard has no residency or metadata allocation");
    return Object.freeze({
      productTableSlot: entry.slot,
      productGeneration: entry.generation,
      descriptor: entry.descriptor,
      residency: entry.residency,
      assetReferenceBegin: entry.allocation.assetBegin,
      assetCount: entry.allocation.assetCount,
      get state() {
        return entry.state;
      }
    });
  }

  private allocateMetadata(
    descriptor: GeometryProductDescriptorV1,
    assetReferenceBegin?: number
  ): ProductMetadataAllocation {
    const counts = descriptorCounts(descriptor);
    const names = ["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const;
    const sizes = [
      counts.assets,
      counts.roots,
      counts.hierarchy,
      counts.groups,
      counts.pages,
      counts.formats
    ];
    const values: Record<string, number> = {};
    let allocated = 0;
    try {
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        values[`${name}Begin`] =
          name === "asset" && assetReferenceBegin !== undefined
            ? this.#ranges[name]!.reserve(assetReferenceBegin, sizes[index]!)
            : this.#ranges[name]!.allocate(sizes[index]!);
        values[`${name}Count`] = sizes[index]!;
        allocated++;
      }
    } catch (error) {
      for (let index = 0; index < allocated; index++) {
        const name = names[index]!;
        this.#ranges[name]!.release(values[`${name}Begin`]!, sizes[index]!);
      }
      throw error;
    }
    this.#pageCursor = Math.max(this.#pageCursor, values.pageBegin! + values.pageCount!);
    return Object.freeze(values) as unknown as ProductMetadataAllocation;
  }

  private freeMetadata(entry: ProductEntry): void {
    const allocation = entry.allocation;
    if (allocation === undefined) return;
    for (const name of ["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const) {
      this.#ranges[name]!.release(allocation[`${name}Begin`], allocation[`${name}Count`]);
    }
    entry.allocation = undefined;
  }

  private publishStaticMetadata(entry: ProductEntry, allocation: ProductMetadataAllocation): void {
    const descriptor = entry.descriptor;
    const assetRecords = relocateAssetRecords(descriptor.assetRecords, allocation);
    const roots = relocateRoots(descriptor.rootNodeIds, allocation.hierarchyBegin);
    const hierarchy = relocateHierarchy(descriptor.hierarchyNodes, allocation);
    const groups = copyBytes(descriptor.groupDirectory);
    const refs = new Uint8Array(allocation.assetCount * 16);
    for (let asset = 0; asset < allocation.assetCount; asset++)
      refs.set(
        packGeometryProductAssetReferenceV1({
          productTableSlot: entry.slot,
          productGeneration: entry.generation,
          assetRecordIndex: asset,
          flags: 0
        }),
        asset * 16
      );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.assetReferences + allocation.assetBegin * 16,
      refs
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.assetRecords + allocation.assetBegin * 128,
      assetRecords
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.rootNodeIds + allocation.rootBegin * 4,
      roots
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.hierarchyNodes + allocation.hierarchyBegin * 48,
      hierarchy
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.groupDirectory + allocation.groupBegin * 16,
      groups
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.vertexFormats + allocation.vertexFormatBegin * 16,
      copyBytes(descriptor.vertexFormats)
    );
  }

  private findFreeSlot(): number {
    for (let slot = 0; slot < this.#slotCapacity; slot++) if (!this.slotOccupied(slot)) return slot;
    throw new RangeError(
      `Geometry Product multi-runtime has no free ProductTableSlot (capacity ${this.#slotCapacity})`
    );
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
    const allocation = this.#current.get(slot)?.allocation;
    const published =
      allocation === undefined
        ? record
        : Object.freeze({
            ...record,
            assetBegin: allocation.assetBegin,
            rootBegin: allocation.rootBegin,
            hierarchyBegin: allocation.hierarchyBegin,
            groupBegin: allocation.groupBegin,
            pageBegin: allocation.pageBegin,
            vertexFormatBegin: allocation.vertexFormatBegin
          });
    this.#records[slot] = Object.freeze({ ...published });
    const bytes = packGeometryProductTableRecordV1(published);
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.productTable + slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
      bytes
    );
  }

  private clearRecord(slot: number): void {
    this.#records[slot] = undefined;
    const bytes = new Uint8Array(GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1);
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.productTable + slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
      bytes
    );
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
  return (
    Number.isSafeInteger(assetRecordIndex) &&
    assetRecordIndex >= 0 &&
    assetRecordIndex < descriptor.assetRecords.byteLength / 128
  );
}

function validPageId(descriptor: GeometryProductDescriptorV1, pageId: number): boolean {
  return Number.isSafeInteger(pageId) && pageId >= 0 && pageId < descriptor.pageRecords.byteLength / 32;
}

function entryKey(slot: number, generation: number): string {
  return `${slot}:${generation}`;
}

function descriptorCounts(descriptor: GeometryProductDescriptorV1): Readonly<{
  assets: number;
  roots: number;
  hierarchy: number;
  groups: number;
  pages: number;
  formats: number;
}> {
  return Object.freeze({
    assets: descriptor.assetRecords.byteLength / 128,
    roots: descriptor.rootNodeIds.length,
    hierarchy: descriptor.hierarchyNodes.byteLength / 48,
    groups: descriptor.groupDirectory.byteLength / 16,
    pages: descriptor.pageRecords.byteLength / 32,
    formats: descriptor.vertexFormats.byteLength / 16
  });
}

/**
 * Builds a fixed scene heap. Ranges remain stable until their last consumer
 * fence, then become reusable without moving live instances/bind groups.
 * The split favors hierarchy, group and page tables; callers may request a
 * larger heap when the formal workload needs a different absolute capacity.
 */
function createMultiMetadataLayout(byteLength: number, slotCapacity: number): MultiMetadataLayout {
  const alignedBytes = alignDown16(byteLength);
  const productTable = 64;
  const afterTable = align16(productTable + slotCapacity * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1);
  if (alignedBytes <= afterTable + 1024) {
    throw new RangeError("Geometry Product multi-runtime metadata heap is too small");
  }
  const available = alignedBytes - afterTable;
  const assetCapacity = Math.max(1, Math.floor((available * 0.02) / (16 + 128)));
  const rootCapacity = Math.max(1, Math.floor((available * 0.02) / 4));
  const hierarchyCapacity = Math.max(1, Math.floor((available * 0.55) / 48));
  const groupCapacity = Math.max(1, Math.floor((available * 0.18) / 16));
  const pageCapacity = Math.max(1, Math.floor((available * 0.22) / 16));
  const assetReferences = afterTable;
  const assetRecords = align16(assetReferences + assetCapacity * 16);
  const rootNodeIds = align16(assetRecords + assetCapacity * 128);
  const hierarchyNodes = align16(rootNodeIds + rootCapacity * 4);
  const groupDirectory = align16(hierarchyNodes + hierarchyCapacity * 48);
  const pageLocations = align16(groupDirectory + groupCapacity * 16);
  const vertexFormats = align16(pageLocations + pageCapacity * 16);
  const vertexFormatCapacity = Math.floor((alignedBytes - vertexFormats) / 16);
  if (vertexFormatCapacity < 1) {
    throw new RangeError("Geometry Product multi-runtime metadata heap has no vertex-format capacity");
  }
  return Object.freeze({
    byteLength: alignedBytes,
    productTable,
    assetReferences,
    assetRecords,
    rootNodeIds,
    hierarchyNodes,
    groupDirectory,
    pageLocations,
    vertexFormats,
    assetCapacity,
    rootCapacity,
    hierarchyCapacity,
    groupCapacity,
    pageCapacity,
    vertexFormatCapacity
  });
}

function relocateAssetRecords(
  source: Uint8Array,
  allocation: ProductMetadataAllocation
): Uint8Array<ArrayBuffer> {
  const bytes = copyBytes(source);
  const view = new DataView(bytes.buffer);
  for (let asset = 0; asset < allocation.assetCount; asset++) {
    const at = asset * 128;
    addU32(view, at + 72, allocation.rootBegin, "asset root range");
    addU32(view, at + 80, allocation.hierarchyBegin, "asset hierarchy range");
    addU32(view, at + 88, allocation.groupBegin, "asset group range");
  }
  return bytes;
}

function relocateRoots(source: Uint32Array, hierarchyBegin: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(source.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < source.length; index++) {
    const value = source[index]! + hierarchyBegin;
    if (!Number.isSafeInteger(value) || value > 0xffffffff)
      throw new RangeError("Geometry Product root relocation overflows u32");
    view.setUint32(index * 4, value, true);
  }
  return bytes;
}

function relocateHierarchy(
  source: Uint8Array,
  allocation: ProductMetadataAllocation
): Uint8Array<ArrayBuffer> {
  const bytes = copyBytes(source);
  const view = new DataView(bytes.buffer);
  for (let node = 0; node < allocation.hierarchyCount; node++) {
    const at = node * 48 + 44;
    const packed = view.getUint32(at, true);
    if ((packed & 1) !== 0) {
      const localGroup = (packed >>> 1) & 0x00ffffff;
      const globalGroup = localGroup + allocation.groupBegin;
      if (!Number.isSafeInteger(globalGroup) || globalGroup > 0x00ffffff) {
        throw new RangeError("Geometry Product group relocation exceeds the hierarchy leaf ABI");
      }
      view.setUint32(at, ((packed & 0xfe000000) | (globalGroup << 1) | 1) >>> 0, true);
    } else {
      const localChild = (packed >>> 1) & 0x07ffffff;
      const globalChild = localChild + allocation.hierarchyBegin;
      if (!Number.isSafeInteger(globalChild) || globalChild > 0x07ffffff) {
        throw new RangeError("Geometry Product child relocation exceeds the hierarchy interior ABI");
      }
      view.setUint32(at, ((packed & 0xf0000000) | (globalChild << 1)) >>> 0, true);
    }
  }
  return bytes;
}

function addU32(view: DataView, byteOffset: number, delta: number, label: string): void {
  const value = view.getUint32(byteOffset, true) + delta;
  if (!Number.isSafeInteger(value) || value > 0xffffffff)
    throw new RangeError(`Geometry Product ${label} relocation overflows u32`);
  view.setUint32(byteOffset, value, true);
}

function copyBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

function align16(value: number): number {
  const result = Math.ceil(value / 16) * 16;
  if (!Number.isSafeInteger(result)) throw new RangeError("Geometry Product metadata heap size overflow");
  return result;
}

function alignDown16(value: number): number {
  const result = Math.floor(value / 16) * 16;
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new RangeError("Geometry Product metadata heap size is invalid");
  return result;
}

/** Small CPU free-range list. Published ranges never move; callers free after fences. */
class MetadataRanges {
  readonly #free: Array<{ begin: number; count: number }>;
  constructor(capacity: number) {
    this.#free = [{ begin: 0, count: capacity }];
  }
  allocate(count: number): number {
    if (count === 0) return 0;
    for (let index = 0; index < this.#free.length; index++) {
      const range = this.#free[index]!;
      if (range.count < count) continue;
      const begin = range.begin;
      range.begin += count;
      range.count -= count;
      if (range.count === 0) this.#free.splice(index, 1);
      return begin;
    }
    throw new RangeError("Geometry Product metadata section capacity is exhausted");
  }
  reserve(begin: number, count: number): number {
    for (let index = 0; index < this.#free.length; index++) {
      const range = this.#free[index]!;
      if (begin < range.begin || begin + count > range.begin + range.count) continue;
      const suffix = range.begin + range.count - begin - count;
      const prefix = begin - range.begin;
      this.#free.splice(index, 1);
      if (suffix > 0) this.#free.splice(index, 0, { begin: begin + count, count: suffix });
      if (prefix > 0) this.#free.splice(index, 0, { begin: range.begin, count: prefix });
      return begin;
    }
    throw new RangeError("Recovered Product asset-reference range is unavailable");
  }
  release(begin: number, count: number): void {
    if (count === 0) return;
    const index = this.#free.findIndex((range) => range.begin > begin);
    this.#free.splice(index < 0 ? this.#free.length : index, 0, { begin, count });
    for (let at = 1; at < this.#free.length; ) {
      const previous = this.#free[at - 1]!;
      const current = this.#free[at]!;
      if (previous.begin + previous.count === current.begin) {
        previous.count += current.count;
        this.#free.splice(at, 1);
      } else {
        at++;
      }
    }
  }
}
