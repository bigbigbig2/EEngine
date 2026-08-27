import {
  openRuntimeAssetPackage,
  type RuntimeAssetPackage,
  type RuntimeAssetSectionView,
  type RuntimeAssetValidationIssue
} from "./RuntimeAssetPackage.js";

export const GEOMETRY_ASSET_SCHEMA_VERSION = 1;
export const GEOMETRY_DIRECTORY_RECORD_STRIDE = 192;
export const GEOMETRY_MESHLET_RECORD_STRIDE = 112;
export const GEOMETRY_CLUSTER_RECORD_STRIDE = 128;
export const GEOMETRY_BVH8_NODE_STRIDE = 352;
export const GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE = 128;
export const GEOMETRY_MATERIAL_RANGE_STRIDE = 32;
export const GEOMETRY_INVALID_INDEX = 0xffffffff;

export const GEOMETRY_SECTION_TYPES = Object.freeze({
  GeometryDirectory: 0x1000,
  VertexStreamDescriptors: 0x1100,
  VertexStreamData: 0x1101,
  IndexData: 0x1200,
  MeshletRecords: 0x2000,
  MeshletVertexIndices: 0x2001,
  MeshletTriangleIndices: 0x2002,
  ClusterRecords: 0x3000,
  ClusterChildren: 0x3001,
  Bvh8Nodes: 0x4000,
  MaterialRanges: 0x5000,
  OptionalDebugNames: 0xf000
});

export const GEOMETRY_DIRECTORY_FLAGS = Object.freeze({
  SingleLevel: 1 << 0,
  NoHierarchy: 1 << 1,
  NoBvh: 1 << 2,
  Uncompressed: 1 << 3
});

const GEOMETRY_REQUIRED_R2_B_01_FLAGS =
  GEOMETRY_DIRECTORY_FLAGS.SingleLevel |
  GEOMETRY_DIRECTORY_FLAGS.NoHierarchy |
  GEOMETRY_DIRECTORY_FLAGS.NoBvh |
  GEOMETRY_DIRECTORY_FLAGS.Uncompressed;
const MESHLET_ALPHA_MASK = 0x3;
const MESHLET_DOUBLE_SIDED = 1 << 2;
const MESHLET_CONE_VALID = 1 << 3;
const MESHLET_KNOWN_FLAGS =
  MESHLET_ALPHA_MASK | MESHLET_DOUBLE_SIDED | MESHLET_CONE_VALID;
export const GEOMETRY_CLUSTER_FLAGS = Object.freeze({
  Leaf: 1 << 0,
  SyntheticRoot: 1 << 1,
  MixedMaterial: 1 << 2,
  ConeValid: 1 << 3,
  DoubleSided: 1 << 4,
  SimplificationFallback: 1 << 5
});
const CLUSTER_KNOWN_FLAGS = Object.values(GEOMETRY_CLUSTER_FLAGS)
  .reduce((flags, value) => flags | value, 0);
const HASH_BYTES = 32;
const VERTEX_STREAM_SEMANTIC_BYTES = 32;

export type GeometryVertexDataType =
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

export type GeometryMeshletAlphaMode = "opaque" | "mask" | "blend";

export interface GeometryDirectoryRecord {
  readonly schemaVersion: number;
  readonly flags: number;
  readonly vertexCount: number;
  readonly sourceTriangleCount: number;
  readonly vertexStreamDescriptorBegin: number;
  readonly vertexStreamDescriptorCount: number;
  readonly vertexDataByteBegin: number;
  readonly vertexDataByteLength: number;
  readonly indexBegin: number;
  readonly indexCount: number;
  readonly meshletBegin: number;
  readonly meshletCount: number;
  readonly clusterRoot: number;
  readonly clusterCount: number;
  readonly bvhRoot: number;
  readonly bvhCount: number;
  readonly materialRangeBegin: number;
  readonly materialRangeCount: number;
  readonly maxMeshletVertices: number;
  readonly maxMeshletTriangles: number;
  readonly boundsBox: Float32Array;
  readonly boundsSphere: Float32Array;
  readonly sourceHash: Uint8Array;
  readonly recipeHash: Uint8Array;
}

export interface GeometryMeshletRecord {
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly triangleOffset: number;
  readonly triangleCount: number;
  readonly materialRangeIndex: number;
  readonly materialId: number;
  readonly flags: number;
  readonly alphaMode: GeometryMeshletAlphaMode;
  readonly doubleSided: boolean;
  readonly coneValid: boolean;
  readonly boundsBox: Float32Array;
  readonly bounds: {
    readonly centerX: number;
    readonly centerY: number;
    readonly centerZ: number;
    readonly radius: number;
  };
  readonly cone: {
    readonly apexX: number;
    readonly apexY: number;
    readonly apexZ: number;
    readonly axisX: number;
    readonly axisY: number;
    readonly axisZ: number;
    readonly cutoff: number;
  };
}

export interface GeometryClusterRecord {
  readonly childBegin: number;
  readonly childCount: number;
  readonly meshletBegin: number;
  readonly meshletCount: number;
  readonly parent: number;
  readonly depth: number;
  readonly materialId: number;
  readonly flags: number;
  readonly geometricError: number;
  readonly boundsBox: Float32Array;
  readonly bounds: {
    readonly centerX: number;
    readonly centerY: number;
    readonly centerZ: number;
    readonly radius: number;
  };
  readonly cone: {
    readonly apexX: number;
    readonly apexY: number;
    readonly apexZ: number;
    readonly axisX: number;
    readonly axisY: number;
    readonly axisZ: number;
    readonly cutoff: number;
  };
}

/**
 * Storage-buffer-ready BVH8 node. Bounds are serialized as vec4 min/max at
 * 16-byte aligned offsets; the fourth lanes are reserved zero.
 */
export interface GeometryBvh8Node {
  readonly parent: number;
  readonly depth: number;
  readonly childCount: number;
  readonly validMask: number;
  readonly leafMask: number;
  readonly flags: number;
  readonly childRefs: Uint32Array;
  readonly childRangeCounts: Uint32Array;
  readonly childBoundsBox: readonly Float32Array[];
}

export interface GeometryVertexStreamDescriptor {
  readonly semantic: string;
  readonly dataByteOffset: number;
  readonly dataByteLength: number;
  readonly elementStride: number;
  readonly vertexCount: number;
  readonly componentCount: number;
  readonly dataType: GeometryVertexDataType;
  readonly normalized: boolean;
  readonly flags: number;
  readonly decodeScale: Float32Array;
  readonly decodeBias: Float32Array;
  readonly componentMinimum: Float32Array;
  readonly componentMaximum: Float32Array;
}

export interface GeometryMaterialRangeRecord {
  readonly firstTriangle: number;
  readonly triangleCount: number;
  readonly materialId: number;
  readonly flags: number;
  readonly alphaMode: GeometryMeshletAlphaMode;
  readonly doubleSided: boolean;
}

export interface GeometryAssetValidationReport {
  readonly valid: boolean;
  readonly issues: readonly RuntimeAssetValidationIssue[];
}

export interface GeometryAssetPackage {
  readonly package: RuntimeAssetPackage;
  readonly directory: GeometryDirectoryRecord;
  readonly meshlets: readonly GeometryMeshletRecord[];
  readonly meshletVertexIndices: Uint32Array;
  readonly meshletTriangleIndices: Uint8Array;
  readonly clusters: readonly GeometryClusterRecord[];
  readonly clusterChildren: Uint32Array;
  readonly bvh8Nodes: readonly GeometryBvh8Node[];
  readonly vertexStreamDescriptors: readonly GeometryVertexStreamDescriptor[];
  readonly vertexStreamData: Uint8Array;
  readonly indices: Uint32Array;
  readonly materialRanges: readonly GeometryMaterialRangeRecord[];
  validate(): GeometryAssetValidationReport;
}

export class GeometryAssetPackageError extends Error {
  readonly report: GeometryAssetValidationReport;

  constructor(report: GeometryAssetValidationReport) {
    const first = report.issues.find((issue) => issue.severity === "error");
    super(first?.message ?? "Geometry Asset Package validation failed");
    this.name = "GeometryAssetPackageError";
    this.report = report;
  }
}

