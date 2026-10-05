import test from 'node:test';
import assert from 'node:assert/strict';
import {planSurfaceCellGeometryCapacity,SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES} from '../../.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';
import {surfaceCellGeometrySetupWgsl} from '../../.test-dist/shaders/surface_cell_geometry_setup.js';
import {surfaceGeometryRecordWgsl} from '../../.test-dist/render/surface/SurfaceGeometryPass.js';
import {surfaceCellProductionFactsWgsl} from '../../.test-dist/shaders/surface_cell_production_facts.js';
import {planSurfaceOptimizationCapacity} from '../../.test-dist/gpu/SurfaceOptimizationCapacity.js';

const limits={maxBufferSize:1<<30,maxStorageBufferBindingSize:1<<27,maxTextureDimension2D:8192};

test('Phase 2 reserves complete local setup independently from the bounded memo',()=>{
  const targets=23296,profile=planSurfaceCellGeometryCapacity(targets,targets*1280,limits);
  assert.equal(profile.setupCapacity,targets);
  assert.ok(profile.memoCapacity<targets);
  assert.equal(profile.memoBytes,profile.memoCapacity*SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES);
  assert.ok(profile.totalReservedBytes>profile.reservedBytes);
  assert.ok(profile.setupBytes<=limits.maxStorageBufferBindingSize);
});

test('Geometry physically shares aliases while retaining independently requested semantic kinds',async()=>{
  const {SURFACE_GEOMETRY_PHYSICAL_INPUTS:map,SURFACE_GEOMETRY_RECORD_HOT_BYTES:hot,
    SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES:cold,SURFACE_GEOMETRY_RECORD_BYTES:bytes}=await import('../../.test-dist/gpu/GpuSurfaceGeometryRecordAbi.js');
  assert.equal(map.length,14);assert.equal(new Set(map).size,11);
  assert.equal(map[4],map[10]);assert.equal(map[5],map[11]);assert.equal(map[6],map[9]);
  assert.equal(hot,128);assert.equal(cold,11*3*16);assert.equal(bytes,656);
  const plan=planSurfaceOptimizationCapacity(1920,1080,limits);
  assert.equal(plan.productionAllocations.geometryHot,plan.batchTargetCapacity*hot);
  assert.equal(plan.productionAllocations.geometryCold,plan.batchTargetCapacity*cold);
  assert.equal(plan.productionAllocations.geometryHot+plan.productionAllocations.geometryCold,plan.batchTargetCapacity*bytes);
  assert.ok(plan.reservedBytes>=plan.ledger.scratchBytes*2+plan.ledger.persistentBytes+plan.ledger.outputBytes*2);
});
