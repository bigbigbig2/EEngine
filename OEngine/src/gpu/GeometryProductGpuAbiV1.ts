import type { GeometryPageLocationV1 } from "./VirtualGeometryResidency.js";

export const GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1 = 1;
export const GEOMETRY_PAGE_LOCATION_STRIDE = 16;
export const GEOMETRY_PAGE_LOCATION_NON_RESIDENT = 0xffffffff;
export const GEOMETRY_PAGE_LOCATION_RESIDENT = 1;
export const GEOMETRY_PAGE_LOCATION_PINNED = 2;
export const GEOMETRY_PRODUCT_GPU_PAGE_SHIFT_V1 = 18;
export const GEOMETRY_PRODUCT_GPU_PAGE_BYTES_V1 = 1 << GEOMETRY_PRODUCT_GPU_PAGE_SHIFT_V1;
export const GEOMETRY_PRODUCT_GPU_BANK_COUNT_MAX_V1 = 4;
export const GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1 = 512;
export const GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1 = 64;
export const GEOMETRY_PRODUCT_ASSET_REFERENCE_STRIDE_V1 = 16;
export const GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1 = 1;
export const GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1 = 64;

export interface GeometryProductMetadataHeapHeaderV1 { readonly productCount: number; readonly productCapacity: number; readonly totalWords: number; readonly productTableWordOffset: number; readonly assetReferenceWordOffset: number; readonly assetRecordWordOffset: number; readonly rootNodeIdWordOffset: number; readonly hierarchyWordOffset: number; readonly groupDirectoryWordOffset: number; readonly pageLocationWordOffset: number; readonly vertexFormatWordOffset: number; }

export interface GeometryProductTableRecordV1 {
  readonly productGeneration: number;
  readonly flags: number;
  readonly assetBegin: number; readonly assetCount: number;
  readonly rootBegin: number; readonly rootCount: number;
  readonly hierarchyBegin: number; readonly hierarchyCount: number;
  readonly groupBegin: number; readonly groupCount: number;
  readonly pageBegin: number; readonly pageCount: number;
  readonly vertexFormatBegin: number; readonly vertexFormatCount: number;
}

export interface GeometryProductAssetReferenceV1 { readonly productTableSlot: number; readonly productGeneration: number; readonly assetRecordIndex: number; readonly flags: 0; }
export interface GeometryProductResolvedAssetV1 { readonly productTableSlot: number; readonly productGeneration: number; readonly assetWordOffset: number; readonly rootWordOffset: number; readonly rootCount: number; readonly hierarchyWordOffset: number; readonly hierarchyCount: number; readonly groupWordOffset: number; readonly groupCount: number; readonly pageLocationWordOffset: number; readonly pageCount: number; readonly vertexFormatWordOffset: number; readonly vertexFormatCount: number; }

export interface GeometryProductGpuLocationValidationV1 {
  readonly valid: boolean;
  readonly resident: boolean;
  readonly bankIndex: number;
  readonly slotIndex: number;
  readonly productGeneration: number;
  readonly flags: number;
  readonly byteOffset: number;
}

export function encodeGeometryProductGpuLocationV1(location: GeometryPageLocationV1 | undefined): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(GEOMETRY_PAGE_LOCATION_STRIDE); const view = new DataView(bytes.buffer);
  if (location === undefined) { view.setUint32(0, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); view.setUint32(4, GEOMETRY_PAGE_LOCATION_NON_RESIDENT, true); return bytes; }
  if (!Number.isInteger(location.bankIndex) || location.bankIndex < 0 || location.bankIndex >= GEOMETRY_PRODUCT_GPU_BANK_COUNT_MAX_V1 || !Number.isInteger(location.slotIndex) || location.slotIndex < 0 || location.slotIndex >= GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1 || !Number.isInteger(location.productGeneration) || location.productGeneration <= 0 || location.productGeneration === 0xffffffff || (location.flags & ~3) !== 0 || (location.flags & GEOMETRY_PAGE_LOCATION_RESIDENT) === 0) throw new RangeError("invalid GeometryPageLocationV1");
  view.setUint32(0, location.bankIndex, true); view.setUint32(4, location.slotIndex, true); view.setUint32(8, location.productGeneration, true); view.setUint32(12, location.flags, true); return bytes;
}

