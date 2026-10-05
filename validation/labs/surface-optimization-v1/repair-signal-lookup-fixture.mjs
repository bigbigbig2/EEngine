import { surfaceCellWorkspaceLayout, surfaceCellWorkspaceWgsl, SURFACE_CELL_TILE_PLAN_BYTES } from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import { SURFACE_CELL_ADDRESS_WORDS } from '../../../OEngine/.test-dist/gpu/GpuSurfaceReferenceAbi.js';
import { SURFACE_FIELD_IDENTITY_WORDS as I, SURFACE_FIELD_EXECUTION_PROFILE_WORD as PW } from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldIdentityAbi.js';
import { SURFACE_EXECUTION_WORDS, SURFACE_FIELD_EXECUTION_WORDS as FW, SURFACE_SIGNAL_EXECUTION_WORDS as SW } from '../../../OEngine/.test-dist/gpu/GpuSurfaceExecutionProfileAbi.js';
import { SURFACE_SIGNAL_FIELD_MASKS } from '../../../OEngine/.test-dist/material/AppearanceExecutionProfile.js';
import { SURFACE_SIGNAL_LOOKUP_WGSL } from '../../../OEngine/.test-dist/shaders/surface_signal_lookup.js';
import { VSM_CONTENT_VERSION_WGSL } from '../../../OEngine/.test-dist/shaders/vsm_content_version.js';
import { VSM_ALLOCATE_PAGES_WGSL } from '../../../OEngine/.test-dist/shaders/vsm_allocate_pages.js';
import { SURFACE_SIGNAL_STORE_COMPUTE_WGSL, SURFACE_SIGNAL_STORE_ENTRY_WORDS, SURFACE_SIGNAL_STORE_PAYLOAD_WORD,
  SURFACE_SIGNAL_STORE_FLAGS_WORD, SURFACE_SIGNAL_STORE_STATE_WORD, SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD } from '../../../OEngine/.test-dist/gpu/GpuSurfaceSignalStoreAbi.js';

