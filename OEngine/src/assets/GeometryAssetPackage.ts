import {
  openRuntimeAssetPackage,
  type RuntimeAssetPackage,
  type RuntimeAssetValidationIssue
} from "./RuntimeAssetPackage.js";

export const GEOMETRY_ASSET_SCHEMA_VERSION = 1;
export const GEOMETRY_DIRECTORY_RECORD_STRIDE = 192;
export const GEOMETRY_MESHLET_RECORD_STRIDE = 112;
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
const HASH_BYTES = 32;

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
  validateDirectory(directory, meshlets.length, issues);
  validateMeshlets(
    directory,
    meshlets,
    meshletVertexIndices,
    meshletTriangleIndices,
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
  if (!section.required) {
    error("geometry-section-not-required", `Geometry section ${type} must be required`, type);
    return undefined;
  }
  if (section.elementStride !== stride) {
    error(
      "geometry-section-stride",
      `Geometry section ${type} stride ${section.elementStride} must be ${stride}`,
      type
    );
    return undefined;
  }
  return section;
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

function validateDirectory(
  directory: GeometryDirectoryRecord,
  meshletRecordCount: number,
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
  if (directory.flags !== GEOMETRY_REQUIRED_R2_B_01_FLAGS) {
    error("geometry-directory-flags", "R2-B-01 GeometryDirectory flags are not canonical");
  }
  if (directory.vertexCount === 0 || directory.sourceTriangleCount === 0) {
    error("geometry-empty-source", "GeometryDirectory source counts must be positive");
  }
  if (directory.meshletBegin !== 0 || directory.meshletCount !== meshletRecordCount) {
    error("geometry-meshlet-range", "GeometryDirectory Meshlet range does not cover MeshletRecords");
  }
  if (
    directory.clusterRoot !== GEOMETRY_INVALID_INDEX ||
    directory.clusterCount !== 0 ||
    directory.bvhRoot !== GEOMETRY_INVALID_INDEX ||
    directory.bvhCount !== 0
  ) {
    error("geometry-r2-b-01-future-range", "R2-B-01 hierarchy and BVH ranges must be explicitly absent");
  }
  if (
    directory.vertexStreamDescriptorBegin !== 0 ||
    directory.vertexStreamDescriptorCount !== 0 ||
    directory.vertexDataByteBegin !== 0 ||
    directory.vertexDataByteLength !== 0 ||
    directory.indexBegin !== 0 ||
    directory.indexCount !== 0 ||
    directory.materialRangeBegin !== 0 ||
    directory.materialRangeCount !== 0
  ) {
    error("geometry-r2-b-01-stream-range", "R2-B-01 stream/material ranges must remain absent until R2-B-04");
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
  if (triangleCount !== directory.sourceTriangleCount) {
    issues.push({
      severity: "error",
      code: "meshlet-triangle-coverage",
      message: "Meshlet triangle count does not cover SourceGeometry exactly once",
      sectionType: GEOMETRY_SECTION_TYPES.MeshletRecords
    });
  }
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

function finiteArray(values: Float32Array): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function finiteObject(values: object): boolean {
  return Object.values(values).every((value) => Number.isFinite(value));
}

function allZero(values: Uint8Array): boolean {
  for (const value of values) if (value !== 0) return false;
  return true;
}

function rangeIsZero(bytes: Uint8Array, begin: number, end: number): boolean {
  if (begin < 0 || end < begin || end > bytes.length) return false;
  for (let index = begin; index < end; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}