export function validateGeometryProductGpuLocationV1(bytes: Uint8Array, expectedGeneration: number): GeometryProductGpuLocationValidationV1 {
  if (bytes.byteLength < GEOMETRY_PAGE_LOCATION_STRIDE) throw new RangeError("GeometryPageLocationV1 record is truncated");
  if (!Number.isInteger(expectedGeneration) || expectedGeneration <= 0 || expectedGeneration === 0xffffffff) throw new RangeError("expected generation is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, GEOMETRY_PAGE_LOCATION_STRIDE), bankIndex = view.getUint32(0, true), slotIndex = view.getUint32(4, true), productGeneration = view.getUint32(8, true), flags = view.getUint32(12, true);
  const resident = (flags & GEOMETRY_PAGE_LOCATION_RESIDENT) !== 0;
  const validFlags = (flags & ~(GEOMETRY_PAGE_LOCATION_RESIDENT | GEOMETRY_PAGE_LOCATION_PINNED)) === 0;
  const valid = resident && validFlags && bankIndex < GEOMETRY_PRODUCT_GPU_BANK_COUNT_MAX_V1 && slotIndex < GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1 && productGeneration === expectedGeneration;
  return Object.freeze({ valid, resident, bankIndex, slotIndex, productGeneration, flags, byteOffset: valid ? slotIndex * GEOMETRY_PRODUCT_GPU_PAGE_BYTES_V1 : 0 });
}

export function packGeometryProductTableRecordV1(record: GeometryProductTableRecordV1): Uint8Array<ArrayBuffer> {
  for (const [name, value] of Object.entries(record)) assertU32(value, name);
  if (record.productGeneration === 0 || record.productGeneration === 0xffffffff || (record.flags & ~GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1) !== 0) throw new RangeError("invalid Geometry Product table identity/flags");
  for (const [begin, count, name] of [[record.assetBegin, record.assetCount, "asset"], [record.rootBegin, record.rootCount, "root"], [record.hierarchyBegin, record.hierarchyCount, "hierarchy"], [record.groupBegin, record.groupCount, "group"], [record.pageBegin, record.pageCount, "page"], [record.vertexFormatBegin, record.vertexFormatCount, "vertex format"]] as const) if (begin + count > 0x100000000) throw new RangeError(`Geometry Product ${name} range overflows u32`);
  const values = [record.productGeneration, record.flags, record.assetBegin, record.assetCount, record.rootBegin, record.rootCount, record.hierarchyBegin, record.hierarchyCount, record.groupBegin, record.groupCount, record.pageBegin, record.pageCount, record.vertexFormatBegin, record.vertexFormatCount, 0, 0];
  return new Uint8Array(new Uint32Array(values).buffer);
}

export function packGeometryProductMetadataHeapHeaderV1(header: GeometryProductMetadataHeapHeaderV1): Uint8Array<ArrayBuffer> { for (const [name, value] of Object.entries(header)) assertU32(value, name); if (header.productCount > header.productCapacity || header.productCapacity === 0 || header.totalWords < 16) throw new RangeError("invalid Geometry Product metadata heap counts"); const offsets = [header.productTableWordOffset, header.assetReferenceWordOffset, header.assetRecordWordOffset, header.rootNodeIdWordOffset, header.hierarchyWordOffset, header.groupDirectoryWordOffset, header.pageLocationWordOffset, header.vertexFormatWordOffset]; if (header.productTableWordOffset < 16 || offsets.some(value => (value & 3) !== 0 || value >= header.totalWords) || offsets.some((value, index) => index > 0 && value < offsets[index - 1]!) || !recordRange(header.productTableWordOffset, header.assetReferenceWordOffset, 0, header.productCapacity, 16)) throw new RangeError("invalid Geometry Product metadata heap offsets"); return new Uint8Array(new Uint32Array([GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1, header.productCount, header.productCapacity, header.totalWords, ...offsets, 0, 0, 0, 0]).buffer); }
export function unpackGeometryProductMetadataHeapHeaderV1(bytes: Uint8Array, byteOffset = 0): GeometryProductMetadataHeapHeaderV1 { assertRange(bytes, byteOffset, GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1); const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, GEOMETRY_PRODUCT_METADATA_HEAP_HEADER_BYTES_V1); if (view.getUint32(0, true) !== GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1 || [48, 52, 56, 60].some(offset => view.getUint32(offset, true) !== 0)) throw new RangeError("Geometry Product metadata heap version/reserved fields are invalid"); const record = { productCount: view.getUint32(4, true), productCapacity: view.getUint32(8, true), totalWords: view.getUint32(12, true), productTableWordOffset: view.getUint32(16, true), assetReferenceWordOffset: view.getUint32(20, true), assetRecordWordOffset: view.getUint32(24, true), rootNodeIdWordOffset: view.getUint32(28, true), hierarchyWordOffset: view.getUint32(32, true), groupDirectoryWordOffset: view.getUint32(36, true), pageLocationWordOffset: view.getUint32(40, true), vertexFormatWordOffset: view.getUint32(44, true) }; packGeometryProductMetadataHeapHeaderV1(record); return Object.freeze(record); }

