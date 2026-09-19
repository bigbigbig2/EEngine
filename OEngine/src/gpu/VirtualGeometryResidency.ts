import {
  OEGPACK_V3_PAGE_BYTES,
  hierarchyNodeChildCountV3,
  hierarchyNodeChildStartV3,
  hierarchyNodeGroupIdV3,
  hierarchyNodeIsGroupV3
} from "../assets/GeometryAbiV3.js";
import {
  assertGeometryProductDescriptorV1,
  decodeGeometryProductPageRecordV1,
  type GeometryProductDescriptorV1,
  type GeometryPageProductV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import { GEOMETRY_PAGE_LOCATION_NON_RESIDENT, GEOMETRY_PAGE_LOCATION_PINNED, GEOMETRY_PAGE_LOCATION_RESIDENT, GEOMETRY_PAGE_LOCATION_STRIDE, GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1, packGeometryProductAssetReferenceV1, packGeometryProductMetadataHeapHeaderV1, packGeometryProductTableRecordV1 } from "./GeometryProductGpuAbiV1.js";
import { geometryProductGpuBudgetEvidence, reserveGeometryProductMetadataBytes } from "./GeometryProductGpuBudget.js";
import { GeometryProductSlotPool, GEOMETRY_PRODUCT_SHARED_BANK_BYTES } from "./GeometryProductSlotPool.js";
export { GEOMETRY_PAGE_LOCATION_NON_RESIDENT, GEOMETRY_PAGE_LOCATION_PINNED, GEOMETRY_PAGE_LOCATION_RESIDENT, GEOMETRY_PAGE_LOCATION_STRIDE } from "./GeometryProductGpuAbiV1.js";

export interface GeometryPageLocationV1 {
  readonly bankIndex: number;
  readonly slotIndex: number;
  readonly productGeneration: number;
  readonly flags: number;
}

export interface VirtualGeometryResidencyEvidenceV1 {
  readonly productGeneration: number;
  readonly offeredRevisions: number;
  readonly admittedRevisions: number;
  readonly activeRevisions: number;
  readonly failedRevisions: number;
  readonly requestedPages: number;
  readonly residentPages: number;
  readonly pinnedPages: number;
  readonly residentBytes: number;
  readonly retiringBytes: number;
  readonly evictedPages: number;
  readonly uploadedBytes: number;
  readonly bankCount: number;
  readonly slotCapacity: number;
  readonly invalidGeneration: number;
  readonly failedPages: number;
  readonly retiringPages: number;
  readonly metadataBytes: number;
  readonly allocatedCapacityBytes: number;
  readonly sharedBankCapacityBytes: number;
  readonly globalAllocatedCapacityBytes: number;
  readonly globalMetadataBytes: number;
  readonly globalTotalCapacityBytes: number;
  readonly globalPeakCapacityBytes: number;
  readonly globalCapacityLimitBytes: number;
  readonly globalMetadataLimitBytes: number;
  readonly averagePageLifetimeFrames: number;
  readonly reloads: number;
  readonly shortTermRerequests: number;
  readonly thrashBytes: number;
}

export interface GeometryProductGpuBindingsV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly metadata: GPUBuffer;
  readonly metadataByteLength: number;
  readonly productTableByteOffset: number;
  readonly pageLocationByteOffset: number;
  /** Alias of metadata; record begins at productTableByteOffset. */
  readonly productTable: GPUBuffer;
  readonly banks: readonly GPUBuffer[];
}

interface MetadataLayout { readonly byteLength: number; readonly productTable: number; readonly productRecord: number; readonly productCapacity: number; readonly assetReferences: number; readonly assetRecords: number; readonly rootNodeIds: number; readonly hierarchyNodes: number; readonly groupDirectory: number; readonly pageLocations: number; readonly vertexFormats: number; }
interface PageEvictionHistory {
  residentSince: number;
  lastUsed: number;
  demandFrequency: number;
  visibleFrequency: number;
  lastFeedbackFrame: number;
  predictedUntil: number;
  refetchCost: number;
  lastEvicted: number;
  rerequestNoted: boolean;
  reloads: number;
}
const EVICTION_HYSTERESIS_FRAMES = 8;
const EVICTION_THRASH_WINDOW_FRAMES = 60;

