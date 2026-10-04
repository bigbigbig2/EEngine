import {FrameGraph,FrameGraphContext,FrameGraphResourceManager} from '../../../OEngine/.test-dist/framegraph/FrameGraph.js';
import {SurfaceCellGeometrySetup} from '../../../OEngine/.test-dist/render/surface/SurfaceCellGeometrySetup.js';
import {packGpuInstanceRecord} from '../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js';
import {GPU_FRAME_INSTANCE_STRIDE,GPU_FRAME_INSTANCE_OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuFrameInstanceAbi.js';
import {GPU_GEOMETRY_RECORD_SCHEMA,GPU_MESHLET_RECORD_SCHEMA} from '../../../OEngine/.test-dist/gpu/GpuGeometryAbi.js';
import {SURFACE_CELL_GEOMETRY_SETUP_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';
import {GPUBufferAllocator} from '../../../OEngine/.test-dist/gpu/GPUBufferAllocator.js';
import {surfaceCellWorkspaceLayout} from "../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js";

export async function runGeometryOracle(gpu,assert,onStage=()=>{}) {
 const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
 const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
 const retained=[],errors=[],report={passed:false,apiErrors:errors,evidenceRole:'diagnostic'};
 device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 let context,allocator,owner,compiled;
 try {
 device.pushErrorScope('validation');
 const buffer=(values,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)=>{const b=device.createBuffer({size:values.byteLength,usage});device.queue.writeBuffer(b,0,values);retained.push(b);return b;};
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const instances=new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);instances.set(packGpuInstanceRecord({geometryRecordIndex:1,geometryGeneration:3,instanceSetGeneration:7,materialHandle:0,flags:1,debugId:0,
  boundsSphere:[0,0,0,2],boundsMin:[-1,-1,0,0],boundsMax:[1,1,1,0],currentObjectToWorld:identity,previousObjectToWorld:identity,dynamicRevision:1}));
 const instanceFloats=new Float32Array(instances.buffer);instanceFloats.set(identity,GPU_FRAME_INSTANCE_OFFSETS.objectToClip/4);
 instanceFloats.set([1,0,0,1,0,1,0,0,0,0,1,0],GPU_FRAME_INSTANCE_OFFSETS.normalX/4);new DataView(instances.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation,11,true);
 const attributes=new Uint32Array(160+64*16),attributeFloats=new Float32Array(attributes.buffer);attributes.set([0,1,2,3]);
 new Uint8Array(attributes.buffer).set(Uint8Array.from({length:64*3},(_,i)=>i%3),16);
 const positions=[[-1,-1,.5],[1,-1,.5],[-1,1,.5],[1,1,.5]];
 positions.forEach((p,v)=>{const at=64+v*24;attributeFloats.set([0,0,1,1,1,0,0,1,(p[0]+1)/2,(p[1]+1)/2,(p[0]+1)/2,(p[1]+1)/2,1,1,1,1,0,0,0,0,...p,1],at);});
 for(let triangle=0;triangle<64;triangle++)attributes.set([7,8,9,10,11,12,0,0],160+triangle*16);
 const source=new Uint32Array((GPU_GEOMETRY_RECORD_SCHEMA.stride+GPU_MESHLET_RECORD_SCHEMA.stride)/4);
 const geom=(name,value)=>source[GPU_GEOMETRY_RECORD_SCHEMA.offsets[name]/4]=value;
 const mesh=(name,value)=>source[GPU_GEOMETRY_RECORD_SCHEMA.stride/4+GPU_MESHLET_RECORD_SCHEMA.offsets[name]/4]=value;
 geom('resident_attribute_word_offset',64);mesh('vertex_offset',0);mesh('vertex_count',4);mesh('triangle_byte_offset',0);mesh('triangle_count',64);mesh('surface_metadata_word_offset',160);mesh('surface_metadata_version',2);
 const meshlets=new Uint32Array([1,1,0,1,0,11,0,0,0,0,0,0,0,0]);

 const graph=new FrameGraph('Guaranteed local Geometry and real memo');
 const imported=(name,value)=>graph.import_resource(name,{kind:'imported'},value);
 const geometryInputs={meshletWork:imported('work',buffer(meshlets)),sourceHeap:imported('source',buffer(source)),vertexPayload:imported('attributes',buffer(attributes)),frameInstances:imported('instances',buffer(instances))};
 const workspaceWords=new Uint32Array(surfaceCellWorkspaceLayout(1).bytes/4);workspaceWords.set([0,0,0xffffffff,0xffffffff],128);
 const workspace=imported('workspace',buffer(workspaceWords));
 const activeIndirect=imported('actual indirect',buffer(new Uint32Array([1,1,1,1]),GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST));
 owner=new SurfaceCellGeometrySetup(device);
 const captures=[];
 let after=[];
 const patterns=[['unique64',Uint32Array.from({length:64},(_,i)=>(63-i)<<24)],['memo warm',Uint32Array.from({length:64},(_,i)=>(63-i)<<24)],['memo full',Uint32Array.from({length:64},(_,i)=>(63-i)<<24)],['uniform',new Uint32Array(64).fill(7<<24)],['mixed partial',Uint32Array.from({length:64},(_,i)=>i%3===0?0xffffffff:(i%4)<<24)]];
 for(const [batch,[name,pixels]] of patterns.entries()) {
  const visibility=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(visibility);
  device.queue.writeTexture({texture:visibility},pixels,{bytesPerRow:32},{width:8,height:8});
  const setup=owner.addToGraph(graph,{...geometryInputs,visibility:imported(name,visibility),workspace,activeIndirect,product:null,width:8,height:8,tilesX:1,firstTile:batch,tileCount:1,targetCapacity:64,generation:11,sourceGeometry:0,sourceMeshlet:GPU_GEOMETRY_RECORD_SCHEMA.stride/4,sourceMeshletVertices:0,sourceMeshletTriangles:4,sourceVertexData:0,after});
  const bytes=32+setup.referenceCapacity*8+setup.setupCapacity*512;
  const staging=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(staging);captures.push({name,pixels,staging,setup});
  const capture=graph.add('Observe real local slots '+name,{},(_data,resources,context)=>{
    context.encoder.gpu_encoder.copyBufferToBuffer(resources.get(setup.counts),0,staging,0,32);
    context.encoder.gpu_encoder.copyBufferToBuffer(resources.get(setup.arena),0,staging,32,bytes-32);
  });capture.read(setup.counts);capture.read(setup.arena);capture.make_side_effect();
  const token=capture.write(imported('capture '+name,staging));after=[token];
  if(batch===1) {
    const module=device.createShaderModule({code:'@group(0) @binding(0) var<storage,read_write> memo:array<atomic<u32>>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if id.x>=64u{return;}atomicStore(&memo[id.x*132u],2u);atomicStore(&memo[id.x*132u+1u],0xffffffffu);atomicStore(&memo[id.x*132u+2u],11u);}'});
    const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
    const full=graph.add('Force full optional memo without touching local work',{},(_data,resources,context)=>{
      const pass=context.encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:resources.get(setup.memo)}}]}));pass.dispatchWorkgroups(1);pass.end();
    });full.read(token);full.read(setup.memo);after=[full.write(setup.memo)];
  }
 }
 onStage('Compiling real Geometry run, build, memo publication and consumption');
 const encoder=device.createCommandEncoder(),transient=[];
 const command={device,gpu_encoder:encoder,beginComputePass:options=>encoder.beginComputePass(options),writeBuffer(target,offset,data,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data,start,size));b.unmap();transient.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);}};
 let complete;const done=new Promise(resolve=>complete=resolve);
 allocator=new GPUBufferAllocator(device);context=new FrameGraphContext({device,encoder:command,graphics:{device,buffer_allocator_main:allocator,allocator_textures:{}},resource_manager:new FrameGraphResourceManager(device,done)});
 compiled=graph.compile();compiled.execute(context);device.queue.submit([encoder.finish()]);
 const validation=await device.popErrorScope();assert.equal(validation,null,validation?.message);assert.deepEqual(errors,[]);
 await Promise.all(captures.map(capture=>capture.staging.mapAsync(GPUMapMode.READ)));complete();
 report.cases=[];
 for(const {name,pixels,staging,setup} of captures) {
   const words=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();
   const count=words[0],base=8+setup.referenceCapacity*2;
   const winners=new Set([...pixels].filter(key=>key!==0xffffffff));assert.equal(count,winners.size,name+' complete run capacity');
   for(let lane=0;lane<64;lane++) {
     const key=words[8+lane*2],slot=words[8+lane*2+1];assert.equal(key,pixels[lane]);
     if(key===0xffffffff){assert.equal(slot,0xffffffff);continue;}
     assert.ok(slot<count);assert.equal(words[base+slot*128+4],key,'Reference reads its actual built winner');
     assert.equal(new Float32Array(words.buffer)[base+slot*128+27],1,'Interpolation coefficients are valid');
   }
   if(name==='memo warm'){assert.ok(words[5]>0);assert.equal(words[5]+words[6],64);}
   if(name==='memo full'){assert.equal(words[5],0);assert.equal(words[6],64);assert.equal(words[7],64);}
   report.cases.push({name,local:count,valid:words[1],memoHits:words[5],decodes:words[6],rejectedMemo:words[7]});
 }
 report.passed=true;for(const b of transient)b.destroy();
 }catch(error){report.failure=error.stack??String(error);}finally{compiled?.destroy();context?.resource_manager.destroy();allocator?.destroy();owner?.destroy();for(const b of retained)b.destroy();device.destroy();}
 return report;
}
