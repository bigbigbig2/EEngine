import {WINNER_INTERPOLATION_WGSL} from '../../../OEngine/.test-dist/shaders/winner_interpolation.js';
import {APPEARANCE_FIELD_BOUND_WGSL} from '../../../OEngine/.test-dist/shaders/appearance_field_bounds.js';
import {SURFACE_CELL_ADDRESS_MATH_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_address_math.js';
import {SURFACE_CELL_CANONICAL_SUPPORT_WGSL} from '../../../OEngine/.test-dist/shaders/surface_cell_certificates.js';
import {surfaceCellWorkspaceLayout,surfaceCellWorkspaceWgsl} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellPlanAbi.js';
import {SURFACE_CELL_GEOMETRY_WGSL,surfaceCellGeometryArenaWgsl,SURFACE_CELL_GEOMETRY_SETUP_BYTES} from '../../../OEngine/.test-dist/gpu/GpuSurfaceCellGeometryAbi.js';
import {SURFACE_CELL_ADDRESS_WORDS} from '../../../OEngine/.test-dist/gpu/GpuSurfaceReferenceAbi.js';

export async function checkCanonicalSupport(device,assert) {
  const resources=[];
  const buffer=size=>{
    const value=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
    resources.push(value);return value;
  };
  const affine=[[-.5,-.5,0,1],[.5,0,.5,0],[0,.5,.5,0]];
  const cases=[];
  for(let uv=0;uv<3;uv++) {
    cases.push({name:`UV${uv} legal complete support`,uv,coefficients:affine,u:[0,1,0],v:[0,0,1],expected:1});
    cases.push({name:`UV${uv} center inside but quad crosses cell`,uv,coefficients:affine,u:[0,1.4,0],v:[-.97,-.97,.03],expected:0,oldExpected:1});
  }
  cases.push({name:'negative canonical cell legal support',uv:0,coefficients:affine,u:[-.03,.97,-.03],v:[0,0,1],expected:1});
  // U=.01/(3.1-x) stays in cell zero. Its finite-pixel derivative grows
  // from .002404 to .010417, exceeding the anchor class envelope .00390625.
  cases.push({name:'value inside but gradient escapes envelope',uv:0,
    coefficients:[[0,0,.01,1],[-32,-1,-29.91,0],[0,1,1,0]],u:[1,0,0],v:[.015625,.015625,.015625],expected:0,oldExpected:1});
  cases.push({name:'homogeneous denominator crosses zero',uv:0,
    coefficients:[[0,0,.01,1],[-32,-1,-31.01,0],[0,1,0,0]],u:[1,0,0],v:[.015625,.015625,.015625],expected:0});
  cases.push({name:'unknown interpolation is rejected',uv:0,coefficients:affine,u:[0,1,0],v:[0,0,1],expected:0,flags:0});
  const recover=(rows,values,x,y)=>{
    const ndc=[x/32-1,1-y/32,1];
    const q=rows.map(row=>row.slice(0,3).reduce((sum,value,i)=>sum+value*ndc[i],0));
    return q.reduce((sum,value,i)=>sum+value*values[i],0)/q.reduce((sum,value)=>sum+value,0);
  };
  try {
    const layout=surfaceCellWorkspaceLayout(1),words=new Uint32Array(layout.bytes/4),floats=new Float32Array(words.buffer);
    const originalWords=new Uint32Array(cases.length*144),originalFloats=new Float32Array(originalWords.buffer);
    const setupWords=new Uint32Array(64*2+cases.length*SURFACE_CELL_GEOMETRY_SETUP_BYTES/4),setupFloats=new Float32Array(setupWords.buffer);
    for(let leaf=0;leaf<cases.length;leaf++) {
      const scenario=cases[leaf],setup=64*2+leaf*SURFACE_CELL_GEOMETRY_SETUP_BYTES/4;
      words.set([1,leaf,0,0],layout.facts/4+leaf*4);
      scenario.coefficients.forEach((row,index)=>setupFloats.set(row,setup+24+index*4));
      const attributeIndex=scenario.uv===2?4:2,channel=scenario.uv===1?2:0;
      for(let corner=0;corner<3;corner++) {
        setupFloats.set([scenario.u[corner],scenario.v[corner]],setup+36+(corner*6+attributeIndex)*4+channel);
      }
      const at=layout.addresses/4+leaf*SURFACE_CELL_ADDRESS_WORDS;
      words[at+15]=1<<scenario.uv;words[at+16]=scenario.flags??7;
      const witness=layout.uvWitnesses/4+leaf*18;
      for(let axis=0;axis<2;axis++) {
        const values=axis?scenario.v:scenario.u;
        const center=recover(scenario.coefficients,values,.5,.5);
        floats[witness+scenario.uv*6+axis]=center;
        floats[witness+2+scenario.uv*6+axis]=recover(scenario.coefficients,values,1.5,.5)-center;
        floats[witness+4+scenario.uv*6+axis]=recover(scenario.coefficients,values,.5,1.5)-center;
        originalFloats[leaf*144+16+scenario.uv*6+axis]=center;
      }
      // The old reader sees zero-filled, unproduced bounds in cell zero and
      // accepts both domain and gradient failures. These cases detect that bug.
      if(scenario.name.includes('crosses cell')||scenario.name.includes('gradient escapes')) {
        const center=floats[witness+scenario.uv*6];assert.ok(center>0&&center<1/32);
      }
      if(scenario.name.includes('gradient escapes')) {
        const center=recover(scenario.coefficients,scenario.u,.5,.5);
        const anchorDx=recover(scenario.coefficients,scenario.u,1.5,.5)-center;
        const envelope=2**(Math.floor(Math.log2(Math.abs(anchorDx)))+1);
        const farDx=recover(scenario.coefficients,scenario.u,2.5,.5)-recover(scenario.coefficients,scenario.u,1.5,.5);
        assert.ok(recover(scenario.coefficients,scenario.u,1.5,.5)<1/32&&farDx>envelope);
      }
    }
    const workspace=buffer(words.byteLength),geometry=buffer(setupWords.byteLength),output=buffer(cases.length*8);
    const originalAddresses=buffer(originalWords.byteLength);device.queue.writeBuffer(originalAddresses,0,originalWords);
    device.queue.writeBuffer(workspace,0,words);device.queue.writeBuffer(geometry,0,setupWords);
    const code=`${WINNER_INTERPOLATION_WGSL}\n${APPEARANCE_FIELD_BOUND_WGSL}\n${SURFACE_CELL_ADDRESS_MATH_WGSL}
${SURFACE_CELL_GEOMETRY_WGSL}\n${surfaceCellGeometryArenaWgsl(64,false)}\n${surfaceCellWorkspaceWgsl(1)}
struct CanonicalSettings { width:u32, height:u32, }
const cell_settings=CanonicalSettings(64u,64u);
@group(0) @binding(0) var<storage,read_write> cell_workspace:SurfaceCellWorkspace;
@group(0) @binding(1) var<storage,read> geometry_arena:CellGeometryArenaRead;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@group(0) @binding(3) var<storage,read> original_addresses:array<u32>;
${SURFACE_CELL_CANONICAL_SUPPORT_WGSL}
// Isolated pre-repair reader, used only to check regression sensitivity.
fn original_zero_bound_reader(leaf:u32,uv:u32)->bool {
  let address=leaf*144u;
  for(var axis=0u;axis<2u;axis++) {
    let center=bitcast<f32>(original_addresses[address+16u+uv*6u+axis]);
    let domain_low=floor(center*32.0)/32.0;
    let low=bitcast<f32>(original_addresses[address+46u+uv*4u+axis]);
    let high=bitcast<f32>(original_addresses[address+48u+uv*4u+axis]);
    if !(low>=domain_low && high<=domain_low+1.0/32.0) { return false; }
  }
  return true;
}
@compute @workgroup_size(64) fn check_support(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=${cases.length}u { return; }
  let uv=firstTrailingBit(cell_workspace.addresses[id.x*${SURFACE_CELL_ADDRESS_WORDS}u+15u]);
  output[id.x*2u]=u32(cell_persistent_certificate_covers(id.x,uv,vec4f(.5,.5,1.5,1.5)));
  output[id.x*2u+1u]=u32(original_zero_bound_reader(id.x,uv));
}`;
    const module=device.createShaderModule({code});
    assert.deepEqual((await module.getCompilationInfo()).messages.filter(message=>message.type==='error').map(message=>message.message),[]);
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'check_support'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[workspace,geometry,output,originalAddresses].map((value,binding)=>({binding,resource:{buffer:value}}))});
    const staging=device.createBuffer({size:output.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});resources.push(staging);
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    encoder.copyBufferToBuffer(output,0,staging,0,output.size);device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);const observed=new Uint32Array(staging.getMappedRange()).slice();staging.unmap();
    cases.forEach((scenario,index)=>{
      assert.equal(observed[index*2],scenario.expected,scenario.name);
      if(scenario.oldExpected!==undefined)assert.equal(observed[index*2+1],scenario.oldExpected,`${scenario.name}: original bug sensitivity`);
    });
    return cases.map((scenario,index)=>({name:scenario.name,covered:observed[index*2]!==0,
      originalIncorrectlyAccepted:scenario.oldExpected===1&&observed[index*2+1]===1,passed:true}));
  } finally { for(const resource of resources)resource.destroy(); }
}
