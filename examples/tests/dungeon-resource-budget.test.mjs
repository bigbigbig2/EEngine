import assert from "node:assert/strict";
import test from "node:test";
import { dungeonResourceBudget, DUNGEON_4GB_RESOURCE_BUDGET } from "../integrated/dungeon-warkarma-texture-compression/resource-budget.ts";

test("explicit 4GB target partitions a 2GB API envelope and preserves metadata", () => {
  const plan = dungeonResourceBudget(null);
  assert.equal(plan, DUNGEON_4GB_RESOURCE_BUDGET);
  assert.equal(plan.geometryCapacityBytes, 512 * 1024 ** 2);
  assert.equal(plan.metadataBytes, 128 * 1024 ** 2);
  assert.equal(plan.geometryCapacityBytes + plan.metadataBytes + plan.nonGeometryReserveBytes, plan.apiEnvelopeBytes);
  assert.ok(plan.apiEnvelopeBytes < plan.targetDeviceBytes);
});

test("capacity overrides are labelled custom and invalid input cannot silently select another budget", () => {
  for (const value of ["128", "512", "1536", "2048"]) {
    const plan = dungeonResourceBudget(value);
    assert.equal(plan.geometryCapacityBytes, Number(value) * 1024 ** 2);
    assert.equal(plan.profile, "explicit-geometry-budget");
  }
  for (const value of ["", "0", "127", "2049", "512.5", "NaN", "Infinity"]) {
    assert.throws(() => dungeonResourceBudget(value), RangeError);
  }
});
