import type {
  GeometryAssetPackage,
  GeometryClusterRecord
} from "../assets/GeometryAssetPackage.js";
import { vec3 } from "gl-matrix";

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

export type GeometryHierarchyFrustumPlane = readonly [
  number,
  number,
  number,
  number
];

interface GeometryHierarchyViewBase {
  readonly cameraPosition: readonly [number, number, number];
  readonly viewportHeight: number;
  readonly frustumPlanes: readonly GeometryHierarchyFrustumPlane[];
}

export interface GeometryHierarchyPerspectiveView
  extends GeometryHierarchyViewBase {
  readonly kind: "perspective";
  readonly verticalFovRadians: number;
  readonly nearPlane: number;
}

export interface GeometryHierarchyOrthographicView
  extends GeometryHierarchyViewBase {
  readonly kind: "orthographic";
  readonly verticalWorldSize: number;
}

export type GeometryHierarchyView =
  | GeometryHierarchyPerspectiveView
  | GeometryHierarchyOrthographicView;

export interface GeometryHierarchyInstanceReference {
  readonly asset: GeometryAssetPackage;
  readonly instanceRecordIndex: number;
  readonly geometryRecordIndex: number;
  readonly clusterRecordBegin: number;
  readonly meshletRecordBegin: number;
  readonly materialHandle: number;
  /** Column-major affine object-to-world matrix. */
  readonly objectToWorld: ArrayLike<number>;
}

export interface GeometryHierarchyInstanceSelectionOptions {
  readonly view: GeometryHierarchyView;
  readonly sseThreshold: number;
  readonly rootQueueCapacity?: number;
  readonly traversalQueueCapacity?: number;
}

export interface GeometryHierarchySelectedCluster {
  readonly visibleClusterSlot: number;
  readonly instanceRecordIndex: number;
  readonly geometryRecordIndex: number;
  readonly clusterRecordIndex: number;
  readonly localClusterIndex: number;
  readonly materialHandle: number;
}

export interface GeometryHierarchySelectedMeshlet {
  readonly visibleClusterSlot: number;
  readonly meshletRecordIndex: number;
  readonly localMeshletIndex: number;
}

export interface GeometryHierarchyTraversalRoundEvidence {
  readonly roundIndex: number;
  readonly input: number;
  readonly written: number;
  readonly attempted: number;
  readonly peak: number;
  readonly overflow: number;
  readonly fallback: number;
}

export interface GeometryHierarchyQueueEvidence {
  readonly capacity: number;
  readonly written: number;
  readonly attempted: number;
  readonly peak: number;
  readonly overflow: number;
  readonly fallback: number;
}

export interface GeometryHierarchyInstanceSelection {
  readonly selectedClusters: readonly GeometryHierarchySelectedCluster[];
  readonly selectedMeshlets: readonly GeometryHierarchySelectedMeshlet[];
  readonly rootQueue: GeometryHierarchyQueueEvidence;
  readonly traversalRounds: readonly GeometryHierarchyTraversalRoundEvidence[];
  readonly candidateInstances: number;
  readonly visibleInstances: number;
  readonly rejectedInstancesFrustum: number;
  readonly visitedClusters: number;
  readonly rejectedClustersFrustum: number;
  readonly refinedClusters: number;
  readonly capacityFallbacks: number;
  readonly maxDepthReached: number;
}

interface PendingHierarchyWork {
  readonly instance: PreparedHierarchyInstance;
  readonly localClusterIndex: number;
  /** Package has no serialized hierarchy; residency supplies one virtual leaf. */
  readonly virtualLeaf: boolean;
}

interface PreparedHierarchyInstance {
  readonly source: GeometryHierarchyInstanceReference;
  readonly matrix: Float32Array;
  readonly conservativeScale: number;
}

/**
 * R3 multi-instance CPU oracle.
 *
 * This is a validation/tool path: it allocates selected records and never runs
 * in the steady render frame. Invalid/non-affine transforms and root queue
 * overflow are explicit errors; traversal pressure degrades to a renderable
 * parent without publishing a partial child group.
 */