export async function openGeometryAssetPackage(
  bytes: ArrayBuffer
): Promise<GeometryAssetPackage> {
  const pkg = await openRuntimeAssetPackage(bytes, {
    supportedSectionTypes: new Set(Object.values(GEOMETRY_SECTION_TYPES))
  });
  const issues: RuntimeAssetValidationIssue[] = [];
  const error = (code: string, message: string, sectionType?: number): void => {
    issues.push({ severity: "error", code, message, sectionType });
  };
  const directorySection = requiredSection(
    pkg,
    GEOMETRY_SECTION_TYPES.GeometryDirectory,
    GEOMETRY_DIRECTORY_RECORD_STRIDE,
    error
  );
  const meshletSection = requiredSection(
    pkg,
    GEOMETRY_SECTION_TYPES.MeshletRecords,
    GEOMETRY_MESHLET_RECORD_STRIDE,
    error
  );
  const vertexSection = requiredSection(
    pkg,
    GEOMETRY_SECTION_TYPES.MeshletVertexIndices,
    4,
    error
  );
  const triangleSection = requiredSection(
    pkg,
    GEOMETRY_SECTION_TYPES.MeshletTriangleIndices,
    1,
    error
  );
  const clusterSection = pkg.section(GEOMETRY_SECTION_TYPES.ClusterRecords);
  const clusterChildrenSection = pkg.section(GEOMETRY_SECTION_TYPES.ClusterChildren);
  const bvhSection = pkg.section(GEOMETRY_SECTION_TYPES.Bvh8Nodes);
  const streamDescriptorSection = pkg.section(
    GEOMETRY_SECTION_TYPES.VertexStreamDescriptors
  );
  const vertexDataSection = pkg.section(GEOMETRY_SECTION_TYPES.VertexStreamData);
  const indexSection = pkg.section(GEOMETRY_SECTION_TYPES.IndexData);
  const materialSection = pkg.section(GEOMETRY_SECTION_TYPES.MaterialRanges);
  const payloadSections = [
    streamDescriptorSection,
    vertexDataSection,
    indexSection,
    materialSection
  ];
  const payloadSectionCount = payloadSections.filter(
    (section) => section !== undefined
  ).length;
  if (payloadSectionCount !== 0 && payloadSectionCount !== payloadSections.length) {
    error(
      "geometry-payload-section-set",
      "Vertex descriptors/data, indices and material ranges must be present or absent together"
    );
  }
  if ((clusterSection === undefined) !== (clusterChildrenSection === undefined)) {
    error(
      "geometry-hierarchy-section-pair",
      "ClusterRecords and ClusterChildren must be present or absent together"
    );
  }
  if (clusterSection !== undefined) {
    validateSectionContract(
      clusterSection,
      GEOMETRY_CLUSTER_RECORD_STRIDE,
      error
    );
  }
  if (clusterChildrenSection !== undefined) {
    validateSectionContract(clusterChildrenSection, 4, error);
  }
  if (bvhSection !== undefined) {
    validateSectionContract(bvhSection, GEOMETRY_BVH8_NODE_STRIDE, error);
  }
  if (streamDescriptorSection !== undefined) {
    validateSectionContract(
      streamDescriptorSection,
      GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
      error
    );
  }
  if (vertexDataSection !== undefined) {
    validateSectionContract(vertexDataSection, 1, error);
  }
  if (indexSection !== undefined) {
    validateSectionContract(indexSection, 4, error);
  }
  if (materialSection !== undefined) {
    validateSectionContract(materialSection, GEOMETRY_MATERIAL_RANGE_STRIDE, error);
  }
  if (
    directorySection === undefined ||
    meshletSection === undefined ||
    vertexSection === undefined ||
    triangleSection === undefined
  ) {
    throw new GeometryAssetPackageError(freezeReport(issues));
  }
  if (directorySection.elementCount !== 1) {
    error(
      "geometry-directory-count",
      "R2-B-01 packages must contain exactly one GeometryDirectory record",
      directorySection.type
    );
  }
  validateReservedBytes(directorySection.bytes, meshletSection.bytes, issues);
  if (clusterSection !== undefined) {
    validateClusterReservedBytes(clusterSection.bytes, issues);
  }
  if (bvhSection !== undefined) {
    validateBvhReservedBytes(bvhSection.bytes, issues);
  }
  if (streamDescriptorSection !== undefined) {
    validateVertexDescriptorEncoding(streamDescriptorSection.bytes, issues);
  }
  if (materialSection !== undefined) {
    validateMaterialReservedBytes(materialSection.bytes, issues);
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new GeometryAssetPackageError(freezeReport(issues));
  }

  const directory = readGeometryDirectoryRecord(directorySection.bytes, 0);
  const meshlets = new Array<GeometryMeshletRecord>(meshletSection.elementCount);
  for (let index = 0; index < meshlets.length; index++) {
    meshlets[index] = readGeometryMeshletRecord(meshletSection.bytes, index);
  }
  const meshletVertexIndices = new Uint32Array(
    vertexSection.bytes.buffer,
    vertexSection.bytes.byteOffset,
    vertexSection.elementCount
  );
  const meshletTriangleIndices = triangleSection.bytes;
  const clusters = clusterSection === undefined
    ? []
    : new Array<GeometryClusterRecord>(clusterSection.elementCount);
  if (clusterSection !== undefined) {
    for (let index = 0; index < clusters.length; index++) {
      clusters[index] = readGeometryClusterRecord(clusterSection.bytes, index);
    }
  }
  const clusterChildren = clusterChildrenSection === undefined
    ? new Uint32Array(0)
    : new Uint32Array(
      clusterChildrenSection.bytes.buffer,
      clusterChildrenSection.bytes.byteOffset,
      clusterChildrenSection.elementCount
    );
  const bvh8Nodes = bvhSection === undefined
    ? []
    : new Array<GeometryBvh8Node>(bvhSection.elementCount);
  if (bvhSection !== undefined) {
    for (let index = 0; index < bvh8Nodes.length; index++) {
      bvh8Nodes[index] = readGeometryBvh8Node(bvhSection.bytes, index);
    }
  }
  const vertexStreamDescriptors = streamDescriptorSection === undefined
    ? []
    : new Array<GeometryVertexStreamDescriptor>(streamDescriptorSection.elementCount);
  if (streamDescriptorSection !== undefined) {
    for (let index = 0; index < vertexStreamDescriptors.length; index++) {
      vertexStreamDescriptors[index] = readGeometryVertexStreamDescriptor(
        streamDescriptorSection.bytes,
        index
      );
    }
  }
  const vertexStreamData = vertexDataSection?.bytes ?? new Uint8Array(0);
  const indices = indexSection === undefined
    ? new Uint32Array(0)
    : new Uint32Array(
      indexSection.bytes.buffer,
      indexSection.bytes.byteOffset,
      indexSection.elementCount
    );
  const materialRanges = materialSection === undefined
    ? []
    : new Array<GeometryMaterialRangeRecord>(materialSection.elementCount);
  if (materialSection !== undefined) {
    for (let index = 0; index < materialRanges.length; index++) {
      materialRanges[index] = readGeometryMaterialRange(materialSection.bytes, index);
    }
  }
  validateDirectory(
    directory,
    meshlets.length,
    clusters.length,
    bvh8Nodes.length,
    vertexStreamDescriptors.length,
    vertexStreamData.byteLength,
    indices.length,
    materialRanges.length,
    issues
  );
  validateMeshlets(
    directory,
    meshlets,
    meshletVertexIndices,
    meshletTriangleIndices,
    issues
  );
  validateClusters(
    directory,
    clusters,
    clusterChildren,
    meshlets,
    issues
  );
  validateBvh8(directory, bvh8Nodes, clusters, issues);
  validateVertexAndIndexPayload(
    directory,
    vertexStreamDescriptors,
    vertexStreamData,
    indices,
    issues
  );
  validateMaterials(directory, materialRanges, meshlets, clusters, issues);
  validateMeshletPositionBounds(
    vertexStreamDescriptors,
    vertexStreamData,
    meshlets,
    meshletVertexIndices,
    issues
  );
  const report = freezeReport(issues);
  if (!report.valid) throw new GeometryAssetPackageError(report);

  const frozenMeshlets = Object.freeze(meshlets);
  return {
    package: pkg,
    directory: Object.freeze(directory),
    meshlets: frozenMeshlets,
    meshletVertexIndices,
    meshletTriangleIndices,
    clusters: Object.freeze(clusters),
    clusterChildren,
    bvh8Nodes: Object.freeze(bvh8Nodes),
    vertexStreamDescriptors: Object.freeze(vertexStreamDescriptors),
    vertexStreamData,
    indices,
    materialRanges: Object.freeze(materialRanges),
    validate: () => report
  };
}

