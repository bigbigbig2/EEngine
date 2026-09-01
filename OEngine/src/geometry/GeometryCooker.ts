import { MeshoptClusterizer } from "meshoptimizer/clusterizer";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";

import {
  GEOMETRY_ASSET_SCHEMA_VERSION,
  GEOMETRY_BVH8_NODE_STRIDE,
  GEOMETRY_CLUSTER_FLAGS,
  GEOMETRY_CLUSTER_RECORD_STRIDE,
  GEOMETRY_DIRECTORY_FLAGS,
  GEOMETRY_DIRECTORY_RECORD_STRIDE,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_MATERIAL_RANGE_STRIDE,
  GEOMETRY_MESHLET_RECORD_STRIDE,
  GEOMETRY_SECTION_TYPES,
  decodeGeometryVertexComponent,
  geometryVertexDataTypeBytes,
  GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
  encodeGeometryDirectoryRecord,
  encodeGeometryClusterRecords,
  encodeGeometryBvh8Nodes,
  encodeGeometryMaterialRanges,
  encodeGeometryMeshletRecords,
  encodeGeometryVertexStreamDescriptors,
  encodeMeshletFlags,
  openGeometryAssetPackage,
  type GeometryAssetPackage,
  type GeometryClusterRecord,
  type GeometryDirectoryRecord,
  type GeometryMaterialRangeRecord,
  type GeometryMeshletRecord,
  type GeometryVertexStreamDescriptor
} from "../assets/GeometryAssetPackage.js";
import {
  createGeometryCookRecipe,
  geometryCookRecipeKey,
  type GeometryCookRecipe
} from "../assets/GeometryCookRecipe.js";
import {
  writeRuntimeAssetPackage,
  type RuntimeAssetSectionInput
} from "../assets/RuntimeAssetPackage.js";
import type {
  SourceGeometry,
  SourceMaterialRange,
  SourceNumericArray
} from "../assets/SourceGeometry.js";
import { buildGeometryBvh8 } from "./GeometryBvh8.js";

export interface GeometryCookEvidence {
  readonly sourceCanonicalBytes: number;
  readonly sourceVertexCount: number;
  readonly sourceTriangleCount: number;
  readonly meshletCount: number;
  readonly meshletVertexIndexCount: number;
  readonly meshletTriangleCount: number;
  readonly leafMeshletCount: number;
  readonly parentMeshletCount: number;
  readonly clusterCount: number;
  readonly hierarchyDepth: number;
  readonly simplificationFallbackCount: number;
  readonly bvh8NodeCount: number;
  readonly vertexStreamCount: number;
  readonly materialRangeCount: number;
  readonly directoryBytes: number;
  readonly meshletRecordBytes: number;
  readonly meshletVertexIndexBytes: number;
  readonly meshletTriangleIndexBytes: number;
  readonly bvh8Bytes: number;
  readonly vertexStreamDescriptorBytes: number;
  readonly vertexDataBytes: number;
  readonly indexBytes: number;
  readonly materialRangeBytes: number;
  readonly packageBytes: number;
  readonly sourceHash: string;
  readonly recipeHash: string;
  readonly contentHash: string;
  readonly packageHash: string;
  readonly geometricError: {
    readonly minimum: number;
    readonly maximum: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
  };
  readonly warnings: readonly string[];
}

export interface GeometryCookResult {
  readonly bytes: ArrayBuffer;
  readonly asset: GeometryAssetPackage;
  readonly evidence: GeometryCookEvidence;
  readonly timing: GeometryCookTiming;
}

export interface GeometryCookTiming {
  readonly cookTimeMs: number;
}

interface MeshletBuildResult {
  records: GeometryMeshletRecord[];
  vertices: Uint32Array;
  triangles: Uint8Array;
}

interface MeshletBuildState {
  records: GeometryMeshletRecord[];
  vertexChunks: Uint32Array[];
  triangleChunks: Uint8Array[];
  vertexOffset: number;
  triangleOffset: number;
}

interface HierarchyNode {
  children: HierarchyNode[];
  meshletBegin: number;
  meshletCount: number;
  geometricError: number;
  materialRangeIndex: number;
  materialId: number;
  alphaMode: SourceMaterialRange["alphaMode"];
  doubleSided: boolean;
  simplificationFallback: boolean;
  syntheticRoot: boolean;
}

interface HierarchyBuildResult {
  clusters: GeometryClusterRecord[];
  children: Uint32Array;
  depth: number;
  fallbackCount: number;
}

