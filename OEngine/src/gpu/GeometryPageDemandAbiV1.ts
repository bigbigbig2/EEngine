export const GEOMETRY_PAGE_DEMAND_ABI_VERSION = 1;
export const GEOMETRY_PAGE_DEMAND_HEADER_BYTES = 16;
export const GEOMETRY_PAGE_DEMAND_RECORD_BYTES = 16;
export const GEOMETRY_PAGE_DEMAND_MAX_PRIORITY = 0xffff;
export const GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING = 1 << 16;
export const GEOMETRY_PAGE_DEMAND_FLAG_SHADOW = 1 << 17;
export const GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE = 1 << 18;
export const GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE = 1 << 19;
export const GEOMETRY_PAGE_DEMAND_DEFAULT_FLAGS_V1 = 0x0001ffff;
export const GEOMETRY_PAGE_DEMAND_FLAGS_MASK = 0x000f0000;
/** Readback ring upper bound for one bounded demand queue. */
export const GEOMETRY_PAGE_DEMAND_MAX_QUEUE_BYTES_V1 = 256 * 1024;
export const GEOMETRY_PAGE_DEMAND_MAX_RECORD_CAPACITY_V1 =
  (GEOMETRY_PAGE_DEMAND_MAX_QUEUE_BYTES_V1 - GEOMETRY_PAGE_DEMAND_HEADER_BYTES) /
  GEOMETRY_PAGE_DEMAND_RECORD_BYTES;
/** Product-local request mask header: attempted, unique, duplicate, overflow. */
export const GEOMETRY_PAGE_DEMAND_MASK_HEADER_BYTES_V1 = 16;
export const GEOMETRY_PAGE_DEMAND_MASK_WORD_BYTES_V1 = 4;
/** The mask is frame-local scratch and must remain independently bounded. */
export const GEOMETRY_PAGE_DEMAND_MAX_MASK_BYTES_V1 = 1024 * 1024;

export interface GeometryPageDemandV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly pageId: number;
  readonly priority: number;
  readonly currentViewMissing: boolean;
  readonly shadow: boolean;
  readonly predictive: boolean;
  /** Usage feedback updates residency age without scheduling source IO. */
  readonly residentUsage?: boolean;
}

export interface GeometryPageDemandQueueHeaderV1 {
  readonly attempted: number;
  readonly capacity: number;
  readonly overflow: 0 | 1;
  readonly frameRevisionLow: number;
}

export interface GeometryPageDemandQueueStateV1 {
  attempted: number;
  capacity: number;
  overflow: 0 | 1;
  frameRevisionLow: number;
  readonly records: GeometryPageDemandV1[];
}

export interface GeometryPageDemandMaskStateV1 {
  readonly pageCount: number;
  readonly words: Uint32Array;
  attempted: number;
  unique: number;
  duplicates: number;
  overflow: 0 | 1;
}

export const GEOMETRY_PAGE_DEMAND_WGSL = /* wgsl */ `
struct OEngineGeometryPageDemandQueueHeaderV1 {
  attempted: atomic<u32>,
  capacity: u32,
  overflow: atomic<u32>,
  frame_revision_low: u32,
};
struct OEngineGeometryPageDemandV1 {
  product_table_slot: u32,
  product_generation: u32,
  page_id: u32,
  priority_flags: u32,
};
struct OEngineGeometryPageDemandMaskHeaderV1 {
  attempted: atomic<u32>,
  unique: atomic<u32>,
  duplicates: atomic<u32>,
  overflow: atomic<u32>,
};
struct OEngineGeometryPageDemandMaskV1 {
  header: OEngineGeometryPageDemandMaskHeaderV1,
  words: array<atomic<u32>>,
};
fn oengine_geometry_page_demand_mask_try_mark(
  mask: ptr<storage, OEngineGeometryPageDemandMaskV1, read_write>,
  page_id: u32,
  mask_word_count: u32
) -> bool {
  atomicAdd(&(*mask).header.attempted, 1u);
  let word = page_id >> 5u;
  if (word >= mask_word_count) {
    atomicStore(&(*mask).header.overflow, 1u);
    return false;
  }
  let bit = 1u << (page_id & 31u);
  let previous = atomicOr(&(*mask).words[word], bit);
  if ((previous & bit) != 0u) {
    atomicAdd(&(*mask).header.duplicates, 1u);
    return false;
  }
  atomicAdd(&(*mask).header.unique, 1u);
  return true;
}
fn oengine_geometry_page_demand_try_reserve(
  header: ptr<storage, OEngineGeometryPageDemandQueueHeaderV1, read_write>
) -> u32 {
  let attempted = atomicAdd(&(*header).attempted, 1u);
  if (attempted >= (*header).capacity) {
    atomicStore(&(*header).overflow, 1u);
    return 0xffffffffu;
  }
  return attempted;
}
`;

