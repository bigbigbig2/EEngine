import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";
import { HIERARCHICAL_WORK_GENERATION_WGSL } from "../.test-dist/shaders/hierarchical_work_generation.js";
import {
  MESHLET_WORK_COMPACTION_PORTABLE_WGSL,
  MESHLET_WORK_COMPACTION_SUBGROUP_WGSL
} from "../.test-dist/shaders/meshlet_work_compaction.js";
import { MESHLET_BUCKET_VISIBILITY_WGSL } from "../.test-dist/shaders/meshlet_bucket_visibility.js";
import {
  GPU_MESHLET_BUCKET_COUNT,
  GPU_MESHLET_RASTER_WORK_ABI_VERSION,
  GPU_MESHLET_RASTER_WORK_OFFSETS,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_CLASS,
  GPU_MESHLET_WORK_QUEUE_HEADER_OFFSETS,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  classifyGpuMeshletBucket,
  gpuMeshletWorkQueueByteLength,
  nextGpuMeshletWorkGeneration,
  packGpuMeshletProfileLod,
  packGpuMeshletProfileLodBucket,
  packGpuMeshletRasterWork,
  packGpuMeshletWorkQueueHeader,
  reserveGpuMeshletWork,
  unpackGpuMeshletProfileLod,
  unpackGpuMeshletRasterWork,
  unpackGpuMeshletWorkQueueHeader
} from "../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_VISIBILITY_KEY_ABI_VERSION,
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE,
  GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK,
  decodeVisibilityKey,
  encodeVisibilityKey,
  isVisibilityKeyContextValid,
  resolveVisibilityKeyReference,
  tryEncodeVisibilityKey
} from "../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET,
  largeTriangleSetupIndex
} from "../.test-dist/gpu/GpuLargeTriangleSetupAbi.js";
import { LARGE_TRIANGLE_SETUP_WGSL } from "../.test-dist/shaders/large_triangle_setup.js";
import {
  GEOMETRY_DIRECTORY_FLAGS,
  geometryVisibilityPathFlag,
  geometryVisibilityPathFromFlags,
  recommendGeometryVisibilityPath
} from "../.test-dist/assets/GeometryAssetPackage.js";
import {
  GeometryAdaptiveSseController,
  normalizeGeometryWorkBudget
} from "../.test-dist/render/GeometryWorkBudget.js";
globalThis.GPUShaderStage = Object.freeze({ COMPUTE: 4 });
const { VISIBILITY_COUNTER_WGSL } = await import(
  "../.test-dist/render/passes/VisibilityCounterPass.js"
);
const { PACKED_MATERIAL_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/packed_material_resolve.js"
);
const { PACKED_MATERIAL_CLASS_DEPTH_WGSL } = await import(
  "../.test-dist/shaders/packed_material_class_depth.js"
);
const { PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/render_debug_view.js"
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
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 18);
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
    packedProfileLod: packGpuMeshletProfileLodBucket(0xff, 0xff, 0xff, 0xff)
  };
  assert.deepEqual(unpackGpuMeshletRasterWork(packGpuMeshletRasterWork(boundary)), boundary);
  assert.deepEqual(unpackGpuMeshletProfileLod(boundary.packedProfileLod), {
    decodeProfile: 0xff,
    lod: 0xff,
    bucketKey: 0xff,
    partition: 0xff
  });
  assert.deepEqual(unpackGpuMeshletProfileLod(packGpuMeshletProfileLod(1, 2)), {
    decodeProfile: 1,
    lod: 2,
    bucketKey: 0,
    partition: 0
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
    "geometryRiskyTriangles",
    "geometryExactSurvivedTriangles",
    "geometryRasterTriangles",
    "geometryPaddedVertices"
  ]) {
    assert.match(
      MESHLET_WORK_COMPACTION_SUBGROUP_WGSL,
      new RegExp(`${counterByteOffset(name) / 4}u`)
    );
  }
  assert.match(
    VISIBILITY_COUNTER_WGSL,
    new RegExp(`${counterByteOffset("geometryVisiblePixels") / 4}u`)
  );
});

test("Step-4 production shaders reserve only the selective risk seam", () => {
  for (const name of ["geometryRiskyTriangles"]) {
    const index = counterByteOffset(name) / 4;
    assert.ok(Number.isInteger(index));
    assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, new RegExp(`\\[${index}u\\]`));
  }
});