interface GeometryPayloadBuildResult {
  readonly descriptors: readonly GeometryVertexStreamDescriptor[];
  readonly descriptorBytes: Uint8Array;
  readonly vertexDataBytes: Uint8Array;
  readonly indexBytes: Uint8Array;
  readonly materialRanges: readonly GeometryMaterialRangeRecord[];
  readonly materialRangeBytes: Uint8Array;
}

export async function cookGeometryAssetPackage(
  source: SourceGeometry,
  inputRecipe: GeometryCookRecipe
): Promise<GeometryCookResult> {
  const cookStarted = nowMilliseconds();
  if (!MeshoptClusterizer.supported || !MeshoptSimplifier.supported) {
    throw new Error("meshoptimizer clusterizer is not supported in this runtime");
  }
  await Promise.all([MeshoptClusterizer.ready, MeshoptSimplifier.ready]);

  const recipe = createGeometryCookRecipe(inputRecipe);
  const positions = normalizedPositions(source);
  const warnings = validateCookInput(source, positions, recipe);
  const state = buildMeshlets(source, positions, recipe, warnings);
  const leafMeshletCount = state.records.length;
  const hierarchy = recipe.hierarchyMode === "renderable"
    ? buildRenderableHierarchy(source, positions, recipe, state, warnings)
    : null;
  const built = finalizeMeshlets(state);
  const bvh8Nodes = hierarchy === null
    ? Object.freeze([])
    : buildGeometryBvh8(hierarchy.clusters);
  const payload = recipe.hierarchyMode === "single-level"
    ? null
    : buildGeometryPayload(source, positions);
  const canonicalSourceBytes = canonicalSourceGeometryBytes(source);
  const sourceHash = await sha256(canonicalSourceBytes);
  const recipeHash = await sha256(
    new TextEncoder().encode(geometryCookRecipeKey(recipe))
  );
  const directory: GeometryDirectoryRecord = {
    schemaVersion: GEOMETRY_ASSET_SCHEMA_VERSION,
    flags: hierarchy === null
      ? GEOMETRY_DIRECTORY_FLAGS.SingleLevel |
        GEOMETRY_DIRECTORY_FLAGS.NoHierarchy |
        GEOMETRY_DIRECTORY_FLAGS.NoBvh |
        GEOMETRY_DIRECTORY_FLAGS.Uncompressed
      : GEOMETRY_DIRECTORY_FLAGS.Uncompressed,
    vertexCount: source.vertexCount,
    sourceTriangleCount: source.triangleCount,
    vertexStreamDescriptorBegin: 0,
    vertexStreamDescriptorCount: payload?.descriptors.length ?? 0,
    vertexDataByteBegin: 0,
    vertexDataByteLength: payload?.vertexDataBytes.byteLength ?? 0,
    indexBegin: 0,
    indexCount: payload === null ? 0 : source.indices.length,
    meshletBegin: 0,
    meshletCount: built.records.length,
    clusterRoot: hierarchy === null ? GEOMETRY_INVALID_INDEX : 0,
    clusterCount: hierarchy?.clusters.length ?? 0,
    bvhRoot: bvh8Nodes.length === 0 ? GEOMETRY_INVALID_INDEX : 0,
    bvhCount: bvh8Nodes.length,
    materialRangeBegin: 0,
    materialRangeCount: payload?.materialRanges.length ?? 0,
    maxMeshletVertices: recipe.meshletMaxVertices,
    maxMeshletTriangles: recipe.meshletMaxTriangles,
    boundsBox: source.bounds.box,
    boundsSphere: source.bounds.sphere,
    sourceHash,
    recipeHash
  };
  const directoryBytes = encodeGeometryDirectoryRecord(directory);
  const recordBytes = encodeGeometryMeshletRecords(built.records);
  const clusterBytes = hierarchy === null
    ? null
    : encodeGeometryClusterRecords(hierarchy.clusters);
  const bvhBytes = bvh8Nodes.length === 0
    ? null
    : encodeGeometryBvh8Nodes(bvh8Nodes);
  const sections: RuntimeAssetSectionInput[] = [
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
  ];
  if (hierarchy !== null && clusterBytes !== null) {
    sections.push(
      {
        type: GEOMETRY_SECTION_TYPES.ClusterRecords,
        required: true,
        data: clusterBytes,
        elementStride: GEOMETRY_CLUSTER_RECORD_STRIDE,
        elementCount: hierarchy.clusters.length,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.ClusterChildren,
        required: true,
        data: hierarchy.children,
        elementStride: 4,
        elementCount: hierarchy.children.length,
        alignment: 16
      }
    );
  }
  if (bvhBytes !== null) {
    sections.push({
      type: GEOMETRY_SECTION_TYPES.Bvh8Nodes,
      required: true,
      data: bvhBytes,
      elementStride: GEOMETRY_BVH8_NODE_STRIDE,
      elementCount: bvh8Nodes.length,
      alignment: 16
    });
  }
  if (payload !== null) {
    sections.push(
      {
        type: GEOMETRY_SECTION_TYPES.VertexStreamDescriptors,
        required: true,
        data: payload.descriptorBytes,
        elementStride: GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
        elementCount: payload.descriptors.length,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.VertexStreamData,
        required: true,
        data: payload.vertexDataBytes,
        elementStride: 1,
        elementCount: payload.vertexDataBytes.byteLength,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.IndexData,
        required: true,
        data: payload.indexBytes,
        elementStride: 4,
        elementCount: source.indices.length,
        alignment: 16
      },
      {
        type: GEOMETRY_SECTION_TYPES.MaterialRanges,
        required: true,
        data: payload.materialRangeBytes,
        elementStride: GEOMETRY_MATERIAL_RANGE_STRIDE,
        elementCount: payload.materialRanges.length,
        alignment: 16
      }
    );
  }
  const bytes = await writeRuntimeAssetPackage({
    sections
  });
  const asset = await openGeometryAssetPackage(bytes);
  const packageHash = await sha256(new Uint8Array(bytes));
  const errorDistribution = geometryErrorDistribution(asset.clusters);
  const evidence: GeometryCookEvidence = Object.freeze({
    sourceCanonicalBytes: canonicalSourceBytes.byteLength,
    sourceVertexCount: source.vertexCount,
    sourceTriangleCount: source.triangleCount,
    meshletCount: built.records.length,
    meshletVertexIndexCount: built.vertices.length,
    meshletTriangleCount: built.records.reduce(
      (total, record) => total + record.triangleCount,
      0
    ),
    leafMeshletCount,
    parentMeshletCount: built.records.length - leafMeshletCount,
    clusterCount: hierarchy?.clusters.length ?? 0,
    hierarchyDepth: hierarchy?.depth ?? 0,
    simplificationFallbackCount: hierarchy?.fallbackCount ?? 0,
    bvh8NodeCount: bvh8Nodes.length,
    vertexStreamCount: payload?.descriptors.length ?? 0,
    materialRangeCount: payload?.materialRanges.length ?? 0,
    directoryBytes: directoryBytes.byteLength,
    meshletRecordBytes: recordBytes.byteLength,
    meshletVertexIndexBytes: built.vertices.byteLength,
    meshletTriangleIndexBytes: built.triangles.byteLength,
    bvh8Bytes: bvhBytes?.byteLength ?? 0,
    vertexStreamDescriptorBytes: payload?.descriptorBytes.byteLength ?? 0,
    vertexDataBytes: payload?.vertexDataBytes.byteLength ?? 0,
    indexBytes: payload?.indexBytes.byteLength ?? 0,
    materialRangeBytes: payload?.materialRangeBytes.byteLength ?? 0,
    packageBytes: bytes.byteLength,
    sourceHash: toHex(sourceHash),
    recipeHash: toHex(recipeHash),
    contentHash: asset.package.manifest.contentHash,
    packageHash: toHex(packageHash),
    geometricError: errorDistribution,
    warnings: Object.freeze(warnings)
  });
  const timing = Object.freeze({ cookTimeMs: nowMilliseconds() - cookStarted });
  return Object.freeze({ bytes, asset, evidence, timing });
}

