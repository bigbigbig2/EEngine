import { MeshoptClusterizer } from "meshoptimizer/clusterizer";

import {
  GEOMETRY_ASSET_SCHEMA_VERSION,
  GEOMETRY_DIRECTORY_FLAGS,
  GEOMETRY_DIRECTORY_RECORD_STRIDE,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_MESHLET_RECORD_STRIDE,
  GEOMETRY_SECTION_TYPES,
  encodeGeometryDirectoryRecord,
  encodeGeometryMeshletRecords,
  encodeMeshletFlags,
  openGeometryAssetPackage,
  type GeometryAssetPackage,
  type GeometryDirectoryRecord,
  type GeometryMeshletRecord
} from "../assets/GeometryAssetPackage.js";
import {
  createGeometryCookRecipe,
  geometryCookRecipeKey,
  type GeometryCookRecipe
} from "../assets/GeometryCookRecipe.js";
import { writeRuntimeAssetPackage } from "../assets/RuntimeAssetPackage.js";
import type {
  SourceGeometry,
  SourceMaterialRange,
  SourceNumericArray
} from "../assets/SourceGeometry.js";

export interface GeometryCookEvidence {
  readonly sourceVertexCount: number;
  readonly sourceTriangleCount: number;
  readonly meshletCount: number;
  readonly meshletVertexIndexCount: number;
  readonly meshletTriangleCount: number;
  readonly directoryBytes: number;
  readonly meshletRecordBytes: number;
  readonly meshletVertexIndexBytes: number;
  readonly meshletTriangleIndexBytes: number;
  readonly packageBytes: number;
  readonly contentHash: string;
  readonly warnings: readonly string[];
}

export interface GeometryCookResult {
  readonly bytes: ArrayBuffer;
  readonly asset: GeometryAssetPackage;
  readonly evidence: GeometryCookEvidence;
}

interface MeshletBuildResult {
  records: GeometryMeshletRecord[];
  vertices: Uint32Array;
  triangles: Uint8Array;
}

export async function cookGeometryAssetPackage(
  source: SourceGeometry,
  inputRecipe: GeometryCookRecipe
): Promise<GeometryCookResult> {
  if (!MeshoptClusterizer.supported) {
    throw new Error("meshoptimizer clusterizer is not supported in this runtime");
  }
  await MeshoptClusterizer.ready;

  const recipe = createGeometryCookRecipe(inputRecipe);
  const positions = normalizedPositions(source);
  const warnings = validateCookInput(source, positions, recipe);
  const built = buildMeshlets(source, positions, recipe, warnings);
  const sourceHash = await sha256(canonicalSourceGeometryBytes(source));
  const recipeHash = await sha256(
    new TextEncoder().encode(geometryCookRecipeKey(recipe))
  );
  const directory: GeometryDirectoryRecord = {
    schemaVersion: GEOMETRY_ASSET_SCHEMA_VERSION,
    flags:
      GEOMETRY_DIRECTORY_FLAGS.SingleLevel |
      GEOMETRY_DIRECTORY_FLAGS.NoHierarchy |
      GEOMETRY_DIRECTORY_FLAGS.NoBvh |
      GEOMETRY_DIRECTORY_FLAGS.Uncompressed,
    vertexCount: source.vertexCount,
    sourceTriangleCount: source.triangleCount,
    vertexStreamDescriptorBegin: 0,
    vertexStreamDescriptorCount: 0,
    vertexDataByteBegin: 0,
    vertexDataByteLength: 0,
    indexBegin: 0,
    indexCount: 0,
    meshletBegin: 0,
    meshletCount: built.records.length,
    clusterRoot: GEOMETRY_INVALID_INDEX,
    clusterCount: 0,
    bvhRoot: GEOMETRY_INVALID_INDEX,
    bvhCount: 0,
    materialRangeBegin: 0,
    materialRangeCount: 0,
    maxMeshletVertices: recipe.meshletMaxVertices,
    maxMeshletTriangles: recipe.meshletMaxTriangles,
    boundsBox: source.bounds.box,
    boundsSphere: source.bounds.sphere,
    sourceHash,
    recipeHash
  };
  const directoryBytes = encodeGeometryDirectoryRecord(directory);
  const recordBytes = encodeGeometryMeshletRecords(built.records);
  const bytes = await writeRuntimeAssetPackage({
    sections: [
      {
        type: GEOMETRY_SECTION_TYPES.GeometryDirectory,
        required: true,
        data: directoryBytes,
        elementStride: GEOMETRY_DIRECTORY_RECORD_STRIDE,
        elementCount: 1,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.MeshletRecords,
        required: true,
        data: recordBytes,
        elementStride: GEOMETRY_MESHLET_RECORD_STRIDE,
        elementCount: built.records.length,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.MeshletVertexIndices,
        required: true,
        data: built.vertices,
        elementStride: 4,
        elementCount: built.vertices.length,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.MeshletTriangleIndices,
        required: true,
        data: built.triangles,
        elementStride: 1,
        elementCount: built.triangles.length,
        alignment: 16
      }
    ]
  });
  const asset = await openGeometryAssetPackage(bytes);
  const evidence: GeometryCookEvidence = Object.freeze({
    sourceVertexCount: source.vertexCount,
    sourceTriangleCount: source.triangleCount,
    meshletCount: built.records.length,
    meshletVertexIndexCount: built.vertices.length,
    meshletTriangleCount: built.records.reduce(
      (total, record) => total + record.triangleCount,
      0
    ),
    directoryBytes: directoryBytes.byteLength,
    meshletRecordBytes: recordBytes.byteLength,
    meshletVertexIndexBytes: built.vertices.byteLength,
    meshletTriangleIndexBytes: built.triangles.byteLength,
    packageBytes: bytes.byteLength,
    contentHash: asset.package.manifest.contentHash,
    warnings: Object.freeze(warnings)
  });
  return Object.freeze({ bytes, asset, evidence });
}