export function encodeGeometryDirectoryRecord(
  record: GeometryDirectoryRecord
): Uint8Array {
  if (record.boundsBox.length !== 6 || record.boundsSphere.length !== 4) {
    throw new RangeError("GeometryDirectory bounds must contain box[6] and sphere[4]");
  }
  if (record.sourceHash.length !== HASH_BYTES || record.recipeHash.length !== HASH_BYTES) {
    throw new RangeError("GeometryDirectory source/recipe hashes must be SHA-256");
  }
  const bytes = new Uint8Array(GEOMETRY_DIRECTORY_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  const integers = [
    record.schemaVersion,
    record.flags,
    record.vertexCount,
    record.sourceTriangleCount,
    record.vertexStreamDescriptorBegin,
    record.vertexStreamDescriptorCount,
    record.vertexDataByteBegin,
    record.vertexDataByteLength,
    record.indexBegin,
    record.indexCount,
    record.meshletBegin,
    record.meshletCount,
    record.clusterRoot,
    record.clusterCount,
    record.bvhRoot,
    record.bvhCount,
    record.materialRangeBegin,
    record.materialRangeCount,
    record.maxMeshletVertices,
    record.maxMeshletTriangles
  ];
  for (let index = 0; index < integers.length; index++) {
    view.setUint32(index * 4, integers[index]!, true);
  }
  writeFloatArray(view, 80, record.boundsBox);
  writeFloatArray(view, 104, record.boundsSphere);
  bytes.set(record.sourceHash, 120);
  bytes.set(record.recipeHash, 152);
  return bytes;
}

export function encodeGeometryMeshletRecords(
  records: readonly GeometryMeshletRecord[]
): Uint8Array {
  const bytes = new Uint8Array(records.length * GEOMETRY_MESHLET_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const offset = index * GEOMETRY_MESHLET_RECORD_STRIDE;
    view.setUint32(offset, record.vertexOffset, true);
    view.setUint32(offset + 4, record.vertexCount, true);
    view.setUint32(offset + 8, record.triangleOffset, true);
    view.setUint32(offset + 12, record.triangleCount, true);
    view.setUint32(offset + 16, record.materialRangeIndex, true);
    view.setUint32(offset + 20, record.materialId, true);
    view.setUint32(offset + 24, record.flags, true);
    writeFloatArray(view, offset + 32, record.boundsBox);
    writeFloatArray(view, offset + 64, new Float32Array([
      record.bounds.centerX,
      record.bounds.centerY,
      record.bounds.centerZ,
      record.bounds.radius
    ]));
    writeFloatArray(view, offset + 80, new Float32Array([
      record.cone.apexX,
      record.cone.apexY,
      record.cone.apexZ
    ]));
    writeFloatArray(view, offset + 96, new Float32Array([
      record.cone.axisX,
      record.cone.axisY,
      record.cone.axisZ,
      record.cone.cutoff
    ]));
  }
  return bytes;
}

export function encodeGeometryClusterRecords(
  records: readonly GeometryClusterRecord[]
): Uint8Array {
  const bytes = new Uint8Array(records.length * GEOMETRY_CLUSTER_RECORD_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const offset = index * GEOMETRY_CLUSTER_RECORD_STRIDE;
    view.setUint32(offset, record.childBegin, true);
    view.setUint32(offset + 4, record.childCount, true);
    view.setUint32(offset + 8, record.meshletBegin, true);
    view.setUint32(offset + 12, record.meshletCount, true);
    view.setUint32(offset + 16, record.parent, true);
    view.setUint32(offset + 20, record.depth, true);
    view.setUint32(offset + 24, record.materialId, true);
    view.setUint32(offset + 28, record.flags, true);
    view.setFloat32(offset + 32, record.geometricError, true);
    writeFloatArray(view, offset + 36, record.boundsBox);
    writeFloatArray(view, offset + 64, new Float32Array([
      record.bounds.centerX,
      record.bounds.centerY,
      record.bounds.centerZ,
      record.bounds.radius
    ]));
    writeFloatArray(view, offset + 80, new Float32Array([
      record.cone.apexX,
      record.cone.apexY,
      record.cone.apexZ
    ]));
    writeFloatArray(view, offset + 96, new Float32Array([
      record.cone.axisX,
      record.cone.axisY,
      record.cone.axisZ,
      record.cone.cutoff
    ]));
  }
  return bytes;
}

export function encodeGeometryBvh8Nodes(
  nodes: readonly GeometryBvh8Node[]
): Uint8Array {
  const bytes = new Uint8Array(nodes.length * GEOMETRY_BVH8_NODE_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (
      node.childRefs.length !== 8 ||
      node.childRangeCounts.length !== 8 ||
      node.childBoundsBox.length !== 8 ||
      node.childBoundsBox.some((box) => box.length !== 6)
    ) {
      throw new RangeError("GeometryBvh8Node must contain exactly eight child slots");
    }
    const offset = index * GEOMETRY_BVH8_NODE_STRIDE;
    view.setUint32(offset, node.parent, true);
    view.setUint32(offset + 4, node.depth, true);
    view.setUint32(offset + 8, node.childCount, true);
    view.setUint32(offset + 12, node.validMask, true);
    view.setUint32(offset + 16, node.leafMask, true);
    view.setUint32(offset + 20, node.flags, true);
    for (let slot = 0; slot < 8; slot++) {
      view.setUint32(offset + 32 + slot * 4, node.childRefs[slot]!, true);
      view.setUint32(offset + 64 + slot * 4, node.childRangeCounts[slot]!, true);
      const box = node.childBoundsBox[slot]!;
      writeFloatArray(view, offset + 96 + slot * 16, box.subarray(0, 3));
      writeFloatArray(view, offset + 224 + slot * 16, box.subarray(3, 6));
    }
  }
  return bytes;
}

export function encodeGeometryVertexStreamDescriptors(
  descriptors: readonly GeometryVertexStreamDescriptor[]
): Uint8Array {
  const bytes = new Uint8Array(
    descriptors.length * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE
  );
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index]!;
    const semantic = encoder.encode(descriptor.semantic);
    if (
      semantic.length === 0 ||
      semantic.length >= VERTEX_STREAM_SEMANTIC_BYTES ||
      descriptor.semantic.includes("\0")
    ) {
      throw new RangeError("Vertex stream semantic must contain 1..31 non-NUL UTF-8 bytes");
    }
    if (
      descriptor.decodeScale.length !== 4 ||
      descriptor.decodeBias.length !== 4 ||
      descriptor.componentMinimum.length !== 4 ||
      descriptor.componentMaximum.length !== 4
    ) {
      throw new RangeError("Vertex stream decode and component bounds must be vec4");
    }
    const offset = index * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE;
    bytes.set(semantic, offset);
    view.setUint32(offset + 32, descriptor.dataByteOffset, true);
    view.setUint32(offset + 36, descriptor.dataByteLength, true);
    view.setUint32(offset + 40, descriptor.elementStride, true);
    view.setUint32(offset + 44, descriptor.vertexCount, true);
    view.setUint32(offset + 48, descriptor.componentCount, true);
    view.setUint32(offset + 52, encodeVertexDataType(descriptor.dataType), true);
    view.setUint32(offset + 56, descriptor.normalized ? 1 : 0, true);
    view.setUint32(offset + 60, descriptor.flags, true);
    writeFloatArray(view, offset + 64, descriptor.decodeScale);
    writeFloatArray(view, offset + 80, descriptor.decodeBias);
    writeFloatArray(view, offset + 96, descriptor.componentMinimum);
    writeFloatArray(view, offset + 112, descriptor.componentMaximum);
  }
  return bytes;
}

export function encodeGeometryMaterialRanges(
  ranges: readonly GeometryMaterialRangeRecord[]
): Uint8Array {
  const bytes = new Uint8Array(ranges.length * GEOMETRY_MATERIAL_RANGE_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    const offset = index * GEOMETRY_MATERIAL_RANGE_STRIDE;
    view.setUint32(offset, range.firstTriangle, true);
    view.setUint32(offset + 4, range.triangleCount, true);
    view.setUint32(offset + 8, range.materialId, true);
    view.setUint32(
      offset + 12,
      encodeMaterialRangeFlags(range.alphaMode, range.doubleSided),
      true
    );
  }
  return bytes;
}

export function readGeometryDirectoryRecord(
  bytes: Uint8Array,
  index: number
): GeometryDirectoryRecord {
  const offset = index * GEOMETRY_DIRECTORY_RECORD_STRIDE;
  assertRecordRange(bytes, offset, GEOMETRY_DIRECTORY_RECORD_STRIDE, "GeometryDirectory");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    schemaVersion: view.getUint32(offset, true),
    flags: view.getUint32(offset + 4, true),
    vertexCount: view.getUint32(offset + 8, true),
    sourceTriangleCount: view.getUint32(offset + 12, true),
    vertexStreamDescriptorBegin: view.getUint32(offset + 16, true),
    vertexStreamDescriptorCount: view.getUint32(offset + 20, true),
    vertexDataByteBegin: view.getUint32(offset + 24, true),
    vertexDataByteLength: view.getUint32(offset + 28, true),
    indexBegin: view.getUint32(offset + 32, true),
    indexCount: view.getUint32(offset + 36, true),
    meshletBegin: view.getUint32(offset + 40, true),
    meshletCount: view.getUint32(offset + 44, true),
    clusterRoot: view.getUint32(offset + 48, true),
    clusterCount: view.getUint32(offset + 52, true),
    bvhRoot: view.getUint32(offset + 56, true),
    bvhCount: view.getUint32(offset + 60, true),
    materialRangeBegin: view.getUint32(offset + 64, true),
    materialRangeCount: view.getUint32(offset + 68, true),
    maxMeshletVertices: view.getUint32(offset + 72, true),
    maxMeshletTriangles: view.getUint32(offset + 76, true),
    boundsBox: readFloatArray(view, offset + 80, 6),
    boundsSphere: readFloatArray(view, offset + 104, 4),
    sourceHash: bytes.slice(offset + 120, offset + 152),
    recipeHash: bytes.slice(offset + 152, offset + 184)
  };
}

export function readGeometryMeshletRecord(
  bytes: Uint8Array,
  index: number
): GeometryMeshletRecord {
  const offset = index * GEOMETRY_MESHLET_RECORD_STRIDE;
  assertRecordRange(bytes, offset, GEOMETRY_MESHLET_RECORD_STRIDE, "MeshletRecord");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(offset + 24, true);
  const sphere = readFloatArray(view, offset + 64, 4);
  const coneApex = readFloatArray(view, offset + 80, 3);
  const cone = readFloatArray(view, offset + 96, 4);
  return Object.freeze({
    vertexOffset: view.getUint32(offset, true),
    vertexCount: view.getUint32(offset + 4, true),
    triangleOffset: view.getUint32(offset + 8, true),
    triangleCount: view.getUint32(offset + 12, true),
    materialRangeIndex: view.getUint32(offset + 16, true),
    materialId: view.getUint32(offset + 20, true),
    flags,
    alphaMode: decodeAlphaMode(flags),
    doubleSided: (flags & MESHLET_DOUBLE_SIDED) !== 0,
    coneValid: (flags & MESHLET_CONE_VALID) !== 0,
    boundsBox: readFloatArray(view, offset + 32, 6),
    bounds: Object.freeze({
      centerX: sphere[0]!,
      centerY: sphere[1]!,
      centerZ: sphere[2]!,
      radius: sphere[3]!
    }),
    cone: Object.freeze({
      apexX: coneApex[0]!,
      apexY: coneApex[1]!,
      apexZ: coneApex[2]!,
      axisX: cone[0]!,
      axisY: cone[1]!,
      axisZ: cone[2]!,
      cutoff: cone[3]!
    })
  });
}

export function readGeometryClusterRecord(
  bytes: Uint8Array,
  index: number
): GeometryClusterRecord {
  const offset = index * GEOMETRY_CLUSTER_RECORD_STRIDE;
  assertRecordRange(bytes, offset, GEOMETRY_CLUSTER_RECORD_STRIDE, "ClusterRecord");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sphere = readFloatArray(view, offset + 64, 4);
  const coneApex = readFloatArray(view, offset + 80, 3);
  const cone = readFloatArray(view, offset + 96, 4);
  return Object.freeze({
    childBegin: view.getUint32(offset, true),
    childCount: view.getUint32(offset + 4, true),
    meshletBegin: view.getUint32(offset + 8, true),
    meshletCount: view.getUint32(offset + 12, true),
    parent: view.getUint32(offset + 16, true),
    depth: view.getUint32(offset + 20, true),
    materialId: view.getUint32(offset + 24, true),
    flags: view.getUint32(offset + 28, true),
    geometricError: view.getFloat32(offset + 32, true),
    boundsBox: readFloatArray(view, offset + 36, 6),
    bounds: Object.freeze({
      centerX: sphere[0]!,
      centerY: sphere[1]!,
      centerZ: sphere[2]!,
      radius: sphere[3]!
    }),
    cone: Object.freeze({
      apexX: coneApex[0]!,
      apexY: coneApex[1]!,
      apexZ: coneApex[2]!,
      axisX: cone[0]!,
      axisY: cone[1]!,
      axisZ: cone[2]!,
      cutoff: cone[3]!
    })
  });
}