function buildMeshlets(
  source: SourceGeometry,
  positions: Float32Array,
  recipe: GeometryCookRecipe,
  warnings: string[]
): MeshletBuildState {
  const state: MeshletBuildState = {
    records: [],
    vertexChunks: [],
    triangleChunks: [],
    vertexOffset: 0,
    triangleOffset: 0
  };
  for (let rangeIndex = 0; rangeIndex < source.materialRanges.length; rangeIndex++) {
    const range = source.materialRanges[rangeIndex]!;
    const indexBegin = range.firstTriangle * 3;
    const indices = source.indices.slice(
      indexBegin,
      indexBegin + range.triangleCount * 3
    );
    appendMeshlets(state, indices, positions, recipe, warnings, range, rangeIndex);
  }
  return state;
}

function appendMeshlets(
  state: MeshletBuildState,
  indices: Uint32Array,
  positions: Float32Array,
  recipe: GeometryCookRecipe,
  warnings: string[],
  range: SourceMaterialRange,
  rangeIndex: number
): { meshletBegin: number; meshletCount: number } {
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
  const upstreamBounds = MeshoptClusterizer.computeMeshletBounds(buffers, positions, 3);
  if (upstreamBounds.length !== buffers.meshletCount) {
    throw new Error("meshoptimizer Meshlet bounds count does not match Meshlet count");
  }
  const meshletBegin = state.records.length;
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
      upstreamBounds[index]!, boundsBox, warnings, rangeIndex, index
    );
    const coneAxisLength = Math.hypot(
      bounds.coneAxisX, bounds.coneAxisY, bounds.coneAxisZ
    );
    const coneValid =
      !range.doubleSided &&
      Number.isFinite(bounds.coneCutoff) &&
      bounds.coneCutoff >= -1 &&
      bounds.coneCutoff < 1 &&
      coneAxisLength >= 0.5 &&
      coneAxisLength <= 1.5;
    state.records.push(Object.freeze({
      vertexOffset: state.vertexOffset,
      vertexCount: meshlet.vertices.length,
      triangleOffset: state.triangleOffset,
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
          bounds, meshlet.vertices, positions, warnings, rangeIndex, index
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
    }));
    state.vertexChunks.push(meshlet.vertices.slice());
    state.triangleChunks.push(meshlet.triangles.slice());
    state.vertexOffset += meshlet.vertices.length;
    state.triangleOffset += meshlet.triangles.length;
  }
  return { meshletBegin, meshletCount: buffers.meshletCount };
}