export function selectGeometryHierarchyInstances(
  instances: readonly GeometryHierarchyInstanceReference[],
  options: GeometryHierarchyInstanceSelectionOptions
): GeometryHierarchyInstanceSelection {
  validateHierarchyView(options.view);
  if (!Number.isFinite(options.sseThreshold) || options.sseThreshold < 0) {
    throw new RangeError("sseThreshold must be a non-negative finite number");
  }
  assertU32(instances.length, "Hierarchy instance count");
  const rootQueueCapacity = options.rootQueueCapacity ?? instances.length;
  const traversalQueueCapacity = options.traversalQueueCapacity ?? 0xffffffff;
  assertU32(rootQueueCapacity, "RootTraversal capacity");
  assertU32(traversalQueueCapacity, "Traversal capacity");

  const roots: PendingHierarchyWork[] = [];
  let rejectedInstancesFrustum = 0;
  for (const source of instances) {
    const instance = prepareHierarchyInstance(source);
    const asset = source.asset;
    const virtualLeaf = asset.clusters.length === 0;
    const root = virtualLeaf ? 0 : asset.directory.clusterRoot;
    if (
      !virtualLeaf &&
      (!Number.isInteger(root) || root < 0 || root >= asset.clusters.length)
    ) {
      throw new RangeError(`Geometry Cluster root ${root} is out of bounds`);
    }
    const bounds = asset.directory.boundsSphere;
    if (bounds.length < 4) {
      throw new RangeError("Geometry boundsSphere must contain four values");
    }
    const sphere = transformSphere(
      Number(bounds[0]),
      Number(bounds[1]),
      Number(bounds[2]),
      Number(bounds[3]),
      instance
    );
    if (!sphereIntersectsFrustum(sphere, options.view.frustumPlanes)) {
      rejectedInstancesFrustum++;
      continue;
    }
    roots.push({ instance, localClusterIndex: root, virtualLeaf });
  }

  if (roots.length > rootQueueCapacity) {
    throw new RangeError(
      `RootTraversal capacity ${rootQueueCapacity} cannot contain ${roots.length} visible roots`
    );
  }

  const selectedClusters: GeometryHierarchySelectedCluster[] = [];
  const selectedMeshlets: GeometryHierarchySelectedMeshlet[] = [];
  const traversalRounds: GeometryHierarchyTraversalRoundEvidence[] = [];
  let current = roots;
  let visitedClusters = 0;
  let rejectedClustersFrustum = 0;
  let refinedClusters = 0;
  let capacityFallbacks = 0;
  let maxDepthReached = 0;
  let roundIndex = 0;

  const select = (work: PendingHierarchyWork): void => {
    const source = work.instance.source;
    const cluster = work.virtualLeaf
      ? undefined
      : source.asset.clusters[work.localClusterIndex]!;
    const visibleClusterSlot = selectedClusters.length;
    selectedClusters.push(Object.freeze({
      visibleClusterSlot,
      instanceRecordIndex: source.instanceRecordIndex,
      geometryRecordIndex: source.geometryRecordIndex,
      clusterRecordIndex: addU32(
        source.clusterRecordBegin,
        work.localClusterIndex,
        "Selected Cluster record index"
      ),
      localClusterIndex: work.localClusterIndex,
      materialHandle: source.materialHandle
    }));
    const meshletBegin = cluster?.meshletBegin ?? 0;
    const meshletCount = cluster?.meshletCount ?? source.asset.meshlets.length;
    const meshletEnd = meshletBegin + meshletCount;
    if (
      !Number.isSafeInteger(meshletEnd) ||
      meshletBegin < 0 ||
      meshletEnd > source.asset.meshlets.length
    ) {
      throw new RangeError(`Cluster ${work.localClusterIndex} Meshlet range is invalid`);
    }
    for (let localMeshletIndex = meshletBegin; localMeshletIndex < meshletEnd; localMeshletIndex++) {
      selectedMeshlets.push(Object.freeze({
        visibleClusterSlot,
        meshletRecordIndex: addU32(
          source.meshletRecordBegin,
          localMeshletIndex,
          "Selected Meshlet record index"
        ),
        localMeshletIndex
      }));
    }
  };

  const maximumPossibleRounds = instances.reduce(
    (sum, instance) => sum + Math.max(1, instance.asset.clusters.length),
    0
  ) + 1;
  while (current.length > 0) {
    if (roundIndex >= maximumPossibleRounds) {
      throw new Error("Hierarchy traversal exceeded the validated Cluster count");
    }
    const next: PendingHierarchyWork[] = [];
    let attempted = 0;
    let peak = 0;
    let overflow = 0;
    let fallback = 0;
    for (const work of current) {
      const source = work.instance.source;
      if (work.virtualLeaf) {
        visitedClusters++;
        select(work);
        continue;
      }
      const cluster = source.asset.clusters[work.localClusterIndex];
      if (cluster === undefined) {
        throw new RangeError(`Cluster ${work.localClusterIndex} is out of bounds`);
      }
      visitedClusters++;
      maxDepthReached = Math.max(maxDepthReached, cluster.depth);
      const sphere = transformSphere(
        cluster.bounds.centerX,
        cluster.bounds.centerY,
        cluster.bounds.centerZ,
        cluster.bounds.radius,
        work.instance
      );
      if (!sphereIntersectsFrustum(sphere, options.view.frustumPlanes)) {
        rejectedClustersFrustum++;
        continue;
      }
      const projectedError = projectedWorldGeometryErrorPixels(
        cluster.geometricError,
        sphere,
        work.instance.conservativeScale,
        options.view
      );
      if (cluster.childCount === 0 || projectedError <= options.sseThreshold) {
        select(work);
        continue;
      }

      attempted = saturatingU32Add(attempted, cluster.childCount);
      if (cluster.childCount > traversalQueueCapacity - next.length) {
        overflow = 1;
        fallback = saturatingU32Add(fallback, 1);
        capacityFallbacks++;
        select(work);
        continue;
      }
      validateChildren(source.asset, work.localClusterIndex, cluster);
      for (let child = 0; child < cluster.childCount; child++) {
        next.push({
          instance: work.instance,
          localClusterIndex: source.asset.clusterChildren[cluster.childBegin + child]!,
          virtualLeaf: false
        });
      }
      refinedClusters++;
      peak = Math.max(peak, next.length);
    }
    traversalRounds.push(Object.freeze({
      roundIndex,
      input: current.length,
      written: next.length,
      attempted,
      peak,
      overflow,
      fallback
    }));
    current = next;
    roundIndex++;
  }

  return Object.freeze({
    selectedClusters: Object.freeze(selectedClusters),
    selectedMeshlets: Object.freeze(selectedMeshlets),
    rootQueue: Object.freeze({
      capacity: rootQueueCapacity,
      written: roots.length,
      attempted: roots.length,
      peak: roots.length,
      overflow: 0,
      fallback: 0
    }),
    traversalRounds: Object.freeze(traversalRounds),
    candidateInstances: instances.length,
    visibleInstances: roots.length,
    rejectedInstancesFrustum,
    visitedClusters,
    rejectedClustersFrustum,
    refinedClusters,
    capacityFallbacks,
    maxDepthReached
  });
}

