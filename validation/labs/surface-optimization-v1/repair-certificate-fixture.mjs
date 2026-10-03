import {APPEARANCE_FIELD_BOUND_WGSL} from '../../../OEngine/.test-dist/shaders/appearance_field_bounds.js';
import {SURFACE_CELL_ADDRESS_MATH_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_address_math.js';
import {WINNER_INTERPOLATION_WGSL} from '../../../OEngine/.test-dist/shaders/winner_interpolation.js';
import {SURFACE_CELL_CERTIFICATE_READ_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_certificates.js';
import {surfaceCellClassifyStageWgsl} from '../../../OEngine/.test-dist/shaders/surface_cell_classify.js';
import {surfaceCellWorkspaceLayout,SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';

/** Analytic inputs are independent of the GPU leaf producers: child constant
 * intervals and exact parallel planes prove the parent rejection requirements. */
export async function checkCertificateParents(device,assert) {
  const retained=[];
  const buffer=(size,usage)=>{const result=device.createBuffer({size,usage});retained.push(result);return result;};
  device.pushErrorScope('validation');
  try {
    const factLibrary=`
${WINNER_INTERPOLATION_WGSL}
${APPEARANCE_FIELD_BOUND_WGSL}
${SURFACE_CELL_ADDRESS_MATH_WGSL}
struct AnalyticLaneGeometry { plane:vec4f, source:vec4u, }
var<workgroup> cell_lane_geometry:array<AnalyticLaneGeometry,64>;
fn cell_material_entry(material:u32)->u32 { return 0u; }
fn surface_cell_load(pixel:vec2u,winner:u32)->SurfaceCellLane {
  let lane=(pixel.y%8u)*8u+pixel.x%8u;
  let at=lane*32u;
  cell_lane_geometry[lane]=AnalyticLaneGeometry(bitcast<vec4f>(vec4u(cell_workspace.geometry_certificates[at+26u],
    cell_workspace.geometry_certificates[at+27u],cell_workspace.geometry_certificates[at+28u],cell_workspace.geometry_certificates[at+29u])),vec4u(0u));
  return SurfaceCellLane(vec4u(1u),winner,lane,1u|(1u<<16u)|(1u<<18u),0u);
}
fn surface_cell_compatible(plane:u32,a:SurfaceCellLane,b:SurfaceCellLane)->bool { return all(a.identity==b.identity); }
fn cell_merge_bound(a:AppearanceBound4,b:AppearanceBound4)->AppearanceBound4 { return AppearanceBound4(min(a.low,b.low),max(a.high,b.high),a.known&b.known); }
fn cell_field_budget(field:u32,value:AppearanceBound4)->bool {
  return all(value.known.xyz!=vec3u(0u)) && all(value.high.xyz-value.low.xyz<=vec3f(0.02));
}
fn cell_material_signal_dependencies(plane:u32,entry:u32)->u32 { return (1u<<6u)|(1u<<13u)|select(0u,1u<<3u,plane>=17u); }
fn cell_direct_group_safe(mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u,rect:vec4f,low:vec3f,high:vec3f,scale:f32)->bool { return true; }
${SURFACE_CELL_CERTIFICATE_READ_WGSL}`;
    const module=device.createShaderModule({code:surfaceCellClassifyStageWgsl(factLibrary,1,0,0,1,'classify_parent','field-geometry')});
    const info=await module.getCompilationInfo();assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'classify_parent'}});
    const signalModule=device.createShaderModule({code:surfaceCellClassifyStageWgsl(factLibrary,1,0,16,3,'classify_direction','full')});
    const signalInfo=await signalModule.getCompilationInfo();assert.deepEqual(signalInfo.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const signalPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:signalModule,entryPoint:'classify_direction'}});
    const layout=surfaceCellWorkspaceLayout(1),workspace=buffer(layout.bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);
    const settings=buffer(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(settings,0,new Uint32Array([8,8,1,0,1,64,1,1]));
    const visibility=device.createTexture({size:[8,8],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(visibility);
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:settings}},{binding:1,resource:visibility.createView()},{binding:2,resource:{buffer:workspace}}
    ]});
    const signalGroup=device.createBindGroup({layout:signalPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:settings}},{binding:1,resource:visibility.createView()},{binding:2,resource:{buffer:workspace}}
    ]});
    const cases=[{name:'continuous parent',groups:4},{name:'safe children exceed parent color budget',groups:16,colors:true},
      {name:'child plane residual changes parent anchor',groups:16,planes:true},{name:'unknown is local',unknown:true},
      {name:'partial coverage',partial:true},{name:'safe child directions exceed parent cone',direction:true,groups:16},
      {name:'glossy signal rejects sharing',glossy:true,groups:64},{name:'unknown normal is local',unknownNormal:true}];
    const results=[];
    for(const scenario of cases){
      const words=new Uint32Array(layout.bytes/4),floats=new Float32Array(words.buffer),winners=new Uint32Array(64);
      for(let lane=0;lane<64;lane++){
        const x=lane%8,y=Math.floor(lane/8),height=scenario.planes&&x%4>=2?2:0;
        const color=scenario.colors ? 0.1+Math.floor(x/2)%2*0.04+Math.floor(y/2)%2*0.04 : 0.25;
        winners[lane]=scenario.partial&&x>=5?0xffffffff:lane+1;
        words[layout.primitives/4+lane]=lane;
        const geometry=layout.geometryCertificates/4+lane*32;
        floats.set([x&~1,y&~1,height,(x&~1)+1,(y&~1)+1,height],geometry);
        floats.set([0,0],geometry+24);floats.set([0,0,1,-height],geometry+26);floats[geometry+30]=1;words[geometry+31]=17;
        const tilted=scenario.direction&&Math.floor(x/2)%2;
        const normal=tilted?[Math.sin(Math.PI/18),0,Math.cos(Math.PI/18)]:[0,0,1];
        floats.set([...normal,...normal],geometry+6);floats.set([1,0,0,1,0,0],geometry+12);floats.set([0,0,1,0,0,1],geometry+18);words[geometry+31]=31;
        const field=layout.fieldCertificates/4+lane*52;
        floats.set([color,color,color,color,color,color],field);
        words[field+50]=scenario.unknown&&lane===0?0:7;
        if(scenario.direction||scenario.glossy||scenario.unknownNormal){
          const offset=field+SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS[6];floats.set([0,0,1,0,0,1],offset);
          floats.set([1,1],field+SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS[13]);
          floats.set(scenario.glossy?[.05,.05]:[.8,.8],field+SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS[3]);
          words[field+50]=(1<<25)-1;
          if(scenario.unknownNormal&&lane===0)words[field+50]&=~(7<<(SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS[6]/2));
        }
      }
      device.queue.writeBuffer(workspace,0,words);device.queue.writeTexture({texture:visibility},winners,{bytesPerRow:32},{width:8,height:8});
      const staging=buffer(layout.bytes,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
      const signal=scenario.direction||scenario.glossy||scenario.unknownNormal;
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(signal?signalPipeline:pipeline);pass.setBindGroup(0,signal?signalGroup:group);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(workspace,0,staging,0,layout.bytes);device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);const observed=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();
      const plane=scenario.glossy?18:signal?16:0;
      const plan=layout.plans/4+16+plane*6,mode=observed[plan]&255,rate=observed[plan]>>8,groups=observed[plan+3];
      if(scenario.groups!==undefined){assert.equal(mode,scenario.glossy?2:3);assert.equal(groups,scenario.groups);assert.equal(rate,scenario.glossy?0:scenario.groups===4?10:5);}
      if(scenario.unknown){assert.ok(groups>4&&groups<64);assert.equal(mode,4);}
      if(scenario.partial){assert.equal(observed[plan+4],0x1f1f1f1f);assert.equal(observed[plan+5],0x1f1f1f1f);assert.equal(groups,4);}
      if(scenario.unknownNormal){assert.ok(groups>1&&groups<64);assert.equal(mode,4);}
      results.push({name:scenario.name,mode,rate,groups,passed:true});
    }
    assert.equal(await device.popErrorScope(),null);return {passed:true,cases:results};
  }finally{for(const resource of retained)resource.destroy();}
}
