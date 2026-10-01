import assert from 'node:assert/strict';
import test from 'node:test';
import '../webgpu-test-globals.mjs';
import { PackedVisibilityPass } from '../../.test-dist/render/passes/PackedVisibilityPass.js';
import { FrameInstanceTransforms } from '../../.test-dist/render/FrameInstanceTransforms.js';
import { FrameGeometryArena } from '../../.test-dist/render/FrameGeometryArena.js';
import { FrameGeometryVertices } from '../../.test-dist/render/FrameGeometryVertices.js';
import { ResourceAccounting } from '../../.test-dist/debug/profiling/ResourceAccounting.js';
globalThis.GPUBufferUsage={UNIFORM:64,STORAGE:128,INDIRECT:256,COPY_SRC:4,COPY_DST:8};
async function fixture() {
  const buffers=[],events=[],commits=[],retirements=[],copies=[],accounting=new ResourceAccounting();
  const device={features:new Set(),limits:{maxStorageBuffersPerShaderStage:16,maxBindingsPerBindGroup:1000,maxBindGroups:4,
    maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupsPerDimension:65535,
    minStorageBufferOffsetAlignment:256,maxBufferSize:1<<27,maxStorageBufferBindingSize:1<<27},lost:new Promise(()=>{}),queue:{writeBuffer(){}},
    createShaderModule:d=>d,createBindGroupLayout:d=>d,createPipelineLayout:d=>d,createComputePipeline:d=>d,createComputePipelineAsync:async d=>d,
    createBuffer(d){const bytes=new ArrayBuffer(d.size),b={...d,destroyed:0,getMappedRange:()=>bytes,unmap(){},destroy(){this.destroyed++;}};buffers.push(b);return b;},createBindGroup:d=>d};
  const make=(size=1024)=>device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const graphics={device,resource_accounting:accounting,frame_instances:new FrameInstanceTransforms(device,accounting),
    frame_vertices:new FrameGeometryVertices(device,accounting),frame_geometry_arena:new FrameGeometryArena(device,accounting),
    bind_groups:{obtain:d=>d},render_pipelines:{requirePrepared:d=>d}};
  await Promise.all([graphics.frame_instances.ready,graphics.frame_vertices.ready]);
  const hierarchy={prepare(){return {generated:{viewUniform:make(),visibleClusters:make(),visibleClusterCapacity:1}};},
    rebind(){},encode(){events.push('hierarchy');return {pageDemand:null};},release(){events.push('hierarchy-release');},destroy(){}};
  const candidate={prepare(input){return {queue:make(),drawIndirect:make(),bucketStates:make(),bucketSettings:make(),bucketCount:1,capacity:input.capacity};},
    rebind(){},encode(){events.push('candidate');},release(){events.push('candidate-release');},destroy(){}};
  const pass=new PackedVisibilityPass(graphics,hierarchy,candidate),camera=make(),counters=make();
  const job={runtime:{hierarchyRasterWorkCapacity:4,hierarchyTraversalCapacity:4,hierarchyVisibleClusterCapacity:4,hierarchyMaxDepth:1,
    instanceBegin:0,instanceCount:1,materialResources:{bindingSets:[{id:0,textureBanks:Array(9).fill({})}],materialRecords:make(),materialCapacity:1}},
    assets:{epoch:1,geometryRecords:make(),meshletRecords:make(),meshletVertexIndices:make(),meshletTriangleIndices:make(),vertexStreamData:make(),
      highWaterCounts:{geometryRecords:1,meshletRecords:1},sparseShading:{assetMetadataHeap:make(),assetMetadataBytes:256}},
    scene:{resourceEpoch:1,instances:make(176),highWaterCount:1},width:64,height:64,countersEnabled:false,hierarchyView:{},sseThreshold:1,coneEnabled:false,
    previousHzb:null,executionMode:'none',frameGeometryBudget:{vertexCapacity:9,triangleCapacity:3,dictionaryCapacity:16,coefficientCapacity:8,probeLimit:8,maxBytes:16384}};
  const encoder={copyBufferToBuffer(...args){copies.push(args);},clearBuffer(){},beginComputePass(){return {setPipeline(p){events.push(p.compute.entryPoint);},setBindGroup(){},dispatchWorkgroups(){},dispatchWorkgroupsIndirect(){},end(){}};},
    beginRenderPass(){events.push('raster');return {setPipeline(){},setBindGroup(){},drawIndirect(){},end(){}};}};
  const command={isGPUCommandContext:true,gpu_encoder:encoder,onFinished:{addOne(fn){commits.push(fn);}},destroyAfterGpuDone(r){retirements.push(r);}};
  const dispose=()=>{pass.destroy();graphics.frame_instances.destroy();graphics.frame_vertices.destroy();graphics.frame_geometry_arena.destroy();};
  return {pass,job,camera,counters,command,graphics,events,buffers,commits,copies,retirements,accounting,dispose};
}
test('production Visibility publishes metadata only after submission and orders candidate, transforms, shared vertices, raster',async()=>{
  const f=await fixture(),prepared=f.pass.prepareHierarchy(f.job,f.counters,f.camera,f.command);
  let callback;const writes=[],graph={add(_name,_job,fn){callback=fn;return {read(){},write(id){writes.push(id);return id+100;},create(){return 99;},make_side_effect(){}};}};
  const input={camera:1,counters:2,frameInstances:3,frameGeometry:4,meshletWorkRecords:5,depth:6};
  const output=f.pass.addToGraph(graph,{...f.job,prepared},input);assert.equal(output.frame.frameGeometry,104);assert.ok(writes.includes(4));
  const run=()=>callback({...f.job,prepared},{get:id=>id===1?f.camera:id===2?f.counters:{isView:true}},{encoder:f.command});
  run();assert.equal(f.copies.length,1);assert.equal(f.commits.length,1);
  const order=['candidate','frame_instance_build','frame_vertices_begin','frame_vertices_build','frame_vertices_finalize','raster'];
  assert.ok(order.every((e,i)=>i===0||f.events.indexOf(e)>f.events.indexOf(order[i-1])));
  // An aborted command discards its commit callback; next frame republishes.
  run();assert.equal(f.copies.length,2);f.commits[1]();run();assert.equal(f.copies.length,2);assert.equal(f.commits.length,2);
  const count=f.buffers.length;assert.equal(f.pass.prepareHierarchy(f.job,f.counters,{},f.command).workSet,prepared.workSet);assert.equal(f.buffers.length,count);
  f.dispose();assert.equal(f.accounting.snapshot().totalBytes,0);
});
test('failed replacement preserves the live workset; successful replacement retires old arena and vertices in GPU order',async()=>{
  const f=await fixture(),old=f.pass.prepareHierarchy(f.job,f.counters,f.camera,f.command),bytes=f.accounting.snapshot().totalBytes;
  assert.throws(()=>f.pass.prepareHierarchy({...f.job,frameGeometryBudget:{...f.job.frameGeometryBudget,maxBytes:16}},f.counters,f.camera,f.command),RangeError);
  assert.equal(f.accounting.snapshot().totalBytes,bytes);assert.equal(f.pass.prepareHierarchy(f.job,f.counters,f.camera,f.command).workSet,old.workSet);
  const next=f.pass.prepareHierarchy({...f.job,assets:{...f.job.assets,epoch:2}},f.counters,f.camera,f.command);
  assert.notEqual(next.workSet,old.workSet);assert.equal(old.workSet.frameGeometry.buffer.destroyed,0);assert.equal(f.retirements.length,1);
  f.retirements[0].destroy();assert.equal(old.workSet.frameGeometry.buffer.destroyed,1);assert.equal(f.accounting.snapshot().totalBytes,bytes);
  f.dispose();assert.equal(f.accounting.snapshot().totalBytes,0);
});
test('retiring late-HZB work retains its device owner after the feature is destroyed',async()=>{
  const f=await fixture(),retired={},released=[];
  // Retirement owns this handle after it has left the feature's live map.
  f.pass.currentHzbLateRecheck={release:p=>released.push(p)};
  f.pass.currentHzbPrepared.set(f.job.runtime,retired);
  f.pass.release(f.job.runtime,f.command);f.pass.destroy();
  assert.equal(released.length,0);f.retirements[0].destroy();assert.deepEqual(released,[retired]);f.dispose();
});
