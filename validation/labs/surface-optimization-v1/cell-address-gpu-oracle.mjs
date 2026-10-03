import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SURFACE_CELL_ADDRESS_MATH_WGSL } from '../../../OEngine/.test-dist/shaders/surface_cell_address_math.js';
import { WINNER_INTERPOLATION_WGSL } from '../../../OEngine/.test-dist/shaders/winner_interpolation.js';
import { APPEARANCE_FIELD_BOUND_WGSL } from '../../../OEngine/.test-dist/shaders/appearance_field_bounds.js';
import { surfaceCellGeometrySetupWgsl } from '../../../OEngine/.test-dist/shaders/surface_cell_geometry_setup.js';

// CPU oracle uses pivoted Gaussian elimination on the homogeneous vertex
// matrix. It does not copy the GPU cross-product coefficient construction.
function value(clips, attributes, pixel, viewport) {
 const ndc=[pixel[0]/viewport[0]*2-1,1-pixel[1]/viewport[1]*2,1];
 const a=[0,1,3].map((row,i)=>[...clips.map(v=>v[row]),ndc[i]]);
 for(let c=0;c<3;c++){
  let p=c;for(let i=c+1;i<3;i++)if(Math.abs(a[i][c])>Math.abs(a[p][c]))p=i;
  [a[p],a[c]]=[a[c],a[p]];assert.ok(Math.abs(a[c][c])>1e-15);
  const d=a[c][c];for(let j=c;j<4;j++)a[c][j]/=d;
  for(let i=0;i<3;i++)if(i!==c){const factor=a[i][c];for(let j=c;j<4;j++)a[i][j]-=factor*a[c][j];}
 }
 const weights=a.map(row=>row[3]),sum=weights.reduce((a,b)=>a+b,0);
 return weights.reduce((a,w,i)=>a+w*attributes[i],0)/sum;
}
if(!process.argv[2])throw new Error('Pass external runtime directory');
const {create,globals}=createRequire(resolve(process.argv[2],'package.json'))('webgpu');Object.assign(globalThis,globals);
const gpu=create(['backend=d3d12']),adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
assert.ok(adapter&&!adapter.info.isFallbackAdapter);assert.ok(adapter.limits.maxStorageBuffersPerShaderStage>=13);
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:13}});
const errors=[],keepAlive=setInterval(()=>{},1000);device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
const report={evidenceRole:'diagnostic',passed:false,cases:[],apiErrors:errors};let disposing=false,loss=null;void device.lost.then(i=>{if(!disposing)loss=i.message;});
const retained=[];
try{
 device.pushErrorScope('validation');
 for(const product of [false,true]){
  const setup=device.createShaderModule({code:surfaceCellGeometrySetupWgsl(product)});
  const info=await setup.getCompilationInfo();assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
  for(const entryPoint of ['reset_cell_geometry','request_cell_geometry','build_cell_geometry'])
   await device.createComputePipelineAsync({layout:'auto',compute:{module:setup,entryPoint}});
 }
 const fixtures=[
  {name:'affine continuous triangle',clips:[[-1,-1,.5,1],[1,-1,.5,1],[-1,1,.5,1]],values:[0,1,.5],rect:[5.5,3.5,12.5,10.5],viewport:[64,64]},
  {name:'perspective footprint',clips:[[-1,-1,.5,1],[2,-2,1,2],[-4,4,2,4]],values:[0,1,.5],rect:[5.5,3.5,12.5,10.5],viewport:[64,64]},
  {name:'negative original clip w',clips:[[-1,-1,.5,-.2],[1,-1,.5,1],[-1,1,.5,1]],values:[-.7,.2,.9],rect:[30.5,28.5,37.5,35.5],viewport:[64,64]},
  {name:'zero original clip w',clips:[[-1,-1,.5,0],[1,-1,.5,1],[-1,1,.5,1]],values:[.3,.7,-.4],rect:[22.5,19.5,29.5,26.5],viewport:[64,64]},
  {name:'cancellation with large authored values',clips:[[-1,-1,.5,1],[1,-1,.5,1],[-1,1,.5,1]],values:[-2000,2000,0],rect:[23.5,23.5,30.5,30.5],viewport:[64,64]},
  {name:'denominator horizon rejected',clips:[[-1,-1,.5,-1],[1,-1,.5,1],[-1,1,.5,1]],values:[0,1,2],rect:[.5,.5,63.5,63.5],viewport:[64,64],unknown:true},
 ];
 const input=new Float32Array(fixtures.length*24);
 fixtures.forEach((q,i)=>{q.clips.forEach((v,c)=>input.set(v,i*24+c*4));input.set(q.values,i*24+12);input.set(q.rect,i*24+16);input.set(q.viewport,i*24+20);});
 const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});retained.push(b);return b;};
 const source=buffer(input.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),output=buffer(fixtures.length*48,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),staging=buffer(fixtures.length*48,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
 device.queue.writeBuffer(source,0,input);
 const module=device.createShaderModule({code:`
 ${WINNER_INTERPOLATION_WGSL}
 ${APPEARANCE_FIELD_BOUND_WGSL}
 ${SURFACE_CELL_ADDRESS_MATH_WGSL}
 @group(0) @binding(0) var<storage,read> source:array<vec4f>;
 @group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
 @compute @workgroup_size(64) fn address(@builtin(global_invocation_id) id:vec3u){
  if id.x>=${fixtures.length}u{return;}
  let at=id.x*6u;let c=winner_build_coefficients(source[at],source[at+1u],source[at+2u]);
  let result=cell_scalar_footprint(c,source[at+3u].xyz,source[at+4u].xy,source[at+4u].zw,source[at+5u].xy);
  output[id.x*3u]=vec4f(result.value.low,result.value.high,f32(result.value.known),0);
  output[id.x*3u+1u]=vec4f(result.dx.low,result.dx.high,f32(result.dx.known),0);
  output[id.x*3u+2u]=vec4f(result.dy.low,result.dy.high,f32(result.dy.known),0);
 }`});
 const info=await module.getCompilationInfo();assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'address'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:output}}]});
 const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,staging,0,output.size);device.queue.submit([encoder.finish()]);
 await staging.mapAsync(GPUMapMode.READ);const bounds=new Float32Array(staging.getMappedRange()).slice();staging.unmap();
 for(let f=0;f<fixtures.length;f++){
  const q=fixtures[f];let points=0;
  if(q.unknown){assert.equal(bounds[f*12+2],0);report.cases.push({name:q.name,unknown:true});continue;}
  for(let component=0;component<3;component++)assert.equal(bounds[f*12+component*4+2],1);
  for(let y=0;y<=16;y++)for(let x=0;x<=16;x++){
   const p=[q.rect[0]+(q.rect[2]-q.rect[0])*x/16,q.rect[1]+(q.rect[3]-q.rect[1])*y/16];
   const v=value(q.clips,q.values,p,q.viewport),dx=value(q.clips,q.values,[p[0]+1,p[1]],q.viewport)-v,dy=value(q.clips,q.values,[p[0],p[1]+1],q.viewport)-v;
   [v,dx,dy].forEach((actual,c)=>{const lo=bounds[f*12+c*4],hi=bounds[f*12+c*4+1];assert.ok(actual>=lo&&actual<=hi,`${q.name} component ${c} ${actual} outside ${lo} ${hi}`);});points++;
  }
  report.cases.push({name:q.name,points,valueWidth:bounds[f*12+1]-bounds[f*12]});
 }
 assert.equal(await device.popErrorScope(),null);assert.deepEqual(errors,[]);assert.equal(loss,null);report.passed=true;
}finally{
 await mkdir('.local/validation/surface-optimization-v1',{recursive:true});await writeFile('.local/validation/surface-optimization-v1/cell-address-gpu-oracle.json',JSON.stringify(report,null,2));
 for(const b of retained)b.destroy();disposing=true;device.destroy();clearInterval(keepAlive);
}
console.log(JSON.stringify(report));
