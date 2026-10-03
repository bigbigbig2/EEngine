import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppearanceGraphBuilder } from '../../../OEngine/.test-dist/material/AppearanceGraph.js';
import { compileAppearanceGraph } from '../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js';
import { lowerAppearanceWgsl } from '../../../OEngine/.test-dist/shaders/appearance_program.js';
import { lowerAppearanceFieldBounds, APPEARANCE_FIELD_BOUND_WGSL } from '../../../OEngine/.test-dist/shaders/appearance_field_bounds.js';
import { textureLocalVariationQueryWgsl } from '../../../OEngine/.test-dist/shaders/texture_local_variation_query.js';
import { TextureVariationResidency } from '../../../OEngine/.test-dist/gpu/TextureVariationResidency.js';
import { buildTextureLocalVariation, queryTextureLocalVariation } from '../../../OEngine/.test-dist/texture/TextureLocalVariation.js';

if(!process.argv[2])throw new Error('Pass existing external WebGPU runtime directory');
const {create,globals}=createRequire(resolve(process.argv[2],'package.json'))('webgpu');Object.assign(globalThis,globals);
const gpu=create(['backend=d3d12']),adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
assert.ok(adapter&&!adapter.info.isFallbackAdapter);const device=await adapter.requestDevice();
const errors=[],keepAlive=setInterval(()=>{},1000);device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
let disposing=false,loss=null;void device.lost.then(i=>{if(!disposing)loss=i.message;});
const report={evidenceRole:'diagnostic',passed:false,cases:[],apiErrors:errors};
const destroy=[];let owner;
try{
 device.pushErrorScope('validation');
 const g=new AppearanceGraphBuilder(),uv=g.input('uv0',2,'surface',undefined,'uv0');
 const binding={texture:{},source:{},contentVersion:'fixture',decode:'linear-rgb',sampler:Array(9).fill(0),offset:[0,0],scale:[1,1],rotation:0,fallback:[1,1,1,1],range:{low:0,high:1}};
 const tex=g.texture(binding,uv),rgb=g.swizzle(tex,[0,1,2]);
 const scaled=g.operation('multiply',rgb,g.parameter('factor',[3,1,.2]));g.output('baseColor',scaled);
 const zero=g.constant(0),one=g.constant(1),orm=g.operation('clamp',g.operation('multiply',g.swizzle(tex,[1]),g.parameter('roughness',.8)),zero,one);g.output('roughness',orm);
 g.output('normalTS',g.operation('subtract',g.operation('multiply',rgb,g.constant(2)),one));
 const dynamic=g.input('animated',1,'dynamic');g.output('dynamic',g.operation('multiply',dynamic,g.swizzle(tex,[0])));
 g.output('zero',g.operation('multiply',dynamic,zero));
 const scalar=g.input('scalar',1,'geometry'),scalar2=g.input('scalar2',1,'geometry');
 g.output('divide',g.operation('divide',one,scalar));g.output('trig',g.operation('sin',scalar));
 g.output('sqrt',g.operation('sqrt',scalar));g.output('pow',g.operation('pow',scalar,scalar2));
 const graph=compileAppearanceGraph(g.build()),lowered=lowerAppearanceWgsl(graph),bounds=lowerAppearanceFieldBounds(graph,lowered);
 assert.equal(bounds.supported.dynamic,false);assert.equal(bounds.supported.roughness,true);
 const names=Object.keys(graph.outputs),inputIndex=Object.fromEntries(graph.inputs.map((v,i)=>[v.name,i]));
 const width=16,height=8,mips=3,texels=[],texture=device.createTexture({size:[width,height],mipLevelCount:mips,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});destroy.push(texture);
 for(let mip=0;mip<mips;mip++){
  const w=width>>mip,h=height>>mip,bytes=Uint8Array.from({length:w*h*4},(_,i)=>((i%4)*37+Math.floor(i/4)*11+mip*13)%256);
  device.queue.writeTexture({texture,mipLevel:mip},bytes,{bytesPerRow:w*4},{width:w,height:h});
  texels.push({width:w,height:h,rgba:Float32Array.from(bytes,x=>x/255)});
 }
 const tree=buildTextureLocalVariation(texels,4);
 const fixtures=[
  {name:'local linear clamp',uv:[.1,.1,.2,.2],lod:[0,0],wrap:0,filters:3,scalar:[.2,.3],scalar2:[.5,.6]},
  {name:'repeat negative seam with trilinear',uv:[-.06,-.1,.12,.2],lod:[.4,.7],wrap:2,filters:3,scalar:[1,2],scalar2:[-1,2]},
  {name:'mirror support across three segments',uv:[-.01,.01,1.7,.9],lod:[1,1],wrap:1,filters:1,scalar:[0,1],scalar2:[1,2]},
  {name:'nearest mip and texel',uv:[.61,.31,.62,.32],lod:[.3,.3],wrap:2,filters:0,scalar:[1.5,1.7],scalar2:[0,1]},
  {name:'division singular local unknown',uv:[.05,.05,.08,.08],lod:[0,0],wrap:0,filters:3,scalar:[-.1,.1],scalar2:[.5,.5]},
  {name:'sqrt negative local unknown',uv:[.5,.3,.51,.31],lod:[2,2],wrap:0,filters:3,scalar:[-2,-1],scalar2:[1,1]},
  {name:'sine interior extrema',uv:[.2,.2,.21,.21],lod:[0,0],wrap:0,filters:3,scalar:[1,2],scalar2:[2,3]},
 ];
 const data=new Uint32Array(fixtures.length*12),fdata=new Float32Array(data.buffer);
 fixtures.forEach((q,i)=>{fdata.set(q.uv,i*12);fdata.set(q.lod,i*12+4);data[i*12+6]=q.wrap;data[i*12+7]=q.filters;fdata.set([...q.scalar,...q.scalar2],i*12+8);});
 const encoder=device.createCommandEncoder(),transient=[],finish=[],abort=[];
 const command={device,closed:false,onFinished:{addOne(f){finish.push(f);}},onAborted:{addOne(f){abort.push(f);}},
  allocateTransientBuffer(usage,size){const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});transient.push(b);return b;},
  writeBuffer(target,offset,array,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(array,start,size));b.unmap();transient.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);},
  beginComputePass(options){return encoder.beginComputePass(options);}};
 owner=new TextureVariationResidency(device,8);assert.equal(owner.stage(command,{slot:1,generation:7,revision:9,texture,layer:0,width,height,mipCount:mips,availableMip:0,decodeSrgb:false}),true);
 const input=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),constants=device.createBuffer({size:lowered.constants.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});destroy.push(input,constants);
 device.queue.writeBuffer(input,0,data);device.queue.writeBuffer(constants,0,Float32Array.from(lowered.constants));
 const rows=fixtures.length*(names.length+1),result=device.createBuffer({size:rows*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),staging=device.createBuffer({size:rows*48,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});destroy.push(result,staging);
 const source=`
  @group(0) @binding(0) var<storage,read> texture_variation:array<u32>;
  @group(0) @binding(1) var<storage,read> input_data:array<vec4u>;
  @group(0) @binding(2) var<storage,read> constants:array<f32>;
  @group(0) @binding(3) var<storage,read_write> result:array<AppearanceBound4>;
  ${APPEARANCE_FIELD_BOUND_WGSL}
  ${textureLocalVariationQueryWgsl()}
  fn ab_constant(context:vec4u,slot:u32)->f32{return constants[slot];}
  fn ab_input(context:vec4u,index:u32,channel:u32)->AppearanceBound{
   let values=bitcast<vec4f>(input_data[context.x*3u]);
   if index==${inputIndex.uv0}u{return AppearanceBound(values[channel],values[channel+2u],1u);}
   let scalar=bitcast<vec4f>(input_data[context.x*3u+2u]);
   if index==${inputIndex.scalar}u{return AppearanceBound(scalar.x,scalar.y,1u);}
   if index==${inputIndex.scalar2}u{return AppearanceBound(scalar.z,scalar.w,1u);}
   return ab_unknown();
  }
  fn ab_input_gradient(context:vec4u,index:u32,channel:u32,axis:u32)->AppearanceBound{return ab_exact(0.0);}
  fn ab_texture(context:vec4u,sample:u32,u:AppearanceBound,v:AppearanceBound,udx:AppearanceBound,udy:AppearanceBound,vdx:AppearanceBound,vdy:AppearanceBound)->AppearanceBound4{
   if !ab_valid(u)||!ab_valid(v){return AppearanceBound4(vec4f(0),vec4f(0),vec4u(0));}
   let data=input_data[context.x*3u+1u];let query=tv_query(vec3u(1u,7u,9u),vec2f(u.low,v.low),vec2f(u.high,v.high),bitcast<vec2f>(data.xy),vec2u(data.z),data.w);
   return AppearanceBound4(query.low,query.high,vec4u(query.known));
  }
  fn ab_product(context:vec4u,index:u32,u:AppearanceBound,v:AppearanceBound)->AppearanceBound4{return AppearanceBound4(vec4f(0),vec4f(0),vec4u(0));}
  ${bounds.source}
  @compute @workgroup_size(64) fn evaluate(@builtin(global_invocation_id) id:vec3u){
   if id.x>=${rows}u{return;}
   let fixture=id.x/${names.length+1}u;let field=id.x%${names.length+1}u;
   if field<${names.length}u{result[id.x]=ab_field(field,vec4u(fixture,0u,0u,0u));}
   else{
    let u=bitcast<vec4f>(input_data[fixture*3u]);let data=input_data[fixture*3u+1u];
    let query=tv_query(vec3u(1u,7u,9u),u.xy,u.zw,bitcast<vec2f>(data.xy),vec2u(data.z),data.w);
    result[id.x]=AppearanceBound4(query.low,query.high,vec4u(query.known));
   }
  }`;
 const module=device.createShaderModule({code:source}),info=await module.getCompilationInfo();assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'evaluate'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:owner.buffer}},{binding:1,resource:{buffer:input}},{binding:2,resource:{buffer:constants}},{binding:3,resource:{buffer:result}}]});
 const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(rows/64));pass.end();encoder.copyBufferToBuffer(result,0,staging,0,result.size);
 device.queue.submit([encoder.finish()]);for(const callback of finish)callback();await staging.mapAsync(GPUMapMode.READ);
 const words=new Uint32Array(staging.getMappedRange()).slice(),values=new Float32Array(words.buffer);staging.unmap();
 const wrapModes=['clamp-to-edge','mirror-repeat','repeat'];
 for(let fixture=0;fixture<fixtures.length;fixture++){
  const q=fixtures[fixture],channel=(field,c)=>{const at=(fixture*(names.length+1)+names.indexOf(field))*12;return {low:values[at+c],high:values[at+c+4],known:words[at+c+8]};};
  const expected=queryTextureLocalVariation(tree,{minU:q.uv[0],minV:q.uv[1],maxU:q.uv[2],maxV:q.uv[3],lod:q.lod[0],wrapU:wrapModes[q.wrap],wrapV:wrapModes[q.wrap],filter:q.filters&1?'linear':'nearest',mipFilter:q.filters&2?'linear':'nearest'});
  const queryAt=(fixture*(names.length+1)+names.length)*12;
  for(let c=0;c<4;c++){assert.equal(words[queryAt+8+c],1);assert.ok(Math.abs(values[queryAt+c]-expected.low[c])<2e-7);assert.ok(Math.abs(values[queryAt+4+c]-expected.high[c])<2e-7);}
  // Independent point evaluations over input box, including internal extrema.
  for(let s=0;s<=128;s++){
   const t=s/128,x=q.scalar[0]+(q.scalar[1]-q.scalar[0])*t,e=q.scalar2[0]+(q.scalar2[1]-q.scalar2[0])*(1-t);
   const check=(field,value,c=0)=>{const bound=channel(field,c);if(bound.known){assert.ok(value>=bound.low-1e-6&&value<=bound.high+1e-6,`${q.name} ${field}: ${value} outside ${bound.low} ${bound.high}`);}};
   for(let c=0;c<3;c++){const texel=expected.low[c]+(expected.high[c]-expected.low[c])*t;check('baseColor',texel*[3,1,.2][c],c);check('normalTS',texel*2-1,c);}
   check('roughness',Math.min(1,Math.max(0,(expected.low[1]+(expected.high[1]-expected.low[1])*t)*.8)));
   if(x!==0)check('divide',1/x);check('trig',Math.sin(x));if(x>=0)check('sqrt',Math.sqrt(x));if(x>0)check('pow',x**e);
  }
  assert.equal(channel('dynamic',0).known,0);assert.deepEqual(channel('zero',0),{low:0,high:0,known:1});
  if(q.name.startsWith('division'))assert.equal(channel('divide',0).known,0);
  if(q.name.startsWith('sqrt'))assert.equal(channel('sqrt',0).known,0);
  report.cases.push({name:q.name,fields:names.length,localSummaryNodes:expected.nodesRead});
 }
 assert.equal(await device.popErrorScope(),null);assert.deepEqual(errors,[]);assert.equal(loss,null);report.passed=true;
 for(const b of transient)b.destroy();
}finally{
 await mkdir('.local/validation/surface-optimization-v1',{recursive:true});await writeFile('.local/validation/surface-optimization-v1/appearance-bound-gpu-oracle.json',JSON.stringify(report,null,2));
 for(const b of destroy)b.destroy();owner?.destroy();disposing=true;device.destroy();clearInterval(keepAlive);
}
console.log(JSON.stringify(report));