function finalizeMeshlets(state: MeshletBuildState): MeshletBuildResult {
  return {
    records: state.records,
    vertices: concatenateUint32(state.vertexChunks, state.vertexOffset),
    triangles: concatenateUint8(state.triangleChunks, state.triangleOffset)
  };
}

function buildGeometryPayload(
  source: SourceGeometry,
  positions: Float32Array
): GeometryPayloadBuildResult {
  const descriptors: GeometryVertexStreamDescriptor[] = [];
  const streams: Uint8Array[] = [];
  let byteLength = 0;
  const orderedStreams = [...source.attributes.values()].sort((left, right) =>
    vertexSemanticOrder(left.semantic) - vertexSemanticOrder(right.semantic) ||
    (left.semantic < right.semantic ? -1 : left.semantic > right.semantic ? 1 : 0)
  );
  for (const sourceStream of orderedStreams) {
    if (sourceStream.componentCount > 4) {
      throw new RangeError(
        `Vertex stream '${sourceStream.semantic}' has ${sourceStream.componentCount} components; Geometry v1 supports at most 4`
      );
    }
    const convertToFloat32 = sourceStream.semantic === "position" ||
      sourceStream.dataType === "float64";
    const streamData = sourceStream.semantic === "position"
      ? positions
      : convertToFloat32
        ? new Float32Array(sourceStream.data)
        : sourceStream.data;
    const dataType = convertToFloat32 ? "float32" as const : sourceStream.dataType;
    const componentBytes = geometryVertexDataTypeBytes(dataType);
    const elementStride = sourceStream.componentCount * componentBytes;
    const dataBytes = encodeNumericArrayLittleEndian(streamData, dataType);
    byteLength = alignUp(byteLength, 16);
    const dataByteOffset = byteLength;
    byteLength += dataBytes.byteLength;
    streams.push(dataBytes);
    const componentMinimum = new Float32Array(4);
    const componentMaximum = new Float32Array(4);
    componentMinimum.fill(Infinity, 0, sourceStream.componentCount);
    componentMaximum.fill(-Infinity, 0, sourceStream.componentCount);
    for (let vertex = 0; vertex < source.vertexCount; vertex++) {
      for (let component = 0; component < sourceStream.componentCount; component++) {
        const raw = streamData[vertex * sourceStream.componentCount + component]!;
        const value = dataType === "float32"
          ? raw
          : decodeGeometryVertexComponent(raw, dataType, sourceStream.normalized);
        componentMinimum[component] = Math.min(componentMinimum[component]!, value);
        componentMaximum[component] = Math.max(componentMaximum[component]!, value);
      }
    }
    if (!componentMinimum.every(Number.isFinite) || !componentMaximum.every(Number.isFinite)) {
      throw new RangeError(`Vertex stream '${sourceStream.semantic}' bounds are not finite float32`);
    }
    descriptors.push(Object.freeze({
      semantic: sourceStream.semantic,
      dataByteOffset,
      dataByteLength: dataBytes.byteLength,
      elementStride,
      vertexCount: source.vertexCount,
      componentCount: sourceStream.componentCount,
      dataType,
      normalized: dataType === "float32" ? false : sourceStream.normalized,
      flags: 0,
      decodeScale: new Float32Array([1, 1, 1, 1]),
      decodeBias: new Float32Array(4),
      componentMinimum,
      componentMaximum
    }));
  }
  const vertexDataBytes = new Uint8Array(alignUp(byteLength, 16));
  for (let index = 0; index < descriptors.length; index++) {
    vertexDataBytes.set(streams[index]!, descriptors[index]!.dataByteOffset);
  }
  const materialRanges = source.materialRanges.map((range) => Object.freeze({
    firstTriangle: range.firstTriangle,
    triangleCount: range.triangleCount,
    materialId: range.materialId,
    flags: encodeMeshletFlags(range.alphaMode, range.doubleSided, false),
    alphaMode: range.alphaMode,
    doubleSided: range.doubleSided
  }));
  return {
    descriptors: Object.freeze(descriptors),
    descriptorBytes: encodeGeometryVertexStreamDescriptors(descriptors),
    vertexDataBytes,
    indexBytes: encodeNumericArrayLittleEndian(source.indices, "uint32"),
    materialRanges: Object.freeze(materialRanges),
    materialRangeBytes: encodeGeometryMaterialRanges(materialRanges)
  };
}

