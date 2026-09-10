import assert from "node:assert/strict";
import test from "node:test";

import {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  counterByteOffset
} from "../.test-dist/debug/GpuFrameCounters.js";
import { EXACT_TRIANGLE_FILTER_WGSL } from "../.test-dist/shaders/exact_triangle_filter.js";
import { HIERARCHICAL_WORK_GENERATION_WGSL } from "../.test-dist/shaders/hierarchical_work_generation.js";
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
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 14);
  const indices = GPU_COUNTER_FIELDS.map((field) => field.index);
  assert.equal(new Set(indices).size, indices.length);
  for (const name of GEOMETRY_TRUTH_FIELDS) {
    const field = GPU_COUNTER_FIELDS.find((candidate) => candidate.name === name);
    assert.ok(field, `missing ${name}`);
    assert.ok(counterByteOffset(name) + 4 <= GPU_COUNTER_BYTE_SIZE);
  }
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

test("pre-cutover counters explicitly reserve zero-valued future seams", () => {
  for (const name of [
    "geometryMeshletWorksProduced",
    "geometryRiskyTriangles",
    "geometryPaddedVertices"
  ]) {
    const index = counterByteOffset(name) / 4;
    assert.ok(Number.isInteger(index));
    assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, new RegExp(`\\[${index}u\\]`));
    assert.doesNotMatch(EXACT_TRIANGLE_FILTER_WGSL, new RegExp(`\\[${index}u\\]`));
  }
});