test("Step-5 selective risk route is exclusive and LargeTriangleSetup uses V2 dense identity", () => {
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /classify_meshlet_projection_risk/);
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /SelectiveExact|1073741824u/);
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /route_bucket/);
  assert.equal(GPU_LARGE_TRIANGLE_SETUP_TRIANGLES_PER_MESHLET, 128);
  assert.equal(largeTriangleSetupIndex(7, 31), 7 * 128 + 31);
  assert.throws(() => largeTriangleSetupIndex(0, 128), /\[0, 127\]/);
  assert.match(LARGE_TRIANGLE_SETUP_WGSL, /work_slot = linear \/ 128u/);
  assert.match(LARGE_TRIANGLE_SETUP_WGSL,
    new RegExp(`${counterByteOffset("setupOverflow") / 4}u`));
});

test("Step-6 cooker hint selects Flat/Shallow/Full and GPU traversal consumes it locally", () => {
  assert.equal(recommendGeometryVisibilityPath(4, 0, false), "flat");
  assert.equal(recommendGeometryVisibilityPath(48, 5, true), "shallow");
  assert.equal(recommendGeometryVisibilityPath(256, 2, true), "shallow");
  assert.equal(recommendGeometryVisibilityPath(256, 5, true), "full");
  for (const path of ["flat", "shallow", "full"]) {
    assert.equal(geometryVisibilityPathFromFlags(geometryVisibilityPathFlag(path)), path);
  }
  assert.throws(
    () => geometryVisibilityPathFromFlags(
      GEOMETRY_DIRECTORY_FLAGS.VisibilityFlat |
      GEOMETRY_DIRECTORY_FLAGS.VisibilityFull
    ),
    /multiple visibility path hints/
  );
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /hierarchy_refinement_allowed/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /R3_GEOMETRY_VISIBILITY_SHALLOW/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /cluster\.depth < 2u/);
});

test("Step-6 GeometryWorkBudget adaptive SSE has a dead zone, slow recovery and camera-cut reset", () => {
  const budget = normalizeGeometryWorkBudget({
    maxTestedHierarchyNodes: 100,
    targetMeshletWork: 100,
    maxMeshletWork: 200,
    targetRasterVertices: 300,
    maxRasterVertices: 600,
    maxRiskyTriangles: 10,
    maxSetupBytes: 4096
  });
  const controller = new GeometryAdaptiveSseController(4, budget, {
    deadZone: 0.1,
    overloadGain: 0.5,
    recoveryRate: 0.05,
    qualityFloorSse: 8
  });
  const withinDeadZone = {
    testedHierarchyNodes: 90,
    meshletWork: 105,
    rasterVertices: 300,
    riskyTriangles: 0
  };
  assert.equal(controller.update(withinDeadZone), 4);
  assert.equal(controller.update({ ...withinDeadZone, meshletWork: 150 }), 5);
  const recovered = controller.update({
    testedHierarchyNodes: 1,
    meshletWork: 1,
    rasterVertices: 3,
    riskyTriangles: 0
  });
  assert.ok(recovered > 4 && recovered < 5, "recovery must be gradual");
  assert.equal(controller.resetForCameraCut(), 4);
});

test("VisibilityKey V2 freezes logical identity and external lifetime context", () => {
  assert.equal(GPU_VISIBILITY_KEY_ABI_VERSION, 4);
  const key = encodeVisibilityKey(GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK, 127);
  assert.deepEqual(decodeVisibilityKey(key), {
    kind: "valid",
    meshletWorkSlot: GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK,
    localPrimitive: 127
  });
  assert.equal(decodeVisibilityKey(GPU_VISIBILITY_KEY_EMPTY).kind, "empty");
  assert.equal(decodeVisibilityKey(GPU_VISIBILITY_KEY_INVALID).kind, "invalid");
  assert.equal(tryEncodeVisibilityKey(0, GPU_VISIBILITY_KEY_MAX_LOCAL_PRIMITIVE + 1).valid, false);
  assert.equal(isVisibilityKeyContextValid(7, 7, 0), true);
  assert.equal(isVisibilityKeyContextValid(0, 0, 0), false);
  assert.equal(isVisibilityKeyContextValid(7, 8, 0), false);
  assert.equal(isVisibilityKeyContextValid(7, 7, 1), false);
  const work = {
    instanceSlot: 2,
    geometrySlot: 3,
    meshletSlot: 5,
    materialSlotOrRange: 7,
    packedRasterFlags: 0,
    packedProfileLod: 0
  };
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(0, 12), [work],
      { partition: 0, generation: 9 }, { partition: 0, generation: 9 }).kind,
    "valid"
  );
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(0, 12), [work],
      { partition: 0, generation: 9 }, { partition: 0, generation: 10 }).reason,
    "generation-mismatch"
  );
});