function encodeNumericArrayLittleEndian(
  values: SourceNumericArray,
  dataType: GeometryVertexStreamDescriptor["dataType"]
): Uint8Array {
  const componentBytes = geometryVertexDataTypeBytes(dataType);
  const bytes = new Uint8Array(values.length * componentBytes);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    const offset = index * componentBytes;
    const value = values[index]!;
    switch (dataType) {
      case "int8": view.setInt8(offset, value); break;
      case "uint8": view.setUint8(offset, value); break;
      case "int16": view.setInt16(offset, value, true); break;
      case "uint16": view.setUint16(offset, value, true); break;
      case "int32": view.setInt32(offset, value, true); break;
      case "uint32": view.setUint32(offset, value, true); break;
      case "float32": view.setFloat32(offset, value, true); break;
      case "float64": view.setFloat64(offset, value, true); break;
    }
  }
  return bytes;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function vertexSemanticOrder(semantic: string): number {
  const order = [
    "position", "normal", "tangent", "color", "uv0", "uv1", "joints", "weights"
  ];
  const index = order.indexOf(semantic);
  return index < 0 ? order.length : index;
}

function buildRenderableHierarchy(
  source: SourceGeometry,
  positions: Float32Array,
  recipe: GeometryCookRecipe,
  state: MeshletBuildState,
  warnings: string[]
): HierarchyBuildResult | null {
  const leafCount = state.records.length;
  const leavesByRange = new Map<number, HierarchyNode[]>();
  for (let meshlet = 0; meshlet < leafCount; meshlet++) {
    const record = state.records[meshlet]!;
    const nodes = leavesByRange.get(record.materialRangeIndex) ?? [];
    nodes.push({
      children: [],
      meshletBegin: meshlet,
      meshletCount: 1,
      geometricError: 0,
      materialRangeIndex: record.materialRangeIndex,
      materialId: record.materialId,
      alphaMode: record.alphaMode,
      doubleSided: record.doubleSided,
      simplificationFallback: false,
      syntheticRoot: false
    });
    leavesByRange.set(record.materialRangeIndex, nodes);
  }

  const materialRoots: HierarchyNode[] = [];
  let fallbackCount = 0;
  for (const [rangeIndex, initialLevel] of leavesByRange) {
    let level = initialLevel;
    let depth = 0;
    while (level.length > 1) {
      if (depth >= recipe.hierarchyMaxDepth) {
        throw new RangeError("Renderable hierarchy exceeds recipe hierarchyMaxDepth");
      }
      const groups = groupHierarchyNodes(level, state, recipe.hierarchyTargetFanout);
      const next: HierarchyNode[] = [];
      for (const group of groups) {
        if (group.length === 1) {
          next.push(group[0]!);
          continue;
        }
        const combined = globalIndicesForNodes(group, state);
        const targetTriangles = Math.max(
          1,
          Math.floor((combined.length / 3) * recipe.simplificationTargetRatio)
        );
        const targetIndexCount = targetTriangles * 3;
        const [candidate, simplificationError] = MeshoptSimplifier.simplify(
          combined,
          positions,
          3,
          targetIndexCount,
          recipe.simplificationErrorLimit,
          ["LockBorder", "Sparse", "ErrorAbsolute"]
        );
        const ratio = candidate.length / combined.length;
        const fallback =
          candidate.length === 0 ||
          candidate.length >= combined.length ||
          ratio > recipe.simplificationFailureRatio;
        const parentIndices = fallback ? combined : new Uint32Array(candidate);
        if (fallback) {
          fallbackCount++;
          warnings.push(`hierarchy-simplification-fallback:${rangeIndex}:${depth}:${fallbackCount}`);
        }
        const range = source.materialRanges[rangeIndex]!;
        const parentMeshlets = appendMeshlets(
          state,
          parentIndices,
          positions,
          recipe,
          warnings,
          range,
          rangeIndex
        );
        next.push({
          children: group,
          ...parentMeshlets,
          geometricError: Math.max(
            fallback ? 0 : simplificationError,
            ...group.map((node) => node.geometricError)
          ),
          materialRangeIndex: rangeIndex,
          materialId: range.materialId,
          alphaMode: range.alphaMode,
          doubleSided: range.doubleSided,
          simplificationFallback: fallback,
          syntheticRoot: false
        });
      }
      level = next;
      depth++;
    }
    materialRoots.push(level[0]!);
  }

  let root: HierarchyNode;
  if (materialRoots.length === 1) {
    root = materialRoots[0]!;
    if (root.children.length === 0) return null;
  } else {
    const meshletBegin = state.records.length;
    let meshletCount = 0;
    for (const materialRoot of materialRoots) {
      const indices = globalIndicesForNodes([materialRoot], state);
      const rangeIndex = materialRoot.materialRangeIndex;
      const appended = appendMeshlets(
        state,
        indices,
        positions,
        recipe,
        warnings,
        source.materialRanges[rangeIndex]!,
        rangeIndex
      );
      meshletCount += appended.meshletCount;
    }
    root = {
      children: materialRoots,
      meshletBegin,
      meshletCount,
      geometricError: Math.max(...materialRoots.map((node) => node.geometricError)),
      materialRangeIndex: GEOMETRY_INVALID_INDEX,
      materialId: GEOMETRY_INVALID_INDEX,
      alphaMode: "opaque",
      doubleSided: materialRoots.some((node) => node.doubleSided),
      simplificationFallback: false,
      syntheticRoot: true
    };
  }
  return flattenHierarchy(root, state, positions, fallbackCount, warnings);
}

