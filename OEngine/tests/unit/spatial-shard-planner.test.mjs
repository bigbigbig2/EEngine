import assert from "node:assert/strict";
import test from "node:test";

const {
  canonicalizeGlbPrimitiveSpatialShardV1,
  canonicalizeGlbPrimitiveSpatialShardIndicesV1,
  materializeGlbPrimitiveSpatialShardsV1,
  partitionMortonHistogramV1,
  planGlbPrimitiveSpatialShardsV1
} = await import("../../.test-dist/assets/web-cook/SpatialShardPlanner.js");
const { WEB_GEOMETRY_MESHLET_CASTS_SHADOW, WEB_GEOMETRY_MESHLET_MASK, WEB_GEOMETRY_MESHLET_TWO_SIDED } = await import("../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js");

function fixture() {
  const triangleCount = 8, vertexCount = triangleCount * 3;
  const positionBytes = vertexCount * 12, normalBytes = vertexCount * 12, uvBytes = vertexCount * 8, indexBytes = triangleCount * 3 * 2;
  const bytes = new ArrayBuffer(positionBytes + normalBytes + uvBytes + indexBytes), view = new DataView(bytes);
  const centroids = [];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const baseX = triangle < 4 ? triangle : 100 + triangle;
    centroids.push(`${baseX + 1 / 3},${1 / 3},0`);
    [[baseX, 0, 0], [baseX + 1, 0, 0], [baseX, 1, 0]].forEach((position, corner) => position.forEach((value, axis) => view.setFloat32((triangle * 3 + corner) * 12 + axis * 4, value, true)));
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) view.setFloat32(positionBytes + vertex * 12 + 8, 1, true);
  for (let vertex = 0; vertex < vertexCount; vertex++) { view.setFloat32(positionBytes + normalBytes + vertex * 8, vertex / vertexCount, true); view.setFloat32(positionBytes + normalBytes + vertex * 8 + 4, 1, true); }
  const indicesAt = positionBytes + normalBytes + uvBytes;
  for (let index = 0; index < triangleCount * 3; index++) view.setUint16(indicesAt + index * 2, index, true);
  const accessor = (accessorIndex, byteOffset, byteLength, byteStride, componentType, componentCount, count, min, max) => ({ accessorIndex, bufferIndex: 0, byteOffset, byteLength, byteStride, componentType, componentCount, count, normalized: false, ...(min ? { min, max } : {}) });
  const position = accessor(0, 0, positionBytes, 12, 5126, 3, vertexCount, [0, 0, 0], [108, 1, 0]);
  const normal = accessor(1, positionBytes, normalBytes, 12, 5126, 3, vertexCount);
  const uv = accessor(2, positionBytes + normalBytes, uvBytes, 8, 5126, 2, vertexCount);
  const indices = accessor(3, indicesAt, indexBytes, 2, 5123, 1, triangleCount * 3);
  const material = { materialIndex: 7, alphaMode: "MASK", doubleSided: true };
  const unit = { nodeIndex: 2, instanceNodeIndices: [2], meshIndex: 3, primitiveIndex: 4, materialIndex: 7, mode: 4, vertexCount, triangleCount, attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material, ranges: [position, normal, uv, indices], boundsMin: [0, 0, 0], boundsMax: [108, 1, 0], boundsSphere: [54, 0.5, 0, 54.1] };
  const reader = { readRange: async range => bytes.slice(range.byteOffset, range.byteOffset + range.byteLength) };
  return { unit, reader, centroids };
}

function sharedBoundaryFixture() {
  const vertexCount = 5, triangleCount = 2, positionBytes = vertexCount * 12, normalBytes = vertexCount * 12, uvBytes = vertexCount * 8, indexBytes = triangleCount * 3 * 2;
  const bytes = new ArrayBuffer(positionBytes + normalBytes + uvBytes + indexBytes), view = new DataView(bytes);
  const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [100, 0, 0], [100, 1, 0]];
  const indicesAt = positionBytes + normalBytes + uvBytes;
  positions.forEach((position, vertex) => position.forEach((value, axis) => view.setFloat32(vertex * 12 + axis * 4, value, true)));
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    view.setFloat32(positionBytes + vertex * 12, 0, true);
    view.setFloat32(positionBytes + vertex * 12 + 4, 0, true);
    view.setFloat32(positionBytes + vertex * 12 + 8, 1, true);
    view.setFloat32(positionBytes + normalBytes + vertex * 8, vertex / 10, true);
    view.setFloat32(positionBytes + normalBytes + vertex * 8 + 4, 0.5, true);
  }
  [0, 1, 2, 0, 3, 4].forEach((value, index) => view.setUint16(indicesAt + index * 2, value, true));
  const accessor = (accessorIndex, byteOffset, byteLength, byteStride, componentType, componentCount, count, min, max) => ({ accessorIndex, bufferIndex: 0, byteOffset, byteLength, byteStride, componentType, componentCount, count, normalized: false, ...(min ? { min, max } : {}) });
  const position = accessor(0, 0, positionBytes, 12, 5126, 3, vertexCount, [0, 0, 0], [100, 1, 0]);
  const normal = accessor(1, positionBytes, normalBytes, 12, 5126, 3, vertexCount);
  const uv = accessor(2, positionBytes + normalBytes, uvBytes, 8, 5126, 2, vertexCount);
  const indices = accessor(3, indicesAt, indexBytes, 2, 5123, 1, triangleCount * 3);
  const unit = { nodeIndex: 0, instanceNodeIndices: [0], meshIndex: 0, primitiveIndex: 0, materialIndex: 3, mode: 4, vertexCount, triangleCount, attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material: { materialIndex: 3, alphaMode: "OPAQUE", doubleSided: false }, ranges: [position, normal, uv, indices], boundsMin: [0, 0, 0], boundsMax: [100, 1, 0], boundsSphere: [50, 0.5, 0, 50.1] };
  const reader = { readRange: async range => bytes.slice(range.byteOffset, range.byteOffset + range.byteLength) };
  return { unit, reader };
}