export function readGeometryBvh8Node(
  bytes: Uint8Array,
  index: number
): GeometryBvh8Node {
  const offset = index * GEOMETRY_BVH8_NODE_STRIDE;
  assertRecordRange(bytes, offset, GEOMETRY_BVH8_NODE_STRIDE, "Bvh8Node");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const childRefs = new Uint32Array(8);
  const childRangeCounts = new Uint32Array(8);
  const childBoundsBox = new Array<Float32Array>(8);
  for (let slot = 0; slot < 8; slot++) {
    childRefs[slot] = view.getUint32(offset + 32 + slot * 4, true);
    childRangeCounts[slot] = view.getUint32(offset + 64 + slot * 4, true);
    const minimum = readFloatArray(view, offset + 96 + slot * 16, 3);
    const maximum = readFloatArray(view, offset + 224 + slot * 16, 3);
    childBoundsBox[slot] = new Float32Array([
      minimum[0]!, minimum[1]!, minimum[2]!,
      maximum[0]!, maximum[1]!, maximum[2]!
    ]);
  }
  return Object.freeze({
    parent: view.getUint32(offset, true),
    depth: view.getUint32(offset + 4, true),
    childCount: view.getUint32(offset + 8, true),
    validMask: view.getUint32(offset + 12, true),
    leafMask: view.getUint32(offset + 16, true),
    flags: view.getUint32(offset + 20, true),
    childRefs,
    childRangeCounts,
    childBoundsBox: Object.freeze(childBoundsBox)
  });
}

export function readGeometryVertexStreamDescriptor(
  bytes: Uint8Array,
  index: number
): GeometryVertexStreamDescriptor {
  const offset = index * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE;
  assertRecordRange(
    bytes,
    offset,
    GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
    "VertexStreamDescriptor"
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const semanticBytes = bytes.subarray(offset, offset + VERTEX_STREAM_SEMANTIC_BYTES);
  const terminator = semanticBytes.indexOf(0);
  const semantic = new TextDecoder("utf-8", { fatal: true }).decode(
    terminator < 0 ? semanticBytes : semanticBytes.subarray(0, terminator)
  );
  return Object.freeze({
    semantic,
    dataByteOffset: view.getUint32(offset + 32, true),
    dataByteLength: view.getUint32(offset + 36, true),
    elementStride: view.getUint32(offset + 40, true),
    vertexCount: view.getUint32(offset + 44, true),
    componentCount: view.getUint32(offset + 48, true),
    dataType: decodeVertexDataType(view.getUint32(offset + 52, true)),
    normalized: view.getUint32(offset + 56, true) !== 0,
    flags: view.getUint32(offset + 60, true),
    decodeScale: readFloatArray(view, offset + 64, 4),
    decodeBias: readFloatArray(view, offset + 80, 4),
    componentMinimum: readFloatArray(view, offset + 96, 4),
    componentMaximum: readFloatArray(view, offset + 112, 4)
  });
}

export function readGeometryMaterialRange(
  bytes: Uint8Array,
  index: number
): GeometryMaterialRangeRecord {
  const offset = index * GEOMETRY_MATERIAL_RANGE_STRIDE;
  assertRecordRange(bytes, offset, GEOMETRY_MATERIAL_RANGE_STRIDE, "MaterialRange");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(offset + 12, true);
  return Object.freeze({
    firstTriangle: view.getUint32(offset, true),
    triangleCount: view.getUint32(offset + 4, true),
    materialId: view.getUint32(offset + 8, true),
    flags,
    alphaMode: decodeAlphaMode(flags),
    doubleSided: (flags & MESHLET_DOUBLE_SIDED) !== 0
  });
}

export function encodeMeshletFlags(
  alphaMode: GeometryMeshletAlphaMode,
  doubleSided: boolean,
  coneValid: boolean
): number {
  const alpha = alphaMode === "mask" ? 1 : alphaMode === "blend" ? 2 : 0;
  return alpha |
    (doubleSided ? MESHLET_DOUBLE_SIDED : 0) |
    (coneValid ? MESHLET_CONE_VALID : 0);
}

function requiredSection(
  pkg: RuntimeAssetPackage,
  type: number,
  stride: number,
  error: (code: string, message: string, sectionType?: number) => void
) {
  const section = pkg.section(type);
  if (section === undefined) {
    error("missing-geometry-section", `Required Geometry section ${type} is missing`, type);
    return undefined;
  }
  if (!validateSectionContract(section, stride, error)) return undefined;
  return section;
}

function validateSectionContract(
  section: RuntimeAssetSectionView,
  stride: number,
  error: (code: string, message: string, sectionType?: number) => void
): boolean {
  if (!section.required) {
    error(
      "geometry-section-not-required",
      `Geometry section ${section.type} must be required`,
      section.type
    );
    return false;
  }
  if (section.elementStride !== stride) {
    error(
      "geometry-section-stride",
      `Geometry section ${section.type} stride ${section.elementStride} must be ${stride}`,
      section.type
    );
    return false;
  }
  return true;
}

function validateReservedBytes(
  directoryBytes: Uint8Array,
  meshletBytes: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  if (!rangeIsZero(directoryBytes, 184, 192)) {
    issues.push({
      severity: "error",
      code: "geometry-directory-reserved",
      message: "GeometryDirectory reserved bytes must be zero",
      sectionType: GEOMETRY_SECTION_TYPES.GeometryDirectory
    });
  }
  const count = meshletBytes.byteLength / GEOMETRY_MESHLET_RECORD_STRIDE;
  for (let index = 0; index < count; index++) {
    const begin = index * GEOMETRY_MESHLET_RECORD_STRIDE;
    if (
      !rangeIsZero(meshletBytes, begin + 28, begin + 32) ||
      !rangeIsZero(meshletBytes, begin + 56, begin + 64)
    ) {
      issues.push({
        severity: "error",
        code: "meshlet-record-reserved",
        message: `Meshlet ${index}: reserved bytes must be zero`,
        sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
      });
    }
  }
}

function validateClusterReservedBytes(
  bytes: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  const count = bytes.byteLength / GEOMETRY_CLUSTER_RECORD_STRIDE;
  for (let index = 0; index < count; index++) {
    const begin = index * GEOMETRY_CLUSTER_RECORD_STRIDE;
    if (
      !rangeIsZero(bytes, begin + 60, begin + 64) ||
      !rangeIsZero(bytes, begin + 92, begin + 96) ||
      !rangeIsZero(bytes, begin + 112, begin + 128)
    ) {
      issues.push({
        severity: "error",
        code: "cluster-record-reserved",
        message: `Cluster ${index}: reserved bytes must be zero`,
        sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
      });
    }
  }
}

function validateBvhReservedBytes(
  bytes: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  const count = bytes.byteLength / GEOMETRY_BVH8_NODE_STRIDE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
    const begin = index * GEOMETRY_BVH8_NODE_STRIDE;
    let valid = rangeIsZero(bytes, begin + 24, begin + 32);
    for (let slot = 0; slot < 8; slot++) {
      valid = valid && view.getUint32(begin + 108 + slot * 16, true) === 0;
      valid = valid && view.getUint32(begin + 236 + slot * 16, true) === 0;
    }
    if (!valid) {
      issues.push({
        severity: "error",
        code: "bvh8-record-reserved",
        message: `BVH8 node ${index}: reserved bytes/lanes must be zero`,
        sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
      });
    }
  }
}

function validateVertexDescriptorEncoding(
  bytes: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  const count = bytes.byteLength / GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
    const begin = index * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE;
    const semanticBytes = bytes.subarray(begin, begin + VERTEX_STREAM_SEMANTIC_BYTES);
    const terminator = semanticBytes.indexOf(0);
    let validSemantic = terminator > 0;
    if (terminator > 0) {
      validSemantic = rangeIsZero(
        bytes,
        begin + terminator,
        begin + VERTEX_STREAM_SEMANTIC_BYTES
      );
      try {
        const semantic = new TextDecoder("utf-8", { fatal: true }).decode(
          semanticBytes.subarray(0, terminator)
        );
        validSemantic = validSemantic && semantic.length > 0 && !semantic.includes("\0");
      } catch {
        validSemantic = false;
      }
    }
    const dataTypeCode = view.getUint32(begin + 52, true);
    const normalized = view.getUint32(begin + 56, true);
    if (
      !validSemantic ||
      dataTypeCode < 1 ||
      dataTypeCode > 8 ||
      normalized > 1
    ) {
      issues.push({
        severity: "error",
        code: "vertex-stream-descriptor-encoding",
        message: `Vertex stream descriptor ${index}: semantic/type/normalized encoding is invalid`,
        sectionType: GEOMETRY_SECTION_TYPES.VertexStreamDescriptors
      });
    }
  }
}

function validateMaterialReservedBytes(
  bytes: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  const count = bytes.byteLength / GEOMETRY_MATERIAL_RANGE_STRIDE;
  for (let index = 0; index < count; index++) {
    const begin = index * GEOMETRY_MATERIAL_RANGE_STRIDE;
    if (!rangeIsZero(bytes, begin + 16, begin + GEOMETRY_MATERIAL_RANGE_STRIDE)) {
      issues.push({
        severity: "error",
        code: "material-range-reserved",
        message: `Material range ${index}: reserved bytes must be zero`,
        sectionType: GEOMETRY_SECTION_TYPES.MaterialRanges
      });
    }
  }
}

