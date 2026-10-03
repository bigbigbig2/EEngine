import test from 'node:test';
import assert from 'node:assert/strict';
import '../webgpu-test-globals.mjs';
import { FrameGraph } from '../../.test-dist/framegraph/FrameGraph.js';
import { SurfaceFrameResources } from '../../.test-dist/render/surface/SurfaceFrameResources.js';
import { SurfaceCellClassifierPass } from '../../.test-dist/render/surface/SurfaceCellClassifierPass.js';
import { SurfaceCellGeometrySetup } from '../../.test-dist/render/surface/SurfaceCellGeometrySetup.js';
import { SurfaceReconstructionPass } from '../../.test-dist/render/surface/SurfaceReconstructionPass.js';
import { surfaceWorkLayout } from '../../.test-dist/gpu/GpuSurfaceWorkAbi.js';
import { SurfaceWorkRuntime } from '../../.test-dist/render/surface/SurfaceWorkRuntime.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 1, STORAGE: 2, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 16 };
function fixture() {
  const device={
    limits:{ maxBufferSize:1<<28, maxStorageBufferBindingSize:1<<27, maxStorageBuffersPerShaderStage:16, maxTextureDimension2D:8192 },
    createBuffer:d=>({...d,destroy(){}}), createShaderModule:d=>d,
    createBindGroupLayout:d=>d, createPipelineLayout:d=>d,
    createComputePipeline:d=>({...d,getBindGroupLayout:()=>({})})
  };
  const graph=new FrameGraph('bounded Surface batch consumption');
  const imported=name=>graph.import_resource(name,{kind:'imported'},{});
  const names=['visibility','meshletWork','sourceHeap','vertexPayload','frameInstances','camera','textureVariation','appearanceMetadata','lightRecords'];
  const ids=Object.fromEntries(names.map(name=>[name,imported(name)]));
  const scratch=new SurfaceFrameResources(device);
  const classifier=new SurfaceCellClassifierPass(device,scratch);
  const setup=new SurfaceCellGeometrySetup(device);
  const reconstruction=new SurfaceReconstructionPass(device);
  reconstruction.prepareFrame(17,9,2);
  return {device,graph,imported,ids,scratch,classifier,setup,reconstruction};
}
test('production allocation obeys batch capacity even with a full-screen caller budget',()=>{
  const owner=Object.create(SurfaceWorkRuntime.prototype);
  let preparedTiles;
  Object.assign(owner,{
    device:{limits:{maxBufferSize:1<<30,maxStorageBufferBindingSize:1<<27,maxTextureDimension2D:8192}},
    budget:{maxTiles:262144,maxSamples:4194304,maxGeometryRecords:4194304,maxExceptions:65536,maxBytes:1<<29},
    scratch:{prepare(){}},reconstruction:{prepareFrame(_w,_h,tiles){preparedTiles=tiles;}},
    fieldStore:null,signalStore:null,prepared:false,destroyed:false
  });
  owner.prepareFrame(1920,1080,1);
  assert.ok(owner.capacity.batchCount>1);
  assert.ok(owner.layout.sampleCapacity<=owner.capacity.batchTargetCapacity);
  assert.ok(owner.layout.geometryCapacity<=owner.capacity.batchTargetCapacity);
  assert.equal(preparedTiles*64,owner.layout.sampleCapacity);
  assert.ok(owner.layout.sampleCapacity<1920*1080);
});
test('all producers of the next batch follow prior reconstruction and cache publication',()=>{
  const f=fixture(),{graph,imported}=f;
  const ranges=[];
  let previous;
  const products=f.classifier.addToGraph(graph,{
    ...f.ids, resourceBinding:(_name,resolve)=>resolve(),
    geometryPass:{addCellSetupsToGraph:(g,input)=>f.setup.addToGraph(g,input)},
    width:17,height:9,generation:1,frameAt:0,directoryAt:0,
    sourceGeometry:0,sourceMeshlet:0,sourceMeshletVertices:0,sourceMeshletTriangles:0,sourceVertexData:0,
    product:null,clusters:{parameters:imported('cluster parameters'),lookup:imported('cluster lookup'),data:imported('cluster data')},
    shadowEnabled:false,physicalSunEnabled:false,diagnosticsEnabled:false,
    publication:{surfaceBoundPrograms:[],surfaceProgramCount:0,surfaceCacheGeneration:1,surfaceMetadataOffsets:{}},
    workLayout:surfaceWorkLayout(17,9,{maxTiles:16,maxSamples:128,maxExceptions:16,maxGeometryRecords:128,maxBytes:1<<24},f.device.limits),
    consumeBatch:(cells,first,count,batchTiles)=>{
      ranges.push([first,count,batchTiles]);
      const produce=graph.add(`test lighting ${first}`,{},()=>{});
      produce.read(cells.work);produce.read(cells.counts);
      const packets=produce.create(`packets ${first}`,{kind:'transient_buffer',size:64,usage:GPUBufferUsage.STORAGE});
      const publish=graph.add(`test cache publication ${first}`,{},()=>{});
      publish.read(packets);
      const published=publish.create(`published ${first}`,{kind:'transient_buffer',size:4,usage:GPUBufferUsage.STORAGE});
      previous=f.reconstruction.addToGraph(graph,{
        packets,fullPackets:packets,packetFlags:packets,reactive:imported(`facts ${first}`),preExposure:imported(`exposure ${first}`),
        sampleMap:cells.sampleMap,cellWorkspace:cells.workspace,cellBatchTiles:batchTiles,firstTile:first,fields:packets,appearanceMetadata:f.ids.appearanceMetadata,constantFieldsOffset:0,scalarAo:null,width:17,height:9,recordCount:128,diagnosticsEnabled:true,
        batch:{index:first/batchTiles,batchTiles},previous,after:[published]
      });
      return [previous.radiance,previous.reactiveMask];
    }
  });
  const present=graph.add('present',{},()=>{});
  present.read(previous.radiance);present.read(products.sampleMap);present.make_side_effect();
  const dump=graph.compile().dump();
  const order=dump.executablePassOrder.map(id=>dump.passes[id].name);
  assert.deepEqual(ranges,[[0,2,2],[2,2,2],[4,2,2]]);
  const reconstruct=order.flatMap((name,index)=>name==='Surface/cheap batched reconstruct'?[index]:[]);
  assert.equal(reconstruct.length,3);
  for(let batch=1;batch<3;batch++){
    assert.ok(order.indexOf(`SurfaceGeometry/reset_cell_geometry batch ${batch*2}`)>reconstruct[batch-1]);
    assert.ok(order.indexOf(`Surface/cell batch ${batch} workspace reset`)>reconstruct[batch-1]);
  }
  for(let batch=0;batch<3;batch++)assert.ok(order.indexOf(`test cache publication ${batch*2}`)<reconstruct[batch]);
  assert.equal(dump.resources.filter(r=>r.name==='Surface/HDR reconstructed').length,1,
    'all batch writes retain one physical HDR output');
});
