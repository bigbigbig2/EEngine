import { NATIVE_TEMPORAL_FACTS_WGSL } from "./reference/s3/native_surface_aux.mjs";
import { Fsr3UpscalerRuntime } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerRuntime.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";

// Independent analytic motion for this fixture's z=.5 plane and translating,
// fixed-orientation perspective camera. No raster depth or recovered position.
// P_old/P_current * distance_current/distance_old maps centred current UV to
// previous UV; the remaining term is camera translation and projection jitter.
function analyticFactsSource() {
  const begin = NATIVE_TEMPORAL_FACTS_WGSL.indexOf("fn native_facts_previous_clip(");
  const end = NATIVE_TEMPORAL_FACTS_WGSL.indexOf("@compute @workgroup_size", begin);
  if (begin < 0 || end < 0) throw new Error("Frozen Facts analytic seam changed");
  const helpers = `
struct AnalyticMotion { plane: vec4f, sky: vec4f, };
@group(0) @binding(19) var<uniform> analytic: AnalyticMotion;
fn analytic_motion(uv: vec2f, sky: bool) -> vec2f {
  if (sky) { return -analytic.sky.xy; }
  return (uv - vec2f(0.5)) * (1.0 - analytic.plane.x) - analytic.plane.yz;
}
fn native_facts_previous_clip(uv: vec2f, depth: f32, instance: OEngineInstanceRecord) -> vec4f {
  let previous = uv - analytic_motion(uv, false);
  return vec4f(previous * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.5, 1.0);
}
fn native_facts_sky_previous_clip(uv: vec2f) -> vec4f {
  let previous = uv - analytic_motion(uv, true);
  return vec4f(previous * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.5, 1.0);
}
`;
  return (NATIVE_TEMPORAL_FACTS_WGSL.slice(0, begin) + helpers + NATIVE_TEMPORAL_FACTS_WGSL.slice(end))
    .replaceAll("motion = uv - previous_uv;", "motion = analytic_motion(uv, key == OENGINE_VISIBILITY_KEY_EMPTY);");
}

