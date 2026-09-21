import assert from "node:assert/strict";
import test from "node:test";

const { estimateCanonicalBytes, planCanonicalWindows } = await import("../../.test-dist/assets/web-cook/CanonicalWindowPlanner.js");

function primitive(index, triangles = 100_000, sourceBytes = 2 * 1024 * 1024) {
  const range = { bufferIndex: 0, byteOffset: index * sourceBytes, byteLength: sourceBytes };
  return {
    nodeIndex: index, instanceNodeIndices: [index], meshIndex: index, primitiveIndex: 0,
    materialIndex: 0, mode: 4, vertexCount: 65_536, triangleCount: triangles,
    attributes: {}, material: {}, ranges: [range],
    indices: { ...range, count: triangles * 3 }
  };
}

test("canonical windows are deterministic and stay inside both live budgets", () => {
  const units = Array.from({ length: 25 }, (_, index) => primitive(index));
  const sourceBudget = 16 * 1024 * 1024, canonicalBudget = 64 * 1024 * 1024;
  const first = planCanonicalWindows(units, sourceBudget, canonicalBudget);
  const second = planCanonicalWindows(units, sourceBudget, canonicalBudget);
  assert.deepEqual(first.map(window => window.units.map(unit => unit.meshIndex)), second.map(window => window.units.map(unit => unit.meshIndex)));
  assert.ok(first.length > 1);
  for (const window of first) {
    assert.ok(window.sourceBytes <= sourceBudget);
    assert.ok(window.canonicalBytes <= canonicalBudget);
  }
});

test("100M to 250M triangles grows window count, not canonical peak", () => {
  const sourceBudget = 16 * 1024 * 1024, canonicalBudget = 64 * 1024 * 1024;
  const hundredMillion = planCanonicalWindows(Array.from({ length: 1_000 }, (_, index) => primitive(index)), sourceBudget, canonicalBudget);
  const twoHundredFiftyMillion = planCanonicalWindows(Array.from({ length: 2_500 }, (_, index) => primitive(index)), sourceBudget, canonicalBudget);
  const peak = windows => Math.max(...windows.map(window => window.canonicalBytes));
  assert.equal(peak(hundredMillion), peak(twoHundredFiftyMillion));
  assert.ok(twoHundredFiftyMillion.length > hundredMillion.length);
  assert.ok(peak(twoHundredFiftyMillion) <= canonicalBudget);
});

test("whole-primitive planner requires spatial expansion for an oversized unit", () => {
  const giant = primitive(0, 32_000_000, 32 * 1024 * 1024);
  assert.ok(estimateCanonicalBytes([giant]) > 64 * 1024 * 1024);
  assert.throws(() => planCanonicalWindows([giant], 64 * 1024 * 1024, 64 * 1024 * 1024), /spatial expansion is required/u);
});