export function packGeometryPageDemandV1(record: GeometryPageDemandV1): Uint8Array<ArrayBuffer> {
  validateDemand(record);
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  view.setUint32(0, record.productTableSlot, true);
  view.setUint32(4, record.productGeneration, true);
  view.setUint32(8, record.pageId, true);
  view.setUint32(12, packPriorityFlags(record), true);
  return bytes;
}

export function unpackGeometryPageDemandV1(bytes: Uint8Array, byteOffset = 0): GeometryPageDemandV1 {
  if (byteOffset < 0 || byteOffset + 16 > bytes.byteLength)
    throw new RangeError("GeometryPageDemand record range is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 16),
    packed = view.getUint32(12, true);
  if ((packed & ~(GEOMETRY_PAGE_DEMAND_FLAGS_MASK | GEOMETRY_PAGE_DEMAND_MAX_PRIORITY)) !== 0)
    throw new RangeError("GeometryPageDemand reserved priority/flags bits are non-zero");
  const record = Object.freeze({
    productTableSlot: view.getUint32(0, true),
    productGeneration: view.getUint32(4, true),
    pageId: view.getUint32(8, true),
    priority: packed & 0xffff,
    currentViewMissing: (packed & GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING) !== 0,
    shadow: (packed & GEOMETRY_PAGE_DEMAND_FLAG_SHADOW) !== 0,
    predictive: (packed & GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE) !== 0,
    ...((packed & GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE) !== 0 ? { residentUsage: true } : {})
  });
  validateDemand(record);
  return record;
}

export function packGeometryPageDemandHeaderV1(
  header: GeometryPageDemandQueueHeaderV1
): Uint8Array<ArrayBuffer> {
  validateHeader(header);
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  view.setUint32(0, header.attempted, true);
  view.setUint32(4, header.capacity, true);
  view.setUint32(8, header.overflow, true);
  view.setUint32(12, header.frameRevisionLow, true);
  return bytes;
}
export function unpackGeometryPageDemandHeaderV1(
  bytes: Uint8Array,
  byteOffset = 0
): GeometryPageDemandQueueHeaderV1 {
  if (byteOffset < 0 || byteOffset + 16 > bytes.byteLength)
    throw new RangeError("GeometryPageDemand header range is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 16),
    header = Object.freeze({
      attempted: view.getUint32(0, true),
      capacity: view.getUint32(4, true),
      overflow: view.getUint32(8, true) as 0 | 1,
      frameRevisionLow: view.getUint32(12, true)
    });
  validateHeader(header);
  return header;
}

export function createGeometryPageDemandQueueV1(
  capacity: number,
  frameRevisionLow: number
): GeometryPageDemandQueueStateV1 {
  assertU32(capacity, "demand capacity");
  assertU32(frameRevisionLow, "frame revision");
  if (capacity === 0) throw new RangeError("demand capacity must be positive");
  return { attempted: 0, capacity, overflow: 0, frameRevisionLow, records: [] };
}
export function reserveGeometryPageDemandV1(
  state: GeometryPageDemandQueueStateV1,
  record: GeometryPageDemandV1
): boolean {
  validateDemand(record);
  if (state.attempted < 0xffffffff) state.attempted++;
  if (state.records.length >= state.capacity) {
    state.overflow = 1;
    return false;
  }
  (state.records as GeometryPageDemandV1[]).push(Object.freeze({ ...record }));
  return true;
}
export function geometryPageDemandMaskWordCountV1(pageCount: number): number {
  assertU32(pageCount, "demand mask page count");
  if (pageCount === 0) throw new RangeError("demand mask page count must be positive");
  const words = Math.ceil(pageCount / 32);
  const bytes = GEOMETRY_PAGE_DEMAND_MASK_HEADER_BYTES_V1 + words * GEOMETRY_PAGE_DEMAND_MASK_WORD_BYTES_V1;
  if (bytes > GEOMETRY_PAGE_DEMAND_MAX_MASK_BYTES_V1) {
    throw new RangeError("demand mask exceeds the bounded mask budget");
  }
  return words;
}
export function createGeometryPageDemandMaskV1(pageCount: number): GeometryPageDemandMaskStateV1 {
  const words = geometryPageDemandMaskWordCountV1(pageCount);
  return { pageCount, words: new Uint32Array(words), attempted: 0, unique: 0, duplicates: 0, overflow: 0 };
}
export function clearGeometryPageDemandMaskV1(state: GeometryPageDemandMaskStateV1): void {
  state.words.fill(0);
  state.attempted = 0;
  state.unique = 0;
  state.duplicates = 0;
  state.overflow = 0;
}
export function markGeometryPageDemandMaskV1(state: GeometryPageDemandMaskStateV1, pageId: number): boolean {
  state.attempted++;
  if (!Number.isSafeInteger(pageId) || pageId < 0 || pageId >= state.pageCount) {
    state.overflow = 1;
    return false;
  }
  const word = pageId >>> 5;
  const bit = 1 << (pageId & 31);
  if ((state.words[word]! & bit) !== 0) {
    state.duplicates++;
    return false;
  }
  state.words[word] = state.words[word]! | bit;
  state.unique++;
  return true;
}
export function deduplicateGeometryPageDemandsV1(
  records: readonly GeometryPageDemandV1[]
): readonly GeometryPageDemandV1[] {
  const batch = new GeometryPageDemandBatchV1();
  batch.setRecords(records);
  return Object.freeze(Array.from(batch.uniqueIndices, (index) => records[index]!));
}

/** Reusable, validated packet storage. Consumers finish synchronously before reuse.
 * Raw records retain packet order; uniqueIndices is the scheduler's priority order.
 * No packed numeric identity: all three unsigned 32-bit identity fields survive.
 */
export class GeometryPageDemandBatchV1 {
  words = new Uint32Array(0);
  #indices = new Uint32Array(0);
  #firstOccurrence = new Uint32Array(0);
  count = 0;
  requested = 0;
  uniqueCount = 0;
  header: GeometryPageDemandQueueHeaderV1 | null = null;

  get uniqueIndices(): Uint32Array {
    return this.#indices.subarray(0, this.uniqueCount);
  }

  decodeRecords(bytes: Uint8Array, header: GeometryPageDemandQueueHeaderV1): void {
    const count = Math.min(header.attempted, header.capacity);
    if (16 + count * 16 > bytes.byteLength) {
      throw new RangeError("GeometryPageDemand readback is truncated");
    }
    this.reset(count);
    this.header = header;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < this.count; index++) {
      const at = index * 4;
      const offset = 16 + index * 16;
      const slot = view.getUint32(offset, true);
      const generation = view.getUint32(offset + 4, true);
      const pageId = view.getUint32(offset + 8, true);
      const packed = view.getUint32(offset + 12, true);
      if ((packed & ~(GEOMETRY_PAGE_DEMAND_FLAGS_MASK | GEOMETRY_PAGE_DEMAND_MAX_PRIORITY)) !== 0) {
        throw new RangeError("GeometryPageDemand reserved priority/flags bits are non-zero");
      }
      if (generation === 0 || pageId === 0xffffffff) {
        throw new RangeError("GeometryPageDemand identity is invalid");
      }
      this.words[at] = slot;
      this.words[at + 1] = generation;
      this.words[at + 2] = pageId;
      this.words[at + 3] = packed;
      if ((packed & GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE) === 0) {
        this.requested++;
      }
    }
    this.deduplicate();
  }

  setRecords(records: readonly GeometryPageDemandV1[]): void {
    this.reset(records.length);
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      validateDemand(record);
      const at = index * 4;
      this.words[at] = record.productTableSlot;
      this.words[at + 1] = record.productGeneration;
      this.words[at + 2] = record.pageId;
      this.words[at + 3] = packPriorityFlags(record);
      if (!record.residentUsage) {
        this.requested++;
      }
    }
    this.deduplicate();
  }

  priority(index: number): number {
    const packed = this.words[index * 4 + 3]!;
    if ((packed & GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE) !== 0) {
      return -1;
    }
    return (
      (packed & 0xffff) +
      ((packed & GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING) !== 0 ? 0x1000000 : 0) +
      ((packed & GEOMETRY_PAGE_DEMAND_FLAG_SHADOW) !== 0 ? 0x800000 : 0) +
      ((packed & GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE) !== 0 ? 0x400000 : 0)
    );
  }

  /** Only persistent scheduler operations need an object, never usage feedback. */
  materialize(index: number): GeometryPageDemandV1 {
    const at = index * 4;
    const packed = this.words[at + 3]!;
    return Object.freeze({
      productTableSlot: this.words[at]!,
      productGeneration: this.words[at + 1]!,
      pageId: this.words[at + 2]!,
      priority: packed & 0xffff,
      currentViewMissing: (packed & GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING) !== 0,
      shadow: (packed & GEOMETRY_PAGE_DEMAND_FLAG_SHADOW) !== 0,
      predictive: (packed & GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE) !== 0,
      ...((packed & GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE) !== 0 ? { residentUsage: true } : {})
    });
  }

  private reset(count: number): void {
    this.count = count;
    this.requested = 0;
    this.uniqueCount = 0;
    this.header = null;
    if (this.#indices.length < count) {
      const capacity = Math.max(count, this.#indices.length * 2, 64);
      this.words = new Uint32Array(capacity * 4);
      this.#indices = new Uint32Array(capacity);
      this.#firstOccurrence = new Uint32Array(capacity);
    }
    for (let index = 0; index < count; index++) {
      this.#indices[index] = index;
    }
  }

  readonly #compareIdentity = (a: number, b: number): number =>
    this.words[a * 4]! - this.words[b * 4]! ||
    this.words[a * 4 + 1]! - this.words[b * 4 + 1]! ||
    this.words[a * 4 + 2]! - this.words[b * 4 + 2]! ||
    a - b;

  readonly #comparePriority = (a: number, b: number): number =>
    this.priority(b) - this.priority(a) ||
    this.words[a * 4]! - this.words[b * 4]! ||
    this.words[a * 4 + 2]! - this.words[b * 4 + 2]! ||
    this.#firstOccurrence[a]! - this.#firstOccurrence[b]!;

  private deduplicate(): void {
    const order = this.#indices.subarray(0, this.count);
    order.sort(this.#compareIdentity);
    let start = 0;
    while (start < this.count) {
      const first = order[start]!;
      let winner = first;
      let end = start + 1;
      while (end < this.count) {
        const candidate = order[end]!;
        if (
          this.words[first * 4] !== this.words[candidate * 4] ||
          this.words[first * 4 + 1] !== this.words[candidate * 4 + 1] ||
          this.words[first * 4 + 2] !== this.words[candidate * 4 + 2]
        ) {
          break;
        }
        if (this.priority(candidate) > this.priority(winner)) {
          winner = candidate;
        }
        end++;
      }
      this.#firstOccurrence[winner] = first;
      this.#indices[this.uniqueCount++] = winner;
      start = end;
    }
    this.uniqueIndices.sort(this.#comparePriority);
  }
}
function packPriorityFlags(record: GeometryPageDemandV1): number {
  return (
    record.priority |
    (record.currentViewMissing ? GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING : 0) |
    (record.shadow ? GEOMETRY_PAGE_DEMAND_FLAG_SHADOW : 0) |
    (record.predictive ? GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE : 0) |
    (record.residentUsage ? GEOMETRY_PAGE_DEMAND_FLAG_RESIDENT_USAGE : 0)
  );
}
function validateDemand(record: GeometryPageDemandV1): void {
  assertU32(record.productTableSlot, "product table slot");
  assertU32(record.productGeneration, "product generation");
  assertU32(record.pageId, "page id");
  assertU32(record.priority, "demand priority");
  if (
    record.productGeneration === 0 ||
    record.pageId === 0xffffffff ||
    record.priority > GEOMETRY_PAGE_DEMAND_MAX_PRIORITY
  )
    throw new RangeError("GeometryPageDemand contains invalid identity/priority");
}
function validateHeader(header: GeometryPageDemandQueueHeaderV1): void {
  assertU32(header.attempted, "demand attempted");
  assertU32(header.capacity, "demand capacity");
  assertU32(header.frameRevisionLow, "frame revision");
  if (
    (header.overflow !== 0 && header.overflow !== 1) ||
    header.attempted < 0 ||
    header.attempted > 0xffffffff
  )
    throw new RangeError("GeometryPageDemand header overflow must be 0/1");
}
function assertU32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError(`${name} must be u32`);
}