function groupHierarchyNodes(
  nodes: readonly HierarchyNode[],
  state: MeshletBuildState,
  fanout: number
): HierarchyNode[][] {
  const vertices = nodes.map((node) => uniqueVerticesForNode(node, state));
  const owners = new Map<number, number[]>();
  for (let index = 0; index < vertices.length; index++) {
    for (const vertex of vertices[index]!) {
      const list = owners.get(vertex) ?? [];
      list.push(index);
      owners.set(vertex, list);
    }
  }
  const assigned = new Uint8Array(nodes.length);
  const groups: HierarchyNode[][] = [];
  for (let seed = 0; seed < nodes.length; seed++) {
    if (assigned[seed] !== 0) continue;
    const groupIndices = [seed];
    assigned[seed] = 1;
    while (groupIndices.length < fanout) {
      const scores = new Map<number, number>();
      for (const member of groupIndices) {
        for (const vertex of vertices[member]!) {
          for (const candidate of owners.get(vertex) ?? []) {
            if (assigned[candidate] === 0) {
              scores.set(candidate, (scores.get(candidate) ?? 0) + 1);
            }
          }
        }
      }
      let best = -1;
      let bestScore = -1;
      for (const [candidate, score] of scores) {
        if (score > bestScore || (score === bestScore && candidate < best)) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best < 0) {
        best = assigned.findIndex((value) => value === 0);
      }
      if (best < 0) break;
      assigned[best] = 1;
      groupIndices.push(best);
    }
    groups.push(groupIndices.map((index) => nodes[index]!));
  }
  return groups;
}

function uniqueVerticesForNode(
  node: HierarchyNode,
  state: MeshletBuildState
): Set<number> {
  const result = new Set<number>();
  for (
    let meshlet = node.meshletBegin;
    meshlet < node.meshletBegin + node.meshletCount;
    meshlet++
  ) {
    for (const vertex of state.vertexChunks[meshlet]!) result.add(vertex);
  }
  return result;
}

function globalIndicesForNodes(
  nodes: readonly HierarchyNode[],
  state: MeshletBuildState
): Uint32Array {
  let length = 0;
  for (const node of nodes) {
    for (
      let meshlet = node.meshletBegin;
      meshlet < node.meshletBegin + node.meshletCount;
      meshlet++
    ) {
      length += state.triangleChunks[meshlet]!.length;
    }
  }
  const output = new Uint32Array(length);
  let offset = 0;
  for (const node of nodes) {
    for (
      let meshlet = node.meshletBegin;
      meshlet < node.meshletBegin + node.meshletCount;
      meshlet++
    ) {
      const vertices = state.vertexChunks[meshlet]!;
      for (const local of state.triangleChunks[meshlet]!) {
        output[offset++] = vertices[local]!;
      }
    }
  }
  return output;
}

