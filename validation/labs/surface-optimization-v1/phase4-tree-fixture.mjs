import {APPEARANCE_FIELD_BOUND_WGSL} from '../../../OEngine/.test-dist/shaders/appearance_field_bounds.js';
import {SURFACE_CELL_ADDRESS_MATH_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_address_math.js';
import {WINNER_INTERPOLATION_WGSL} from '../../../OEngine/.test-dist/shaders/winner_interpolation.js';
import {SURFACE_CELL_CERTIFICATE_READ_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_certificates.js';
import {SURFACE_CELL_DOMAIN_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_domain.js';
import {SURFACE_CELL_LIGHTING_RISK_PREDICATE_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_lighting_risk.js';
import {surfaceCellClassifyStageWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_classify.js';
import {surfaceProofAdmissionWgsl} from '../../../OEngine/.test-dist/gpu/GpuSurfaceProofAbi.js';
import {surfaceCellWorkspaceLayout,surfaceCellSelectionWgsl,SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS as OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {SURFACE_REFERENCE_WGSL,SURFACE_CELL_ADDRESS_WORDS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceReferenceAbi.js';
import {SURFACE_EXECUTION_WORDS,SURFACE_FIELD_EXECUTION_WORDS as FW,SURFACE_SIGNAL_EXECUTION_WORDS as SW} from '../../../OEngine/.test-dist/gpu/GpuSurfaceExecutionProfileAbi.js';
import {SURFACE_SIGNAL_FIELD_MASKS} from '../../../OEngine/.test-dist/material/AppearanceExecutionProfile.js';
import {POINT_LIGHT_DESCRIPTOR as POINT,POINT_LIGHT_RECORD_TYPE as POINT_TYPE} from '../../../OEngine/.test-dist/gpu/LightDatabase.js';

/** Analytic bounds/lineage are independent inputs. The actual production tree,
 * complete DomainKey, bounded Lighting predicate and source reader run on GPU. */
export async function runPhaseFourTree(gpu,assert,onStage=()=>{}) {
  const report={evidenceRole:'diagnostic',passed:false,cases:[],apiErrors:[]};
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  assert.ok(adapter&&!adapter.info.isFallbackAdapter);
  const device=await adapter.requestDevice();
  device.addEventListener('uncapturederror',event=>report.apiErrors.push(event.error.message));
  const retained=[];
  const buffer=(size,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC)=>{
    const resource=device.createBuffer({size,usage});retained.push(resource);return resource;
  };
  try {
    device.pushErrorScope('validation');
    const layout=surfaceCellWorkspaceLayout(4);
    const workspace=buffer(layout.bytes);
    const cells=buffer(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const settings=buffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const metadata=buffer(SURFACE_EXECUTION_WORDS*4);
    const lights=buffer(16384*4);
    const lookup=buffer(2*16);
    const clusterData=buffer(32*4);
    const sources=buffer(64*21*4);
    const visibility=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    retained.push(visibility);
    const library=`
${WINNER_INTERPOLATION_WGSL}
${APPEARANCE_FIELD_BOUND_WGSL}
${SURFACE_CELL_ADDRESS_MATH_WGSL}
${SURFACE_REFERENCE_WGSL}
struct DomainSettings { appearance2: vec4u, }
@group(1) @binding(0) var<uniform> settings: DomainSettings;
@group(1) @binding(1) var<storage,read> appearance_metadata: array<u32>;
struct CellLaneGeometry {
  identity:vec4u, source:vec4u, continuity0:vec4u, continuity1:vec4u,
  address:vec4u, plane:vec4f, slot:u32,
}
var<workgroup> cell_lane_geometry: array<CellLaneGeometry,64>;
fn cell_material_entry(material:u32)->u32 { return material; }
fn cell_certificate_publication(leaf:u32,field:u32)->AppearanceBound4 { return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u)); }
fn cell_directory(entry:u32)->vec4u { return vec4u(0u); }
fn cell_solar_direction()->vec3f { return vec3f(0.0,0.0,1.0); }
fn surface_cell_load(pixel:vec2u,winner:u32)->SurfaceCellLane {
  let lane=pixel.y*8u+pixel.x;
  let at=lane*${SURFACE_CELL_ADDRESS_WORDS}u;
  let identity=vec4u(cell_workspace.addresses[at],cell_workspace.addresses[at+1u],cell_workspace.addresses[at+2u],cell_workspace.addresses[at+8u]);
  let continuity=vec4u(cell_workspace.addresses[at+7u],cell_workspace.addresses[at+9u],cell_workspace.addresses[at+10u],cell_workspace.addresses[at+17u]);
  cell_lane_geometry[lane]=CellLaneGeometry(identity,vec4u(winner,cell_workspace.addresses[at+4u],cell_workspace.addresses[at+3u],cell_workspace.addresses[at+12u]),
    continuity,vec4u(cell_workspace.addresses[at+20u],cell_workspace.addresses[at+21u],0u,0u),vec4u(0u,cell_workspace.addresses[at+6u],cell_workspace.addresses[at+5u],0u),vec4f(0.0,0.0,1.0,0.0),lane);
  return SurfaceCellLane(vec4u(identity.xyz,continuity.x),winner,lane,2097151u,cell_workspace.addresses[at+15u]);
}
${SURFACE_CELL_DOMAIN_WGSL}
fn cell_merge_bound(a:AppearanceBound4,b:AppearanceBound4)->AppearanceBound4 {
  return AppearanceBound4(min(a.low,b.low),max(a.high,b.high),a.known&b.known);
}
fn cell_field_budget(field:u32,value:AppearanceBound4)->bool {
  let width=select(1u,3u,field==0u||field==5u||field==6u||field==9u||field==12u);
  for(var channel=0u;channel<width;channel++) { if !ab_valid(ab_channel(value,channel)) { return false; } }
  if field==6u||field==12u { return cell_normal_box_cone(value.low.xyz,value.high.xyz).w>=0.99965732498; }
  for(var channel=0u;channel<width;channel++) { if value.high[channel]-value.low[channel]>0.02 { return false; } }
  return true;
}
fn cell_material_signal_dependencies(plane:u32,entry:u32,leaf:u32)->u32 {
  return appearance_metadata[8u+15u*${FW}u+(plane-15u)*${SW}u+1u];
}
${SURFACE_CELL_CERTIFICATE_READ_WGSL}
${surfaceProofAdmissionWgsl('cell_workspace')}
${SURFACE_CELL_LIGHTING_RISK_PREDICATE_WGSL}
${surfaceCellSelectionWgsl('cell_workspace','appearance_metadata','0u')}
@group(3) @binding(0) var<storage,read_write> selected_sources:array<u32>;
@compute @workgroup_size(64)
fn consume_sources(@builtin(global_invocation_id) id:vec3u) {
  if id.x<64u*21u { selected_sources[id.x]=reference_plan_leaf(id.x%64u,id.x/64u); }
}`;
    const source=surfaceCellClassifyStageWgsl(library,4,0,0,21,'classify_tree','full');
    const module=device.createShaderModule({code:source});
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(message=>message.type==='error').map(message=>message.message),[]);
    onStage('Compiling production fixed tree and provider budget');
    const classify=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'classify_tree'}});
    const consume=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'consume_sources'}});
    const groups=[
      device.createBindGroup({layout:classify.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:cells}},{binding:1,resource:visibility.createView()},{binding:2,resource:{buffer:workspace}}]}),
      device.createBindGroup({layout:classify.getBindGroupLayout(1),entries:[
        {binding:0,resource:{buffer:settings}},{binding:1,resource:{buffer:metadata}}]}),
      device.createBindGroup({layout:classify.getBindGroupLayout(2),entries:[
        {binding:0,resource:{buffer:lights}},{binding:1,resource:{buffer:lookup}},{binding:2,resource:{buffer:clusterData}}]})
    ];
    const consumeWorkspace=device.createBindGroup({layout:consume.getBindGroupLayout(0),entries:[{binding:2,resource:{buffer:workspace}}]});
    const consumeOutput=device.createBindGroup({layout:consume.getBindGroupLayout(3),entries:[{binding:0,resource:{buffer:sources}}]});
    const metadataWords=new Uint32Array(SURFACE_EXECUTION_WORDS);
    const seams=Array(15).fill(0);seams[0]=1;seams[1]=64;
    for(let field=0;field<15;field++) {
      const at=8+field*FW;
      metadataWords[at+2]=seams[field];
      metadataWords[at+12]=field>=2&&field<=4?102:100+field;
    }
    SURFACE_SIGNAL_FIELD_MASKS.forEach((fields,kind)=>{
      const at=8+15*FW+kind*SW;
      metadataWords[at]=200+kind;metadataWords[at+1]=fields;
      metadataWords[at+3]=12;
      for(let field=0;field<15;field++) if(fields&(1<<field))metadataWords[at+3]|=seams[field];
      // Current publication ABI stores the premerged Ddirect seam in word 10;
      // retain word 3 as the signal's immutable source seam for other consumers.
      metadataWords[at+10]=metadataWords[at+3];
    });
    device.queue.writeBuffer(metadata,0,metadataWords);
    const cases=[
      {name:'continuous full tree',field:4,environment:1,direct:1,provider:21},
      {name:'albedo UV0 checkerboard is compose-only for transport',seam:true,field:64,environment:1,direct:1},
      {name:'normal UV0 seam still rejects transport sharing',seam:true,normalSeam:true,field:64,environment:64,direct:64},
      {name:'half-vector singular support retains fine direct',halfSingular:true,lightCount:1,field:4,environment:1,direct:64,provider:21},
      {name:'UV2 primitive-local namespace',uv2:true,field:4,alpha:64,environment:1},
      {name:'different cluster rejects direct despite equal lists',clusters:true,field:4,environment:1,direct:64,provider:0},
      {name:'side rejects the complete DomainKey',side:true,field:64,environment:64},
      {name:'published meshlet continuity permits UV0 but preserves local UV2',meshlets:true,field:4,alpha:64,environment:1},
      {name:'unknown representation continuity cannot synthesize domain',representation:true,field:64,environment:64},
      {name:'point hits retain fine refs while transport omits albedo proof',hits:true,field:64,environment:64,direct:1},
      {name:'publication excludes its field from classification',publication:true,field:0,environment:1},
      {name:'local Unknown preserves unrelated field',unknown:true,field:4,environment:10},
      {name:'partial mixed coverage maps real anchors',partial:true,fieldMode:4},
      {name:'full mixed-map reservation falls back to complete implicit fine',partial:true,mapsFull:true,fieldMode:2},
      {name:'nine punctual lights exhaust front proof only',lightCount:9,field:4,environment:1,direct:64,provider:21},
      {name:'eight distant lights retain complete bounded risk',lightCount:8,field:4,environment:1,direct:1,provider:21},
      {name:'receiver shadow without certificate',shadow:true,field:4,environment:1,direct:64,provider:21},
      {name:'shared proof capacity full retains fine direct work',full:true,field:4,environment:1,direct:64,provider:0},
      {name:'two remaining proof slots prioritize the complete root',remaining:true,field:4,environment:1,direct:1,provider:2}
    ];
    for(const scenario of cases) {
      onStage(scenario.name);
      const currentMetadata=metadataWords.slice();
      currentMetadata[8+6*FW+2]=scenario.normalSeam?1:0;
      let transportSeam=12;
      for(let field=0;field<15;field++)if(SURFACE_SIGNAL_FIELD_MASKS[0]&(1<<field)) {
        transportSeam|=currentMetadata[8+field*FW+2];
      }
      currentMetadata[8+15*FW+10]=transportSeam;
      for (const kind of [1, 3, 5]) {
        currentMetadata[8+15*FW+kind*SW+3]=scenario.normalSeam?1:12;
        currentMetadata[8+15*FW+kind*SW+10]=scenario.normalSeam?1:12;
      }
      device.queue.writeBuffer(metadata,0,currentMetadata);
      const words=new Uint32Array(layout.bytes/4),floats=new Float32Array(words.buffer),winners=new Uint32Array(64);
      words[120]=scenario.full?128:scenario.remaining?126:32;
      if(scenario.mapsFull)words[126]=4*21*24;
      for(let lane=0;lane<64;lane++) {
        const x=lane%8,y=Math.floor(lane/8),at=layout.addresses/4+lane*SURFACE_CELL_ADDRESS_WORDS;
        const covered=!(scenario.partial&&(lane===0||lane===17||x===7));
        winners[lane]=covered?lane+1:0xffffffff;
        words.set([1,7,3,11,0,scenario.meshlets?x%2:0,scenario.uv2?x%2:0,scenario.representation&&x%2?0:19,scenario.side?x%2:1,
          scenario.seam?x%2:scenario.partial&&x>=3?23:17,29,0,31],at);
        words[at+15]=scenario.publication?1:0;words[at+17]=37;words[at+20]=41;words[at+21]=43;
        words[at+18]=3; // Explicit finite transport profile in this isolated tree oracle.
        words.set([lane+1,lane,0,scenario.clusters?x%2:0],layout.facts/4+lane*4);
        const quad=Math.floor(y/2)*4+Math.floor(x/2);
        words[layout.primitives/4+lane]=quad;
        words[layout.geometryProofs/4+lane]=quad+1;
        words.set([quad,1,0xffffffff,0xffffffff,4,0,0,0],layout.proofs/4+quad*8);
        words.set([quad,3,32767,0xffffffff,4,32767,0,0],layout.proofs/4+(16+quad)*8);
        const geometry=layout.proofResults/4+quad*52;
        floats.set([x*.0001,y*.0001,0,x*.0001,y*.0001,0],geometry);
        floats.set([0,0,1,0,0,1],geometry+6);
        floats.set([1,0,0,1,0,0],geometry+12);
        floats.set([0,0,1,0,0,1],geometry+18);
        floats.set([0,0,0,0,1,0,1],geometry+24);words[geometry+31]=31;
        const certificate=layout.proofResults/4+(16+quad)*52;
        for(let field=0;field<15;field++)words[layout.screenFieldProofs/4+lane*15+field]=17+quad;
        for(let field=0;field<15;field++) {
          const vector=field===6||field===12?[0,0,1]:field===0||field===5||field===9?[.25,.25,.25]:field===3||field===11?[.8]:field===10?[1]:[.25];
          floats.set([...vector,...vector],certificate+OFFSETS[field]);
        }
        const known=layout.fieldKnownMasks/4+lane;
        words[known]=(1<<25)-1;
        if(scenario.unknown&&quad===0)words[known]&=~(7<<(OFFSETS[6]/2));
        if(scenario.hits) {
          words[known]&=~7;
          words[layout.fieldStoreMasks/4+lane]=1;
          words[layout.signalStoreMasks/4+lane]=2;
          words.set([lane,1],layout.fieldReferences/4+lane*15*2);
          words.set([lane,1],layout.signalReferences/4+(lane*6+1)*2);
        }
      }
      const lightWords=new Uint32Array(16384).fill(0xffffffff),lightFloats=new Float32Array(lightWords.buffer);
      const page=8192;
      lightWords[POINT.page_lookup_address]=page;lightWords[page]=0;lightWords[page+1]=(1<<(scenario.lightCount??0))-1;
      for(let light=0;light<(scenario.lightCount??0);light++) {
        const start=page+POINT.page_header_words+light*POINT.packed_element_size_bytes/4;
        const values={position:[0,0,scenario.halfSingular?-100:100],color:[1,1,1],distance:[1000],radius:[1],flags:[0],near_clip_distance:[.01],shadow_id:[0]};
        for(const field of POINT_TYPE.fields) {
          const target=field.name==='flags'||field.name==='shadow_id'?lightWords:lightFloats;
          target.set(values[field.name],start+field.offset/4);
        }
      }
      const count=scenario.lightCount??0;
      device.queue.writeBuffer(lights,0,lightWords);
      device.queue.writeBuffer(lookup,0,new Uint32Array([0,count,0,0,0,count,0,0]));
      device.queue.writeBuffer(clusterData,0,new Uint32Array([count,count,16,0,0,0,0,0,...Array.from({length:16},(_,i)=>i)]));
      device.queue.writeBuffer(settings,0,new Uint32Array([0,scenario.shadow?3:0,0,0]));
      device.queue.writeBuffer(cells,0,new Uint32Array([8,8,1,0,1,64,1,1]));
      device.queue.writeBuffer(workspace,0,words);
      device.queue.writeTexture({texture:visibility},winners,{bytesPerRow:32},{width:8,height:8});
      const capture=buffer(layout.bytes+sources.size,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
      const encoder=device.createCommandEncoder();
      {const pass=encoder.beginComputePass();pass.setPipeline(classify);groups.forEach((group,index)=>pass.setBindGroup(index,group));pass.dispatchWorkgroups(1);pass.end();}
      {const pass=encoder.beginComputePass();pass.setPipeline(consume);pass.setBindGroup(0,consumeWorkspace);pass.setBindGroup(3,consumeOutput);pass.dispatchWorkgroups(21);pass.end();}
      encoder.copyBufferToBuffer(workspace,0,capture,0,layout.bytes);
      encoder.copyBufferToBuffer(sources,0,capture,layout.bytes,sources.size);
      device.queue.submit([encoder.finish()]);
      const validation=await device.popErrorScope();assert.equal(validation,null,validation?.message);device.pushErrorScope('validation');
      await capture.mapAsync(GPUMapMode.READ);const observed=new Uint32Array(capture.getMappedRange()).slice();capture.unmap();
      const plan=plane=>{const at=layout.plans/4+16+plane*6;return {mode:observed[at]&255,slots:observed[at+3]};};
      report.current={name:scenario.name,field:plan(0),environment:plan(16),direct:plan(15),proofCount:observed[120],rejected:observed[122],
        providerStates:Array.from({length:Math.min(128,observed[120])},(_,i)=>observed[layout.proofs/4+i*8+4])};
      for(const [property,plane] of [['field',0],['alpha',1],['environment',16],['direct',15]]) {
        if(scenario[property]!==undefined)assert.equal(plan(plane).slots,scenario[property],scenario.name+' '+property+': '+plan(plane).slots+' != '+scenario[property]);
      }
      if(scenario.fieldMode!==undefined)assert.equal(plan(0).mode,scenario.fieldMode);
      for(let plane=0;plane<21;plane++) for(let lane=0;lane<64;lane++) {
        const selected=observed[layout.bytes/4+plane*64+lane];
        if(winners[lane]===0xffffffff)assert.equal(selected,0xffffffff,'Background has no selected source');
        else {assert.ok(selected<64);assert.ok(winners[selected]!==0xffffffff,'Source must be a covered winner');}
      }
      assert.ok(observed[120]<=128);
      const provider=Array.from({length:observed[120]},(_,i)=>observed[layout.proofs/4+i*8+1]).filter(kind=>kind===4).length;
      if(scenario.provider!==undefined)assert.equal(provider,scenario.provider,'One provider admission per exact node/coverage across direct lobes');
      report.cases.push({name:scenario.name,field:plan(0),environment:plan(16),direct:plan(15),proofSlots:observed[120],providerProofs:provider});
    }
    assert.equal(await device.popErrorScope(),null);
    assert.deepEqual(report.apiErrors,[]);report.passed=true;
  } catch(error) { report.failure=error?.stack??String(error); }
  finally {for(const resource of retained)resource.destroy();device.destroy();}
  return report;
}
