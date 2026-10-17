import { GeometryProductBytePool } from "./GeometryProductBytePool.js";
import {
  validateGeometryProductQuerySection,
  verifyGeometryProductQueryContent,
} from "../assets/geometry-product/GeometryProductQuerySection.js";
import {
  GEOMETRY_METADATA_SECTIONS,
  geometryMetadataCounts,
  geometryMetadataLayout,
  planGeometryProductCapacity,
  type GeometryMetadataCapacities,
  type GeometryMetadataLayout,
} from "./GeometryProductCapacity.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  assertGeometryProductDescriptorV1,
  snapshotGeometryProductSourceV1,
  type GeometryPageProductV1,
  type GeometryProductDescriptorV1,
  type GeometryProductRevisionSourceV1,
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
  type GeometryProductTableRecordV1,
} from "./GeometryProductGpuAbiV1.js";
import {
  selectGeometryProductResidencyProfileV1,
  type GeometryProductResidencyProfilePlanV1,
} from "./GeometryProductResidencyProfile.js";
import { reserveGeometryProductMetadataBytes } from "./GeometryProductGpuBudget.js";
import {
  VirtualGeometryResidency,
  type GeometryPageLocationV1,
  type GeometryProductGpuBindingsV1,
  type GeometryProductPageLocationSinkV1,
  type VirtualGeometryResidencyOptionsV1,
} from "./VirtualGeometryResidency.js";

/** Phase E logical multi-Product table and lifecycle ABI version. */
export const GEOMETRY_PRODUCT_MULTI_RUNTIME_ABI_VERSION_V1 = 1;
/** ADR-0018's first promoted scale gate. */
export const GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1 = 1;

export type GeometryProductShardStateV1 =
  "loading" | "active" | "dormant" | "retiring" | "released" | "failed";

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
  readonly capacityPending: boolean;
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
  readonly metadataSections: Readonly<
    Record<
      string,
      Readonly<{
        usedRecords: number;
        capacityRecords: number;
        usedBytes: number;
      }>
    >
  >;
  readonly lastError: string | null;
}

export type GeometryProductPageStageResultV1 = "staged" | "stale" | "rejected";

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

