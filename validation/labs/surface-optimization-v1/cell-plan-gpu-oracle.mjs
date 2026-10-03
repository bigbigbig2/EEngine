import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { surfaceCellClassifyWgsl } from '../../../OEngine/.test-dist/shaders/surface_cell_classify.js';
import { surfaceCellSixBit, SURFACE_CELL_TILE_PLAN_BYTES, SURFACE_CELL_PLANE_BYTES, SURFACE_CELL_TILE_MAP_BYTES, surfaceCellWorkspaceLayout } from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';

// Synthetic facts exercise the unchanged production partition kernel, not a
// production geometry/material implementation. Assertions use independent
// coverage, domain and error invariants, never reproduce the merge algorithm.
if (!process.argv[2]) throw new Error('Pass external webgpu runtime directory');
const { create, globals } = createRequire(resolve(process.argv[2], 'package.json'))('webgpu');
Object.assign(globalThis, globals);
const gpu = create(['backend=d3d12', ...process.argv.slice(3)]);
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
assert.ok(adapter && !adapter.info.isFallbackAdapter);
const device = await adapter.requestDevice();
const errors = [], keepAlive = setInterval(() => {}, 1000);
device.addEventListener('uncapturederror', e => errors.push(e.error.message));
let disposing = false, loss = null;
void device.lost.then(info => { if (!disposing) loss = info.message; });
const report = { evidenceRole: 'diagnostic', passed: false, adapter: adapter.info.description, cases: [], apiErrors: errors };
const facts = /* wgsl */ `
@group(0) @binding(5) var<storage,read> fixture:array<vec4u>;
fn surface_cell_load(pixel:vec2u,winner:u32)->SurfaceCellLane {
 let at=(pixel.y*cell_settings.width+pixel.x)*2u;
 let data=fixture[at];return SurfaceCellLane(vec4u(data.x,data.y,0u,0u),winner,at,data.z,data.w);
}
fn surface_cell_compatible(plane:u32,a:SurfaceCellLane,b:SurfaceCellLane)->bool {
 return all(a.identity==b.identity);
}
fn surface_cell_group_valid(plane:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u)->bool {
 var low=1e30;var high=-1e30;
 for(var i=0u;i<64u;i++){if cell_member(mask,i){
  let value=bitcast<vec4f>(fixture[(*lanes)[i].source+1u]);
  if plane==6u && value.z<0.5{return false;}
  low=min(low,value.x);high=max(high,value.y);
 }}
 return high-low<=0.02;
}`;
async function capture(encoder, source, size=source.size, offset=0) {
 const staging=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 encoder.copyBufferToBuffer(source,offset,staging,0,size);return staging;
}
function read(staging){const v=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();return v;}
try {
 device.pushErrorScope('validation');
 const workspaceLayout=surfaceCellWorkspaceLayout(3);
 const module=device.createShaderModule({code:surfaceCellClassifyWgsl(facts,3)});
 const compilation=await module.getCompilationInfo();
 assert.deepEqual(compilation.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'classify_cells'}});
 const ALL=(1<<21)-1;
 const fixtures=[
  {name:'cross-winner continuous',width:8,height:8,first:0,count:1,lane:i=>({domain:1,winner:i,enabled:ALL})},
  {name:'mixed interleaved domains retain low rate',width:8,height:8,first:0,count:1,lane:i=>({domain:i%2+1,winner:i,enabled:ALL})},
  {name:'fine unique domains implicit',width:8,height:8,first:0,count:1,lane:i=>({domain:i+1,winner:i,enabled:ALL})},
  {name:'constant publication no result slots',width:8,height:8,first:0,count:1,lane:i=>({domain:1,winner:i,enabled:ALL,publication:ALL})},
  {name:'unknown normal only normal fine',width:8,height:8,first:0,count:1,lane:i=>({domain:1,winner:i,enabled:ALL,normal:false})},
  {name:'varying base only base fine',width:8,height:8,first:0,count:1,lane:i=>({domain:1,winner:i,enabled:1,low:i*.1})},
  {name:'tail batch sparse coverage and disabled planes',width:13,height:11,first:1,count:3,lane:i=>({domain:1,winner:i,enabled:i%3?1:0,covered:i%7!==0})},
  {name:'empty tile',width:8,height:8,first:0,count:1,lane:i=>({domain:1,winner:i,enabled:0,covered:false})},
  {name:'separated mixed domains use compact group indices',width:8,height:8,first:0,count:1,lane:i=>({domain:i<32?1:2,winner:i,enabled:1})},
  {name:'mixed domains preserve field error bounds',width:8,height:8,first:0,count:1,lane:i=>({domain:i%2+1,winner:i,enabled:1,low:i*.1})},
 ];
 for(const test of fixtures){
  if(process.env.SURFACE_CELL_CASE && !test.name.includes(process.env.SURFACE_CELL_CASE))continue;
  report.currentCase=test.name;
  const retained=[], n=test.width*test.height;
  const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});retained.push(b);return b;};
  const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
  const values=new Uint32Array(n*8),floats=new Float32Array(values.buffer),visibility=new Uint32Array(n),lanes=[];
  for(let i=0;i<n;i++){const l={covered:true,publication:0,normal:true,low:0,...test.lane(i)};lanes.push(l);
   visibility[i]=l.covered?l.winner:0xffffffff;values.set([l.domain,1,l.enabled,l.publication],i*8);
   floats[i*8+4]=l.low;floats[i*8+5]=l.low;floats[i*8+6]=l.normal?1:0;
  }
  const input=buffer(values.byteLength,storage);device.queue.writeBuffer(input,0,values);
  const settings=buffer(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(settings,0,new Uint32Array([test.width,test.height,Math.ceil(test.width/8),test.first,test.count,test.count*64,7,0]));
  const workspace=buffer(workspaceLayout.bytes,storage);
  const texture=device.createTexture({size:[test.width,test.height],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},visibility,{bytesPerRow:test.width*4},{width:test.width,height:test.height});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
   {binding:0,resource:{buffer:settings}},{binding:1,resource:texture.createView()},
   {binding:2,resource:{buffer:workspace}},{binding:5,resource:{buffer:input}}]});
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
  pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(test.count);pass.end();
  const staging=await Promise.all([
   capture(encoder,workspace,test.count*SURFACE_CELL_TILE_PLAN_BYTES,workspaceLayout.plans),
   capture(encoder,workspace,test.count*SURFACE_CELL_TILE_MAP_BYTES,workspaceLayout.maps),
   capture(encoder,workspace,128*4,0)]);
  device.queue.submit([encoder.finish()]);await Promise.all(staging.map(b=>b.mapAsync(GPUMapMode.READ)));
  const [p,m,c]=staging.map(read);let groups=0,cross=0,mapBytes=0;
  for(let tile=0;tile<test.count;tile++){
   const header=tile*(SURFACE_CELL_TILE_PLAN_BYTES/4),ox=p[header],oy=p[header+1];
   assert.equal(ox,((tile+test.first)%Math.ceil(test.width/8))*8);assert.equal(oy,Math.floor((tile+test.first)/Math.ceil(test.width/8))*8);
   for(let plane=0;plane<21;plane++){
    const at=header+16+plane*(SURFACE_CELL_PLANE_BYTES/4),mode=p[at]&255,rate=p[at]>>>8,slots=p[at+3],partition=new Map();
    assert.ok(slots<=64);assert.ok(p[at+1]+slots<=test.count*64);
    for(let lane=0;lane<64;lane++){
     const x=ox+lane%8,y=oy+Math.floor(lane/8),l=x<test.width&&y<test.height?lanes[y*test.width+x]:null;
     const expectedCoverage=!!l?.covered && !!(l.enabled&(1<<plane));
     assert.equal(!!(p[at+4+(lane>=32?1:0)]&(1<<(lane&31))),expectedCoverage);
     if(!expectedCoverage)continue;
     if(mode===1){assert.ok(l.publication&(1<<plane));continue;}
     assert.ok(mode>=2&&mode<=4);
     const g=mode===2?lane:mode===3?(Math.floor(lane/8)>>(rate>>2&3))*(8>>(rate&3))+((lane%8)>>(rate&3)):surfaceCellSixBit(m,lane,p[at+2]);
     assert.ok(g<slots,`${test.name}: tile ${tile}, plane ${plane}, lane ${lane}, group ${g} exceeds ${slots} slots`);if(!partition.has(g))partition.set(g,[]);partition.get(g).push({lane,l});
    }
    for(const [g,members] of partition){
     assert.ok(members.every(({l})=>l.domain===members[0].l.domain));
     assert.ok(Math.max(...members.map(({l})=>l.low))-Math.min(...members.map(({l})=>l.low))<=.020001,`${test.name}: tile ${tile}, plane ${plane}, group ${g} exceeds the 0.02 field error budget`);
     if(plane===6&&!members[0].l.normal)assert.equal(members.length,1);
     if(mode===4){const representative=surfaceCellSixBit(m,g,p[at+2]+12);assert.ok(members.some(({lane})=>lane===representative));}
    }
    groups+=partition.size;if(mode===4)mapBytes+=96;
    if(test.name==='cross-winner continuous'&&plane===0){assert.equal(mode,3);assert.equal(slots,4);}
    if(test.name==='mixed interleaved domains retain low rate'&&plane===0){assert.equal(mode,4);assert.ok(partition.size<32);}
    if(test.name.startsWith('fine')&&plane===0){assert.equal(mode,2);assert.equal(slots,64);}
    if(test.name.startsWith('constant')){assert.equal(mode,1);assert.equal(slots,0);}
    if(test.name.startsWith('unknown')&&plane===0)assert.equal(slots,4);
   }
  }
  for(let plane=0;plane<21;plane++)cross+=c[plane*4+2];
  if(test.name.startsWith('cross'))assert.ok(cross>0);
  report.cases.push({name:test.name,groups,crossWinnerGroups:cross,mapBytes});
  texture.destroy();for(const b of [...retained,...staging])b.destroy();
 }
 assert.equal(await device.popErrorScope(),null);assert.deepEqual(errors,[]);assert.equal(loss,null);report.passed=true;
} finally {
 await mkdir('.local/validation/surface-optimization-v1',{recursive:true});
 await writeFile('.local/validation/surface-optimization-v1/cell-plan-gpu-oracle.json',JSON.stringify(report,null,2));
 disposing=true;device.destroy();clearInterval(keepAlive);
}
console.log(JSON.stringify(report));
