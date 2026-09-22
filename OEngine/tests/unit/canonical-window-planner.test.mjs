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

function budget(maxSourceBytes = 16 * 1024 * 1024, maxCanonicalBytes = 64 * 1024 * 1024) {
  return { maxSourceBytes, maxCanonicalBytes, maxTriangles: 128 * 1024, maxVertices: 512 * 1024, maxDomains: 64 };
}

test("canonical windows are deterministic and stay inside both live budgets", () => {
  const units = Array.from({ length: 25 }, (_, index) => primitive(index));
  const sourceBudget = 16 * 1024 * 1024, canonicalBudget = 64 * 1024 * 1024;
  const first = planCanonicalWindows(units, budget(sourceBudget, canonicalBudget));
  const second = planCanonicalWindows(units, budget(sourceBudget, canonicalBudget));
  assert.deepEqual(first.map(window => window.units.map(unit => unit.meshIndex)), second.map(window => window.units.map(unit => unit.meshIndex)));
  assert.ok(first.length > 1);
  for (const window of first) {
    assert.ok(window.sourceBytes <= sourceBudget);
    assert.ok(window.canonicalBytes <= canonicalBudget);
    assert.ok(window.triangleCount <= 128 * 1024);
    assert.ok(window.vertexCount <= 512 * 1024);
    assert.ok(window.domainCount <= 64);
  }
});

test("100M to 250M triangles grows window count, not canonical peak", () => {
  const sourceBudget = 16 * 1024 * 1024, canonicalBudget = 64 * 1024 * 1024;
  const hundredMillion = planCanonicalWindows(Array.from({ length: 1_000 }, (_, index) => primitive(index)), budget(sourceBudget, canonicalBudget));
  const twoHundredFiftyMillion = planCanonicalWindows(Array.from({ length: 2_500 }, (_, index) => primitive(index)), budget(sourceBudget, canonicalBudget));
  const peak = windows => Math.max(...windows.map(window => window.canonicalBytes));
  assert.equal(peak(hundredMillion), peak(twoHundredFiftyMillion));
  assert.ok(twoHundredFiftyMillion.length > hundredMillion.length);
  assert.ok(peak(twoHundredFiftyMillion) <= canonicalBudget);
});

test("whole-primitive planner requires spatial expansion for an oversized unit", () => {
  const giant = primitive(0, 32_000_000, 32 * 1024 * 1024);
  assert.ok(estimateCanonicalBytes([giant]) > 64 * 1024 * 1024);
  assert.throws(() => planCanonicalWindows([giant], budget(64 * 1024 * 1024, 64 * 1024 * 1024)), /spatial expansion is required/u);
});

test("triangle work triggers spatial expansion even when canonical bytes fit", () => {
  const highlyIndexed = primitive(0, 1_364_306, 8 * 1024 * 1024);
  assert.ok(estimateCanonicalBytes([highlyIndexed]) < 64 * 1024 * 1024);
  assert.throws(() => planCanonicalWindows([highlyIndexed], budget(64 * 1024 * 1024, 64 * 1024 * 1024)), /triangles=1364306/u);
});
