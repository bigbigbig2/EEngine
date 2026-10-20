import { GEOMETRY_LAYOUT_V4 as L } from "./GeometryLayoutV4.generated.js";

export const OEGPACK_V4_HEADER_BYTES = 256;
export const OEGPACK_V4_PAGE_SHIFT = 18;
export const OEGPACK_V4_PAGE_BYTES = 1 << OEGPACK_V4_PAGE_SHIFT;
export const OEGPACK_V4_HIERARCHY_STRIDE = 48;
export const OEGPACK_V4_GROUP_DIRECTORY_STRIDE = 16;
export const OEGPACK_V4_PAGE_DIRECTORY_STRIDE = 64;
export const OEGPACK_V4_ASSET_STRIDE = 128;
export const OEGPACK_V4_VERTEX_FORMAT_STRIDE = 16;
export const OEGPACK_V4_GROUP_HEADER_BYTES = 64;
export const OEGPACK_V4_MESHLET_HEADER_BYTES = L.meshletHeaderBytes;
export const OEGPACK_V4_INVALID_ID = 0xffffffff;

export interface GeometryHierarchyNodeV4 {
  readonly boundsSphere: readonly [number, number, number, number];
  readonly bboxMin: readonly [number, number, number];
  readonly bboxMax: readonly [number, number, number];
  readonly maxParentError: number;
  readonly packedNodeData: number;
}

export interface GeometryGroupDirectoryV4 {
  readonly pageId: number;
  readonly offsetInDecodedPage: number;
  readonly payloadBytes: number;
  readonly flags: number;
}

export interface GeometryPageDirectoryV4 {
  readonly compressedFileOffset: bigint;
  readonly compressedBytes: number;
  readonly decodedBytes: number;
  readonly firstGroup: number;
  readonly groupCount: number;
  readonly codec: 0 | 1;
  readonly flags: number;
  readonly decodedContentHash128: string;
  readonly compressedChecksum: number;
}

export interface GeometryAssetRecordV4 {
  readonly assetId: string;
  readonly boundsSphere: readonly [number, number, number, number];
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly rootNodeBegin: number;
  readonly rootNodeCount: number;
  readonly hierarchyBegin: number;
  readonly hierarchyCount: number;
  readonly groupBegin: number;
  readonly groupCount: number;
  readonly bootstrapPageBegin: number;
  readonly bootstrapPageCount: number;
  readonly sourceTriangleCount: number;
  readonly leafMeshletCount: number;
  readonly totalMeshletCount: number;
  readonly flags: number;
}

export interface VertexFormatRecordV4 {
  /** Byte 10: component SoA F32. Older interleaved/quantized pages require recook. */
  readonly positionEncoding: 2;
  readonly tangentSignEncoding: 0 | 1 | 2;
  readonly streamBytesPerVertex: number;
  readonly attributeMask: number;
  readonly positionOffset: number;
  readonly normalOffset: number;
  readonly tangentOffset: number;
  readonly uv0Offset: number;
  readonly uv1Offset: number;
  readonly colorOffset: number;
}

export function geometryVertexPayloadBytes(count: number, format: VertexFormatRecordV4): number {
  return (
    Math.ceil(
      (count * format.streamBytesPerVertex + (format.tangentSignEncoding === 1 ? Math.ceil(count / 8) : 0)) /
        4
    ) * 4
  );
}

/** Offsets are per-vertex stream widths preceding a channel, multiplied by count. */
export function geometryVertexFormat(mask: number, sign: 0 | 1 | 2): VertexFormatRecordV4 {
  let cursor: number = L.vertex.optionalStreamBegin;
  const take = (active: number): number => {
    if (!(mask & active)) {
      return 255;
    }
    const at = cursor;
    cursor += L.vertex.optionalStreamWidth;
    return at;
  };
  const tangentOffset = take(4),
    uv0Offset = take(8),
    uv1Offset = take(16),
    colorOffset = take(32);
  if (
    (mask & L.vertex.requiredMask) !== L.vertex.requiredMask ||
    (mask & ~L.vertex.knownMask) !== 0 ||
    (mask & 4 ? sign !== 1 && sign !== 2 : sign !== 0)
  ) {
    throw new RangeError("Invalid compact geometry vertex profile");
  }
  return Object.freeze({
    streamBytesPerVertex: cursor + (sign === 2 ? 2 : 0),
    attributeMask: mask,
    positionOffset: L.vertex.positionOffset,
    normalOffset: L.vertex.normalOffset,
    tangentOffset,
    uv0Offset,
    uv1Offset,
    colorOffset,
    positionEncoding: L.vertex.positionEncoding,
    tangentSignEncoding: sign
  });
}

