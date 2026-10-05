import {surfaceGeometryRecordWgsl} from '../../../OEngine/.test-dist/render/surface/SurfaceGeometryPass.js';
import {surfaceCellWorkspaceLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {surfaceDemandLayout} from '../../../OEngine/.test-dist/gpu/GpuSurfaceDemandAbi.js';
import {SURFACE_GEOMETRY_RECORD_BYTES,SURFACE_GEOMETRY_RECORD_WGSL,surfaceGeometryReadWgsl} from '../../../OEngine/.test-dist/gpu/GpuSurfaceGeometryRecordAbi.js';
import {SURFACE_CELL_GEOMETRY_SETUP_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';
import {SURFACE_CELL_ADDRESS_WORDS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceReferenceAbi.js';
export async function runRecordOracle(gpu,assert,onStage=()=>{}) {
 const adapter=await gpu.requestAdapter({powerPreference:'high-performance'}),device=await adapter.requestDevice();
 const kept=[],errors=[],report={passed:false,evidenceRole:'diagnostic',apiErrors:errors};device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const floats=values=>new Uint32Array(new Float32Array(values).buffer);
 const make=(words,usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)=>{const b=device.createBuffer({size:words.byteLength,usage});device.queue.writeBuffer(b,0,words);kept.push(b);return b;};
 const normal=(v,fallback=[0,0,1])=>{const length=Math.hypot(...v);return length>1e-10?v.map(x=>x/length):fallback;};
 try {
 device.pushErrorScope('validation');
 const layout=surfaceCellWorkspaceLayout(1),demandLayout=surfaceDemandLayout(64,1);
 const workspace=new Uint32Array(layout.bytes/4),demands=new Uint32Array(demandLayout.bytes/4),leaves=[0,17,63],allMask=32766;
 const setupWords=new Uint32Array(64*2+leaves.length*SURFACE_CELL_GEOMETRY_SETUP_BYTES/4),setupFloats=new Float32Array(setupWords.buffer);
 const expected=[];
 demands[0]=leaves.length;
 for(const [index,leaf] of leaves.entries()) {
  const at=layout.addresses/4+leaf*SURFACE_CELL_ADDRESS_WORDS;
  workspace.set([leaf+101,7,0,3,2,0,0,9,1,4,5,6,11,leaf,0,7],at);
  workspace[at+17]=16;workspace[at+20]=2;
  const positions=[],normals=[],tangents=[];
  for(let point=0;point<3;point++){
    const position=[.3+index*.2+point*.1,-.2+point*.05,point===1?5.5:.5+point*.02,1];
    const n=[.2+point*.3,.4,.9,.73],t=[1,.1+point*.2,.3,-.8];
    positions.push(position);normals.push(n);tangents.push(t);
  }
  const color=[.2,.3,.4,.8],colorX=[.01,-.02,.03,0],colorY=[-.02,.01,0,.02];
  workspace.set([1,index,2,0],layout.facts/4+leaf*4);
  const setup=64*2+index*SURFACE_CELL_GEOMETRY_SETUP_BYTES/4;
  setupFloats.set([-.5,-.5,0,1,.5,0,.5,0,0,.5,.5,0],setup+24);
  setupWords[setup+116+3]=16;
  setupFloats.set([0,0,1,-.5],setup+108);
  const pixel=[leaf%8+.5,Math.floor(leaf/8)+.5];
  const attributes=[normals,tangents,
    Array.from({length:3},(_,point)=>[.1+(point===1?.03:point===2?-.01:0),.2+(point===1?-.02:point===2?.04:0),
      .3+(point===1?.03:point===2?-.01:0),.3+(point===1?-.02:point===2?.04:0)]),
    Array.from({length:3},(_,point)=>color.map((value,channel)=>value+(point===1?colorX[channel]:point===2?colorY[channel]:0))),
    Array.from({length:3},(_,point)=>[.5+(point===1?.03:point===2?-.01:0),.4+(point===1?-.02:point===2?.04:0),0,0]),positions];
  for(let attribute=0;attribute<6;attribute++)for(let channel=0;channel<4;channel++) {
    const center=attributes[attribute][0][channel],dx=attributes[attribute][1][channel]-center,dy=attributes[attribute][2][channel]-center;
    const base=center-dx*pixel[0]+dy*(8-pixel[1]);
    for(let corner=0;corner<3;corner++)setupFloats[setup+36+(corner*6+attribute)*4+channel]=base+(corner===1?dx*8:corner===2?-dy*8:0);
  }
  demands[demandLayout.offsets.geometry_queue/4+index]=leaf;
  demands[demandLayout.offsets.geometry_masks/4+leaf]=allMask;
  const row=[];
  for(let kind=1;kind<=14;kind++)for(let point=0;point<3;point++) {
    let n=normal(normals[point].slice(0,3)),t=normal(tangents[point].slice(0,3).map((x,c)=>x-n[c]*n.reduce((sum,y,k)=>sum+y*tangents[point][k],0)));
    if(point===1){n=n.map(x=>-x);t=t.map(x=>-x);}
    let value;
    if(kind<=3){const uv=kind-1;value=[.1+uv*.2+(point===1?.03:point===2?-.01:0),.2+uv*.1+(point===1?-.02:point===2?.04:0),0,0];}
    else if(kind===4)value=color.map((x,c)=>x+(point===1?colorX[c]:point===2?colorY[c]:0));
    else if([5,11,14].includes(kind))value=[...n,.73];
    else if([6,12].includes(kind))value=[...t,-.8];
    else if([7,10,13].includes(kind))value=positions[point];
    else if(kind===8)value=[...normal([1,2,3].map((x,c)=>x-positions[point][c])),0];
    else if(kind===9)value=[1,2,3,1];
    row.push(...value);
  }
  expected.push(row);
 }
 const camera=new Float32Array(164),identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];for(let i=0;i<8;i++)camera.set(identity,i*16);camera.set([1,2,3],12);
 const w=make(workspace),d=make(demands),c=make(camera,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),records=make(new Uint32Array(64*SURFACE_GEOMETRY_RECORD_BYTES/4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
 const setups=make(setupWords),viewport=make(new Uint32Array([8,8,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const result=make(new Uint32Array(leaves.length*14*3*4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
 const module=device.createShaderModule({code:surfaceGeometryRecordWgsl(64,1)});
 const reader=device.createShaderModule({code:`${SURFACE_GEOMETRY_RECORD_WGSL}
@group(0) @binding(0) var<storage,read> g:array<u32>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
${surfaceGeometryReadWgsl('g')}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if id.x>=126u{return;}let leaf=array<u32,3>(0u,17u,63u)[id.x/42u];let kind=(id.x%42u)/3u+1u;result[id.x]=geometry_product_input(leaf,kind,id.x%3u);}`});
 for(const m of [module,reader])assert.deepEqual((await m.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message),[]);
 onStage('Geometry hot/cold producer -> actual C/X/Y reader');
 const producer=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'produce_geometry'}}),consumer=await device.createComputePipelineAsync({layout:'auto',compute:{module:reader,entryPoint:'main'}});
 const producerGroup=device.createBindGroup({layout:producer.getBindGroupLayout(0),entries:[w,d,c,records,setups,viewport].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const consumerGroup=device.createBindGroup({layout:consumer.getBindGroupLayout(0),entries:[records,result].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const staging=device.createBuffer({size:result.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});kept.push(staging);
 const encoder=device.createCommandEncoder();for(const [pipeline,group] of [[producer,producerGroup],[consumer,consumerGroup]]){const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(2);pass.end();}encoder.copyBufferToBuffer(result,0,staging,0,result.size);device.queue.submit([encoder.finish()]);
 const error=await device.popErrorScope();assert.equal(error,null,error?.message);assert.deepEqual(errors,[]);
 await staging.mapAsync(GPUMapMode.READ);const actual=new Float32Array(staging.getMappedRange()).slice();staging.unmap();
 let maximumError=0;for(const [i,value] of expected.flat().entries()){const delta=Math.abs(actual[i]-value);maximumError=Math.max(maximumError,delta);assert.ok(delta<2e-6,`Semantic C/X/Y word ${i}: ${actual[i]} vs ${value}`);}
 report.maximumError=maximumError;report.semanticInputs=14;report.points=3;report.records=leaves.length;report.passed=true;
 }catch(error){report.failure=error.stack??String(error);}finally{for(const b of kept)b.destroy();device.destroy();}
 return report;
}