/** Maximum Meshlet count of any legal parent/children-exclusive hierarchy cut. */
export function computeGeometryMaxCutMeshlets(
  asset: GeometryAssetPackage
): number {
  if (asset.clusters.length === 0) {
    assertU32(asset.meshlets.length, "Geometry Meshlet count");
    return asset.meshlets.length;
  }
  return analyzeGeometryHierarchy(asset).maxCutMeshlets;
}

export function computePackedMaxCutMeshlets(
  instances: readonly Pick<GeometryHierarchyInstanceReference, "asset">[]
): number {
  let total = 0;
  for (const instance of instances) {
    total = addU32(
      total,
      computeGeometryMaxCutMeshlets(instance.asset),
      "Packed max-cut Meshlet count"
    );
  }
  return total;
}

export interface GeometryHierarchyWorkCapacity {
  readonly rootTraversalCapacity: number;
  readonly traversalWorkCapacity: number;
  readonly visibleClusterCapacity: number;
  readonly rasterWorkCapacity: number;
  /** Zero-based deepest reachable Cluster depth. */
  readonly maxHierarchyDepth: number;
}

/**
 * Exact safe capacities for one or more complete hierarchy instances.
 *
 * Traversal capacity is the largest combined breadth at any depth. Selected
 * Cluster and RasterWork capacities are the largest legal parent/children-
 * exclusive cuts. This is preparation/tool work and is never run per frame.
 */
