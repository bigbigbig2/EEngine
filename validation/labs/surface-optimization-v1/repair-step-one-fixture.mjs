import {surfaceReconstructWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceReconstructionPass.js';
import {surfaceCellWorkspaceLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
function half(value) {
  const sign=value&0x8000?-1:1,exponent=(value>>10)&31,mantissa=value&1023;
  return sign*(exponent===0?mantissa*2**-24:exponent===31?Infinity:(1+mantissa/1024)*2**(exponent-15));
}
function working(rgb) {
  return [rgb[0]*.6274040+rgb[1]*.3292820+rgb[2]*.0433136,
    rgb[0]*.0690970+rgb[1]*.9195400+rgb[2]*.0113612,
    rgb[0]*.0163916+rgb[1]*.0880132+rgb[2]*.8955950];
}
export async function runRepairStepOne(gpu,assert,stage=()=>{}) {
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  assert.ok(adapter&&!adapter.info.isFallbackAdapter,'A hardware adapter is required');
  const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
  const retained=[],errors=[];
  device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
  const report={evidenceRole:'diagnostic',accepted:false,passed:false,adapter:adapter.info,errors};
  const buffer=(size,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC)=>{
    const result=device.createBuffer({size,usage});retained.push(result);return result;
  };
  const texture=(format,usage)=>{const result=device.createTexture({size:[8,8],format,usage});retained.push(result);return result;};
  async function pipeline(source,entryPoint) {
    const module=device.createShaderModule({code:source,label:entryPoint});
    const info=await module.getCompilationInfo();
    assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[]);
    return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
  }
  async function read(source) {
    const target=buffer(source.size,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,target,0,source.size);
    device.queue.submit([encoder.finish()]);await target.mapAsync(GPUMapMode.READ);
    const result=new Uint32Array(target.getMappedRange()).slice();target.unmap();return result;
  }
  try {
    device.pushErrorScope('validation');
    let encoder,pass;
    stage('Production reconstruction: E-only, irradiance/AO, direct residual');
    const reconstruct=await pipeline(surfaceReconstructWgsl(1),'reconstruct');
    const workspaceLayout=surfaceCellWorkspaceLayout(1),workspace=buffer(workspaceLayout.bytes);
    const material=buffer(64*15*16),metadata=buffer(256),signals=buffer(64*6*16),fieldStore=buffer(4),signalStore=buffer(4);
    const exposure=buffer(4);device.queue.writeBuffer(exposure,0,new Float32Array([1]));
    const ao=buffer(64),diagnostics=buffer(32),reconstructSettings=buffer(48,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const facts=texture('rgba8unorm',GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST);
    const output=texture('rgba16float',GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC);
    const reactive=texture('rgba8unorm',GPUTextureUsage.STORAGE_BINDING);
    const group=device.createBindGroup({layout:reconstruct.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:reconstructSettings}},{binding:1,resource:{buffer:signals}},
      {binding:2,resource:{buffer:signalStore}},{binding:3,resource:{buffer:fieldStore}},{binding:4,resource:facts.createView()},
      {binding:6,resource:{buffer:exposure}},
      {binding:7,resource:output.createView()},{binding:8,resource:reactive.createView()},
      {binding:9,resource:{buffer:diagnostics}},{binding:10,resource:{buffer:workspace}},
      {binding:11,resource:{buffer:material}},{binding:12,resource:{buffer:metadata}},{binding:13,resource:{buffer:ao}}
    ]});
    const cases=[{name:'E-only',emissive:[1,2,3],signal:0},{name:'checker diffuse and fine AO',emissive:[0,0,0],signal:1},
      {name:'colored direct residual plus E',emissive:[1,2,3],signal:2},{name:'partial E-only',emissive:[1,2,3],signal:0,partial:true},
      {name:'empty',emissive:[1,2,3],signal:0,empty:true},{name:'unlit publication color',emissive:[0,0,0],signal:0,unlit:true}];
    report.compose=[];
    for(const scenario of cases){
      const plan=new Uint32Array(workspaceLayout.bytes/4),palette=new Uint32Array(64),values=new Float32Array(palette.buffer);
      palette[0]=0x7fff;
      for(const [field,value] of [[0,[.5,.5,.5]],[2,[0]],[4,[1]],[5,scenario.emissive]])values.set(value,4+field*4);
      for(let lane=0;lane<64;lane++){
        const covered=!scenario.empty&&(!scenario.partial||lane%8<5);
        plan.set(covered?[lane+1,0,0,0]:[0xffffffff,0xffffffff,0xffffffff,0xffffffff],workspaceLayout.facts/4+lane*4);
      }
      if(scenario.emissive.some(value=>value!==0))plan.set([1,0,0,0,scenario.empty?0:scenario.partial?0x1f1f1f1f:0xffffffff,scenario.empty?0:scenario.partial?0x1f1f1f1f:0xffffffff],workspaceLayout.plans/4+16+5*6);
      if(scenario.unlit)plan.set([1,0,0,0,0xffffffff,0xffffffff],workspaceLayout.plans/4+16);
      // Checker color is a publication-independent fine field. Constant
      // irradiance stays one source, proving the entry point resolves both.
      if(scenario.signal===1){palette[0]&=~1;plan.set([2,0,0,64,0xffffffff,0xffffffff],workspaceLayout.plans/4+16);
        const actual=new Float32Array(64*15*4);
        for(let lane=0;lane<64;lane++)actual.set(lane%2?[1,1,1,0]:[0,0,0,0],lane*4);
        device.queue.writeBuffer(material,0,actual);

      }
      const fullValues=new Float32Array(64*6*4);
      if(scenario.signal){const kind=scenario.signal===1?1:0;plan.set([3|(15<<8),0,kind*24,1,0xffffffff,0xffffffff],workspaceLayout.plans/4+16+(15+kind)*6);
        plan.set([4,kind,1],workspaceLayout.signalReferences/4+kind*3);fullValues.set(kind===1?[Math.PI,Math.PI,Math.PI,1]:[2,3,4,1],kind*4);}
      for(let lane=0;lane<64;lane++)for(let field=0;field<15;field++) {
        plan.set([scenario.signal===1&&field===0?4:1,scenario.signal===1&&field===0?lane:0,1],workspaceLayout.fieldReferences/4+(lane*15+field)*3);
      }
      device.queue.writeBuffer(workspace,0,plan);device.queue.writeBuffer(metadata,0,palette);device.queue.writeBuffer(signals,0,fullValues);
      const aoBytes=Uint8Array.from({length:64},(_,lane)=>lane%4<2?255:0);device.queue.writeBuffer(ao,0,aoBytes);
      device.queue.writeBuffer(reconstructSettings,0,new Uint32Array([8,8,64,0,1,1,1,0,0,0,1,0]));
      const readback=buffer(256*8,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
      encoder=device.createCommandEncoder();pass=encoder.beginComputePass();pass.setPipeline(reconstruct);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyTextureToBuffer({texture:output},{buffer:readback,bytesPerRow:256},{width:8,height:8});device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const pixels=new Uint16Array(readback.getMappedRange()).slice();readback.unmap();
      for(let lane=0;lane<64;lane++){
        const covered=!scenario.empty&&(!scenario.partial||lane%8<5),offset=Math.floor(lane/8)*128+(lane%8)*4;
        let color=scenario.emissive;
        if(scenario.signal===1)color=[0,0,0].map(()=>lane%2&&aoBytes[lane]?1:0);
        if(scenario.signal===2)color=[3,5,7];
        if(scenario.unlit)color=[.5,.5,.5];
        const expected=working(covered?color:[0,0,0]);
        for(let c=0;c<3;c++)assert.ok(Math.abs(half(pixels[offset+c])-expected[c])<.006,`${scenario.name} lane ${lane}: ${half(pixels[offset+c])} vs ${expected[c]}`);
        assert.equal(half(pixels[offset+3]),covered?1:0);
      }
      report.compose.push({name:scenario.name,checkedPixels:64,passed:true});
    }
    assert.equal(await device.popErrorScope(),null);assert.deepEqual(errors,[]);report.passed=true;
  } catch(error){report.failure=error.stack??String(error);}
  finally{for(const value of retained)value.destroy();device.destroy();}
  return report;
}