export async function runSignalLookupRepair(gpu, assert, onStage=()=>{}) {
  const report={evidenceRole:'diagnostic',passed:false,cases:[],apiErrors:[]};
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});assert.ok(adapter&&!adapter.info.isFallbackAdapter);
  const device=await adapter.requestDevice();device.addEventListener('uncapturederror',event=>report.apiErrors.push(event.error.message));
  const retained=[];
  const bits=values=>new Uint32Array(new Float32Array(values).buffer);
  const buffer=(words,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC)=>{
    const result=device.createBuffer({size:words.byteLength,usage});device.queue.writeBuffer(result,0,words);retained.push(result);return result;
  };
  const read=async resource=>{
    const target=device.createBuffer({size:resource.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(resource,0,target,0,resource.size);device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);const words=new Uint32Array(target.getMappedRange()).slice();target.unmap();target.destroy();return words;
  };
  try {
    device.pushErrorScope('validation');
    const layout=surfaceCellWorkspaceLayout(1),workspaceWords=new Uint32Array(layout.bytes/4);
    const address=layout.addresses/4;
    workspaceWords.set([3,7,11,13,17,19,23,29,1,31,37,41,43,5,0,1],address);
    workspaceWords[address+16]=7;
    workspaceWords[address+19]=63;
    workspaceWords.set(bits([1,2,3,1]),layout.signalWitnesses/4);
    workspaceWords.set(bits([0,0,1,1]),layout.signalWitnesses/4+4);
    workspaceWords.set(bits([1,0,0,1]),layout.signalWitnesses/4+8);
    for(let leaf=0;leaf<3;leaf++)workspaceWords.set([1,0,0,1],layout.facts/4+leaf*4);
    for(let field=0;field<15;field++) {
      const at=layout.plans/4+16+field*6;
      workspaceWords.set([1,0,field*24,0,7,0],at);
      for(let leaf=0;leaf<3;leaf++)workspaceWords[layout.addresses/4+leaf*SURFACE_CELL_ADDRESS_WORDS+19]=63;
    }
    // Different fields select different covered physical sources; the union
    // leaf's own roughness/normal references are intentionally invalid.
    for(const [field,leaf,slot,generation] of [[3,1,17,23],[6,2,19,29]]) {
      const plan=layout.plans/4+16+field*6;
      workspaceWords[plan]=4;workspaceWords[plan+3]=1;
      workspaceWords[layout.maps/4+field*24+12]=leaf;
      workspaceWords.set([slot,generation],layout.fieldReferences/4+(leaf*15+field)*2);
      workspaceWords[layout.fieldStoreMasks/4+leaf]|=1<<field;
    }
    const workspace=buffer(workspaceWords);
    const constants=15*I,execution=constants+64,metadataWords=new Uint32Array(execution+SURFACE_EXECUTION_WORDS);
    metadataWords[constants]=0x7fff&~((1<<3)|(1<<6));
    metadataWords[constants+3]=0x7fff;
    for(let field=0;field<15;field++) {
      metadataWords.set([100+field,field,0,0,0,0,0,0,execution+8+field*FW],field*I);
      metadataWords.set(bits([.5,.5,.5,0]),constants+4+field*4);
    }
    SURFACE_SIGNAL_FIELD_MASKS.forEach((fields,kind)=>{metadataWords[execution+8+15*FW+kind*SW+1]=fields;});
    metadataWords.set(bits([1,0,0,0]),constants+4+10*4);
    const metadata=buffer(metadataWords),versionWords=new Uint32Array(15*4);
    for(let field=0;field<15;field++)versionWords[field*4]=1;
    const versions=buffer(versionWords);
    const values=[0,constants,1,256,2,11,7,13,17,19,1,1,1,1,0,0];
    const settings=buffer(new Uint32Array(values),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const sun=buffer(bits([0,1,0,.001,1,2,3,4,1,0,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const shadow=buffer(new Uint32Array([17,0,17,73]));
    const store=buffer(new Uint32Array(256*SURFACE_SIGNAL_STORE_ENTRY_WORDS));
    const requests=buffer(new Uint32Array(6*SURFACE_SIGNAL_STORE_ENTRY_WORDS));
    const source=`${surfaceCellWorkspaceWgsl(1)}\n${SURFACE_SIGNAL_LOOKUP_WGSL}
      @group(0) @binding(7) var<storage,read_write> known_signal_requests:array<u32>;
      @compute @workgroup_size(64) fn pack_known_signals(@builtin(global_invocation_id) id:vec3u) {
        let kind=id.x;if kind>=6u{return;}
        let fields=signal_request_fields(0u,kind);
        let at=kind*${SURFACE_SIGNAL_STORE_ENTRY_WORDS}u;
        for(var word=0u;word<SIGNAL_REQUEST_KEY_WORDS;word++){known_signal_requests[at+word]=signal_request_word(0u,kind,word,fields);}
        known_signal_requests[at+${SURFACE_SIGNAL_STORE_PAYLOAD_WORD}u]=pack2x16float(vec2f(.5,.25));
        known_signal_requests[at+${SURFACE_SIGNAL_STORE_PAYLOAD_WORD+1}u]=pack2x16float(vec2f(.125,0.0));
        known_signal_requests[at+${SURFACE_SIGNAL_STORE_FLAGS_WORD}u]=select(5u,201u,kind==1u);
      }`;
    const module=device.createShaderModule({code:source});
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(message=>message.type==='error').map(message=>message.message),[]);
    onStage('Compiling actual signal lookup and complete key getter');
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'lookup_surface_signals'}});
    const all=[settings,workspace,metadata,versions,store,sun,shadow,requests];
    const groupFor=(pipeline,bindings)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:bindings.map(binding=>({binding,resource:{buffer:all[binding]}}))});
    const group=groupFor(pipeline,[0,1,2,3,4,5,6]);
    const sample=async(name,dirty)=>{
      onStage(name);device.queue.writeBuffer(settings,0,new Uint32Array(values));
      const encoder=device.createCommandEncoder();encoder.clearBuffer(workspace,0,128*4);
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
      const words=await read(workspace);assert.equal(words[layout.demands/4+2],dirty,name);
      assert.equal(words[117],6-[...Array(6)].filter((_,kind)=>(dirty&(1<<kind))!==0).length);
      report.cases.push({name,dirtyMask:dirty,hits:words[117],lightingInvocationsRequired:words[118]});
      return words;
    };
    await sample('cold',63);
    const pack=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'pack_known_signals'}});
    const packGroup=groupFor(pack,[0,1,2,3,5,6,7]);
    {const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(pack);pass.setBindGroup(0,packGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);}
    const keys=await read(requests);
    const denv=SURFACE_SIGNAL_STORE_ENTRY_WORDS;
    assert.equal(keys[denv+1],7);assert.equal(keys[denv+2],0);assert.equal(keys[denv+3],0);assert.equal(keys[denv+4],0);assert.equal(keys[denv+5],0);
    assert.deepEqual([...keys.subarray(denv+40+6*2,denv+40+6*2+2)],[0x80000000+19,29]);
    const spec=2*SURFACE_SIGNAL_STORE_ENTRY_WORDS;
    assert.deepEqual([...keys.subarray(spec+40+3*2,spec+40+3*2+2)],[0x80000000+17,23]);
    const publicationSettings=buffer(new Uint32Array([6,256,1,1]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const owners=buffer(new Uint32Array(6)),counters=buffer(new Uint32Array(8));
    const publicationModule=device.createShaderModule({code:SURFACE_SIGNAL_STORE_COMPUTE_WGSL});
    for(const entryPoint of ['surface_signal_store_publish','surface_signal_store_commit']) {
      const publication=await device.createComputePipelineAsync({layout:'auto',compute:{module:publicationModule,entryPoint}});
      const data=[publicationSettings,requests,store,owners,counters];
      const bindings=entryPoint.endsWith('commit')?[0,2,3]:[0,1,2,3,4];
      const publicationGroup=device.createBindGroup({layout:publication.getBindGroupLayout(0),entries:bindings.map(binding=>({binding,resource:{buffer:data[binding]}}))});
      const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(publication);pass.setBindGroup(0,publicationGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
      if(entryPoint.endsWith('publish'))await sample('reserved rejected',63);
    }
    await sample('warm actual selected refs',0);
    await sample('same submitted epoch repeated lookup',0);
    const published=await read(store);
    const ages=Array.from({length:256},(_,entry)=>entry).filter(entry=>published[entry*SURFACE_SIGNAL_STORE_ENTRY_WORDS+SURFACE_SIGNAL_STORE_STATE_WORD]===2)
      .map(entry=>published[entry*SURFACE_SIGNAL_STORE_ENTRY_WORDS+SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD]&0xffff);
    assert.deepEqual(ages,[1,1,1,1,1,1]);
    values[6]=23;await sample('environment only',42);values[6]=7;
    values[7]=29;await sample('direct lights only',21);values[7]=13;
    device.queue.writeBuffer(shadow,0,new Uint32Array([31]));await sample('actual GPU shadow content version only',21);
    device.queue.writeBuffer(shadow,0,new Uint32Array([17]));
    values[9]=37;await sample('physical sun only',21);values[9]=19;
    values[5]=41;await sample('view revision preserves Denv',61);values[5]=11;
    device.queue.writeBuffer(versions,4*4*4,new Uint32Array([2]));
    device.queue.writeBuffer(versions,5*4*4,new Uint32Array([2]));
    await sample('compose AO occlusion and E do not invalidate lighting',0);
    device.queue.writeBuffer(workspace,(layout.fieldReferences/4+(1*15+3)*2+1)*4,new Uint32Array([24]));
    await sample('selected roughness producer generation only',29);
    device.queue.writeBuffer(workspace,layout.fieldStoreMasks+4,new Uint32Array([0]));
    await sample('transient selected Field keeps dependent signals dirty',29);
    device.queue.writeBuffer(workspace,(layout.fieldReferences/4+(1*15+3)*2)*4,new Uint32Array([17,23]));
    device.queue.writeBuffer(workspace,layout.fieldStoreMasks+4,new Uint32Array([1<<3]));
    onStage('Actual VSM content publication and allocation API');
    const contentModule=device.createShaderModule({code:VSM_CONTENT_VERSION_WGSL});
    const allocationModule=device.createShaderModule({code:VSM_ALLOCATE_PAGES_WGSL});
    for(const module of [contentModule,allocationModule])assert.deepEqual((await module.getCompilationInfo()).messages.filter(message=>message.type==='error').map(message=>message.message),[]);
    await device.createComputePipelineAsync({layout:'auto',compute:{module:allocationModule,entryPoint:'main'}});
    const contentPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:contentModule,entryPoint:'publish_vsm_content_version'}});
    const contentGeneration=buffer(new Uint32Array([2,0,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const contentWords=buffer(new Uint32Array([0,0,0,79]));
    const contentGroup=device.createBindGroup({layout:contentPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:contentGeneration}},{binding:1,resource:{buffer:contentWords}}
    ]});
    const publishContent=async()=>{
      const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(contentPipeline);pass.setBindGroup(0,contentGroup);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);return [...await read(contentWords)];
    };
    assert.deepEqual(await publishContent(),[1,0,2,79]);
    assert.deepEqual(await publishContent(),[1,0,2,79]);
    device.queue.writeBuffer(contentWords,4,new Uint32Array([1]));
    assert.deepEqual(await publishContent(),[2,0,2,79]);
    device.queue.writeBuffer(contentGeneration,0,new Uint32Array([3]));
    assert.deepEqual(await publishContent(),[3,0,3,79]);
    device.queue.writeBuffer(contentWords,0,new Uint32Array([0xfffffffe,1]));
    assert.deepEqual(await publishContent(),[0xffffffff,0,3,79]);
    report.vsmContentVersion={cold:1,unchanged:1,actualMutation:2,generationChange:3,exhaustion:0xffffffff,namespace:79};
    const validation=await device.popErrorScope();report.validationError=validation?.message??null;assert.equal(validation,null,validation?.message);
    assert.deepEqual(report.apiErrors,[]);report.passed=true;
  } catch(error){report.failure=error?.stack??String(error);}
  finally{for(const resource of retained)resource.destroy();device.destroy();}
  return report;
}
