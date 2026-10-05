import type {
  GlbCookAccessor,
  GlbCookAttributeSemantic,
  GlbCookPrimitive,
} from "../../loaders/gltf/streaming/GlbSceneCatalog.js";
import {
  WEB_GEOMETRY_ATTRIBUTE_COLOR,
  WEB_GEOMETRY_ATTRIBUTE_NORMAL,
  WEB_GEOMETRY_ATTRIBUTE_POSITION,
  WEB_GEOMETRY_ATTRIBUTE_TANGENT,
  WEB_GEOMETRY_ATTRIBUTE_UV0,
  WEB_GEOMETRY_ATTRIBUTE_UV1,
  WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES,
  WEB_GEOMETRY_CANONICAL_HEADER_BYTES,
  WEB_GEOMETRY_CANONICAL_VERTEX_BYTES,
  WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS,
  WEB_GEOMETRY_MESHLET_BLEND,
  WEB_GEOMETRY_MESHLET_CASTS_SHADOW,
  WEB_GEOMETRY_MESHLET_MASK,
  WEB_GEOMETRY_MESHLET_OPAQUE,
  WEB_GEOMETRY_MESHLET_TWO_SIDED,
  type WebCanonicalGeometryDomainV1,
} from "./wasm/WebGeometryCookerAbi.js";
import type { GlbPrimitiveRangeReader } from "./gltf/GlbPrimitiveCanonicalizer.js";

export const WEB_SPATIAL_SHARD_PARTITION_VERSION = "morton-radix-prefix-v1";
export const WEB_SPATIAL_SHARD_MIN_TRIANGLES = 256 * 1024;
export const WEB_SPATIAL_SHARD_MAX_TRIANGLES = 2 * 1024 * 1024;
const DEFAULT_BUCKET_BITS = 12;
const SCAN_TRIANGLES = 64 * 1024;

export interface GlbSpatialShardOptionsV1 {
  readonly maxSourceWindowBytes: number;
  readonly maxCanonicalWindowBytes: number;
  readonly sourceIdentityHash: Uint8Array;
  readonly bucketBits?: number;
  /** Test/offline override. Production defaults to the ADR-0018 256K lower target. */
  readonly minimumTrianglesPerShard?: number;
  readonly maximumTrianglesPerShard?: number;
  /** Worst-case unique vertices admitted by one shard. */
  readonly maximumVerticesPerShard?: number;
}

export interface GlbSpatialShardPlanV1 {
  readonly schemaVersion: 1;
  readonly partitionVersion: typeof WEB_SPATIAL_SHARD_PARTITION_VERSION;
  readonly shardIndex: number;
  readonly shardId: string;
  readonly sourcePrimitive: string;
  /** Half-open interval in stable Morton-prefix order. */
  readonly triangleOrderOffset: number;
  readonly triangleCount: number;
  readonly firstBucket: number;
  readonly lastBucket: number;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly estimatedCanonicalBytes: number;
  readonly materialIndex: number;
  readonly attributeSemantics: readonly GlbCookAttributeSemantic[];
  readonly neighbors: readonly string[];
}

export interface GlbSpatialShardSetV1 {
  readonly schemaVersion: 1;
  readonly partitionVersion: typeof WEB_SPATIAL_SHARD_PARTITION_VERSION;
  readonly sourcePrimitive: string;
  readonly sourceTriangleCount: number;
  readonly bucketBits: number;
  readonly bucketOffsets: Uint32Array;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly shards: readonly GlbSpatialShardPlanV1[];
  readonly peakSourceWindowBytes: number;
  readonly planningPasses: number;
}

/**
 * Triangle ownership materialized in one source-order scan.
 *
 * The scratch contains only index triples, not source attributes or canonical
 * vertices. Its size is checked by the caller before allocation so a giant
 * primitive cannot silently turn this optimization into scene-scale heap
 * residency.
 */
export interface GlbSpatialShardMaterializationV1 {
  readonly backend: "memory" | "opfs";
  /** Peak index scratch, including one shard read buffer on the external path. */
  readonly scratchBytes: number;
  readonly externalBytes: number;
  readonly scanPasses: number;
  readShard(shardIndex: number): Uint32Array;
  dispose(): Promise<void>;
}

export interface SpatialShardExternalScratchV1 {
  write(bytes: Uint8Array, at: number): void;
  read(bytes: Uint8Array, at: number): void;
  flush(): void;
  dispose(): Promise<void>;
}

