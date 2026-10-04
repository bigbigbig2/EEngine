import {surfaceDemandWgsl} from '../../../OEngine/.test-dist/shaders/surface_demand.js';
import {surfaceStorePublishWgsl} from '../../../OEngine/.test-dist/shaders/surface_store_publish.js';
import {surfaceGeometryRecordWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceGeometryPass.js';
import {surfaceLightingWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceLightingWorkPass.js';
import {surfaceReconstructWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceReconstructionPass.js';
import {surfaceDemandLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceDemandAbi.js';
import {surfaceCellWorkspaceLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';

const check=(condition,message)=>{if(!condition)throw new Error(message);};
export async function runDemandRepairOracle(gpu,stage) {
 const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
 check(adapter&&!adapter.info.isFallbackAdapter,'Real GPU adapter required');
 const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
 const errors=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 const retained=[];
 try {
  device.pushErrorScope('validation');
  const definitions=[
   ['demand',surfaceDemandWgsl(64,1),['emit_surface_requests','finalize_surface_requests','nominate_field_producers','resolve_field_producers','nominate_signal_producers','resolve_signal_producers','compact_surface_groups','finalize_surface_groups','order_material_groups']],
   ['geometry',surfaceGeometryRecordWgsl(64,1),['produce_geometry']],
   ['fields',surfaceStorePublishWgsl(64,1,false),['admit_surface_values','commit_surface_values','publish_surface_references']],
   ['signals',surfaceStorePublishWgsl(64,1,true),['admit_surface_values','commit_surface_values','publish_surface_references']],
   ['lighting',surfaceLightingWgsl(64,1),['build']],
   ['reconstruct',surfaceReconstructWgsl(1),['reconstruct']]
  ];
  const pipelines={};
  for(const [name,code,entries] of definitions) {
   stage(`Compile ${name}`);
   const module=device.createShaderModule({label:name,code});
   const problems=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error');
   check(problems.length===0,`${name}: ${JSON.stringify(problems.map(m=>({message:m.message,line:m.lineNum})))}`);
   pipelines[name]={};
   for(const entryPoint of entries) pipelines[name][entryPoint]=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
  }
  const buffer=(words,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC)=>{
   const result=device.createBuffer({size:words.byteLength,usage});device.queue.writeBuffer(result,0,words);retained.push(result);return result;
  };
  const workspaceLayout=surfaceCellWorkspaceLayout(1),demandLayout=surfaceDemandLayout(64,1);
  const words=new Uint32Array(workspaceLayout.bytes/4),f32=new Float32Array(words.buffer);
  for(let leaf=0;leaf<64;leaf++) words.set([0xffffffff,0xffffffff,0xffffffff,0],workspaceLayout.facts/4+leaf*4);
  for(let leaf=0;leaf<2;leaf++) {
   words.set([0,0,0,0],workspaceLayout.facts/4+leaf*4);
   const a=workspaceLayout.addresses/4+leaf*144;
   words.set([1,1,1,1,0,0,0,0,0,1,1,1,1,leaf,0,7],a);
   f32.set([.2,.3,.01,0,0,.01],a+16);f32.set([.19,.29,.21,.31],a+46);
   f32.set([.01,0,0,.01,.01,0,0,.01],a+58);words[a+93]=7;
   for(let point=0;point<3;point++) {
    f32.set([0,0,.5,1],a+94+point*4);f32.set([0,0,1,1],a+106+point*4);f32.set([1,0,0,1],a+118+point*4);
   }
   f32.set([0,0,1,-.5],a+132);
   for(let field=0;field<15;field++) words.set([field===0?0:2,0,1],workspaceLayout.fieldReferences/4+(leaf*15+field)*3);
   for(let kind=0;kind<6;kind++) words.set([kind===1?0:3,0,0],workspaceLayout.signalReferences/4+(leaf*6+kind)*3);
  }
  for(const plane of [0,16]) words.set([2,0,0,2,3,0],workspaceLayout.plans/4+16+plane*6);
  const metadataWords=new Uint32Array(200);
  for(let field=0;field<15;field++) metadataWords.set([field+1,field,0,1|(1<<9),0,0,1,1],field*8);
  const metadata=buffer(metadataWords),versions=buffer(new Uint32Array(60).fill(1));
  const workspace=buffer(words),arena=buffer(new Uint32Array(demandLayout.bytes/4),GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);
  const settings=buffer(new Uint32Array([0,128,64,4,1,1,1,1,0,0,0,0,0,1,0,0,192,1,960,384,0,1,8,8]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const sun=buffer(new Uint32Array(12),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),shadow=buffer(new Uint32Array(4));
  const resources=[settings,workspace,metadata,versions,arena,sun,shadow];
  stage('Execute actual requests, full-key aliases and independent indirect groups');
  const encoder=device.createCommandEncoder();
  for(const entry of definitions[0][2]) {
   const pipeline=pipelines.demand[entry];
   // Entry-specific auto layouts expose precisely their reachable resources.
   const candidates=entry==='finalize_surface_requests'||entry==='finalize_surface_groups'?
    (entry==='finalize_surface_groups'?[0,4]:[4]):entry==='compact_surface_groups'?[0,2,4,1]:entry==='order_material_groups'?[0,1,2,4]:
    entry.startsWith('nominate_signal')||entry.startsWith('resolve_signal')?[0,1,2,3,4,5,6]:entry==='emit_surface_requests'?[0,1,4]:[0,1,2,3,4];
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:candidates.map(binding=>({binding,resource:{buffer:resources[binding]}}))});
   const pass=encoder.beginComputePass({label:entry});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
  }
  const staging=device.createBuffer({size:arena.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(staging);
  encoder.copyBufferToBuffer(arena,0,staging,0,arena.size);device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);const result=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();
  const scope=await device.popErrorScope();check(scope===null,scope?.message);check(errors.length===0,errors.join('\n'));
  check(result[1]===2&&result[3]===1,`Field request/unique counts ${result[1]}/${result[3]}`);
  check(result[2]===2&&result[4]===1,`Signal request/unique counts ${result[2]}/${result[4]}`);
  check(result[0]===1&&result[5]===1&&result[6]===1,'Actual geometry/material/lighting union');
  check(result[demandLayout.offsets.field_aliases/4]===result[demandLayout.offsets.field_aliases/4+1],'Duplicate fields share one producer');
  const values=buffer(new Float32Array(960*4).fill(70000));
  const storeWords=new Uint32Array(4*120),store=buffer(storeWords);
  const publicationSettings=new Uint32Array([0,128,64,4,1,1,1,1,0,0,0,0,1,1,0,0]);
  const publication=buffer(publicationSettings,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const publicationResources=[publication,workspace,metadata,versions,arena,store,values];
  const runPublication=async full=>{
   if(full) {for(let entry=0;entry<4;entry++) {storeWords[entry*120+114]=2;storeWords[entry*120+115]=1;}device.queue.writeBuffer(store,0,storeWords);}
   const current=result.slice();current.fill(0xffffffff,demandLayout.offsets.field_results/4,demandLayout.offsets.field_results/4+960);device.queue.writeBuffer(arena,0,current);
   device.pushErrorScope('validation');
   const encoder=device.createCommandEncoder();
   for(const [entry,bindings] of [['admit_surface_values',[0,1,2,3,4,5,6]],['commit_surface_values',[4,5]],['publish_surface_references',[1,4,5]]]) {
    const pipeline=pipelines.fields[entry];
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:bindings.map(binding=>({binding,resource:{buffer:publicationResources[binding]}}))});
    const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
   }
   const readback=device.createBuffer({size:store.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(readback);
   const requests=device.createBuffer({size:arena.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(requests);
   encoder.copyBufferToBuffer(store,0,readback,0,store.size);encoder.copyBufferToBuffer(arena,0,requests,0,arena.size);device.queue.submit([encoder.finish()]);
   await Promise.all([readback,requests].map(b=>b.mapAsync(GPUMapMode.READ)));
   const payload=new Uint32Array(readback.getMappedRange()).slice(),outputs=new Uint32Array(requests.getMappedRange()).slice();readback.unmap();requests.unmap();
   const scope=await device.popErrorScope();check(scope===null,scope?.message);
   const producer=outputs[demandLayout.offsets.unique_fields/4],slot=outputs[demandLayout.offsets.field_results/4+producer];
   if(full) {check(slot===0xffffffff,'Pinned full Store preserves transient producer');}
   else {check(slot!==0xffffffff,'Unique producer admitted');check(payload[slot*120+114]===2,'Later commit published');check(new Float32Array(payload.buffer)[slot*120+88]===70000,'f32 HDR precision retained');}
   return {full,slot};
  };
  const publicationCases=[await runPublication(false),await runPublication(true)];
  const demandCases=[];
  for(const [name,fieldsMissing,signalsMissing,active,expected] of [
   ['empty',false,false,false,[0,0,0]],['all-hit',false,false,true,[0,0,0]],
   ['one-field-miss',true,false,true,[1,1,0]],['one-signal-dirty',false,true,true,[1,0,1]]]) {
   const next=words.slice();
   for(let leaf=0;leaf<2;leaf++) {
    if(!active)next[workspaceLayout.facts/4+leaf*4]=0xffffffff;
    for(let field=0;field<15;field++)next[workspaceLayout.fieldReferences/4+(leaf*15+field)*3]=field===0&&fieldsMissing&&leaf===0?0:2;
    for(let kind=0;kind<6;kind++)next[workspaceLayout.signalReferences/4+(leaf*6+kind)*3]=kind===1&&signalsMissing&&leaf===0?0:3;
   }
   device.queue.writeBuffer(workspace,0,next);device.queue.writeBuffer(arena,0,new Uint32Array(arena.size/4));
   device.pushErrorScope('validation');const encoder=device.createCommandEncoder();
   for(const entry of definitions[0][2]) {
    const pipeline=pipelines.demand[entry];
    const bindings=entry==='finalize_surface_requests'||entry==='finalize_surface_groups'?(entry==='finalize_surface_groups'?[0,4]:[4]):
     entry==='compact_surface_groups'?[0,1,2,4]:entry==='order_material_groups'?[0,1,2,4]:
     entry.includes('signal_producers')?[0,1,2,3,4,5,6]:entry==='emit_surface_requests'?[0,1,4]:[0,1,2,3,4];
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:bindings.map(binding=>({binding,resource:{buffer:resources[binding]}}))});
    const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
   }
   encoder.copyBufferToBuffer(arena,0,staging,0,arena.size);device.queue.submit([encoder.finish()]);
   await staging.mapAsync(GPUMapMode.READ);const counts=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();
   const scope=await device.popErrorScope();check(scope===null,scope?.message);
   check([counts[0],counts[3],counts[4]].every((value,index)=>value===expected[index]),`${name}: ${[...counts.slice(0,8)]}`);
   demandCases.push({name,counts:[...counts.slice(0,8)]});
  }
  check(errors.length===0,errors.join('\n'));
  return {passed:true,evidenceRole:'diagnostic',compiled:definitions.map(([name])=>name),counts:[...result.slice(0,8)],publicationCases,demandCases,apiErrors:errors};
 } finally { for(const resource of retained)resource.destroy();device.destroy(); }
}
