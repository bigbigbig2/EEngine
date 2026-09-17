import {
  OEGPACK_V3_GEOMETRY_BANK_BYTES,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_SLOTS_PER_BANK
} from "../assets/GeometryAbiV3.js";
import {
  assertGeometryProductDescriptorV1,
  decodeGeometryProductPageRecordV1,
  type GeometryProductDescriptorV1,
  type GeometryPageProductV1,
  type GeometryProductRevisionSourceV1
} from "../assets/geometry-product/GeometryProductV1.js";
import { GEOMETRY_PAGE_LOCATION_NON_RESIDENT, GEOMETRY_PAGE_LOCATION_PINNED, GEOMETRY_PAGE_LOCATION_RESIDENT, GEOMETRY_PAGE_LOCATION_STRIDE, GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1, GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1, packGeometryProductAssetReferenceV1, packGeometryProductMetadataHeapHeaderV1, packGeometryProductTableRecordV1 } from "./GeometryProductGpuAbiV1.js";
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

/** Product-owned bootstrap admission and decoded-page heap. Later demand/eviction extends this owner. */
export class VirtualGeometryResidency {
  readonly #banks: GPUBuffer[] = [];
  readonly #pageLocations = new Map<number, GeometryPageLocationV1>();
  readonly #retiringLocations = new Map<number, GeometryPageLocationV1>();
  readonly #slotOwners = new Map<string, number>();
  readonly #pageLastUsed = new Map<number, number>();
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