function validateDirectory(
  directory: GeometryDirectoryRecord,
  meshletRecordCount: number,
  clusterRecordCount: number,
  bvhRecordCount: number,
  vertexDescriptorCount: number,
  vertexDataBytes: number,
  indexCount: number,
  materialRangeCount: number,
  issues: RuntimeAssetValidationIssue[]
): void {
  const error = (code: string, message: string): void => {
    issues.push({
      severity: "error",
      code,
      message,
      sectionType: GEOMETRY_SECTION_TYPES.GeometryDirectory
    });
  };
  if (directory.schemaVersion !== GEOMETRY_ASSET_SCHEMA_VERSION) {
    error("geometry-schema-version", "GeometryDirectory schema version is unsupported");
  }
  const hierarchyPresent = clusterRecordCount > 0;
  const bvhPresent = bvhRecordCount > 0;
  const hierarchyFlags = (bvhPresent ? 0 : GEOMETRY_DIRECTORY_FLAGS.NoBvh) |
    GEOMETRY_DIRECTORY_FLAGS.Uncompressed;
  const expectedFlags = hierarchyPresent
    ? hierarchyFlags
    : GEOMETRY_REQUIRED_R2_B_01_FLAGS;
  if (directory.flags !== expectedFlags) {
    error("geometry-directory-flags", "GeometryDirectory flags do not match serialized capabilities");
  }
  if (directory.vertexCount === 0 || directory.sourceTriangleCount === 0) {
    error("geometry-empty-source", "GeometryDirectory source counts must be positive");
  }
  if (directory.meshletBegin !== 0 || directory.meshletCount !== meshletRecordCount) {
    error("geometry-meshlet-range", "GeometryDirectory Meshlet range does not cover MeshletRecords");
  }
  if (hierarchyPresent) {
    if (
      directory.clusterRoot >= directory.clusterCount ||
      directory.clusterCount !== clusterRecordCount
    ) {
      error("geometry-cluster-range", "GeometryDirectory hierarchy root/count are invalid");
    }
  } else if (
    directory.clusterRoot !== GEOMETRY_INVALID_INDEX ||
    directory.clusterCount !== 0
  ) {
    error("geometry-r2-b-01-future-range", "Single-level hierarchy range must be explicitly absent");
  }
  if (bvhPresent) {
    if (!hierarchyPresent) {
      error("geometry-bvh-without-hierarchy", "BVH8 requires a serialized Cluster hierarchy");
    }
    if (directory.bvhRoot >= bvhRecordCount || directory.bvhCount !== bvhRecordCount) {
      error("geometry-bvh-range", "GeometryDirectory BVH8 root/count are invalid");
    }
  } else if (directory.bvhRoot !== GEOMETRY_INVALID_INDEX || directory.bvhCount !== 0) {
    error("geometry-bvh-range", "Absent BVH8 must use invalid root and zero count");
  }
  const payloadPresent = vertexDescriptorCount > 0 || vertexDataBytes > 0 ||
    indexCount > 0 || materialRangeCount > 0;
  if (hierarchyPresent && !bvhPresent) {
    error("geometry-hierarchy-bvh-missing", "Renderable hierarchy requires its BVH8 acceleration section");
  }
  if (hierarchyPresent && !payloadPresent) {
    error("geometry-hierarchy-payload-missing", "Renderable hierarchy requires stream/index/material payload");
  }
  if (payloadPresent) {
    if (
      vertexDescriptorCount === 0 || vertexDataBytes === 0 ||
      indexCount === 0 || materialRangeCount === 0 ||
      directory.vertexStreamDescriptorBegin !== 0 ||
      directory.vertexStreamDescriptorCount !== vertexDescriptorCount ||
      directory.vertexDataByteBegin !== 0 ||
      directory.vertexDataByteLength !== vertexDataBytes ||
      directory.indexBegin !== 0 || directory.indexCount !== indexCount ||
      directory.materialRangeBegin !== 0 ||
      directory.materialRangeCount !== materialRangeCount
    ) {
      error("geometry-payload-range", "GeometryDirectory payload ranges do not cover their sections");
    }
  } else if (
    directory.vertexStreamDescriptorBegin !== 0 ||
    directory.vertexStreamDescriptorCount !== 0 ||
    directory.vertexDataByteBegin !== 0 ||
    directory.vertexDataByteLength !== 0 ||
    directory.indexBegin !== 0 ||
    directory.indexCount !== 0 ||
    directory.materialRangeBegin !== 0 ||
    directory.materialRangeCount !== 0
  ) {
    error("geometry-payload-range", "Absent stream/material payload must use zero ranges");
  }
  if (
    directory.maxMeshletVertices === 0 ||
    directory.maxMeshletVertices > 256 ||
    directory.maxMeshletTriangles === 0 ||
    directory.maxMeshletTriangles > 512
  ) {
    error("geometry-meshlet-limits", "GeometryDirectory Meshlet limits are invalid");
  }
  if (!finiteArray(directory.boundsBox) || !finiteArray(directory.boundsSphere)) {
    error("geometry-bounds-nonfinite", "GeometryDirectory bounds must be finite");
  }
  if (
    directory.boundsBox[0]! > directory.boundsBox[3]! ||
    directory.boundsBox[1]! > directory.boundsBox[4]! ||
    directory.boundsBox[2]! > directory.boundsBox[5]! ||
    directory.boundsSphere[3]! < 0
  ) {
    error("geometry-bounds-invalid", "GeometryDirectory bounds are invalid");
  }
  if (allZero(directory.sourceHash) || allZero(directory.recipeHash)) {
    error("geometry-identity-missing", "GeometryDirectory source and recipe hashes must be present");
  }
}

function validateMeshlets(
  directory: GeometryDirectoryRecord,
  meshlets: readonly GeometryMeshletRecord[],
  vertices: Uint32Array,
  triangles: Uint8Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  let vertexCursor = 0;
  let triangleCursor = 0;
  let triangleCount = 0;
  for (let index = 0; index < meshlets.length; index++) {
    const meshlet = meshlets[index]!;
    const error = (code: string, message: string): void => {
      issues.push({
        severity: "error",
        code,
        message: `Meshlet ${index}: ${message}`,
        sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
      });
    };
    if (meshlet.vertexCount === 0 || meshlet.vertexCount > directory.maxMeshletVertices) {
      error("meshlet-vertex-limit", "vertex count exceeds GeometryDirectory limits");
    }
    if (meshlet.triangleCount === 0 || meshlet.triangleCount > directory.maxMeshletTriangles) {
      error("meshlet-triangle-limit", "triangle count exceeds GeometryDirectory limits");
    }
    if (meshlet.vertexOffset !== vertexCursor) {
      error("meshlet-vertex-range-noncanonical", "vertex payload ranges must be contiguous");
    }
    if (meshlet.triangleOffset !== triangleCursor) {
      error("meshlet-triangle-range-noncanonical", "triangle payload ranges must be contiguous");
    }
    if (meshlet.vertexCount > vertices.length - Math.min(vertices.length, meshlet.vertexOffset)) {
      error("meshlet-vertex-range", "vertex payload range is out of bounds");
    }
    const localIndexCount = meshlet.triangleCount * 3;
    if (localIndexCount > triangles.length - Math.min(triangles.length, meshlet.triangleOffset)) {
      error("meshlet-triangle-range", "triangle payload range is out of bounds");
    }
    const vertexEnd = Math.min(vertices.length, meshlet.vertexOffset + meshlet.vertexCount);
    for (let offset = meshlet.vertexOffset; offset < vertexEnd; offset++) {
      if (vertices[offset]! >= directory.vertexCount) {
        error("meshlet-global-index", "global vertex index is outside SourceGeometry");
        break;
      }
    }
    const triangleEnd = Math.min(triangles.length, meshlet.triangleOffset + localIndexCount);
    for (let offset = meshlet.triangleOffset; offset < triangleEnd; offset++) {
      if (triangles[offset]! >= meshlet.vertexCount) {
        error("meshlet-local-index", "local triangle index is outside Meshlet vertices");
        break;
      }
    }
    if ((meshlet.flags & ~MESHLET_KNOWN_FLAGS) !== 0 || (meshlet.flags & MESHLET_ALPHA_MASK) === 3) {
      error("meshlet-flags", "flags contain an unsupported alpha mode or bit");
    }
    if (
      !finiteArray(meshlet.boundsBox) ||
      !finiteObject(meshlet.bounds) ||
      !finiteObject(meshlet.cone) ||
      meshlet.bounds.radius < 0 ||
      meshlet.boundsBox[0]! > meshlet.boundsBox[3]! ||
      meshlet.boundsBox[1]! > meshlet.boundsBox[4]! ||
      meshlet.boundsBox[2]! > meshlet.boundsBox[5]!
    ) {
      error("meshlet-bounds", "bounds or cone contain invalid values");
    }
    const coneAxisLength = Math.hypot(
      meshlet.cone.axisX,
      meshlet.cone.axisY,
      meshlet.cone.axisZ
    );
    if (
      meshlet.cone.cutoff < -1 ||
      meshlet.cone.cutoff > 1 ||
      (meshlet.coneValid && (
        meshlet.doubleSided ||
        coneAxisLength < 0.5 ||
        coneAxisLength > 1.5
      ))
    ) {
      error("meshlet-cone", "normal cone flags or values are invalid");
    }
    vertexCursor += meshlet.vertexCount;
    triangleCursor += localIndexCount;
    triangleCount += meshlet.triangleCount;
  }
  if (vertexCursor !== vertices.length) {
    issues.push({
      severity: "error",
      code: "meshlet-vertex-trailing-data",
      message: "Meshlet vertex payload has missing or trailing elements",
      sectionType: GEOMETRY_SECTION_TYPES.MeshletVertexIndices
    });
  }
  if (triangleCursor !== triangles.length) {
    issues.push({
      severity: "error",
      code: "meshlet-triangle-trailing-data",
      message: "Meshlet triangle payload has missing or trailing elements",
      sectionType: GEOMETRY_SECTION_TYPES.MeshletTriangleIndices
    });
  }
  if (directory.clusterCount === 0 && triangleCount !== directory.sourceTriangleCount) {
    issues.push({
      severity: "error",
      code: "meshlet-triangle-coverage",
      message: "Meshlet triangle count does not cover SourceGeometry exactly once",
      sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
    });
  }
}

