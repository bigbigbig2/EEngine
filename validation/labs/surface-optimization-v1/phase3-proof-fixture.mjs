import {TextureVariationResidency} from '../../../OEngine/.test-dist/gpu/TextureVariationResidency.js';
import {textureLocalVariationQueryWgsl} from '../../../OEngine/.test-dist/shaders/texture_local_variation_query.js';
export async function runProofOracle(gpu,assert,onStage=()=>{}) {
 const adapter=await gpu.requestAdapter({powerPreference:'high-performance'}),device=await adapter.requestDevice();
 const kept=[],errors=[],report={passed:false,evidenceRole:'diagnostic',apiErrors:errors};device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 let variation;
 try {
 device.pushErrorScope('validation');
 const texture=device.createTexture({size:[1024,1024,2],mipLevelCount:11,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});kept.push(texture);
 for(let mip=0;mip<11;mip++){const size=1024>>mip;device.queue.writeTexture({texture,mipLevel:mip,origin:[0,0,1]},new Uint8Array(size*size*4).fill(128),{bytesPerRow:size*4},{width:size,height:size,depthOrArrayLayers:1});}
 const encoder=device.createCommandEncoder(),before=[],finished=[],aborted=[];
 let complete;const gpuDone=new Promise(resolve=>complete=resolve);
 const command={device,gpu_encoder:encoder,gpuDone,closed:false,onBeforeFinish:{addOne:fn=>before.push(fn)},onFinished:{addOne:fn=>finished.push(fn)},onAborted:{addOne:fn=>aborted.push(fn)},
 beginComputePass:options=>encoder.beginComputePass(options),allocateTransientBuffer(usage,size){const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});kept.push(b);return b;},
 writeBuffer(target,offset,data,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data,start,size));b.unmap();kept.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);}};
 variation=new TextureVariationResidency(device,8);assert.equal(variation.stage(command,{slot:1,generation:7,revision:9,texture,layer:1,width:1024,height:1024,mipCount:11,availableMip:0,decodeSrgb:false}),true);
 const module=device.createShaderModule({code:`@group(0) @binding(0) var<storage,read> texture_variation:array<u32>;@group(0) @binding(1) var<storage,read_write> output:array<vec4u>;${textureLocalVariationQueryWgsl('texture_variation',32)}
@compute @workgroup_size(1) fn main(){let local=tv_query(vec3u(1u,7u,9u),vec2f(.1),vec2f(.11),vec2f(0.0),vec2u(2u),3u);let full=tv_query(vec3u(1u,7u,9u),vec2f(-.4),vec2f(.6),vec2f(0.0,10.0),vec2u(2u),3u);let stale=tv_query(vec3u(1u,7u,11u),vec2f(.1),vec2f(.11),vec2f(0.0),vec2u(2u),3u);output[0]=vec4u(local.known,local.visits,bitcast<u32>(local.low.x),bitcast<u32>(local.high.x));output[1]=vec4u(full.known,full.visits,full.nodes,full.exhausted);output[2]=vec4u(stale.known,stale.nodes,0u,0u);}`});
 assert.deepEqual((await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
 onStage('Actual decoded variation hierarchy -> bounded 32-visit query');
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const output=device.createBuffer({size:48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),staging=device.createBuffer({size:48,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});kept.push(output,staging);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:variation.buffer}},{binding:1,resource:{buffer:output}}]});
 const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,staging,0,48);for(const fn of before)fn();device.queue.submit([encoder.finish()]);for(const fn of finished)fn();
 const error=await device.popErrorScope();assert.equal(error,null,error?.message);assert.deepEqual(errors,[]);await staging.mapAsync(GPUMapMode.READ);complete();const words=new Uint32Array(staging.getMappedRange()).slice(),values=new Float32Array(words.buffer);staging.unmap();
 assert.equal(words[0],1);assert.ok(words[1]<=32);report.raw=[...words];report.localRange=[values[2],values[3]];const uploaded=Math.fround(128/255);assert.ok(values[2]<=uploaded&&values[3]>=uploaded,'Interval encloses the uploaded normalized f32 texel');
 assert.equal(words[4],0,'Exhaustion produces Unknown instead of a truncated interval');assert.equal(words[5],32);assert.equal(words[8],0,'Stale texture version cannot prove support');
 report.cases=[{name:'local',known:words[0],visits:words[1],range:[values[2],values[3]]},{name:'exhausted',known:words[4],visits:words[5]},{name:'stale',known:words[8],visits:words[9]}];report.passed=true;
 }catch(error){report.failure=error.stack??String(error);}finally{variation?.destroy();for(const b of kept)b.destroy();device.destroy();}
 return report;
}