test("100M Morton histogram produces bounded, exact triangle ownership", () => {
  const histogram = new Uint32Array(4096);
  histogram[0] = 40_000_000;
  histogram[2048] = 10_000_000;
  histogram[4095] = 50_000_000;
  const shards = partitionMortonHistogramV1(histogram, 1_000_000);
  assert.equal(shards.length, 100);
  assert.equal(shards.reduce((sum, shard) => sum + shard.triangleCount, 0), 100_000_000);
  assert.ok(shards.every(shard => shard.triangleCount <= 1_000_000));
  assert.deepEqual(shards.map(shard => shard.triangleOrderOffset), Array.from({ length: 100 }, (_, index) => index * 1_000_000));
});

test("spatial planner and canonicalizer preserve bounds, attributes, material, seams, and deterministic identity", async () => {
  const { unit, reader, centroids } = fixture();
  const options = { maxSourceWindowBytes: 2048, maxCanonicalWindowBytes: 2048, sourceIdentityHash: new Uint8Array(32).fill(9), bucketBits: 4, minimumTrianglesPerShard: 1, maximumTrianglesPerShard: 2 };
  const first = await planGlbPrimitiveSpatialShardsV1(unit, reader, options);
  const second = await planGlbPrimitiveSpatialShardsV1(unit, reader, options);
  assert.equal(first.shards.length, 4);
  assert.deepEqual(first.shards.map(shard => shard.shardId), second.shards.map(shard => shard.shardId));
  assert.equal(new Set(first.shards.map(shard => shard.shardId)).size, 4);
  assert.equal(first.shards.reduce((sum, shard) => sum + shard.triangleCount, 0), unit.triangleCount);
  assert.ok(first.shards.every(shard => shard.triangleCount <= 2 && shard.estimatedCanonicalBytes <= options.maxCanonicalWindowBytes));

  const producedCentroids = [];
  for (const shard of first.shards) {
    const domain = await canonicalizeGlbPrimitiveSpatialShardV1(unit, first, shard, reader, options.maxSourceWindowBytes);
    assert.equal(domain.materialId, 7);
    assert.notEqual(domain.meshletFlags & WEB_GEOMETRY_MESHLET_MASK, 0);
    assert.notEqual(domain.meshletFlags & WEB_GEOMETRY_MESHLET_TWO_SIDED, 0);
    assert.notEqual(domain.meshletFlags & WEB_GEOMETRY_MESHLET_CASTS_SHADOW, 0);
    assert.equal(domain.generateNormals, false);
    assert.equal(domain.attributeMask, 1 | 2 | 8);
    assert.equal(domain.indices.length / 3, shard.triangleCount);
    for (let triangle = 0; triangle < domain.indices.length / 3; triangle++) {
      const points = [0, 1, 2].map(corner => { const at = domain.indices[triangle * 3 + corner] * 18; return [domain.vertices[at], domain.vertices[at + 1], domain.vertices[at + 2]]; });
      const centroid = [0, 1, 2].map(axis => (points[0][axis] + points[1][axis] + points[2][axis]) / 3);
      producedCentroids.push(`${centroid[0]},${centroid[1]},${centroid[2]}`);
      for (const point of points) for (let axis = 0; axis < 3; axis++) assert.ok(point[axis] >= shard.boundsMin[axis] && point[axis] <= shard.boundsMax[axis]);
    }
  }
  assert.deepEqual(producedCentroids.sort(), centroids.sort());
});