export function computePackedHierarchyWorkCapacity(
  instances: readonly Pick<GeometryHierarchyInstanceReference, "asset">[]
): GeometryHierarchyWorkCapacity {
  assertU32(instances.length, "Hierarchy instance count");
  const cached = new Map<GeometryAssetPackage, GeometryHierarchyAnalysis>();
  const combinedDepthWidths: number[] = [];
  let visibleClusterCapacity = 0;
  let rasterWorkCapacity = 0;
  let maxHierarchyDepth = 0;
  for (const instance of instances) {
    let analysis = cached.get(instance.asset);
    if (analysis === undefined) {
      analysis = analyzeGeometryHierarchy(instance.asset);
      cached.set(instance.asset, analysis);
    }
    visibleClusterCapacity = addU32(
      visibleClusterCapacity,
      analysis.maxCutClusters,
      "Packed VisibleCluster capacity"
    );
    rasterWorkCapacity = addU32(
      rasterWorkCapacity,
      analysis.maxCutMeshlets,
      "Packed RasterWork capacity"
    );
    maxHierarchyDepth = Math.max(maxHierarchyDepth, analysis.maxDepth);
    for (let depth = 0; depth < analysis.depthWidths.length; depth++) {
      combinedDepthWidths[depth] = addU32(
        combinedDepthWidths[depth] ?? 0,
        analysis.depthWidths[depth]!,
        `Packed traversal depth ${depth} capacity`
      );
    }
  }
  const traversalWorkCapacity = combinedDepthWidths.reduce(
    (maximum, width) => Math.max(maximum, width),
    0
  );
  return Object.freeze({
    rootTraversalCapacity: instances.length,
    traversalWorkCapacity,
    visibleClusterCapacity,
    rasterWorkCapacity,
    maxHierarchyDepth
  });
}

/**
 * Bulk equivalent of `computePackedHierarchyWorkCapacity()` for Packed Scene
 * dictionaries. It aggregates identical Geometry packages before applying
 * their hierarchy bounds, so preparation remains O(instance count) without
 * allocating one JavaScript wrapper object per Instance.
 */
export function computeIndexedPackedHierarchyWorkCapacity(
  geometries: readonly GeometryAssetPackage[],
  geometryIndices: Uint32Array
): GeometryHierarchyWorkCapacity {
  if (geometries.length === 0) {
    throw new RangeError("Packed hierarchy requires at least one Geometry");
  }
  assertU32(geometryIndices.length, "Hierarchy instance count");
  if (geometryIndices.length === 0) {
    throw new RangeError("Packed hierarchy requires at least one Instance");
  }
  const instanceCounts = new Uint32Array(geometries.length);
  for (let index = 0; index < geometryIndices.length; index++) {
    const geometryIndex = geometryIndices[index]!;
    if (geometryIndex >= geometries.length) {
      throw new RangeError(
        `geometryIndices[${index}] ${geometryIndex} is outside the Geometry dictionary`
      );
    }
    const next = instanceCounts[geometryIndex]! + 1;
    assertU32(next, `Geometry ${geometryIndex} Instance count`);
    instanceCounts[geometryIndex] = next;
  }

  const combinedDepthWidths: number[] = [];
  let visibleClusterCapacity = 0;
  let rasterWorkCapacity = 0;
  let maxHierarchyDepth = 0;
  for (let geometryIndex = 0; geometryIndex < geometries.length; geometryIndex++) {
    const instanceCount = instanceCounts[geometryIndex]!;
    if (instanceCount === 0) continue;
    const analysis = analyzeGeometryHierarchy(geometries[geometryIndex]!);
    visibleClusterCapacity = addU32(
      visibleClusterCapacity,
      multiplyU32(
        analysis.maxCutClusters,
        instanceCount,
        `Geometry ${geometryIndex} VisibleCluster capacity`
      ),
      "Packed VisibleCluster capacity"
    );
    rasterWorkCapacity = addU32(
      rasterWorkCapacity,
      multiplyU32(
        analysis.maxCutMeshlets,
        instanceCount,
        `Geometry ${geometryIndex} RasterWork capacity`
      ),
      "Packed RasterWork capacity"
    );
    maxHierarchyDepth = Math.max(maxHierarchyDepth, analysis.maxDepth);
    for (let depth = 0; depth < analysis.depthWidths.length; depth++) {
      combinedDepthWidths[depth] = addU32(
        combinedDepthWidths[depth] ?? 0,
        multiplyU32(
          analysis.depthWidths[depth]!,
          instanceCount,
          `Geometry ${geometryIndex} traversal depth ${depth} capacity`
        ),
        `Packed traversal depth ${depth} capacity`
      );
    }
  }
  return Object.freeze({
    rootTraversalCapacity: geometryIndices.length,
    traversalWorkCapacity: combinedDepthWidths.reduce(
      (maximum, width) => Math.max(maximum, width),
      0
    ),
    visibleClusterCapacity,
    rasterWorkCapacity,
    maxHierarchyDepth
  });
}