function validateClusters(
  directory: GeometryDirectoryRecord,
  clusters: readonly GeometryClusterRecord[],
  children: Uint32Array,
  meshlets: readonly GeometryMeshletRecord[],
  issues: RuntimeAssetValidationIssue[]
): void {
  if (clusters.length === 0) {
    if (children.length !== 0) {
      issues.push({
        severity: "error",
        code: "cluster-children-without-hierarchy",
        message: "ClusterChildren must be empty when hierarchy is absent",
        sectionType: GEOMETRY_SECTION_TYPES.ClusterChildren
      });
    }
    return;
  }

  const incoming = new Uint32Array(clusters.length);
  const referencedMeshlets = new Uint8Array(meshlets.length);
  const leafMeshlets = new Uint8Array(meshlets.length);
  let childCursor = 0;
  let leafTriangleCount = 0;
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]!;
    const error = (code: string, message: string): void => {
      issues.push({
        severity: "error",
        code,
        message: `Cluster ${index}: ${message}`,
        sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
      });
    };
    if (cluster.childBegin !== childCursor) {
      error("cluster-child-range-noncanonical", "child ranges must be contiguous");
    }
    if (cluster.childCount > children.length - Math.min(children.length, cluster.childBegin)) {
      error("cluster-child-range", "child range is out of bounds");
    }
    childCursor += cluster.childCount;
    if (
      cluster.meshletCount === 0 ||
      cluster.meshletBegin >= meshlets.length ||
      cluster.meshletCount > meshlets.length - Math.min(meshlets.length, cluster.meshletBegin)
    ) {
      error("cluster-meshlet-range", "renderable Meshlet range is empty or out of bounds");
    }
    const meshletEnd = Math.min(meshlets.length, cluster.meshletBegin + cluster.meshletCount);
    for (let meshlet = cluster.meshletBegin; meshlet < meshletEnd; meshlet++) {
      referencedMeshlets[meshlet] = 1;
      if (cluster.childCount === 0) {
        if (leafMeshlets[meshlet] !== 0) {
          error("cluster-leaf-meshlet-duplicate", "leaf Meshlet is selected by multiple leaf clusters");
        }
        leafMeshlets[meshlet] = 1;
        leafTriangleCount += meshlets[meshlet]!.triangleCount;
      }
    }
    const leafFlag = (cluster.flags & GEOMETRY_CLUSTER_FLAGS.Leaf) !== 0;
    if (leafFlag !== (cluster.childCount === 0)) {
      error("cluster-leaf-flag", "Leaf flag does not match child count");
    }
    if ((cluster.flags & ~CLUSTER_KNOWN_FLAGS) !== 0) {
      error("cluster-flags", "flags contain an unsupported bit");
    }
    if (
      !Number.isFinite(cluster.geometricError) ||
      cluster.geometricError < 0
    ) {
      error("cluster-error", "geometric error must be finite and non-negative");
    }
    if (
      !finiteArray(cluster.boundsBox) ||
      !finiteObject(cluster.bounds) ||
      !finiteObject(cluster.cone) ||
      cluster.bounds.radius < 0 ||
      cluster.boundsBox[0]! > cluster.boundsBox[3]! ||
      cluster.boundsBox[1]! > cluster.boundsBox[4]! ||
      cluster.boundsBox[2]! > cluster.boundsBox[5]!
    ) {
      error("cluster-bounds", "bounds or cone contain invalid values");
    }
    if (cluster.depth > 64) {
      error("cluster-depth", "depth exceeds the v1 validation limit");
    }
  }
  if (childCursor !== children.length) {
    issues.push({
      severity: "error",
      code: "cluster-children-trailing-data",
      message: "ClusterChildren has missing or trailing elements",
      sectionType: GEOMETRY_SECTION_TYPES.ClusterChildren
    });
  }

  for (let parentIndex = 0; parentIndex < clusters.length; parentIndex++) {
    const parent = clusters[parentIndex]!;
    const end = Math.min(children.length, parent.childBegin + parent.childCount);
    for (let offset = parent.childBegin; offset < end; offset++) {
      const childIndex = children[offset]!;
      if (childIndex >= clusters.length) {
        issues.push({
          severity: "error",
          code: "cluster-child-index",
          message: `Cluster ${parentIndex}: child index is out of bounds`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterChildren
        });
        continue;
      }
      if (childIndex === parentIndex) {
        issues.push({
          severity: "error",
          code: "cluster-cycle",
          message: `Cluster ${parentIndex}: cluster directly references itself`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterChildren
        });
      }
      incoming[childIndex] = incoming[childIndex]! + 1;
      const child = clusters[childIndex]!;
      if (child.parent !== parentIndex || child.depth !== parent.depth + 1) {
        issues.push({
          severity: "error",
          code: "cluster-parent",
          message: `Cluster ${childIndex}: parent/depth does not match its incoming edge`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
        });
      }
      if (child.geometricError > parent.geometricError + 1e-6) {
        issues.push({
          severity: "error",
          code: "cluster-error-monotonic",
          message: `Cluster ${parentIndex}: geometric error is below child ${childIndex}`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
        });
      }
      if (!boundsContain(parent.boundsBox, child.boundsBox) ||
          !sphereContains(parent.bounds, child.bounds)) {
        issues.push({
          severity: "error",
          code: "cluster-bounds-containment",
          message: `Cluster ${parentIndex}: bounds do not conservatively contain child ${childIndex}`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
        });
      }
    }
  }

  const root = directory.clusterRoot;
  if (root < clusters.length) {
    if (clusters[root]!.parent !== GEOMETRY_INVALID_INDEX || clusters[root]!.depth !== 0) {
      issues.push({
        severity: "error",
        code: "cluster-root",
        message: "Hierarchy root must have invalid parent and depth zero",
        sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
      });
    }
    const state = new Uint8Array(clusters.length);
    const visit = (index: number): void => {
      if (state[index] === 1) {
        issues.push({
          severity: "error",
          code: "cluster-cycle",
          message: `Cluster ${index}: hierarchy contains a cycle`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterChildren
        });
        return;
      }
      if (state[index] === 2) return;
      state[index] = 1;
      const cluster = clusters[index]!;
      const end = Math.min(children.length, cluster.childBegin + cluster.childCount);
      for (let offset = cluster.childBegin; offset < end; offset++) {
        const child = children[offset]!;
        if (child < clusters.length) visit(child);
      }
      state[index] = 2;
    };
    visit(root);
    for (let index = 0; index < clusters.length; index++) {
      const expectedIncoming = index === root ? 0 : 1;
      if (incoming[index] !== expectedIncoming || state[index] !== 2) {
        issues.push({
          severity: "error",
          code: incoming[index]! > 1 ? "cluster-multi-parent" : "cluster-orphan",
          message: `Cluster ${index}: hierarchy reachability/ownership is invalid`,
          sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
        });
      }
    }
  }
  if (leafTriangleCount !== directory.sourceTriangleCount) {
    issues.push({
      severity: "error",
      code: "cluster-leaf-triangle-coverage",
      message: "Leaf Cluster Meshlets do not cover SourceGeometry exactly once",
      sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
    });
  }
  for (let index = 0; index < referencedMeshlets.length; index++) {
    if (referencedMeshlets[index] === 0) {
      issues.push({
        severity: "error",
        code: "cluster-meshlet-orphan",
        message: `Meshlet ${index} is not referenced by any Cluster`,
        sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
      });
      break;
    }
  }
}

function validateBvh8(
  directory: GeometryDirectoryRecord,
  nodes: readonly GeometryBvh8Node[],
  clusters: readonly GeometryClusterRecord[],
  issues: RuntimeAssetValidationIssue[]
): void {
  if (nodes.length === 0) return;
  const incomingNodes = new Uint32Array(nodes.length);
  const referencedClusters = new Uint32Array(clusters.length);
  const nodeBounds = nodes.map((node) => boundsOfBvhNode(node));
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const error = (code: string, message: string): void => {
      issues.push({
        severity: "error",
        code,
        message: `BVH8 node ${index}: ${message}`,
        sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
      });
    };
    const expectedMask = node.childCount === 8
      ? 0xff
      : (1 << node.childCount) - 1;
    if (
      node.childCount < 1 ||
      node.childCount > 8 ||
      node.validMask !== expectedMask ||
      (node.leafMask & ~node.validMask) !== 0
    ) {
      error("bvh8-mask", "child count, valid mask or leaf mask is non-canonical");
    }
    if (node.flags !== 0 || node.depth > 64) {
      error("bvh8-flags-depth", "flags or depth are outside the v1 contract");
    }
    for (let slot = 0; slot < 8; slot++) {
      const valid = (node.validMask & (1 << slot)) !== 0;
      const leaf = (node.leafMask & (1 << slot)) !== 0;
      const ref = node.childRefs[slot]!;
      const rangeCount = node.childRangeCounts[slot]!;
      const box = node.childBoundsBox[slot]!;
      if (!valid) {
        if (
          ref !== GEOMETRY_INVALID_INDEX ||
          rangeCount !== 0 ||
          !allZero(box)
        ) {
          error("bvh8-unused-slot", `unused child slot ${slot} is not canonical zero/invalid`);
        }
        continue;
      }
      if (!finiteArray(box) || !validBoundsBox(box)) {
        error("bvh8-child-bounds", `child slot ${slot} bounds are invalid`);
      }
      if (leaf) {
        if (
          rangeCount === 0 ||
          ref >= clusters.length ||
          rangeCount > clusters.length - Math.min(ref, clusters.length)
        ) {
          error("bvh8-cluster-range", `leaf slot ${slot} Cluster range is invalid`);
          continue;
        }
        const end = Math.min(clusters.length, ref + rangeCount);
        for (let cluster = ref; cluster < end; cluster++) {
          referencedClusters[cluster] = referencedClusters[cluster]! + 1;
          if (!boundsContain(box, clusters[cluster]!.boundsBox)) {
            error("bvh8-bounds-containment", `leaf slot ${slot} does not contain Cluster ${cluster}`);
          }
        }
      } else {
        if (rangeCount !== 0 || ref >= nodes.length) {
          error("bvh8-node-ref", `internal slot ${slot} node reference is invalid`);
          continue;
        }
        incomingNodes[ref] = incomingNodes[ref]! + 1;
        const child = nodes[ref]!;
        if (child.parent !== index || child.depth !== node.depth + 1) {
          error("bvh8-parent", `internal child ${ref} parent/depth is invalid`);
        }
        if (!boundsContain(box, nodeBounds[ref]!)) {
          error("bvh8-bounds-containment", `internal slot ${slot} does not contain node ${ref}`);
        }
      }
    }
  }

  const root = directory.bvhRoot;
  if (root < nodes.length) {
    if (nodes[root]!.parent !== GEOMETRY_INVALID_INDEX || nodes[root]!.depth !== 0) {
      issues.push({
        severity: "error",
        code: "bvh8-root",
        message: "BVH8 root must have invalid parent and depth zero",
        sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
      });
    }
    const state = new Uint8Array(nodes.length);
    const visit = (index: number): void => {
      if (state[index] === 1) {
        issues.push({
          severity: "error",
          code: "bvh8-cycle",
          message: `BVH8 node ${index}: hierarchy contains a cycle`,
          sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
        });
        return;
      }
      if (state[index] === 2) return;
      state[index] = 1;
      const node = nodes[index]!;
      for (let slot = 0; slot < 8; slot++) {
        if (
          (node.validMask & (1 << slot)) !== 0 &&
          (node.leafMask & (1 << slot)) === 0
        ) {
          const child = node.childRefs[slot]!;
          if (child < nodes.length) visit(child);
        }
      }
      state[index] = 2;
    };
    visit(root);
    for (let index = 0; index < nodes.length; index++) {
      const expectedIncoming = index === root ? 0 : 1;
      if (incomingNodes[index] !== expectedIncoming || state[index] !== 2) {
        issues.push({
          severity: "error",
          code: incomingNodes[index]! > 1 ? "bvh8-multi-parent" : "bvh8-orphan",
          message: `BVH8 node ${index}: reachability/ownership is invalid`,
          sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
        });
      }
    }
  }
  for (let cluster = 0; cluster < referencedClusters.length; cluster++) {
    if (referencedClusters[cluster] !== 1) {
      issues.push({
        severity: "error",
        code: referencedClusters[cluster]! > 1
          ? "bvh8-cluster-duplicate"
          : "bvh8-cluster-orphan",
        message: `Cluster ${cluster}: BVH8 leaf ownership is invalid`,
        sectionType: GEOMETRY_SECTION_TYPES.Bvh8Nodes
      });
    }
  }
}