function flattenHierarchy(
  root: HierarchyNode,
  state: MeshletBuildState,
  positions: Float32Array,
  fallbackCount: number,
  warnings: string[]
): HierarchyBuildResult {
  const nodes = [root];
  const parents = [GEOMETRY_INVALID_INDEX];
  const depths = [0];
  const childRanges: Array<{ begin: number; count: number }> = [];
  const childIndices: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const begin = childIndices.length;
    for (const child of node.children) {
      const childIndex = nodes.length;
      nodes.push(child);
      parents.push(index);
      depths.push(depths[index]! + 1);
      childIndices.push(childIndex);
    }
    childRanges.push({ begin, count: node.children.length });
  }
  const boundsCache = new Map<HierarchyNode, ClusterBounds>();
  const clusters = nodes.map((node, index) => {
    const bounds = hierarchyNodeBounds(node, state, positions, boundsCache, warnings);
    let flags = node.children.length === 0 ? GEOMETRY_CLUSTER_FLAGS.Leaf : 0;
    if (node.syntheticRoot) flags |= GEOMETRY_CLUSTER_FLAGS.SyntheticRoot;
    if (node.materialId === GEOMETRY_INVALID_INDEX) flags |= GEOMETRY_CLUSTER_FLAGS.MixedMaterial;
    if (node.doubleSided) flags |= GEOMETRY_CLUSTER_FLAGS.DoubleSided;
    if (node.simplificationFallback) flags |= GEOMETRY_CLUSTER_FLAGS.SimplificationFallback;
    if (bounds.coneValid && !node.doubleSided && !node.syntheticRoot) {
      flags |= GEOMETRY_CLUSTER_FLAGS.ConeValid;
    }
    return Object.freeze({
      childBegin: childRanges[index]!.begin,
      childCount: childRanges[index]!.count,
      meshletBegin: node.meshletBegin,
      meshletCount: node.meshletCount,
      parent: parents[index]!,
      depth: depths[index]!,
      materialId: node.materialId,
      flags,
      geometricError: Math.fround(node.geometricError),
      boundsBox: bounds.box,
      bounds: bounds.sphere,
      cone: bounds.cone
    });
  });
  return {
    clusters,
    children: new Uint32Array(childIndices),
    depth: Math.max(...depths),
    fallbackCount
  };
}

interface ClusterBounds {
  box: Float32Array;
  sphere: GeometryClusterRecord["bounds"];
  cone: GeometryClusterRecord["cone"];
  coneValid: boolean;
}

// meshoptimizer v1.0's public JS boundary asserts this exact upper bound before
// calling meshopt_computeClusterBounds. Hierarchy nodes are allowed to aggregate
// more work than one cluster, so those nodes use the upstream sphere API and
// explicitly disable cone culling instead of violating the dependency contract.
const MESHOPT_CLUSTER_BOUNDS_MAX_TRIANGLES = 512;

function hierarchyNodeBounds(
  node: HierarchyNode,
  state: MeshletBuildState,
  positions: Float32Array,
  cache: Map<HierarchyNode, ClusterBounds>,
  warnings: string[]
): ClusterBounds {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  const indices = globalIndicesForNodes([node], state);
  const unique = uniqueVerticesForNode(node, state);
  const vertexArray = new Uint32Array(unique);
  let box = meshletBoundsBox(vertexArray, positions);
  const triangleCount = indices.length / 3;
  const usesClusterBounds = triangleCount <= MESHOPT_CLUSTER_BOUNDS_MAX_TRIANGLES;
  const upstream = usesClusterBounds
    ? MeshoptClusterizer.computeClusterBounds(indices, positions, 3)
    : MeshoptClusterizer.computeSphereBounds(
        compactVertexPositions(vertexArray, positions),
        3
      );
  if (!usesClusterBounds) {
    warnings.push(`hierarchy-bounds-sphere-only:${triangleCount}`);
  }
  const normalized = normalizeUpstreamBounds(upstream, box, warnings, -1, triangleCount);
  let sphere = Object.freeze({
    centerX: normalized.centerX,
    centerY: normalized.centerY,
    centerZ: normalized.centerZ,
    radius: conservativeMeshletRadius(
      normalized,
      vertexArray,
      positions,
      warnings,
      -1,
      triangleCount
    )
  });
  for (const child of node.children) {
    const childBounds = hierarchyNodeBounds(child, state, positions, cache, warnings);
    box = mergeBoxes(box, childBounds.box);
    sphere = mergeSpheres(sphere, childBounds.sphere);
  }
  const axisLength = Math.hypot(
    normalized.coneAxisX, normalized.coneAxisY, normalized.coneAxisZ
  );
  const result: ClusterBounds = {
    box,
    sphere,
    cone: Object.freeze(usesClusterBounds ? {
      apexX: normalized.coneApexX,
      apexY: normalized.coneApexY,
      apexZ: normalized.coneApexZ,
      axisX: normalized.coneAxisX,
      axisY: normalized.coneAxisY,
      axisZ: normalized.coneAxisZ,
      cutoff: normalized.coneCutoff
    } : {
      apexX: sphere.centerX,
      apexY: sphere.centerY,
      apexZ: sphere.centerZ,
      axisX: 0,
      axisY: 0,
      axisZ: 1,
      cutoff: 1
    }),
    coneValid: usesClusterBounds && Number.isFinite(normalized.coneCutoff) &&
      normalized.coneCutoff >= -1 && normalized.coneCutoff < 1 &&
      axisLength >= 0.5 && axisLength <= 1.5
  };
  cache.set(node, result);
  return result;
}