export function unpackGeometryProductTableRecordV1(bytes: Uint8Array, byteOffset = 0): GeometryProductTableRecordV1 {
  assertRange(bytes, byteOffset, GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1); const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1);
  if (view.getUint32(56, true) !== 0 || view.getUint32(60, true) !== 0) throw new RangeError("Geometry Product table reserved fields are non-zero");
  const record = { productGeneration: view.getUint32(0, true), flags: view.getUint32(4, true), assetBegin: view.getUint32(8, true), assetCount: view.getUint32(12, true), rootBegin: view.getUint32(16, true), rootCount: view.getUint32(20, true), hierarchyBegin: view.getUint32(24, true), hierarchyCount: view.getUint32(28, true), groupBegin: view.getUint32(32, true), groupCount: view.getUint32(36, true), pageBegin: view.getUint32(40, true), pageCount: view.getUint32(44, true), vertexFormatBegin: view.getUint32(48, true), vertexFormatCount: view.getUint32(52, true) };
  packGeometryProductTableRecordV1(record); return Object.freeze(record);
}

export function packGeometryProductAssetReferenceV1(reference: GeometryProductAssetReferenceV1): Uint8Array<ArrayBuffer> { assertU32(reference.productTableSlot, "productTableSlot"); assertU32(reference.productGeneration, "productGeneration"); assertU32(reference.assetRecordIndex, "assetRecordIndex"); if (reference.productGeneration === 0 || reference.productGeneration === 0xffffffff || reference.assetRecordIndex === 0xffffffff || reference.flags !== 0) throw new RangeError("invalid Geometry Product asset reference"); return new Uint8Array(new Uint32Array([reference.productTableSlot, reference.productGeneration, reference.assetRecordIndex, 0]).buffer); }
export function unpackGeometryProductAssetReferenceV1(bytes: Uint8Array, byteOffset = 0): GeometryProductAssetReferenceV1 { assertRange(bytes, byteOffset, GEOMETRY_PRODUCT_ASSET_REFERENCE_STRIDE_V1); const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, GEOMETRY_PRODUCT_ASSET_REFERENCE_STRIDE_V1), record = { productTableSlot: view.getUint32(0, true), productGeneration: view.getUint32(4, true), assetRecordIndex: view.getUint32(8, true), flags: view.getUint32(12, true) as 0 }; packGeometryProductAssetReferenceV1(record); return Object.freeze(record); }

