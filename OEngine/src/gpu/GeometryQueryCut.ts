import type { GeometryProductDescriptorV1 } from "../assets/geometry-product/GeometryProductV1.js";
import {
  GEOMETRY_QUERY_CLUSTER_BYTES,
  GEOMETRY_QUERY_CLUSTER_COVERAGE_CRITICAL,
  GEOMETRY_QUERY_CLUSTER_LEAF,
  validateGeometryProductQuerySection,
} from "../assets/geometry-product/GeometryProductQuerySection.js";
import type { GeometryQueryDomain } from "./GeometryQueryDomain.js";
import { geometryQueryDomain } from "./GeometryQueryDomain.js";

/** An object-space envelope of every relevant instance of one asset. The GPU
 * produces these envelopes; a delayed publication may use a wider envelope.
 * Empty means no relevant instance, null means the entire asset. */
export interface GeometryQueryAssetDemand {
  readonly domain: GeometryQueryDomain | null;
  readonly active: boolean;
  readonly maximumError: number;
}

/** Immutable cold-publication plan. Physical page addresses are acquired only
 * after the existing streaming owner has published the complete selected cut. */
export interface GeometryQueryCut {
  readonly descriptor: GeometryProductDescriptorV1;
  readonly assets: readonly GeometryQueryAssetDemand[];
  readonly clusters: readonly number[];
  readonly pages: readonly number[];
  readonly primitiveCount: number;
}

export function geometryQueryCut(
  descriptor: GeometryProductDescriptorV1,
  demands?: readonly GeometryQueryAssetDemand[],
): GeometryQueryCut {
  const section = validateGeometryProductQuerySection(descriptor);
  if (demands !== undefined && demands.length !== section.assetCount) {
    throw new RangeError("Query cut demand must cover the complete Product asset domain");
  }
  const assets = Object.freeze(Array.from({ length: section.assetCount }, (_, asset) => {
    const demand = demands?.[asset] ?? { active: true, domain: null, maximumError: 0 };
    if (!Number.isFinite(demand.maximumError) || demand.maximumError < 0) {
      throw new RangeError("Query cut error must be finite and nonnegative");
    }
    return Object.freeze({ active: demand.active, maximumError: demand.maximumError,
      domain: demand.domain === null ? null : geometryQueryDomain([demand.domain], 0) });
  }));
  const read = (cluster: number, offset: number): number =>
    section.view.getUint32(section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES + offset, true);
  const relevant = new Uint8Array(section.clusterCount);
  const refine = new Uint8Array(section.clusterCount);
  const parents: number[][] = Array.from({ length: section.clusterCount }, () => []);
  const cohorts = new Map<number, number[]>();
  const queue: number[] = [];
  for (let cluster = 0; cluster < section.clusterCount; cluster++) {
    const demand = assets[read(cluster, 28)]!;
    const at = section.clusters + cluster * GEOMETRY_QUERY_CLUSTER_BYTES;
    let intersects = demand.active;
    if (intersects && demand.domain !== null) {
      for (let axis = 0; axis < 3; axis++) {
        intersects &&= section.view.getFloat32(at + 44 + axis * 4, true) >= demand.domain.min[axis]! &&
          section.view.getFloat32(at + 32 + axis * 4, true) <= demand.domain.max[axis]!;
      }
    }
    relevant[cluster] = intersects ? 1 : 0;
    const childBegin = read(cluster, 60);
    const childCount = read(cluster, 64);
    for (let index = 0; index < childCount; index++) {
      const child = section.view.getUint32(section.children + (childBegin + index) * 4, true);
      parents[child]!.push(cluster);
    }
    if (childCount > 0) {
      // Multiple meshlets can represent one replacement group. They must
      // refine together, even when they occur under different coarse groups.
      const first = section.view.getUint32(section.children + childBegin * 4, true);
      const group = read(first, 4);
      const cohort = cohorts.get(group);
      if (cohort === undefined) {
        cohorts.set(group, [cluster]);
      } else {
        cohort.push(cluster);
      }
      const flags = read(cluster, 24);
      if (intersects && ((flags & GEOMETRY_QUERY_CLUSTER_COVERAGE_CRITICAL) !== 0 ||
          section.view.getFloat32(at + 56, true) > demand.maximumError)) {
        refine[cluster] = 1;
        queue.push(cluster);
      }
    } else if ((read(cluster, 24) & GEOMETRY_QUERY_CLUSTER_LEAF) === 0) {
      throw new Error("Query cut encountered a terminal cluster without exact coverage");
    }
  }
  // Monotone closure over incoming DAG edges prevents a coarse ancestor from
  // surviving next to a refined representation of the same source surface.
  const expandedGroups = new Set<number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const cluster = queue[cursor]!;
    const force = (parent: number): void => {
      if (refine[parent] === 0) {
        refine[parent] = 1;
        queue.push(parent);
      }
    };
    for (const parent of parents[cluster]!) {
      force(parent);
    }
    if (read(cluster, 64) > 0) {
      const first = section.view.getUint32(section.children + read(cluster, 60) * 4, true);
      const group = read(first, 4);
      if (!expandedGroups.has(group)) {
        expandedGroups.add(group);
        for (const peer of cohorts.get(group)!) {
          force(peer);
        }
      }
    }
  }
  const visited = new Uint8Array(section.clusterCount);
  const clusters: number[] = [];
  const pages = new Set<number>();
  const stack: number[] = [];
  let primitiveCount = 0;
  for (let index = 0; index < section.view.getUint32(60, true); index++) {
    stack.push(section.view.getUint32(section.roots + index * 4, true));
  }
  while (stack.length > 0) {
    const cluster = stack.pop()!;
    if (visited[cluster] !== 0) {
      continue;
    }
    visited[cluster] = 1;
    if (refine[cluster] !== 0 || (relevant[cluster] === 0 && read(cluster, 64) > 0)) {
      const begin = read(cluster, 60);
      for (let index = 0; index < read(cluster, 64); index++) {
        stack.push(section.view.getUint32(section.children + (begin + index) * 4, true));
      }
    } else if (relevant[cluster] !== 0) {
      clusters.push(cluster);
      pages.add(read(cluster, 0));
      primitiveCount += read(cluster, 12);
    }
  }
  clusters.sort((a, b) => a - b);
  return Object.freeze({ descriptor, assets, clusters: Object.freeze(clusters),
    pages: Object.freeze([...pages].sort((a, b) => a - b)), primitiveCount });
}
