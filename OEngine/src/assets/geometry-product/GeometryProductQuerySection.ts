import type { GeometryProductDescriptorV1 } from "./GeometryProductV1.js";
import {
  hierarchyNodeGroupIdV3,
  hierarchyNodeIsGroupV3,
  hierarchyNodeMeshletCountV3,
} from "../GeometryAbiV3.js";

export const GEOMETRY_QUERY_SECTION_VERSION = 2;
export const GEOMETRY_QUERY_HEADER_BYTES = 128;
export const GEOMETRY_QUERY_ASSET_BYTES = 32;
export const GEOMETRY_QUERY_CLUSTER_BYTES = 80;
export const GEOMETRY_QUERY_CLUSTER_LEAF = 1;
export const GEOMETRY_QUERY_CLUSTER_APPROXIMATE = 2;
export const GEOMETRY_QUERY_CLUSTER_COVERAGE_CRITICAL = 4;

export interface GeometryProductQuerySection {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly assetCount: number;
  readonly clusterCount: number;
  readonly assets: number;
  readonly clusters: number;
  readonly children: number;
  readonly roots: number;
  readonly minimumCut: number;
  readonly minimumPages: number;
}

const pageQueryIndices = new WeakMap<GeometryProductDescriptorV1, ReadonlyMap<number, number>>();

/** Product-local packed meshlet key -> query cluster word record. This cold
 * index belongs to immutable admission metadata, not a second scene/mesh. */
export function geometryProductQueryMeshletIndex(
  descriptor: GeometryProductDescriptorV1,
): ReadonlyMap<number, number> {
  const cached = pageQueryIndices.get(descriptor);
  if (cached !== undefined) {
    return cached;
  }
  const section = validateGeometryProductQuerySection(descriptor);
  const indices = new Map<number, number>();
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    const at = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
    const group = section.view.getUint32(at + 4, true);
    const meshlet = section.view.getUint32(at + 8, true);
    indices.set(group * 128 + meshlet, at);
  }
  pageQueryIndices.set(descriptor, indices);
  return indices;
}

/** Structural cook/admission validation. Shared payload headers and indices
 * remain the existing page validator's responsibility. No GPU resources or
 * mutable second geometry representation are created here. */