export function resolveGeometryProductAssetFromHeapV1(bytes: Uint8Array, geometrySlot: number, expectedGeneration: number): GeometryProductResolvedAssetV1 | undefined {
  assertU32(geometrySlot, "geometrySlot"); assertU32(expectedGeneration, "expectedGeneration"); if (expectedGeneration === 0 || expectedGeneration === 0xffffffff) return undefined;
  let header: GeometryProductMetadataHeapHeaderV1; try { header = unpackGeometryProductMetadataHeapHeaderV1(bytes); } catch { return undefined; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), words = Math.floor(bytes.byteLength / 4); if (header.totalWords > words || !recordRange(header.assetReferenceWordOffset, header.assetRecordWordOffset, geometrySlot, 1, 4)) return undefined;
  const referenceAt = (header.assetReferenceWordOffset + geometrySlot * 4) * 4, slot = view.getUint32(referenceAt, true), generation = view.getUint32(referenceAt + 4, true), localAsset = view.getUint32(referenceAt + 8, true), referenceFlags = view.getUint32(referenceAt + 12, true);
  if (referenceFlags !== 0 || generation !== expectedGeneration || slot >= header.productCount || !recordRange(header.productTableWordOffset, header.assetReferenceWordOffset, slot, 1, 16)) return undefined;
  const productAt = (header.productTableWordOffset + slot * 16) * 4, productBytes = bytes.subarray(productAt, productAt + 64); let product: GeometryProductTableRecordV1; try { product = unpackGeometryProductTableRecordV1(productBytes); } catch { return undefined; }
  if (product.productGeneration !== generation || product.flags !== GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1 || localAsset >= product.assetCount || localAsset > 0xffffffff - product.assetBegin) return undefined;
  const assetIndex = product.assetBegin + localAsset;
  if (!recordRange(header.assetRecordWordOffset, header.rootNodeIdWordOffset, assetIndex, 1, 32) || !recordRange(header.rootNodeIdWordOffset, header.hierarchyWordOffset, product.rootBegin, product.rootCount, 1) || !recordRange(header.hierarchyWordOffset, header.groupDirectoryWordOffset, product.hierarchyBegin, product.hierarchyCount, 12) || !recordRange(header.groupDirectoryWordOffset, header.pageLocationWordOffset, product.groupBegin, product.groupCount, 4) || !recordRange(header.pageLocationWordOffset, header.vertexFormatWordOffset, product.pageBegin, product.pageCount, 4) || !recordRange(header.vertexFormatWordOffset, header.totalWords, product.vertexFormatBegin, product.vertexFormatCount, 4)) return undefined;
  const assetAt = (header.assetRecordWordOffset + assetIndex * 32) * 4, assetRootBegin = view.getUint32(assetAt + 72, true), assetRootCount = view.getUint32(assetAt + 76, true), assetHierarchyBegin = view.getUint32(assetAt + 80, true), assetHierarchyCount = view.getUint32(assetAt + 84, true), assetGroupBegin = view.getUint32(assetAt + 88, true), assetGroupCount = view.getUint32(assetAt + 92, true);
  if (!contained(assetRootBegin, assetRootCount, product.rootBegin, product.rootCount) || !contained(assetHierarchyBegin, assetHierarchyCount, product.hierarchyBegin, product.hierarchyCount) || !contained(assetGroupBegin, assetGroupCount, product.groupBegin, product.groupCount)) return undefined;
  return Object.freeze({ productTableSlot: slot, productGeneration: generation, assetWordOffset: assetAt / 4, rootWordOffset: header.rootNodeIdWordOffset + assetRootBegin, rootCount: assetRootCount, hierarchyWordOffset: header.hierarchyWordOffset + assetHierarchyBegin * 12, hierarchyCount: assetHierarchyCount, groupWordOffset: header.groupDirectoryWordOffset + assetGroupBegin * 4, groupCount: assetGroupCount, pageLocationWordOffset: header.pageLocationWordOffset + product.pageBegin * 4, pageCount: product.pageCount, vertexFormatWordOffset: header.vertexFormatWordOffset + product.vertexFormatBegin * 4, vertexFormatCount: product.vertexFormatCount });
}

