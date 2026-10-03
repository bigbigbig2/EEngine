import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {FrameGraph,FrameGraphContext,FrameGraphResourceManager} from '../../../OEngine/.test-dist/framegraph/FrameGraph.js';
import {SurfaceCellGeometrySetup} from '../../../OEngine/.test-dist/render/surface/SurfaceCellGeometrySetup.js';
import {packGpuInstanceRecord} from '../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js';
import {GPU_FRAME_INSTANCE_STRIDE,GPU_FRAME_INSTANCE_OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuFrameInstanceAbi.js';
import {GPU_GEOMETRY_RECORD_SCHEMA,GPU_MESHLET_RECORD_SCHEMA} from '../../../OEngine/.test-dist/gpu/GpuGeometryAbi.js';
import {SURFACE_CELL_GEOMETRY_SETUP_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';
import {GPUBufferAllocator} from '../../../OEngine/.test-dist/gpu/GPUBufferAllocator.js';

if(!process.argv[2])throw new Error('Pass external runtime directory');
const {create,globals}=createRequire(resolve(process.argv[2],'package.json'))('webgpu');Object.assign(globalThis,globals);
const gpu=create(['backend=d3d12']),adapter=await gpu.requestAdapter({powerPreference:'high-performance'});assert.ok(adapter&&!adapter.info.isFallbackAdapter);
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:13}});
const errors=[],keepAlive=setInterval(()=>{},1000);device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
let loss=null,disposing=false;void device.lost.then(i=>{if(!disposing)loss=i.message;});
const report={evidenceRole:'diagnostic',passed:false,apiErrors:errors};const retained=[];let context,owner,allocator;
try{
 device.pushErrorScope('validation');
 const buffer=(values,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)=>{const b=device.createBuffer({size:values.byteLength,usage});device.queue.writeBuffer(b,0,values);retained.push(b);return b;};
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const instances=new Uint8Array(GPU_FRAME_INSTANCE_STRIDE);instances.set(packGpuInstanceRecord({geometryRecordIndex:1,geometryGeneration:3,instanceSetGeneration:7,materialHandle:0,flags:1,debugId:0,
  boundsSphere:[0,0,0,2],boundsMin:[-1,-1,0,0],boundsMax:[1,1,1,0],currentObjectToWorld:identity,previousObjectToWorld:identity,dynamicRevision:1}));
 const instanceFloats=new Float32Array(instances.buffer);instanceFloats.set(identity,GPU_FRAME_INSTANCE_OFFSETS.objectToClip/4);
 instanceFloats.set([1,0,0,1,0,1,0,0,0,0,1,0],GPU_FRAME_INSTANCE_OFFSETS.normalX/4);new DataView(instances.buffer).setUint32(GPU_FRAME_INSTANCE_OFFSETS.generation,11,true);
 const attributes=new Uint32Array(144),attributeFloats=new Float32Array(attributes.buffer);attributes.set([0,1,2,3]);
 new Uint8Array(attributes.buffer).set([0,1,2,2,1,3],16);
 const positions=[[-1,-1,.5],[1,-1,.5],[-1,1,.5],[1,1,.5]];
 positions.forEach((p,v)=>{const at=8+v*24;attributeFloats.set([0,0,1,1,1,0,0,1,(p[0]+1)/2,(p[1]+1)/2,(p[0]+1)/2,(p[1]+1)/2,1,1,1,1,0,0,0,0,...p,1],at);});
 for(let triangle=0;triangle<2;triangle++)attributes.set([7,8,9,10,11,12,0,0],112+triangle*16);
 const source=new Uint32Array((GPU_GEOMETRY_RECORD_SCHEMA.stride+GPU_MESHLET_RECORD_SCHEMA.stride)/4);
 const geom=(name,value)=>source[GPU_GEOMETRY_RECORD_SCHEMA.offsets[name]/4]=value;
 const mesh=(name,value)=>source[GPU_GEOMETRY_RECORD_SCHEMA.stride/4+GPU_MESHLET_RECORD_SCHEMA.offsets[name]/4]=value;
 geom('resident_attribute_word_offset',8);mesh('vertex_offset',0);mesh('vertex_count',4);mesh('triangle_byte_offset',0);mesh('triangle_count',2);mesh('surface_metadata_word_offset',112);mesh('surface_metadata_version',2);
 const meshlets=new Uint32Array([1,1,0,1,0,11,0,0,0,0,0,0,0,0]);
 const visibility=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(visibility);
 device.queue.writeTexture({texture:visibility},Uint32Array.from({length:64},(_,i)=>(i%2)<<24),{bytesPerRow:32},{width:8,height:8});
 const graph=new FrameGraph('diagnostic actual cell Geometry owner'),imported=(name,value)=>graph.import_resource(name,{kind:'imported'},value);
 owner=new SurfaceCellGeometrySetup(device);
 const product=owner.addToGraph(graph,{visibility:imported('visibility',visibility),meshletWork:imported('work',buffer(meshlets)),sourceHeap:imported('source',buffer(source)),vertexPayload:imported('attributes',buffer(attributes)),frameInstances:imported('instances',buffer(instances)),product:null,
  width:8,height:8,tilesX:1,firstTile:0,tileCount:1,targetCapacity:64,generation:11,sourceGeometry:0,sourceMeshlet:GPU_GEOMETRY_RECORD_SCHEMA.stride/4,sourceMeshletVertices:0,sourceMeshletTriangles:4,sourceVertexData:0});
 const sizes=[32,16,product.setupCapacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES,product.dictionaryCapacity*8];
 const staging=sizes.map(size=>{const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});retained.push(b);return b;});
 const capture=graph.add('diagnostic copy',{},(_data,resources,ctx)=>{
  [product.counts,product.indirect,product.arena,product.arena].forEach((id,i)=>ctx.gpu_encoder.copyBufferToBuffer(resources.get(id),i===2?product.dictionaryCapacity*8:0,staging[i],0,sizes[i]));
 });for(const id of [product.counts,product.indirect,product.arena])capture.read(id);capture.make_side_effect();
 const encoder=device.createCommandEncoder(),transient=[];
 const command={device,gpu_encoder:encoder,beginComputePass(options){return encoder.beginComputePass(options);},
  writeBuffer(target,offset,data,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data,start,size));b.unmap();transient.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);}};
 let complete;const gpuDone=new Promise(resolve=>{complete=resolve;});
 allocator=new GPUBufferAllocator(device);
 context=new FrameGraphContext({device,encoder:command,graphics:{device,buffer_allocator_main:allocator,allocator_textures:{}},resource_manager:new FrameGraphResourceManager(device,gpuDone)});const compiled=graph.compile();
 report.frameGraph=compiled.dump().passes.map(p=>({name:p.name,culled:p.culled}));compiled.execute(context);
 device.queue.submit([encoder.finish()]);await Promise.all(staging.map(b=>b.mapAsync(GPUMapMode.READ)));
 const [counts,indirect,setups,dictionary]=staging.map(b=>{const data=new Uint32Array(b.getMappedRange()).slice();b.unmap();return data;});complete();
 report.counts=[...counts];report.indirect=[...indirect];
 const validation=await device.popErrorScope();report.validationError=validation?.message??null;assert.equal(validation,null,validation?.message);
 assert.deepEqual([...counts.subarray(0,5)],[2,2,0,0,0]);assert.deepEqual([...indirect],[1,1,1,2]);
 const floats=new Float32Array(setups.buffer),winners=[];
 for(let slot=0;slot<2;slot++){
  const at=slot*128;assert.deepEqual([...setups.subarray(at,at+3)],[0,7,0]);assert.equal(setups[at+6],3);assert.equal(setups[at+7],1);
  assert.deepEqual([...setups.subarray(at+8,at+14)],[7,8,9,10,11,12]);assert.equal(floats[at+24+3],1);
  [0,0,1,-.5].forEach((expected,c)=>assert.ok(Math.abs(floats[at+108+c]-expected)<1e-6));winners.push(setups[at+4]);
 }
 assert.deepEqual(winners.sort((a,b)=>a-b),[0,1<<24]);
 let entries=0;for(let i=0;i<dictionary.length;i+=2)if(dictionary[i]!==0xffffffff){assert.ok(dictionary[i+1]<2);assert.equal(setups[dictionary[i+1]*128+4],dictionary[i]);entries++;}assert.equal(entries,2);
 assert.deepEqual(errors,[]);assert.equal(loss,null);
 report.passed=true;report.uniqueWinners=2;report.coveredPixels=64;report.setupWritesBytes=2*SURFACE_CELL_GEOMETRY_SETUP_BYTES;report.frameGraph=compiled.dump().passes.map(p=>p.name);
 for(const b of transient)b.destroy();compiled.destroy();
}finally{
 await mkdir('.local/validation/surface-optimization-v1',{recursive:true});await writeFile('.local/validation/surface-optimization-v1/cell-geometry-gpu-oracle.json',JSON.stringify(report,null,2));
 context?.resource_manager.destroy();allocator?.destroy();owner?.destroy();for(const b of retained)b.destroy();disposing=true;device.destroy();clearInterval(keepAlive);
}
console.log(JSON.stringify(report));
