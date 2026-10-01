// Diagnostic fixture shared by Native and installed Chrome. Actual production
// owners/shaders; independent double Gaussian interpolation, no renderer fork.
import { FrameInstanceTransforms } from '../../../OEngine/.test-dist/render/FrameInstanceTransforms.js';
import { FrameGeometryArena } from '../../../OEngine/.test-dist/render/FrameGeometryArena.js';
import { FrameGeometryVertices } from '../../../OEngine/.test-dist/render/FrameGeometryVertices.js';
import { CurrentHzbLateRecheckGpu } from '../../../OEngine/.test-dist/render/CurrentHzbLateRecheck.js';
import { WinnerPrimitiveInterpolation } from '../../../OEngine/.test-dist/render/surface/WinnerPrimitiveInterpolation.js';
import { ResourceAccounting } from '../../../OEngine/.test-dist/debug/profiling/ResourceAccounting.js';
import { packGpuInstanceRecords } from '../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js';
import { GPU_COUNTER_BYTE_SIZE } from '../../../OEngine/.test-dist/debug/GpuFrameCounters.js';
import { GPU_SHADING_MATERIAL_RECORD_STRIDE, GPU_SHADING_MATERIAL_HEADER_STRIDE } from '../../../OEngine/.test-dist/gpu/GpuShadingMaterialAbi.js';
import { GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK } from '../../../OEngine/.test-dist/gpu/GpuVisibilityKeyAbi.js';
import { PACKED_CAMERA_TYPE } from '../../../OEngine/.test-dist/shaders/packed_camera.js';
import { MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL, VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL } from '../../../OEngine/.test-dist/shaders/meshlet_bucket_visibility.js';
import { winnerPrimitiveArenaConsumerWgsl } from '../../../OEngine/.test-dist/shaders/winner_primitive_work.js';
import { homogeneousInterpolationReference, transformPosition } from '../../../OEngine/tests/helpers/homogeneous-interpolation-reference.mjs';