/** WGSL mirror: fail-closed location lookup before any physical bank access. */
export const GEOMETRY_PRODUCT_GPU_WGSL_V1 = /* wgsl */ `
const OENGINE_GEOMETRY_PAGE_LOCATION_STRIDE_V1: u32 = 4u;
const OENGINE_GEOMETRY_PAGE_LOCATION_RESIDENT_V1: u32 = 1u;
const OENGINE_GEOMETRY_PAGE_LOCATION_PINNED_V1: u32 = 2u;
const OENGINE_GEOMETRY_PAGE_LOCATION_NON_RESIDENT_V1: u32 = 0xffffffffu;
const OENGINE_GEOMETRY_PAGE_SHIFT_V1: u32 = 18u;
const OENGINE_GEOMETRY_BANK_COUNT_MAX_V1: u32 = ${GEOMETRY_PRODUCT_GPU_BANK_COUNT_MAX_V1}u;
const OENGINE_GEOMETRY_SLOTS_PER_BANK_V1: u32 = ${GEOMETRY_PRODUCT_GPU_SLOTS_PER_BANK_V1}u;
struct OEngineGeometryPageLocationV1 { bank_index: u32, slot_index: u32, product_generation: u32, flags: u32 };
struct OEngineGeometryProductMetadataHeapHeaderV1 { abi_version: u32, product_count: u32, product_capacity: u32, total_words: u32, product_table_word_offset: u32, asset_reference_word_offset: u32, asset_record_word_offset: u32, root_node_id_word_offset: u32, hierarchy_word_offset: u32, group_directory_word_offset: u32, page_location_word_offset: u32, vertex_format_word_offset: u32, reserved0: u32, reserved1: u32, reserved2: u32, reserved3: u32 };
struct OEngineGeometryProductTableRecordV1 { product_generation: u32, flags: u32, asset_begin: u32, asset_count: u32, root_begin: u32, root_count: u32, hierarchy_begin: u32, hierarchy_count: u32, group_begin: u32, group_count: u32, page_begin: u32, page_count: u32, vertex_format_begin: u32, vertex_format_count: u32, reserved0: u32, reserved1: u32 };
struct OEngineGeometryProductAssetReferenceV1 { product_table_slot: u32, product_generation: u32, asset_record_index: u32, flags: u32 };
struct OEngineGeometryProductAssetLookupV1 { valid: bool, product_table_slot: u32, product_generation: u32, asset_record_index: u32 };
struct OEngineGeometryProductResolvedAssetV1 { valid: bool, product_table_slot: u32, product_generation: u32, asset_word_offset: u32, root_word_offset: u32, root_count: u32, hierarchy_word_offset: u32, hierarchy_count: u32, group_word_offset: u32, group_count: u32, page_location_word_offset: u32, page_count: u32, vertex_format_word_offset: u32, vertex_format_count: u32 };
struct OEngineGeometryPageLookupV1 { valid: bool, bank_index: u32, byte_offset: u32, flags: u32 };
fn oengine_geometry_product_invalid_asset_v1() -> OEngineGeometryProductResolvedAssetV1 { return OEngineGeometryProductResolvedAssetV1(false, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u); }
fn oengine_geometry_product_record_range_v1(section_begin: u32, section_end: u32, record_begin: u32, record_count: u32, stride_words: u32) -> bool {
  if (stride_words == 0u || section_begin > section_end) { return false; }
  let capacity = (section_end - section_begin) / stride_words;
  return record_begin <= capacity && record_count <= capacity - record_begin;
}
fn oengine_geometry_product_contained_v1(begin: u32, count: u32, outer_begin: u32, outer_count: u32) -> bool {
  return count != 0u && begin >= outer_begin && outer_count <= 0xffffffffu - outer_begin && begin <= 0xffffffffu - count && begin + count <= outer_begin + outer_count;
}
fn oengine_geometry_product_resolve_asset_v1(heap: ptr<storage, array<u32>, read>, geometry_slot: u32, expected_generation: u32) -> OEngineGeometryProductResolvedAssetV1 {
  if (arrayLength(heap) < 16u || (*heap)[0] != ${GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1}u || (*heap)[12] != 0u || (*heap)[13] != 0u || (*heap)[14] != 0u || (*heap)[15] != 0u) { return oengine_geometry_product_invalid_asset_v1(); }
  let product_count = (*heap)[1]; let product_capacity = (*heap)[2]; let total_words = (*heap)[3]; if (total_words > arrayLength(heap) || product_capacity == 0u || product_count > product_capacity || expected_generation == 0u || expected_generation == 0xffffffffu) { return oengine_geometry_product_invalid_asset_v1(); }
  let product_table_words = (*heap)[4]; let reference_words = (*heap)[5]; let asset_words = (*heap)[6]; let root_words = (*heap)[7]; let hierarchy_words = (*heap)[8]; let group_words = (*heap)[9]; let location_words = (*heap)[10]; let vertex_format_words = (*heap)[11];
  if (product_table_words < 16u || ((product_table_words | reference_words | asset_words | root_words | hierarchy_words | group_words | location_words | vertex_format_words) & 3u) != 0u || product_table_words > reference_words || reference_words > asset_words || asset_words > root_words || root_words > hierarchy_words || hierarchy_words > group_words || group_words > location_words || location_words > vertex_format_words || vertex_format_words >= total_words || !oengine_geometry_product_record_range_v1(product_table_words, reference_words, 0u, product_capacity, 16u) || !oengine_geometry_product_record_range_v1(reference_words, asset_words, geometry_slot, 1u, 4u)) { return oengine_geometry_product_invalid_asset_v1(); }
  let reference = reference_words + geometry_slot * 4u; let product_slot = (*heap)[reference]; let generation = (*heap)[reference + 1u]; let local_asset = (*heap)[reference + 2u];
  if ((*heap)[reference + 3u] != 0u || generation != expected_generation || product_slot >= product_count || !oengine_geometry_product_record_range_v1(product_table_words, reference_words, product_slot, 1u, 16u)) { return oengine_geometry_product_invalid_asset_v1(); }
  let product = product_table_words + product_slot * 16u; let flags = (*heap)[product + 1u]; if ((*heap)[product] != generation || flags != ${GEOMETRY_PRODUCT_TABLE_FLAG_ACTIVE_V1}u || (*heap)[product + 14u] != 0u || (*heap)[product + 15u] != 0u || local_asset >= (*heap)[product + 3u]) { return oengine_geometry_product_invalid_asset_v1(); }
  let asset_begin = (*heap)[product + 2u]; if (local_asset > 0xffffffffu - asset_begin) { return oengine_geometry_product_invalid_asset_v1(); } let asset_index = asset_begin + local_asset; let root_begin = (*heap)[product + 4u]; let root_count = (*heap)[product + 5u]; let hierarchy_begin = (*heap)[product + 6u]; let hierarchy_count = (*heap)[product + 7u]; let group_begin = (*heap)[product + 8u]; let group_count = (*heap)[product + 9u]; let page_begin = (*heap)[product + 10u]; let page_count = (*heap)[product + 11u]; let format_begin = (*heap)[product + 12u]; let format_count = (*heap)[product + 13u];
  if (!oengine_geometry_product_record_range_v1(asset_words, root_words, asset_index, 1u, 32u) || !oengine_geometry_product_record_range_v1(root_words, hierarchy_words, root_begin, root_count, 1u) || !oengine_geometry_product_record_range_v1(hierarchy_words, group_words, hierarchy_begin, hierarchy_count, 12u) || !oengine_geometry_product_record_range_v1(group_words, location_words, group_begin, group_count, 4u) || !oengine_geometry_product_record_range_v1(location_words, vertex_format_words, page_begin, page_count, 4u) || !oengine_geometry_product_record_range_v1(vertex_format_words, total_words, format_begin, format_count, 4u)) { return oengine_geometry_product_invalid_asset_v1(); }
  let asset = asset_words + asset_index * 32u; let asset_root_begin = (*heap)[asset + 18u]; let asset_root_count = (*heap)[asset + 19u]; let asset_hierarchy_begin = (*heap)[asset + 20u]; let asset_hierarchy_count = (*heap)[asset + 21u]; let asset_group_begin = (*heap)[asset + 22u]; let asset_group_count = (*heap)[asset + 23u];
  if (!oengine_geometry_product_contained_v1(asset_root_begin, asset_root_count, root_begin, root_count) || !oengine_geometry_product_contained_v1(asset_hierarchy_begin, asset_hierarchy_count, hierarchy_begin, hierarchy_count) || !oengine_geometry_product_contained_v1(asset_group_begin, asset_group_count, group_begin, group_count)) { return oengine_geometry_product_invalid_asset_v1(); }
  return OEngineGeometryProductResolvedAssetV1(true, product_slot, generation, asset, root_words + asset_root_begin, asset_root_count, hierarchy_words + asset_hierarchy_begin * 12u, asset_hierarchy_count, group_words + asset_group_begin * 4u, asset_group_count, location_words + page_begin * 4u, page_count, vertex_format_words + format_begin * 4u, format_count);
}
fn oengine_geometry_product_lookup_page_heap_v1(heap: ptr<storage, array<u32>, read>, asset: OEngineGeometryProductResolvedAssetV1, page_id: u32) -> OEngineGeometryPageLookupV1 { if (!asset.valid || page_id >= asset.page_count) { return OEngineGeometryPageLookupV1(false, 0u, 0u, 0u); } let at = asset.page_location_word_offset + page_id * 4u; if (at > arrayLength(heap) || arrayLength(heap) - at < 4u) { return OEngineGeometryPageLookupV1(false, 0u, 0u, 0u); } let bank = (*heap)[at]; let slot = (*heap)[at + 1u]; let generation = (*heap)[at + 2u]; let flags = (*heap)[at + 3u]; let valid = (flags & OENGINE_GEOMETRY_PAGE_LOCATION_RESIDENT_V1) != 0u && (flags & ~(OENGINE_GEOMETRY_PAGE_LOCATION_RESIDENT_V1 | OENGINE_GEOMETRY_PAGE_LOCATION_PINNED_V1)) == 0u && bank < OENGINE_GEOMETRY_BANK_COUNT_MAX_V1 && slot < OENGINE_GEOMETRY_SLOTS_PER_BANK_V1 && generation == asset.product_generation; return OEngineGeometryPageLookupV1(valid, bank, select(0u, slot << OENGINE_GEOMETRY_PAGE_SHIFT_V1, valid), flags); }
fn oengine_geometry_product_lookup_asset_v1(products: ptr<storage, array<OEngineGeometryProductTableRecordV1>, read>, refs: ptr<storage, array<OEngineGeometryProductAssetReferenceV1>, read>, geometry_slot: u32, expected_generation: u32) -> OEngineGeometryProductAssetLookupV1 {
  if (geometry_slot >= arrayLength(refs)) { return OEngineGeometryProductAssetLookupV1(false, 0u, 0u, 0u); }
  let reference = (*refs)[geometry_slot]; if (reference.flags != 0u || reference.product_generation != expected_generation || reference.product_table_slot >= arrayLength(products)) { return OEngineGeometryProductAssetLookupV1(false, 0u, 0u, 0u); }
  let product = (*products)[reference.product_table_slot]; let valid = (product.flags & 1u) != 0u && (product.flags & ~1u) == 0u && product.reserved0 == 0u && product.reserved1 == 0u && product.product_generation == expected_generation && reference.asset_record_index < product.asset_count;
  return OEngineGeometryProductAssetLookupV1(valid, reference.product_table_slot, reference.product_generation, product.asset_begin + reference.asset_record_index);
}
fn oengine_geometry_product_lookup_page_v1(
  locations: ptr<storage, array<OEngineGeometryPageLocationV1>, read>,
  page_id: u32, page_count: u32, expected_generation: u32
) -> OEngineGeometryPageLookupV1 {
  if (page_id >= page_count) { return OEngineGeometryPageLookupV1(false, 0u, 0u, 0u); }
  let location = (*locations)[page_id];
  let valid_flags = (location.flags & ~(OENGINE_GEOMETRY_PAGE_LOCATION_RESIDENT_V1 | OENGINE_GEOMETRY_PAGE_LOCATION_PINNED_V1)) == 0u;
  let valid = valid_flags && (location.flags & OENGINE_GEOMETRY_PAGE_LOCATION_RESIDENT_V1) != 0u && location.bank_index < OENGINE_GEOMETRY_BANK_COUNT_MAX_V1 && location.slot_index < OENGINE_GEOMETRY_SLOTS_PER_BANK_V1 && location.product_generation == expected_generation;
  if (!valid) { return OEngineGeometryPageLookupV1(false, 0u, 0u, 0u); }
  return OEngineGeometryPageLookupV1(true, location.bank_index, location.slot_index << OENGINE_GEOMETRY_PAGE_SHIFT_V1, location.flags);
}
`;

function assertU32(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be u32`); }
function assertRange(bytes: Uint8Array, byteOffset: number, byteLength: number): void { if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + byteLength > bytes.byteLength) throw new RangeError("Geometry Product GPU record range is invalid"); }
function recordRange(sectionBegin: number, sectionEnd: number, recordBegin: number, recordCount: number, stride: number): boolean { if (stride <= 0 || sectionBegin > sectionEnd) return false; const capacity = Math.floor((sectionEnd - sectionBegin) / stride); return recordBegin <= capacity && recordCount <= capacity - recordBegin; }
function contained(begin: number, count: number, outerBegin: number, outerCount: number): boolean { return count > 0 && begin >= outerBegin && begin <= 0xffffffff - count && outerBegin <= 0xffffffff - outerCount && begin + count <= outerBegin + outerCount; }