interface SpatialSyncAccessHandle {
  write(bytes: Uint8Array, options: { at: number }): number;
  read(bytes: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface MortonPartitionIntervalV1 {
  readonly triangleOrderOffset: number;
  readonly triangleCount: number;
  readonly firstBucket: number;
  readonly lastBucket: number;
}

interface ScanOptions {
  readonly maxSourceWindowBytes: number;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly bucketBits: number;
}

interface ScanEvidence {
  peakSourceWindowBytes: number;
}

const ATTRIBUTE_LAYOUT: Readonly<
  Record<GlbCookAttributeSemantic, { readonly offset: number; readonly bit: number }>
> = Object.freeze({
  POSITION: { offset: 0, bit: WEB_GEOMETRY_ATTRIBUTE_POSITION },
  NORMAL: { offset: 3, bit: WEB_GEOMETRY_ATTRIBUTE_NORMAL },
  TANGENT: { offset: 6, bit: WEB_GEOMETRY_ATTRIBUTE_TANGENT },
  TEXCOORD_0: { offset: 10, bit: WEB_GEOMETRY_ATTRIBUTE_UV0 },
  TEXCOORD_1: { offset: 12, bit: WEB_GEOMETRY_ATTRIBUTE_UV1 },
  COLOR_0: { offset: 14, bit: WEB_GEOMETRY_ATTRIBUTE_COLOR },
});

/**
 * Plans bounded triangle-owned shards without retaining a scene-scale key array.
 * The histogram is the most-significant radix pass; source triangle order is the
 * deterministic tie break inside one Morton prefix.
 */
export async function planGlbPrimitiveSpatialShardsV1(
  unit: GlbCookPrimitive,
  reader: GlbPrimitiveRangeReader,
  options: GlbSpatialShardOptionsV1,
): Promise<GlbSpatialShardSetV1> {
  validateOptions(unit, options);
  rejectSparse(unit);
  const bucketBits = options.bucketBits ?? DEFAULT_BUCKET_BITS;
  const bucketCount = 1 << bucketBits;
  const histogram = new Uint32Array(bucketCount);
  const bucketMin = new Float64Array(bucketCount * 3);
  bucketMin.fill(Number.POSITIVE_INFINITY);
  const bucketMax = new Float64Array(bucketCount * 3);
  bucketMax.fill(Number.NEGATIVE_INFINITY);
  const evidence: ScanEvidence = { peakSourceWindowBytes: 0 };
  const bounds = await resolvePlanningBounds(
    unit.attributes.POSITION,
    reader,
    options.maxSourceWindowBytes,
    evidence,
  );
  await scanTriangles(
    unit,
    reader,
    { maxSourceWindowBytes: options.maxSourceWindowBytes, ...bounds, bucketBits },
    evidence,
    (_triangle, _indices, centroid, bucket, triangleMin, triangleMax) => {
      histogram[bucket] = histogram[bucket]! + 1;
      const at = bucket * 3;
      for (let axis = 0; axis < 3; axis++) {
        bucketMin[at + axis] = Math.min(bucketMin[at + axis]!, triangleMin[axis]!);
        bucketMax[at + axis] = Math.max(bucketMax[at + axis]!, triangleMax[axis]!);
      }
    },
  );
  const target = targetTriangles(options);
  const intervals = partitionMortonHistogramV1(histogram, target);
  const bucketOffsets = prefixOffsets(histogram);
  const identities = await Promise.all(
    intervals.map((interval, index) =>
      deriveShardId(options.sourceIdentityHash, unit, bucketBits, target, index, interval),
    ),
  );
  const semantics = Object.freeze((Object.keys(unit.attributes) as GlbCookAttributeSemantic[]).sort());
  const shards = intervals.map((interval, index): GlbSpatialShardPlanV1 => {
    const shardBounds = intervalBounds(interval, bucketMin, bucketMax, bounds);
    const neighbors = [identities[index - 1], identities[index + 1]].filter(
      (value): value is string => value !== undefined,
    );
    return Object.freeze({
      schemaVersion: 1,
      partitionVersion: WEB_SPATIAL_SHARD_PARTITION_VERSION,
      shardIndex: index,
      shardId: identities[index]!,
      sourcePrimitive: primitiveKey(unit),
      triangleOrderOffset: interval.triangleOrderOffset,
      triangleCount: interval.triangleCount,
      firstBucket: interval.firstBucket,
      lastBucket: interval.lastBucket,
      boundsMin: shardBounds.boundsMin,
      boundsMax: shardBounds.boundsMax,
      estimatedCanonicalBytes: worstCaseCanonicalBytes(interval.triangleCount),
      materialIndex: unit.materialIndex,
      attributeSemantics: semantics,
      neighbors: Object.freeze(neighbors),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    partitionVersion: WEB_SPATIAL_SHARD_PARTITION_VERSION,
    sourcePrimitive: primitiveKey(unit),
    sourceTriangleCount: unit.triangleCount,
    bucketBits,
    bucketOffsets,
    boundsMin: bounds.boundsMin,
    boundsMax: bounds.boundsMax,
    shards: Object.freeze(shards),
    peakSourceWindowBytes: evidence.peakSourceWindowBytes,
    planningPasses: bounds.usedAccessorBounds ? 1 : 2,
  });
}

/**
 * Materializes every shard's triangle ownership with one sequential scan.
 *
 * The previous path scanned the complete primitive once per shard. This pass
 * keeps only bounded index scratch for the current primitive and writes each
 * triangle directly into its deterministic Morton-rank slot. Attribute and
 * canonical vertex data remain per-shard and are read after this pass.
 */
export async function materializeGlbPrimitiveSpatialShardsV1(
  unit: GlbCookPrimitive,
  set: GlbSpatialShardSetV1,
  reader: GlbPrimitiveRangeReader,
  maxSourceWindowBytes: number,
  maxScratchBytes: number,
  createExternalScratch: (
    bytes: number,
  ) => Promise<SpatialShardExternalScratchV1> = createOpfsSpatialShardScratch,
): Promise<GlbSpatialShardMaterializationV1> {
  assertPlanBelongsToPrimitive(unit, set);
  rejectSparse(unit);
  if (!Number.isSafeInteger(maxSourceWindowBytes) || maxSourceWindowBytes <= 0)
    throw new RangeError("maxSourceWindowBytes must be a positive safe integer");
  if (!Number.isSafeInteger(maxScratchBytes) || maxScratchBytes <= 0)
    throw new RangeError("maxScratchBytes must be a positive safe integer");
  const totalBytes = spatialScratchBytes(set);
  const external = totalBytes > maxScratchBytes;
  const bucketCount = set.bucketOffsets.length - 1;
  const maxShardBytes = Math.max(...set.shards.map((shard) => shard.triangleCount * 12));
  const activeBuckets = Array.from({ length: bucketCount }, (_, index) => index).filter(
    (index) => set.bucketOffsets[index + 1]! > set.bucketOffsets[index]!,
  ).length;
  const bufferTriangles = external
    ? Math.min(341, Math.floor((maxScratchBytes - bucketCount * 4 - maxShardBytes) / (activeBuckets * 12)))
    : 0;
  if (external && bufferTriangles < 1) {
    throw new RangeError(
      `spatial external shard scratch needs one bucket triple and one shard within maxScratchBytes=${maxScratchBytes}`,
    );
  }
  const scratchBytes = external
    ? bucketCount * 4 + activeBuckets * bufferTriangles * 12 + maxShardBytes
    : totalBytes;
  const triangleIndices = external
    ? null
    : set.shards.map((shard) => new Uint32Array(shard.triangleCount * 3));
  const buffers = external
    ? Array.from({ length: bucketCount }, (_, bucket) =>
        set.bucketOffsets[bucket + 1]! > set.bucketOffsets[bucket]!
          ? new Uint32Array(bufferTriangles * 3)
          : null,
      )
    : [];
  const seen = new Uint32Array(set.bucketOffsets.length - 1);
  const scratch = external ? await createExternalScratch(totalBytes) : null;
  try {
    await scanTriangles(
      unit,
      reader,
      {
        maxSourceWindowBytes,
        boundsMin: set.boundsMin,
        boundsMax: set.boundsMax,
        bucketBits: set.bucketBits,
      },
      { peakSourceWindowBytes: 0 },
      (_triangle, indices, _centroid, bucket) => {
        const ordinal = seen[bucket]!;
        const rank = set.bucketOffsets[bucket]! + ordinal;
        seen[bucket] = ordinal + 1;
        if (triangleIndices !== null) {
          const shardIndex = shardIndexForRank(set.shards, rank);
          if (shardIndex < 0) throw new Error(`spatial triangle rank ${rank} is outside the shard plan`);
          const shard = set.shards[shardIndex]!;
          triangleIndices[shardIndex]!.set(indices, (rank - shard.triangleOrderOffset) * 3);
        } else {
          const buffer = buffers[bucket]!;
          const local = ordinal % bufferTriangles;
          buffer.set(indices, local * 3);
          if (local + 1 === bufferTriangles) {
            const bytes = new Uint8Array(buffer.buffer);
            scratch!.write(bytes, (rank - local) * 12);
          }
        }
      },
    );
    for (let bucket = 0; bucket < seen.length; bucket++) {
      if (seen[bucket] !== set.bucketOffsets[bucket + 1]! - set.bucketOffsets[bucket]!) {
        throw new Error(`spatial bucket ${bucket} ownership count is incomplete`);
      }
      if (scratch !== null && seen[bucket]! % bufferTriangles !== 0) {
        const count = seen[bucket]! % bufferTriangles;
        const bytes = new Uint8Array(buffers[bucket]!.buffer, 0, count * 12);
        scratch.write(bytes, (set.bucketOffsets[bucket]! + seen[bucket]! - count) * 12);
      }
    }
    scratch?.flush();
  } catch (error) {
    await scratch?.dispose();
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    backend: external ? "opfs" : "memory",
    scratchBytes,
    externalBytes: external ? totalBytes : 0,
    scanPasses: 1,
    readShard(shardIndex: number): Uint32Array {
      if (disposed) throw new Error("spatial shard scratch is disposed");
      const shard = set.shards[shardIndex];
      if (shard === undefined) throw new RangeError(`spatial shard ${shardIndex} is outside the plan`);
      if (triangleIndices !== null) return triangleIndices[shardIndex]!;
      const result = new Uint32Array(shard.triangleCount * 3);
      scratch!.read(new Uint8Array(result.buffer), shard.triangleOrderOffset * 12);
      return result;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await scratch?.dispose();
    },
  });
}

async function createOpfsSpatialShardScratch(bytes: number): Promise<SpatialShardExternalScratchV1> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof storage?.getDirectory !== "function" || !locks) {
    throw new Error("giant spatial shard scratch requires OPFS and Web Locks in a dedicated worker");
  }
  const directory = await storage.getDirectory();
  const name = `oengine-spatial-${crypto.randomUUID()}.scratch`;
  const lease = await acquireSpatialScratchLease(locks, name);
  let access: SpatialSyncAccessHandle | undefined;
  try {
    const file = await directory.getFileHandle(name, { create: true });
    const open = (
      file as FileSystemFileHandle & {
        createSyncAccessHandle?: () => Promise<SpatialSyncAccessHandle>;
      }
    ).createSyncAccessHandle;
    if (typeof open !== "function") throw new Error("OPFS synchronous access is unavailable in this worker");
    access = await open.call(file);
    access.truncate(bytes);
  } catch (error) {
    try {
      access?.close();
    } finally {
      try {
        await removeSpatialScratch(directory, name);
      } finally {
        await lease();
      }
    }
    throw error;
  }
  const live = access;
  let disposed = false;
  return {
    write(data, at) {
      if (disposed || live.write(data, { at }) !== data.byteLength) {
        throw new Error("OPFS spatial shard scratch write was incomplete");
      }
    },
    read(data, at) {
      if (disposed || live.read(data, { at }) !== data.byteLength) {
        throw new Error("OPFS spatial shard scratch read was incomplete");
      }
    },
    flush() {
      if (disposed) throw new Error("OPFS spatial shard scratch is disposed");
      live.flush();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        live.close();
      } finally {
        try {
          await removeSpatialScratch(directory, name);
        } finally {
          await lease();
        }
      }
    },
  };
}

