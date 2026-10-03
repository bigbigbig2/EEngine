import { COMPACT_WGSL } from '../../../OEngine/.test-dist/render/surface/SurfaceCellClassifierPass.js';
import { surfaceCellWorkspaceLayout, surfaceCellWorkspaceWgsl, surfaceCellReadWgsl } from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import { SURFACE_FIELD_STORE_COMPUTE_WGSL } from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldStoreAbi.js';

/** GPU regression: coarse diffuse must not consume the fine specular or field
 * representative. Expected records are analytic, independent of the classifier. */
export async function checkCellDemand(device, assert) {
  const retained=[];
  const buffer=(size,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC)=>{
    const value=device.createBuffer({size,usage});retained.push(value);return value;
  };
  const pipeline=async (source,entryPoint)=>{
    const module=device.createShaderModule({code:source});
    const info=await module.getCompilationInfo();
    assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
  };
  const read=async source=>{
    const staging=buffer(source.size,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,staging,0,source.size);
    device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);
    const value=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();return value;
  };
  device.pushErrorScope('validation');
  try {
    const layout=surfaceCellWorkspaceLayout(1),words=new Uint32Array(layout.bytes/4);
    for(const [plane,mode,rate,slots] of [[0,3,10,4],[3,2,0,64],[15,3,15,1],[17,2,0,64]]) {
      words.set([mode|(rate<<8),0,plane*24,slots,0xffffffff,0xffffffff],layout.plans/4+16+plane*6);
    }
    for(let lane=0;lane<64;lane++)words.set([lane+1,0,0,0],layout.facts/4+lane*4);
    const workspace=buffer(layout.bytes);device.queue.writeBuffer(workspace,0,words);
    const settings=buffer(48,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(settings,0,new Uint32Array([8,8,1,0,1,0,512,64,1]));
    const work=buffer(4096),counts=buffer(128);
    const map=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});retained.push(map);
    const compact=await pipeline(surfaceCellWorkspaceWgsl(1)+COMPACT_WGSL,'compact_cells');
    const group=device.createBindGroup({layout:compact.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:settings}},{binding:1,resource:{buffer:workspace}},
      {binding:2,resource:{buffer:work}},{binding:3,resource:{buffer:counts}},{binding:4,resource:map.createView()}
    ]});
    let encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(compact);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
    const records=await read(work),total=await read(counts);assert.equal(total[0],64);
    for(let lane=0;lane<64;lane++){
      assert.equal(records[lane*8],lane);
      assert.equal(records[lane*8+3],4|(lane===0?1:0));
      assert.equal(!!(records[lane*8+4]&1),[0,4,32,36].includes(lane));
      assert.equal(!!(records[lane*8+4]&8),true);
    }
    const consumer=await pipeline(`
@group(0) @binding(0) var<storage,read> cell_plan_words:array<u32>;
@group(0) @binding(1) var sample_map:texture_2d<u32>;
@group(0) @binding(2) var<storage,read_write> results:array<u32>;
${surfaceCellReadWgsl('1u')}
@compute @workgroup_size(64) fn check(@builtin(local_invocation_index) lane:u32) {
 let pixel=vec2u(lane%8u,lane/8u);
 results[lane*3u]=surface_plan_record(pixel,0u,1u,0u);
 results[lane*3u+1u]=surface_plan_record(pixel,15u,1u,0u);
 results[lane*3u+2u]=surface_plan_record(pixel,17u,1u,0u);
}`,'check');
    const result=buffer(64*3*4);
    const consumerGroup=device.createBindGroup({layout:consumer.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:workspace}},{binding:1,resource:map.createView()},{binding:2,resource:{buffer:result}}
    ]});
    encoder=device.createCommandEncoder();pass=encoder.beginComputePass();pass.setPipeline(consumer);pass.setBindGroup(0,consumerGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
    const resolved=await read(result);
    for(let lane=0;lane<64;lane++){
      assert.equal(resolved[lane*3],Math.floor(lane/32)*32+Math.floor(lane%8/4)*4);
      assert.equal(resolved[lane*3+1],0);
      assert.equal(resolved[lane*3+2],lane);
    }

    // All requests share a first word and one four-way set. Distinct complete
    // keys must own separate immutable entries, never overwrite one another.
    const entries=buffer(4*24*4),requests=buffer(4*16*4),storeCounters=buffer(32),owners=buffer(16);
    const storeSettings=buffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const initial=new Uint32Array(96);for(let i=0;i<4;i++)initial[i*24]=0xffffffff;
    device.queue.writeBuffer(entries,0,initial);
    const requestWords=new Uint32Array(64);
    for(let i=0;i<4;i++){requestWords[i*16]=7;requestWords[i*16+11]=i+1;requestWords[i*16+12]=100+i;}
    device.queue.writeBuffer(requests,0,requestWords);device.queue.writeBuffer(storeSettings,0,new Uint32Array([4,4,1,0]));
    const publish=await pipeline(SURFACE_FIELD_STORE_COMPUTE_WGSL,'surface_field_store_publish');
    const storeGroup=device.createBindGroup({layout:publish.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:storeSettings}},{binding:1,resource:{buffer:requests}},
      {binding:2,resource:{buffer:entries}},{binding:3,resource:{buffer:owners}},{binding:4,resource:{buffer:storeCounters}}
    ]});
    encoder=device.createCommandEncoder();pass=encoder.beginComputePass();pass.setPipeline(publish);pass.setBindGroup(0,storeGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
    const commit=await pipeline(SURFACE_FIELD_STORE_COMPUTE_WGSL,'surface_field_store_commit');
    const commitGroup=device.createBindGroup({layout:commit.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:storeSettings}},{binding:2,resource:{buffer:entries}},{binding:3,resource:{buffer:owners}}
    ]});
    encoder=device.createCommandEncoder();pass=encoder.beginComputePass();pass.setPipeline(commit);pass.setBindGroup(0,commitGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
    const stored=await read(entries),keys=new Set();
    for(let i=0;i<4;i++)if(stored[i*24+14]===1){
      const key=stored[i*24+11];assert.equal(stored[i*24],7);assert.equal(stored[i*24+16],99+key);
      assert.ok(!keys.has(key));keys.add(key);
    }
    assert.equal(keys.size,4);
    assert.equal(await device.popErrorScope(),null);
    return {representatives:64,independentMappings:192,distinctSamePrefixKeys:keys.size,passed:true};
  } finally {for(const resource of retained)resource.destroy();}
}