interface GeometryHierarchyAnalysis {
  readonly maxCutClusters: number;
  readonly maxCutMeshlets: number;
  readonly maxDepth: number;
  readonly depthWidths: readonly number[];
}

function analyzeGeometryHierarchy(
  asset: GeometryAssetPackage
): GeometryHierarchyAnalysis {
  if (asset.clusters.length === 0) {
    assertU32(asset.meshlets.length, "Geometry Meshlet count");
    return Object.freeze({
      maxCutClusters: 1,
      maxCutMeshlets: asset.meshlets.length,
      maxDepth: 0,
      depthWidths: Object.freeze([1])
    });
  }
  const root = asset.directory.clusterRoot;
  if (!Number.isInteger(root) || root < 0 || root >= asset.clusters.length) {
    throw new RangeError(`Geometry Cluster root ${root} is out of bounds`);
  }
  const state = new Uint8Array(asset.clusters.length);
  const depthWidths: number[] = [];
  let maxDepth = 0;
  const visit = (
    clusterIndex: number,
    expectedDepth: number
  ): Readonly<{ clusters: number; meshlets: number }> => {
    if (state[clusterIndex] === 1) {
      throw new Error(`Geometry hierarchy contains a cycle at Cluster ${clusterIndex}`);
    }
    if (state[clusterIndex] === 2) {
      throw new Error(`Geometry hierarchy shares Cluster ${clusterIndex} between parents`);
    }
    const cluster = asset.clusters[clusterIndex];
    if (cluster === undefined) {
      throw new RangeError(`Cluster ${clusterIndex} is out of bounds`);
    }
    if (cluster.depth !== expectedDepth) {
      throw new Error(
        `Cluster ${clusterIndex} depth ${cluster.depth} does not match ${expectedDepth}`
      );
    }
    state[clusterIndex] = 1;
    depthWidths[expectedDepth] = addU32(
      depthWidths[expectedDepth] ?? 0,
      1,
      `Geometry traversal depth ${expectedDepth} width`
    );
    maxDepth = Math.max(maxDepth, expectedDepth);
    assertU32(cluster.meshletCount, `Cluster ${clusterIndex} Meshlet count`);
    validateChildren(asset, clusterIndex, cluster);
    let childCutClusters = 0;
    let childCutMeshlets = 0;
    for (let child = 0; child < cluster.childCount; child++) {
      const childIndex = asset.clusterChildren[cluster.childBegin + child]!;
      const childCut = visit(childIndex, expectedDepth + 1);
      childCutClusters = addU32(
        childCutClusters,
        childCut.clusters,
        `Cluster ${clusterIndex} child cut Cluster count`
      );
      childCutMeshlets = addU32(
        childCutMeshlets,
        childCut.meshlets,
        `Cluster ${clusterIndex} child cut Meshlet count`
      );
    }
    state[clusterIndex] = 2;
    return {
      clusters: Math.max(1, childCutClusters),
      meshlets: Math.max(cluster.meshletCount, childCutMeshlets)
    };
  };
  const cut = visit(root, 0);
  if (state.some((value) => value === 0)) {
    throw new Error("Geometry hierarchy contains an unreachable Cluster");
  }
  return Object.freeze({
    maxCutClusters: cut.clusters,
    maxCutMeshlets: cut.meshlets,
    maxDepth,
    depthWidths: Object.freeze(depthWidths)
  });
}

function multiplyU32(left: number, right: number, label: string): number {
  assertU32(left, label);
  assertU32(right, label);
  const result = left * right;
  assertU32(result, label);
  return result;
}