/** Reclaims files whose worker died before its materialization could dispose. */
export async function cleanupOrphanedSpatialShardScratchV1(): Promise<number> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof storage?.getDirectory !== "function" || !locks) return 0;
  const directory = await storage.getDirectory();
  let removed = 0;
  const entries = directory as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of entries.keys()) {
    if (!/^oengine-spatial-[0-9a-f-]{36}\.scratch$/u.test(name)) continue;
    await locks.request(spatialScratchLockName(name), { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      await removeSpatialScratch(directory, name);
      removed++;
    });
  }
  return removed;
}

async function acquireSpatialScratchLease(locks: LockManager, name: string): Promise<() => Promise<void>> {
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = locks.request(spatialScratchLockName(name), async () => {
    acquired();
    await held;
  });
  void running.catch(failed);
  await ready;
  return async () => {
    release();
    await running;
  };
}

function spatialScratchLockName(name: string): string {
  return `oengine-spatial:${name}`;
}

async function removeSpatialScratch(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}

/** Canonicalizes a shard from one-shot materialized triangle ownership. */
export async function canonicalizeGlbPrimitiveSpatialShardIndicesV1(
  unit: GlbCookPrimitive,
  set: GlbSpatialShardSetV1,
  shard: GlbSpatialShardPlanV1,
  selected: Uint32Array,
  reader: GlbPrimitiveRangeReader,
  maxSourceWindowBytes: number,
): Promise<WebCanonicalGeometryDomainV1> {
  assertPlanBelongsToPrimitive(unit, set, shard);
  if (selected.length !== shard.triangleCount * 3)
    throw new Error(
      `spatial shard materialization has ${selected.length / 3} triangles, expected ${shard.triangleCount}`,
    );
  return canonicalizeSelectedTriangles(unit, shard, selected, reader, maxSourceWindowBytes);
}

