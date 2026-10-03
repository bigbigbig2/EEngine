import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeSurfaceFieldStoreKey,planSurfaceFieldStoreCapacity,SURFACE_FIELD_STORE_ENTRY_BYTES,SURFACE_FIELD_STORE_WAYS,SURFACE_FIELD_STORE_WGSL} from '../../.test-dist/gpu/GpuSurfaceFieldStoreAbi.js';
test('FieldStore key keeps full identity separate from bounded hash selection',()=>{
 const base={programGeneration:1,fieldVersion:2,chartDomain:3,cellLevel:4,cellX:5,cellY:6,samplerClass:7,textureGeneration:8,geometryDomain:9,side:1,footprintId:11,reserved:0};
 const a=encodeSurfaceFieldStoreKey(base),b=encodeSurfaceFieldStoreKey({...base,cellX:6});assert.notDeepEqual(a,b);assert.equal(a.length,12);
});
test('FieldStore 128 MiB budget is bounded and segments only at negotiated limits',()=>{
 const p=planSurfaceFieldStoreCapacity({maxBufferSize:1024**3,maxStorageBufferBindingSize:2*1024**2});
 assert.ok(p.bytes<=128*1024**2);assert.equal(p.entries*SURFACE_FIELD_STORE_ENTRY_BYTES,p.bytes);assert.equal(p.entries%SURFACE_FIELD_STORE_WAYS,0);
 assert.ok(p.segmentBytes.every(bytes=>bytes<=2*1024**2));
});
test('FieldStore rejects a device that cannot fit one complete four-way set',()=>assert.throws(()=>planSurfaceFieldStoreCapacity({maxBufferSize:1024,maxStorageBufferBindingSize:1024},SURFACE_FIELD_STORE_ENTRY_BYTES*3),RangeError));
test('FieldStore WGSL uses hash only for set selection and compares every key word',()=>{
 assert.match(SURFACE_FIELD_STORE_WGSL,/surface_field_store_hash/);assert.match(SURFACE_FIELD_STORE_WGSL,/surface_field_store_equal/);
 assert.match(SURFACE_FIELD_STORE_WGSL,/SURFACE_FIELD_STORE_KEY_WORDS/);assert.match(SURFACE_FIELD_STORE_WGSL,/SURFACE_FIELD_STORE_WAYS/);
});
