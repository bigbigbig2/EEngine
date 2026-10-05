import test from "node:test";
import assert from "node:assert/strict";
import {
  planSurfaceOptimizationCapacity,
  surfaceOptimizationBatchRange,
  SURFACE_OPTIMIZATION_DEFAULT_PROFILE,
  SURFACE_OPTIMIZATION_BUDGET_MIB,
} from "../../.test-dist/gpu/SurfaceOptimizationCapacity.js";
import { surfaceCellWorkspaceLayout } from "../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandLayout } from "../../.test-dist/gpu/GpuSurfaceDemandAbi.js";
import { surfaceCoverageLayout } from "../../.test-dist/gpu/GpuSurfaceCoverageAbi.js";
import { planSurfaceCellGeometryCapacity } from "../../.test-dist/gpu/GpuSurfaceCellGeometryAbi.js";

const limits = {
  maxBufferSize: 1024 ** 3,
  maxStorageBufferBindingSize: 128 * 1024 ** 2,
  maxTextureDimension2D: 8192,
};
test("1080p complete disjoint batches include certificates and worst-case HDR/request bytes", () => {
  const plan = planSurfaceOptimizationCapacity(1920, 1080, limits);
  assert.equal(
    Object.values(SURFACE_OPTIMIZATION_BUDGET_MIB).reduce((sum, mib) => sum + mib, 0),
    512,
    "Demand and refs share one budget; retirement is headroom rather than another payload pool",
  );
  assert.equal(plan.pixelCount, 2073600);
  assert.equal(plan.tileCount, 32400);
  assert.ok(plan.productionAllocations.signalValues <= 32 * 1024 ** 2);
  assert.equal(plan.productionAllocations.geometryHot, plan.batchTargetCapacity * 128);
  assert.equal(plan.productionAllocations.geometryCold, plan.batchTargetCapacity * 528);
  assert.ok(
    plan.batchTargetCapacity * SURFACE_OPTIMIZATION_DEFAULT_PROFILE.fieldBytesPerTarget <= 32 * 1024 ** 2,
  );
  assert.ok(
    plan.batchTargetCapacity * SURFACE_OPTIMIZATION_DEFAULT_PROFILE.addressBytesPerTarget <= 32 * 1024 ** 2,
  );
  assert.ok(plan.productionAllocations.demand <= 64 * 1024 ** 2);
  assert.ok(plan.reservedBytes <= 512 * 1024 ** 2);
  assert.ok(surfaceCellWorkspaceLayout(plan.batchTileCapacity).bytes <= limits.maxStorageBufferBindingSize);
  let last = 0;
  for (let batch = 0; batch < plan.batchCount; batch++) {
    const range = surfaceOptimizationBatchRange(plan, batch);
    assert.equal(range.firstTile, last);
    assert.ok(range.paddedTargetCapacity <= plan.batchTargetCapacity);
    last += range.tileCount;
  }
  assert.equal(last, 32400);
  assert.ok(surfaceOptimizationBatchRange(plan, plan.batchCount - 1).tileCount <= plan.batchTileCapacity);
});
test("a wider cold profile reduces batch size without truncating target coverage", () => {
  const plan = planSurfaceOptimizationCapacity(1920, 1080, limits, {
    ...SURFACE_OPTIMIZATION_DEFAULT_PROFILE,
    geometryColdBytesPerTarget: 1024,
  });
  assert.ok(plan.scratchBytes.geometryCold <= 48 * 1024 ** 2);
  assert.ok(
    plan.batchTargetCapacity <= planSurfaceOptimizationCapacity(1920, 1080, limits).batchTargetCapacity,
  );
});
test("lower binding limits segment persistent pools and reduce scratch before allocation", () => {
  const reduced = { ...limits, maxStorageBufferBindingSize: 2 * 1024 ** 2 };
  const plan = planSurfaceOptimizationCapacity(1920, 1080, reduced);
  assert.ok(plan.productionAllocations.signalValues <= 2 * 1024 ** 2);
  assert.ok(surfaceCellWorkspaceLayout(plan.batchTileCapacity).bytes <= reduced.maxStorageBufferBindingSize);
  for (const bytes of Object.values(plan.scratchBytes))
    assert.ok(bytes <= reduced.maxStorageBufferBindingSize);
  for (const segments of Object.values(plan.persistentSegments)) {
    for (const bytes of segments) assert.ok(bytes <= reduced.maxStorageBufferBindingSize);
  }
  assert.equal(
    plan.persistentSegments.fieldStore.reduce((a, b) => a + b, 0),
    128 * 1024 ** 2,
  );
});
test("NPOT targets reserve padded tile slots and cover partial edge tiles once", () => {
  const plan = planSurfaceOptimizationCapacity(17, 9, limits);
  assert.equal(plan.pixelCount, 153);
  assert.equal(plan.tileCount, 6);
  assert.equal(surfaceOptimizationBatchRange(plan, 0).paddedTargetCapacity, 384);
});
test("physical ledger includes each current ABI allocation and in-flight overlap once", () => {
  const plan = planSurfaceOptimizationCapacity(1920, 1080, limits);
  const r = plan.batchTargetCapacity;
  const workspace = surfaceCellWorkspaceLayout(plan.batchTileCapacity);
  const setup = planSurfaceCellGeometryCapacity(r, r * 1280, limits);
  const independent = {
    workspace: workspace.bytes,
    geometrySetup: setup.setupBytes + setup.referenceBytes + setup.memoBytes + 512,
    geometryHot: r * 128,
    geometryCold: r * 528,
    fieldValues: r * 15 * 16,
    signalValues: r * 6 * 16,
    demand: surfaceDemandLayout(r, 256).bytes,
    demandIndirect: 512 + 256 * 32,
    proofIndirect: 7 * 16,
    controlAndSettings: 65536,
    coverage: surfaceCoverageLayout(32400).bytes,
    activeRange: 32,
    dependencyOwners: 256 * 15 * 4,
  };
  assert.deepEqual(plan.productionAllocations, independent);
  const total = Object.values(independent).reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(plan.ledger.scratchBytes, total);
  assert.equal(plan.physicalPoolBytes.scratch, total);
  assert.equal(plan.ledger.retiredOverlapBytes, total);
  assert.equal(plan.reservedBytes, total * 2 + (224 + 48) * 1024 ** 2);
  assert.equal(plan.ledger.payloadBytes + plan.ledger.metadataBytes + plan.ledger.queueBytes, total);
  assert.equal(
    plan.physicalPoolBytes.addressProof,
    workspace.fieldReferences - workspace.proofResults + workspace.bytes - workspace.proofs,
  );
  assert.ok(plan.limitingPools.length > 0);
  assert.equal(
    plan.physicalPoolBytes.demandAndRefs,
    plan.physicalPoolBytes.refs + independent.demand + independent.proofIndirect,
  );
  for (const [category, mib] of [
    ["plans", 8],
    ["addressProof", 32],
    ["setup", 48],
    ["geometryHot", 8],
    ["geometryCold", 48],
    ["fields", 16],
    ["signals", 8],
    ["demandAndRefs", 32],
  ]) {
    assert.ok(plan.physicalPoolBytes[category] <= mib * 1024 ** 2, category);
  }
  const larger = planSurfaceOptimizationCapacity(1920, 1080, limits, {
    ...SURFACE_OPTIMIZATION_DEFAULT_PROFILE,
    geometryColdBytesPerTarget: 1024,
  });
  assert.equal(larger.productionAllocations.geometryCold, larger.batchTargetCapacity * 1024);
});
test("invalid extents, strides, tiny buffers and impossible outputs reject before allocation", () => {
  assert.throws(() => planSurfaceOptimizationCapacity(0, 1080, limits), RangeError);
  assert.throws(() => planSurfaceOptimizationCapacity(1920, NaN, limits), RangeError);
  assert.throws(
    () =>
      planSurfaceOptimizationCapacity(1920, 1080, limits, {
        ...SURFACE_OPTIMIZATION_DEFAULT_PROFILE,
        fieldBytesPerTarget: 95,
      }),
    RangeError,
  );
  assert.throws(
    () => planSurfaceOptimizationCapacity(1920, 1080, { ...limits, maxBufferSize: 256 }),
    RangeError,
  );
  assert.throws(() => planSurfaceOptimizationCapacity(3840, 2160, limits), RangeError);
  const plan = planSurfaceOptimizationCapacity(1, 1, limits);
  assert.throws(() => surfaceOptimizationBatchRange(plan, -1), RangeError);
  assert.throws(() => surfaceOptimizationBatchRange(plan, plan.batchCount), RangeError);
});