function validateVertexAndIndexPayload(
  directory: GeometryDirectoryRecord,
  descriptors: readonly GeometryVertexStreamDescriptor[],
  data: Uint8Array,
  indices: Uint32Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  if (descriptors.length === 0) return;
  const semantics = new Set<string>();
  let cursor = 0;
  let positionCount = 0;
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index]!;
    const error = (code: string, message: string): void => {
      issues.push({
        severity: "error",
        code,
        message: `Vertex stream ${index} '${descriptor.semantic}': ${message}`,
        sectionType: GEOMETRY_SECTION_TYPES.VertexStreamDescriptors
      });
    };
    cursor = alignUp(cursor, 16);
    if (descriptor.dataByteOffset !== cursor) {
      error("vertex-stream-range-noncanonical", "stream offsets must be canonical 16-byte ranges");
    }
    if (
      descriptor.componentCount < 1 || descriptor.componentCount > 4 ||
      descriptor.vertexCount !== directory.vertexCount ||
      descriptor.elementStride !==
        descriptor.componentCount * vertexDataTypeBytes(descriptor.dataType) ||
      descriptor.dataByteLength !== descriptor.elementStride * descriptor.vertexCount ||
      descriptor.dataByteLength > data.length - Math.min(data.length, descriptor.dataByteOffset)
    ) {
      error("vertex-stream-layout", "component, stride, count or byte range is invalid");
    }
    if (descriptor.flags !== 0) {
      error("vertex-stream-flags", "v1 uncompressed stream flags must be zero");
    }
    if (
      descriptor.normalized &&
      (descriptor.dataType === "float32" || descriptor.dataType === "float64")
    ) {
      error("vertex-stream-normalized", "floating-point streams cannot use integer normalized semantics");
    }
    if (semantics.has(descriptor.semantic)) {
      error("vertex-stream-semantic-duplicate", "semantic occurs more than once");
    }
    semantics.add(descriptor.semantic);
    if (
      !finiteArray(descriptor.decodeScale) ||
      !finiteArray(descriptor.decodeBias) ||
      !finiteArray(descriptor.componentMinimum) ||
      !finiteArray(descriptor.componentMaximum)
    ) {
      error("vertex-stream-metadata", "decode or component bounds contain non-finite values");
    }
    for (let component = 0; component < 4; component++) {
      if (component < descriptor.componentCount) {
        if (
          descriptor.componentMinimum[component]! >
          descriptor.componentMaximum[component]!
        ) {
          error("vertex-stream-component-bounds", "component bounds are reversed");
        }
      } else if (
        descriptor.componentMinimum[component] !== 0 ||
        descriptor.componentMaximum[component] !== 0
      ) {
        error("vertex-stream-component-bounds", "unused component bounds must be zero");
      }
      if (
        descriptor.decodeScale[component] !== 1 ||
        descriptor.decodeBias[component] !== 0
      ) {
        error("vertex-stream-decode", "uncompressed v1 decode must be identity");
      }
    }
    if (descriptor.semantic === "position") {
      positionCount++;
      if (
        descriptor.dataType !== "float32" ||
        descriptor.componentCount !== 3 ||
        descriptor.normalized
      ) {
        error("vertex-position-format", "position must be unnormalized float32x3 in v1");
      }
      const expected = directory.boundsBox;
      const actual = descriptor.componentMinimum;
      const maximum = descriptor.componentMaximum;
      if (
        !nearlyEqual(actual[0]!, expected[0]!) ||
        !nearlyEqual(actual[1]!, expected[1]!) ||
        !nearlyEqual(actual[2]!, expected[2]!) ||
        !nearlyEqual(maximum[0]!, expected[3]!) ||
        !nearlyEqual(maximum[1]!, expected[4]!) ||
        !nearlyEqual(maximum[2]!, expected[5]!)
      ) {
        error("vertex-position-bounds", "position component bounds do not match GeometryDirectory");
      }
    }
    validateStreamFiniteValues(descriptor, data, index, issues);
    cursor = descriptor.dataByteOffset + descriptor.dataByteLength;
  }
  if (positionCount !== 1) {
    issues.push({
      severity: "error",
      code: "vertex-position-count",
      message: "Exactly one position stream is required",
      sectionType: GEOMETRY_SECTION_TYPES.VertexStreamDescriptors
    });
  }
  const paddedEnd = alignUp(cursor, 16);
  if (paddedEnd !== data.length || !rangeIsZero(data, cursor, paddedEnd)) {
    issues.push({
      severity: "error",
      code: "vertex-stream-trailing-data",
      message: "Vertex stream payload has non-canonical padding or trailing bytes",
      sectionType: GEOMETRY_SECTION_TYPES.VertexStreamData
    });
  }
  if (indices.length !== directory.sourceTriangleCount * 3) {
    issues.push({
      severity: "error",
      code: "geometry-index-count",
      message: "IndexData must contain exactly three u32 indices per source triangle",
      sectionType: GEOMETRY_SECTION_TYPES.IndexData
    });
  }
  for (let index = 0; index < indices.length; index++) {
    if (indices[index]! >= directory.vertexCount) {
      issues.push({
        severity: "error",
        code: "geometry-index-range",
        message: `IndexData element ${index} is outside vertexCount`,
        sectionType: GEOMETRY_SECTION_TYPES.IndexData
      });
      break;
    }
  }
}