/** Converts one planned shard to one independent Nyx canonical material domain. */
export async function canonicalizeGlbPrimitiveSpatialShardV1(
  unit: GlbCookPrimitive,
  set: GlbSpatialShardSetV1,
  shard: GlbSpatialShardPlanV1,
  reader: GlbPrimitiveRangeReader,
  maxSourceWindowBytes: number,
): Promise<WebCanonicalGeometryDomainV1> {
  assertPlanBelongsToPrimitive(unit, set, shard);
  rejectSparse(unit);
  const evidence: ScanEvidence = { peakSourceWindowBytes: 0 };
  const selected = new Uint32Array(shard.triangleCount * 3);
  const seen = new Uint32Array(set.bucketOffsets.length - 1);
  let selectedTriangles = 0;
  const start = shard.triangleOrderOffset,
    end = start + shard.triangleCount;
  await scanTriangles(
    unit,
    reader,
    { maxSourceWindowBytes, boundsMin: set.boundsMin, boundsMax: set.boundsMax, bucketBits: set.bucketBits },
    evidence,
    (_triangle, indices, _centroid, bucket) => {
      const rank = set.bucketOffsets[bucket]! + seen[bucket]!;
      seen[bucket] = seen[bucket]! + 1;
      if (rank < start || rank >= end) return;
      selected.set(indices, (rank - start) * 3);
      selectedTriangles++;
    },
  );
  if (selectedTriangles !== shard.triangleCount)
    throw new Error(`spatial shard selected ${selectedTriangles} triangles, expected ${shard.triangleCount}`);

  return canonicalizeSelectedTriangles(unit, shard, selected, reader, maxSourceWindowBytes, evidence);
}