/** Product-owned bootstrap admission and decoded-page heap. Later demand/eviction extends this owner. */
export class VirtualGeometryResidency {
  readonly #banks: GPUBuffer[] = [];
  #slotPool: GeometryProductSlotPool | undefined;
  readonly #releaseReservations: Array<() => void> = [];
  readonly #pageLocations = new Map<number, GeometryPageLocationV1>();
  readonly #retiringLocations = new Map<number, GeometryPageLocationV1>();
  readonly #slotOwners = new Map<string, number>();
  readonly #pageLastUsed = new Map<number, number>();
  readonly #pageHistory = new Map<number, PageEvictionHistory>();
  readonly #pageImportance = new Map<number, number>();
  readonly #groupLocations = new Map<number, GeometryPageLocationV1 & { readonly byteOffset: number }>();
  readonly #descriptor: GeometryProductDescriptorV1;
  readonly #source: GeometryProductRevisionSourceV1;
  readonly #productGeneration: number;
  readonly #productTableSlot: number;
  readonly #metadata: GPUBuffer;
  readonly #metadataLayout: MetadataLayout;
  readonly #signal?: AbortSignal;
  #destroyed = false;
  #uploadedBytes = 0;
  #evictedPages = 0;
  #failedPages = 0;
  #activePublication = false;
  #frameClock = 0;
  #lifetimeFrames = 0;
  #reloads = 0;
  #shortTermRerequests = 0;
  #thrashBytes = 0;

