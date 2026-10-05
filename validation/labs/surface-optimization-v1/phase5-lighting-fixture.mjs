import {SurfaceLightingPass} from '../../../OEngine/.test-dist/render/surface/SurfaceLightingPass.js';
import {surfaceLightingWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceLightingWorkPass.js';
import {SurfaceReconstructionPass} from '../../../OEngine/.test-dist/render/surface/SurfaceReconstructionPass.js';
import {SURFACE_RADIOMETRY_WGSL} from '../../../OEngine/.test-dist/render/surface/SurfaceRadiometryPass.js';
import {SurfaceFrameResources} from '../../../OEngine/.test-dist/render/surface/SurfaceFrameResources.js';
import {FrameGraph,FrameGraphContext,FrameGraphResourceManager} from '../../../OEngine/.test-dist/framegraph/FrameGraph.js';
import {GPUBufferAllocator} from '../../../OEngine/.test-dist/gpu/GPUBufferAllocator.js';
import {GPUTextureAllocator} from '../../../OEngine/.test-dist/gpu/GPUTextureAllocator.js';
import {DIRECTIONAL_LIGHT_DESCRIPTOR as D,DIRECTIONAL_LIGHT_RECORD_TYPE as DT} from '../../../OEngine/.test-dist/gpu/LightDatabase.js';
import {surfaceDemandLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceDemandAbi.js';
import {surfaceCellWorkspaceLayout,SURFACE_CELL_TILE_PLAN_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';

const normalize=value=>{const length=Math.hypot(...value);return value.map(v=>v/length);};
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const clamp=value=>Math.min(1,Math.max(0,value));
const rgbAdd=(a,b)=>a.map((v,i)=>v+b[i]);
const rgbMul=(a,b)=>a.map((v,i)=>v*b[i]);
const transform=c=>[
  .627404*c[0]+.329282*c[1]+.0433136*c[2],
  .069097*c[0]+.919540*c[1]+.0113612*c[2],
  .0163916*c[0]+.0880132*c[1]+.895595*c[2]];
function numericOracle(input) {
  const n=input.mapped&&(input.normalValidity??1)>0.5?normalize(input.mapped):[0,0,1],v=input.view??[0,0,1],l=[0,0,1],h=normalize(rgbAdd(l,v));
  const noL=clamp(dot(n,l)),noV=clamp(dot(n,v)),noH=clamp(dot(n,h)),voH=clamp(dot(v,h));
  const alpha=Math.max(input.roughness**2,.002),a2=alpha*alpha;
  const denominator=noH*noH*(a2-1)+1,distribution=a2/(Math.PI*denominator*denominator);
  const visibility=.5/Math.max(noL*Math.sqrt(noV*noV*(1-a2)+a2)+noV*Math.sqrt(noL*noL*(1-a2)+a2),1e-6);
  const dielectric=((input.ior-1)/(input.ior+1))**2;
  const f0=input.base.map(value=>(dielectric+(value-dielectric)*input.metallic)*input.specColor);
  const fresnel=f0.map(value=>value+(1-value)*(1-voH)**5);
  const attenuation=1-(.04+.96*(1-voH)**5)*input.coat;
  const transport=[4,2,1].map(value=>value*noL/Math.PI*attenuation);
  const factor=input.base.map(value=>Math.max(0,value)*(1-input.metallic));
  const diffuse=rgbMul(factor,transport),specular=fresnel.map((value,i)=>value*visibility*distribution*[4,2,1][i]*noL*attenuation);
  const coatNormal=input.coatMapped&&(input.coatValidity??1)>0.5?normalize(input.coatMapped):[0,0,1];
  const coatAlpha=Math.max(.5**2,.002),coatA2=coatAlpha*coatAlpha,coatDenom=dot(coatNormal,h)**2*(coatA2-1)+1;
  const coatBrdf=coatA2/(Math.PI*coatDenom*coatDenom)*(.25/Math.max(voH*voH,.0000039))*(.04+.96*(1-voH)**5)*input.coat;
  const coat=[4,2,1].map(value=>value*clamp(dot(coatNormal,l))*coatBrdf);
  return {transport,diffuse,specular,coat,factor,f0};
}
const half=value=>{
  const sign=value>>>15,exponent=(value>>>10)&31,fraction=value&1023;
  return (sign?-1:1)*(exponent===0?2**-14*fraction/1024:exponent===31?Infinity:2**(exponent-15)*(1+fraction/1024));
};

export async function runPhaseFiveLighting(gpu,assert,stage) {
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});assert.ok(adapter&&!adapter.info.isFallbackAdapter);
  const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
  const retained=[],modules=[],apiErrors=[],report={passed:false,evidenceRole:'diagnostic',cases:[],apiErrors};
  device.addEventListener('uncapturederror',event=>apiErrors.push(event.error.message));
  const nativeModule=device.createShaderModule.bind(device);device.createShaderModule=d=>{const m=nativeModule(d);modules.push(m);return m;};
  const buffer=(data,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST)=>{
    const b=device.createBuffer({size:data.byteLength,usage});device.queue.writeBuffer(b,0,data);retained.push(b);return b;
  };
  const encodeHalf=value=>{
    if(value===0)return 0;
    const exponent=Math.floor(Math.log2(Math.abs(value))),fraction=Math.round((Math.abs(value)/2**exponent-1)*1024);
    return (value<0?0x8000:0)|((exponent+15)<<10)|fraction;
  };
  const texture=(format='rgba16float',color=[.8,.6,.4,1])=>{
    const t=device.createTexture({size:[1,1],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:t},new Uint16Array(color.map(encodeHalf)),{bytesPerRow:8},[1,1]);retained.push(t);return t.createView();
  };
  let compiled,context,allocator,textureAllocator,lighting,reconstruction,scratch;
  try {
    device.pushErrorScope('validation');
    const common={base:[.8,.4,.2],metallic:.25,roughness:.8,ior:1.5,specColor:1,coat:0,mask:1,semantic:3,ao:255};
    const cases=[
      {...common,name:'transport-only'},
      {...common,name:'AO-zero-does-not-darken-direct',ao:0},
      {...common,name:'diffuse-environment-AO-pi',mask:3,ao:128},
      {...common,name:'coat-attenuation',coat:.65},
      {...common,name:'colored-residual',semantic:0},
      {...common,name:'exceptional-combined-guard',semantic:0,specColor:1e38,roughness:.04},
      {...common,name:'all-direct-lobes',mask:21,coat:.7},
      {...common,name:'specular-environment',mask:8},
      {...common,name:'IOR-one-direct',ior:1,metallic:0,mask:4},
      {...common,name:'IOR-two-direct',ior:2,metallic:0,mask:4},
      {...common,name:'IOR-two-environment',ior:2,metallic:0,mask:8},
      {...common,name:'coat-environment',mask:32,coat:.7},
      {...common,name:'coat-normal-valid',mask:16,coat:.7,coatMapped:[.6,0,.8]},
      {...common,name:'coat-normal-invalid',mask:16,coat:.7,coatMapped:[.6,0,.8],coatValidity:0},
      {...common,name:'mapped-normal',mapped:[.6,0,.8]},
      {...common,name:'normal-invalid',mapped:[.6,0,.8],normalValidity:0},
      {...common,name:'zero-normal',mapped:[0,0,0]},
      {...common,name:'antiparallel-half',view:[0,0,-1]},
      {...common,name:'full-hit-packet',mask:0,hit:[.2,.3,.4]},
      {...common,name:'HDR-direct',base:[2,4,8],metallic:0}
    ];
    const width=8,height=8,layout=surfaceDemandLayout(64,1),wsLayout=surfaceCellWorkspaceLayout(1);
    const words=new Uint32Array(wsLayout.bytes/4),geometryWords=new Uint32Array(64*32),geometryFloats=new Float32Array(geometryWords.buffer);
    const metadataWords=new Uint32Array(cases.length*64),metadataFloats=new Float32Array(metadataWords.buffer);
    const demandWords=new Uint32Array(layout.bytes/4),aoBytes=new Uint8Array(64).fill(255),signalTable=new Uint32Array(4*88);
    let targets=0;
    cases.forEach((input,leaf)=>{
      words.set([1,0,leaf,0],wsLayout.facts/4+leaf*4);words[wsLayout.addresses/4+leaf*24+18]=input.semantic;
      const at=leaf*32;
      geometryFloats.set([0,0,0,1,0,0,1,0,1,0,0,1,...(input.view??[0,0,1]),0,0,0,1,0],at);
      geometryWords.set([leaf,0,leaf,0],at+20);geometryFloats.set([1,1,0,0],at+24);
      metadataWords[leaf*64]=0x7fff;metadataWords[leaf*64+3]=0x7fff;
      const field=(index,value)=>metadataFloats.set(value,leaf*64+4+index*4);
      field(0,[...input.base,0]);field(2,[input.metallic,0,0,0]);field(3,[input.roughness,0,0,0]);field(4,[.5,0,0,0]);
      field(5,[0,0,0,0]);field(6,[...(input.mapped??[0,0,1]),0]);field(7,[input.ior,0,0,0]);field(8,[1,0,0,0]);field(9,[input.specColor,input.specColor,input.specColor,0]);
      field(10,[input.coat,0,0,0]);field(11,[.5,0,0,0]);field(12,[...(input.coatMapped??[0,0,1]),0]);field(13,[input.normalValidity??(input.mapped?1:0),0,0,0]);field(14,[input.coatValidity??1,0,0,0]);
      aoBytes[leaf]=input.ao;
      if(input.mask) {
        demandWords[layout.offsets.lighting_queue/4+targets++]=leaf;
        demandWords[layout.offsets.lighting_masks/4+leaf]=input.mask;
      }
      if(input.hit) {
        words[wsLayout.signalStoreMasks/4+leaf]=1;
        words.set([0,1],wsLayout.signalReferences/4+leaf*6*2);
        new Float32Array(signalTable.buffer).set(input.hit,72);signalTable[75]=1|4|8|512;
      }
    });
    const coverage=(1<<cases.length)-1;
    words[127]=1;words.set([0,0,coverage,0,0],128);
    for(let plane=0;plane<21;plane++) {
      const planeCoverage=plane<15?coverage:cases.reduce((mask,input,leaf)=>
        mask|(((input.mask&(1<<(plane-15)))!==0||(plane===15&&input.hit))?1<<leaf:0),0);
      words.set([planeCoverage?2:0,0,0,64,planeCoverage,0],128+16+plane*6);
    }
    demandWords[6]=targets;
    const indirectWords=new Uint32Array(512/4+32/4);indirectWords.set([1,1,1,targets],32); // lighting args byte 128
    const lightWords=new Uint32Array(32768).fill(0xffffffff),page=8000;
    lightWords[D.page_lookup_address]=page;lightWords.fill(0,page,page+D.page_header_words);lightWords[page+1]=1;
    const record=page+D.page_header_words,lightFloats=new Float32Array(lightWords.buffer);
    for(const field of DT.fields) {
      const at=record+field.offset/4;
      if(field.name==='direction')lightFloats.set([0,0,-1],at);
      else if(field.name==='color')lightFloats.set([4,2,1],at);
      else lightWords[at]=0;
    }
    const cameraData=new Float32Array(164);for(let block=0;block<8;block++)cameraData.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],block*16);
    const graph=new FrameGraph('Phase 5 actual Lighting packet and compose');
    const imported=(name,value)=>graph.import_resource(name,{kind:'imported'},value),bind=(_name,resolve)=>resolve();
    const workspace=buffer(words),geometry=buffer(geometryWords),metadata=buffer(metadataWords),arena=buffer(demandWords);
    const camera=buffer(cameraData,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),lights=buffer(lightWords),fields=buffer(new Uint32Array(64*15*4));
    const fieldStore=buffer(new Uint32Array(4*64)),signalStore=buffer(signalTable),indirect=buffer(indirectWords,GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST);
    const ids={workspace:imported('workspace',workspace),arena:imported('demand',arena),geometry:imported('geometry',geometry),metadata:imported('metadata',metadata),
      fieldStore:imported('field store',fieldStore),signalStore:imported('signal store',signalStore),fields:imported('fields',fields),indirect:imported('indirect',indirect),lights:imported('lights',lights)};
    const clusters={parameters:imported('cluster parameters',buffer(new Float32Array([0,1,1,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)),
      lookup:imported('cluster lookup',buffer(new Uint32Array(24*4))),data:imported('cluster data',buffer(new Uint32Array(9))),activeLightList:imported('active lights',buffer(new Uint32Array(5)))};
    let encoder=device.createCommandEncoder();const transients=[],done=Promise.resolve();
    const command={device,closed:false,gpu_encoder:encoder,gpuDone:done,
      allocateTransientBuffer(usage,size){const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});transients.push(b);return b;},
      beginComputePass(options){return encoder.beginComputePass(options);},
      writeBuffer(target,offset,data,start,size){const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_SRC,mappedAtCreation:true});new Uint8Array(b.getMappedRange()).set(new Uint8Array(data,start,size));b.unmap();transients.push(b);encoder.copyBufferToBuffer(b,0,target,offset,size);}};
    scratch=new SurfaceFrameResources(device);scratch.prepare(width,height);
    lighting=new SurfaceLightingPass(device,scratch);reconstruction=new SurfaceReconstructionPass(device,scratch);reconstruction.prepareFrame(width,height,1);
    const demand={workspace:ids.workspace,arena:ids.arena,indirect:ids.indirect,activeIndirect:ids.indirect,fieldStore:ids.fieldStore,signalStore:ids.signalStore,layout};
    const output=lighting.addToGraph(graph,{resourceBinding:bind,demand,geometry:ids.geometry,fields:ids.fields,appearanceMetadata:ids.metadata,constantFieldsOffset:0,
      width,height,frame:1,camera:imported('camera',camera),physicalSun:null,lightRecords:ids.lights,clusters,shadow:null,scalarAo:null,
      environment:{diffuse:imported('diffuse environment',texture()),specular:imported('specular environment',texture()),dfg:imported('DFG',texture('rgba16float',[.7,.2,0,0]))},diagnosticsEnabled:true});
    const active=buffer(new Uint32Array([1,1,1,1]),GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST);
    const facts=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});retained.push(facts);
    const composed=reconstruction.addToGraph(graph,{signalValues:output.values,signalStore:ids.signalStore,fieldStore:ids.fieldStore,fields:ids.fields,
      reactive:imported('temporal facts',facts.createView()),preExposure:imported('pre exposure',buffer(new Float32Array([1.7]))),cellWorkspace:ids.workspace,
      coverage:imported('coverage',buffer(new Uint32Array([1,1,1,0,0,coverage,0,0,0,0,0,0]))),activeIndirect:imported('active indirect',active),
      cellBatchTiles:1,firstTile:0,appearanceMetadata:ids.metadata,constantFieldsOffset:0,scalarAo:imported('AO',buffer(new Uint32Array(aoBytes.buffer))),
      width,height,recordCount:64,diagnosticsEnabled:true});
    const packets=device.createBuffer({size:64*6*16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(packets);
    const hdr=device.createBuffer({size:height*256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(hdr);
    const demandReadback=device.createBuffer({size:layout.bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(demandReadback);
    const capture=graph.add('Read actual packets and HDR',{},(_data,resources)=>{
      encoder.copyBufferToBuffer(resources.get(output.values),0,packets,0,packets.size);
      encoder.copyBufferToBuffer(arena,0,demandReadback,0,layout.bytes);
      encoder.copyTextureToBuffer({texture:resources.get(composed.radiance).gpu_texture},{buffer:hdr,bytesPerRow:256},[width,height]);
    });capture.read(output.values);capture.read(output.demand.arena);capture.read(composed.radiance);capture.make_side_effect();
    allocator=new GPUBufferAllocator(device);textureAllocator=new GPUTextureAllocator(device);
    context=new FrameGraphContext({device,encoder:command,graphics:{device,buffer_allocator_main:allocator,allocator_textures:textureAllocator},resource_manager:new FrameGraphResourceManager(device,done)});
    compiled=graph.compile();
    stage('Compile actual dirty Lighting and cheap reconstruction');
    assert.deepEqual((await Promise.all(modules.map(async m=>(await m.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message)))).flat(),[]);
    compiled.execute(context);device.queue.submit([encoder.finish()]);
    await Promise.all([packets,hdr,demandReadback].map(b=>b.mapAsync(GPUMapMode.READ)));
    const values=new Float32Array(packets.getMappedRange()).slice(),packetBits=new Uint32Array(values.buffer),hdrValues=new Uint16Array(hdr.getMappedRange()).slice();packets.unmap();hdr.unmap();
    const executed=new Uint32Array(demandReadback.getMappedRange()).slice();demandReadback.unmap();
    const full=input=>(input.mask&20)!==0||((input.mask&1)!==0&&input.semantic!==3);
    const expectedFull=cases.filter(full).length;
    const expectedShared=cases.filter(input=>full(input)&&(input.mask&1)!==0&&input.semantic===3).length;
    const expectedTransport=cases.filter(input=>!full(input)&&(input.mask&1)!==0&&input.semantic===3).length;
    assert.deepEqual([...executed.slice(96,99)],[expectedFull,expectedShared,expectedTransport],
      'One guarded per-light evaluation per dirty direct target; full work reuses its transport math');
    assert.ok(expectedShared>0&&expectedTransport>0,'Both fused and transport-only branches executed');
    report.directWork={full:executed[96],sharedTransport:executed[97],transportOnly:executed[98]};
    const expectedEnvironment=[2,8,32].map(mask=>cases.filter(input=>(input.mask&mask)!==0).length);
    assert.deepEqual([executed[67],executed[70],executed[68]],expectedEnvironment,
      'Actual diffuse/specular/coat environment branches each count one evaluation');
    assert.ok(expectedEnvironment.every(count=>count>0),'All three environment producer branches execute');
    report.environmentWork={diffuse:executed[67],specular:executed[70],coat:executed[68]};
    const executionError=await device.popErrorScope();
    assert.equal(executionError,null,executionError?.message);
    device.pushErrorScope('validation');
    const close=(actual,expected,tolerance,message)=>assert.ok(actual.every((v,c)=>Math.abs(v-expected[c])<=tolerance*Math.max(1,Math.abs(expected[c]))),`${message}: ${actual} vs ${expected}`);
    const packet=(leaf,kind)=>[...values.slice((leaf*6+kind)*4,(leaf*6+kind)*4+3)];
    cases.forEach((input,leaf)=>{
      const invalid=['zero-normal','antiparallel-half'].includes(input.name);
      const oracle=invalid?null:numericOracle(input);
      let expected=[0,0,0];
      if(input.name==='exceptional-combined-guard') {
        close(packet(leaf,0),[0,0,0],0,input.name);
        assert.ok(packetBits[(leaf*6)*4+3]&512);
      } else if(invalid) {
        // Invalid normalization has implementation-defined results. The exact
        // production combined guard is compared in the additional GPU oracle below.
      } else if(input.hit) { expected=input.hit; }
      else {
        if(input.mask&1) {
          close(packet(leaf,0),input.semantic===3?oracle.transport:oracle.diffuse,2e-5,input.name);
          assert.ok(packetBits[(leaf*6)*4+3]&(input.semantic===3?256:512));expected=rgbAdd(expected,oracle.diffuse);
        }
        if(input.mask&2)expected=rgbAdd(expected,oracle.factor.map((f,c)=>f*.5*(input.ao/255)*[.8,.6,.4][c]/Math.PI));
        if(input.mask&4){close(packet(leaf,2),oracle.specular,2e-5,input.name);expected=rgbAdd(expected,oracle.specular);}
        if(input.mask&16){close(packet(leaf,4),oracle.coat,2e-5,input.name);expected=rgbAdd(expected,oracle.coat);}
        if(input.mask&8)expected=rgbAdd(expected,oracle.f0.map((f,c)=>(f*.7+.2)*[.8,.6,.4][c]));
        if(input.mask&32)expected=rgbAdd(expected,[.8,.6,.4].map(v=>v*input.coat*.04));
      }
      const rgb=Array.from({length:3},(_,c)=>half(hdrValues[Math.floor(leaf/8)*128+(leaf%8)*4+c]));
      if(!invalid)close(rgb,transform(expected).map(v=>v*1.7),.002,input.name+' HDR / color / pre-exposure');
      report.cases.push({name:input.name,packet:packet(leaf,0),hdr:rgb});
    });
    close(packet(0,0),packet(1,0),0,'Direct AO independence');
    // Compare abnormal normalization with the untouched original per-light guard.
    const oracleCode=surfaceLightingWgsl(64,1)+`
      @group(0) @binding(19) var<storage,read_write> old_guard:array<vec4f>;
      @compute @workgroup_size(64) fn original_guard(@builtin(global_invocation_id) id:vec3u) {
        if id.x>=${cases.length}u{return;}
        let record=id.x;let hot=geometry_product_hot(record);
        var normal=hot.normal.xyz;
        if surface_field(record,13u).x>0.5 {
          let ts=normalize(surface_field(record,6u).xyz);
          let bitangent=normalize(cross(normal,hot.tangent.xyz)*hot.metrics.y);
          normal=normalize(hot.tangent.xyz*ts.x+bitangent*ts.y+normal*ts.z);
        }
        var material=surface_material(record,21u,false);
        let ts=material.coatNormal;let bitangent=normalize(cross(hot.normal.xyz,hot.tangent.xyz)*hot.metrics.y);
        material.coatNormal=normalize(hot.tangent.xyz*ts.x+bitangent*ts.y+hot.normal.xyz*ts.z);
        var result=ReflectedLight(vec3f(0.0),vec3f(0.0),vec3f(0.0),vec3f(0.0));
        re_direct_physical(get_directional_light_info_by_index(&node,0u),
          SurfaceGeometry(normal,hot.geometric.xyz,hot.position.xyz,hot.view.xyz),material,&result);
        old_guard[record]=vec4f(result.diffuse,0.0);
      }`;
    const oracleModule=device.createShaderModule({code:oracleCode});
    assert.deepEqual((await oracleModule.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const oraclePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:oracleModule,entryPoint:'original_guard'}});
    const old=buffer(new Float32Array(64*4)),oracleSettings=buffer(new Uint32Array([8,8,0,0,0,0,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(oraclePipeline);
    pass.setBindGroup(0,device.createBindGroup({layout:oraclePipeline.getBindGroupLayout(0),entries:[[0,oracleSettings],[1,geometry],[2,fields],[3,fieldStore],[5,workspace],[6,metadata],[19,old]].map(([binding,b])=>({binding,resource:{buffer:b}}))}));
    pass.setBindGroup(1,device.createBindGroup({layout:oraclePipeline.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:lights}}]}));
    pass.dispatchWorkgroups(1);pass.end();
    const oldRead=device.createBuffer({size:old.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(oldRead);
    encoder.copyBufferToBuffer(old,0,oldRead,0,old.size);device.queue.submit([encoder.finish()]);await oldRead.mapAsync(GPUMapMode.READ);
    const original=new Float32Array(oldRead.getMappedRange()).slice();oldRead.unmap();
    for(const name of ['zero-normal','antiparallel-half']) {
      const leaf=cases.findIndex(input=>input.name===name);
      assert.ok(leaf>=0);
      close(rgbMul(packet(leaf,0),cases[leaf].base.map(v=>v*(1-cases[leaf].metallic))),[...original.slice(leaf*4,leaf*4+3)],2e-5,name+' original guard');
    }
    stage('Actual current-provider finite proof: ordinary, unsafe light and solar LUT');
    const radiometryModule=device.createShaderModule({code:SURFACE_RADIOMETRY_WGSL});
    assert.deepEqual((await radiometryModule.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    const radiometryPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:radiometryModule,entryPoint:'prove_radiometry'}});
    const numeric=buffer(new Uint32Array(4));
    const numericRead=device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});retained.push(numericRead);
    const solarData=new Float32Array([0,0,1,.001,1,2,3,1,1,0,0,0]);
    const solarBuffer=buffer(solarData,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const proofSettings=buffer(new Uint32Array(4),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const transmission=device.createTexture({size:[1,1],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});retained.push(transmission);
    const proofCluster=buffer(new Uint32Array(9));
    const proofGroup=device.createBindGroup({layout:radiometryPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:proofSettings}},{binding:1,resource:{buffer:lights}},{binding:2,resource:{buffer:proofCluster}},
      {binding:3,resource:{buffer:solarBuffer}},{binding:4,resource:transmission.createView()},{binding:5,resource:{buffer:numeric}}]});
    report.providerCases=[];
    const lightColor=record+DT.fields.find(field=>field.name==='color').offset/4;
    for(const [name,lightColorValue,solarEnabled,texel,expected] of [
      ['ordinary-current-light',4,0,1,1],['unsafe-light',2e9,0,1,0],
      ['physical-solar',4,1,.75,1],['unsafe-solar-LUT',4,1,NaN,0]]) {
      lightFloats[lightColor]=lightColorValue;device.queue.writeBuffer(lights,0,lightWords);
      device.queue.writeBuffer(proofSettings,0,new Uint32Array([0,solarEnabled,0,0]));
      device.queue.writeTexture({texture:transmission},new Float32Array([texel,1,1,1]),{bytesPerRow:16},[1,1]);
      encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(radiometryPipeline);pass.setBindGroup(0,proofGroup);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(numeric,0,numericRead,0,16);device.queue.submit([encoder.finish()]);await numericRead.mapAsync(GPUMapMode.READ);
      const accepted=new Uint32Array(numericRead.getMappedRange())[0];numericRead.unmap();assert.equal(accepted,expected,name);
      report.providerCases.push({name,accepted});
    }
    assert.equal(await device.popErrorScope(),null);assert.deepEqual(apiErrors,[]);report.passed=true;
    for(const b of transients)b.destroy();
  } catch(error) {report.failure=error.stack??String(error);} finally {
    compiled?.destroy();context?.resource_manager.destroy();allocator?.destroy();textureAllocator?.destroy();lighting?.destroy();reconstruction?.destroy();scratch?.destroy();
    for(const resource of retained)resource.destroy();device.destroy();
  }
  return report;
}
