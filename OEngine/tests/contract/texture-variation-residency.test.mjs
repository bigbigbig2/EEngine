import assert from 'node:assert/strict';
import test from 'node:test';
import '../webgpu-test-globals.mjs';
import { TextureVariationResidency } from '../../.test-dist/gpu/TextureVariationResidency.js';
globalThis.GPUBufferUsage ??= { STORAGE:128, UNIFORM:64, COPY_SRC:4, COPY_DST:8 };

function device() {
 return { limits:{maxBufferSize:128*1024**2,maxStorageBufferBindingSize:128*1024**2,maxComputeWorkgroupsPerDimension:65535},
  buffers:[],createBuffer(desc){const value={...desc,destroyed:false,destroy(){this.destroyed=true;}};this.buffers.push(value);return value;},
  createBindGroupLayout(desc){return desc;},createPipelineLayout(desc){return desc;},createShaderModule(desc){return desc;},
  createComputePipeline(desc){return desc;},createBindGroup(desc){return desc;} };
}
function command(d) {
 const finished=[],aborted=[];
 return {device:d,closed:false,onFinished:{addOne(fn){finished.push(fn);}},onAborted:{addOne(fn){aborted.push(fn);}},
  allocateTransientBuffer(usage,size){return d.createBuffer({usage,size});},writeBuffer(){},
  beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};},
  finish(){this.closed=true;for(const fn of finished)fn();},abort(){this.closed=true;for(const fn of aborted)fn();} };
}
function input(slot=1,generation=1,revision=1) {
 return {slot,generation,revision,width:8,height:8,mipCount:2,availableMip:0,layer:0,decodeSrgb:false,
  texture:{width:8,height:8,mipLevelCount:2,depthOrArrayLayers:1,createView(desc){return desc;}}};
}
test('aborted initial publication returns its complete range and never commits a resident entry',()=>{
 const d=device(),owner=new TextureVariationResidency(d,16),free=owner.stats().freeBytes,cmd=command(d);
 assert.equal(owner.stage(cmd,input()),true);assert.ok(owner.stats().freeBytes<free);
 assert.throws(()=>owner.stage(command(d),input()),/two unsubmitted producers/);
 assert.throws(()=>owner.retire(1,1),/unsubmitted/);
 cmd.abort();assert.equal(owner.stats().residentTextures,0);assert.equal(owner.stats().freeBytes,free);
 owner.destroy();assert.equal(owner.buffer.destroyed,true);
});
test('committed generations cannot alias; abort promotion keeps the old owner; retirement frees its range',()=>{
 const d=device(),owner=new TextureVariationResidency(d,16),free=owner.stats().freeBytes,first=command(d);
 owner.stage(first,input());first.finish();assert.equal(owner.stats().residentTextures,1);assert.equal(owner.stats().builds,1);
 assert.throws(()=>owner.stage(command(d),input(1,2,2)),/recycled/);
 const promote=command(d);owner.stage(promote,input(1,1,2));promote.abort();assert.equal(owner.stats().builds,1);
 owner.retire(1,2);assert.equal(owner.stats().residentTextures,1,'wrong generation cannot release the current owner');
 owner.retire(1,1);assert.equal(owner.stats().freeBytes,free);assert.equal(owner.stats().residentTextures,0);
 const reused=command(d);owner.stage(reused,input(1,2,1));reused.finish();assert.equal(owner.stats().residentTextures,1);
 owner.destroy();
});
test('pipeline initialization failure destroys the allocated pool and releases accounting',()=>{
 const d=device(),released=[];d.createComputePipeline=()=>{throw new Error('pipeline failure');};
 assert.throws(()=>new TextureVariationResidency(d,16,{created(){return 'variation';},destroyed(handle){released.push(handle);}}),/pipeline failure/);
 assert.equal(d.buffers[0].destroyed,true);assert.deepEqual(released,['variation']);
});
test('static products share the pool, recycle descriptor slots only with new generations and roll back aborts',()=>{
 const d=device(),owner=new TextureVariationResidency(d,16,undefined,1),free=owner.stats().freeBytes;
 const {slot:unusedSlot,generation:unusedGeneration,revision:unusedRevision,...texture}=input();
 const aborted=command(d),first=owner.stageStatic(aborted,texture);
 assert.equal(first.slot,17);assert.ok(first.generation>0);aborted.abort();assert.equal(owner.stats().freeBytes,free);
 const committed=command(d),next=owner.stageStatic(committed,texture);
 assert.equal(next.slot,17);assert.ok(next.generation>first.generation);committed.finish();
 assert.equal(owner.stats().residentTextures,1);
 assert.deepEqual(owner.stageStatic(command(d),texture),{slot:0,generation:0,revision:0});
 owner.retire(next.slot,first.generation);assert.equal(owner.stats().residentTextures,1);
 owner.retire(next.slot,next.generation);assert.equal(owner.stats().freeBytes,free);
 const replacement=command(d),last=owner.stageStatic(replacement,texture);assert.ok(last.generation>next.generation);replacement.abort();
 assert.equal(owner.stats().freeBytes,free);owner.destroy();
});