// Test-only c71c6d31 facts + unchanged T3 algorithm. Both graphs consume the
// same actual Native HDR and raster depth; only the facts producer differs.
export class FinalPixelSeedReference {
  constructor(device, width, height, analytic = false) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.owned = [];
    this.index = 0;
    this.analytic = analytic;
    this.priorAnalyticCamera = null;
    this.ideal = analytic ? null : new FinalPixelSeedReference(device, width, height, true);
    this.analyticParameters = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.fsr = new Fsr3UpscalerRuntime(device);
    this.identities = [this.texture("rgba32uint"), this.texture("rgba32uint")];
    this.previousCamera = this.buffer(PACKED_CAMERA_TYPE.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.constants = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.versions = this.buffer(8 * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.factsPipeline = device.createComputePipeline({ layout: "auto", compute: {
      module: device.createShaderModule({ code: analytic ? analyticFactsSource() : NATIVE_TEMPORAL_FACTS_WGSL }), entryPoint: "main",
    } });
    this.responsePipeline = device.createComputePipeline({ layout: "auto", compute: {
      module: device.createShaderModule({ code: `
@group(0) @binding(0) var response:texture_2d<f32>;
@group(0) @binding(1) var opaque:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(response))){return;}
  let value=textureLoad(response,vec2i(id.xy),0);
  textureStore(opaque,vec2i(id.xy),vec4f(value.x,value.z,0,0));
}` }), entryPoint: "main",
    } });
    const layout = device.createBindGroupLayout({ entries: [
      ...[0,1,2,3,4,5].map((binding) => ({binding,visibility:4,texture:{sampleType:"unfilterable-float"}})),
      ...[6,7,8].map((binding) => ({binding,visibility:4,texture:{sampleType:"uint"}})),
      {binding:9,visibility:4,buffer:{type:"storage"}},
      {binding:10,visibility:4,texture:{sampleType:"unfilterable-float"}},
    ] });
    this.comparePipeline = device.createComputePipeline({ layout: device.createPipelineLayout({bindGroupLayouts:[layout]}), compute: {
      module: device.createShaderModule({ code: `
@group(0) @binding(0) var actual:texture_2d<f32>;
@group(0) @binding(1) var reference:texture_2d<f32>;
@group(0) @binding(2) var seed:texture_2d<f32>;
@group(0) @binding(3) var motion:texture_2d<f32>;
@group(0) @binding(4) var mask:texture_2d<f32>;
@group(0) @binding(5) var reference_mask:texture_2d<f32>;
@group(0) @binding(6) var identity:texture_2d<u32>;
@group(0) @binding(7) var reference_identity:texture_2d<u32>;
@group(0) @binding(8) var previous_identity:texture_2d<u32>;
@group(0) @binding(9) var<storage,read_write> metrics:array<vec4f>;
@group(0) @binding(10) var ideal:texture_2d<f32>;
var<workgroup> sums:array<vec4f,64>;
var<workgroup> peaks:array<vec4f,64>;
var<workgroup> mask_counts:array<vec4f,64>;
var<workgroup> checks:array<vec4f,64>;
var<workgroup> ideal_errors:array<vec4f,64>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,
 @builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  sums[lane]=vec4f(0); peaks[lane]=vec4f(0); mask_counts[lane]=vec4f(0); checks[lane]=vec4f(0);
  ideal_errors[lane]=vec4f(0);
  let size=textureDimensions(actual); let p=vec2i(id.xy);
  if(all(id.xy<size)) {
    let a=textureLoad(actual,p,0).rgb; let b=textureLoad(reference,p,0).rgb;
    let delta=abs(a-b);
    let oracle=textureLoad(ideal,p,0).rgb;
    let actual_error=abs(a-oracle); let reference_error=abs(b-oracle);
    let interior=all(id.xy>=vec2u(2))&&all(id.xy+vec2u(2)<size);
    ideal_errors[lane]=vec4f(max(actual_error.x,max(actual_error.y,actual_error.z)),
      max(reference_error.x,max(reference_error.y,reference_error.z)),
      dot(actual_error,actual_error),dot(reference_error,reference_error))*select(0.0,1.0,interior);
    let finite=all(abs(a)<vec3f(3.402823466e38))&&all(abs(b)<vec3f(3.402823466e38));
    let mask_difference=textureLoad(mask,p,0)!=textureLoad(reference_mask,p,0);
    let mask_error=any(mask_difference);
    mask_counts[lane]=select(vec4f(0),vec4f(1),mask_difference);
    let current_identity=textureLoad(identity,p,0);
    let identity_error=any(current_identity!=textureLoad(reference_identity,p,0));
    var bits=16u;
    var hard=false;
    let actual_mask=textureLoad(mask,p,0);
    let old_mask=textureLoad(reference_mask,p,0);
    if(textureLoad(mask,p,0).y>0.5) {
      bits=0u;
      let uv=(vec2f(id.xy)+vec2f(0.5))/vec2f(size)-textureLoad(seed,p,0).xy;
      let previous=textureLoad(previous_identity,clamp(vec2i(uv*vec2f(size)),vec2i(0),vec2i(size)-1),0);
      hard=previous.x==current_identity.x&&(previous.y!=current_identity.y||(previous.w==current_identity.w&&previous.z!=current_identity.z));
      for(var field=0u;field<4u;field++){ if(current_identity[field]!=previous[field]){bits|=1u<<field;} }
    }
    let unexpected_byte=u32(round(textureLoad(mask,p,0).w*255.0))!=bits;
    let actual_valid=actual_mask.y>0.5;
    let old_valid=old_mask.y>0.5;
    let valid_motion=select(textureLoad(motion,p,0).xy,textureLoad(seed,p,0).xy,actual_valid);
    let previous_uv=(vec2f(id.xy)+vec2f(0.5))/vec2f(size)-valid_motion;
    // Offscreen decisions at a mathematically exact viewport edge can split
    // after the two f32 recovery chains. Only a one-ULP uncertainty at the
    // exact viewport edge is accepted; interior disagreement always fails.
    let edge_distance=min(min(abs(previous_uv.x),abs(previous_uv.y)),min(abs(1.0-previous_uv.x),abs(1.0-previous_uv.y)));
    let unexplained_valid=actual_valid!=old_valid&&edge_distance>exp2(-23.0);
    let wrong_hard=(actual_mask.z>0.5)!=hard;
    checks[lane]=vec4f(select(0.0,1.0,unexpected_byte),
      max(delta.x,max(delta.y,delta.z))/(exp2(-10.0)*max(1.0,max(abs(b.x),max(abs(b.y),abs(b.z)))))*select(0.0,1.0,interior),select(0.0,1.0,unexplained_valid),select(0.0,1.0,wrong_hard));
    sums[lane]=vec4f(select(0.0,dot(delta,delta),interior),select(0.0,dot(b,b),interior),select(0.0,1.0,mask_error),select(0.0,1.0,identity_error));
    let motion_error=select(vec2f(0),abs(textureLoad(seed,p,0).xy-textureLoad(motion,p,0).xy)*vec2f(size),actual_valid&&old_valid);
    let invalid_nonzero=!actual_valid&&any(textureLoad(seed,p,0).xy!=vec2f(0));
    // One binary16 representational step, derived from the reference magnitude.
    let ulp=exp2(floor(log2(max(abs(b),vec3f(exp2(-14.0)))))-vec3f(10.0));
    let ratio=delta/ulp;
    peaks[lane]=vec4f(max(motion_error.x,motion_error.y),max(delta.x,max(delta.y,delta.z)),
      max(ratio.x,max(ratio.y,ratio.z)),select(1.0,0.0,finite&&!invalid_nonzero));
  }
  workgroupBarrier();
  for(var stride=32u;stride>0u;stride/=2u) {
    if(lane<stride){ sums[lane]+=sums[lane+stride]; peaks[lane]=max(peaks[lane],peaks[lane+stride]); mask_counts[lane]+=mask_counts[lane+stride]; checks[lane]=max(checks[lane],checks[lane+stride]);
      ideal_errors[lane]=vec4f(max(ideal_errors[lane].xy,ideal_errors[lane+stride].xy),ideal_errors[lane].zw+ideal_errors[lane+stride].zw); }
    workgroupBarrier();
  }
  if(lane==0u){ let at=(group.x+group.y*((size.x+7u)/8u))*5u; metrics[at]=sums[0]; metrics[at+1u]=peaks[0]; metrics[at+2u]=mask_counts[0]; metrics[at+3u]=checks[0]; metrics[at+4u]=ideal_errors[0]; }
}` }), entryPoint: "main",
    } });
    const bytes = Math.ceil(width/8)*Math.ceil(height/8)*80;
    this.metrics = this.buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.readback = this.buffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  }
  texture(format) {
    const value = this.device.createTexture({size:[this.width,this.height],format,
      usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
    this.owned.push(value); return value;
  }
  buffer(size,usage) {
    const value=this.device.createBuffer({size,usage}); this.owned.push(value); return value;
  }
  prepare(command,settings,publication,camera) {
    if (this.analytic) {
      const previous = settings.reset || !this.priorAnalyticCamera ? camera : this.priorAnalyticCamera;
      const ratio = camera.distance / previous.distance;
      const shiftX = 0.5 * (camera.jitterX * ratio - previous.jitterX + (camera.x - previous.x) * previous.scaleX / previous.distance);
      const shiftY = 0.5 * (-camera.jitterY * ratio + previous.jitterY);
      this.device.queue.writeBuffer(this.analyticParameters, 0, new Float32Array([
        ratio, shiftX, shiftY, 0, 0.5 * (camera.jitterX - previous.jitterX),
        -0.5 * (camera.jitterY - previous.jitterY), 0, 0,
      ]));
      command.onFinished.addOne(() => { this.priorAnalyticCamera = camera; });
    }
    this.ideal?.prepare(command,settings,publication,camera);
    const versions = new Uint32Array(16);
    for(const entry of publication.entries) versions.set([entry.signature,entry.valueRevision],entry.materialSlot*2);
    this.device.queue.writeBuffer(this.versions,0,versions);
    this.device.queue.writeBuffer(this.constants,0,new Uint32Array([this.width,this.height,Number(!settings.reset),publication.materialSlotCount,0,0,0,0]));
    this.fsr.prepareFrame(command,settings);
    command.onFinished.addOne(()=>{this.index=1-this.index;this.fsr.commit(command.gpuDone);});
    command.onAborted.addOne(()=>this.fsr.abort());
  }
  addToGraph(graph,command,input) {
    const imported=(name,resource)=>graph.import_resource(`Seed reference/${name}`,{kind:"imported"},resource);
    const previous=imported("previous identity",this.identities[this.index]);
    const current=imported("current identity",this.identities[1-this.index]);
    const camera=imported("current camera",input.camera), priorCamera=imported("previous camera",this.previousCamera);
    const work=imported("work",input.work), instances=imported("authoritative Scene instances",input.instances);
    let opaque=-1,motion=-1,mask=-1,identity=-1;
    const response=graph.add("Seed reference/opaque response",{},(_data,resources)=>{
      const group=this.device.createBindGroup({layout:this.responsePipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:resources.get(input.response).createView()},
        {binding:1,resource:resources.get(opaque).createView()},
      ]});
      const pass=command.beginComputePass();pass.setPipeline(this.responsePipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    });
    response.read(input.response);
    const texture=(node,name,format)=>node.create(`Seed reference/${name}`,{kind:"transient_texture",width:this.width,height:this.height,format,
      usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING,domain:"internal-full"});
    opaque=texture(response,"opaque","rgba8unorm");
    const facts=graph.add("Seed reference/c71c6d31 Facts",{},(_data,resources)=>{
      const group=this.device.createBindGroup({layout:this.factsPipeline.getBindGroupLayout(0),entries:[
        ...[[0,input.visibility],[2,input.depth],[3,previous],[10,motion],[11,mask],[12,identity],[18,opaque]]
          .map(([binding,id])=>({binding,resource:resources.get(id).createView()})),
        ...[[4,resources.get(work)],[5,resources.get(instances)],[7,resources.get(camera)],
          [8,resources.get(priorCamera)],[9,this.constants],[17,this.versions]]
          .filter(([binding]) => !this.analytic || (binding !== 7 && binding !== 8))
          .map(([binding,buffer])=>({binding,resource:{buffer}})),
        ...(this.analytic ? [{binding:19,resource:{buffer:this.analyticParameters}}] : []),
      ]});
      const pass=command.beginComputePass();pass.setPipeline(this.factsPipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
    });
    for(const id of [input.visibility,input.depth,opaque,previous,camera,priorCamera,work,instances])facts.read(id);
    motion=texture(facts,"motion","rg32float");mask=texture(facts,"mask","rgba8unorm");identity=facts.write(current);
    const color=this.fsr.addToGraph(graph,{...input,motion,reactiveMask:mask,validityMask:mask,
      width:this.width,height:this.height,outputWidth:this.width,outputHeight:this.height},(_name,resolve)=>resolve(this.fsr));
    const copy=graph.add("Seed reference/submit camera publication",{},()=>{
      command.gpu_encoder.copyBufferToBuffer(input.camera,0,this.previousCamera,0,PACKED_CAMERA_TYPE.size);
    });copy.read(color);copy.read(camera);copy.write(priorCamera);copy.make_side_effect();
    const ideal = this.ideal?.addToGraph(graph,command,input);
    return {color,motion,mask,identity,previous,idealColor:ideal?.color};
  }
  compare(graph,command,actual,reference) {
    const ids=[actual.color,reference.color,actual.seed,reference.motion,actual.mask,reference.mask,actual.identity,reference.identity,reference.previous];
    const node=graph.add("Seed quality/full 1080p per-tile comparison",{},(_data,resources)=>{
      const group=this.device.createBindGroup({layout:this.comparePipeline.getBindGroupLayout(0),entries:[
        ...ids.map((id,binding)=>({binding,resource:resources.get(id).createView()})),
        {binding:9,resource:{buffer:this.metrics}},
        {binding:10,resource:resources.get(reference.idealColor).createView()},
      ]});
      const pass=command.beginComputePass();pass.setPipeline(this.comparePipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
      command.gpu_encoder.copyBufferToBuffer(this.metrics,0,this.readback,0,this.metrics.size);
    });ids.forEach((id)=>node.read(id));node.read(reference.idealColor);node.make_side_effect();
  }
  async measure() {
    await this.readback.mapAsync(GPUMapMode.READ);
    const values=new Float32Array(this.readback.getMappedRange());
    let error=0,energy=0,masks=0,identities=0,motion=0,peak=0,ulp=0,nonfinite=0;
    const channels=[0,0,0,0];
    let unexplainedByte=0,peakRgbComparisonUnits=0,unexplainedValidity=0,wrongHard=0;
    let actualAnalyticPeak=0,referenceAnalyticPeak=0,actualAnalyticSq=0,referenceAnalyticSq=0;
    for(let at=0;at<values.length;at+=20) {
      actualAnalyticPeak=Math.max(actualAnalyticPeak,values[at+16]);referenceAnalyticPeak=Math.max(referenceAnalyticPeak,values[at+17]);
      actualAnalyticSq+=values[at+18];referenceAnalyticSq+=values[at+19];
      for(let channel=0;channel<4;channel++)channels[channel]+=values[at+8+channel];
      unexplainedByte=Math.max(unexplainedByte,values[at+12]);peakRgbComparisonUnits=Math.max(peakRgbComparisonUnits,values[at+13]);
      unexplainedValidity=Math.max(unexplainedValidity,values[at+14]);wrongHard=Math.max(wrongHard,values[at+15]);
      error+=values[at];energy+=values[at+1];masks+=values[at+2];identities+=values[at+3];
      motion=Math.max(motion,values[at+4]);peak=Math.max(peak,values[at+5]);ulp=Math.max(ulp,values[at+6]);nonfinite=Math.max(nonfinite,values[at+7]);
    }
    this.readback.unmap();
    return {normalizedHdrError:Math.sqrt(error/Math.max(energy,1e-20)),motionPixelError:motion,
      maskChannels:channels,maskMismatches:masks,identityMismatches:identities,peakHdrError:peak,peakHalfSteps:ulp,unexplainedValidity,wrongHard,unexplainedByte,peakRgbComparisonUnits,nonfinite,
      actualAnalyticPeak,referenceAnalyticPeak,actualAnalyticRmse:Math.sqrt(actualAnalyticSq/Math.max(energy,1e-20)),referenceAnalyticRmse:Math.sqrt(referenceAnalyticSq/Math.max(energy,1e-20))};
  }
  destroy() {this.ideal?.destroy();this.fsr.destroy();for(const value of this.owned)value.destroy();}
}