function compactVertexPositions(
  vertices: Uint32Array,
  positions: Float32Array
): Float32Array {
  const compact = new Float32Array(vertices.length * 3);
  for (let index = 0; index < vertices.length; index++) {
    const source = vertices[index]! * 3;
    compact[index * 3] = positions[source]!;
    compact[index * 3 + 1] = positions[source + 1]!;
    compact[index * 3 + 2] = positions[source + 2]!;
  }
  return compact;
}

function mergeBoxes(a: Float32Array, b: Float32Array): Float32Array {
  return new Float32Array([
    Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.min(a[2]!, b[2]!),
    Math.max(a[3]!, b[3]!), Math.max(a[4]!, b[4]!), Math.max(a[5]!, b[5]!)
  ]);
}

function mergeSpheres(
  a: GeometryClusterRecord["bounds"],
  b: GeometryClusterRecord["bounds"]
): GeometryClusterRecord["bounds"] {
  const dx = b.centerX - a.centerX;
  const dy = b.centerY - a.centerY;
  const dz = b.centerZ - a.centerZ;
  const distance = Math.hypot(dx, dy, dz);
  if (a.radius >= distance + b.radius) return a;
  if (b.radius >= distance + a.radius) return b;
  if (distance === 0) {
    return Object.freeze({ ...a, radius: conservativeRadius(Math.max(a.radius, b.radius)) });
  }
  const radius = 0.5 * (distance + a.radius + b.radius);
  const t = (radius - a.radius) / distance;
  // Cluster records serialize centers as float32. Re-evaluate the required
  // radius after quantizing the merged center; otherwise large-coordinate,
  // small-extent geometry can lose more than the validator epsilon here.
  const centerX = Math.fround(a.centerX + dx * t);
  const centerY = Math.fround(a.centerY + dy * t);
  const centerZ = Math.fround(a.centerZ + dz * t);
  const requiredRadius = Math.max(
    Math.hypot(centerX - a.centerX, centerY - a.centerY, centerZ - a.centerZ) + a.radius,
    Math.hypot(centerX - b.centerX, centerY - b.centerY, centerZ - b.centerZ) + b.radius
  );
  return Object.freeze({
    centerX,
    centerY,
    centerZ,
    radius: conservativeRadius(Math.max(radius, requiredRadius))
  });
}

function validateCookInput(
  source: SourceGeometry,
  positions: Float32Array,
  recipe: GeometryCookRecipe
): string[] {
  const warnings: string[] = [];
  if (recipe.hierarchyMode === "renderable") {
    const semanticEncoder = new TextEncoder();
    for (const stream of source.attributes.values()) {
      const semanticBytes = semanticEncoder.encode(stream.semantic);
      if (
        stream.componentCount > 4 ||
        semanticBytes.length === 0 ||
        semanticBytes.length >= 32 ||
        stream.semantic.includes("\0")
      ) {
        throw new RangeError(
          `Vertex stream '${stream.semantic}' cannot be represented by Geometry package v1`
        );
      }
    }
    const position = source.attributes.get("position")!;
    if (
      position.normalized ||
      (position.dataType !== "float32" && position.dataType !== "float64")
    ) {
      throw new RangeError(
        "Geometry package v1 position input must be non-normalized float32/float64"
      );
    }
  }
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

function geometryErrorDistribution(
  clusters: readonly GeometryClusterRecord[]
): GeometryCookEvidence["geometricError"] {
  if (clusters.length === 0) {
    return Object.freeze({ minimum: 0, maximum: 0, mean: 0, p50: 0, p95: 0 });
  }
  const values = clusters.map((cluster) => cluster.geometricError)
    .sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return Object.freeze({
    minimum: values[0]!,
    maximum: values[values.length - 1]!,
    mean: sum / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  });
}

function percentile(values: readonly number[], quantile: number): number {
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * quantile) - 1)
  );
  return values[index]!;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function nowMilliseconds(): number {
  return globalThis.performance?.now() ?? Date.now();
}