type MultiMetadataLayout = GeometryMetadataLayout;

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
  #slotCapacity: number;
  #metadata: GPUBuffer;
  #metadataLayout: MultiMetadataLayout;
  #releaseMetadataReservation: () => void;
  readonly #candidates = new Map<number, ProductEntry>();
  readonly #ranges: Record<string, MetadataRanges>;
  readonly #current = new Map<number, ProductEntry>();
  readonly #retiring = new Map<string, ProductEntry>();
  readonly #records: Array<GeometryProductTableRecordV1 | undefined>;
  #usedSlots: Uint8Array;
  readonly #pool: GeometryProductBytePool;
  readonly #removePoolListener: () => void;
  readonly #metadataLimit: number;
  #metadataEpoch = 0;
  #metadataSerial = 0;
  #bankHeaderBytes = 0;
  #growthRequest?: { layout: MultiMetadataLayout; slots: number };
  #metadataCandidate?: {
    command: ShadeGPUCommandContext;
    buffer: GPUBuffer;
    layout: MultiMetadataLayout;
    slots: number;
    epoch: number;
    release: () => void;
  };
  readonly #retiredMetadata = new Set<() => void>();
  #capacityWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
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
  #bindingsExposed = false;
  #admissionTail: Promise<unknown> = Promise.resolve();

  constructor(
    device: GPUDevice,
    options: Readonly<{
      readonly slotCapacity?: number;
      readonly residency?: VirtualGeometryResidencyOptionsV1;
      /** Capacity ceiling; section growth preserves published record indices. */
      readonly metadataBytes?: number;
      readonly descriptors?: readonly GeometryProductDescriptorV1[];
      readonly metadataCapacities?: GeometryMetadataCapacities;
    }> = {},
  ) {
    this.#device = device;
    const limits = {
      maxBufferSize: Number(device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
      maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage ?? 16,
    };
    const planned = planGeometryProductCapacity(options.descriptors ?? [], limits, options.residency);
    this.#residencyOptions = { ...planned.residency, ...options.residency };
    this.#metadataLimit = Math.min(
      options.metadataBytes ?? 256 * 1024 * 1024,
      limits.maxBufferSize,
      limits.maxStorageBufferBindingSize,
    );
    this.#profile = selectGeometryProductResidencyProfileV1(
      {
        maxBufferSize: Number(device.limits.maxBufferSize),
        maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
        maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage ?? 16,
      },
      this.#residencyOptions,
    );
    if (!this.#profile.enabled) {
      throw new RangeError(`Geometry Product residency is unavailable: ${this.#profile.reason}`);
    }
    const slotCapacity = options.slotCapacity ?? planned.slotCapacity;
    if (
      !Number.isSafeInteger(slotCapacity) ||
      slotCapacity < GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1 ||
      slotCapacity >= 0xffffffff
    ) {
      throw new RangeError(
        `Geometry Product multi-runtime slotCapacity must be an integer in [${GEOMETRY_PRODUCT_MULTI_RUNTIME_MIN_CAPACITY_V1}, 0xfffffffe]`,
      );
    }
    this.#slotCapacity = slotCapacity;
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
        "Geometry Product multi-runtime Product Table exceeds negotiated storage-buffer limits",
      );
    }

    this.#records = new Array(slotCapacity);
    this.#usedSlots = new Uint8Array(slotCapacity);

    this.#metadataLayout = geometryMetadataLayout(
      options.metadataCapacities ?? planned.metadata,
      slotCapacity,
    );
    if (this.#metadataLayout.byteLength > this.#metadataLimit) {
      throw new RangeError("Geometry planned metadata exceeds its configured/device budget");
    }
    const releaseMetadataReservation = reserveGeometryProductMetadataBytes(
      device,
      this.#metadataLayout.byteLength,
    );
    this.#ranges = {};
    for (const name of ["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const) {
      this.#ranges[name] = new MetadataRanges(this.#metadataLayout[name]);
    }
    let metadata: GPUBuffer | undefined;
    try {
      this.#metadata = metadata = device.createBuffer({
        label: "OEngine Geometry Product multi-runtime metadata heap V1",
        size: this.#metadataLayout.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      this.#releaseMetadataReservation = releaseMetadataReservation;
      device.queue.writeBuffer(
        this.#metadata,
        0,
        packGeometryProductMetadataHeapHeaderV1({
          bankByteCapacity: this.#profile.initialBankBytes,
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
          vertexFormatWordOffset: this.#metadataLayout.vertexFormats / 4,
        }),
      );
    } catch (error) {
      metadata?.destroy();
      releaseMetadataReservation();
      throw error;
    }
    try {
      this.#pool = GeometryProductBytePool.retain(device, this.#profile);
      this.#bankHeaderBytes = this.#pool.bankBytes;
      device.queue.writeBuffer(this.#metadata, 48, new Uint32Array([this.#pool.bankBytes]));
      this.#removePoolListener = this.#pool.onBindings((command, bankBytes) =>
        this.prepareMetadataFrame(command, bankBytes),
      );
    } catch (error) {
      this.#metadata.destroy();
      this.#releaseMetadataReservation();
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
    this.#bindingsExposed = true;
    this.#pool.exposeBindings();
    if (!this.#pool.frozen && this.#bankHeaderBytes !== this.#pool.bankBytes) {
      this.#bankHeaderBytes = this.#pool.bankBytes;
      this.#device.queue.writeBuffer(this.#metadata, 48, new Uint32Array([this.#bankHeaderBytes]));
    }
    const active = [...this.#current.values()].find(
      (entry) => entry.state === "active" && entry.residency !== undefined,
    );
    if (!active?.residency) throw new Error("Geometry Product multi-runtime has no active Product bindings");
    const owner = this;
    return Object.freeze({
      productTableSlot: active.slot,
      productGeneration: active.generation,
      get pageCount() {
        return owner.#pageCursor;
      },
      get metadata() {
        return owner.#metadataCandidate?.buffer ?? owner.#metadata;
      },
      get metadataByteLength() {
        return (owner.#metadataCandidate?.layout ?? owner.#metadataLayout).byteLength;
      },
      get productTableByteOffset() {
        return (owner.#metadataCandidate?.layout ?? owner.#metadataLayout).productTable;
      },
      get pageLocationByteOffset() {
        return (owner.#metadataCandidate?.layout ?? owner.#metadataLayout).pageLocations;
      },
      get productTable() {
        return owner.#metadataCandidate?.buffer ?? owner.#metadata;
      },
      get banks() {
        return owner.#pool.banks;
      },
      get bindingEpoch() {
        return owner.#pool.bindingEpoch + "/" + (owner.#metadataCandidate?.epoch ?? owner.#metadataEpoch);
      },
    });
  }

  pageLocationAddress(
    productTableSlot: number,
    productGeneration: number,
    pageId: number,
  ): { readonly buffer: GPUBuffer; readonly byteOffset: number } | undefined {
    this.assertAlive();
    const entry =
      this.currentEntry(productTableSlot, productGeneration) ?? this.#candidates.get(productTableSlot);
    if (entry?.generation !== productGeneration) {
      return undefined;
    }
    const allocation = entry?.allocation;
    if (!entry || !allocation || pageId < 0 || pageId >= allocation.pageCount) return undefined;
    return Object.freeze({
      buffer: this.#metadataCandidate?.buffer ?? this.#metadata,
      byteOffset:
        (this.#metadataCandidate?.layout ?? this.#metadataLayout).pageLocations +
        (allocation.pageBegin + pageId) * GEOMETRY_PAGE_LOCATION_STRIDE,
    });
  }

  publishPageLocation(
    productTableSlot: number,
    productGeneration: number,
    pageId: number,
    location: GeometryPageLocationV1 | undefined,
  ): void {
    this.assertAlive();
    this.assertMetadataWritable();
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
      encodeGeometryProductGpuLocationV1(location),
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
    }> = {},
  ): Promise<GeometryProductShardHandleV1> {
    return this.loadSource(source, options);
  }

  private async loadSource(
    source: GeometryProductRevisionSourceV1,
    options: Readonly<{
      productTableSlot?: number;
      productGeneration?: number;
      assetReferenceBegin?: number;
    }>,
  ): Promise<GeometryProductShardHandleV1> {
    try {
      source = snapshotGeometryProductSourceV1(source);
    } catch (error) {
      source.release();
      throw error;
    }
    const admission = this.#admissionTail.then(async () => {
      this.assertAlive();
      assertGeometryProductDescriptorV1(source.descriptor);
      await verifyGeometryProductQueryContent(validateGeometryProductQuerySection(source.descriptor));
      this.assertAlive();
      const slot = options.productTableSlot ?? this.nextAvailableSlot();
      if (slot < this.#slotCapacity && this.slotOccupied(slot)) {
        throw new Error(`Geometry Product table slot ${slot} is already occupied`);
      }
      await this.ensureCapacity(source.descriptor, slot + 1, options.assetReferenceBegin);
      this.assertAlive();
      this.assertSlot(slot);
      if (this.slotOccupied(slot)) {
        throw new Error(`Geometry Product table slot ${slot} is already occupied`);
      }
      const entry = this.createEntry(slot, source, options.productGeneration, options.assetReferenceBegin);
      this.#current.set(slot, entry);
      this.#usedSlots[slot] = 1;
      return entry;
    });
    this.#admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    let entry: ProductEntry;
    try {
      entry = await admission;
    } catch (error) {
      // No residency exists until createEntry transfers source ownership.
      source.release();
      throw error;
    }
    const slot = entry.slot;
    try {
      const residency = await entry.ready;
      await this.waitForWritableMetadata();
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
    source: GeometryProductRevisionSourceV1,
  ): Promise<GeometryProductShardHandleV1> {
    return this.replaceSource(productTableSlot, source);
  }

  private async replaceSource(
    productTableSlot: number,
    source: GeometryProductRevisionSourceV1,
  ): Promise<GeometryProductShardHandleV1> {
    try {
      source = snapshotGeometryProductSourceV1(source);
    } catch (error) {
      source.release();
      throw error;
    }
    const admission = this.#admissionTail.then(async () => {
      this.assertAlive();
      this.assertSlot(productTableSlot);
      const previous = this.#current.get(productTableSlot);
      if (!previous || (previous.state !== "active" && previous.state !== "dormant")) {
        throw new Error(`Geometry Product table slot ${productTableSlot} has no replaceable active shard`);
      }
      assertGeometryProductDescriptorV1(source.descriptor);
      await verifyGeometryProductQueryContent(validateGeometryProductQuerySection(source.descriptor));
      this.assertAlive();
      if (this.#candidates.has(productTableSlot)) {
        throw new Error("Geometry Product replacement already in progress");
      }
      await this.ensureCapacity(source.descriptor, this.#slotCapacity);
      this.assertAlive();
      if (this.#current.get(productTableSlot) !== previous || this.#candidates.has(productTableSlot)) {
        throw new Error("Geometry replacement changed while waiting for capacity");
      }
      const replacement = this.createEntry(productTableSlot, source);
      this.#candidates.set(productTableSlot, replacement);
      return { previous, replacement };
    });
    this.#admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    let candidate: { previous: ProductEntry; replacement: ProductEntry };
    try {
      candidate = await admission;
    } catch (error) {
      source.release();
      throw error;
    }
    const { previous, replacement } = candidate;
    try {
      const residency = await replacement.ready;
      await this.waitForWritableMetadata();
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
            productRecord(previous.descriptor, previous.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1),
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
    this.abortCapacityFrame();
    this.assertMetadataWritable();
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
      productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1),
    );
  }

  /**
   * Requests a page eviction. Its residency encodes the revocation in the next
   * ordinary frame and retains the slot through that command's successful fence.
   */
  evictPage(identity: GeometryProductPageIdentityV1): boolean {
    this.assertAlive();
    const entry = this.currentEntry(identity.productTableSlot, identity.productGeneration);
    if (!entry || entry.state !== "active") {
      this.#staleDemands++;
      return false;
    }
    const location = entry.residency!.pageLocation(identity.pageId);
    if (!location || (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) return false;
    entry.residency!.beginRetirePage(identity.pageId);
    this.#evictions++;
    return true;
  }

  /** Revokes a whole shard and releases it after the submission boundary. */
  async release(
    productTableSlot: number,
    productGeneration: number,
    completion?: PromiseLike<void>,
  ): Promise<boolean> {
    this.assertAlive();
    this.abortCapacityFrame();
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
    completion?: PromiseLike<void>,
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
   * Stages a verified page into a hidden slot only when the exact current
   * generation owns the identity. The address is published by the next frame
   * transaction, so a stale completion never consumes a visible mapping.
   */
  stagePage(
    identity: GeometryProductPageIdentityV1,
    page: GeometryPageProductV1,
  ): GeometryProductPageStageResultV1 {
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
      entry.residency!.stagePage(page);
    } catch (error) {
      this.#lastError = String(error);
      this.#rejectedCompletions++;
      return "rejected";
    }
    this.#acceptedCompletions++;
    return "staged";
  }

  /** Product-local instance identity used by the GPU instance publication. */
  instanceIdentity(
    productTableSlot: number,
    productGeneration: number,
    assetRecordIndex: number,
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
  assetReferenceBegin(productTableSlot: number, productGeneration: number): number {
    const record = this.tableRecord(productTableSlot);
    if (record?.productGeneration !== productGeneration) {
      throw new Error("Geometry asset range no longer belongs to the requested Product generation");
    }
    return record.assetBegin;
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
      capacityPending: this.#growthRequest !== undefined || this.#metadataCandidate !== undefined,
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
      metadataSections: Object.freeze(
        Object.fromEntries(
          (["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const).map((name) => {
            const capacityRecords = this.#metadataLayout[name];
            const usedRecords = capacityRecords - this.#ranges[name]!.availableRecords;
            const stride = { asset: 144, root: 4, hierarchy: 48, group: 16, page: 16, vertexFormat: 16 }[
              name
            ];
            return [name, Object.freeze({ usedRecords, capacityRecords, usedBytes: usedRecords * stride })];
          }),
        ),
      ),
      lastError: this.#lastError,
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
        dormant: entry.state === "dormant",
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
        metadataBytes: this.#metadataLimit,
        metadataCapacities: { ...this.#metadataLayout },
        residency: { ...this.#residencyOptions, configuredCapacityBytes: this.#profile.capacityBytes },
      },
    };
    this.destroy();
    return checkpoint;
  }

  /** Synchronous teardown used by Renderer destruction; no GPU await is needed. */
  destroy(): void {
    if (this.#destroyed) return;
    this.abortCapacityFrame();
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
    this.#removePoolListener();
    this.#pool.releaseOwner();
    for (const release of this.#retiredMetadata) {
      release();
    }
    this.#retiredMetadata.clear();
    this.settleCapacity(new Error("Geometry metadata destroyed"));
  }

  private createEntry(
    slot: number,
    source: GeometryProductRevisionSourceV1,
    preservedGeneration?: number,
    assetReferenceBegin?: number,
  ): ProductEntry {
    const generation = preservedGeneration ?? this.allocateGeneration();
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      generation >= 0xffffffff ||
      [...this.#current.values(), ...this.#retiring.values(), ...this.#candidates.values()].some(
        (entry) => entry.generation === generation,
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
      ready: Promise.resolve(undefined as never),
    };
    entry.ready = VirtualGeometryResidency.create(this.#device, source, generation, slot, abort.signal, {
      ...this.#residencyOptions,
      directory: this,
    }).then(
      (residency) => {
        entry.residency = residency;
        return residency;
      },
      (error) => {
        entry.state = "failed";
        throw error;
      },
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
      productRecord(entry.descriptor, entry.generation, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1),
    );
    this.#peakActive = Math.max(
      this.#peakActive,
      [...this.#current.values()].filter((candidate) => candidate.state === "active").length,
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
      },
    });
  }

  private nextAvailableSlot(): number {
    for (let slot = 0; slot < this.#slotCapacity; slot++) {
      if (!this.slotOccupied(slot)) {
        return slot;
      }
    }
    return this.#slotCapacity;
  }

  private async ensureCapacity(
    descriptor: GeometryProductDescriptorV1,
    products: number,
    assetReferenceBegin?: number,
  ): Promise<void> {
    if (
      assetReferenceBegin !== undefined &&
      (!Number.isSafeInteger(assetReferenceBegin) ||
        assetReferenceBegin < 0 ||
        assetReferenceBegin > 0xffffffff)
    ) {
      throw new RangeError("Geometry recovered asset-reference begin is invalid");
    }
    const counts = geometryMetadataCounts(descriptor);
    for (;;) {
      this.assertAlive();
      if (this.#metadataCandidate !== undefined) {
        await this.waitForCapacity();
        continue;
      }
      if (this.#pool.frozen) {
        await this.#pool.waitForGrowth();
        continue;
      }
      const capacity = { ...this.#metadataLayout };
      let needsGrowth = products > this.#slotCapacity;
      for (const name of GEOMETRY_METADATA_SECTIONS) {
        const ranges = this.#ranges[name]!;
        const fixedBegin = name === "asset" ? assetReferenceBegin : undefined;
        if (!ranges.canAllocate(counts[name], fixedBegin)) {
          const neededEnd =
            fixedBegin === undefined ? this.#metadataLayout[name] + counts[name] : fixedBegin + counts[name];
          capacity[name] = Math.max(
            neededEnd,
            Math.ceil(counts[name] * 2.25),
            Math.ceil(this.#metadataLayout[name] * 1.5),
          );
          needsGrowth = true;
        }
      }
      if (!needsGrowth) {
        return;
      }
      const slots =
        products > this.#slotCapacity
          ? Math.max(products, Math.ceil(this.#slotCapacity * 1.5))
          : this.#slotCapacity;
      const existing = this.#growthRequest;
      if (existing !== undefined) {
        for (const name of GEOMETRY_METADATA_SECTIONS) {
          capacity[name] = Math.max(capacity[name], existing.layout[name]);
        }
      }
      const requestedSlots = Math.max(slots, existing?.slots ?? 0);
      const layout = geometryMetadataLayout(capacity, requestedSlots);
      if (layout.byteLength > this.#metadataLimit) {
        throw new RangeError("Geometry metadata admission exceeds its capacity budget");
      }
      if (!this.#bindingsExposed && this.#retiring.size === 0 && this.#candidates.size === 0) {
        // Before the first binding escapes, reconstruct metadata from authoritative CPU records.
        const next = this.createMetadataBuffer(layout);
        const previous = this.#metadata;
        const release = this.#releaseMetadataReservation;
        this.applyMetadataCapacity(layout, requestedSlots);
        this.#metadata = next.buffer;
        this.#releaseMetadataReservation = next.release;
        this.#metadataEpoch = ++this.#metadataSerial;
        this.#device.queue.writeBuffer(
          next.buffer,
          0,
          this.metadataHeader(layout, requestedSlots, this.#pool.bankBytes),
        );
        for (const entry of this.#current.values()) {
          if (entry.allocation !== undefined) {
            this.publishStaticMetadata(entry, entry.allocation);
            for (let page = 0; page < entry.allocation.pageCount; page++) {
              this.publishPageLocation(
                entry.slot,
                entry.generation,
                page,
                entry.residency?.pageLocation(page),
              );
            }
            const record = this.#records[entry.slot];
            if (record !== undefined) {
              this.writeRecord(entry.slot, record);
            }
          }
        }
        previous.destroy();
        release();
        continue;
      }
      this.#growthRequest = { layout, slots: requestedSlots };
      await this.waitForCapacity();
    }
  }

  private waitForCapacity(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#capacityWaiters.push({ resolve, reject });
    });
  }

  private settleCapacity(error?: unknown): void {
    for (const waiter of this.#capacityWaiters.splice(0)) {
      if (error === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
  }

  private assertMetadataWritable(): void {
    if (this.#metadataCandidate !== undefined || this.#pool?.frozen) {
      throw new Error("Geometry metadata mutation overlaps an unsubmitted capacity transaction");
    }
  }

  private abortCapacityFrame(): void {
    const reason = new Error("Geometry ownership changed during capacity encoding");
    this.#metadataCandidate?.command.abort(reason);
    this.#pool.abortPendingFrame(reason);
  }

  private async waitForWritableMetadata(): Promise<void> {
    while (this.#metadataCandidate !== undefined || this.#pool.frozen) {
      if (this.#metadataCandidate !== undefined) {
        await this.waitForCapacity();
      } else {
        await this.#pool.waitForGrowth();
      }
    }
  }

  private applyMetadataCapacity(layout: MultiMetadataLayout, slots: number): void {
    for (const name of GEOMETRY_METADATA_SECTIONS) {
      this.#ranges[name]!.grow(this.#metadataLayout[name], layout[name]);
    }
    if (slots > this.#slotCapacity) {
      const used = new Uint8Array(slots);
      used.set(this.#usedSlots);
      this.#usedSlots = used;
      this.#records.length = slots;
    }
    this.#slotCapacity = slots;
    this.#metadataLayout = layout;
  }

  private createMetadataBuffer(layout: MultiMetadataLayout): { buffer: GPUBuffer; release: () => void } {
    const releaseBudget = reserveGeometryProductMetadataBytes(this.#device, layout.byteLength);
    try {
      const buffer = this.#device.createBuffer({
        label: "OEngine Geometry metadata capacity candidate",
        size: layout.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      let released = false;
      return {
        buffer,
        release: () => {
          if (!released) {
            released = true;
            buffer.destroy();
            releaseBudget();
          }
        },
      };
    } catch (error) {
      releaseBudget();
      throw error;
    }
  }

  private metadataHeader(
    layout: MultiMetadataLayout,
    products: number,
    bankBytes: number,
  ): Uint8Array<ArrayBuffer> {
    return packGeometryProductMetadataHeapHeaderV1({
      bankByteCapacity: bankBytes,
      productCount: products,
      productCapacity: products,
      totalWords: layout.byteLength / 4,
      productTableWordOffset: layout.productTable / 4,
      assetReferenceWordOffset: layout.assetReferences / 4,
      assetRecordWordOffset: layout.assetRecords / 4,
      rootNodeIdWordOffset: layout.rootNodeIds / 4,
      hierarchyWordOffset: layout.hierarchyNodes / 4,
      groupDirectoryWordOffset: layout.groupDirectory / 4,
      pageLocationWordOffset: layout.pageLocations / 4,
      vertexFormatWordOffset: layout.vertexFormats / 4,
    });
  }

  private prepareMetadataFrame(command: ShadeGPUCommandContext, bankBytes: number): void {
    if (this.#metadataCandidate !== undefined) {
      if (this.#metadataCandidate.command !== command) {
        throw new Error("Geometry metadata already belongs to another unsubmitted command");
      }
      return;
    }
    const request = this.#growthRequest;
    if (request === undefined) {
      if (bankBytes !== this.#bankHeaderBytes) {
        command.uploadRegions([
          {
            destination: this.#metadata,
            destinationOffset: 48,
            bytes: new Uint8Array(new Uint32Array([bankBytes]).buffer),
          },
        ]);
        command.observeSubmission({
          submitted: () => {
            this.#bankHeaderBytes = bankBytes;
            this.settleCapacity();
          },
          aborted: () => {},
          failed: (error) => {
            this.#lastError = String(error);
          },
        });
      }
      return;
    }
    let next: { buffer: GPUBuffer; release: () => void };
    try {
      next = this.createMetadataBuffer(request.layout);
    } catch (error) {
      this.#lastError = String(error);
      this.#growthRequest = undefined;
      this.settleCapacity(error);
      return;
    }
    const candidate = {
      ...next,
      layout: request.layout,
      slots: request.slots,
      command,
      epoch: ++this.#metadataSerial,
    };
    const previous = this.#metadata;
    const previousRelease = this.#releaseMetadataReservation;
    this.#metadataCandidate = candidate;
    command.observeSubmission({
      aborted: () => {
        if (this.#metadataCandidate === candidate) {
          this.#metadataCandidate = undefined;
          candidate.release();
          this.settleCapacity();
        }
      },
      failed: (error) => {
        this.#lastError = String(error);
      },
      submitted: (fence) => {
        if (this.#metadataCandidate !== candidate) {
          throw new Error("Geometry metadata lost its capacity candidate");
        }
        this.applyMetadataCapacity(candidate.layout, candidate.slots);
        this.#metadata = candidate.buffer;
        this.#releaseMetadataReservation = candidate.release;
        this.#metadataCandidate = undefined;
        this.#growthRequest = undefined;
        this.#metadataEpoch = candidate.epoch;
        this.#bankHeaderBytes = bankBytes;
        const retire = () => {
          previous.destroy();
          previousRelease();
        };
        this.#retiredMetadata.add(retire);
        this.settleCapacity();
        void fence.then(
          () => {
            if (this.#retiredMetadata.delete(retire)) {
              retire();
            }
          },
          (error: unknown) => {
            this.#lastError = String(error);
          },
        );
      },
    });
    const old = this.#metadataLayout;
    for (const [field, bytes] of [
      ["productTable", this.#slotCapacity * 64],
      ["assetReferences", old.asset * 16],
      ["assetRecords", old.asset * 128],
      ["rootNodeIds", Math.ceil((old.root * 4) / 16) * 16],
      ["hierarchyNodes", old.hierarchy * 48],
      ["groupDirectory", old.group * 16],
      ["pageLocations", old.page * 16],
      ["vertexFormats", old.vertexFormat * 16],
    ] as const) {
      command.copyBufferToBuffer(previous, old[field], candidate.buffer, candidate.layout[field], bytes);
    }
    command.uploadRegions([
      {
        destination: candidate.buffer,
        destinationOffset: 0,
        bytes: this.metadataHeader(candidate.layout, candidate.slots, bankBytes),
      },
    ]);
  }

  private allocateMetadata(
    descriptor: GeometryProductDescriptorV1,
    assetReferenceBegin?: number,
  ): ProductMetadataAllocation {
    const counts = descriptorCounts(descriptor);
    const names = ["asset", "root", "hierarchy", "group", "page", "vertexFormat"] as const;
    const sizes = [
      counts.assets,
      counts.roots,
      counts.hierarchy,
      counts.groups,
      counts.pages,
      counts.formats,
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
    this.assertMetadataWritable();
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
          flags: 0,
        }),
        asset * 16,
      );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.assetReferences + allocation.assetBegin * 16,
      refs,
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.assetRecords + allocation.assetBegin * 128,
      assetRecords,
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.rootNodeIds + allocation.rootBegin * 4,
      roots,
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.hierarchyNodes + allocation.hierarchyBegin * 48,
      hierarchy,
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.groupDirectory + allocation.groupBegin * 16,
      groups,
    );
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.vertexFormats + allocation.vertexFormatBegin * 16,
      copyBytes(descriptor.vertexFormats),
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
      ...[...this.#retiring.values()].map((entry) => entry.generation),
    ]);
    for (let attempt = 0; attempt < 0xfffffffe; attempt++) {
      const generation = this.#nextGeneration;
      this.#nextGeneration = generation >= 0xfffffffe ? 1 : generation + 1;
      if (generation !== 0 && generation !== 0xffffffff && !live.has(generation)) return generation;
    }
    throw new Error("Geometry Product generation space exhausted");
  }

  private writeRecord(slot: number, record: GeometryProductTableRecordV1): void {
    this.assertMetadataWritable();
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
            vertexFormatBegin: allocation.vertexFormatBegin,
          });
    this.#records[slot] = Object.freeze({ ...published });
    const bytes = packGeometryProductTableRecordV1(published);
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.productTable + slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
      bytes,
    );
  }

  private clearRecord(slot: number): void {
    this.assertMetadataWritable();
    this.#records[slot] = undefined;
    const bytes = new Uint8Array(GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1);
    this.#device.queue.writeBuffer(
      this.#metadata,
      this.#metadataLayout.productTable + slot * GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1,
      bytes,
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
  flags: number,
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
    vertexFormatCount: descriptor.vertexFormats.byteLength / 16,
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
    formats: descriptor.vertexFormats.byteLength / 16,
  });
}

function relocateAssetRecords(
  source: Uint8Array,
  allocation: ProductMetadataAllocation,
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
  allocation: ProductMetadataAllocation,
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
  get availableRecords(): number {
    let count = 0;
    for (const range of this.#free) count += range.count;
    return count;
  }
  canAllocate(count: number, begin?: number): boolean {
    if (count === 0) {
      return true;
    }
    return this.#free.some((range) =>
      begin === undefined
        ? range.count >= count
        : begin >= range.begin && begin + count <= range.begin + range.count,
    );
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
  grow(previous: number, next: number): void {
    if (next > previous) {
      this.release(previous, next - previous);
    }
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
    for (let at = 1; at < this.#free.length;) {
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
