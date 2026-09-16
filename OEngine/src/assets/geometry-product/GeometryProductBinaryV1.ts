import {
  OEGPACK_V3_ASSET_STRIDE,
  OEGPACK_V3_GROUP_DIRECTORY_STRIDE,
  OEGPACK_V3_HIERARCHY_STRIDE,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_VERTEX_FORMAT_STRIDE
} from "../GeometryAbiV3.js";
import {
  GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE,
  GEOMETRY_PRODUCT_RUNTIME_PROFILE,
  assertGeometryProductDescriptorV1,
  type GeometryProductDescriptorV1,
  type GeometryProductProducerKind,
  type GeometryProductSourceIdentityKind
} from "./GeometryProductV1.js";

export const GEOMETRY_PRODUCT_BINARY_MAGIC_V1 = 0x5047454f;
export const GEOMETRY_PRODUCT_BINARY_VERSION_V1 = 1;
export const GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1 = 256;

const PROFILE_V1 = 1;
const FLAG_REPLACES = 1;
const SECTION_ALIGNMENT = 16;

const PRODUCER_KIND: Readonly<Record<GeometryProductProducerKind, number>> = Object.freeze({ "web-runtime": 1, "offline-native": 2 });
const SOURCE_KIND: Readonly<Record<GeometryProductSourceIdentityKind, number>> = Object.freeze({ "content-sha256": 1, "strong-http-validator": 2, session: 3 });

interface Section {
  readonly bytes: Uint8Array;
  readonly count: number;
  readonly stride: number;
  offset: number;
}

export function encodeGeometryProductDescriptorBinaryV1(descriptor: GeometryProductDescriptorV1): ArrayBuffer {
  assertGeometryProductDescriptorV1(descriptor);
  const encoder = new TextEncoder();
  const producerId = encoder.encode(descriptor.producerId), producerVersion = encoder.encode(descriptor.producerVersion);
  if (producerId.byteLength === 0 || producerVersion.byteLength === 0) throw new RangeError("Geometry Product producer strings must be non-empty");
  const sections: Section[] = [
    section(descriptor.assetRecords, OEGPACK_V3_ASSET_STRIDE),
    section(u32Bytes(descriptor.rootNodeIds), 4),
    section(descriptor.hierarchyNodes, OEGPACK_V3_HIERARCHY_STRIDE),
    section(descriptor.groupDirectory, OEGPACK_V3_GROUP_DIRECTORY_STRIDE),
    section(descriptor.pageRecords, GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE),
    section(u32Bytes(descriptor.bootstrapPageIds), 4),
    section(descriptor.vertexFormats, OEGPACK_V3_VERTEX_FORMAT_STRIDE),
    section(u32Bytes(descriptor.activationPageIds), 4),
    section(producerId, 1),
    section(producerVersion, 1)
  ];
  let cursor = GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1;
  for (const item of sections) { cursor = align(cursor); item.offset = cursor; cursor = checkedAdd(cursor, item.bytes.byteLength); }
  const totalBytes = align(cursor); assertU32(totalBytes, "descriptor totalBytes");
  const output = new Uint8Array(totalBytes), view = new DataView(output.buffer);
  writeU32(view, 0, GEOMETRY_PRODUCT_BINARY_MAGIC_V1); writeU32(view, 4, GEOMETRY_PRODUCT_BINARY_VERSION_V1); writeU32(view, 8, GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1); writeU32(view, 12, totalBytes);
  writeU32(view, 16, PROFILE_V1); writeU32(view, 20, PRODUCER_KIND[descriptor.producerKind]); writeU32(view, 24, SOURCE_KIND[descriptor.sourceIdentityKind]); writeU32(view, 28, descriptor.replaces ? FLAG_REPLACES : 0);
  writeU32(view, 32, descriptor.revision); writeU32(view, 36, descriptor.decodedPageBytes);
  sections.slice(0, 8).forEach((item, index) => writeU32(view, 40 + index * 4, item.count));
  writeU32(view, 72, producerId.byteLength); writeU32(view, 76, producerVersion.byteLength);
  sections.forEach((item, index) => writeU32(view, 80 + index * 4, item.offset));
  writeU32(view, 120, descriptor.replaces?.revision ?? 0); writeU32(view, 124, 0);
  output.set(descriptor.productId, 128); output.set(descriptor.sourceIdentityHash, 160); output.set(descriptor.recipeHash, 192); if (descriptor.replaces) output.set(descriptor.replaces.productId, 224);
  for (const item of sections) output.set(item.bytes, item.offset);
  return output.buffer;
}

