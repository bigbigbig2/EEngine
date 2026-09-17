export const GEOMETRY_PAGE_DEMAND_ABI_VERSION = 1;
export const GEOMETRY_PAGE_DEMAND_HEADER_BYTES = 16;
export const GEOMETRY_PAGE_DEMAND_RECORD_BYTES = 16;
export const GEOMETRY_PAGE_DEMAND_MAX_PRIORITY = 0xffff;
export const GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING = 1 << 16;
export const GEOMETRY_PAGE_DEMAND_FLAG_SHADOW = 1 << 17;
export const GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE = 1 << 18;
export const GEOMETRY_PAGE_DEMAND_DEFAULT_FLAGS_V1 = 0x0001ffff;
export const GEOMETRY_PAGE_DEMAND_FLAGS_MASK = 0x00070000;
/** Readback ring upper bound for one bounded demand queue. */
export const GEOMETRY_PAGE_DEMAND_MAX_QUEUE_BYTES_V1 = 256 * 1024;
export const GEOMETRY_PAGE_DEMAND_MAX_RECORD_CAPACITY_V1 =
  (GEOMETRY_PAGE_DEMAND_MAX_QUEUE_BYTES_V1 -
    GEOMETRY_PAGE_DEMAND_HEADER_BYTES) / GEOMETRY_PAGE_DEMAND_RECORD_BYTES;

export interface GeometryPageDemandV1 {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly pageId: number;
  readonly priority: number;
  readonly currentViewMissing: boolean;
  readonly shadow: boolean;
  readonly predictive: boolean;
}

export interface GeometryPageDemandQueueHeaderV1 {
  readonly attempted: number;
  readonly capacity: number;
  readonly overflow: 0 | 1;
  readonly frameRevisionLow: number;
}

export interface GeometryPageDemandQueueStateV1 { attempted: number; capacity: number; overflow: 0 | 1; frameRevisionLow: number; readonly records: GeometryPageDemandV1[]; }

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
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setUint32(0, record.productTableSlot, true); view.setUint32(4, record.productGeneration, true); view.setUint32(8, record.pageId, true); view.setUint32(12, packPriorityFlags(record), true); return bytes;
}

export function unpackGeometryPageDemandV1(bytes: Uint8Array, byteOffset = 0): GeometryPageDemandV1 {
  if (byteOffset < 0 || byteOffset + 16 > bytes.byteLength) throw new RangeError("GeometryPageDemand record range is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 16), packed = view.getUint32(12, true);
  if ((packed & ~0x0007ffff) !== 0) throw new RangeError("GeometryPageDemand reserved priority/flags bits are non-zero");
  const record = Object.freeze({ productTableSlot: view.getUint32(0, true), productGeneration: view.getUint32(4, true), pageId: view.getUint32(8, true), priority: packed & 0xffff, currentViewMissing: (packed & GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING) !== 0, shadow: (packed & GEOMETRY_PAGE_DEMAND_FLAG_SHADOW) !== 0, predictive: (packed & GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE) !== 0 });
  validateDemand(record); return record;
}

export function packGeometryPageDemandHeaderV1(header: GeometryPageDemandQueueHeaderV1): Uint8Array<ArrayBuffer> { validateHeader(header); const bytes = new Uint8Array(16), view = new DataView(bytes.buffer); view.setUint32(0, header.attempted, true); view.setUint32(4, header.capacity, true); view.setUint32(8, header.overflow, true); view.setUint32(12, header.frameRevisionLow, true); return bytes; }
export function unpackGeometryPageDemandHeaderV1(bytes: Uint8Array, byteOffset = 0): GeometryPageDemandQueueHeaderV1 { if (byteOffset < 0 || byteOffset + 16 > bytes.byteLength) throw new RangeError("GeometryPageDemand header range is invalid"); const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, 16), header = Object.freeze({ attempted: view.getUint32(0, true), capacity: view.getUint32(4, true), overflow: view.getUint32(8, true) as 0 | 1, frameRevisionLow: view.getUint32(12, true) }); validateHeader(header); return header; }

export function createGeometryPageDemandQueueV1(capacity: number, frameRevisionLow: number): GeometryPageDemandQueueStateV1 { assertU32(capacity, "demand capacity"); assertU32(frameRevisionLow, "frame revision"); if (capacity === 0) throw new RangeError("demand capacity must be positive"); return { attempted: 0, capacity, overflow: 0, frameRevisionLow, records: [] }; }
export function reserveGeometryPageDemandV1(state: GeometryPageDemandQueueStateV1, record: GeometryPageDemandV1): boolean { validateDemand(record); if (state.attempted < 0xffffffff) state.attempted++; if (state.records.length >= state.capacity) { state.overflow = 1; return false; } (state.records as GeometryPageDemandV1[]).push(Object.freeze({ ...record })); return true; }
export function deduplicateGeometryPageDemandsV1(records: readonly GeometryPageDemandV1[]): readonly GeometryPageDemandV1[] { const map = new Map<string, GeometryPageDemandV1>(); for (const record of records) { validateDemand(record); const key = `${record.productTableSlot}:${record.productGeneration}:${record.pageId}`; const old = map.get(key); if (!old || demandPriority(record) > demandPriority(old)) map.set(key, record); } return Object.freeze([...map.values()].sort((a, b) => demandPriority(b) - demandPriority(a) || a.productTableSlot - b.productTableSlot || a.pageId - b.pageId)); }
function packPriorityFlags(record: GeometryPageDemandV1): number { return record.priority | (record.currentViewMissing ? GEOMETRY_PAGE_DEMAND_FLAG_CURRENT_VIEW_MISSING : 0) | (record.shadow ? GEOMETRY_PAGE_DEMAND_FLAG_SHADOW : 0) | (record.predictive ? GEOMETRY_PAGE_DEMAND_FLAG_PREDICTIVE : 0); }
function demandPriority(record: GeometryPageDemandV1): number { return record.priority + (record.currentViewMissing ? 0x1000000 : 0) + (record.shadow ? 0x800000 : 0) + (record.predictive ? 0x400000 : 0); }
function validateDemand(record: GeometryPageDemandV1): void { assertU32(record.productTableSlot, "product table slot"); assertU32(record.productGeneration, "product generation"); assertU32(record.pageId, "page id"); assertU32(record.priority, "demand priority"); if (record.productGeneration === 0 || record.pageId === 0xffffffff || record.priority > GEOMETRY_PAGE_DEMAND_MAX_PRIORITY) throw new RangeError("GeometryPageDemand contains invalid identity/priority"); }
function validateHeader(header: GeometryPageDemandQueueHeaderV1): void { assertU32(header.attempted, "demand attempted"); assertU32(header.capacity, "demand capacity"); assertU32(header.frameRevisionLow, "frame revision"); if (header.overflow !== 0 && header.overflow !== 1 || header.attempted < 0 || header.attempted > 0xffffffff) throw new RangeError("GeometryPageDemand header overflow must be 0/1"); }
function assertU32(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be u32`); }
