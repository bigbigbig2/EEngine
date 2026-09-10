import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";
import { EXACT_TRIANGLE_FILTER_WGSL } from "../.test-dist/shaders/exact_triangle_filter.js";
import { HIERARCHICAL_WORK_GENERATION_WGSL } from "../.test-dist/shaders/hierarchical_work_generation.js";
import { MESHLET_WORK_CANDIDATE_WGSL } from "../.test-dist/shaders/meshlet_work_candidate.js";
import {
  GPU_MESHLET_RASTER_WORK_ABI_VERSION,
  GPU_MESHLET_RASTER_WORK_OFFSETS,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_CLASS,
  GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  gpuMeshletWorkQueueByteLength,
  nextGpuMeshletWorkGeneration,
  packGpuMeshletProfileLod,
  packGpuMeshletRasterWork,
  packGpuMeshletWorkQueueHeader,
  reserveGpuMeshletWork,
  unpackGpuMeshletProfileLod,
  unpackGpuMeshletRasterWork,
  unpackGpuMeshletWorkQueueHeader
} from "../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
globalThis.GPUShaderStage = Object.freeze({ COMPUTE: 4 });
const { VISIBILITY_COUNTER_WGSL } = await import(
  "../.test-dist/render/passes/VisibilityCounterPass.js"
);

const GEOMETRY_TRUTH_FIELDS = [
  "geometryNodesTested",
  "geometryClustersAccepted",
  "geometryMeshletsSelected",
  "geometryMeshletWorksProduced",
  "geometryCandidateTriangles",
  "geometryRiskyTriangles",
  "geometryExactSurvivedTriangles",
  "geometryRasterTriangles",
  "geometryPaddedVertices",
  "geometryVisiblePixels",
  "geometryQueueBytes"
];

test("ADR-0008 Step 0 freezes a collision-free geometry truth counter ABI", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 15);
  const indices = GPU_COUNTER_FIELDS.map((field) => field.index);
  assert.equal(new Set(indices).size, indices.length);
  for (const name of GEOMETRY_TRUTH_FIELDS) {
    const field = GPU_COUNTER_FIELDS.find((candidate) => candidate.name === name);
    assert.ok(field, `missing ${name}`);
    assert.ok(counterByteOffset(name) + 4 <= GPU_COUNTER_BYTE_SIZE);
  }
});

test("MeshletRasterWork CPU/WGSL ABI freezes six aligned u32 identity fields", () => {
  assert.equal(GPU_MESHLET_RASTER_WORK_ABI_VERSION, 1);
  assert.equal(GPU_MESHLET_RASTER_WORK_RECORD_STRIDE, 24);
  assert.deepEqual(GPU_MESHLET_RASTER_WORK_OFFSETS, {
    instanceSlot: 0,
    geometrySlot: 4,
    meshletSlot: 8,
    materialSlotOrRange: 12,
    packedRasterFlags: 16,
    packedProfileLod: 20
  });
  const boundary = {
    instanceSlot: 0,
    geometrySlot: 0xffffffff,
    meshletSlot: 17,
    materialSlotOrRange: 0xfffffffe,
    packedRasterFlags: 0x80000001,
    packedProfileLod: packGpuMeshletProfileLod(0xff, 0xff)
  };
  assert.deepEqual(unpackGpuMeshletRasterWork(packGpuMeshletRasterWork(boundary)), boundary);
  assert.deepEqual(unpackGpuMeshletProfileLod(boundary.packedProfileLod), {
    decodeProfile: 0xff,
    lod: 0xff
  });
  assert.throws(() => packGpuMeshletProfileLod(0x100, 0), /8 bits/);
});

test("MeshletWork correctness-critical queue header and reservation oracle are all-or-nothing", () => {
  assert.equal(GPU_MESHLET_WORK_QUEUE_CLASS, "CorrectnessCritical");
  assert.equal(GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE, 32);
  assert.deepEqual(GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS, {
    attemptedCount: 0,
    writtenCount: 4,
    consumedCount: 8,
    capacity: 12,
    overflowCount: 16,
    generation: 20,
    invalidCount: 24,
    reserved: 28
  });
  const initial = {
    attemptedCount: 0,
    writtenCount: 0,
    consumedCount: 0,
    capacity: 3,
    overflowCount: 0,
    generation: 1,
    invalidCount: 0
  };
  assert.deepEqual(unpackGpuMeshletWorkQueueHeader(packGpuMeshletWorkQueueHeader(initial)), initial);
  const first = reserveGpuMeshletWork(initial, 2);
  assert.equal(first.offset, 0);
  assert.equal(first.header.writtenCount, 2);
  const overflow = reserveGpuMeshletWork(first.header, 2);
  assert.equal(overflow.offset, null);
  assert.deepEqual(overflow.header, {
    ...initial,
    attemptedCount: 4,
    writtenCount: 2,
    overflowCount: 2
  });
  assert.equal(gpuMeshletWorkQueueByteLength(3), 32 + 3 * 24);
  assert.equal(nextGpuMeshletWorkGeneration(0xffffffff), 1);
  assert.throws(
    () => packGpuMeshletWorkQueueHeader({ ...initial, overflowCount: 1 }),
    /attempted minus written/
  );
});

test("Step-1 MeshletWork seam has no CPU queue readback consumer", () => {
  const source = readFileSync(new URL("../src/render/MeshletWorkCandidate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /MAP_READ|mapAsync|getMappedRange|copyBufferToBuffer/);
  assert.match(source, /dispatchWorkgroupsIndirect/);
});

test("geometry truth fields are written by their production GPU stages", () => {
  for (const name of [
    "geometryNodesTested",
    "geometryClustersAccepted",
    "geometryMeshletsSelected",
    "geometryQueueBytes"
  ]) {
    assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, new RegExp(`${counterByteOffset(name) / 4}u`));
  }
  for (const name of [
    "geometryCandidateTriangles",
    "geometryExactSurvivedTriangles",
    "geometryRasterTriangles",
    "geometryQueueBytes"
  ]) {
    assert.match(EXACT_TRIANGLE_FILTER_WGSL, new RegExp(`${counterByteOffset(name) / 4}u`));
  }
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`${counterByteOffset("geometryVisiblePixels") / 4}u`)
  );
});

test("pre-cutover production shaders explicitly reserve zero-valued risk and padding seams", () => {
  for (const name of [
    "geometryRiskyTriangles",
    "geometryPaddedVertices"
  ]) {
    const index = counterByteOffset(name) / 4;
    assert.ok(Number.isInteger(index));
    assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, new RegExp(`\\[${index}u\\]`));
    assert.doesNotMatch(EXACT_TRIANGLE_FILTER_WGSL, new RegExp(`\\[${index}u\\]`));
  }
});

test("MeshletWork candidate publishes attempted/written/consumed/overflow/invalid closure", () => {
  for (const name of [
    "geometryMeshletWorksProduced",
    "meshletQueueAttempted",
    "meshletQueueWritten",
    "meshletQueueConsumed",
    "meshletQueueOverflow",
    "meshletQueueInvalid"
  ]) {
    assert.match(
      MESHLET_WORK_CANDIDATE_WGSL,
      new RegExp(`${counterByteOffset(name) / 4}u`)
    );
  }
});
