import test from 'node:test';
import assert from 'node:assert/strict';
import { planSurfaceOptimizationCapacity, surfaceOptimizationBatchRange,
  SURFACE_OPTIMIZATION_DEFAULT_PROFILE } from '../../.test-dist/gpu/SurfaceOptimizationCapacity.js';
import {surfaceCellWorkspaceLayout} from '../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js';

const limits = { maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 128 * 1024 ** 2, maxTextureDimension2D: 8192 };
test('1080p complete disjoint batches include certificates and worst-case HDR/request bytes', () => {
  const plan = planSurfaceOptimizationCapacity(1920, 1080, limits);
  assert.equal(plan.pixelCount, 2073600);
  assert.equal(plan.tileCount, 32400);
  assert.ok(plan.productionAllocations.signalValues<=32*1024**2);
  assert.ok(plan.batchTargetCapacity*SURFACE_OPTIMIZATION_DEFAULT_PROFILE.fieldBytesPerTarget<=32*1024**2);
  assert.ok(plan.batchTargetCapacity*SURFACE_OPTIMIZATION_DEFAULT_PROFILE.addressBytesPerTarget<=32*1024**2);
  assert.ok(plan.productionAllocations.demand<=64*1024**2);
  assert.ok(plan.reservedBytes<=512*1024**2);
  assert.ok(surfaceCellWorkspaceLayout(plan.batchTileCapacity).bytes<=limits.maxStorageBufferBindingSize);
  let last = 0;
  for (let batch = 0; batch < plan.batchCount; batch++) {
    const range = surfaceOptimizationBatchRange(plan, batch);
    assert.equal(range.firstTile, last);
    assert.ok(range.paddedTargetCapacity <= plan.batchTargetCapacity);
    last += range.tileCount;
  }
  assert.equal(last, 32400);
  assert.ok(surfaceOptimizationBatchRange(plan,plan.batchCount-1).tileCount<=plan.batchTileCapacity);
});
test('a wider cold profile reduces batch size without truncating target coverage', () => {
  const plan = planSurfaceOptimizationCapacity(1920, 1080, limits,
    { ...SURFACE_OPTIMIZATION_DEFAULT_PROFILE, geometryColdBytesPerTarget: 1024 });
  assert.ok(plan.scratchBytes.geometryCold<=32*1024**2);
  assert.ok(plan.batchTargetCapacity<=planSurfaceOptimizationCapacity(1920,1080,limits).batchTargetCapacity);
});
test('lower binding limits segment persistent pools and reduce scratch before allocation', () => {
  const reduced = { ...limits, maxStorageBufferBindingSize: 2 * 1024 ** 2 };
  const plan = planSurfaceOptimizationCapacity(1920, 1080, reduced);
  assert.ok(plan.productionAllocations.signalValues<=2*1024**2);
  assert.ok(surfaceCellWorkspaceLayout(plan.batchTileCapacity).bytes<=reduced.maxStorageBufferBindingSize);
  for (const bytes of Object.values(plan.scratchBytes)) assert.ok(bytes <= reduced.maxStorageBufferBindingSize);
  for (const segments of Object.values(plan.persistentSegments)) {
    for (const bytes of segments) assert.ok(bytes <= reduced.maxStorageBufferBindingSize);
  }
  assert.equal(plan.persistentSegments.fieldStore.reduce((a, b) => a + b, 0), 128 * 1024 ** 2);
});
test('NPOT targets reserve padded tile slots and cover partial edge tiles once', () => {
  const plan = planSurfaceOptimizationCapacity(17, 9, limits);
  assert.equal(plan.pixelCount, 153);
  assert.equal(plan.tileCount, 6);
  assert.equal(surfaceOptimizationBatchRange(plan, 0).paddedTargetCapacity, 384);
});
test('invalid extents, strides, tiny buffers and impossible outputs reject before allocation', () => {
  assert.throws(() => planSurfaceOptimizationCapacity(0, 1080, limits), RangeError);
  assert.throws(() => planSurfaceOptimizationCapacity(1920, NaN, limits), RangeError);
  assert.throws(() => planSurfaceOptimizationCapacity(1920, 1080, limits,
    { ...SURFACE_OPTIMIZATION_DEFAULT_PROFILE, fieldBytesPerTarget: 95 }), RangeError);
  assert.throws(() => planSurfaceOptimizationCapacity(1920, 1080,
    { ...limits, maxBufferSize: 256 }), RangeError);
  assert.throws(() => planSurfaceOptimizationCapacity(3840, 2160, limits), RangeError);
  const plan = planSurfaceOptimizationCapacity(1, 1, limits);
  assert.throws(() => surfaceOptimizationBatchRange(plan, -1), RangeError);
  assert.throws(() => surfaceOptimizationBatchRange(plan, plan.batchCount), RangeError);
});