async function canonicalizeSelectedTriangles(
  unit: GlbCookPrimitive,
  shard: GlbSpatialShardPlanV1,
  selected: Uint32Array,
  reader: GlbPrimitiveRangeReader,
  maxSourceWindowBytes: number,
  evidence: ScanEvidence = { peakSourceWindowBytes: 0 },
): Promise<WebCanonicalGeometryDomainV1> {
  if (!Number.isSafeInteger(maxSourceWindowBytes) || maxSourceWindowBytes <= 0)
    throw new RangeError("maxSourceWindowBytes must be a positive safe integer");

  const sorted = selected.slice().sort();
  let uniqueCount = 0;
  for (const value of sorted)
    if (uniqueCount === 0 || value !== sorted[uniqueCount - 1]) sorted[uniqueCount++] = value;
  const sourceVertices = sorted.subarray(0, uniqueCount);
  const vertices = new Float32Array(uniqueCount * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS);
  for (let vertex = 0; vertex < uniqueCount; vertex++) {
    const at = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    vertices[at + 5] = 1;
    vertices[at + 6] = 1;
    vertices[at + 9] = 1;
    vertices.fill(1, at + 14, at + 18);
  }
  let attributeMask = 0;
  for (const semantic of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"] as const) {
    const accessor = unit.attributes[semantic];
    if (!accessor) continue;
    requireAttributeEncoding(accessor, semantic, unit.vertexCount);
    const values = await readAccessorElements(
      accessor,
      sourceVertices,
      reader,
      maxSourceWindowBytes,
      evidence,
    );
    const layout = ATTRIBUTE_LAYOUT[semantic];
    for (let vertex = 0; vertex < uniqueCount; vertex++) {
      const target = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS + layout.offset;
      for (let component = 0; component < accessor.componentCount; component++)
        vertices[target + component] = values[vertex * accessor.componentCount + component]!;
    }
    attributeMask |= layout.bit;
  }
  const indices = new Uint32Array(selected.length);
  for (let index = 0; index < selected.length; index++)
    indices[index] = binarySearch(sourceVertices, selected[index]!);
  const alpha =
    unit.material.alphaMode === "OPAQUE"
      ? WEB_GEOMETRY_MESHLET_OPAQUE
      : unit.material.alphaMode === "MASK"
        ? WEB_GEOMETRY_MESHLET_MASK
        : WEB_GEOMETRY_MESHLET_BLEND;
  return Object.freeze({
    materialId: unit.material.materialIndex,
    meshletFlags:
      alpha |
      (unit.material.doubleSided ? WEB_GEOMETRY_MESHLET_TWO_SIDED : 0) |
      WEB_GEOMETRY_MESHLET_CASTS_SHADOW,
    attributeMask,
    generateNormals: (attributeMask & WEB_GEOMETRY_ATTRIBUTE_NORMAL) === 0,
    vertices,
    indices,
  });
}

/** Stable counting-radix grouping; intervals cover every triangle exactly once. */
export function partitionMortonHistogramV1(
  histogram: Uint32Array,
  targetTriangles: number,
): readonly MortonPartitionIntervalV1[] {
  if (histogram.length < 2 || (histogram.length & (histogram.length - 1)) !== 0)
    throw new RangeError("Morton histogram length must be a power of two");
  if (!Number.isSafeInteger(targetTriangles) || targetTriangles <= 0)
    throw new RangeError("targetTriangles must be a positive safe integer");
  let total = 0;
  for (const count of histogram) total = checkedAdd(total, count);
  const offsets = prefixOffsets(histogram);
  const intervals: MortonPartitionIntervalV1[] = [];
  for (let offset = 0; offset < total; offset += targetTriangles) {
    const count = Math.min(targetTriangles, total - offset);
    intervals.push(
      Object.freeze({
        triangleOrderOffset: offset,
        triangleCount: count,
        firstBucket: bucketForRank(offsets, offset),
        lastBucket: bucketForRank(offsets, offset + count - 1),
      }),
    );
  }
  return Object.freeze(intervals);
}

