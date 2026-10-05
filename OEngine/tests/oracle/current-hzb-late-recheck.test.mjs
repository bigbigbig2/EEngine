import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const abi = await import("../../.test-dist/render/CurrentHzbLateRecheck.js");
const shader = await import("../../.test-dist/shaders/current_hzb_late_recheck.js");

function hzb() {
  // One HZB texel at reverse-Z 0.8 is a conservative occluder for the
  // candidate whose nearest depth is 0.4.
  return {
    width: 4,
    height: 4,
    levels: [{ width: 4, height: 4, minMax: new Float32Array(4 * 4 * 2).fill(0.8) }],
  };
}

function candidate(slot, flags, depth = 0.4, vertices = 384) {
  return {
    workSlot: slot,
    screenRect: [0.1, 0.1, 0.8, 0.8],
    nearestDepth: depth,
    rasterVertices: vertices,
    flags,
  };
}

test("current HZB late recheck rejects only conservative uncertain/expensive candidates", () => {
  const flags = abi.CURRENT_HZB_LATE_RECHECK_FLAGS;
  const result = abi.recheckCurrentHzbCandidates(
    [candidate(0, flags.Uncertain | flags.Conservative), candidate(1, flags.Expensive), candidate(2, 0)],
    hzb(),
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.retained, 2);
  assert.equal(result.rasterVerticesBefore, 1152);
  assert.equal(result.rasterVerticesAfter, 768);
  assert.equal(result.imageParity, "preserved");
  assert.deepEqual(
    result.records.map((entry) => entry.workSlot),
    [1, 2],
  );
});

test("invalid projection metadata fails open and marks image parity unknown", () => {
  const flags = abi.CURRENT_HZB_LATE_RECHECK_FLAGS;
  const result = abi.recheckCurrentHzbCandidates(
    [{ ...candidate(3, flags.Uncertain | flags.Conservative), screenRect: [0.9, 0.9, 0.1, 1] }],
    hzb(),
  );
  assert.equal(result.invalid, 1);
  assert.equal(result.rejected, 0);
  assert.equal(result.published, true);
  assert.equal(result.imageParity, "unknown");
});

test("late recheck overflow publishes the source queue instead of partial work", () => {
  const flags = abi.CURRENT_HZB_LATE_RECHECK_FLAGS;
  const source = [candidate(0, flags.Uncertain), candidate(1, 0)];
  const result = abi.recheckCurrentHzbCandidates(source, hzb(), 1);
  assert.equal(result.overflow, 1);
  assert.equal(result.published, false);
  assert.equal(result.rejected, 0);
  assert.deepEqual(
    result.records.map((entry) => entry.workSlot),
    [0, 1],
  );
});

test("WGSL keeps current-HZB producer/consumer, bounded reservation, and fail-open guards", () => {
  assert.match(shader.CURRENT_HZB_LATE_RECHECK_WGSL, /current_hzb_late_recheck/u);
  assert.match(shader.CURRENT_HZB_LATE_RECHECK_WGSL, /atomicCompareExchangeWeak/u);
  assert.match(shader.CURRENT_HZB_LATE_RECHECK_WGSL, /recheck_candidate_valid/u);
  assert.match(shader.CURRENT_HZB_LATE_RECHECK_WGSL, /CURRENT_HZB_RECHECK_CONSERVATIVE/u);
  assert.match(shader.CURRENT_HZB_LATE_RECHECK_WGSL, /recheck_output\.header\.overflow_count/u);
  const production = shader.CURRENT_HZB_MESHLET_WORK_LATE_RECHECK_WGSL;
  assert.match(production, /current_source: OEngineMeshletWorkQueueRead/u);
  assert.match(production, /current_output: OEngineMeshletWorkQueue/u);
  assert.match(production, /source_fail_open/u);
  assert.match(production, /current_meshlet_occluded/u);
  assert.match(production, /atomicStore\(&current_draw\.instance_count, written\)/u);
  assert.doesNotMatch(production, /source_invalid[\s\S]*instance_count, select\(written, 0u/u);
  assert.equal(abi.CURRENT_HZB_MESHLET_WORK_MAX_CAPACITY, 0x01000000);
});