export async function runFrameVerticesFixture(device) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const resources = [], accounting = new ResourceAccounting(), cases = [];
  const result = { evidenceRole: 'diagnostic', component: 'SelectedSharedVertices/Raster/HZB/Winner', cases,
    coveredPixels: 0, maxClipError: 0, maxWeightError: 0, maxGradientError: 0 };
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], width = 64, height = 64;
  const buffer = (value, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
    const b = device.createBuffer({ size: typeof value === 'number' ? value : value.byteLength, usage }); resources.push(b);
    if (typeof value !== 'number') device.queue.writeBuffer(b, 0, value); return b;
  };
  const texture = (format, size = [width, height]) => {
    const t = device.createTexture({ size, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST }); resources.push(t); return t;
  };
  const readback = size => buffer(size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const map = async (b, Type = Uint32Array) => { await b.mapAsync(GPUMapMode.READ); const v = new Type(b.getMappedRange().slice(0)); b.unmap(); return v; };
  const module = async code => { const m = device.createShaderModule({ code }); const info = await m.getCompilationInfo();
    check(!info.messages.some(m => m.type === 'error'), JSON.stringify(info.messages)); return m; };
  const group = (p, entries, index = 0) => device.createBindGroup({ layout: p.getBindGroupLayout(index), entries: entries.map(([binding, value]) =>
    ({ binding, resource: value.size === undefined ? value : { buffer: value } })) });
  const cameraData = matrix => { const v = new Uint8Array(PACKED_CAMERA_TYPE.size); new Float32Array(v.buffer, 384, 16).set(matrix); return v; };
  const queueData = (count, generation, capacity, slots = [0,1,2], profile = false) => {
    const v = new Uint32Array(8 + capacity * 6); v.set([count,count,0,capacity,0,generation,0,0]);
    for (let i=0;i<Math.min(count,capacity);i++) v.set([slots[i % slots.length],0,profile ? i % 3 : 0,0,0,1],8+i*6);
    return v;
  };
  const instances = new FrameInstanceTransforms(device, accounting, true);
  const vertices = new FrameGeometryVertices(device, accounting, true);
  const arenaOwner = new FrameGeometryArena(device, accounting);
  const lateOwner = new CurrentHzbLateRecheckGpu(device, accounting);
  let winner;
  try {
    device.pushErrorScope('validation');
    await Promise.all([instances.ready, vertices.ready, lateOwner.ready]);
    winner = await WinnerPrimitiveInterpolation.create(device, { observe: true, accounting });
    const consume = await device.createComputePipelineAsync({ layout: 'auto', compute: { entryPoint: 'main', module: await module(`
${winnerPrimitiveArenaConsumerWgsl()}
struct View { viewport: vec2u, frame_at: u32, directory_at: u32, }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> asset_metadata_heap: array<u32>;
@group(1) @binding(0) var visibility: texture_2d<u32>;
struct Result { weights: vec4f, dx: vec4f, dy: vec4f, }
@group(1) @binding(1) var<storage, read_write> result: array<Result>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if any(id.xy >= view.viewport) { return; }
  let value = winner_arena_interpolate_key(textureLoad(visibility, vec2i(id.xy), 0).x,
    vec2f(id.xy) + vec2f(0.5), vec2f(view.viewport), view.frame_at, view.directory_at);
  result[id.y * view.viewport.x + id.x] = Result(vec4f(value.weights,f32(value.flags)),vec4f(value.dx,0),vec4f(value.dy,0));
}`) } });
    const ordinaryModule = await module(MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL), productModule = await module(VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL);
    const raster = await Promise.all([false,true].map(product => device.createRenderPipelineAsync({ layout:'auto',
      vertex: { module: product ? productModule : ordinaryModule, entryPoint: product ? 'raster_virtual_meshlet' : 'raster_meshlet_bucket' },
      fragment: { module: product ? productModule : ordinaryModule, entryPoint: product ? 'write_virtual_meshlet' : 'write_meshlet_opaque', targets:[{format:'r32uint'}] },
      primitive: { topology:'triangle-list', cullMode: product ? 'none' : 'back', frontFace:'ccw' },
      depthStencil: { format:'depth32float',depthWriteEnabled:true,depthCompare:'greater' } })));
    check(await device.popErrorScope() === null, 'Pipeline validation failed');
    const local = [[-0.7,-0.6,0.5,1],[0.7,-0.6,0.5,1],[0,0.7,0.5,1]];
    const matrices = [I, [-0.7,0,0,0,0,1.2,0,0,0,0,1,0,0.08,0,0,1],
      [0.6,0.15,0,0,-0.2,0.8,0,0,0,0,1,0,0,0.05,0,1]];
    const sourceData = () => packGpuInstanceRecords(matrices.map((m, slot) => ({ currentObjectToWorld:m, previousObjectToWorld:I,
      geometryRecordIndex:0, geometryGeneration:1, materialHandle:0,flags:1,debugId:slot,boundsSphere:[0,0,0,1],boundsMin:[-1,-1,-1],boundsMax:[1,1,1] })));
    const source = buffer(sourceData()), camera = buffer(cameraData(I),GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const geometryWords = new Uint32Array(60); geometryWords[12]=3;geometryWords[30]=12;geometryWords[31]=1;
    const meshletWords = new Uint32Array(28);meshletWords[1]=3;meshletWords[3]=1;
    const positions = new Float32Array(local.flatMap(v => v.slice(0,3)));
    const posBuffer=buffer(positions), geoBuffer=buffer(geometryWords), meshBuffer=buffer(meshletWords), cornerBuffer=buffer(new Uint32Array([0x020100]));
    const vertexIndices=buffer(new Uint32Array([0,1,2])), metadata=buffer(new Uint32Array([...geometryWords,...meshletWords]));
    const assets={ geometryRecords:geoBuffer,meshletRecords:meshBuffer,meshletVertexIndices:vertexIndices,meshletTriangleIndices:cornerBuffer,vertexStreamData:posBuffer };
    // Complete existing Product profile: one group, three meshlets with distinct
    // source positions/bounds; no substitute geometry decoder.
    const heap = new Uint32Array(96);heap.set([1,1,1,96,16,32,36,68,72,84,88,92]);
    heap.set([1,1,0,1,0,1,0,1,0,1,0,1,0,1],16);heap.set([0,1,0,0],32);
    heap.set([0,1,0,1,0,1],36+18);heap.set([0,0,1024,0],84);heap.set([0,0,1,3],88);heap.set([16|(3<<16),12<<8,1<<16,0],92);
    const productBytes = new ArrayBuffer(262144), words = new Uint32Array(productBytes), floats = new Float32Array(productBytes);
    floats[3]=1;words[11]=3;words[12]=64;words[13]=208;words[14]=224;words[15]=1024;
    const productLocal = [];
    for(let m=0;m<3;m++) {
      const at=16+m*12, z=m===0?0.2:0.8, offset=m===2?0.25:0;
      words[at]=3|(1<<16);words[at+1]=224+m*48;words[at+2]=208+m*3;words[at+3]=0xffffffff;
      floats.set([-0.7+offset,-0.6,z,0.7+offset,0.7,z],at+6);
      const p=local.map(v=>[v[0]+offset,v[1],z,1]);productLocal.push(p);
      p.forEach((v,i)=>floats.set(v.slice(0,3),(224+m*48+i*16)/4));
      new Uint8Array(productBytes).set([0,1,2],208+m*3);
    }
    const bank=buffer(new Uint8Array(productBytes)), productMetadata=buffer(heap), banks=[bank,buffer(4),buffer(4),buffer(4)];
    const product={metadata:productMetadata,banks,productGeneration:1}, materialWords=new Uint32Array(GPU_SHADING_MATERIAL_RECORD_STRIDE/4);
    materialWords[GPU_SHADING_MATERIAL_HEADER_STRIDE/4+2]=1;
    const material=buffer(materialWords), neutral=texture('rgba8unorm',[1,1,1]).createView({dimension:'2d-array'});
    const hzb=texture('r32float',[1,1]);device.queue.writeTexture({texture:hzb},new Float32Array([0.5]),{bytesPerRow:4},[1,1]);
    const counters=buffer(GPU_COUNTER_BYTE_SIZE), visible=texture('r32uint'), depth=texture('depth32float');
    const output=buffer(width*height*48), outputRead=readback(output.size), keyRead=readback(width*height*4);
    const poisoned=buffer(new Float32Array(positions.length).fill(100));
    const poisonedProduct=productBytes.slice(0);const poisonedFloats=new Float32Array(poisonedProduct);
    for(let m=0;m<3;m++)for(let i=0;i<3;i++)poisonedFloats[(224+m*48+i*16)/4]=100;
    const poisonBank=buffer(new Uint8Array(poisonedProduct));
    const inputCases = [
      {name:'ordinary/shared',slots:[0,1,2]}, {name:'ordinary/poison-source',slots:[0,1,2],poison:true},
      {name:'ordinary/mirror',slots:[1]}, {name:'ordinary/shear',slots:[2]},
      {name:'ordinary/camera',slots:[0],camera:[0.8,0,0,0.2,0,0.9,0,0,0,0,1,0,0.03,-0.02,0,1]},
      {name:'ordinary/empty',slots:[]}, {name:'ordinary/zero-generation',slots:[0],generation:0},
      {name:'ordinary/vertex-capacity-miss',slots:[0],vertexCapacity:1},
      {name:'ordinary/triangle-capacity-miss',slots:[0,1,2],triangleCapacity:1},
      {name:'ordinary/motion',slots:[0],motion:true},
      {name:'Product/shared',product:true,slots:[0,0,0]}, {name:'Product/poison-source',product:true,slots:[0,0,0],poison:true},
      {name:'Product/HZB-remap',product:true,slots:[0,0,0],late:true},
      {name:'Product/HZB-poison-source',product:true,slots:[0,0,0],late:true,poison:true},
      {name:'Product/HZB-empty',product:true,slots:[],late:true},
      {name:'Product/HZB-stale-source',product:true,slots:[0,0,0],late:true,stale:true},
      {name:'ordinary/2D-padded',slots:[0],large:true,vertexCapacity:1},
      {name:'Product/2D-HZB',product:true,slots:[0],large:true,vertexCapacity:1,late:true},
    ];
    let baselineOrdinary, baselineProduct, baselineLate;
    for (const [ordinal,input] of inputCases.entries()) {
      const capacity=input.large?device.limits.maxComputeWorkgroupsPerDimension+2:4;
      const count=input.large?capacity:input.slots.length, generation=input.generation??ordinal+1;
      const q=buffer(queueData(count,generation,capacity,input.slots.length?input.slots:[0],input.product));
      const allocation=instances.prepare({camera,source,work:q,workCapacity:capacity,instanceCapacity:3});
      const budget={workCapacity:capacity,filteredWorkCapacity:input.late?capacity:0,vertexCapacity:input.vertexCapacity??9,
        triangleCapacity:input.triangleCapacity??3,dictionaryCapacity:64,coefficientCapacity:32,probeLimit:16,maxBytes:16*1024*1024};
      const arena=arenaOwner.prepare(metadata,metadata.size,budget);
      const p=vertices.prepare({arena,instances:allocation,work:q,assets,...(input.product?{product,productBanks:banks}:{})});
      const late=input.late?lateOwner.prepare({sourceQueue:q,sourceGeometry:arena.sourceDirectory,filteredGeometry:arena.filteredDirectory,
        capacity,camera,instances:source,virtualGeometry:product,productBanks:banks,counters,countersEnabled:true,width:1,height:1,mipLevelCount:1}):null;
      const directory=input.late?arena.filteredDirectory:arena.sourceDirectory;
      const w=winner.prepare({geometry:{directory,clips:arena.clips,triangles:arena.triangles},visibility:visible.createView(),width,height,budget,
        storage:{dictionary:arena.dictionary,coefficients:arena.coefficients,work:arena.work,control:arena.control}});
      const view=buffer(new Uint32Array([width,height,arena.layout.header.offset/4,directory.offset/4]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const consumeGroup=group(consume,[[0,view],[1,arena.buffer]]), consumeOutput=group(consume,[[0,visible.createView()],[1,output]],1);
      const bucketWords=new Uint32Array(64*4);bucketWords[0]=1;
      const settings=buffer(new Uint32Array(4),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const pipeline=raster[input.product?1:0], finalQueue=late?.queue??q;
      const rasterBindings=input.product?[[1,allocation.records],[2,finalQueue],[3,productMetadata],...banks.map((b,i)=>[4+i,b]),[8,material],
        ...Array.from({length:9},(_,i)=>[9+i,neutral]),[18,arena.buffer],[19,input.late?p.filteredRasterSettings:p.rasterSettings]]:
        [[1,allocation.records],[2,meshBuffer],[3,vertexIndices],[4,cornerBuffer],[5,posBuffer],[6,geoBuffer],[7,q],
          [8,buffer(bucketWords)],[9,settings],[20,arena.buffer],[21,p.rasterSettings]];
      const rasterGroup=group(pipeline,rasterBindings), arenaRead=readback(arena.buffer.size), controlRead=readback(p.control.size), queueRead=readback(finalQueue.size);
      device.queue.writeBuffer(camera,0,cameraData(input.camera??I));device.queue.writeBuffer(posBuffer,0,positions);device.queue.writeBuffer(bank,0,productBytes);
      if(input.motion){matrices[0]=[0.8,0.1,0,0,-0.1,0.7,0,0,0,0,1,0,-0.1,0.06,0,1];device.queue.writeBuffer(source,0,sourceData());}
      device.pushErrorScope('validation');const encoder=device.createCommandEncoder();
      const commit=arenaOwner.encodeMetadataPublication(encoder,arena);instances.encode(encoder,allocation);vertices.encode(encoder,p);
      if(input.stale)encoder.copyBufferToBuffer(buffer(new Uint32Array([0])),0,arena.buffer,arena.sourceDirectory.offset+4,4);
      if(input.poison)encoder.copyBufferToBuffer(input.product?poisonBank:poisoned,0,input.product?bank:posBuffer,0,input.product?bank.size:posBuffer.size);
      if(late)lateOwner.encode(encoder,late,hzb.createView());
      const pass=encoder.beginRenderPass({colorAttachments:[{view:visible.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0xffffffff,g:0,b:0,a:0}}],
        depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
      if(count&&generation&&!input.large){pass.setPipeline(pipeline);pass.setBindGroup(0,rasterGroup);
        if(late)pass.drawIndirect(late.drawIndirect,0);else pass.draw(input.product?384:3,input.product?count:1);}
      pass.end();winner.encode(encoder,w);
      const cp=encoder.beginComputePass();cp.setPipeline(consume);cp.setBindGroup(0,consumeGroup);cp.setBindGroup(1,consumeOutput);cp.dispatchWorkgroups(8,8);cp.end();
      for(const [a,b] of [[arena.buffer,arenaRead],[p.control,controlRead],[output,outputRead],[finalQueue,queueRead]])encoder.copyBufferToBuffer(a,0,b,0,a.size);
      encoder.copyTextureToBuffer({texture:visible},{buffer:keyRead,bytesPerRow:width*4},[width,height]);device.queue.submit([encoder.finish()]);commit();
      const [arenaWords,control,values,keys,queue]=await Promise.all([map(arenaRead),map(controlRead),map(outputRead,Float32Array),map(keyRead),map(queueRead)]);
      const error=await device.popErrorScope();check(error===null,error?.message);const arenaFloats=new Float32Array(arenaWords.buffer);
      const at=directory.offset/4, sourceAt=arena.sourceDirectory.offset/4;
      const expectedCount=generation?count:0;check(arenaWords[sourceAt]===expectedCount,`${input.name}: source count`);
      let cached=0;
      for(let i=0;i<expectedCount;i++){
        const d=sourceAt+4+i*4;if(!arenaWords[d+2])continue;cached++;
        const sourceSlot=input.slots[i%input.slots.length], positionsLocal=input.product?productLocal[i%3]:local;
        for(let v=0;v<3;v++) {const expected=transformPosition(input.camera??I,transformPosition(matrices[sourceSlot],positionsLocal[v]));
          const clipAt=arena.clips.offset/4+(arenaWords[d]+v)*4;
          for(let j=0;j<4;j++){const e=Math.abs(arenaFloats[clipAt+j]-expected[j]);result.maxClipError=Math.max(result.maxClipError,e);check(e<2e-6,`${input.name}: shared clip error ${e}`);}
        }
        check(arenaWords[arena.triangles.offset/4+arenaWords[d+1]]===0x020100,`${input.name}: packed triangle`);
      }
      check(control[2]===cached&&control[3]===expectedCount-cached,`${input.name}: exact committed/miss counts`);
      if(input.large)check(cached===0&&control[0]===0,`${input.name}: 2D padded capacity miss`);
      if(late){
        const n=queue[1];check(arenaWords[at]===n&&arenaWords[at+1]===generation,`${input.name}: final directory header`);
        if(!input.large)check(n===input.slots.filter((_,i)=>i%3!==0).length,`${input.name}: conservative HZB reject count ${n}`);
        for(let i=0;i<n;i++) {const original=queue[8+i*6+2]&127, d=at+4+i*4, s=sourceAt+4+original*4;
          for(let lane=0;lane<4;lane++)check(arenaWords[d+lane]===(input.stale?0:arenaWords[s+lane]),`${input.name}: remap slot ${i} original ${original}`);
        }
      }
      let coverage=0, validInterpolation=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const offset=y*width+x;if(keys[offset]===0xffffffff)continue;coverage++;
        const slot=keys[offset]&GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK, d=at+4+slot*4;
        if(!arenaWords[d+2]) {check(values[offset*12+3]===0,`${input.name}: missing clip directory must not invent coefficients`);continue;}
        const workAt=8+slot*6, instanceSlot=queue[workAt], meshlet=queue[workAt+2]&127;
        const sourceLocal=input.product?productLocal[meshlet]:local;
        const clips=sourceLocal.map(v=>transformPosition(input.camera??I,transformPosition(matrices[instanceSlot],v)));
        const reference=homogeneousInterpolationReference(clips,[x+0.5,y+0.5],[width,height]);
        check((values[offset*12+3]&1)!==0&&reference.flags&1,`${input.name}: winner value validity`);validInterpolation++;
        for(let lane=0;lane<3;lane++)for(const [base,field,metric] of [[0,'weights','maxWeightError'],[4,'dx','maxGradientError'],[8,'dy','maxGradientError']]) {
          const e=Math.abs(values[offset*12+base+lane]-reference[field][lane]);result[metric]=Math.max(result[metric],e);check(e<3e-6,`${input.name}: ${field} error ${e}`);
        }
      }
      if(!input.large&&count&&generation)check(coverage>200,`${input.name}: raster coverage ${coverage}`);
      else check(coverage===0,`${input.name}: empty visibility`);
      const equalKeys=baseline=>check(keys.every((key,i)=>key===baseline[i]),`${input.name}: source poison changed raster output`);
      if(input.name==='ordinary/shared')baselineOrdinary=keys;if(input.name==='ordinary/poison-source')equalKeys(baselineOrdinary);
      if(input.name==='Product/shared')baselineProduct=keys;if(input.name==='Product/poison-source')equalKeys(baselineProduct);
      if(input.name==='Product/HZB-remap')baselineLate=keys;if(input.name==='Product/HZB-poison-source')equalKeys(baselineLate);
      result.coveredPixels+=coverage;cases.push({name:input.name,workCount:expectedCount,cached,misses:control[3],covered:coverage,validInterpolation,filteredCount:late?queue[1]:null});
      winner.release(w);if(late)lateOwner.release(late);vertices.release(p);arenaOwner.release(arena);instances.release(allocation);
      check(accounting.snapshot().totalBytes===0,`${input.name}: leaked owner accounting`);
    }
    result.passed=true;return result;
  } finally { winner?.destroy();lateOwner.destroy();vertices.destroy();arenaOwner.destroy();instances.destroy();resources.forEach(r=>r.destroy()); }
}