function validateStreamFiniteValues(
  descriptor: GeometryVertexStreamDescriptor,
  data: Uint8Array,
  descriptorIndex: number,
  issues: RuntimeAssetValidationIssue[]
): void {
  if (
    descriptor.componentCount < 1 ||
    descriptor.componentCount > 4 ||
    descriptor.dataByteOffset > data.length ||
    descriptor.dataByteLength > data.length - descriptor.dataByteOffset
  ) {
    return;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const componentBytes = vertexDataTypeBytes(descriptor.dataType);
  const minimum = new Float32Array(4);
  const maximum = new Float32Array(4);
  minimum.fill(Infinity, 0, descriptor.componentCount);
  maximum.fill(-Infinity, 0, descriptor.componentCount);
  const end = Math.min(
    data.length,
    descriptor.dataByteOffset + descriptor.dataByteLength
  );
  let component = 0;
  for (let offset = descriptor.dataByteOffset;
    offset + componentBytes <= end;
    offset += componentBytes, component = (component + 1) % descriptor.componentCount
  ) {
    const raw = readVertexComponent(view, offset, descriptor.dataType);
    if (!Number.isFinite(raw)) {
      issues.push({
        severity: "error",
        code: "vertex-stream-nonfinite",
        message: `Vertex stream descriptor ${descriptorIndex} contains a non-finite component`,
        sectionType: GEOMETRY_SECTION_TYPES.VertexStreamData
      });
      return;
    }
    const value = normalizedVertexComponent(
      raw,
      descriptor.dataType,
      descriptor.normalized
    );
    minimum[component] = Math.min(minimum[component]!, value);
    maximum[component] = Math.max(maximum[component]!, value);
  }
  for (let index = 0; index < descriptor.componentCount; index++) {
    if (
      !nearlyEqual(minimum[index]!, descriptor.componentMinimum[index]!) ||
      !nearlyEqual(maximum[index]!, descriptor.componentMaximum[index]!)
    ) {
      issues.push({
        severity: "error",
        code: "vertex-stream-component-bounds",
        message: `Vertex stream descriptor ${descriptorIndex} component bounds do not match payload`,
        sectionType: GEOMETRY_SECTION_TYPES.VertexStreamData
      });
      return;
    }
  }
}

function validateMaterials(
  directory: GeometryDirectoryRecord,
  materials: readonly GeometryMaterialRangeRecord[],
  meshlets: readonly GeometryMeshletRecord[],
  clusters: readonly GeometryClusterRecord[],
  issues: RuntimeAssetValidationIssue[]
): void {
  if (materials.length === 0) return;
  let triangleCursor = 0;
  const materialIds = new Set<number>();
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index]!;
    if (
      material.firstTriangle !== triangleCursor ||
      material.triangleCount === 0 ||
      material.triangleCount > directory.sourceTriangleCount -
        Math.min(directory.sourceTriangleCount, material.firstTriangle) ||
      (material.flags & ~(MESHLET_ALPHA_MASK | MESHLET_DOUBLE_SIDED)) !== 0 ||
      (material.flags & MESHLET_ALPHA_MASK) === 3
    ) {
      issues.push({
        severity: "error",
        code: "material-range",
        message: `Material range ${index}: coverage or flags are invalid`,
        sectionType: GEOMETRY_SECTION_TYPES.MaterialRanges
      });
    }
    triangleCursor += material.triangleCount;
    materialIds.add(material.materialId);
  }
  if (triangleCursor !== directory.sourceTriangleCount) {
    issues.push({
      severity: "error",
      code: "material-range-coverage",
      message: "Material ranges do not cover source triangles exactly once",
      sectionType: GEOMETRY_SECTION_TYPES.MaterialRanges
    });
  }
  for (let index = 0; index < meshlets.length; index++) {
    const meshlet = meshlets[index]!;
    if (meshlet.materialRangeIndex >= materials.length) {
      issues.push({
        severity: "error",
        code: "meshlet-material-range",
        message: `Meshlet ${index}: material range reference is out of bounds`,
        sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
      });
      continue;
    }
    const material = materials[meshlet.materialRangeIndex]!;
    if (
      meshlet.materialId !== material.materialId ||
      meshlet.alphaMode !== material.alphaMode ||
      meshlet.doubleSided !== material.doubleSided
    ) {
      issues.push({
        severity: "error",
        code: "meshlet-material-mismatch",
        message: `Meshlet ${index}: material ID/classification does not match MaterialRanges`,
        sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
      });
    }
  }
  for (let index = 0; index < clusters.length; index++) {
    const materialId = clusters[index]!.materialId;
    if (materialId !== GEOMETRY_INVALID_INDEX && !materialIds.has(materialId)) {
      issues.push({
        severity: "error",
        code: "cluster-material",
        message: `Cluster ${index}: material ID is not declared by MaterialRanges`,
        sectionType: GEOMETRY_SECTION_TYPES.ClusterRecords
      });
    }
  }
}

function validateMeshletPositionBounds(
  descriptors: readonly GeometryVertexStreamDescriptor[],
  data: Uint8Array,
  meshlets: readonly GeometryMeshletRecord[],
  meshletVertices: Uint32Array,
  issues: RuntimeAssetValidationIssue[]
): void {
  const position = descriptors.find((descriptor) => descriptor.semantic === "position");
  if (position === undefined || position.dataType !== "float32" || position.componentCount !== 3) {
    return;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < meshlets.length; index++) {
    const meshlet = meshlets[index]!;
    const end = Math.min(
      meshletVertices.length,
      meshlet.vertexOffset + meshlet.vertexCount
    );
    for (let offset = meshlet.vertexOffset; offset < end; offset++) {
      const vertex = meshletVertices[offset]!;
      const byteOffset = position.dataByteOffset + vertex * position.elementStride;
      if (byteOffset + 12 > data.length) break;
      const x = view.getFloat32(byteOffset, true);
      const y = view.getFloat32(byteOffset + 4, true);
      const z = view.getFloat32(byteOffset + 8, true);
      const dx = x - meshlet.bounds.centerX;
      const dy = y - meshlet.bounds.centerY;
      const dz = z - meshlet.bounds.centerZ;
      if (
        x < meshlet.boundsBox[0]! - 1e-5 ||
        y < meshlet.boundsBox[1]! - 1e-5 ||
        z < meshlet.boundsBox[2]! - 1e-5 ||
        x > meshlet.boundsBox[3]! + 1e-5 ||
        y > meshlet.boundsBox[4]! + 1e-5 ||
        z > meshlet.boundsBox[5]! + 1e-5 ||
        Math.hypot(dx, dy, dz) > meshlet.bounds.radius + 1e-4
      ) {
        issues.push({
          severity: "error",
          code: "meshlet-position-bounds-containment",
          message: `Meshlet ${index}: bounds do not conservatively contain vertex ${vertex}`,
          sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
        });
        break;
      }
    }
  }
}

function boundsOfBvhNode(node: GeometryBvh8Node): Float32Array {
  const result = new Float32Array([
    Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity
  ]);
  for (let slot = 0; slot < 8; slot++) {
    if ((node.validMask & (1 << slot)) === 0) continue;
    const box = node.childBoundsBox[slot]!;
    result[0] = Math.min(result[0]!, box[0]!);
    result[1] = Math.min(result[1]!, box[1]!);
    result[2] = Math.min(result[2]!, box[2]!);
    result[3] = Math.max(result[3]!, box[3]!);
    result[4] = Math.max(result[4]!, box[4]!);
    result[5] = Math.max(result[5]!, box[5]!);
  }
  return result;
}

function validBoundsBox(box: Float32Array): boolean {
  return box.length === 6 &&
    box[0]! <= box[3]! && box[1]! <= box[4]! && box[2]! <= box[5]!;
}

function freezeReport(
  issues: RuntimeAssetValidationIssue[]
): GeometryAssetValidationReport {
  const frozen = Object.freeze(issues.map((issue) => Object.freeze(issue)));
  return Object.freeze({
    valid: !frozen.some((issue) => issue.severity === "error"),
    issues: frozen
  });
}

function writeFloatArray(view: DataView, offset: number, values: Float32Array): void {
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(offset + index * 4, values[index]!, true);
  }
}

function readFloatArray(view: DataView, offset: number, count: number): Float32Array {
  const result = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    result[index] = view.getFloat32(offset + index * 4, true);
  }
  return result;
}

function assertRecordRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  name: string
): void {
  if (offset < 0 || length > bytes.length - offset) {
    throw new RangeError(`${name} record is out of range`);
  }
}

function decodeAlphaMode(flags: number): GeometryMeshletAlphaMode {
  const value = flags & MESHLET_ALPHA_MASK;
  if (value === 1) return "mask";
  if (value === 2) return "blend";
  return "opaque";
}

function encodeMaterialRangeFlags(
  alphaMode: GeometryMeshletAlphaMode,
  doubleSided: boolean
): number {
  return encodeMeshletFlags(alphaMode, doubleSided, false);
}

function encodeVertexDataType(type: GeometryVertexDataType): number {
  switch (type) {
    case "int8": return 1;
    case "uint8": return 2;
    case "int16": return 3;
    case "uint16": return 4;
    case "int32": return 5;
    case "uint32": return 6;
    case "float32": return 7;
    case "float64": return 8;
  }
}

function decodeVertexDataType(value: number): GeometryVertexDataType {
  switch (value) {
    case 1: return "int8";
    case 2: return "uint8";
    case 3: return "int16";
    case 4: return "uint16";
    case 5: return "int32";
    case 6: return "uint32";
    case 7: return "float32";
    case 8: return "float64";
    default: throw new RangeError(`Unsupported vertex data type code ${value}`);
  }
}

function vertexDataTypeBytes(type: GeometryVertexDataType): number {
  switch (type) {
    case "int8":
    case "uint8": return 1;
    case "int16":
    case "uint16": return 2;
    case "int32":
    case "uint32":
    case "float32": return 4;
    case "float64": return 8;
  }
}

function readVertexComponent(
  view: DataView,
  offset: number,
  type: GeometryVertexDataType
): number {
  switch (type) {
    case "int8": return view.getInt8(offset);
    case "uint8": return view.getUint8(offset);
    case "int16": return view.getInt16(offset, true);
    case "uint16": return view.getUint16(offset, true);
    case "int32": return view.getInt32(offset, true);
    case "uint32": return view.getUint32(offset, true);
    case "float32": return view.getFloat32(offset, true);
    case "float64": return view.getFloat64(offset, true);
  }
}

function normalizedVertexComponent(
  value: number,
  type: GeometryVertexDataType,
  normalized: boolean
): number {
  if (!normalized) return value;
  switch (type) {
    case "int8": return Math.max(value / 127, -1);
    case "uint8": return value / 255;
    case "int16": return Math.max(value / 32767, -1);
    case "uint16": return value / 65535;
    case "int32": return Math.max(value / 2147483647, -1);
    case "uint32": return value / 4294967295;
    case "float32":
    case "float64": return value;
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
}

function finiteArray(values: Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function finiteObject(values: object): boolean {
  return Object.values(values).every((value) => Number.isFinite(value));
}

function allZero(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== 0) return false;
  }
  return true;
}

function rangeIsZero(bytes: Uint8Array, begin: number, end: number): boolean {
  if (begin < 0 || end < begin || end > bytes.length) return false;
  for (let index = begin; index < end; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function boundsContain(parent: Float32Array, child: Float32Array): boolean {
  const epsilon = 1e-5;
  return parent[0]! <= child[0]! + epsilon &&
    parent[1]! <= child[1]! + epsilon &&
    parent[2]! <= child[2]! + epsilon &&
    parent[3]! + epsilon >= child[3]! &&
    parent[4]! + epsilon >= child[4]! &&
    parent[5]! + epsilon >= child[5]!;
}

function sphereContains(
  parent: GeometryClusterRecord["bounds"],
  child: GeometryClusterRecord["bounds"]
): boolean {
  const distance = Math.hypot(
    parent.centerX - child.centerX,
    parent.centerY - child.centerY,
    parent.centerZ - child.centerZ
  );
  return distance + child.radius <= parent.radius + 1e-4;
}