export function decodeGeometryProductDescriptorBinaryV1(buffer: ArrayBuffer): GeometryProductDescriptorV1 {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1) throw new RangeError("Geometry Product descriptor binary is truncated");
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (view.getUint32(0, true) !== GEOMETRY_PRODUCT_BINARY_MAGIC_V1 || view.getUint32(4, true) !== GEOMETRY_PRODUCT_BINARY_VERSION_V1 || view.getUint32(8, true) !== GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1) throw new RangeError("Geometry Product descriptor binary header is unsupported");
  if (view.getUint32(12, true) !== bytes.byteLength) throw new RangeError("Geometry Product descriptor totalBytes is not canonical");
  if (view.getUint32(16, true) !== PROFILE_V1 || view.getUint32(36, true) !== OEGPACK_V3_PAGE_BYTES) throw new RangeError("Geometry Product descriptor profile is unsupported");
  const producerKind = decodeEnum(view.getUint32(20, true), ["web-runtime", "offline-native"] as const, "producer kind");
  const sourceIdentityKind = decodeEnum(view.getUint32(24, true), ["content-sha256", "strong-http-validator", "session"] as const, "source identity kind");
  const flags = view.getUint32(28, true); if ((flags & ~FLAG_REPLACES) !== 0 || view.getUint32(124, true) !== 0) throw new RangeError("Geometry Product descriptor reserved fields are non-zero");
  const strides = [OEGPACK_V3_ASSET_STRIDE, 4, OEGPACK_V3_HIERARCHY_STRIDE, OEGPACK_V3_GROUP_DIRECTORY_STRIDE, GEOMETRY_PRODUCT_PAGE_RECORD_STRIDE, 4, OEGPACK_V3_VERTEX_FORMAT_STRIDE, 4, 1, 1];
  const counts = Array.from({ length: 8 }, (_, index) => view.getUint32(40 + index * 4, true)); counts.push(view.getUint32(72, true), view.getUint32(76, true));
  const offsets = Array.from({ length: 10 }, (_, index) => view.getUint32(80 + index * 4, true));
  let cursor = GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1;
  const ranges = offsets.map((offset, index) => { cursor = align(cursor); const byteLength = checkedMultiply(counts[index]!, strides[index]!); if (offset !== cursor || (offset & (SECTION_ALIGNMENT - 1)) !== 0) throw new RangeError(`Geometry Product section ${index} offset is not canonical`); const end = checkedAdd(offset, byteLength); if (end > bytes.byteLength) throw new RangeError(`Geometry Product section ${index} is out of range`); cursor = end; return { offset, byteLength }; });
  if (align(cursor) !== bytes.byteLength) throw new RangeError("Geometry Product descriptor has trailing or missing bytes");
  let previousEnd = GEOMETRY_PRODUCT_BINARY_HEADER_BYTES_V1; for (const range of ranges) { assertZero(bytes, previousEnd, range.offset); previousEnd = range.offset + range.byteLength; } assertZero(bytes, previousEnd, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true }); const producerId = decoder.decode(sliceRange(bytes, ranges[8]!)), producerVersion = decoder.decode(sliceRange(bytes, ranges[9]!));
  if (!producerId || !producerVersion || producerId.includes("\0") || producerVersion.includes("\0")) throw new RangeError("Geometry Product producer strings are invalid");
  const replacesBytes = bytes.slice(224, 256), hasReplacement = (flags & FLAG_REPLACES) !== 0; if (!hasReplacement && (view.getUint32(120, true) !== 0 || replacesBytes.some(value => value !== 0))) throw new RangeError("Geometry Product empty replacement fields must be zero");
  const descriptor: GeometryProductDescriptorV1 = Object.freeze({
    schemaVersion: 1, productId: bytes.slice(128, 160), revision: view.getUint32(32, true), ...(hasReplacement ? { replaces: Object.freeze({ productId: replacesBytes, revision: view.getUint32(120, true) }) } : {}),
    producerKind, producerId, producerVersion, sourceIdentityKind, sourceIdentityHash: bytes.slice(160, 192), recipeHash: bytes.slice(192, 224), runtimeProfile: GEOMETRY_PRODUCT_RUNTIME_PROFILE, decodedPageBytes: OEGPACK_V3_PAGE_BYTES,
    assetRecords: sliceRange(bytes, ranges[0]!), rootNodeIds: u32Array(sliceRange(bytes, ranges[1]!)), hierarchyNodes: sliceRange(bytes, ranges[2]!), groupDirectory: sliceRange(bytes, ranges[3]!), pageRecords: sliceRange(bytes, ranges[4]!), bootstrapPageIds: u32Array(sliceRange(bytes, ranges[5]!)), vertexFormats: sliceRange(bytes, ranges[6]!), activationPageIds: u32Array(sliceRange(bytes, ranges[7]!))
  });
  assertGeometryProductDescriptorV1(descriptor); return descriptor;
}

function section(bytes: Uint8Array, stride: number): Section { if (bytes.byteLength % stride !== 0) throw new RangeError("Geometry Product section has an invalid stride"); return { bytes: bytes.slice(), count: bytes.byteLength / stride, stride, offset: 0 }; }
function u32Bytes(values: Uint32Array): Uint8Array { const bytes = new Uint8Array(values.byteLength); const view = new DataView(bytes.buffer); for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]!, true); return bytes; }
function u32Array(bytes: Uint8Array): Uint32Array { const values = new Uint32Array(bytes.byteLength / 4); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); for (let i = 0; i < values.length; i++) values[i] = view.getUint32(i * 4, true); return values; }
function sliceRange(bytes: Uint8Array, range: { offset: number; byteLength: number }): Uint8Array<ArrayBuffer> { return bytes.slice(range.offset, range.offset + range.byteLength); }
function align(value: number): number { const result = Math.ceil(value / SECTION_ALIGNMENT) * SECTION_ALIGNMENT; if (!Number.isSafeInteger(result)) throw new RangeError("Geometry Product descriptor alignment overflow"); return result; }
function checkedAdd(a: number, b: number): number { const value = a + b; if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError("Geometry Product descriptor size overflow"); return value; }
function checkedMultiply(a: number, b: number): number { const value = a * b; if (!Number.isSafeInteger(value) || value > 0xffffffff) throw new RangeError("Geometry Product descriptor size overflow"); return value; }
function assertU32(value: number, name: string): void { if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be u32`); }
function writeU32(view: DataView, offset: number, value: number): void { assertU32(value, "descriptor field"); view.setUint32(offset, value, true); }
function assertZero(bytes: Uint8Array, begin: number, end: number): void { for (let i = begin; i < end; i++) if (bytes[i] !== 0) throw new RangeError("Geometry Product descriptor padding is non-zero"); }
function decodeEnum<const T extends readonly string[]>(value: number, values: T, name: string): T[number] { if (value < 1 || value > values.length) throw new RangeError(`Geometry Product ${name} is invalid`); return values[value - 1]!; }
