import {
  hierarchyNodeChildCountV3,
  hierarchyNodeChildStartV3,
  hierarchyNodeGroupIdV3,
  hierarchyNodeIsGroupV3,
  hierarchyNodeMeshletCountV3,
  OEGPACK_V3_ASSET_STRIDE,
  OEGPACK_V3_GROUP_DIRECTORY_STRIDE,
  OEGPACK_V3_HIERARCHY_STRIDE,
} from "../GeometryAbiV3.js";
import { assertGeometryProductDescriptorV1, type GeometryProductDescriptorV1 } from "./GeometryProductV1.js";
import { GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY } from "../../gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_TRAVERSAL_WORK_SCHEMA,
  GPU_VISIBLE_CLUSTER_RECORD_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA,
} from "../../gpu/GpuWorkGenerationAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
} from "../../gpu/GpuMeshletRasterWorkAbi.js";

export interface GeometryProductAssetWorkload {
  readonly maxDepth: number;
  readonly maxFrontier: number;
  readonly visibleGroups: number;
  readonly meshlets: number;
}

export interface GeometryProductWorkload {
  readonly assets: readonly GeometryProductAssetWorkload[];
  readonly groupMeshletCounts: Uint16Array;
}

export interface GeometryProductSceneWorkload {
  readonly hierarchyMaxDepth: number;
  readonly hierarchyTraversalCapacity: number;
  readonly hierarchyVisibleClusterCapacity: number;
  readonly hierarchyRasterWorkCapacity: number;
}

// Product descriptors are immutable publications. This analysis is performed
// once per descriptor, not per frame or per streamed page.
const workloads = new WeakMap<GeometryProductDescriptorV1, GeometryProductWorkload>();

/** Bound all legal SSE/residency cuts, not just the current camera's cut.
 * Spatial leaves describe every refinement group; they are not renderable
 * ancestors. A wavefront queue needs the widest level of this root forest,
 * while the selected queue may accumulate all leaves across levels. */
export function geometryProductWorkload(descriptor: GeometryProductDescriptorV1): GeometryProductWorkload {
  const cached = workloads.get(descriptor);
  if (cached !== undefined) {
    return cached;
  }
  assertGeometryProductDescriptorV1(descriptor);
  const assetView = new DataView(
    descriptor.assetRecords.buffer,
    descriptor.assetRecords.byteOffset,
    descriptor.assetRecords.byteLength,
  );
  const nodeView = new DataView(
    descriptor.hierarchyNodes.buffer,
    descriptor.hierarchyNodes.byteOffset,
    descriptor.hierarchyNodes.byteLength,
  );
  const groupMeshletCounts = new Uint16Array(
    descriptor.groupDirectory.byteLength / OEGPACK_V3_GROUP_DIRECTORY_STRIDE,
  );
  const assets: GeometryProductAssetWorkload[] = [];
  for (let asset = 0; asset < descriptor.assetRecords.byteLength / OEGPACK_V3_ASSET_STRIDE; asset++) {
    const rootBegin = assetView.getUint32(asset * OEGPACK_V3_ASSET_STRIDE + 72, true);
    const rootCount = assetView.getUint32(asset * OEGPACK_V3_ASSET_STRIDE + 76, true);
    const nodes: number[] = [];
    const depths: number[] = [];
    const widths: number[] = [];
    const groups = new Set<number>();
    for (let root = 0; root < rootCount; root++) {
      nodes.push(descriptor.rootNodeIds[rootBegin + root]!);
      depths.push(0);
    }
    let maxDepth = 0;
    let meshlets = 0;
    while (nodes.length > 0) {
      const node = nodes.pop()!;
      const depth = depths.pop()!;
      widths[depth] = (widths[depth] ?? 0) + 1;
      maxDepth = Math.max(maxDepth, depth);
      const packed = nodeView.getUint32(node * OEGPACK_V3_HIERARCHY_STRIDE + 44, true);
      if (hierarchyNodeIsGroupV3(packed)) {
        const group = hierarchyNodeGroupIdV3(packed);
        if (groups.has(group)) {
          throw new RangeError("Product hierarchy selects a group more than once");
        }
        groups.add(group);
        const count = hierarchyNodeMeshletCountV3(packed);
        if (groupMeshletCounts[group] !== 0 && groupMeshletCounts[group] !== count) {
          throw new RangeError("Product hierarchy group meshlet counts disagree");
        }
        groupMeshletCounts[group] = count;
        meshlets = checkedGeometryWorkCount(meshlets + count, "Product asset meshlets");
      } else {
        const begin = hierarchyNodeChildStartV3(packed);
        const count = hierarchyNodeChildCountV3(packed);
        for (let child = 0; child < count; child++) {
          nodes.push(begin + child);
          depths.push(depth + 1);
        }
      }
    }
    let maxFrontier = 0;
    for (const width of widths) {
      maxFrontier = Math.max(maxFrontier, width);
    }
    assets.push(Object.freeze({ maxDepth, maxFrontier, visibleGroups: groups.size, meshlets }));
  }
  const result = Object.freeze({ assets: Object.freeze(assets), groupMeshletCounts });
  workloads.set(descriptor, result);
  return result;
}