test("spatial canonicalization duplicates a shared boundary vertex with all attributes", async () => {
  const { unit, reader } = sharedBoundaryFixture();
  const options = { maxSourceWindowBytes: 512, maxCanonicalWindowBytes: 1024, sourceIdentityHash: new Uint8Array(32).fill(11), bucketBits: 4, minimumTrianglesPerShard: 1, maximumTrianglesPerShard: 1 };
  const set = await planGlbPrimitiveSpatialShardsV1(unit, reader, options);
  assert.equal(set.shards.length, 2);
  const domains = await Promise.all(set.shards.map(shard => canonicalizeGlbPrimitiveSpatialShardV1(unit, set, shard, reader, options.maxSourceWindowBytes)));
  const shared = domains.map(domain => {
    for (let vertex = 0; vertex < domain.vertices.length / 18; vertex++) {
      const at = vertex * 18;
      if (domain.vertices[at] === 0 && domain.vertices[at + 1] === 0 && domain.vertices[at + 2] === 0) return [domain.vertices[at + 3], domain.vertices[at + 4], domain.vertices[at + 5], domain.vertices[at + 10], domain.vertices[at + 11]];
    }
    return undefined;
  });
  assert.deepEqual(shared, [[0, 0, 1, 0, 0.5], [0, 0, 1, 0, 0.5]], "shared source vertex is present in both independent shard domains");
  assert.ok(domains.every(domain => domain.indices.length === 3));
});

test("spatial materialization scans one primitive once and preserves Morton-rank ownership", async () => {
  const { unit, reader: baseReader } = fixture();
  let indexReads = 0;
  const reader = {
    readRange: async range => {
      if (range.byteOffset === unit.indices.byteOffset) indexReads++;
      return baseReader.readRange(range);
    }
  };
  const options = { maxSourceWindowBytes: 2048, maxCanonicalWindowBytes: 2048, sourceIdentityHash: new Uint8Array(32).fill(13), bucketBits: 4, minimumTrianglesPerShard: 1, maximumTrianglesPerShard: 2 };
  const set = await planGlbPrimitiveSpatialShardsV1(unit, reader, options);
  indexReads = 0;
  const materialized = await materializeGlbPrimitiveSpatialShardsV1(unit, set, reader, options.maxSourceWindowBytes, options.maxSourceWindowBytes);
  assert.equal(materialized.scanPasses, 1);
  assert.equal(materialized.scratchBytes, unit.triangleCount * 3 * 4);
  assert.equal(indexReads, 1, "all shard ownership must come from one index window scan");
  const domains = await Promise.all(set.shards.map((shard, index) => canonicalizeGlbPrimitiveSpatialShardIndicesV1(unit, set, shard, materialized.readShard(index), reader, options.maxSourceWindowBytes)));
  assert.equal(domains.reduce((sum, domain) => sum + domain.indices.length / 3, 0), unit.triangleCount);
  await materialized.dispose();
});

test("external spatial scratch keeps one-pass Morton ownership within the RAM cap and disposes on failure", async () => {
  const { unit, reader } = fixture();
  const options = { maxSourceWindowBytes: 2048, maxCanonicalWindowBytes: 2048, sourceIdentityHash: new Uint8Array(32).fill(17), bucketBits: 1, minimumTrianglesPerShard: 1, maximumTrianglesPerShard: 4 };
  const set = await planGlbPrimitiveSpatialShardsV1(unit, reader, options);
  let disposeCount = 0;
  const createScratch = async bytes => {
    assert.equal(bytes, unit.triangleCount * 12);
    const storage = new Uint8Array(bytes);
    return {
      write(data, at) { storage.set(data, at); },
      read(data, at) { data.set(storage.subarray(at, at + data.byteLength)); },
      flush() {},
      async dispose() { disposeCount++; }
    };
  };
  const materialized = await materializeGlbPrimitiveSpatialShardsV1(unit, set, reader, options.maxSourceWindowBytes, 80, createScratch);
  assert.equal(materialized.backend, "opfs");
  assert.equal(materialized.externalBytes, 96);
  assert.ok(materialized.scratchBytes <= 80);
  assert.equal(materialized.scanPasses, 1);
  for (const [index, shard] of set.shards.entries()) {
    const external = await canonicalizeGlbPrimitiveSpatialShardIndicesV1(unit, set, shard, materialized.readShard(index), reader, options.maxSourceWindowBytes);
    const rescanned = await canonicalizeGlbPrimitiveSpatialShardV1(unit, set, shard, reader, options.maxSourceWindowBytes);
    assert.deepEqual(external.indices, rescanned.indices);
    assert.deepEqual(external.vertices, rescanned.vertices);
  }
  await materialized.dispose();
  await materialized.dispose();
  assert.equal(disposeCount, 1);
  assert.throws(() => materialized.readShard(0), /disposed/);

  let aborted = false;
  await assert.rejects(materializeGlbPrimitiveSpatialShardsV1(unit, set, reader, options.maxSourceWindowBytes, 80, async () => ({
    write() { throw new Error("scratch write failed"); },
    read() {},
    flush() {},
    async dispose() { aborted = true; }
  })), /scratch write failed/);
  assert.equal(aborted, true);
});
