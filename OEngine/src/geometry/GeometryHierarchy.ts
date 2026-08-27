import type {
  GeometryAssetPackage,
  GeometryClusterRecord
} from "../assets/GeometryAssetPackage.js";

export interface GeometryHierarchyProjection {
  readonly cameraPosition: readonly [number, number, number];
  readonly verticalFovRadians: number;
  readonly viewportHeight: number;
  readonly maxAxisScale: number;
}

export interface GeometryHierarchySelectionOptions
  extends GeometryHierarchyProjection {
  readonly sseThreshold: number;
  readonly maxVisitedClusters?: number;
}

export interface GeometryHierarchySelection {
  readonly selectedClusterIndices: readonly number[];
  readonly selectedMeshletIndices: readonly number[];
  readonly visitedClusters: number;
  readonly refinedClusters: number;
  readonly capacityFallbacks: number;
  readonly maxDepthReached: number;
}

/**
 * CPU oracle for the R3 GPU traversal. It performs no allocation proportional
 * to source triangles and never reads back GPU state.
 */
export function selectGeometryHierarchy(
  asset: GeometryAssetPackage,
  options: GeometryHierarchySelectionOptions
): GeometryHierarchySelection {
  validateProjection(options);
  if (!Number.isFinite(options.sseThreshold) || options.sseThreshold < 0) {
    throw new RangeError("sseThreshold must be a non-negative finite number");
  }
  const maxVisited = options.maxVisitedClusters ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(maxVisited) || maxVisited < 1) {
    throw new RangeError("maxVisitedClusters must be a positive integer");
  }
  if (asset.clusters.length === 0) {
    return Object.freeze({
      selectedClusterIndices: Object.freeze([]),
      selectedMeshletIndices: Object.freeze(
        asset.meshlets.map((_, index) => index)
      ),
      visitedClusters: 0,
      refinedClusters: 0,
      capacityFallbacks: 0,
      maxDepthReached: 0
    });
  }

  const selectedClusters: number[] = [];
  const selectedMeshlets: number[] = [];
  let visitedClusters = 0;
  let refinedClusters = 0;
  let capacityFallbacks = 0;
  let maxDepthReached = 0;
  const select = (index: number): void => {
    const cluster = asset.clusters[index]!;
    selectedClusters.push(index);
    for (
      let meshlet = cluster.meshletBegin;
      meshlet < cluster.meshletBegin + cluster.meshletCount;
      meshlet++
    ) {
      selectedMeshlets.push(meshlet);
    }
  };
  const visit = (index: number, reservedAfter: number): void => {
    const cluster = asset.clusters[index]!;
    visitedClusters++;
    maxDepthReached = Math.max(maxDepthReached, cluster.depth);
    const shouldRefine =
      cluster.childCount > 0 &&
      projectedGeometryErrorPixels(cluster, options) > options.sseThreshold;
    if (!shouldRefine) {
      select(index);
      return;
    }
    if (visitedClusters + cluster.childCount + reservedAfter > maxVisited) {
      capacityFallbacks++;
      select(index);
      return;
    }
    refinedClusters++;
    for (let child = 0; child < cluster.childCount; child++) {
      const offset = cluster.childBegin + child;
      const remainingSiblings = cluster.childCount - child - 1;
      visit(asset.clusterChildren[offset]!, reservedAfter + remainingSiblings);
    }
  };
  visit(asset.directory.clusterRoot, 0);
  return Object.freeze({
    selectedClusterIndices: Object.freeze(selectedClusters),
    selectedMeshletIndices: Object.freeze(selectedMeshlets),
    visitedClusters,
    refinedClusters,
    capacityFallbacks,
    maxDepthReached
  });
}

export function projectedGeometryErrorPixels(
  cluster: GeometryClusterRecord,
  projection: GeometryHierarchyProjection
): number {
  validateProjection(projection);
  const dx = cluster.bounds.centerX - projection.cameraPosition[0];
  const dy = cluster.bounds.centerY - projection.cameraPosition[1];
  const dz = cluster.bounds.centerZ - projection.cameraPosition[2];
  const nearestDistance = Math.max(
    Math.hypot(dx, dy, dz) - cluster.bounds.radius * projection.maxAxisScale,
    1e-6
  );
  const focalLengthPixels = projection.viewportHeight /
    (2 * Math.tan(projection.verticalFovRadians * 0.5));
  return cluster.geometricError * projection.maxAxisScale *
    focalLengthPixels / nearestDistance;
}

function validateProjection(projection: GeometryHierarchyProjection): void {
  if (
    projection.cameraPosition.length !== 3 ||
    !projection.cameraPosition.every(Number.isFinite)
  ) {
    throw new RangeError("cameraPosition must contain three finite values");
  }
  if (
    !Number.isFinite(projection.verticalFovRadians) ||
    projection.verticalFovRadians <= 0 ||
    projection.verticalFovRadians >= Math.PI
  ) {
    throw new RangeError("verticalFovRadians must be in (0, PI)");
  }
  if (!Number.isFinite(projection.viewportHeight) || projection.viewportHeight <= 0) {
    throw new RangeError("viewportHeight must be positive and finite");
  }
  if (!Number.isFinite(projection.maxAxisScale) || projection.maxAxisScale <= 0) {
    throw new RangeError("maxAxisScale must be positive and finite");
  }
}