  private constructor(readonly device: GPUDevice, source: GeometryProductRevisionSourceV1, productGeneration: number, productTableSlot: number, signal?: AbortSignal) {
    this.#source = source;
    this.#descriptor = source.descriptor;
    this.#productGeneration = productGeneration;
    this.#productTableSlot = productTableSlot;
    this.#signal = signal;
    const assetCount = source.descriptor.assetRecords.byteLength / 128;
    this.#metadataLayout = metadataLayout(source.descriptor, productTableSlot);
    if (this.#metadataLayout.byteLength > device.limits.maxBufferSize || this.#metadataLayout.byteLength > device.limits.maxStorageBufferBindingSize) throw new RangeError("Geometry Product metadata heap exceeds the negotiated storage-buffer limit");
    this.#metadata = createStorageBuffer(device, "OEngine Geometry Product V1 metadata heap", this.#metadataLayout.byteLength);
    try {
      const initial = buildMetadataHeap(source.descriptor, this.#metadataLayout, productGeneration, productTableSlot, assetCount);
      device.queue.writeBuffer(this.#metadata, 0, initial);
    } catch (error) {
      this.#metadata.destroy();
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
      if (device.limits.maxBufferSize < OEGPACK_V3_GEOMETRY_BANK_BYTES || device.limits.maxStorageBufferBindingSize < OEGPACK_V3_GEOMETRY_BANK_BYTES) throw new RangeError("Geometry Product V1 requires a 128 MiB storage-buffer bank");
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
    const bankCount = Math.ceil(pages.length / OEGPACK_V3_SLOTS_PER_BANK);
    if (bankCount > 4) throw new RangeError("Geometry Product activation cut exceeds the 512 MiB resident budget");
    for (let bank = 0; bank < bankCount; bank++) this.#banks.push(this.device.createBuffer({ label: `OEngine Geometry Product V1 bank ${bank}`, size: OEGPACK_V3_GEOMETRY_BANK_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    for (let index = 0; index < pages.length; index++) {
      if (this.#signal?.aborted) throw this.#signal.reason ?? new Error("Geometry Product admission was cancelled");
      const pageId = pages[index]!;
      const bankIndex = Math.floor(index / OEGPACK_V3_SLOTS_PER_BANK), slotIndex = index % OEGPACK_V3_SLOTS_PER_BANK;
      try {
        const page = await this.#source.readPage(pageId, this.#signal);
        if (this.#signal?.aborted) throw this.#signal.reason ?? new Error("Geometry Product admission was cancelled");
        const expected = decodeGeometryProductPageRecordV1(this.#descriptor, pageId);
        if (page.productId.length !== 32 || !sameBytes(page.productId, this.#descriptor.productId) || page.revision !== this.#descriptor.revision || page.pageId !== pageId || page.bytes.byteLength !== OEGPACK_V3_PAGE_BYTES || !sameBytes(page.decodedHash128, expected.decodedHash128)) throw new Error(`page ${pageId} returned an invalid Product key, hash or size`);
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", page.bytes.slice(0)));
        if (!sameBytes(digest.subarray(0, 16), expected.decodedHash128)) throw new Error(`page ${pageId} decoded hash mismatch`);
        this.device.queue.writeBuffer(this.#banks[bankIndex]!, slotIndex * OEGPACK_V3_PAGE_BYTES, new Uint8Array(page.bytes));
        const location = Object.freeze({ bankIndex, slotIndex, productGeneration: this.#productGeneration, flags: GEOMETRY_PAGE_LOCATION_RESIDENT | GEOMETRY_PAGE_LOCATION_PINNED });
        this.#pageLocations.set(pageId, location);
        this.#slotOwners.set(slotKey(bankIndex, slotIndex), pageId);
        this.#pageLastUsed.set(pageId, 0);
        this.#uploadedBytes += OEGPACK_V3_PAGE_BYTES;
      } catch (error) { this.#failedPages++; throw error; }
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
  activatePublication(): void { if (this.#destroyed) throw new Error("VirtualGeometryResidency is destroyed"); this.#writeProductRecord(GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1); }
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
    this.#pageLastUsed.set(pageId, frameIndex);
    return true;
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
    const candidates = [...this.#pageLocations.entries()]
      .filter(([, location]) => (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) === 0)
      .filter(([pageId]) => frameIndex - (this.#pageLastUsed.get(pageId) ?? 0) >= minimumAge)
      .sort((a, b) => (this.#pageLastUsed.get(a[0]) ?? 0) - (this.#pageLastUsed.get(b[0]) ?? 0) || a[0] - b[0]);
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
    if (!sameBytes(page.decodedHash128, expected.decodedHash128)) throw new Error("Geometry Product page decoded hash identity is invalid");
    if (this.#pageLocations.has(page.pageId)) return;
    if (this.#retiringLocations.has(page.pageId)) throw new Error("Geometry Product page is retiring and cannot be re-uploaded yet");
    const slot = this.#acquireSlot();
    if (!slot) throw new Error("Geometry Product resident heap is full; page must remain queued");
    this.device.queue.writeBuffer(this.#banks[slot.bankIndex]!, slot.slotIndex * OEGPACK_V3_PAGE_BYTES, new Uint8Array(page.bytes));
    const location = Object.freeze({ bankIndex: slot.bankIndex, slotIndex: slot.slotIndex, productGeneration: this.#productGeneration, flags: GEOMETRY_PAGE_LOCATION_RESIDENT });
    this.#pageLocations.set(page.pageId, location); this.#slotOwners.set(slotKey(slot.bankIndex, slot.slotIndex), page.pageId); this.#uploadedBytes += OEGPACK_V3_PAGE_BYTES;
    this.#pageLastUsed.set(page.pageId, 0);
    this.#publishPageLocation(page.pageId, location); this.#publishGroupsForPage(page.pageId, location);
  }
  beginRetirePage(pageId: number): void {
    this.#assertPageId(pageId);
    const location = this.#pageLocations.get(pageId); if (!location || (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0) return;
    this.#pageLocations.delete(pageId); this.#retiringLocations.set(pageId, location); this.#pageLastUsed.delete(pageId); this.#publishPageLocation(pageId, undefined);
    for (const [groupId, group] of this.#groupLocations) if (group.bankIndex === location.bankIndex && group.slotIndex === location.slotIndex) this.#groupLocations.delete(groupId);
  }
  completeRetirePage(pageId: number): void { this.#assertPageId(pageId); const location = this.#retiringLocations.get(pageId); if (!location) return; this.#retiringLocations.delete(pageId); this.#slotOwners.delete(slotKey(location.bankIndex, location.slotIndex)); this.#evictedPages++; }
  writePageLocation(location: GeometryPageLocationV1, target = new ArrayBuffer(GEOMETRY_PAGE_LOCATION_STRIDE)): ArrayBuffer { const view = new DataView(target); view.setUint32(0, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.bankIndex : GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(4, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.slotIndex : GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(8, location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT ? location.productGeneration : 0, true); view.setUint32(12, location.flags, true); return target; }
  evidence(): VirtualGeometryResidencyEvidenceV1 { const pinnedPages = [...this.#pageLocations.values()].filter(location => (location.flags & GEOMETRY_PAGE_LOCATION_PINNED) !== 0).length; return Object.freeze({ productGeneration: this.#productGeneration, offeredRevisions: 1, admittedRevisions: this.#failedPages ? 0 : 1, activeRevisions: this.#failedPages ? 0 : 1, failedRevisions: this.#failedPages ? 1 : 0, requestedPages: this.#descriptor.activationPageIds.length, residentPages: this.#pageLocations.size, pinnedPages, retiringPages: this.#retiringLocations.size, residentBytes: this.#pageLocations.size * OEGPACK_V3_PAGE_BYTES, retiringBytes: this.#retiringLocations.size * OEGPACK_V3_PAGE_BYTES, evictedPages: this.#evictedPages, uploadedBytes: this.#uploadedBytes, metadataBytes: this.#metadataLayout.byteLength, bankCount: this.#banks.length, slotCapacity: this.#banks.length * OEGPACK_V3_SLOTS_PER_BANK, invalidGeneration: 0, failedPages: this.#failedPages }); }
  #acquireSlot(): { bankIndex: number; slotIndex: number } | undefined { for (let bankIndex = 0; bankIndex < this.#banks.length; bankIndex++) for (let slotIndex = 0; slotIndex < OEGPACK_V3_SLOTS_PER_BANK; slotIndex++) if (!this.#slotOwners.has(slotKey(bankIndex, slotIndex))) return { bankIndex, slotIndex }; if (this.#banks.length >= 4) return undefined; const bankIndex = this.#banks.length; this.#banks.push(this.device.createBuffer({ label: `OEngine Geometry Product V1 bank ${bankIndex}`, size: OEGPACK_V3_GEOMETRY_BANK_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })); return { bankIndex, slotIndex: 0 }; }
  #publishPageLocation(pageId: number, location: GeometryPageLocationV1 | undefined): void { const bytes = new ArrayBuffer(GEOMETRY_PAGE_LOCATION_STRIDE); if (location) this.writePageLocation(location, bytes); else { const view = new DataView(bytes); view.setUint32(0, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(8, 0, true); view.setUint32(12, 0, true); } this.device.queue.writeBuffer(this.#metadata, this.#metadataLayout.pageLocations + pageId * GEOMETRY_PAGE_LOCATION_STRIDE, new Uint8Array(bytes)); }
  #publishGroupsForPage(pageId: number, location: GeometryPageLocationV1): void { const groupView = new DataView(this.#descriptor.groupDirectory.buffer, this.#descriptor.groupDirectory.byteOffset, this.#descriptor.groupDirectory.byteLength); for (let groupId = 0; groupId < this.#descriptor.groupDirectory.byteLength / 16; groupId++) if (groupView.getUint32(groupId * 16, true) === pageId) this.#groupLocations.set(groupId, Object.freeze({ ...location, byteOffset: location.slotIndex * OEGPACK_V3_PAGE_BYTES + groupView.getUint32(groupId * 16 + 4, true) })); }
  #writeProductRecord(flags: number): void { const descriptor = this.#descriptor; const record = packGeometryProductTableRecordV1({ productGeneration: this.#productGeneration, flags, assetBegin: 0, assetCount: descriptor.assetRecords.byteLength / 128, rootBegin: 0, rootCount: descriptor.rootNodeIds.length, hierarchyBegin: 0, hierarchyCount: descriptor.hierarchyNodes.byteLength / 48, groupBegin: 0, groupCount: descriptor.groupDirectory.byteLength / 16, pageBegin: 0, pageCount: descriptor.pageRecords.byteLength / 32, vertexFormatBegin: 0, vertexFormatCount: descriptor.vertexFormats.byteLength / 16 }); this.device.queue.writeBuffer(this.#metadata, this.#metadataLayout.productRecord, record); }
  destroy(): void { if (this.#destroyed) return; this.#destroyed = true; this.#destroyGpuResources(); this.#source.release(); }
  #destroyGpuResources(): void { for (const bank of this.#banks) bank.destroy(); this.#metadata.destroy(); this.#banks.length = 0; this.#pageLocations.clear(); this.#retiringLocations.clear(); this.#groupLocations.clear(); this.#slotOwners.clear(); this.#pageLastUsed.clear(); }
  #assertPageId(pageId: number): void { const pageCount = this.#descriptor.pageRecords.byteLength / 32; if (!Number.isSafeInteger(pageId) || pageId < 0 || pageId >= pageCount) throw new RangeError("Geometry Product pageId is outside the descriptor"); }
}

function slotKey(bankIndex: number, slotIndex: number): string { return `${bankIndex}:${slotIndex}`; }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false; return true; }
function createStorageBuffer(device: GPUDevice, label: string, byteLength: number): GPUBuffer { const size = Math.max(4, Math.ceil(byteLength / 4) * 4); if (!Number.isSafeInteger(size)) throw new RangeError("Geometry Product metadata buffer size is invalid"); return device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); }
function u32LittleEndian(values: Uint32Array): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(values.byteLength), view = new DataView(bytes.buffer); for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]!, true); return bytes; }
function align16(value: number): number { const result = Math.ceil(value / 16) * 16; if (!Number.isSafeInteger(result)) throw new RangeError("Geometry Product metadata heap size overflow"); return result; }
function metadataLayout(descriptor: GeometryProductDescriptorV1, productTableSlot: number): MetadataLayout { let cursor = GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1; const take = (bytes: number): number => { cursor = align16(cursor); const offset = cursor; cursor += bytes; if (!Number.isSafeInteger(cursor)) throw new RangeError("Geometry Product metadata heap size overflow"); return offset; }; const productCapacity = productTableSlot + 1; if (!Number.isSafeInteger(productCapacity)) throw new RangeError("Geometry Product table capacity overflow"); const productTable = take(productCapacity * 64), productRecord = productTable + productTableSlot * 64, assetReferences = take(descriptor.assetRecords.byteLength / 8), assetRecords = take(descriptor.assetRecords.byteLength), rootNodeIds = take(descriptor.rootNodeIds.byteLength), hierarchyNodes = take(descriptor.hierarchyNodes.byteLength), groupDirectory = take(descriptor.groupDirectory.byteLength), pageLocations = take(descriptor.pageRecords.byteLength / 2), vertexFormats = take(descriptor.vertexFormats.byteLength); return Object.freeze({ byteLength: align16(cursor), productTable, productRecord, productCapacity, assetReferences, assetRecords, rootNodeIds, hierarchyNodes, groupDirectory, pageLocations, vertexFormats }); }
function buildMetadataHeap(descriptor: GeometryProductDescriptorV1, layout: MetadataLayout, productGeneration: number, productTableSlot: number, assetCount: number): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(layout.byteLength); const header = packGeometryProductMetadataHeapHeaderV1({ productCount: layout.productCapacity, productCapacity: layout.productCapacity, totalWords: layout.byteLength / 4, productTableWordOffset: layout.productTable / 4, assetReferenceWordOffset: layout.assetReferences / 4, assetRecordWordOffset: layout.assetRecords / 4, rootNodeIdWordOffset: layout.rootNodeIds / 4, hierarchyWordOffset: layout.hierarchyNodes / 4, groupDirectoryWordOffset: layout.groupDirectory / 4, pageLocationWordOffset: layout.pageLocations / 4, vertexFormatWordOffset: layout.vertexFormats / 4 }); bytes.set(header, 0); bytes.set(packGeometryProductTableRecordV1({ productGeneration, flags: 0, assetBegin: 0, assetCount, rootBegin: 0, rootCount: descriptor.rootNodeIds.length, hierarchyBegin: 0, hierarchyCount: descriptor.hierarchyNodes.byteLength / 48, groupBegin: 0, groupCount: descriptor.groupDirectory.byteLength / 16, pageBegin: 0, pageCount: descriptor.pageRecords.byteLength / 32, vertexFormatBegin: 0, vertexFormatCount: descriptor.vertexFormats.byteLength / 16 }), layout.productRecord); for (let asset = 0; asset < assetCount; asset++) bytes.set(packGeometryProductAssetReferenceV1({ productTableSlot, productGeneration, assetRecordIndex: asset, flags: 0 }), layout.assetReferences + asset * 16); bytes.set(descriptor.assetRecords, layout.assetRecords); bytes.set(u32LittleEndian(descriptor.rootNodeIds), layout.rootNodeIds); bytes.set(descriptor.hierarchyNodes, layout.hierarchyNodes); bytes.set(descriptor.groupDirectory, layout.groupDirectory); const locationView = new DataView(bytes.buffer); for (let page = 0; page < descriptor.pageRecords.byteLength / 32; page++) { const at = layout.pageLocations + page * 16; locationView.setUint32(at, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); locationView.setUint32(at + 4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); } bytes.set(descriptor.vertexFormats, layout.vertexFormats); return bytes; }