function validateOptions(unit: GlbCookPrimitive, options: GlbSpatialShardOptionsV1): void {
  if (unit.mode !== 4 || unit.triangleCount < 1 || unit.vertexCount < 3)
    throw new Error("spatial sharding requires a non-empty TRIANGLES primitive");
  for (const [name, value] of [
    ["maxSourceWindowBytes", options.maxSourceWindowBytes],
    ["maxCanonicalWindowBytes", options.maxCanonicalWindowBytes],
  ] as const)
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive safe integer`);
  if (options.sourceIdentityHash.byteLength !== 32)
    throw new RangeError("sourceIdentityHash must be 32 bytes");
  const bits = options.bucketBits ?? DEFAULT_BUCKET_BITS;
  if (!Number.isInteger(bits) || bits < 1 || bits > 20) throw new RangeError("bucketBits must be in [1, 20]");
}

function assertPlanBelongsToPrimitive(
  unit: GlbCookPrimitive,
  set: GlbSpatialShardSetV1,
  shard?: GlbSpatialShardPlanV1,
): void {
  if (set.sourcePrimitive !== primitiveKey(unit) || set.sourceTriangleCount !== unit.triangleCount)
    throw new Error("spatial shard plan does not belong to this GLB primitive");
  if (set.bucketOffsets.length < 2 || set.bucketOffsets[set.bucketOffsets.length - 1] !== unit.triangleCount)
    throw new Error("spatial shard bucket offsets do not cover this GLB primitive");
  if (
    shard !== undefined &&
    (shard.sourcePrimitive !== set.sourcePrimitive || set.shards[shard.shardIndex] !== shard)
  )
    throw new Error("spatial shard plan does not belong to this GLB primitive");
}

function spatialScratchBytes(set: GlbSpatialShardSetV1): number {
  let triangles = 0;
  for (const shard of set.shards) triangles = checkedAdd(triangles, shard.triangleCount);
  if (triangles !== set.sourceTriangleCount)
    throw new Error("spatial shard plans do not cover the source primitive exactly");
  return checkedMultiply(triangles, 3 * 4);
}

function shardIndexForRank(shards: readonly GlbSpatialShardPlanV1[], rank: number): number {
  let low = 0,
    high = shards.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1,
      shard = shards[middle]!;
    if (rank < shard.triangleOrderOffset) high = middle - 1;
    else if (rank >= shard.triangleOrderOffset + shard.triangleCount) low = middle + 1;
    else return middle;
  }
  return -1;
}

function rejectSparse(unit: GlbCookPrimitive): void {
  if (
    unit.indices?.sparse ||
    Object.values(unit.attributes).some((accessor) => accessor?.sparse !== undefined)
  )
    throw new Error(
      "giant-primitive spatial sharding does not admit sparse accessors; use the offline fallback",
    );
}

function targetTriangles(options: GlbSpatialShardOptionsV1): number {
  const minimum = options.minimumTrianglesPerShard ?? 1;
  const maximum = options.maximumTrianglesPerShard ?? WEB_SPATIAL_SHARD_MAX_TRIANGLES;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum <= 0 || maximum < minimum)
    throw new RangeError("spatial shard triangle limits are invalid");
  const byCanonical = Math.floor(
    (options.maxCanonicalWindowBytes -
      align16(WEB_GEOMETRY_CANONICAL_HEADER_BYTES + WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES)) /
      (3 * WEB_GEOMETRY_CANONICAL_VERTEX_BYTES + 12),
  );
  if (byCanonical <= 0) throw new Error("canonical budget cannot hold one worst-case triangle shard");
  const maximumVertices = options.maximumVerticesPerShard ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maximumVertices) || maximumVertices < 3)
    throw new RangeError("maximumVerticesPerShard must admit at least one triangle");
  const byVertices = Math.floor(maximumVertices / 3);
  const target = Math.min(maximum, byCanonical, byVertices);
  if (target < minimum) throw new Error("spatial shard work budget cannot admit minimumTrianglesPerShard");
  return target;
}

async function resolvePlanningBounds(
  accessor: GlbCookAccessor,
  reader: GlbPrimitiveRangeReader,
  maxBytes: number,
  evidence: ScanEvidence,
): Promise<{
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
  usedAccessorBounds: boolean;
}> {
  if (
    accessor.min?.length === 3 &&
    accessor.max?.length === 3 &&
    accessor.min.every(Number.isFinite) &&
    accessor.max.every(Number.isFinite)
  )
    return {
      boundsMin: accessor.min as readonly [number, number, number],
      boundsMax: accessor.max as readonly [number, number, number],
      usedAccessorBounds: true,
    };
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const perWindow = Math.max(
    1,
    Math.floor(
      (maxBytes - componentBytes(accessor.componentType) * accessor.componentCount) / accessor.byteStride,
    ) + 1,
  );
  for (let first = 0; first < accessor.count; first += perWindow) {
    const count = Math.min(perWindow, accessor.count - first);
    const ids = Uint32Array.from({ length: count }, (_, index) => first + index);
    const values = await readAccessorElements(accessor, ids, reader, maxBytes, evidence);
    for (let index = 0; index < count; index++)
      for (let axis = 0; axis < 3; axis++) {
        const value = values[index * 3 + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
  }
  return { boundsMin: min, boundsMax: max, usedAccessorBounds: false };
}

async function scanTriangles(
  unit: GlbCookPrimitive,
  reader: GlbPrimitiveRangeReader,
  options: ScanOptions,
  evidence: ScanEvidence,
  visit: (
    triangle: number,
    indices: readonly [number, number, number],
    centroid: readonly [number, number, number],
    bucket: number,
    triangleMin: readonly [number, number, number],
    triangleMax: readonly [number, number, number],
  ) => void,
): Promise<void> {
  const indexBytes = unit.indices ? componentBytes(unit.indices.componentType) * 3 : 12;
  const trianglesPerWindow = Math.max(
    1,
    Math.min(SCAN_TRIANGLES, Math.floor(options.maxSourceWindowBytes / Math.max(indexBytes * 2, 1))),
  );
  for (let firstTriangle = 0; firstTriangle < unit.triangleCount; firstTriangle += trianglesPerWindow) {
    const count = Math.min(trianglesPerWindow, unit.triangleCount - firstTriangle);
    const indices = unit.indices
      ? await readIndexWindow(
          unit.indices,
          firstTriangle * 3,
          count * 3,
          unit.vertexCount,
          reader,
          options.maxSourceWindowBytes,
          evidence,
        )
      : Uint32Array.from({ length: count * 3 }, (_, index) => firstTriangle * 3 + index);
    const sorted = indices.slice().sort();
    let uniqueCount = 0;
    for (const value of sorted)
      if (uniqueCount === 0 || value !== sorted[uniqueCount - 1]) sorted[uniqueCount++] = value;
    const unique = sorted.subarray(0, uniqueCount);
    const positions = await readAccessorElements(
      unit.attributes.POSITION,
      unique,
      reader,
      options.maxSourceWindowBytes,
      evidence,
      indices.byteLength,
    );
    for (let local = 0; local < count; local++) {
      const a = indices[local * 3]!,
        b = indices[local * 3 + 1]!,
        c = indices[local * 3 + 2]!;
      const ai = binarySearch(unique, a) * 3,
        bi = binarySearch(unique, b) * 3,
        ci = binarySearch(unique, c) * 3;
      const centroid: [number, number, number] = [
        (positions[ai]! + positions[bi]! + positions[ci]!) / 3,
        (positions[ai + 1]! + positions[bi + 1]! + positions[ci + 1]!) / 3,
        (positions[ai + 2]! + positions[bi + 2]! + positions[ci + 2]!) / 3,
      ];
      const triangleMin: [number, number, number] = [
        Math.min(positions[ai]!, positions[bi]!, positions[ci]!),
        Math.min(positions[ai + 1]!, positions[bi + 1]!, positions[ci + 1]!),
        Math.min(positions[ai + 2]!, positions[bi + 2]!, positions[ci + 2]!),
      ];
      const triangleMax: [number, number, number] = [
        Math.max(positions[ai]!, positions[bi]!, positions[ci]!),
        Math.max(positions[ai + 1]!, positions[bi + 1]!, positions[ci + 1]!),
        Math.max(positions[ai + 2]!, positions[bi + 2]!, positions[ci + 2]!),
      ];
      visit(
        firstTriangle + local,
        [a, b, c],
        centroid,
        mortonBucket(centroid, options.boundsMin, options.boundsMax, options.bucketBits),
        triangleMin,
        triangleMax,
      );
    }
  }
}

async function readIndexWindow(
  accessor: GlbCookAccessor,
  first: number,
  count: number,
  vertexCount: number,
  reader: GlbPrimitiveRangeReader,
  maxBytes: number,
  evidence: ScanEvidence,
): Promise<Uint32Array> {
  const bytes = componentBytes(accessor.componentType),
    byteLength = count * bytes;
  if (byteLength > maxBytes) throw new Error("index source window exceeds maxSourceWindowBytes");
  const payload = await reader.readRange({
    bufferIndex: accessor.bufferIndex,
    byteOffset: accessor.byteOffset + first * accessor.byteStride,
    byteLength,
  });
  if (payload.byteLength !== byteLength)
    throw new Error("GLB index source window returned the wrong byte length");
  evidence.peakSourceWindowBytes = Math.max(evidence.peakSourceWindowBytes, payload.byteLength);
  const view = new DataView(payload),
    output = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    const at = index * bytes;
    const value =
      accessor.componentType === 5121
        ? view.getUint8(at)
        : accessor.componentType === 5123
          ? view.getUint16(at, true)
          : view.getUint32(at, true);
    if (value >= vertexCount) throw new Error(`GLB index ${value} exceeds vertex count ${vertexCount}`);
    output[index] = value;
  }
  return output;
}

async function readAccessorElements(
  accessor: GlbCookAccessor,
  ids: Uint32Array,
  reader: GlbPrimitiveRangeReader,
  maxBytes: number,
  evidence: ScanEvidence,
  residentBytes = 0,
): Promise<Float32Array> {
  const output = new Float32Array(ids.length * accessor.componentCount);
  const elementBytes = accessor.componentCount * componentBytes(accessor.componentType);
  let begin = 0;
  while (begin < ids.length) {
    const first = ids[begin]!;
    if (first >= accessor.count)
      throw new Error(`GLB accessor ${accessor.accessorIndex} element ${first} is out of range`);
    let end = begin + 1;
    while (end < ids.length) {
      const candidate = (ids[end]! - first) * accessor.byteStride + elementBytes;
      if (candidate > maxBytes - residentBytes) break;
      end++;
    }
    if (end === begin) throw new Error("accessor source window cannot admit one element");
    const byteLength = (ids[end - 1]! - first) * accessor.byteStride + elementBytes;
    if (residentBytes + byteLength > maxBytes)
      throw new Error("accessor source window exceeds maxSourceWindowBytes");
    const payload = await reader.readRange({
      bufferIndex: accessor.bufferIndex,
      byteOffset: accessor.byteOffset + first * accessor.byteStride,
      byteLength,
    });
    if (payload.byteLength !== byteLength)
      throw new Error(`GLB accessor ${accessor.accessorIndex} source window returned the wrong byte length`);
    evidence.peakSourceWindowBytes = Math.max(
      evidence.peakSourceWindowBytes,
      residentBytes + payload.byteLength,
    );
    const view = new DataView(payload);
    for (let cursor = begin; cursor < end; cursor++) {
      const source = (ids[cursor]! - first) * accessor.byteStride;
      for (let component = 0; component < accessor.componentCount; component++) {
        const value = readComponent(
          view,
          source + component * componentBytes(accessor.componentType),
          accessor.componentType,
          accessor.normalized,
        );
        if (!Number.isFinite(value))
          throw new Error(`GLB accessor ${accessor.accessorIndex} contains non-finite data`);
        output[cursor * accessor.componentCount + component] = value;
      }
    }
    begin = end;
  }
  return output;
}

function requireAttributeEncoding(
  accessor: GlbCookAccessor,
  semantic: GlbCookAttributeSemantic,
  vertexCount: number,
): void {
  if (
    accessor.count !== vertexCount ||
    accessor.byteStride < accessor.componentCount * componentBytes(accessor.componentType)
  )
    throw new Error(`GLB ${semantic} accessor shape/stride is invalid`);
  const encodingIs = (types: readonly number[], normalized: boolean): boolean =>
    types.includes(accessor.componentType) && accessor.normalized === normalized;
  const valid =
    semantic === "POSITION"
      ? accessor.componentCount === 3 && encodingIs([5126], false)
      : semantic === "NORMAL"
        ? accessor.componentCount === 3 && (encodingIs([5126], false) || encodingIs([5120, 5122], true))
        : semantic === "TANGENT"
          ? accessor.componentCount === 4 && (encodingIs([5126], false) || encodingIs([5120, 5122], true))
          : semantic === "COLOR_0"
            ? [3, 4].includes(accessor.componentCount) &&
              (encodingIs([5126], false) || encodingIs([5121, 5123], true))
            : accessor.componentCount === 2 && (encodingIs([5126], false) || encodingIs([5121, 5123], true));
  if (!valid) throw new Error(`GLB ${semantic} accessor component encoding is invalid`);
}

function intervalBounds(
  interval: MortonPartitionIntervalV1,
  bucketMin: Float64Array,
  bucketMax: Float64Array,
  fallback: { boundsMin: readonly [number, number, number]; boundsMax: readonly [number, number, number] },
): { boundsMin: readonly [number, number, number]; boundsMax: readonly [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let bucket = interval.firstBucket; bucket <= interval.lastBucket; bucket++)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, bucketMin[bucket * 3 + axis]!);
      max[axis] = Math.max(max[axis]!, bucketMax[bucket * 3 + axis]!);
    }
  return min.every(Number.isFinite) && max.every(Number.isFinite)
    ? { boundsMin: Object.freeze(min), boundsMax: Object.freeze(max) }
    : fallback;
}

async function deriveShardId(
  sourceHash: Uint8Array,
  unit: GlbCookPrimitive,
  bucketBits: number,
  target: number,
  index: number,
  interval: MortonPartitionIntervalV1,
): Promise<string> {
  const tag = new TextEncoder().encode(`OENGINE-SPATIAL-SHARD-V1\0${WEB_SPATIAL_SHARD_PARTITION_VERSION}`);
  const bytes = new Uint8Array(tag.byteLength + sourceHash.byteLength + 32),
    view = new DataView(bytes.buffer);
  bytes.set(tag);
  bytes.set(sourceHash, tag.byteLength);
  let at = tag.byteLength + sourceHash.byteLength;
  for (const value of [
    unit.meshIndex,
    unit.primitiveIndex,
    bucketBits,
    target,
    index,
    interval.triangleOrderOffset,
    interval.triangleCount,
    unit.materialIndex >>> 0,
  ]) {
    view.setUint32(at, value, true);
    at += 4;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function prefixOffsets(histogram: Uint32Array): Uint32Array {
  const offsets = new Uint32Array(histogram.length + 1);
  let total = 0;
  for (let index = 0; index < histogram.length; index++) {
    total = checkedAdd(total, histogram[index]!);
    if (total > 0xffffffff) throw new RangeError("spatial triangle count exceeds u32");
    offsets[index + 1] = total;
  }
  return offsets;
}
function bucketForRank(offsets: Uint32Array, rank: number): number {
  let low = 0,
    high = offsets.length - 2;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (rank < offsets[middle]!) high = middle - 1;
    else if (rank >= offsets[middle + 1]!) low = middle + 1;
    else return middle;
  }
  throw new RangeError("Morton rank is outside the histogram");
}
function mortonBucket(
  point: readonly number[],
  min: readonly number[],
  max: readonly number[],
  bits: number,
): number {
  const q = point.map((value, axis) => {
    const extent = max[axis]! - min[axis]!;
    return extent > 0 ? Math.max(0, Math.min(1023, Math.floor(((value - min[axis]!) / extent) * 1023))) : 0;
  });
  const code = (part1By2(q[0]!) | (part1By2(q[1]!) << 1) | (part1By2(q[2]!) << 2)) >>> 0;
  return code >>> (30 - bits);
}
function part1By2(value: number): number {
  let x = value & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x;
}
function binarySearch(values: Uint32Array, target: number): number {
  let low = 0,
    high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1,
      value = values[middle]!;
    if (value < target) low = middle + 1;
    else if (value > target) high = middle - 1;
    else return middle;
  }
  throw new Error(`source vertex ${target} is absent from the shard remap`);
}
function worstCaseCanonicalBytes(triangles: number): number {
  const vertexOffset = align16(WEB_GEOMETRY_CANONICAL_HEADER_BYTES + WEB_GEOMETRY_CANONICAL_DOMAIN_BYTES);
  const indexOffset = align16(vertexOffset + triangles * 3 * WEB_GEOMETRY_CANONICAL_VERTEX_BYTES);
  return align16(indexOffset + triangles * 3 * 4);
}
function primitiveKey(unit: GlbCookPrimitive): string {
  return `${unit.nodeIndex}:${unit.meshIndex}:${unit.primitiveIndex}`;
}
function align16(value: number): number {
  return Math.ceil(value / 16) * 16;
}
function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError("spatial triangle count exceeds safe integer range");
  return value;
}
function checkedMultiply(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Math.floor(Number.MAX_SAFE_INTEGER / Math.max(1, right))
  )
    throw new RangeError("spatial scratch byte count exceeds safe integer range");
  return left * right;
}
function componentBytes(type: GlbCookAccessor["componentType"]): number {
  return type === 5120 || type === 5121 ? 1 : type === 5122 || type === 5123 ? 2 : 4;
}
function readComponent(
  view: DataView,
  at: number,
  type: GlbCookAccessor["componentType"],
  normalized: boolean,
): number {
  switch (type) {
    case 5120: {
      const value = view.getInt8(at);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = view.getUint8(at);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = view.getInt16(at, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    case 5123: {
      const value = view.getUint16(at, true);
      return normalized ? value / 65535 : value;
    }
    case 5125:
      return view.getUint32(at, true);
    case 5126:
      return view.getFloat32(at, true);
  }
}