export function decodeVertexFormatV4(view: DataView, at: number): VertexFormatRecordV4 {
  const format = geometryVertexFormat(view.getUint16(at + 2, true), view.getUint8(at + 11) as 0 | 1 | 2);
  const fields = [
    format.positionOffset,
    format.normalOffset,
    format.tangentOffset,
    format.uv0Offset,
    format.uv1Offset,
    format.colorOffset,
    format.positionEncoding,
    format.tangentSignEncoding,
    0,
    0,
    0,
    0
  ];
  if (
    view.getUint16(at, true) !== format.streamBytesPerVertex ||
    fields.some((value, i) => view.getUint8(at + 4 + i) !== value)
  ) {
    throw new RangeError("Noncanonical compact geometry format; recook source");
  }
  return format;
}

export interface GroupHeaderV4 {
  readonly boundsSphere: readonly [number, number, number, number];
  readonly bboxMin: readonly [number, number, number];
  readonly bboxMax: readonly [number, number, number];
  readonly parentError: number;
  readonly meshletCount: number;
  readonly lodLevel: number;
  readonly vertexFormatId: number;
  readonly meshletHeaderOffset: number;
  readonly triangleDataOffset: number;
  readonly vertexDataOffset: number;
  readonly payloadBytes: number;
}

export interface MeshletHeaderV4 {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly vertexByteOffset: number;
  readonly triangleByteOffset: number;
  readonly refineGroupId: number;
  readonly materialId: number;
  readonly flags: number;
  readonly bboxMin: readonly [number, number, number];
  readonly bboxMax: readonly [number, number, number];
}

function f32(view: DataView, byteOffset: number, count: 3): readonly [number, number, number];
function f32(view: DataView, byteOffset: number, count: 4): readonly [number, number, number, number];
function f32(view: DataView, byteOffset: number, count: 3 | 4): readonly number[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => view.getFloat32(byteOffset + index * 4, true))
  );
}

export function decodeHierarchyNodeV4(view: DataView, byteOffset = 0): GeometryHierarchyNodeV4 {
  return Object.freeze({
    boundsSphere: f32(view, byteOffset, 4),
    bboxMin: f32(view, byteOffset + 16, 3),
    bboxMax: f32(view, byteOffset + 28, 3),
    maxParentError: view.getFloat32(byteOffset + 40, true),
    packedNodeData: view.getUint32(byteOffset + 44, true)
  });
}

export function decodeGroupHeaderV4(view: DataView, byteOffset = 0): GroupHeaderV4 {
  return Object.freeze({
    boundsSphere: f32(view, byteOffset, 4),
    bboxMin: f32(view, byteOffset + 16, 3),
    bboxMax: f32(view, byteOffset + 28, 3),
    parentError: view.getFloat32(byteOffset + 40, true),
    meshletCount: view.getUint16(byteOffset + 44, true),
    lodLevel: view.getUint8(byteOffset + 46),
    vertexFormatId: view.getUint8(byteOffset + 47),
    meshletHeaderOffset: view.getUint32(byteOffset + 48, true),
    triangleDataOffset: view.getUint32(byteOffset + 52, true),
    vertexDataOffset: view.getUint32(byteOffset + 56, true),
    payloadBytes: view.getUint32(byteOffset + 60, true)
  });
}

export function decodeMeshletHeaderV4(view: DataView, byteOffset = 0): MeshletHeaderV4 {
  return Object.freeze({
    vertexCount: view.getUint8(byteOffset + L.meshlet.vertexCount),
    triangleCount: view.getUint8(byteOffset + L.meshlet.triangleCount),
    vertexByteOffset: view.getUint32(byteOffset + L.meshlet.vertexByteOffset, true),
    triangleByteOffset: view.getUint32(byteOffset + L.meshlet.triangleByteOffset, true),
    refineGroupId: view.getUint32(byteOffset + L.meshlet.refineGroupId, true),
    materialId: view.getUint32(byteOffset + L.meshlet.materialId, true),
    flags: view.getUint16(byteOffset + L.meshlet.flags, true),
    bboxMin: f32(view, byteOffset + L.meshlet.bboxMin, 3),
    bboxMax: f32(view, byteOffset + L.meshlet.bboxMax, 3)
  });
}

export function hierarchyNodeIsGroupV4(packed: number): boolean {
  return (packed & 1) !== 0;
}

export function hierarchyNodeChildStartV4(packed: number): number {
  return (packed >>> 1) & 0x07ffffff;
}

export function hierarchyNodeChildCountV4(packed: number): number {
  return packed >>> 28;
}

export function hierarchyNodeGroupIdV4(packed: number): number {
  return (packed >>> 1) & 0x00ffffff;
}

export function hierarchyNodeMeshletCountV4(packed: number): number {
  return ((packed >>> 25) & 0x7f) + 1;
}