  private constructor(readonly device: GPUDevice, source: GeometryProductRevisionSourceV1, productGeneration: number, productTableSlot: number, signal?: AbortSignal) {
    this.#source = source;
    this.#descriptor = source.descriptor;
    this.#productGeneration = productGeneration;
    this.#productTableSlot = productTableSlot;
    this.#signal = signal;
    this.#indexHierarchyImportance();
    const assetCount = source.descriptor.assetRecords.byteLength / 128;
    this.#metadataLayout = metadataLayout(source.descriptor, productTableSlot);
    if (this.#metadataLayout.byteLength > device.limits.maxBufferSize || this.#metadataLayout.byteLength > device.limits.maxStorageBufferBindingSize) throw new RangeError("Geometry Product metadata heap exceeds the negotiated storage-buffer limit");
    const metadataSize = Math.max(4, Math.ceil(this.#metadataLayout.byteLength / 4) * 4);
    const releaseMetadata = reserveGeometryProductMetadataBytes(device, metadataSize);
    try {
      this.#metadata = createStorageBuffer(device, "OEngine Geometry Product V1 metadata heap", metadataSize);
      this.#releaseReservations.push(releaseMetadata);
    } catch (error) { releaseMetadata(); throw error; }
    try {
      const initial = buildMetadataHeap(source.descriptor, this.#metadataLayout, productGeneration, productTableSlot, assetCount);
      device.queue.writeBuffer(this.#metadata, 0, initial);
    } catch (error) {
      this.#metadata.destroy();
      this.#releaseReservations.pop()?.();
      throw error;
    }
  }

  static async create(device: GPUDevice, source: GeometryProductRevisionSourceV1, productGeneration = 1, productTableSlot = 0, signal?: AbortSignal): Promise<VirtualGeometryResidency> {
    let owner: VirtualGeometryResidency | undefined;
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("Geometry Product admission was cancelled");
      assertGeometryProductDescriptorV1(source.descriptor);
      if (!Number.isInteger(productGeneration) || productGeneration <= 0 || productGeneration === 0xffffffff) throw new RangeError("productGeneration must be a non-zero u32");
      if (!Number.isInteger(productTableSlot) || productTableSlot < 0 || productTableSlot >= 0xffffffff) throw new RangeError("productTableSlot must be a valid u32");
      owner = new VirtualGeometryResidency(device, source, productGeneration, productTableSlot, signal);
      await owner.#fillActivationCut();
      return owner;
    } catch (error) {
      if (owner) owner.destroy(); else source.release();
      throw error;
    }
  }

  async #fillActivationCut(): Promise<void> {
    const pages = [...this.#descriptor.activationPageIds];
    // All revisions bind the same four bank objects. Global slot ownership
    // prevents new/old Product overlap while keeping refinement bindings fixed.
    this.#slotPool = GeometryProductSlotPool.retain(this.device);
    this.#banks.push(...this.#slotPool.banks);
    if (pages.length > this.#slotPool.availableSlots) throw new RangeError("Geometry Product activation cut exceeds shared GPU slot capacity");
    for (let index = 0; index < pages.length; index++) {
      if (this.#signal?.aborted) throw this.#signal.reason ?? new Error("Geometry Product admission was cancelled");
      const pageId = pages[index]!;
      const slot = this.#slotPool.allocate();
      if (!slot) throw new RangeError("Geometry Product activation cut has no shared GPU slot");
      const { bankIndex, slotIndex } = slot;
      try {
        const page = await this.#source.readPage(pageId, this.#signal);
        if (this.#signal?.aborted) throw this.#signal.reason ?? new Error("Geometry Product admission was cancelled");
        const expected = decodeGeometryProductPageRecordV1(this.#descriptor, pageId);
        if (page.productId.length !== 32 || !sameBytes(page.productId, this.#descriptor.productId) || page.revision !== this.#descriptor.revision || page.pageId !== pageId || page.bytes.byteLength !== OEGPACK_V3_PAGE_BYTES || !sameBytes(page.decodedHash128, expected.decodedHash128)) throw new Error(`page ${pageId} returned an invalid Product key, identity or size`);
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", page.bytes.slice(0)));
        if (!sameBytes(digest.subarray(0, 16), page.decodedPageHash128)) throw new Error(`page ${pageId} integrity hash mismatch`);
        this.device.queue.writeBuffer(this.#banks[bankIndex]!, slotIndex * OEGPACK_V3_PAGE_BYTES, new Uint8Array(page.bytes));
        const location = Object.freeze({ bankIndex, slotIndex, productGeneration: this.#productGeneration, flags: GEOMETRY_PAGE_LOCATION_RESIDENT | GEOMETRY_PAGE_LOCATION_PINNED });
        this.#pageLocations.set(pageId, location);
        this.#slotOwners.set(slotKey(bankIndex, slotIndex), pageId);
        this.#pageLastUsed.set(pageId, 0);
        this.#onResident(pageId);
        this.#uploadedBytes += OEGPACK_V3_PAGE_BYTES;
      } catch (error) { if (!this.#slotOwners.has(slotKey(bankIndex, slotIndex))) this.#slotPool.release(bankIndex, slotIndex); this.#failedPages++; throw error; }
    }
    const groupView = new DataView(this.#descriptor.groupDirectory.buffer, this.#descriptor.groupDirectory.byteOffset, this.#descriptor.groupDirectory.byteLength);
    for (let groupId = 0; groupId < this.#descriptor.groupDirectory.byteLength / 16; groupId++) {
      const pageId = groupView.getUint32(groupId * 16, true), location = this.#pageLocations.get(pageId);
      if (location) this.#groupLocations.set(groupId, Object.freeze({ ...location, byteOffset: location.slotIndex * OEGPACK_V3_PAGE_BYTES + groupView.getUint32(groupId * 16 + 4, true) }));
    }
    for (const pageId of this.#descriptor.activationPageIds) if (!this.#pageLocations.has(pageId)) throw new Error(`activation page ${pageId} is not resident`);
    if (this.#signal?.aborted) throw this.#signal.reason ?? new Error("Geometry Product admission was cancelled");
    const locations = new Uint8Array(Math.max(GEOMETRY_PAGE_LOCATION_STRIDE, this.#descriptor.pageRecords.byteLength / 2));
    const locationView = new DataView(locations.buffer);
    for (let pageId = 0; pageId < this.#descriptor.pageRecords.byteLength / 32; pageId++) { const at = pageId * GEOMETRY_PAGE_LOCATION_STRIDE; locationView.setUint32(at, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); locationView.setUint32(at + 4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); }
    for (const [pageId, location] of this.#pageLocations) locations.set(new Uint8Array(this.writePageLocation(location)), pageId * GEOMETRY_PAGE_LOCATION_STRIDE);
    this.device.queue.writeBuffer(this.#metadata, this.#metadataLayout.pageLocations, locations);
  }

  bank(index: number): GPUBuffer { if (this.#destroyed || !Number.isInteger(index) || index < 0 || index >= this.#banks.length) throw new RangeError("geometry bank index is invalid"); return this.#banks[index]!; }
  get descriptor(): GeometryProductDescriptorV1 { return this.#descriptor; }
  /** CPU Product source view for external schedulers; residency keeps release ownership. */
  sourceForStreaming(): GeometryProductRevisionSourceV1 {
    if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed");
    return Object.freeze({
      descriptor: this.#descriptor,
      readPage: (pageId: number, signal?: AbortSignal) => this.#source.readPage(pageId, signal),
      release: () => undefined
    });
  }
  get productGeneration(): number { return this.#productGeneration; }
  get productTableSlot(): number { return this.#productTableSlot; }
  activatePublication(): void { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); this.#writeProductRecord(GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1); this.#activePublication = true; }
  bindings(): GeometryProductGpuBindingsV1 { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); return Object.freeze({ productTableSlot: this.#productTableSlot, productGeneration: this.#productGeneration, metadata: this.#metadata, metadataByteLength: this.#metadataLayout.byteLength, productTableByteOffset: this.#metadataLayout.productRecord, pageLocationByteOffset: this.#metadataLayout.pageLocations, productTable: this.#metadata, banks: Object.freeze([...this.#banks]) }); }
  pageLocationTable(): GPUBuffer { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); return this.#metadata; }
  pageLocation(pageId: number): GeometryPageLocationV1 | undefined { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); this.#assertPageId(pageId); return this.#pageLocations.get(pageId); }
  /** Drops all GPU allocations after device loss while retaining the Product source. */
  abandonForDeviceLoss(): void {
    if (this.#destroyed) return;
    this.#destroyGpuResources();
    this.#destroyed = true;
  }
  /** Records a consumer use for age-aware eviction; it never changes GPU state. */
  touchPage(pageId: number, frameIndex: number): boolean {
    if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed");
    this.#assertPageId(pageId);
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new RangeError("Geometry Product frame index must be non-negative");
    const location = this.#pageLocations.get(pageId);
    if (!location) return false;
    this.#frameClock = Math.max(this.#frameClock, frameIndex);
    this.#pageLastUsed.set(pageId, frameIndex);
    const history = this.#pageHistory.get(pageId);
    if (history) { history.lastUsed = frameIndex; history.visibleFrequency = Math.min(255, history.visibleFrequency + 1); }
    return true;
  }
  /** Delayed GPU request/visibility feedback; cost is a source-provided normalized estimate. */
  recordDemand(pageId: number, frameIndex: number, visible: boolean, predictive: boolean, refetchCost = 1): void {
    this.#assertPageId(pageId);
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || !Number.isFinite(refetchCost) || refetchCost < 1) throw new RangeError("Geometry Product demand feedback is invalid");
    this.#frameClock = Math.max(this.#frameClock, frameIndex);
    const history = this.#history(pageId);
    const elapsed = Math.max(0, frameIndex - history.lastFeedbackFrame);
    const decay = 2 ** (-elapsed / 32);
    history.demandFrequency = Math.min(255, history.demandFrequency * decay + 1);
    history.visibleFrequency = Math.min(255, history.visibleFrequency * decay + (visible ? 1 : 0));
    history.lastFeedbackFrame = frameIndex;
    history.refetchCost = refetchCost;
    if (predictive) history.predictedUntil = Math.max(history.predictedUntil, frameIndex + EVICTION_HYSTERESIS_FRAMES);
    if (!history.rerequestNoted && history.lastEvicted >= 0 && frameIndex - history.lastEvicted <= EVICTION_THRASH_WINDOW_FRAMES) {
      this.#shortTermRerequests++;
      history.rerequestNoted = true;
    }
    if (this.#pageLocations.has(pageId)) this.touchPage(pageId, frameIndex);
  }
  /**
   * Selects non-pinned pages using age and a minimum residency cooldown. The
   * caller must call beginRetirePage() and wait for its submission boundary.
   */
  selectEvictionCandidates(frameIndex: number, maxBytes: number, minimumAge = 2): readonly number[] {
    if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed");
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
        !Number.isSafeInteger(minimumAge) || minimumAge < 0) {
      throw new RangeError("Geometry Product eviction budget/age is invalid");
    }
    this.#frameClock = Math.max(this.#frameClock, frameIndex);
    const candidates = [...this.#pageLocations.entries()]
      .filter(([, location]) => (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) === 0)
      .filter(([pageId]) => {
        const history = this.#history(pageId);
        return frameIndex - history.residentSince >= minimumAge &&
          frameIndex - history.lastUsed >= minimumAge &&
          frameIndex >= history.predictedUntil &&
          (history.reloads === 0 || frameIndex - history.residentSince >= EVICTION_HYSTERESIS_FRAMES);
      })
      .sort((a, b) => this.#evictionKeepScore(a[0], frameIndex) - this.#evictionKeepScore(b[0], frameIndex) || a[0] - b[0]);
    const selected: number[] = [];
    let bytes = 0;
    for (const [pageId] of candidates) {
      if (bytes + OEGPACK_V3_PAGE_BYTES > maxBytes) break;
      selected.push(pageId);
      bytes += OEGPACK_V3_PAGE_BYTES;
    }
    return Object.freeze(selected);
  }
  groupAddress(groupId: number): (GeometryPageLocationV1 & { readonly byteOffset: number }) | undefined { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); return this.#groupLocations.get(groupId); }
  /** Scheduler upload sink. The page was hash-verified before this synchronous publication. */
  uploadPage(page: GeometryPageProductV1): void {
    if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed");
    this.#assertPageId(page.pageId);
    if (page.revision !== this.#descriptor.revision || page.bytes.byteLength !== OEGPACK_V3_PAGE_BYTES || !sameBytes(page.productId, this.#descriptor.productId)) throw new Error("Geometry Product page identity or payload is invalid");
    const expected = decodeGeometryProductPageRecordV1(this.#descriptor, page.pageId);
    if (!sameBytes(page.decodedHash128, expected.decodedHash128)) throw new Error("Geometry Product page identity is invalid");
    if (this.#pageLocations.has(page.pageId)) return;
    if (this.#retiringLocations.has(page.pageId)) throw new Error("Geometry Product page is retiring and cannot be re-uploaded yet");
    const slot = this.#acquireSlot();
    if (!slot) throw new Error("Geometry Product shared resident heap is full; page must remain queued");
    try { this.device.queue.writeBuffer(this.#banks[slot.bankIndex]!, slot.slotIndex * OEGPACK_V3_PAGE_BYTES, new Uint8Array(page.bytes)); }
    catch (error) { this.#slotPool!.release(slot.bankIndex, slot.slotIndex); throw error; }
    const location = Object.freeze({ bankIndex: slot.bankIndex, slotIndex: slot.slotIndex, productGeneration: this.#productGeneration, flags: GEOMETRY_PAGE_LOCATION_RESIDENT });
    this.#pageLocations.set(page.pageId, location); this.#slotOwners.set(slotKey(slot.bankIndex, slot.slotIndex), page.pageId); this.#uploadedBytes += OEGPACK_V3_PAGE_BYTES;
    this.#pageLastUsed.set(page.pageId, 0);
    this.#onResident(page.pageId);
    this.#publishPageLocation(page.pageId, location); this.#publishGroupsForPage(page.pageId, location);
  }
  beginRetirePage(pageId: number): void {
    this.#assertPageId(pageId);
    const location = this.#pageLocations.get(pageId); if (!location || (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) return;
    this.#pageLocations.delete(pageId); this.#retiringLocations.set(pageId, location); this.#pageLastUsed.delete(pageId); this.#publishPageLocation(pageId, undefined);
    for (const [groupId, group] of this.#groupLocations) if (group.bankIndex === location.bankIndex && group.slotIndex === location.slotIndex) this.#groupLocations.delete(groupId);
  }
  completeRetirePage(pageId: number): void { this.#assertPageId(pageId); const location = this.#retiringLocations.get(pageId); if (!location) return; this.#retiringLocations.delete(pageId); this.#slotOwners.delete(slotKey(location.bankIndex, location.slotIndex)); this.#slotPool!.release(location.bankIndex, location.slotIndex); const history = this.#history(pageId); this.#lifetimeFrames += Math.max(0, this.#frameClock - history.residentSince); history.lastEvicted = this.#frameClock; history.rerequestNoted = false; this.#evictedPages++; }
  writePageLocation(location: GeometryPageLocationV1, target = new ArrayBuffer(GEOMETRY_PAGE_LOCATION_STRIDE)): ArrayBuffer { const view = new DataView(target); view.setUint32(0, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.bankIndex : GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(4, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.slotIndex : GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(8, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.productGeneration : 0, true); view.setUint32(12, location.flags, true); return target; }
  evidence(): VirtualGeometryResidencyEvidenceV1 {
    const pinnedPages = [...this.#pageLocations.values()].filter(location => (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0).length;
    const global = geometryProductGpuBudgetEvidence(this.device);
    return Object.freeze({
      productGeneration: this.#productGeneration,
      offeredRevisions: 1,
      admittedRevisions: this.#failedPages ? 0 : 1,
      activeRevisions: this.#activePublication ? 1 : 0,
      failedRevisions: this.#failedPages ? 1 : 0,
      requestedPages: this.#descriptor.activationPageIds.length,
      residentPages: this.#pageLocations.size,
      pinnedPages,
      retiringPages: this.#retiringLocations.size,
      residentBytes: this.#pageLocations.size * OEGPACK_V3_PAGE_BYTES,
      retiringBytes: this.#retiringLocations.size * OEGPACK_V3_PAGE_BYTES,
      evictedPages: this.#evictedPages,
      uploadedBytes: this.#uploadedBytes,
      metadataBytes: this.#metadataLayout.byteLength,
      bankCount: this.#banks.length,
      slotCapacity: this.#slotPool?.slotCapacity ?? 0,
      allocatedCapacityBytes: this.#metadataLayout.byteLength + this.#banks.length * GEOMETRY_PRODUCT_SHARED_BANK_BYTES,
      sharedBankCapacityBytes: this.#banks.length * GEOMETRY_PRODUCT_SHARED_BANK_BYTES,
      globalAllocatedCapacityBytes: global.allocatedBytes,
      globalMetadataBytes: global.metadataBytes,
      globalTotalCapacityBytes: global.totalBytes,
      globalPeakCapacityBytes: global.peakBytes,
      globalCapacityLimitBytes: global.limitBytes,
      globalMetadataLimitBytes: global.metadataLimitBytes,
      averagePageLifetimeFrames: this.#evictedPages === 0 ? 0 : this.#lifetimeFrames / this.#evictedPages,
      reloads: this.#reloads,
      shortTermRerequests: this.#shortTermRerequests,
      thrashBytes: this.#thrashBytes,
      invalidGeneration: 0,
      failedPages: this.#failedPages
    });
  }
  #history(pageId: number): PageEvictionHistory {
    let history = this.#pageHistory.get(pageId);
    if (!history) {
      history = { residentSince: this.#frameClock, lastUsed: this.#frameClock, demandFrequency: 0, visibleFrequency: 0, lastFeedbackFrame: this.#frameClock, predictedUntil: 0, refetchCost: 1, lastEvicted: -1, rerequestNoted: false, reloads: 0 };
      this.#pageHistory.set(pageId, history);
    }
    return history;
  }
  #onResident(pageId: number): void {
    const history = this.#history(pageId);
    if (history.lastEvicted >= 0) {
      history.reloads++;
      this.#reloads++;
      if (this.#frameClock - history.lastEvicted <= EVICTION_THRASH_WINDOW_FRAMES) this.#thrashBytes += OEGPACK_V3_PAGE_BYTES;
    }
    history.residentSince = this.#frameClock;
    history.lastUsed = this.#frameClock;
    history.lastEvicted = -1;
    history.rerequestNoted = false;
  }
  #evictionKeepScore(pageId: number, frameIndex: number): number {
    const history = this.#history(pageId);
    const decay = 2 ** (-Math.max(0, frameIndex - history.lastFeedbackFrame) / 32);
    return Math.max(0, 64 - (frameIndex - history.lastUsed)) +
      history.demandFrequency * decay * 8 + history.visibleFrequency * decay * 12 +
      (this.#pageImportance.get(pageId) ?? 0) * 16 + history.refetchCost * 4;
  }
  #indexHierarchyImportance(): void {
    const nodes = new DataView(this.#descriptor.hierarchyNodes.buffer, this.#descriptor.hierarchyNodes.byteOffset, this.#descriptor.hierarchyNodes.byteLength);
    const groups = new DataView(this.#descriptor.groupDirectory.buffer, this.#descriptor.groupDirectory.byteOffset, this.#descriptor.groupDirectory.byteLength);
    const visited = new Set<number>();
    const walk = (nodeId: number, depth: number): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const packed = nodes.getUint32(nodeId * 48 + 44, true);
      if (hierarchyNodeIsGroupV3(packed)) {
        const groupId = hierarchyNodeGroupIdV3(packed);
        const pageId = groups.getUint32(groupId * 16, true);
        this.#pageImportance.set(pageId, Math.max(this.#pageImportance.get(pageId) ?? 0, 1 / (depth + 1)));
      } else {
        const start = hierarchyNodeChildStartV3(packed), count = hierarchyNodeChildCountV3(packed);
        for (let child = 0; child < count; child++) walk(start + child, depth + 1);
      }
    };
    for (const root of this.#descriptor.rootNodeIds) walk(root, 0);
  }
  #acquireSlot(): { bankIndex: number; slotIndex: number } | undefined { return this.#slotPool?.allocate(); }
  #publishPageLocation(pageId: number, location: GeometryPageLocationV1 | undefined): void { const bytes = new ArrayBuffer(GEOMETRY_PAGE_LOCATION_STRIDE); if (location) this.writePageLocation(location, bytes); else { const view = new DataView(bytes); view.setUint32(0, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(8, 0, true); view.setUint32(12, 0, true); } this.device.queue.writeBuffer(this.#metadata, this.#metadataLayout.pageLocations + pageId * GEOMETRY_PAGE_LOCATION_STRIDE, new Uint8Array(bytes)); }
  #publishGroupsForPage(pageId: number, location: GeometryPageLocationV1): void { const groupView = new DataView(this.#descriptor.groupDirectory.buffer, this.#descriptor.groupDirectory.byteOffset, this.#descriptor.groupDirectory.byteLength); for (let groupId = 0; groupId < this.#descriptor.groupDirectory.byteLength / 16; groupId++) if (groupView.getUint32(groupId * 16, true) === pageId) this.#groupLocations.set(groupId, Object.freeze({ ...location, byteOffset: location.slotIndex * OEGPACK_V3_PAGE_BYTES + groupView.getUint32(groupId * 16 + 4, true) })); }
  #writeProductRecord(flags: number): void { const descriptor = this.#descriptor; const record = packGeometryProductTableRecordV1({ productGeneration: this.#productGeneration, flags, assetBegin: 0, assetCount: descriptor.assetRecords.byteLength / 128, rootBegin: 0, rootCount: descriptor.rootNodeIds.length, hierarchyBegin: 0, hierarchyCount: descriptor.hierarchyNodes.byteLength / 48, groupBegin: 0, groupCount: descriptor.groupDirectory.byteLength / 16, pageBegin: 0, pageCount: descriptor.pageRecords.byteLength / 32, vertexFormatBegin: 0, vertexFormatCount: descriptor.vertexFormats.byteLength / 16 }); this.device.queue.writeBuffer(this.#metadata, this.#metadataLayout.productRecord, record); }
  destroy(): void { if (this.#destroyed) return; this.#destroyed = true; this.#destroyGpuResources(); this.#source.release(); }
  #destroyGpuResources(): void { for (const key of this.#slotOwners.keys()) { const [bank, slot] = key.split(":").map(Number); this.#slotPool!.release(bank!, slot!); } this.#slotPool?.releaseOwner(); this.#slotPool = undefined; this.#metadata.destroy(); for (const release of this.#releaseReservations.splice(0)) release(); this.#banks.length = 0; this.#pageLocations.clear(); this.#retiringLocations.clear(); this.#groupLocations.clear(); this.#slotOwners.clear(); this.#pageLastUsed.clear(); this.#pageHistory.clear(); }
  #assertPageId(pageId: number): void { const pageCount = this.#descriptor.pageRecords.byteLength / 32; if (!Number.isSafeInteger(pageId) || pageId < 0 || pageId >= pageCount) throw new RangeError("Geometry Product pageId is outside the descriptor"); }
}

/**
 * The current Product raster/shading specialization declares the metadata
 * heap, four fixed page banks, and the existing frame/material buffers in one
 * compute stage.  This is a capability of the concrete consumer ABI, not a
 * new global sparse-shading baseline; callers must request it before device
 * creation when they admit a Product scene.
 */
// Product traversal plus the current single-bin material/shadow publication
// consumes fifteen storage-buffer bindings in its highest consumer variant;
// request the next aligned device limit so pipeline layout validation cannot
// succeed at admission and fail later during shader creation.
export const VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE = 16;

function slotKey(bankIndex: number, slotIndex: number): string { return `${bankIndex}:${slotIndex}`; }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false; return true; }
function createStorageBuffer(device: GPUDevice, label: string, byteLength: number): GPUBuffer { const size = Math.max(4, Math.ceil(byteLength / 4) * 4); if (!Number.isSafeInteger(size)) throw new RangeError("Geometry Product metadata buffer size is invalid"); return device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); }
function u32LittleEndian(values: Uint32Array): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(values.byteLength), view = new DataView(bytes.buffer); for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]!, true); return bytes; }
function align16(value: number): number { const result = Math.ceil(value / 16) * 16; if (!Number.isSafeInteger(result)) throw new RangeError("Geometry Product metadata heap size overflow"); return result; }
function metadataLayout(descriptor: GeometryProductDescriptorV1, productTableSlot: number): MetadataLayout { let cursor = GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1; const take = (bytes: number): number => { cursor = align16(cursor); const offset = cursor; cursor += bytes; if (!Number.isSafeInteger(cursor)) throw new RangeError("Geometry Product metadata heap size overflow"); return offset; }; const productCapacity = productTableSlot + 1; if (!Number.isSafeInteger(productCapacity)) throw new RangeError("Geometry Product table capacity overflow"); const productTable = take(productCapacity * 64), productRecord = productTable + productTableSlot * 64, assetReferences = take(descriptor.assetRecords.byteLength / 8), assetRecords = take(descriptor.assetRecords.byteLength), rootNodeIds = take(descriptor.rootNodeIds.byteLength), hierarchyNodes = take(descriptor.hierarchyNodes.byteLength), groupDirectory = take(descriptor.groupDirectory.byteLength), pageLocations = take(descriptor.pageRecords.byteLength / 2), vertexFormats = take(descriptor.vertexFormats.byteLength); return Object.freeze({ byteLength: align16(cursor), productTable, productRecord, productCapacity, assetReferences, assetRecords, rootNodeIds, hierarchyNodes, groupDirectory, pageLocations, vertexFormats }); }
function buildMetadataHeap(descriptor: GeometryProductDescriptorV1, layout: MetadataLayout, productGeneration: number, productTableSlot: number, assetCount: number): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(layout.byteLength); const header = packGeometryProductMetadataHeapHeaderV1({ productCount: layout.productCapacity, productCapacity: layout.productCapacity, totalWords: layout.byteLength / 4, productTableWordOffset: layout.productTable / 4, assetReferenceWordOffset: layout.assetReferences / 4, assetRecordWordOffset: layout.assetRecords / 4, rootNodeIdWordOffset: layout.rootNodeIds / 4, hierarchyWordOffset: layout.hierarchyNodes / 4, groupDirectoryWordOffset: layout.groupDirectory / 4, pageLocationWordOffset: layout.pageLocations / 4, vertexFormatWordOffset: layout.vertexFormats / 4 }); bytes.set(header, 0); bytes.set(packGeometryProductTableRecordV1({ productGeneration, flags: 0, assetBegin: 0, assetCount, rootBegin: 0, rootCount: descriptor.rootNodeIds.length, hierarchyBegin: 0, hierarchyCount: descriptor.hierarchyNodes.byteLength / 48, groupBegin: 0, groupCount: descriptor.groupDirectory.byteLength / 16, pageBegin: 0, pageCount: descriptor.pageRecords.byteLength / 32, vertexFormatBegin: 0, vertexFormatCount: descriptor.vertexFormats.byteLength / 16 }), layout.productRecord); for (let asset = 0; asset < assetCount; asset++) bytes.set(packGeometryProductAssetReferenceV1({ productTableSlot, productGeneration, assetRecordIndex: asset, flags: 0 }), layout.assetReferences + asset * 16); bytes.set(descriptor.assetRecords, layout.assetRecords); bytes.set(u32LittleEndian(descriptor.rootNodeIds), layout.rootNodeIds); bytes.set(descriptor.hierarchyNodes, layout.hierarchyNodes); bytes.set(descriptor.groupDirectory, layout.groupDirectory); const locationView = new DataView(bytes.buffer); for (let page = 0; page < descriptor.pageRecords.byteLength / 32; page++) { const at = layout.pageLocations + page * 16; locationView.setUint32(at, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); locationView.setUint32(at + 4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); } bytes.set(descriptor.vertexFormats, layout.vertexFormats); return bytes; }