interface WorldSphere {
  readonly center: vec3;
  readonly radius: number;
}

function prepareHierarchyInstance(
  source: GeometryHierarchyInstanceReference
): PreparedHierarchyInstance {
  assertU32(source.instanceRecordIndex, "Instance record index");
  assertU32(source.geometryRecordIndex, "Geometry record index");
  assertU32(source.clusterRecordBegin, "Cluster record begin");
  assertU32(source.meshletRecordBegin, "Meshlet record begin");
  assertU32(source.materialHandle, "Material handle");
  if (source.objectToWorld.length < 16) {
    throw new RangeError("objectToWorld must contain 16 values");
  }
  const matrix = new Float32Array(16);
  for (let index = 0; index < 16; index++) {
    const value = Number(source.objectToWorld[index]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`objectToWorld[${index}] must be finite`);
    }
    matrix[index] = value;
  }
  if (
    Math.abs(matrix[3]!) > 1e-6 ||
    Math.abs(matrix[7]!) > 1e-6 ||
    Math.abs(matrix[11]!) > 1e-6 ||
    Math.abs(matrix[15]! - 1) > 1e-6
  ) {
    throw new RangeError("objectToWorld must be an affine matrix");
  }
  const xLength = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
  const yLength = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
  const zLength = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  if (Math.min(xLength, yLength, zLength) <= 1e-12) {
    throw new RangeError("objectToWorld must have three non-zero axes");
  }
  const determinant =
    matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) -
    matrix[4]! * (matrix[1]! * matrix[10]! - matrix[2]! * matrix[9]!) +
    matrix[8]! * (matrix[1]! * matrix[6]! - matrix[2]! * matrix[5]!);
  const normalizedDeterminant = determinant / (xLength * yLength * zLength);
  if (Math.abs(normalizedDeterminant) <= 1e-8) {
    throw new RangeError("objectToWorld linear transform must be non-singular");
  }
  const xy = normalizedAxisDot(matrix, 0, 4, xLength, yLength);
  const xz = normalizedAxisDot(matrix, 0, 8, xLength, zLength);
  const yz = normalizedAxisDot(matrix, 4, 8, yLength, zLength);
  const conservativeScale = Math.max(Math.abs(xy), Math.abs(xz), Math.abs(yz)) <= 1e-5
    ? Math.max(xLength, yLength, zLength)
    : Math.hypot(
      matrix[0]!, matrix[1]!, matrix[2]!,
      matrix[4]!, matrix[5]!, matrix[6]!,
      matrix[8]!, matrix[9]!, matrix[10]!
    );
  return { source, matrix, conservativeScale };
}

function normalizedAxisDot(
  matrix: Float32Array,
  left: number,
  right: number,
  leftLength: number,
  rightLength: number
): number {
  return (
    matrix[left]! * matrix[right]! +
    matrix[left + 1]! * matrix[right + 1]! +
    matrix[left + 2]! * matrix[right + 2]!
  ) / (leftLength * rightLength);
}

function transformSphere(
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  instance: PreparedHierarchyInstance
): WorldSphere {
  if (![centerX, centerY, centerZ, radius].every(Number.isFinite) || radius < 0) {
    throw new RangeError("Hierarchy bounds sphere must be finite with a non-negative radius");
  }
  const localCenter = vec3.fromValues(centerX, centerY, centerZ);
  const worldCenter = vec3.create();
  vec3.transformMat4(worldCenter, localCenter, instance.matrix);
  return {
    center: worldCenter,
    radius: radius * instance.conservativeScale
  };
}

function sphereIntersectsFrustum(
  sphere: WorldSphere,
  planes: readonly GeometryHierarchyFrustumPlane[]
): boolean {
  // Algorithm provenance: Niagara eefec2794681a1f8416e1fcc2771c1cdc11a86cb,
  // src/shaders/drawcull.comp.glsl:73-82. OEngine accepts non-normalized
  // world-space planes by scaling the radius with each plane normal length.
  for (const plane of planes) {
    const normalLength = Math.hypot(plane[0], plane[1], plane[2]);
    const distance =
      plane[0] * sphere.center[0]! +
      plane[1] * sphere.center[1]! +
      plane[2] * sphere.center[2]! +
      plane[3];
    if (distance < -sphere.radius * normalLength) return false;
  }
  return true;
}

