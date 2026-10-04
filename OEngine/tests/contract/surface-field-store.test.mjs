import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeSurfaceFieldStoreKey,planSurfaceFieldStoreCapacity,SURFACE_FIELD_STORE_ENTRY_BYTES,SURFACE_FIELD_STORE_WAYS,SURFACE_FIELD_STORE_KEY_WORDS} from '../../.test-dist/gpu/GpuSurfaceFieldStoreAbi.js';
test('FieldStore key keeps full identity separate from bounded hash selection',()=>{
 const base={producer:1,version:2,dependencyEpoch:3,material:4,instance:5,instanceGeneration:6,
  geometry:7,geometryGeneration:8,sourceMeshlet:9,sourcePrimitive:10,lod:11,chart:12,side:1,scope:14,
  cellX:15,cellY:16,gradientX:17,gradientY:18,geometryRevision:19,viewRevision:20,pointWitness:[21,22,23]};
 const a=encodeSurfaceFieldStoreKey(base);
 assert.equal(a.length,SURFACE_FIELD_STORE_KEY_WORDS);
 for(const name of Object.keys(base).filter(name=>name!=='pointWitness')) {
  assert.notDeepEqual(a,encodeSurfaceFieldStoreKey({...base,[name]:base[name]+1}),name);
 }
 assert.notDeepEqual(a,encodeSurfaceFieldStoreKey({...base,pointWitness:[21,22,24]}));
 assert.deepEqual([...a.subarray(0,23)],[1,2,3,4,5,6,7,8,9,10,11,12,1,14,15,16,17,18,19,20,21,22,23]);
 assert.throws(()=>encodeSurfaceFieldStoreKey({...base,pointWitness:Array(69).fill(0)}),RangeError);
 assert.throws(()=>encodeSurfaceFieldStoreKey({...base,dependencyEpoch:-1}),RangeError);
});
test('FieldStore 128 MiB budget is bounded and segments only at negotiated limits',()=>{
 const p=planSurfaceFieldStoreCapacity({maxBufferSize:1024**3,maxStorageBufferBindingSize:2*1024**2});
 assert.ok(p.bytes<=128*1024**2);assert.equal(p.entries*SURFACE_FIELD_STORE_ENTRY_BYTES,p.bytes);assert.equal(p.entries%SURFACE_FIELD_STORE_WAYS,0);
 assert.ok(p.segmentBytes.every(bytes=>bytes<=2*1024**2));
});
test('FieldStore rejects a device that cannot fit one complete four-way set',()=>assert.throws(()=>planSurfaceFieldStoreCapacity({maxBufferSize:1024,maxStorageBufferBindingSize:1024},SURFACE_FIELD_STORE_ENTRY_BYTES*3),RangeError));
