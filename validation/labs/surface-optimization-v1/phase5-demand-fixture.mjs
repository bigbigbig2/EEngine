import {surfaceDemandWgsl} from '../../../OEngine/.test-dist/shaders/surface_demand.js';
import {surfaceStorePublishWgsl} from '../../../OEngine/.test-dist/shaders/surface_store_publish.js';
import {surfaceDemandLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceDemandAbi.js';
import {surfaceCellWorkspaceLayout,SURFACE_CELL_TILE_PLAN_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {SURFACE_FIELD_IDENTITY_WORDS as IW} from '../../../OEngine/.test-dist/gpu/GpuSurfaceFieldIdentityAbi.js';
import {SURFACE_EXECUTION_WORDS as EW,SURFACE_FIELD_EXECUTION_WORDS as FW} from '../../../OEngine/.test-dist/gpu/GpuSurfaceExecutionProfileAbi.js';
import {SURFACE_SIGNAL_FIELD_MASKS} from '../../../OEngine/.test-dist/material/AppearanceExecutionProfile.js';
import {checkCanonicalSupport} from './phase5-canonical-support-fixture.mjs';

export async function runPhaseFiveDemand(gpu, assert, stage) {
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  assert.ok(adapter&&!adapter.info.isFallbackAdapter);
  const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
  const retained=[],apiErrors=[],report={passed:false,evidenceRole:'diagnostic',cases:[],apiErrors};
  device.addEventListener('uncapturederror',event=>apiErrors.push(event.error.message));
  const buffer=(words,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST)=>{
    const result=device.createBuffer({size:words.byteLength,usage});device.queue.writeBuffer(result,0,words);retained.push(result);return result;
  };
  const read=async source=>{
    const target=device.createBuffer({size:source.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,target,0,source.size);device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);const result=new Uint32Array(target.getMappedRange()).slice();target.unmap();target.destroy();return result;
  };
  try {
    device.pushErrorScope('validation');
    stage('Canonical certificate: analytic quad value and gradient containment');
    report.cases.push(...await checkCanonicalSupport(device,assert));
    const targets=256;
    const layout=surfaceDemandLayout(targets,1),workspaceLayout=surfaceCellWorkspaceLayout(targets/64);
    const execution=15*IW,constants=execution+EW,directory=constants+64;
    const metadataWords=new Uint32Array(directory+8);
    const bits=value=>new Uint32Array(new Float32Array(value).buffer);
    for(let field=0;field<15;field++) {
      metadataWords.set([field+1,field,0,1|(1<<9),0,0,1,1,execution+8+field*FW],field*IW);
      metadataWords[execution+8+field*FW+3]=3;
      metadataWords.set(bits([.5,.5,1,0]),constants+4+field*4);
    }
    metadataWords[constants+4+10*4]=0; // no coat: its mapped normal is not a Ddirect dependency
    SURFACE_SIGNAL_FIELD_MASKS.forEach((mask,kind)=>metadataWords[execution+8+15*FW+kind*12+1]=mask);
    const metadata=buffer(metadataWords),versions=buffer(new Uint32Array(60).fill(1));
    const arena=buffer(new Uint32Array(layout.bytes/4)),workspace=buffer(new Uint32Array(workspaceLayout.bytes/4));
    const settings=buffer(new Uint32Array([0,constants,64,4,3,1,1,1,0,0,0,0,0,1,0,0,
      directory,1,layout.fieldAdmissionCapacity,layout.signalAdmissionCapacity,0,1,8,8]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const sun=buffer(new Uint32Array(12),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),shadow=buffer(new Uint32Array(4));
    const keys=buffer(new Uint32Array(6*74));
    const entries=Array.from({length:8},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,
      buffer:{type:binding===0||binding===5?'uniform':[1,4,7].includes(binding)?'storage':'read-only-storage'}}));
    const bindLayout=device.createBindGroupLayout({entries});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[bindLayout]});
    const module=device.createShaderModule({code:surfaceDemandWgsl(targets,1)+`
      @group(0) @binding(7) var<storage,read_write> output_keys:array<u32>;
      @compute @workgroup_size(64) fn inspect_signal_keys(@builtin(global_invocation_id) id:vec3u) {
        if id.x>=6u {return;}
        let fields=signal_request_fields(0u,id.x);
        output_keys[id.x*74u]=fields;
        output_keys[id.x*74u+1u]=u32(signal_request_cacheable(0u,fields,id.x));
        for(var word=0u;word<72u;word++) {
          output_keys[id.x*74u+2u+word]=signal_request_word(0u,id.x,word,fields);
        }
      }`});
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const names=['emit_surface_requests','finalize_surface_requests','nominate_field_producers','resolve_field_producers',
      'emit_signal_cache_requests','finalize_surface_requests',
      'nominate_signal_producers','resolve_signal_producers','compact_surface_groups','finalize_surface_groups','order_material_groups'];
    const pipelines=[];
    for(const entryPoint of [...names,'inspect_signal_keys']) {
      pipelines.push(await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
    }
    const resources=[settings,workspace,metadata,versions,arena,sun,shadow,keys];
    const group=device.createBindGroup({layout:bindLayout,entries:resources.map((resource,binding)=>({binding,resource:{buffer:resource}}))});
    const base=(leaves=64)=>{
      const words=new Uint32Array(workspaceLayout.bytes/4),floats=new Float32Array(words.buffer);
      for(let leaf=0;leaf<leaves;leaf++) {
        words.set([1,0,0,0],workspaceLayout.facts/4+leaf*4);
        const at=workspaceLayout.addresses/4+leaf*144;
        words.set([1,1,1,1,0,0,0,0,0,1,1,1,1,leaf,0,7],at);words[at+93]=7;words[at+136]=3;
        floats.set([.2,.3,.01,0,0,.01],at+16);
        floats.set([0,0,1,1],at+106);floats.set([1,0,0,1],at+118);
        for(let field=0;field<15;field++)words.set([1,0,1],workspaceLayout.fieldReferences/4+(leaf*15+field)*3);
        for(let kind=0;kind<6;kind++)words.set([3,0,1],workspaceLayout.signalReferences/4+(leaf*6+kind)*3);
      }
      for(let tile=0;tile<targets/64;tile++)for(let plane=0;plane<21;plane++) {
        words.set([2,0,0,64,0xffffffff,0xffffffff],workspaceLayout.plans/4+tile*(SURFACE_CELL_TILE_PLAN_BYTES/4)+16+plane*6);
      }
      return words;
    };
    const execute=async(words,meta=metadataWords)=>{
      device.queue.writeBuffer(workspace,0,words);device.queue.writeBuffer(metadata,0,meta);
      device.queue.writeBuffer(arena,0,new Uint32Array(arena.size/4));
      const encoder=device.createCommandEncoder();
      for(const pipeline of pipelines.slice(0,-1)) {
        const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(targets/64);pass.end();
      }
      device.queue.submit([encoder.finish()]);return {arena:await read(arena),workspace:await read(workspace)};
    };
    const missing=(words,fieldMask,signalMask,leaves=64)=>{
      for(let leaf=0;leaf<leaves;leaf++) {
        for(let field=0;field<15;field++)if(fieldMask&(1<<field))words[workspaceLayout.fieldReferences/4+(leaf*15+field)*3]=0;
        for(let kind=0;kind<6;kind++)if(signalMask&(1<<kind))words[workspaceLayout.signalReferences/4+(leaf*6+kind)*3]=0;
      }
    };
    stage('Actual mask demand: empty, hit, transient, bounded admission and partial miss');
    const empty=base();for(let leaf=0;leaf<64;leaf++)empty[workspaceLayout.facts/4+leaf*4]=0xffffffff;
    for(const [name,words,expected] of [['empty',empty,[0,0,0]],['all-hit',base(),[0,0,0]],
      ['fine-transient',(()=>{const w=base();missing(w,0x7fff,63);return w;})(),[64,64,64]],
      ['only-normal-missing',(()=>{const w=base();missing(w,1<<6,0);return w;})(),[64,64,0]],
      ['only-environment-dirty',(()=>{const w=base();missing(w,0,2);return w;})(),[64,0,64]]]) {
      const result=await execute(words),counts=result.arena;
      assert.deepEqual([counts[0],counts[5],counts[6]],expected,name);
      if(name==='fine-transient') {
        assert.equal(counts[1],0);assert.equal(counts[2],0,'Transient fields prevent persistent Signal identity');
        for(let leaf=0;leaf<64;leaf++)for(let field=0;field<15;field++) {
          const at=workspaceLayout.fieldReferences/4+(leaf*15+field)*3;
          assert.equal(result.workspace[at],4);assert.equal(result.workspace[at+1],leaf*15+field);
        }
      }
      report.cases.push({name,counts:[...counts.slice(0,8)]});
      if(name==='only-normal-missing') {
        assert.equal(counts[layout.offsets.geometry_masks/4],1<<1,'Only actual missing closure contributes cold inputs');
      }
      if(name==='only-environment-dirty') {
        assert.equal(counts[layout.offsets.geometry_masks/4],1<<15,'Lighting hot record does not force cold neighbors');
      }
    }
    const stable=metadataWords.slice();for(let field=0;field<15;field++)stable[execution+8+field*FW+3]=1;
    const full=base();missing(full,0x7fff,0);
    let result=await execute(full,stable);
    assert.equal(result.arena[1],layout.fieldAdmissionCapacity);assert.equal(result.arena[47],960-layout.fieldAdmissionCapacity);
    assert.equal(result.arena[5],64,'Admission dedup never removes mandatory target closures');
    assert.equal(result.arena[3],15,'One Store writer per complete key');
    report.cases.push({name:'field-admission-full',accepted:result.arena[1],rejected:result.arena[47],materialTargets:64});
    const signalFull=base();missing(signalFull,0,63);result=await execute(signalFull);
    assert.equal(result.arena[2],layout.signalAdmissionCapacity);assert.equal(result.arena[48],384-layout.signalAdmissionCapacity);assert.equal(result.arena[6],64);
    report.cases.push({name:'signal-admission-full',accepted:result.arena[2],rejected:result.arena[48],lightingTargets:64});
    // FNV-1a modulo a power of two preserves the low bits when one input word
    // changes by that modulus. 128 distinct complete keys, each duplicated,
    // share one initial bucket but only 64 probe locations can be nominated.
    // At least 64 duplicated keys must reject admission in any GPU order.
    device.queue.writeBuffer(settings,8,new Uint32Array([targets]));
    for(const signal of [false,true]) {
      const words=base(targets);
      missing(words,signal?0:1,signal?2:0,targets);
      for(let leaf=0;leaf<targets;leaf++) {
        words[workspaceLayout.addresses/4+leaf*144+4]=(leaf%128)*layout.fieldHashCapacity;
      }
      result=await execute(words,signal?metadataWords:stable);
      const countWord=signal?4:3,fallbackWord=signal?45:44;
      const prefix=signal?'signal':'field',plane=signal?1:0,stride=signal?6:15;
      assert.equal(result.arena[signal?6:5],targets,'All mandatory target closures survive hash exhaustion');
      assert.ok(result.arena[fallbackWord]>=128,'The bounded failure branch executed for duplicated keys');
      const writerKeys=new Set();
      for(let index=0;index<result.arena[countWord];index++) {
        const request=result.arena[layout.offsets[`unique_${prefix}s`]/4+index];
        const leaf=result.arena[layout.offsets[`${prefix}_requests`]/4+request*4];
        const key=leaf%128;
        assert.ok(!writerKeys.has(key),'At most one Store writer per complete key, including rejected duplicates');
        writerKeys.add(key);
      }
      assert.ok(writerKeys.size>0&&writerKeys.size<=64,'Ordinary legal cache admission remains available');
      for(let leaf=0;leaf<targets;leaf++) {
        const at=workspaceLayout[signal?'signalReferences':'fieldReferences']/4+(leaf*stride+plane)*3;
        assert.equal(result.workspace[at],4);
        assert.equal(result.workspace[at+1],leaf*stride+plane);
        assert.equal(result.arena[layout.offsets[signal?'lighting_masks':'material_masks']/4+leaf],1<<plane);
      }
      report.cases.push({name:`${prefix}-bounded-collision-duplicates`,requests:targets,
        uniqueWriters:writerKeys.size,unresolved:result.arena[fallbackWord],mandatoryTargets:targets});
    }
    device.queue.writeBuffer(settings,8,new Uint32Array([64]));
    for(const semantic of [3,0]) {
      const words=base();words[workspaceLayout.addresses/4+136]=semantic;device.queue.writeBuffer(workspace,0,words);
      device.queue.writeBuffer(metadata,0,metadataWords);
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(pipelines.at(-1));pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
      const packed=await read(keys);
      assert.equal(packed[72],semantic);assert.equal(packed[73],packed[0]);
      if(semantic===3)assert.equal(packed[0]&((1<<0)|(1<<2)|(1<<3)|(1<<8)|(1<<9)|(1<<11)|(1<<12)|(1<<14)),0);
      else assert.ok(packed[0]&1);
      report.cases.push({name:semantic===3?'transport-key':'residual-key',fields:packed[0],semantic:packed[72]});
      for(const field of [0,2,3,7,8,9,12,14]) {
        const changed=new Uint32Array(60).fill(1);changed[field*4]=77;
        device.queue.writeBuffer(versions,0,changed);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipelines.at(-1));pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();device.queue.submit([encoder.finish()]);
        const next=await read(keys);
        if(semantic===3)assert.deepEqual([...next.slice(0,74)],[...packed.slice(0,74)],`No-coat transport omits field ${field}`);
        else assert.ok(next.some((value,index)=>index<74&&value!==packed[index]),`Residual preserves field ${field}`);
      }
      device.queue.writeBuffer(versions,0,new Uint32Array(60).fill(1));
    }
    // Actual publishers: formula values -> Produced -> later commit -> refs.
    for(const isSignal of [false,true]) {
    const prefix=isSignal?'signal':'field',stride=isSignal?88:64;
    const stateAt=isSignal?80:58,generationAt=isSignal?77:57,touchedAt=isSignal?79:59;
    const refBase=workspaceLayout[isSignal?'signalReferences':'fieldReferences']/4;
    const valueStride=isSignal?6:15,plane=isSignal?1:0;
    const pubEntries=Array.from({length:9},(_,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,
      buffer:{type:binding===0||binding===7?'uniform':[1,4,5].includes(binding)?'storage':'read-only-storage'}}));
    const pubLayout=device.createBindGroupLayout({entries:pubEntries});
    const pubPipelineLayout=device.createPipelineLayout({bindGroupLayouts:[pubLayout]});
    const pubModule=device.createShaderModule({code:surfaceStorePublishWgsl(targets,1,isSignal)});
    assert.deepEqual((await pubModule.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const pubPipelines=[];for(const entryPoint of ['admit_surface_values','commit_surface_values','publish_surface_references']) {
      pubPipelines.push(await device.createComputePipelineAsync({layout:pubPipelineLayout,compute:{module:pubModule,entryPoint}}));
    }
    const pubSettings=buffer(new Uint32Array([0,constants,64,4,3,1,1,1,0,0,0,0,1,1,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const values=buffer(new Float32Array(targets*valueStride*4).fill(70000)),store=buffer(new Uint32Array(4*stride));
    const pubResources=[pubSettings,workspace,metadata,versions,arena,store,values,sun,shadow];
    const pubGroup=device.createBindGroup({layout:pubLayout,entries:pubResources.map((resource,binding)=>({binding,resource:{buffer:resource}}))});
    const publish=async indices=>{
      const encoder=device.createCommandEncoder();for(const index of indices) {
        const pass=encoder.beginComputePass();pass.setPipeline(pubPipelines[index]);pass.setBindGroup(0,pubGroup);pass.dispatchWorkgroups(layout.fieldAdmissionCapacity/64);pass.end();
      }device.queue.submit([encoder.finish()]);
    };
    const collision=base(targets);missing(collision,isSignal?0:1,isSignal?2:0,targets);
    for(let leaf=0;leaf<targets;leaf++) {
      collision[workspaceLayout.addresses/4+leaf*144+4]=(leaf%128)*layout.fieldHashCapacity;
    }
    device.queue.writeBuffer(settings,8,new Uint32Array([targets]));
    const rejected=await execute(collision,isSignal?metadataWords:stable);
    const rejectedRequest=[...rejected.arena.slice(layout.offsets[`${prefix}_aliases`]/4,
      layout.offsets[`${prefix}_aliases`]/4+targets)].findIndex(owner=>owner===0xffffffff);
    assert.ok(rejectedRequest>=0);
    const rejectedLeaf=rejected.arena[layout.offsets[`${prefix}_requests`]/4+rejectedRequest*4];
    await publish([2]);
    const rejectedRef=refBase+(rejectedLeaf*valueStride+plane)*3;
    assert.equal((await read(workspace))[rejectedRef],4,'Unresolved owner cannot publish a Store reference');
    report.cases.push({name:`${prefix}-unresolved-reference-publication`,rejectedRequest,rejectedLeaf,kind:4});
    device.queue.writeBuffer(settings,8,new Uint32Array([64]));
    for(const [name,state,generation,touched,admit] of [['available',0,41,0,true],['stale-published',2,41,2,true],
      ['reserved-full',1,41,0,false],['pinned-full',2,41,3,false],['produced-full',3,41,0,false],
      ['retiring-full',4,41,0,false],['generation-exhausted',0,0xfffffffe,0,false]]) {
      const one=base();missing(one,isSignal?0:1,isSignal?2:0);await execute(one,isSignal?metadataWords:stable);
      const table=new Uint32Array(4*stride);for(let entry=0;entry<4;entry++) {
        table[entry*stride+generationAt]=generation;table[entry*stride+stateAt]=state;table[entry*stride+touchedAt]=touched;
      }
      device.queue.writeBuffer(store,0,table);await publish([0]);
      const produced=await read(store),requests=await read(arena),owner=requests[layout.offsets[`unique_${prefix}s`]/4];
      const slot=requests[layout.offsets[`${prefix}_results`]/4+owner];
      const ref=refBase+plane*3;
      if(admit) {
        assert.ok(slot!==0xffffffff);assert.equal(produced[slot*stride+stateAt],3);
        assert.equal(new Float32Array(produced.buffer)[slot*stride+(isSignal?72:32)],70000,'HDR f32 retained');
        assert.equal((await read(workspace))[ref],4,'Uncommitted value is not published');
        await publish([2]);
        assert.equal((await read(workspace))[ref],4,'Produced payload cannot publish a reference before commit');
        await publish([1,2]);const refs=await read(workspace),committed=await read(store);
        assert.equal(committed[slot*stride+stateAt],2);assert.equal(refs[ref],5);
        assert.equal(refs[ref+2],42);
      } else {
        assert.equal(slot,0xffffffff);await publish([1,2]);assert.equal((await read(workspace))[ref],4);
      }
      report.cases.push({name:`${prefix}-${name}`,admitted:admit});
    }
    }
    assert.equal(await device.popErrorScope(),null);assert.deepEqual(apiErrors,[]);report.passed=true;
  } catch(error) {report.failure=error.stack??String(error);} finally {for(const resource of retained)resource.destroy();device.destroy();}
  return report;
}