export function validateGeometryProductQuerySection(
  descriptor: GeometryProductDescriptorV1,
): GeometryProductQuerySection {
  const bytes = descriptor.querySection;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < GEOMETRY_QUERY_HEADER_BYTES) {
    throw new RangeError("Geometry Product query section is missing; recook source");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number): number => view.getUint32(at, true);
  if (
    u32(0) !== 0x3251474f ||
    u32(4) !== GEOMETRY_QUERY_SECTION_VERSION ||
    u32(8) !== GEOMETRY_QUERY_HEADER_BYTES ||
    u32(12) !== bytes.byteLength
  ) {
    throw new RangeError("Geometry Product query section version/length is unsupported; recook source");
  }
  if (
    !bytes.subarray(16, 48).every((value, index) => value === descriptor.recipeHash[index]) ||
    bytes.subarray(96, 128).some((value) => value !== 0)
  ) {
    throw new RangeError("Geometry Product query recipe/reserved bytes disagree");
  }
  const strides = [GEOMETRY_QUERY_ASSET_BYTES, GEOMETRY_QUERY_CLUSTER_BYTES, 4, 4, 4, 4];
  const counts: number[] = [];
  const offsets: number[] = [];
  let cursor = GEOMETRY_QUERY_HEADER_BYTES;
  for (let table = 0; table < strides.length; table++) {
    const count = u32(48 + table * 4);
    const offset = u32(72 + table * 4);
    if (offset !== cursor || count * strides[table]! > bytes.byteLength - cursor) {
      throw new RangeError("Geometry Product query table escapes canonical section");
    }
    counts.push(count);
    offsets.push(offset);
    cursor += count * strides[table]!;
  }
  if (cursor !== bytes.byteLength || counts[0] !== descriptor.assetRecords.byteLength / 128) {
    throw new RangeError("Geometry Product query asset count/section extent disagrees");
  }
  const section = Object.freeze({
    bytes,
    view,
    assetCount: counts[0]!,
    clusterCount: counts[1]!,
    assets: offsets[0]!,
    clusters: offsets[1]!,
    children: offsets[2]!,
    roots: offsets[3]!,
    minimumCut: offsets[4]!,
    minimumPages: offsets[5]!,
  });
  const assetView = new DataView(
    descriptor.assetRecords.buffer,
    descriptor.assetRecords.byteOffset,
    descriptor.assetRecords.byteLength,
  );
  const groups = new DataView(
    descriptor.groupDirectory.buffer,
    descriptor.groupDirectory.byteOffset,
    descriptor.groupDirectory.byteLength,
  );
  const groupCounts = new Uint16Array(descriptor.groupDirectory.byteLength / 16);
  const hierarchy = new DataView(
    descriptor.hierarchyNodes.buffer,
    descriptor.hierarchyNodes.byteOffset,
    descriptor.hierarchyNodes.byteLength,
  );
  for (let at = 44; at < hierarchy.byteLength; at += 48) {
    const packed = hierarchy.getUint32(at, true);
    if (hierarchyNodeIsGroupV3(packed)) {
      groupCounts[hierarchyNodeGroupIdV3(packed)] = hierarchyNodeMeshletCountV3(packed);
    }
  }
  const seenMeshlets = new Set<string>();
  const expectedLeaves: number[][] = Array.from({ length: section.assetCount }, () => []);
  const expectedRoots: number[][] = Array.from({ length: section.assetCount }, () => []);
  const clusterOwners = new Uint32Array(section.clusterCount);
  const clusterGroups = new Uint32Array(section.clusterCount);
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    const at = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
    const page = u32(at);
    const group = u32(at + 4);
    const meshlet = u32(at + 8);
    const triangles = u32(at + 12);
    const format = u32(at + 20);
    const flags = u32(at + 24);
    const asset = u32(at + 28);
    if (asset >= section.assetCount) {
      throw new RangeError("Geometry Product query cluster asset is invalid");
    }
    const groupBegin = assetView.getUint32(asset * 128 + 88, true);
    const groupCount = assetView.getUint32(asset * 128 + 92, true);
    if (
      group < groupBegin || group >= groupBegin + groupCount ||
      page !== groups.getUint32(group * 16, true) ||
      meshlet >= groupCounts[group]! || triangles === 0 || triangles > 128 ||
      format >= descriptor.vertexFormats.byteLength / 16 ||
      (flags !== 5 && flags !== 6) || u32(at + 76) !== 0
    ) {
      throw new RangeError("Geometry Product query cluster reference/flags are invalid");
    }
    const key = `${asset}:${group}:${meshlet}`;
    if (seenMeshlets.has(key)) {
      throw new RangeError("Geometry Product query meshlet reference is duplicated");
    }
    seenMeshlets.add(key);
    clusterOwners[cluster] = asset;
    clusterGroups[cluster] = group;
    for (let axis = 0; axis < 3; axis++) {
      const low = view.getFloat32(at + 32 + axis * 4, true);
      const high = view.getFloat32(at + 44 + axis * 4, true);
      if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        throw new RangeError("Geometry Product query cluster bounds are invalid");
      }
    }
    const error = view.getFloat32(at + 56, true);
    const childBegin = u32(at + 60);
    const childCount = u32(at + 64);
    const lod = u32(at + 68);
    if (
      !Number.isFinite(error) || error < 0 || lod > 254 || u32(at + 72) !== 0 ||
      childBegin + childCount > counts[2]! ||
      ((flags & GEOMETRY_QUERY_CLUSTER_LEAF) !== 0
        ? childCount !== 0 || error !== 0 || lod !== 0
        : childCount === 0 || lod === 0)
    ) {
      throw new RangeError("Geometry Product query cluster refinement/error is invalid");
    }
    if (flags & GEOMETRY_QUERY_CLUSTER_LEAF) {
      expectedLeaves[asset]!.push(cluster);
    }
  }
  let expectedMeshletCount = 0;
  for (let asset = 0; asset < section.assetCount; asset++) {
    const begin = assetView.getUint32(asset * 128 + 88, true);
    const count = assetView.getUint32(asset * 128 + 92, true);
    for (let group = begin; group < begin + count; group++) {
      expectedMeshletCount += groupCounts[group]!;
    }
  }
  if (expectedMeshletCount !== section.clusterCount) {
    throw new RangeError("Geometry Product query clusters do not cover every Product meshlet");
  }
  // Strictly descending LOD proves acyclicity without recursive JS traversal.
  const hasParent = new Uint8Array(section.clusterCount);
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    const at = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
    const begin = u32(at + 60);
    const count = u32(at + 64);
    const seen = new Set<number>();
    let refineGroup = 0xffffffff;
    for (let item = 0; item < count; item++) {
      const child = u32(section.children + (begin + item) * 4);
      if (
        child >= section.clusterCount || clusterOwners[child] !== clusterOwners[cluster] ||
        u32(section.clusters + child * GEOMETRY_QUERY_CLUSTER_BYTES + 68) >= u32(at + 68) ||
        seen.has(child)
      ) {
        throw new RangeError("Geometry Product query refinement cycle/duplicate/asset escape");
      }
      seen.add(child);
      hasParent[child] = 1;
      if (refineGroup === 0xffffffff) {
        refineGroup = clusterGroups[child]!;
      } else if (refineGroup !== clusterGroups[child]) {
        throw new RangeError("Geometry Product query children mix refinement groups");
      }
    }
    if (count > 0 && count !== groupCounts[refineGroup]) {
      throw new RangeError("Geometry Product query refinement omits child meshlets");
    }
  }
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    if (hasParent[cluster] === 0) {
      expectedRoots[clusterOwners[cluster]!]!.push(cluster);
    }
  }
  const tableCursors = [0, 0, 0];
  for (let asset = 0; asset < section.assetCount; asset++) {
    const at = section.assets + asset * GEOMETRY_QUERY_ASSET_BYTES;
    const pageSet = new Set<number>();
    for (const cluster of expectedLeaves[asset]!) {
      pageSet.add(u32(section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES));
    }
    const expected = [expectedRoots[asset]!, expectedLeaves[asset]!, [...pageSet].sort((a, b) => a - b)];
    const tableOffsets = [section.roots, section.minimumCut, section.minimumPages];
    for (let table = 0; table < 3; table++) {
      const begin = u32(at + table * 8);
      const count = u32(at + table * 8 + 4);
      if (
        begin !== tableCursors[table] || count === 0 ||
        begin + count > counts[3 + table]! || count !== expected[table]!.length ||
        expected[table]!.some((value, index) => u32(tableOffsets[table]! + (begin + index) * 4) !== value)
      ) {
        throw new RangeError("Geometry Product query minimum coverage cut/pages or roots are incomplete");
      }
      tableCursors[table] = begin + count;
    }
    if (u32(at + 24) !== 0 || u32(at + 28) !== 0) {
      throw new RangeError("Static query Product has unexpected topology/deformation revision");
    }
    const reachable = new Set<number>();
    const stack = [...expectedRoots[asset]!];
    while (stack.length > 0) {
      const cluster = stack.pop()!;
      if (reachable.has(cluster)) {
        continue;
      }
      reachable.add(cluster);
      const clusterAt = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
      const begin = u32(clusterAt + 60);
      const count = u32(clusterAt + 64);
      for (let child = 0; child < count; child++) {
        stack.push(u32(section.children + (begin + child) * 4));
      }
    }
    if (expectedLeaves[asset]!.some((cluster) => !reachable.has(cluster))) {
      throw new RangeError("Geometry Product query root forest does not cover its minimum cut");
    }
  }
  if (tableCursors.some((cursor, index) => cursor !== counts[3 + index])) {
    throw new RangeError("Geometry Product query tables contain unowned records");
  }
  return section;
}
