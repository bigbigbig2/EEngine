export const OEGPACK_V3_HEADER_BYTES = 256;
export const OEGPACK_V3_PAGE_SHIFT = 18;
export const OEGPACK_V3_PAGE_BYTES = 1 << OEGPACK_V3_PAGE_SHIFT;
export const OEGPACK_V3_HIERARCHY_STRIDE = 48;
export const OEGPACK_V3_GROUP_DIRECTORY_STRIDE = 16;
export const OEGPACK_V3_PAGE_DIRECTORY_STRIDE = 64;
export const OEGPACK_V3_ASSET_STRIDE = 128;
export const OEGPACK_V3_VERTEX_FORMAT_STRIDE = 16;
export const OEGPACK_V3_GROUP_HEADER_BYTES = 64;
export const OEGPACK_V3_MESHLET_HEADER_BYTES = 48;
export const OEGPACK_V3_INVALID_ID = 0xffffffff;
export const OEGPACK_V3_GEOMETRY_BANK_BYTES = 128 * 1024 * 1024;
export const OEGPACK_V3_SLOTS_PER_BANK = 512;

export interface GeometryHierarchyNodeV3 {
  readonly boundsSphere: readonly [number, number, number, number];
  readonly bboxMin: readonly [number, number, number];
  readonly bboxMax: readonly [number, number, number];
  readonly maxParentError: number;
  readonly packedNodeData: number;
}

export interface GeometryGroupDirectoryV3 {
  readonly pageId: number;
  readonly offsetInDecodedPage: number;
  readonly payloadBytes: number;
  readonly flags: number;
}

export interface GeometryPageDirectoryV3 {
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

export interface GeometryAssetRecordV3 {
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

export interface VertexFormatRecordV3 {
  readonly strideBytes: number;
  readonly attributeMask: number;
  readonly positionOffset: number;
  readonly normalOffset: number;
  readonly tangentOffset: number;
  readonly uv0Offset: number;
  readonly uv1Offset: number;
  readonly colorOffset: number;
}

export interface GroupHeaderV3 {
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

export interface MeshletHeaderV3 {
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
  return Object.freeze(Array.from({ length: count }, (_, index) => view.getFloat32(byteOffset + index * 4, true)));
}

export function decodeHierarchyNodeV3(view: DataView, byteOffset = 0): GeometryHierarchyNodeV3 {
  return Object.freeze({
    boundsSphere: f32(view, byteOffset, 4),
    bboxMin: f32(view, byteOffset + 16, 3),
    bboxMax: f32(view, byteOffset + 28, 3),
    maxParentError: view.getFloat32(byteOffset + 40, true),
    packedNodeData: view.getUint32(byteOffset + 44, true)
  });
}

export function decodeGroupHeaderV3(view: DataView, byteOffset = 0): GroupHeaderV3 {
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

export function decodeMeshletHeaderV3(view: DataView, byteOffset = 0): MeshletHeaderV3 {
  return Object.freeze({
    vertexCount: view.getUint16(byteOffset, true),
    triangleCount: view.getUint16(byteOffset + 2, true),
    vertexByteOffset: view.getUint32(byteOffset + 4, true),
    triangleByteOffset: view.getUint32(byteOffset + 8, true),
    refineGroupId: view.getUint32(byteOffset + 12, true),
    materialId: view.getUint32(byteOffset + 16, true),
    flags: view.getUint32(byteOffset + 20, true),
    bboxMin: f32(view, byteOffset + 24, 3),
    bboxMax: f32(view, byteOffset + 36, 3)
  });
}

export function hierarchyNodeIsGroupV3(packed: number): boolean {
  return (packed & 1) !== 0;
}

export function hierarchyNodeChildStartV3(packed: number): number {
  return (packed >>> 1) & 0x07ffffff;
}

export function hierarchyNodeChildCountV3(packed: number): number {
  return packed >>> 28;
}

export function hierarchyNodeGroupIdV3(packed: number): number {
  return (packed >>> 1) & 0x00ffffff;
}

export function hierarchyNodeMeshletCountV3(packed: number): number {
  return ((packed >>> 25) & 0x7f) + 1;
}
