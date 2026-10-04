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

test('fixed 64-key sorting and run leader are in the setup producer',()=>{
  const source=surfaceCellGeometrySetupWgsl(false,1024);
  assert.match(source,/bitonic network/u);
  assert.match(source,/request_keys\[lane\]=vec2u\(key,lane\)/u);
  assert.match(source,/request_slots\[lane\]/u);
  assert.match(source,/offset<64u/u);
  assert.doesNotMatch(source,/for\(var i=0u;i<lane;i\+\+\)/u);
});

test('Geometry consumers cannot invoke an invocation-local direct setup fallback',()=>{
  const facts=surfaceCellProductionFactsWgsl([],false,'fn cell_direct_group_safe() {}',null,1024,new Set(),false);
  assert.doesNotMatch(facts,/cell_ensure_direct_geometry/u);
  assert.doesNotMatch(facts,/cell_direct_setup/u);
  assert.match(facts,/if slot\s*>=\s*settings\.geometry\.y/u);
});

test('record producer publishes the actual geometry input union with the hot depth contract',()=>{
  const source=surfaceGeometryRecordWgsl(64,1);
  assert.match(source,/bitcast<f32>\(mask\)/u);
  assert.match(source,/record\.metrics/u);
  const plan=planSurfaceOptimizationCapacity(1920,1080,limits);
  assert.ok(plan.productionAllocations.geometrySetup>0);
  assert.ok(plan.productionAllocations.geometrySetup<=limits.maxStorageBufferBindingSize);
});