function buildMeshlets(
  source: SourceGeometry,
  positions: Float32Array,
  recipe: GeometryCookRecipe,
  warnings: string[]
): MeshletBuildResult {
  const records: GeometryMeshletRecord[] = [];
  const vertexChunks: Uint32Array[] = [];
  const triangleChunks: Uint8Array[] = [];
  let vertexOffset = 0;
  let triangleOffset = 0;
  for (let rangeIndex = 0; rangeIndex < source.materialRanges.length; rangeIndex++) {
    const range = source.materialRanges[rangeIndex]!;
    const indexBegin = range.firstTriangle * 3;
    const indices = source.indices.slice(
      indexBegin,
      indexBegin + range.triangleCount * 3
    );
    const buffers = MeshoptClusterizer.buildMeshlets(
      indices,
      positions,
      3,
      recipe.meshletMaxVertices,
      recipe.meshletMaxTriangles,
      recipe.coneWeight
    );
    if (buffers.meshletCount === 0) {
      throw new Error(`meshoptimizer produced no Meshlets for material range ${rangeIndex}`);
    }
    const upstreamBounds = MeshoptClusterizer.computeMeshletBounds(
      buffers,
      positions,
      3
    );
    if (upstreamBounds.length !== buffers.meshletCount) {
      throw new Error("meshoptimizer Meshlet bounds count does not match Meshlet count");
    }
    for (let index = 0; index < buffers.meshletCount; index++) {
      const meshlet = MeshoptClusterizer.extractMeshlet(buffers, index);
      if (meshlet.vertices.length === 0 || meshlet.triangles.length === 0) {
        throw new Error(`meshoptimizer produced an empty Meshlet at ${rangeIndex}:${index}`);
      }
      if (meshlet.triangles.length % 3 !== 0) {
        throw new Error(`meshoptimizer produced a non-triangle Meshlet at ${rangeIndex}:${index}`);
      }
      const boundsBox = meshletBoundsBox(meshlet.vertices, positions);
      const bounds = normalizeUpstreamBounds(
        upstreamBounds[index]!,
        boundsBox,
        warnings,
        rangeIndex,
        index
      );
      const coneAxisLength = Math.hypot(
        bounds.coneAxisX,
        bounds.coneAxisY,
        bounds.coneAxisZ
      );
      const coneValid =
        !range.doubleSided &&
        Number.isFinite(bounds.coneCutoff) &&
        bounds.coneCutoff >= -1 &&
        bounds.coneCutoff < 1 &&
        coneAxisLength >= 0.5 &&
        coneAxisLength <= 1.5;
      const record: GeometryMeshletRecord = Object.freeze({
        vertexOffset,
        vertexCount: meshlet.vertices.length,
        triangleOffset,
        triangleCount: meshlet.triangles.length / 3,
        materialRangeIndex: rangeIndex,
        materialId: range.materialId,
        flags: encodeMeshletFlags(range.alphaMode, range.doubleSided, coneValid),
        alphaMode: range.alphaMode,
        doubleSided: range.doubleSided,
        coneValid,
        boundsBox,
        bounds: Object.freeze({
          centerX: bounds.centerX,
          centerY: bounds.centerY,
          centerZ: bounds.centerZ,
          radius: conservativeMeshletRadius(
            bounds,
            meshlet.vertices,
            positions,
            warnings,
            rangeIndex,
            index
          )
        }),
        cone: Object.freeze({
          apexX: bounds.coneApexX,
          apexY: bounds.coneApexY,
          apexZ: bounds.coneApexZ,
          axisX: bounds.coneAxisX,
          axisY: bounds.coneAxisY,
          axisZ: bounds.coneAxisZ,
          cutoff: bounds.coneCutoff
        })
      });
      records.push(record);
      vertexChunks.push(meshlet.vertices.slice());
      triangleChunks.push(meshlet.triangles.slice());
      vertexOffset += meshlet.vertices.length;
      triangleOffset += meshlet.triangles.length;
    }
  }
  return {
    records,
    vertices: concatenateUint32(vertexChunks, vertexOffset),
    triangles: concatenateUint8(triangleChunks, triangleOffset)
  };
}

