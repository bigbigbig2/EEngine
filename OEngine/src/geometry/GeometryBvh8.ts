import {
  GEOMETRY_INVALID_INDEX,
  type GeometryBvh8Node,
  type GeometryClusterRecord
} from "../assets/GeometryAssetPackage.js";

interface BvhPrimitive {
  readonly clusterIndex: number;
  readonly boundsBox: Float32Array;
  readonly center: readonly [number, number, number];
}

interface BvhEntry {
  readonly leaf: boolean;
  readonly ref: number;
  readonly rangeCount: number;
  readonly boundsBox: Float32Array;
}

/**
 * Deterministic, unquantized BVH8 builder used by the R2 Cooker.
 *
 * The grouping keeps Bevy's balanced eight-way + surface-area ordering
 * invariants, while deliberately avoiding Bevy's native task/ECS ownership.
 * A leaf references one contiguous Cluster range (count one in v1); internal
 * entries reference another BVH8 node by u32 element index.
 */
export function buildGeometryBvh8(
  clusters: readonly GeometryClusterRecord[]
): readonly GeometryBvh8Node[] {
  if (clusters.length === 0) return Object.freeze([]);
  const primitives = clusters.map((cluster, clusterIndex) => ({
    clusterIndex,
    boundsBox: new Float32Array(cluster.boundsBox),
    center: Object.freeze([
      0.5 * (cluster.boundsBox[0]! + cluster.boundsBox[3]!),
      0.5 * (cluster.boundsBox[1]! + cluster.boundsBox[4]!),
      0.5 * (cluster.boundsBox[2]! + cluster.boundsBox[5]!)
    ] as [number, number, number])
  }));
  const nodes: GeometryBvh8Node[] = [];

  const build = (
    group: readonly BvhPrimitive[],
    parent: number,
    depth: number
  ): number => {
    const index = nodes.length;
    // Reserve the element first so recursive child refs are stable u32 indices.
    nodes.push(undefined as unknown as GeometryBvh8Node);
    const partitions = partitionBalancedSah(group);
    const entries: BvhEntry[] = [];
    for (const partition of partitions) {
      const boundsBox = boundsOfPrimitives(partition);
      if (partition.length === 1) {
        entries.push({
          leaf: true,
          ref: partition[0]!.clusterIndex,
          rangeCount: 1,
          boundsBox
        });
      } else {
        entries.push({
          leaf: false,
          ref: build(partition, index, depth + 1),
          rangeCount: 0,
          boundsBox
        });
      }
    }

    const childRefs = new Uint32Array(8);
    childRefs.fill(GEOMETRY_INVALID_INDEX);
    const childRangeCounts = new Uint32Array(8);
    const childBoundsBox: Float32Array[] = Array.from(
      { length: 8 },
      () => new Float32Array(6)
    );
    let validMask = 0;
    let leafMask = 0;
    for (let slot = 0; slot < entries.length; slot++) {
      const entry = entries[slot]!;
      validMask |= 1 << slot;
      if (entry.leaf) leafMask |= 1 << slot;
      childRefs[slot] = entry.ref;
      childRangeCounts[slot] = entry.rangeCount;
      childBoundsBox[slot] = entry.boundsBox;
    }
    nodes[index] = Object.freeze({
      parent,
      depth,
      childCount: entries.length,
      validMask,
      leafMask,
      flags: 0,
      childRefs,
      childRangeCounts,
      childBoundsBox: Object.freeze(childBoundsBox)
    });
    return index;
  };

  const root = build(primitives, GEOMETRY_INVALID_INDEX, 0);
  if (root !== 0) throw new Error("BVH8 builder failed to emit root at index zero");
  return Object.freeze(nodes);
}

function partitionBalancedSah(
  primitives: readonly BvhPrimitive[]
): readonly (readonly BvhPrimitive[])[] {
  if (primitives.length <= 8) {
    return primitives.map((primitive) => Object.freeze([primitive]));
  }
  const groupCount = Math.min(8, primitives.length);
  let best: BvhPrimitive[][] | undefined;
  let bestCost = Infinity;
  let bestAxis = 0;
  for (let axis = 0; axis < 3; axis++) {
    const sorted = [...primitives].sort((a, b) =>
      a.center[axis]! - b.center[axis]! || a.clusterIndex - b.clusterIndex
    );
    const groups = balancedSlices(sorted, groupCount);
    let cost = 0;
    for (const group of groups) {
      cost += surfaceArea(boundsOfPrimitives(group)) * group.length;
    }
    if (cost < bestCost || (cost === bestCost && axis < bestAxis)) {
      best = groups;
      bestCost = cost;
      bestAxis = axis;
    }
  }
  return Object.freeze(best!.map((group) => Object.freeze(group)));
}

function balancedSlices<T>(values: readonly T[], count: number): T[][] {
  const groups: T[][] = [];
  let cursor = 0;
  for (let group = 0; group < count; group++) {
    const remaining = values.length - cursor;
    const groupCount = count - group;
    const size = Math.ceil(remaining / groupCount);
    groups.push(values.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function boundsOfPrimitives(
  primitives: readonly BvhPrimitive[]
): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const primitive of primitives) {
    const box = primitive.boundsBox;
    minX = Math.min(minX, box[0]!);
    minY = Math.min(minY, box[1]!);
    minZ = Math.min(minZ, box[2]!);
    maxX = Math.max(maxX, box[3]!);
    maxY = Math.max(maxY, box[4]!);
    maxZ = Math.max(maxZ, box[5]!);
  }
  return new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]);
}

function surfaceArea(box: Float32Array): number {
  const x = Math.max(0, box[3]! - box[0]!);
  const y = Math.max(0, box[4]! - box[1]!);
  const z = Math.max(0, box[5]! - box[2]!);
  return 2 * (x * y + y * z + z * x);
}