/** Instance multiplicity is part of capacity; uninstantiated assets cost no
 * frame work. Summed per-asset frontier maxima are conservative when the
 * assets reach their widest levels at different depths. */
export function geometryProductSceneWorkload(
  descriptor: GeometryProductDescriptorV1,
  instances: readonly { readonly assetIndex: number }[],
): GeometryProductSceneWorkload {
  const product = geometryProductWorkload(descriptor);
  let hierarchyMaxDepth = 0;
  let traversal = 0;
  let visible = 0;
  let raster = 0;
  for (const instance of instances) {
    const asset = product.assets[instance.assetIndex];
    if (asset === undefined) {
      throw new RangeError("Product instance is outside the asset dictionary");
    }
    hierarchyMaxDepth = Math.max(hierarchyMaxDepth, asset.maxDepth);
    traversal = checkedGeometryWorkCount(traversal + asset.maxFrontier, "Product traversal capacity");
    visible = checkedGeometryWorkCount(visible + asset.visibleGroups, "Product visible capacity");
    raster = checkedGeometryWorkCount(raster + asset.meshlets, "Product MeshletWork capacity");
  }
  if (raster > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY) {
    throw new RangeError("Product MeshletWork exceeds the r32 VisibilityKey namespace");
  }
  return Object.freeze({
    hierarchyMaxDepth,
    hierarchyTraversalCapacity: Math.max(1, traversal),
    hierarchyVisibleClusterCapacity: Math.max(1, visible),
    hierarchyRasterWorkCapacity: Math.max(1, raster),
  });
}

export function checkedGeometryWorkCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} exceeds the u32 work namespace`);
  }
  return value;
}

/** Current production expansion is one workgroup per visible group. Reject
 * unsupported grids before Scene allocation; G2.3 will extend this physical
 * execution limit, not silently clamp the logical scene. */
export function validateGeometryProductSceneWorkLimits(
  work: GeometryProductSceneWorkload,
  instanceCount: number,
  limits: Pick<
    GPUSupportedLimits,
    "maxBufferSize" | "maxStorageBufferBindingSize" | "maxComputeWorkgroupsPerDimension"
  >,
): void {
  const maximum = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  for (const [name, capacity, stride, header] of [
    [
      "traversal",
      work.hierarchyTraversalCapacity,
      GPU_TRAVERSAL_WORK_SCHEMA.stride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
    ],
    [
      "VisibleCluster",
      work.hierarchyVisibleClusterCapacity,
      GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride,
      GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
    ],
    [
      "MeshletWork",
      work.hierarchyRasterWorkCapacity,
      GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
      GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
    ],
  ] as const) {
    if (header + capacity * stride > maximum) {
      throw new RangeError(`Product ${name} capacity exceeds negotiated storage-buffer limits`);
    }
  }
  if (work.hierarchyRasterWorkCapacity > GPU_VISIBILITY_KEY_MAX_MESHLET_WORK_CAPACITY) {
    throw new RangeError("Product MeshletWork exceeds the r32 VisibilityKey namespace");
  }
  const dimension = limits.maxComputeWorkgroupsPerDimension;
  if (
    work.hierarchyVisibleClusterCapacity > dimension ||
    Math.ceil(Math.max(instanceCount, work.hierarchyTraversalCapacity) / 64) > dimension * dimension
  ) {
    throw new RangeError("Product geometry work exceeds the current negotiated dispatch grid");
  }
}