function validateCookInput(
  source: SourceGeometry,
  positions: Float32Array,
  recipe: GeometryCookRecipe
): string[] {
  const warnings: string[] = [];
  let degenerateTriangles = 0;
  let nonManifoldEdges = 0;
  const edgeUse = new Map<string, number>();
  for (let triangle = 0; triangle < source.triangleCount; triangle++) {
    const a = source.indices[triangle * 3]!;
    const b = source.indices[triangle * 3 + 1]!;
    const c = source.indices[triangle * 3 + 2]!;
    if (triangleIsDegenerate(a, b, c, positions)) degenerateTriangles++;
    incrementEdge(edgeUse, a, b);
    incrementEdge(edgeUse, b, c);
    incrementEdge(edgeUse, c, a);
  }
  for (const count of edgeUse.values()) if (count > 2) nonManifoldEdges++;
  if (degenerateTriangles >= recipe.degenerateTriangleThreshold) {
    if (recipe.degenerateTrianglePolicy === "reject") {
      throw new RangeError(
        `SourceGeometry contains ${degenerateTriangles} degenerate triangles; recipe rejects at ${recipe.degenerateTriangleThreshold}`
      );
    }
    warnings.push(`degenerate-triangles:${degenerateTriangles}`);
  }
  if (nonManifoldEdges >= recipe.nonManifoldEdgeThreshold) {
    if (recipe.nonManifoldPolicy === "reject") {
      throw new RangeError(
        `SourceGeometry contains ${nonManifoldEdges} non-manifold edges; recipe rejects at ${recipe.nonManifoldEdgeThreshold}`
      );
    }
    warnings.push(`non-manifold-edges:${nonManifoldEdges}`);
  }
  return warnings;
}

function normalizedPositions(source: SourceGeometry): Float32Array {
  const position = source.attributes.get("position");
  if (position === undefined || position.componentCount !== 3) {
    throw new RangeError("Geometry Cooker requires position float32x3 input");
  }
  if (position.normalized) {
    throw new RangeError("Geometry Cooker requires importer-decoded, non-normalized positions");
  }
  return position.data instanceof Float32Array
    ? ensureFiniteFloat32(position.data)
    : ensureFiniteFloat32(new Float32Array(position.data));
}

function meshletBoundsBox(
  vertices: Uint32Array,
  positions: Float32Array
): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of vertices) {
    const offset = vertex * 3;
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const z = positions[offset + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]);
}

