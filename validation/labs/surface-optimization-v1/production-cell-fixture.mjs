import {FrameGraph,FrameGraphContext,FrameGraphResourceManager} from '../../../OEngine/.test-dist/framegraph/FrameGraph.js';
import {GPUBufferAllocator} from '../../../OEngine/.test-dist/gpu/GPUBufferAllocator.js';
import {SurfaceCellGeometrySetup} from '../../../OEngine/.test-dist/render/surface/SurfaceCellGeometrySetup.js';
import {packGpuInstanceRecord} from '../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js';
import {GPU_FRAME_INSTANCE_STRIDE,GPU_FRAME_INSTANCE_OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuFrameInstanceAbi.js';
import {GPU_GEOMETRY_RECORD_SCHEMA,GPU_MESHLET_RECORD_SCHEMA} from '../../../OEngine/.test-dist/gpu/GpuGeometryAbi.js';
import {GpuAppearancePublication} from '../../../OEngine/.test-dist/gpu/GpuAppearancePublication.js';
import {GpuAppearanceCache} from '../../../OEngine/.test-dist/gpu/GpuAppearanceCache.js';
import {AppearanceProgramRegistry} from '../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js';
import {StandardShadeMaterial} from '../../../OEngine/.test-dist/material/StandardShadeMaterial.js';
import {compileCanonicalMaterial} from '../../../OEngine/.test-dist/material/CanonicalMaterial.js';
import {ShadeTexture} from '../../../OEngine/.test-dist/texture/ShadeTexture.js';
import {ShadeImage} from '../../../OEngine/.test-dist/texture/ShadeImage.js';
import {Sampler2D} from '../../../OEngine/.test-dist/texture/Sampler2D.js';
import {encodeGpuTextureRef} from '../../../OEngine/.test-dist/gpu/GpuTextureRefAbi.js';
import {TextureVariationResidency} from '../../../OEngine/.test-dist/gpu/TextureVariationResidency.js';
import {surfaceCellWorkspaceLayout,SURFACE_CELL_TILE_PLAN_BYTES,SURFACE_CELL_PLANE_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {surfaceCellClassifyStageWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_classify.js';
import {surfaceCellProductionFactsWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_production_facts.js';
import {createSurfaceCellPipelineLayout} from '../../../OEngine/.test-dist/render/surface/SurfaceCellPipelineLayout.js';
import {SURFACE_CELL_CLASSIFY_STAGES} from '../../../OEngine/.test-dist/shaders/surface_cell_group_validation.js';


export async function runProductionCellOracle(gpu,assert,onStage=()=>{},onSource=()=>{},withOrm=false) {
const {SURFACE_CELL_LIGHTING_RISK_WGSL}=await import('../../../OEngine/.test-dist/shaders/surface_cell_lighting_risk.js');
const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});assert.ok(adapter&&!adapter.info.isFallbackAdapter);
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
const errors=[],keepAlive=setInterval(()=>{},1000);device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
let disposing=false,loss=null;void device.lost.then(i=>{if(!disposing)loss=i.message;});
const report={evidenceRole:'diagnostic',passed:false,apiErrors:errors},retained=[];
let owner,registry,cache,publication,variation,allocator,context;
try{
 const buffer=(data,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)=>{const b=device.createBuffer({size:data.byteLength,usage});device.queue.writeBuffer(b,0,data);retained.push(b);return b;};
 const encoder=device.createCommandEncoder(),transient=[],before=[],finished=[],aborted=[];
 let complete;const gpuDone=new Promise(resolve=>{complete=resolve;});
 const command={device,closed:false,gpu_encoder:encoder,gpuDone,
  onBeforeFinish:{addOne(f){before.push(f);}},onFinished:{addOne(f){finished.push(f);}},onAborted:{addOne(f){aborted.push(f);}},
  allocateTransientBuffer(usage,size){const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});transient.push(b);return b;},
  beginComputePass(options){return encoder.beginComputePass(options);},
  writeBuffer(target,offset,data,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data,start,size));b.unmap();transient.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);}};
 const material=new StandardShadeMaterial();material.roughness_factor=.8;
 const sourceTexture=ShadeTexture.from(ShadeImage.fromSampler2D(new Sampler2D(new Uint8Array([64,64,64,255]),4,1,1)));
 material.texture_albedo=sourceTexture;
 const ormTexture=ShadeTexture.from(ShadeImage.fromSampler2D(new Sampler2D(new Uint8Array([128,255,64,255]),4,1,1)));
 if(withOrm){material.texture_orm=ormTexture;material.metallic_factor=.5;}
 const materialProgram=compileCanonicalMaterial(material).appearance;
 registry=new AppearanceProgramRegistry(device);cache=new GpuAppearanceCache(device);
 publication=new GpuAppearancePublication(device,registry,[{material,materialSlot:0,textureBindingSetId:0,program:materialProgram,textureRefs:new Map([[sourceTexture,encodeGpuTextureRef(0,1)],...(withOrm?[[ormTexture,encodeGpuTextureRef(0,2)]]:[])])}],command,
  new Map([[sourceTexture,[0,0]],...(withOrm?[[ormTexture,[0,0]]]:[])]),new Map([[sourceTexture,{slot:1,generation:7,revision:9,localVariationSlot:1,variation:{known:true,low:[64/255,64/255,64/255,1],high:[64/255,64/255,64/255,1]}}],...(withOrm?[[ormTexture,{slot:2,generation:11,revision:13,localVariationSlot:2,variation:{known:true,low:[128/255,1,64/255,1],high:[128/255,1,64/255,1]}}]]:[])]),undefined,undefined,cache);
 await publication.ready;
 device.pushErrorScope('validation');
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],instances=new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);
 instances.set(packGpuInstanceRecord({geometryRecordIndex:1,geometryGeneration:3,instanceSetGeneration:7,materialHandle:0,flags:1,debugId:0,boundsSphere:[0,0,0,2],boundsMin:[-1,-1,0,0],boundsMax:[1,1,1,0],currentObjectToWorld:identity,previousObjectToWorld:identity,dynamicRevision:1}));
 const instanceFloats=new Float32Array(instances.buffer);instanceFloats.set(identity,GPU_FRAME_INSTANCE_OFFSETS.objectToClip/4);
 instanceFloats.set([1,0,0,1,0,1,0,0,0,0,1,0],GPU_FRAME_INSTANCE_OFFSETS.normalX/4);new DataView(instances.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation,11,true);
 const attributes=new Uint32Array(144),attributeFloats=new Float32Array(attributes.buffer);attributes.set([0,1,2,3]);new Uint8Array(attributes.buffer).set([0,1,2,2,1,3],16);
 const positions=[[-1,-1,.5],[1,-1,.5],[-1,1,.5],[1,1,.5]];
 positions.forEach((p,v)=>attributeFloats.set([0,0,1,1,1,0,0,1,(p[0]+1)/2,(p[1]+1)/2,(p[0]+1)/2,(p[1]+1)/2,1,1,1,1,0,0,0,0,...p,1],8+v*24));
 for(let triangle=0;triangle<2;triangle++)attributes.set([7,8,9,10,11,12,0,0],112+triangle*16);
 const source=new Uint32Array((GPU_GEOMETRY_RECORD_SCHEMA.stride+GPU_MESHLET_RECORD_SCHEMA.stride)/4);
 source[GPU_GEOMETRY_RECORD_SCHEMA.offsets.resident_attribute_word_offset/4]=8;
 const mesh=(name,value)=>source[GPU_GEOMETRY_RECORD_SCHEMA.stride/4+GPU_MESHLET_RECORD_SCHEMA.offsets[name]/4]=value;
 mesh('vertex_offset',0);mesh('vertex_count',4);mesh('triangle_byte_offset',0);mesh('triangle_count',2);mesh('surface_metadata_word_offset',112);mesh('surface_metadata_version',2);
 const geometryInputs={meshletWork:buffer(new Uint32Array([1,1,0,1,0,11,0,0,0,0,0,0,0,0])),sourceHeap:buffer(source),vertexPayload:buffer(attributes),frameInstances:buffer(instances)};
 const visibility=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(visibility);
 device.queue.writeTexture({texture:visibility},Uint32Array.from({length:64},(_,i)=>(i%2)<<24),{bytesPerRow:32},{width:8,height:8});
 const texture=device.createTexture({size:[8,8,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(texture);
 device.queue.writeTexture({texture,origin:[0,0,1]},Uint8Array.from({length:8*8*4},(_,i)=>i%4===3?255:64),{bytesPerRow:32},{width:8,height:8,depthOrArrayLayers:1});
 variation=new TextureVariationResidency(device,8);assert.equal(variation.stage(command,{slot:1,generation:7,revision:9,texture,layer:1,width:8,height:8,mipCount:1,availableMip:0,decodeSrgb:true}),true);
 if(withOrm){
  const ormGpu=device.createTexture({size:[8,8,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(ormGpu);
  device.queue.writeTexture({texture:ormGpu,origin:[0,0,1]},Uint8Array.from({length:8*8*4},(_,i)=>[128,255,64,255][i%4]),{bytesPerRow:32},{width:8,height:8,depthOrArrayLayers:1});
  assert.equal(variation.stage(command,{slot:2,generation:11,revision:13,texture:ormGpu,layer:1,width:8,height:8,mipCount:1,availableMip:0,decodeSrgb:false}),true);
 }
 const cameraValues=new Float32Array(164);for(let i=0;i<8;i++)cameraValues.set(identity,i*16);cameraValues[14]=100;cameraValues[32+14]=-100;
 const camera=buffer(cameraValues,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const graph=new FrameGraph('diagnostic production cell facts'),imported=(name,value)=>graph.import_resource(name,{kind:'imported'},value);
 owner=new SurfaceCellGeometrySetup(device);
 const geometry=owner.addToGraph(graph,{visibility:imported('visibility',visibility),...Object.fromEntries(Object.entries(geometryInputs).map(([name,b])=>[name,imported(name,b)])),product:null,
  width:8,height:8,tilesX:1,firstTile:0,tileCount:1,targetCapacity:64,generation:11,sourceGeometry:0,sourceMeshlet:GPU_GEOMETRY_RECORD_SCHEMA.stride/4,sourceMeshletVertices:0,sourceMeshletTriangles:4,sourceVertexData:0});
 const workspaceLayout=surfaceCellWorkspaceLayout(1),workspace=buffer(new Uint32Array(workspaceLayout.bytes/4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
 const cellSettings=buffer(new Uint32Array([8,8,1,0,1,64,11,1]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const o=publication.surfaceMetadataOffsets;
 const factSettings=buffer(new Uint32Array([0,GPU_GEOMETRY_RECORD_SCHEMA.stride/4,0,4,0,0,0,0,o.constants,o.routes,o.bounds,o.directory,o.materialLookup,o.materialLookupCount,o.directoryCount,publication.surfaceCacheGeneration,
  geometry.dictionaryCapacity,geometry.setupCapacity,11,1,o.constantFields,2,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const lightRecords=buffer(new Uint32Array(32768).fill(0xffffffff));
 const clusterLookup=buffer(new Uint32Array(24*4)),clusterData=buffer(new Uint32Array([0,0,32,0,0,0,0,0,...Array(32).fill(0)])),clusterParameters=buffer(new Float32Array([0,1,1,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const fullFacts=surfaceCellProductionFactsWgsl(publication.surfaceBoundPrograms,false,SURFACE_CELL_LIGHTING_RISK_WGSL,null,geometry.dictionaryCapacity);
 const fullModule=device.createShaderModule({code:surfaceCellClassifyStageWgsl(fullFacts,1,0,0,3,'classify_cells_base',false)});
 const ranges=SURFACE_CELL_CLASSIFY_STAGES.map(({first,count})=>[first,count]);
 const fieldFacts=surfaceCellProductionFactsWgsl(publication.surfaceBoundPrograms,false,SURFACE_CELL_LIGHTING_RISK_WGSL,null,geometry.dictionaryCapacity,null,false);
 const fieldModule=device.createShaderModule({code:surfaceCellClassifyStageWgsl(fieldFacts,1,0,0,0,'unused_field_classifier',false)});
 const modules=ranges.map(([start,count],index)=>{const facts=surfaceCellProductionFactsWgsl(publication.surfaceBoundPrograms,false,SURFACE_CELL_LIGHTING_RISK_WGSL,null,geometry.dictionaryCapacity,new Set(),false);return device.createShaderModule({code:surfaceCellClassifyStageWgsl(facts,1,index,start,count,`classify_cells_stage_${index}`,start>=15?'full':'field-geometry')});});
 const moduleInfo=await Promise.all([fullModule,fieldModule,...modules].map(module=>module.getCompilationInfo()));
 report.compilation=moduleInfo.flatMap(info=>info.messages.filter(m=>m.type==='error').map(m=>({message:m.message,line:m.lineNum})));
 await onSource(surfaceCellClassifyStageWgsl(surfaceCellProductionFactsWgsl(publication.surfaceBoundPrograms,false,SURFACE_CELL_LIGHTING_RISK_WGSL,null,geometry.dictionaryCapacity,new Set([0]),false),1,0,0,1,'classify_cells_stage_0','field-geometry')); assert.deepEqual(report.compilation,[]);
 const pipelines={};
 const productionLayout=createSurfaceCellPipelineLayout(device,false);
 for(const entryPoint of ['publish_cell_material_constants','publish_cell_facts','publish_cell_geometry_certificates','publish_cell_field_certificates']){
  onStage(`Compiling ${entryPoint}`);const start=performance.now();
  pipelines[entryPoint]=await device.createComputePipelineAsync({layout:entryPoint==='publish_cell_material_constants'?'auto':productionLayout,compute:{module:entryPoint==='publish_cell_field_certificates'?fieldModule:fullModule,entryPoint}});
  onStage(`Compiled ${entryPoint} in ${Math.round(performance.now()-start)} ms`);
 }
 pipelines.classify=[];
 for(let index=0;index<modules.length;index++){
  const entryPoint=`classify_cells_stage_${index}`;onStage(`Compiling ${entryPoint}`);const start=performance.now();
  pipelines.classify[index]=await device.createComputePipelineAsync({layout:productionLayout,compute:{module:modules[index],entryPoint}});
  onStage(`Compiled ${entryPoint} in ${Math.round(performance.now()-start)} ms`);
 }
 const all=[
  [{binding:0,resource:{buffer:cellSettings}},{binding:1,resource:visibility.createView()},{binding:2,resource:{buffer:workspace}}],
  [{binding:0,resource:{buffer:factSettings}},{binding:1,resource:null},{binding:3,resource:{buffer:geometryInputs.meshletWork}},{binding:4,resource:{buffer:geometryInputs.sourceHeap}},{binding:5,resource:{buffer:geometryInputs.vertexPayload}},{binding:6,resource:{buffer:geometryInputs.frameInstances}},
   {binding:7,resource:{buffer:publication.surfaceMetadata}},{binding:8,resource:{buffer:variation.buffer}},{binding:14,resource:{buffer:camera}}],
  [{binding:0,resource:{buffer:lightRecords}},{binding:1,resource:{buffer:clusterLookup}},{binding:2,resource:{buffer:clusterData}},{binding:3,resource:{buffer:clusterParameters}}]
 ];
 // Each auto layout exposes only the bindings actually consumed by that stage.
 const stages=[['publish_cell_material_constants',pipelines.publish_cell_material_constants,[],[0,7],[]],['publish_cell_facts',pipelines.publish_cell_facts,[0,1,2],[0,1,3,4,5,6,7,8,14],[0,1,2,3]],['publish_cell_geometry_certificates',pipelines.publish_cell_geometry_certificates,[0,1,2],[0,1,3,4,5,6,7,8,14],[0,1,2,3]],['publish_cell_field_certificates',pipelines.publish_cell_field_certificates,[0,1,2],[0,1,3,4,5,6,7,8,14],[0,1,2,3]],...pipelines.classify.map((pipeline,index)=>[`classify_cells_stage_${index}`,pipeline,[0,1,2],[0,1,3,4,5,6,7,8,14],[0,1,2,3]])];
 let previous=null;
 for(const [name,pipeline,b0,b1,b2] of stages){
  const pass=graph.add(name,{},(_data,resources)=>{
   all[1].find(v=>v.binding===1).resource={buffer:resources.get(geometry.arena)};
   const compute=encoder.beginComputePass({label:name});compute.setPipeline(pipeline);
   for(const [group,bindings] of [b0,b1,b2].entries()){
    const entries=all[group].filter(v=>bindings.includes(v.binding));
   if(entries.length)compute.setBindGroup(group,device.createBindGroup({layout:pipeline.getBindGroupLayout(group),entries}));
   }
   compute.dispatchWorkgroups(1);compute.end();
   });pass.read(geometry.arena);if(previous)pass.dependsOn(previous);previous=pass;pass.make_side_effect();
 }
 const staging=device.createBuffer({size:workspace.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(staging);
 const palette=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(palette);
 const capture=graph.add('capture',{},()=>{encoder.copyBufferToBuffer(workspace,0,staging,0,workspace.size);encoder.copyBufferToBuffer(publication.surfaceMetadata,o.constantFields*4,palette,0,256);});capture.dependsOn(previous);capture.make_side_effect();
 allocator=new GPUBufferAllocator(device);context=new FrameGraphContext({device,encoder:command,graphics:{device,buffer_allocator_main:allocator,allocator_textures:{}},resource_manager:new FrameGraphResourceManager(device,gpuDone)});
 const compiled=graph.compile();compiled.execute(context);for(const f of before)f();command.closed=true;device.queue.submit([encoder.finish()]);for(const f of finished)f();
 await Promise.all([staging,palette].map(b=>b.mapAsync(GPUMapMode.READ)));complete();
 const words=new Uint32Array(staging.getMappedRange()).slice(),constantWords=new Uint32Array(palette.getMappedRange()).slice();staging.unmap();palette.unmap();
 const validation=await device.popErrorScope();report.validationError=validation?.message??null;assert.equal(validation,null,validation?.message);
 report.counts=[...words.subarray(0,128)];report.constantMask=constantWords[0];report.exactMask=constantWords[1];
 const plane=field=>{const at=workspaceLayout.plans/4+16+field*SURFACE_CELL_PLANE_BYTES/4;return {mode:words[at]&255,rate:words[at]>>>8,slots:words[at+3]};};
 report.base=plane(0);report.roughness=plane(3);report.diffuseEnvironment=plane(16);report.specularEnvironment=plane(18);report.coat=plane(20);
 assert.equal(words[104],0);assert.equal(words[105],0);assert.ok(words[106]>0);
 report.certificates={geometry:words[108],fields:words[109],contexts:words[110],textureNodes:words[106],textureQueries:words[111],textureReuses:words[112]};
 if(withOrm){assert.equal(words[111],64);assert.ok(words[112]>=64);report.ormShared=true;}else{assert.equal(words[111],32);}
 assert.equal(words[108],32);assert.equal(words[109],32);assert.equal(words[110],64);
 assert.equal(report.base.mode,3);assert.equal(report.base.slots,4);assert.equal(report.roughness.mode,withOrm?3:1);assert.equal(report.roughness.slots,withOrm?4:0);
 assert.equal(report.diffuseEnvironment.slots,1);assert.ok(report.specularEnvironment.slots<=16);assert.equal(report.coat.mode,0);assert.equal(report.coat.slots,0);
 assert.ok(words[0*4+2]>0);assert.ok(words[16*4+2]>0);assert.deepEqual(errors,[]);assert.equal(loss,null);report.passed=true;
 for(const b of transient)b.destroy();compiled.destroy();
}catch(error){report.failure=error?.stack??String(error);}finally{

 context?.resource_manager.destroy();allocator?.destroy();owner?.destroy();publication?.destroy();cache?.destroy();registry?.destroy();variation?.destroy();for(const b of retained)b.destroy();disposing=true;device.destroy();clearInterval(keepAlive);
}

return report;
}
