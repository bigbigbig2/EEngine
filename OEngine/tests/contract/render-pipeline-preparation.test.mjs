import assert from 'node:assert/strict';
import test from 'node:test';
import '../../tests/webgpu-test-globals.mjs';
globalThis.GPUColorWrite = { ALL:15 };
import { RenderPipelineCache } from '../../.test-dist/gpu/GPUDescriptorCaches.js';
const descriptor = () => ({layout:{bindGroupLayouts:[]},vertex:{module:{code:'vertex'},entryPoint:'main'},
  fragment:{module:{code:'fragment'},entryPoint:'main',targets:[{format:'r32uint'}]},primitive:{cullMode:'none'}});
function fixture() {
  const jobs=[],events=[];
  const device={createRenderPipeline(){throw new Error('Synchronous compiler must not be reached');},createRenderPipelineAsync(d){
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});jobs.push({d,promise,resolve,reject});return promise;}};
  const cache=new RenderPipelineCache(device,{obtainPipelineLayout:d=>d},{obtain:d=>d},
    {onPipelineFirstUse:()=>events.push('first-use'),onPipelineCreated:()=>events.push('created')});
  return {jobs,events,cache};
}
test('scene preparation deduplicates structural descriptors and draw requires the warmed exact variant',async()=>{
  const f=fixture(),d=descriptor();const a=f.cache.prepare(d),b=f.cache.prepare(descriptor());assert.equal(a,b);assert.equal(f.jobs.length,1);
  assert.throws(()=>f.cache.requirePrepared(d),/completed scene preparation/);
  const pipeline={};f.jobs[0].resolve(pipeline);assert.equal(await a,pipeline);assert.deepEqual(f.events,['created']);
  assert.equal(f.cache.requirePrepared(descriptor()),pipeline);assert.equal(f.cache.requirePrepared(d),pipeline);
  assert.deepEqual(f.events,['created','first-use']);assert.equal(await f.cache.prepare(d),pipeline);assert.equal(f.jobs.length,1);
  assert.throws(()=>f.cache.requirePrepared({...d,depthStencil:{format:'depth32float',depthCompare:'greater'}}),/completed scene preparation/);
});
test('compiler failure is propagated, does not publish and permits an independent retry',async()=>{
  const f=fixture(),d=descriptor(),first=f.cache.prepare(d);f.jobs[0].reject(new Error('GPU compile failed'));
  await assert.rejects(first,/GPU compile failed/);assert.throws(()=>f.cache.requirePrepared(d),/completed scene preparation/);
  const next=f.cache.prepare(d),pipeline={};f.jobs[1].resolve(pipeline);assert.equal(await next,pipeline);assert.equal(f.cache.requirePrepared(d),pipeline);
});
test('clear revokes an in-flight compile without deleting or publishing a replacement job',async()=>{
  const f=fixture(),d=descriptor(),old=f.cache.prepare(d);f.cache.clear();const next=f.cache.prepare(d);
  f.jobs[0].resolve({});await assert.rejects(old,/revoked/);assert.throws(()=>f.cache.requirePrepared(d),/completed scene preparation/);
  assert.equal(f.cache.prepare(d),next);const pipeline={};f.jobs[1].resolve(pipeline);await next;assert.equal(f.cache.requirePrepared(d),pipeline);
});