function projectedWorldGeometryErrorPixels(
  objectError: number,
  sphere: WorldSphere,
  conservativeScale: number,
  view: GeometryHierarchyView
): number {
  // Algorithm provenance: docs/references/porting/R3-01-hierarchical-work-generation.md
  // Bevy meshlet_cull_shared.wgsl:14-36 supplies the scale/nearest-distance and
  // perspective/orthographic structure. OEngine keeps worldError scaled in
  // both branches and uses its explicit viewport-height convention.
  if (!Number.isFinite(objectError) || objectError < 0) {
    throw new RangeError("Cluster geometricError must be non-negative and finite");
  }
  const worldError = objectError * conservativeScale;
  if (view.kind === "orthographic") {
    return worldError / view.verticalWorldSize * view.viewportHeight;
  }
  const dx = sphere.center[0]! - view.cameraPosition[0];
  const dy = sphere.center[1]! - view.cameraPosition[1];
  const dz = sphere.center[2]! - view.cameraPosition[2];
  const nearestDistance = Math.max(
    Math.hypot(dx, dy, dz) - sphere.radius,
    view.nearPlane
  );
  const projectionScaleY = 1 / Math.tan(view.verticalFovRadians * 0.5);
  return worldError / nearestDistance * projectionScaleY * 0.5 * view.viewportHeight;
}

function validateHierarchyView(view: GeometryHierarchyView): void {
  if (
    view.cameraPosition.length !== 3 ||
    !view.cameraPosition.every(Number.isFinite)
  ) {
    throw new RangeError("cameraPosition must contain three finite values");
  }
  if (!Number.isFinite(view.viewportHeight) || view.viewportHeight <= 0) {
    throw new RangeError("viewportHeight must be positive and finite");
  }
  if (view.frustumPlanes.length === 0) {
    throw new RangeError("frustumPlanes must not be empty");
  }
  for (let index = 0; index < view.frustumPlanes.length; index++) {
    const plane = view.frustumPlanes[index]!;
    if (plane.length !== 4 || !plane.every(Number.isFinite)) {
      throw new RangeError(`frustumPlanes[${index}] must contain four finite values`);
    }
    if (
      Math.hypot(plane[0], plane[1], plane[2]) === 0 &&
      plane[3] < 0
    ) {
      throw new RangeError(
        `frustumPlanes[${index}] disabled plane must have non-negative W`
      );
    }
  }
  if (view.kind === "perspective") {
    if (
      !Number.isFinite(view.verticalFovRadians) ||
      view.verticalFovRadians <= 0 ||
      view.verticalFovRadians >= Math.PI
    ) {
      throw new RangeError("verticalFovRadians must be in (0, PI)");
    }
    if (!Number.isFinite(view.nearPlane) || view.nearPlane <= 0) {
      throw new RangeError("nearPlane must be positive and finite");
    }
  } else if (!Number.isFinite(view.verticalWorldSize) || view.verticalWorldSize <= 0) {
    throw new RangeError("verticalWorldSize must be positive and finite");
  }
}

function validateChildren(
  asset: GeometryAssetPackage,
  clusterIndex: number,
  cluster: GeometryClusterRecord
): void {
  assertU32(cluster.childBegin, `Cluster ${clusterIndex} childBegin`);
  assertU32(cluster.childCount, `Cluster ${clusterIndex} childCount`);
  const end = cluster.childBegin + cluster.childCount;
  if (!Number.isSafeInteger(end) || end > asset.clusterChildren.length) {
    throw new RangeError(`Cluster ${clusterIndex} child range is invalid`);
  }
  for (let offset = cluster.childBegin; offset < end; offset++) {
    const child = asset.clusterChildren[offset]!;
    if (child >= asset.clusters.length) {
      throw new RangeError(`Cluster ${clusterIndex} child ${child} is out of bounds`);
    }
  }
}

function saturatingU32Add(left: number, right: number): number {
  return Math.min(0xffffffff, left + right);
}

function addU32(left: number, right: number, label: string): number {
  assertU32(left, label);
  assertU32(right, label);
  const result = left + right;
  assertU32(result, label);
  return result;
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside u32`);
  }
}
