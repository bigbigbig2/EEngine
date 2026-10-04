import {GpuSurfaceFieldStore} from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldStore.js';
import {GpuSurfaceSignalStore} from '../../../OEngine/.test-dist/gpu/GpuSurfaceSignalStore.js';
import {SurfaceDependencyEpochPass} from '../../../OEngine/.test-dist/render/surface/SurfaceDependencyEpochPass.js';
import {SurfaceDemandPass} from '../../../OEngine/.test-dist/render/surface/SurfaceDemandPass.js';
import {SurfaceGeometryPass} from '../../../OEngine/.test-dist/render/surface/SurfaceGeometryPass.js';
import {SurfaceLightingPass} from '../../../OEngine/.test-dist/render/surface/SurfaceLightingPass.js';
import {SurfaceStorePublishPass} from '../../../OEngine/.test-dist/render/surface/SurfaceStorePublishPass.js';
import {SurfaceReconstructionPass} from '../../../OEngine/.test-dist/render/surface/SurfaceReconstructionPass.js';
import {SurfaceFrameResources} from '../../../OEngine/.test-dist/render/surface/SurfaceFrameResources.js';
import {GPUTextureAllocator} from '../../../OEngine/.test-dist/gpu/GPUTextureAllocator.js';
import {SurfaceSignalLookupPass} from '../../../OEngine/.test-dist/render/surface/SurfaceSignalLookupPass.js';
import {FrameGraph,FrameGraphContext,FrameGraphResourceManager} from '../../../OEngine/.test-dist/framegraph/FrameGraph.js';
import {GPUBufferAllocator} from '../../../OEngine/.test-dist/gpu/GPUBufferAllocator.js';
import {SurfaceCellGeometrySetup} from '../../../OEngine/.test-dist/render/surface/SurfaceCellGeometrySetup.js';
import {packGpuInstanceRecord} from '../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js';
import {GPU_FRAME_INSTANCE_STRIDE,GPU_FRAME_INSTANCE_OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuFrameInstanceAbi.js';
import {GPU_GEOMETRY_RECORD_SCHEMA,GPU_MESHLET_RECORD_SCHEMA} from '../../../OEngine/.test-dist/gpu/GpuGeometryAbi.js';
import {GpuAppearancePublication} from '../../../OEngine/.test-dist/gpu/GpuAppearancePublication.js';
import {AppearanceProgramRegistry} from '../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js';
import {StandardShadeMaterial} from '../../../OEngine/.test-dist/material/StandardShadeMaterial.js';
import {compileCanonicalMaterial} from '../../../OEngine/.test-dist/material/CanonicalMaterial.js';
import {ShadeTexture} from '../../../OEngine/.test-dist/texture/ShadeTexture.js';
import {ShadeImage} from '../../../OEngine/.test-dist/texture/ShadeImage.js';
import {Sampler2D} from '../../../OEngine/.test-dist/texture/Sampler2D.js';
import {encodeGpuTextureRef} from '../../../OEngine/.test-dist/gpu/GpuTextureRefAbi.js';
import {TextureVariationResidency} from '../../../OEngine/.test-dist/gpu/TextureVariationResidency.js';
import {surfaceCellWorkspaceLayout,surfaceCellWorkspaceWgsl,SURFACE_CELL_TILE_PLAN_BYTES,SURFACE_CELL_PLANE_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {SURFACE_FIELD_LOOKUP_WGSL} from '../../../OEngine/.test-dist/shaders/surface_field_lookup.js';
import {surfaceCellClassifyStageWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_classify.js';
import {surfaceCellProductionFactsWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_production_facts.js';
import {createSurfaceCellPipelineLayout} from '../../../OEngine/.test-dist/render/surface/SurfaceCellPipelineLayout.js';
import {SURFACE_CELL_CLASSIFY_STAGES,SURFACE_CELL_CERTIFICATE_FAMILIES} from '../../../OEngine/.test-dist/shaders/surface_cell_group_validation.js';


import {SurfaceCellClassifierPass} from '../../../OEngine/.test-dist/render/surface/SurfaceCellClassifierPass.js';
import {AppearanceGraphBuilder} from '../../../OEngine/.test-dist/material/AppearanceGraph.js';
import {compileAppearanceGraph} from '../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js';
import {SURFACE_EXECUTION_WORDS,SURFACE_FIELD_EXECUTION_WORDS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceExecutionProfileAbi.js';
import {surfaceCoverageLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCoverageAbi.js';
import {DIRECTIONAL_LIGHT_DESCRIPTOR,DIRECTIONAL_LIGHT_RECORD_TYPE} from '../../../OEngine/.test-dist/gpu/LightDatabase.js';
export async function runPhaseOneOracle(gpu,assert,onStage=()=>{},options={}) {
 const withOrm=true;
 const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});assert.ok(adapter&&!adapter.info.isFallbackAdapter);
 const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
 const errors=[],retained=[],modules=[],phase5Captures=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 const nativeModule=device.createShaderModule.bind(device);device.createShaderModule=descriptor=>{const module=nativeModule(descriptor);modules.push([descriptor.label,module]);return module;};
 if(options.phase5) {
   const nativePipeline=device.createComputePipeline.bind(device);
   device.createComputePipeline=descriptor=>{
     const label=descriptor.label??descriptor.compute.entryPoint;
     onStage(`Creating production pipeline: ${label}`);
     const pipeline=nativePipeline(descriptor);
     onStage(`Created production pipeline: ${label}`);
     return pipeline;
   };
 }
 const report={passed:false,evidenceRole:'diagnostic',apiErrors:errors};
 let publication,registry,variation,allocator,context,compiled;
 try {
 device.pushErrorScope('validation');
 const buffer=(data,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)=>{const b=device.createBuffer({size:data.byteLength,usage});device.queue.writeBuffer(b,0,data);retained.push(b);return b;};
 let encoder=device.createCommandEncoder();const transient=[],before=[],finished=[],aborted=[];
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
 registry=new AppearanceProgramRegistry(device);
 const unlit=new StandardShadeMaterial();
 const unlitGraph=new AppearanceGraphBuilder();unlitGraph.output('alpha',unlitGraph.constant([1]));unlitGraph.output('baseColor',unlitGraph.constant([.1,.2,.3]));unlitGraph.output('emissive',unlitGraph.constant([.03,.02,.01]));
 const unlitProgram=compileAppearanceGraph(unlitGraph.build());
 const full=new StandardShadeMaterial();full.texture_albedo=sourceTexture;full.texture_orm=ormTexture;full.metallic_factor=.5;
 const canonicalFull=compileCanonicalMaterial(full).appearance;
 const validRoot=canonicalFull.instructions.findIndex(node=>node.kind==='constant'&&node.value===1);
 assert.ok(validRoot>=0);
 const fullProgram=Object.freeze({...canonicalFull,outputs:Object.freeze({...canonicalFull.outputs,normalTSValidity:[validRoot],coatNormalTSValidity:[validRoot]}),
   outputMasks:Object.freeze({...canonicalFull.outputMasks,normalTSValidity:1,coatNormalTSValidity:1})});
 publication=new GpuAppearancePublication(device,registry,[
   {material,materialSlot:0,textureBindingSetId:0,program:materialProgram,textureRefs:new Map([[sourceTexture,encodeGpuTextureRef(0,1)],[ormTexture,encodeGpuTextureRef(1,1)]])},
   {material:unlit,materialSlot:1,textureBindingSetId:0,program:unlitProgram,textureRefs:new Map()},
   {material:full,materialSlot:2,textureBindingSetId:0,program:fullProgram,textureRefs:new Map([[sourceTexture,encodeGpuTextureRef(0,1)],[ormTexture,encodeGpuTextureRef(1,1)]])}
 ],command,new Map(),new Map([[sourceTexture,{slot:1,generation:7,revision:9}],[ormTexture,{slot:2,generation:11,revision:13}]]));
 await publication.ready;

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
 const geometryInputs={meshletWork:buffer(new Uint32Array([3,3,0,3,0,11,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,2,0,0])),sourceHeap:buffer(source),vertexPayload:buffer(attributes),frameInstances:buffer(instances)};
 const visibility=device.createTexture({size:[25,9],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(visibility);
 const width=25,height=9;
 const visibilityPixels=new Uint32Array(width*height).fill(0xffffffff);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const tile=(y>>3)*4+(x>>3);
   if([0,2,5,7].includes(tile))visibilityPixels[y*width+x]=((x&1)<<24)|(tile===0?1:tile===2?(x&1):tile===5?2:1);
 }
 device.queue.writeTexture({texture:visibility},visibilityPixels,{bytesPerRow:width*4},{width,height});

 const texture=device.createTexture({size:[8,8,2],format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(texture);
 device.queue.writeTexture({texture,origin:[0,0,1]},Uint8Array.from({length:8*8*4},(_,i)=>i%4===3?255:64),{bytesPerRow:32},{width:8,height:8,depthOrArrayLayers:1});
 // Resident sampling expects decoded linear RGB. Hardware sRGB decode supplies
 // that contract in this fixture; variation must not decode the same view twice.
 variation=new TextureVariationResidency(device,8);assert.equal(variation.stage(command,{slot:1,generation:7,revision:9,texture,layer:1,width:8,height:8,mipCount:1,availableMip:0,decodeSrgb:false}),true);
 const ormGpu=device.createTexture({size:[8,8,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(ormGpu);
 if(withOrm){
  device.queue.writeTexture({texture:ormGpu,origin:[0,0,1]},Uint8Array.from({length:8*8*4},(_,i)=>[128,255,64,255][i%4]),{bytesPerRow:32},{width:8,height:8,depthOrArrayLayers:1});
  assert.equal(variation.stage(command,{slot:2,generation:11,revision:13,texture:ormGpu,layer:1,width:8,height:8,mipCount:1,availableMip:0,decodeSrgb:false}),true);
 }
 const cameraValues=new Float32Array(164);for(let i=0;i<8;i++)cameraValues.set(identity,i*16);cameraValues[14]=100;cameraValues[32+14]=-100;
 const camera=buffer(cameraValues,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);

 const o=publication.surfaceMetadataOffsets;
 const graph=new FrameGraph('Phase 1 production profile and active work');
 const imported=(name,value)=>graph.import_resource(name,{kind:'imported'},value);
 const bind=(_name,resolve)=>resolve();
 const scratch=new SurfaceFrameResources(device);scratch.prepare(width,height);
 const geometryOwner=new SurfaceGeometryPass(device,scratch);
 const fieldStore=options.fieldStore?new GpuSurfaceFieldStore(device,8*1024**2+16*256):null;
 const signalStore=options.signalStore?new GpuSurfaceSignalStore(device,256*352):null;
 const classifier=new SurfaceCellClassifierPass(device,scratch,fieldStore,signalStore);
 const dependency=options.fieldStore?new SurfaceDependencyEpochPass(device,fieldStore):null;
 const demandOwner=new SurfaceDemandPass(device,scratch);
 const lightingOwner=new SurfaceLightingPass(device,scratch);
 const publishOwner=new SurfaceStorePublishPass(device);
 const reconstructOwner=new SurfaceReconstructionPass(device);reconstructOwner.prepareFrame(width,height,2);
 retained.push({destroy(){classifier.destroy();fieldStore?.destroy();signalStore?.destroy();dependency?.destroy();geometryOwner.destroy();demandOwner.destroy();lightingOwner.destroy();publishOwner.destroy();reconstructOwner.destroy();scratch.destroy();}});
 const fieldValueBuffers=[];
 const ids=Object.fromEntries(Object.entries(geometryInputs).map(([name,value])=>[name,imported(name,value)]));
 const visibilityId=imported('visibility',visibility),versionsId=imported('versions',publication.fields),cameraId=imported('camera',camera);
 let metadataId=imported('metadata',publication.surfaceMetadata);
 if(dependency)metadataId=dependency.addToGraph(graph,{metadata:metadataId,versions:imported('real resident revisions',buffer(new Uint32Array([0,9,13]))),publication,bind});
 const lightWords=new Uint32Array(32768);lightWords.fill(0xffffffff);
 if(options.phase5) {
   const descriptor=DIRECTIONAL_LIGHT_DESCRIPTOR,page=8000;
   lightWords[descriptor.page_lookup_address]=page;
   lightWords.fill(0,page,page+descriptor.page_header_words);lightWords[page+1]=1;
   const floats=new Float32Array(lightWords.buffer),record=page+descriptor.page_header_words;
   for(const field of DIRECTIONAL_LIGHT_RECORD_TYPE.fields) {
     const at=record+field.offset/4;
     if(field.name==='direction')floats.set([0,0,-1],at);
     else if(field.name==='color')floats.set([4,2,1],at);
     else lightWords[at]=0;
   }
 }
 const lightId=imported('light records',buffer(lightWords));
 const clusters={parameters:imported('cluster parameters',buffer(new Float32Array([0,1,1,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)),
   lookup:imported('cluster lookup',buffer(new Uint32Array(24*4))),data:imported('cluster data',buffer(new Uint32Array([0,0,32,0,0,0,0,0,...Array(32).fill(0)]))),
   activeLightList:imported('active light list',buffer(new Uint32Array(256)))};
 const env=device.createTexture({size:[2,2],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(env);
 const envPixels=new Uint16Array(16);for(let i=0;i<4;i++)envPixels.set([0x3800,0x3800,0x3800,0x3c00],i*4);
 device.queue.writeTexture({texture:env},envPixels,{bytesPerRow:16},{width:2,height:2});
 const envId=imported('environment',env);
 const facts=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});retained.push(facts);
 const factsId=imported('TemporalFacts',facts),exposureId=imported('exposure',buffer(new Float32Array([1]))),bankId=imported('texture bank',texture),ormBankId=imported('ORM bank',ormGpu);
 let final;const captures=[];
 onStage('Building real classifier → demand → geometry → appearance → lighting → reconstruct');
 const cells=classifier.addToGraph(graph,{resourceBinding:bind,geometryPass:geometryOwner,visibility:visibilityId,...ids,camera:cameraId,
   textureVariation:imported('texture variation',variation.buffer),appearanceMetadata:metadataId,fieldVersions:versionsId,viewRevision:{value:1},signalRevisions:{environment:1,light:1,shadow:0,sun:0},
   sun:null,shadowVersion:null,width,height,generation:11,frameAt:0,directoryAt:0,sourceGeometry:0,sourceMeshlet:GPU_GEOMETRY_RECORD_SCHEMA.stride/4,
   sourceMeshletVertices:0,sourceMeshletTriangles:4,sourceVertexData:0,publication,product:null,lightRecords:lightId,clusters,shadowEnabled:false,physicalSunEnabled:false,targetCapacity:128,diagnosticsEnabled:true,
   consumeBatch(cells,firstTile,tileCount,batchTiles){
    const request={workspace:cells.workspace,activeIndirect:cells.activeIndirect,fieldStore:cells.fieldStore,signalStore:cells.signalStore,
      metadata:metadataId,versions:versionsId,publication,targets:128,leaves:tileCount*64,epoch:{value:1},viewRevision:{value:1},revisions:{environment:1,light:1,shadow:0,sun:0},
      sun:null,shadow:null,firstTile,width,height,diagnostics:true,bind};
    let demand=demandOwner.addToGraph(graph,request);
    const geometry=geometryOwner.addToGraph(graph,{demand,camera:cameraId,bind});
    const values=buffer(new Float32Array(demand.layout.fieldCapacity*4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);const valuesId=imported(`field values ${firstTile}`,values);
    fieldValueBuffers.push(values);
    const materialNode=graph.add('Real Appearance closures',{demand,geometry},(data,resources)=>publication.encodeSurfaceFields(command,{
      geometry:resources.get(data.geometry.records),demand:resources.get(data.demand.arena),indirect:resources.get(data.demand.indirect),values,layout:data.demand.layout,
      textureBanks:[[texture.createView({dimension:'2d-array'}),ormGpu.createView({dimension:'2d-array'})]]}));
    materialNode.read(geometry.records);materialNode.read(demand.arena);materialNode.read(demand.indirect);materialNode.read(bankId);materialNode.read(ormBankId);materialNode.write(valuesId);
    demand=publishOwner.addToGraph(graph,{...request,demand,values:valuesId,signal:false,entries:fieldStore?.capacity.entries??4,enabled:fieldStore!==null});
    const lighting=lightingOwner.addToGraph(graph,{resourceBinding:bind,demand,geometry:geometry.records,fields:valuesId,appearanceMetadata:metadataId,
      constantFieldsOffset:o.constantFields,width,height,frame:11,camera:cameraId,physicalSun:null,lightRecords:lightId,clusters,shadow:null,scalarAo:null,
      environment:{diffuse:envId,specular:envId,dfg:envId},diagnosticsEnabled:true});
    demand=publishOwner.addToGraph(graph,{...request,demand:lighting.demand,values:lighting.values,signal:true,entries:signalStore?.capacity.entries??4,enabled:signalStore!==null});
    final=reconstructOwner.addToGraph(graph,{signalValues:lighting.values,signalStore:demand.signalStore,fieldStore:demand.fieldStore,fields:valuesId,
      reactive:factsId,preExposure:exposureId,cellWorkspace:demand.workspace,cellBatchTiles:batchTiles,coverage:cells.coverage,activeIndirect:cells.activeIndirect,
      firstTile,appearanceMetadata:metadataId,constantFieldsOffset:o.constantFields,scalarAo:null,width,height,recordCount:128,diagnosticsEnabled:true,batch:{index:firstTile/batchTiles,batchTiles},previous:final});
    const size=surfaceCellWorkspaceLayout(batchTiles).bytes;
    const captureBuffer=device.createBuffer({size:size+16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(captureBuffer);captures.push(captureBuffer);
    let extra;
    if (options.phase5) {
      const arenaBytes=demand.layout.bytes,signalBytes=demand.layout.signalCapacity*16;
      extra=device.createBuffer({size:arenaBytes+signalBytes+values.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      retained.push(extra);phase5Captures.push({buffer:extra,layout:demand.layout});
    }
    const token=imported(`capture ${firstTile}`,captureBuffer);
    const capture=graph.add('Capture consumed batch',{workspace:demand.workspace,indirect:cells.activeIndirect},(data,resources)=>{
      encoder.copyBufferToBuffer(resources.get(data.workspace),0,captureBuffer,0,size);
      encoder.copyBufferToBuffer(resources.get(data.indirect),0,captureBuffer,size,16);
      if(extra) {
        encoder.copyBufferToBuffer(resources.get(demand.arena),0,extra,0,demand.layout.bytes);
        encoder.copyBufferToBuffer(resources.get(lighting.values),0,extra,demand.layout.bytes,demand.layout.signalCapacity*16);
        encoder.copyBufferToBuffer(values,0,extra,demand.layout.bytes+demand.layout.signalCapacity*16,values.size);
      }
    });
    capture.read(demand.workspace);capture.read(demand.arena);capture.read(lighting.values);capture.read(cells.activeIndirect);capture.read(final.radiance);const captured=capture.write(token);capture.make_side_effect();
    return [final.radiance,final.reactiveMask,demand.fieldStore,demand.signalStore,captured];
   }
 });
 const coverageBytes=surfaceCoverageLayout(8).bytes;
 const coverageReadback=device.createBuffer({size:coverageBytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(coverageReadback);
 const hdrReadback=device.createBuffer({size:height*256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(hdrReadback);
 const metadataReadback=device.createBuffer({size:publication.surfaceMetadata.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(metadataReadback);
 const counterReadback=device.createBuffer({size:32,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(counterReadback);
 const capture=graph.add('Read actual coverage and complete HDR',{},(_data,resources)=>{
   encoder.copyBufferToBuffer(resources.get(cells.coverage),0,coverageReadback,0,coverageBytes);
   encoder.copyTextureToBuffer({texture:resources.get(final.radiance).gpu_texture},{buffer:hdrReadback,bytesPerRow:256},{width,height});
   encoder.copyBufferToBuffer(resources.get(final.counters),0,counterReadback,0,32);
   encoder.copyBufferToBuffer(publication.surfaceMetadata,0,metadataReadback,0,publication.surfaceMetadata.size);
 });capture.read(cells.coverage);capture.read(metadataId);capture.read(final.radiance);capture.read(final.counters);capture.make_side_effect();
 allocator=new GPUBufferAllocator(device);const textures=new GPUTextureAllocator(device);retained.push(textures);
 context=new FrameGraphContext({device,encoder:command,graphics:{device,buffer_allocator_main:allocator,allocator_textures:textures},resource_manager:new FrameGraphResourceManager(device,gpuDone)});
 compiled=graph.compile();
 onStage(`Querying compilation info for ${modules.length} current production modules`);
 const pendingModules=new Set(modules.map(([label],index)=>`${index}: ${label}`));
 report.compilation=(await Promise.all(modules.map(async([label,module],index)=>{
   const info=await module.getCompilationInfo();
   pendingModules.delete(`${index}: ${label}`);
   onStage(`Compilation pending ${pendingModules.size}: ${[...pendingModules].join(', ')}`);
   return info.messages.filter(message=>message.type==='error').map(message=>({label,message:message.message,line:message.lineNum}));
 }))).flat();
 assert.deepEqual(report.compilation,[]);
 report.modules=modules.length;report.order=compiled.dump().executablePassOrder.map(id=>compiled.dump().passes[id].name);
 report.frames=[];
 for(let frame=0;frame<(options.phase5?6:options.fieldStore?4:3);frame++){
   const numericFinished=[];
   onStage(`Executing production frame ${frame}: sparse / empty / moved`);
   if(frame>0){
     visibilityPixels.fill(0xffffffff);
     if(frame===2)for(let y=0;y<height;y++)for(let x=8;x<16;x++)visibilityPixels[y*width+x]=1;
     device.queue.writeTexture({texture:visibility},visibilityPixels,{bytesPerRow:width*4},{width,height});
     if(frame>=3)for(let y=0;y<height;y++)for(let x=0;x<width;x++){const tile=(y>>3)*4+(x>>3);if([0,2,5,7].includes(tile))visibilityPixels[y*width+x]=((x&1)<<24)|(tile===0?1:tile===2?(x&1):tile===5?2:1);}
     if(frame>=3)device.queue.writeTexture({texture:visibility},visibilityPixels,{bytesPerRow:width*4},{width,height});
     encoder=device.createCommandEncoder();command.gpu_encoder=encoder;command.closed=false;
     if(options.phase5&&frame>=4) {
       for(const entry of publication.entries)entry.material.specular_color_factor.r=frame===4?140000:1;
       publication.syncRuntime({...command,onFinished:{addOne(callback){numericFinished.push(callback);}}});
     }
   }
   if(options.phase5)for(const values of fieldValueBuffers)device.queue.writeBuffer(values,0,new Float32Array(values.size/4).fill(NaN));
   compiled.execute(context);if(frame===0)for(const callback of before)callback();command.closed=true;device.queue.submit([encoder.finish()]);if(frame===0)for(const callback of finished)callback();
   for(const callback of numericFinished)callback();
   await Promise.all([coverageReadback,hdrReadback,counterReadback,metadataReadback,...captures,...phase5Captures.map(item=>item.buffer)].map(buffer=>buffer.mapAsync(GPUMapMode.READ)));
   complete();
   const coverage=new Uint32Array(coverageReadback.getMappedRange()).slice();coverageReadback.unmap();
   const hdr=new Uint16Array(hdrReadback.getMappedRange()).slice();hdrReadback.unmap();
   const counters=new Uint32Array(counterReadback.getMappedRange()).slice();counterReadback.unmap();
   const metadata=new Uint32Array(metadataReadback.getMappedRange()).slice();metadataReadback.unmap();
   for(let entry=0;entry<publication.surfaceExecutionProfiles.length;entry++){
     const profile=publication.surfaceExecutionProfiles[entry],base=o.executionProfiles+entry*SURFACE_EXECUTION_WORDS;
     assert.equal(metadata[base],profile.token);assert.equal(metadata[base+1],profile.enabledMask);assert.equal(metadata[base+2],profile.inputMask);
     for(let field=0;field<15;field++){
       const at=base+8+field*SURFACE_FIELD_EXECUTION_WORDS;
       assert.equal(metadata[at],profile.fields[field].token);assert.equal(metadata[at+7],profile.fields[field].proof.token);
       assert.equal(metadata[at+15]>>>8,profile.fields[field].proof.qualityClass);
       assert.equal(metadata[at+19],profile.fields[field].valueCostClass);
     }
   }
   if(options.phase5) {
     assert.equal(metadata[o.radiometry],1,'Actual provider envelope was consumed');
     for(let entry=0;entry<publication.surfaceExecutionProfiles.length;entry++) {
       assert.equal(metadata[o.executionProfiles+entry*SURFACE_EXECUTION_WORDS+5],frame===4&&entry!==1?0:3,
         'Current GPU parameters, including updates, select guard semantic before lookup');
     }
   }
   const active=[...coverage.slice(68,68+coverage[0])].sort((a,b)=>a-b);
   assert.deepEqual(active,frame===0||frame>=3?[0,2,5,7]:frame===1?[]:[1,5]);
   const batches=captures.map(buffer=>{const words=new Uint32Array(buffer.getMappedRange()).slice();buffer.unmap();return words;});
   assert.deepEqual(batches.map(words=>words[127]),frame===0||frame>=3?[2,2,0,0]:frame===1?[0,0,0,0]:[2,0,0,0]);
   if(frame===0){
     assert.ok(batches.some(words=>words[126]>0),'Mixed sources use the reserved append map pool');
     const absolute=batches.flatMap(words=>Array.from({length:words[127]},(_,tile)=>words[128+tile*(SURFACE_CELL_TILE_PLAN_BYTES/4)+4])).sort((a,b)=>a-b);
     assert.deepEqual(absolute,[0,2,5,7],'All consumers retain absolute active tile addresses');
   }
   const demands=phase5Captures.map(({buffer,layout},batch)=>{
     const words=new Uint32Array(buffer.getMappedRange()).slice();buffer.unmap();
     const evaluated=new Float32Array(words.buffer),valuesAt=(layout.bytes+layout.signalCapacity*16)/4;
     const count=offset=>words[offset/4];
     let fields=0,signals=0,transportPackets=0;
     for(let leaf=0;leaf<layout.targets;leaf++) {
       const pop=value=>{let result=0;while(value){value&=value-1;result++;}return result;};
       fields+=pop(count(layout.offsets.material_masks+leaf*4));
       const missing=count(layout.offsets.material_masks+leaf*4);
       const material=batches[batch][surfaceCellWorkspaceLayout(2).facts/4+leaf*4+2];
       const linear=((64/255+0.055)/1.055)**2.4;
       const expected=[ [linear,linear,linear], [1], [0.5*64/255], [material===0?0.8:1], [128/255], [0,0,0], [0,0,1], [1.5], [1],
         [frame===4?140000:1,1,1], [0], [0], [0,0,1], [1], [1] ];
       for(let field=0;field<15;field++)if(missing&(1<<field)) {
         assert.ok(material!==1,'Constant unlit closure must not enter the material worker');
         const at=valuesAt+(leaf*15+field)*4;
         for(let channel=0;channel<expected[field].length;channel++) {
           const actual=evaluated[at+channel],reference=expected[field][channel];
           assert.ok(Number.isFinite(actual)&&Math.abs(actual-reference)<=2e-5*Math.max(1,Math.abs(reference)),
             `Independent real closure value field ${field} channel ${channel}: ${actual} vs ${reference}`);
         }
       }
       for(let field=0;field<15;field++)if((missing&(1<<field))===0) {
         const at=valuesAt+(leaf*15+field)*4;
         assert.ok(Number.isNaN(evaluated[at]),'Hit/publication/absent closure must not write a transient result');
       }
       const dirty=count(layout.offsets.lighting_masks+leaf*4);signals+=pop(dirty);
       if(dirty&1) {
         const semantic=words[layout.bytes/4+leaf*6*4+3];
         assert.ok((semantic&(frame===4?512:256))!==0,'Real Ddirect producer publishes the current guard semantic');transportPackets++;
       }
       const coverageAt=128+Math.floor(leaf/64)*(SURFACE_CELL_TILE_PLAN_BYTES/4)+2+Math.floor((leaf%64)/32);
       if((batches[batch][coverageAt]&(1<<(leaf%32)))!==0) {
         const material=batches[batch][surfaceCellWorkspaceLayout(2).facts/4+leaf*4+2];
         assert.equal(batches[batch][surfaceCellWorkspaceLayout(2).addresses/4+leaf*144+136],frame===4&&material!==1?0:3,'Semantic is chosen before lookup and rate');
       }
     }
     assert.ok(words[1]<=layout.fieldAdmissionCapacity&&words[2]<=layout.signalAdmissionCapacity);
     return {fields,signals,fieldAdmissions:words[1],signalAdmissions:words[2],transportPackets};
   });
   let visible=0;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
     const valid=visibilityPixels[y*width+x]!==0xffffffff;visible+=Number(valid);
     const at=y*128+x*4;assert.equal(hdr[at+3],valid?0x3c00:0,'Exactly one correct output writer');
     assert.ok(hdr[at]<0x7c00,'Finite HDR');if(valid)assert.ok(hdr[at]>0,'Actual consumers produce visible color');else assert.equal(hdr[at],0,'No stale background');
   }
   assert.equal(counters[0],visible);assert.equal(counters[5],width*height);
   for(const words of batches){assert.equal(words[words.length-4],words[127]);assert.ok(words[126]<=2*21*24);}
   const fieldHits=batches.reduce((sum,words)=>sum+words[113],0);
   const signalHits=batches.reduce((sum,words)=>sum+words[117],0);
   for(const words of batches)assert.ok(words[120]<=64,'All proof families share R/2');
   if(frame===3)assert.ok(fieldHits>0,'Repeated real production Appearance values are read from the FieldStore');
   if(frame===3&&options.signalStore)assert.ok(signalHits>0,'Actual selected Field sources produce reusable SignalStore identity and HDR');
   report.frames.push({frame,demands,fieldHits,signalHits,proofSlots:batches.map(words=>words[120]),active,batches:batches.map(words=>words[127]),visible,completeHdr:true});
 }
 const error=await device.popErrorScope();assert.equal(error,null,error?.message);assert.deepEqual(errors,[]);
 report.maskProfiles=publication.surfaceExecutionProfiles.map(profile=>({enabled:profile.enabledMask,input:profile.inputMask,fields:profile.fields.length,signals:profile.signals.length}));
 assert.equal(report.maskProfiles[1].enabled,35);assert.equal(report.maskProfiles[2].enabled&32767,32767);
 report.passed=true;
 for(const buffer of transient)buffer.destroy();
 }catch(error){report.failure=error.stack??String(error);}finally{
 compiled?.destroy();context?.resource_manager.destroy();allocator?.destroy();publication?.destroy();registry?.destroy();variation?.destroy();for(const resource of retained)resource.destroy();device.destroy();
 }
 return report;
}