test("VisibilityKey V2 material and debug consumers dereference MeshletWork only", () => {
  for (const source of [
    PACKED_MATERIAL_RESOLVE_WGSL,
    PACKED_MATERIAL_CLASS_DEPTH_WGSL,
    PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL
  ]) {
    assert.match(source, /OEngineMeshletWorkQueueRead/);
    assert.match(source, /meshlet_work_slot|meshletWorkSlot/);
    assert.doesNotMatch(source, /ExactRasterWork|raster_work_slot/);
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
    for (const source of [
      MESHLET_WORK_COMPACTION_PORTABLE_WGSL,
      MESHLET_WORK_COMPACTION_SUBGROUP_WGSL
    ]) assert.match(source, new RegExp(`${counterByteOffset(name) / 4}u`));
  }
});

test("Step-2 bucket key is bounded and distinguishes all four raster dimensions", () => {
  assert.equal(GPU_MESHLET_BUCKET_COUNT, 32);
  const keys = new Set();
  for (const triangles of [32, 64, 96, 128]) {
    for (const profile of [1, 2]) {
      for (const doubleSided of [false, true]) {
        for (const mask of [false, true]) {
          const flags = (doubleSided ? 16 : 0) | (mask ? 8 : 0);
          const classification = classifyGpuMeshletBucket(triangles, profile, flags);
          assert.equal(classification.triangleCapacity, triangles);
          keys.add(classification.key);
        }
      }
    }
  }
  assert.equal(keys.size, GPU_MESHLET_BUCKET_COUNT);
  assert.throws(() => classifyGpuMeshletBucket(129, 1, 0), /128-triangle/);
});

test("Step-2 shaders contain distinct subgroup and portable compaction algorithms", () => {
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /enable subgroups/);
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /subgroupBallot/);
  assert.match(MESHLET_WORK_COMPACTION_SUBGROUP_WGSL, /subgroupBroadcastFirst/);
  assert.doesNotMatch(MESHLET_WORK_COMPACTION_PORTABLE_WGSL, /enable subgroups/);
  assert.match(MESHLET_WORK_COMPACTION_PORTABLE_WGSL, /candidate_prefix\[lane\]/);
  for (const source of [
    MESHLET_WORK_COMPACTION_PORTABLE_WGSL,
    MESHLET_WORK_COMPACTION_SUBGROUP_WGSL
  ]) {
    assert.match(source, /finalize_meshlet_work_buckets/);
    assert.match(source, /scatter_meshlet_work_buckets/);
    assert.match(source, /OEngineDrawIndirectArgs/);
  }
});

test("Step-7 bucket raster is the sole standard indirect VisibilityKey V2 consumer", () => {
  const source = readFileSync(new URL("../src/render/MeshletBucketRaster.ts", import.meta.url), "utf8");
  assert.match(source, /for \(let bucket = 0; bucket < inputs\.prepared\.bucketCount; bucket\+\+\)/);
  assert.match(source, /drawIndirect\(inputs\.prepared\.drawIndirect, bucket \* 16\)/);
  assert.match(source, /depthCompare: "greater"/);
  assert.match(source, /cullMode: doubleSided \? "none" : "back"/);
  assert.doesNotMatch(source, /MAP_READ|mapAsync|getMappedRange/);
  assert.match(MESHLET_BUCKET_VISIBILITY_WGSL, /@builtin\(instance_index\)/);
  assert.match(MESHLET_BUCKET_VISIBILITY_WGSL, /triangle < meshlet\.triangle_count/);
  assert.doesNotMatch(source, /ExactTriangleFilter|encodeParity|legacy/);
  const visibility = readFileSync(new URL("../src/render/passes/PackedVisibilityPass.ts", import.meta.url), "utf8");
  assert.match(visibility, /rasterExpansionEnabled: false/);
  assert.doesNotMatch(visibility, /ExactRaster|exactRaster|RasterWorkQueue|packed_visibility/);
  for (const path of [
    "../src/render/ExactTriangleFilter.ts",
    "../src/shaders/exact_triangle_filter.ts",
    "../src/shaders/packed_visibility.ts",
    "../src/gpu/GpuExactRasterAbi.ts"
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must be deleted`);
  }
});