function normalizeUpstreamBounds(
  bounds: {
    centerX: number;
    centerY: number;
    centerZ: number;
    radius: number;
    coneApexX: number;
    coneApexY: number;
    coneApexZ: number;
    coneAxisX: number;
    coneAxisY: number;
    coneAxisZ: number;
    coneCutoff: number;
  },
  box: Float32Array,
  warnings: string[],
  rangeIndex: number,
  meshletIndex: number
) {
  if (Object.values(bounds).every((value) => Number.isFinite(value)) && bounds.radius >= 0) {
    return bounds;
  }
  warnings.push(`meshlet-bounds-fallback:${rangeIndex}:${meshletIndex}`);
  const centerX = 0.5 * (box[0]! + box[3]!);
  const centerY = 0.5 * (box[1]! + box[4]!);
  const centerZ = 0.5 * (box[2]! + box[5]!);
  return {
    centerX,
    centerY,
    centerZ,
    radius: 0.5 * Math.hypot(
      box[3]! - box[0]!,
      box[4]! - box[1]!,
      box[5]! - box[2]!
    ),
    coneApexX: centerX,
    coneApexY: centerY,
    coneApexZ: centerZ,
    coneAxisX: 0,
    coneAxisY: 0,
    coneAxisZ: 1,
    coneCutoff: 1
  };
}

function conservativeRadius(radius: number): number {
  if (radius === 0) return 0;
  return Math.fround(radius * (1 + 1e-6));
}

function conservativeMeshletRadius(
  bounds: { centerX: number; centerY: number; centerZ: number; radius: number },
  vertices: Uint32Array,
  positions: Float32Array,
  warnings: string[],
  rangeIndex: number,
  meshletIndex: number
): number {
  let requiredRadius = 0;
  for (const vertex of vertices) {
    const offset = vertex * 3;
    requiredRadius = Math.max(
      requiredRadius,
      Math.hypot(
        positions[offset]! - bounds.centerX,
        positions[offset + 1]! - bounds.centerY,
        positions[offset + 2]! - bounds.centerZ
      )
    );
  }
  if (requiredRadius > bounds.radius) {
    warnings.push(`meshlet-sphere-expanded:${rangeIndex}:${meshletIndex}`);
  }
  return conservativeRadius(Math.max(bounds.radius, requiredRadius));
}

function ensureFiniteFloat32(values: Float32Array): Float32Array {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError("Geometry Cooker position conversion produced a non-finite float32 value");
    }
  }
  return values;
}

function triangleIsDegenerate(
  a: number,
  b: number,
  c: number,
  positions: Float32Array
): boolean {
  if (a === b || b === c || c === a) return true;
  const ax = positions[a * 3]!;
  const ay = positions[a * 3 + 1]!;
  const az = positions[a * 3 + 2]!;
  const abx = positions[b * 3]! - ax;
  const aby = positions[b * 3 + 1]! - ay;
  const abz = positions[b * 3 + 2]! - az;
  const acx = positions[c * 3]! - ax;
  const acy = positions[c * 3 + 1]! - ay;
  const acz = positions[c * 3 + 2]! - az;
  const x = aby * acz - abz * acy;
  const y = abz * acx - abx * acz;
  const z = abx * acy - aby * acx;
  return x * x + y * y + z * z <= 1e-30;
}

function incrementEdge(edges: Map<string, number>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  edges.set(key, (edges.get(key) ?? 0) + 1);
}

function concatenateUint32(chunks: readonly Uint32Array[], length: number): Uint32Array {
  const output = new Uint32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function concatenateUint8(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function canonicalSourceGeometryBytes(source: SourceGeometry): Uint8Array {
  const attributes = [...source.attributes.values()]
    .sort((left, right) =>
      left.semantic < right.semantic ? -1 : left.semantic > right.semantic ? 1 : 0
    )
    .map((attribute) => ({
      semantic: attribute.semantic,
      componentCount: attribute.componentCount,
      normalized: attribute.normalized,
      dataType: attribute.dataType,
      data: numericArrayValues(attribute.data)
    }));
  return new TextEncoder().encode(JSON.stringify({
    topology: source.topology,
    sourceId: source.sourceId,
    indices: [...source.indices],
    attributes,
    materialRanges: source.materialRanges
  }));
}

function numericArrayValues(data: SourceNumericArray): number[] {
  return Array.from(data);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const view = bytes as Uint8Array<ArrayBuffer>;
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", view));
}
