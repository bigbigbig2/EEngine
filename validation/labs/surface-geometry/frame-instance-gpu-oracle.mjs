// Diagnostic: actual instance owner -> production hardware raster and Surface setup.
// Does not establish complete S2, Chrome, quality or performance acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import "../../../OEngine/tests/webgpu-test-globals.mjs";
import { FrameInstanceTransforms } from "../../../OEngine/.test-dist/render/FrameInstanceTransforms.js";
import { GPU_INSTANCE_RECORD_WGSL, packGpuInstanceRecords } from "../../../OEngine/.test-dist/gpu/GpuInstanceAbi.js";
import { SURFACE_FRAME_INSTANCE_WGSL } from "../../../OEngine/.test-dist/gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../../OEngine/.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../../OEngine/.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../../../OEngine/.test-dist/gpu/GpuSparseShadingFrameAbi.js";
import { PACKED_CAMERA_TYPE } from "../../../OEngine/.test-dist/shaders/packed_camera.js";
import { geometryWgsl } from "../../../OEngine/.test-dist/shaders/surface_geometry.js";
import { SURFACE_TRIANGLE_SETUP_WGSL } from "../../../OEngine/.test-dist/shaders/surface_triangle_setup.js";
import { MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL, VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL } from "../../../OEngine/.test-dist/shaders/meshlet_bucket_visibility.js";
import { surfaceProbeWgsl } from "../../../OEngine/.test-dist/shaders/surface_probe.js";
import { surfaceSampleWorkerWgsl } from "../../../OEngine/.test-dist/shaders/surface_sample_worker.js";
import { compileSurfaceProgramLayout, planSurfaceClosureLightingBindings } from "../../../OEngine/.test-dist/render/surface/SurfaceKernelBindingPlan.js";
import { homogeneousInterpolationReference, transformPosition } from "../../../OEngine/tests/helpers/homogeneous-interpolation-reference.mjs";

if (!process.argv[2]) throw new Error("Pass external webgpu runtime directory");
const { create, globals } = createRequire(resolve(process.argv[2], "package.json"))("webgpu"); Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]), adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter && !adapter.info.isFallbackAdapter);
const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
const errors = [], resources = [], cases = []; let disposing = false, lost, owner;
// Native async PSO callbacks alone do not keep Node's event loop alive.
const keepAlive = setInterval(() => {}, 1000);
device.addEventListener("uncapturederror", e => errors.push(e.error.message));
void device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const artifacts = resolve(".local/validation/surface-geometry"); await mkdir(artifacts, { recursive: true });
const reportPath=resolve(artifacts,process.argv.includes("--compile-consumers")?"frame-instance-native-compile-report.json":"frame-instance-gpu-report.json");
const report = { evidenceRole: "diagnostic", component: "SharedFrameInstanceTransforms", passed: false, cases,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } };
const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const width = 64, height = 64;
function buffer(value, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
  const size = typeof value === "number" ? value : value.byteLength;
  const b = device.createBuffer({ size: Math.max(4, size), usage }); resources.push(b);
  if (typeof value !== "number") device.queue.writeBuffer(b, 0, value); return b;
}
function texture(format) {
  const t = device.createTexture({ size: [width,height], format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }); resources.push(t); return t;
}
async function mapped(b, Type = Float32Array) { await b.mapAsync(GPUMapMode.READ); const a = new Type(b.getMappedRange().slice(0)); b.unmap(); return a; }
const readback = size => buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
async function module(code) {
  const m = device.createShaderModule({ code }); const info = await m.getCompilationInfo();
  assert.deepEqual(info.messages.filter(m => m.type === "error"), []); return m;
}
async function compute(code, entryPoint) {
  console.log(`Compiling ${entryPoint} (${code.length} chars)`);
  return device.createComputePipelineAsync({ layout: "auto", compute: { module: await module(code), entryPoint } });
}
function group(pipeline, entries) {
  return device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries.map(([binding, resource]) =>
    ({ binding, resource: resource.size === undefined ? resource : { buffer: resource } })) });
}
function sourceBytes(matrices) {
  return packGpuInstanceRecords(matrices.map((matrix, slot) => ({ currentObjectToWorld: matrix, previousObjectToWorld: I,
    geometryRecordIndex: 0, geometryGeneration: 7, materialHandle: 0, flags: 1, debugId: slot + 100,
    boundsSphere: [0,0,0,2], boundsMin: [-1,-1,-1], boundsMax: [1,1,1] })));
}
function cameraBytes(matrix) { const bytes = new Uint8Array(PACKED_CAMERA_TYPE.size); new Float32Array(bytes.buffer,384,16).set(matrix); return bytes; }
function queueBytes(slots, generation, capacity = 192, headerCount = slots.length) {
  const data = new Uint32Array(8 + capacity * 6); data.set([headerCount,headerCount,0,capacity,0,generation,0,0]);
  slots.forEach((slot,i) => data.set([slot,0,0,0,0,1],8+i*6)); return data;
}
// Independent normal oracle solves M^T n = local by pivoted Gaussian elimination.
function normalReference(matrix, local, geometric = [0,0,1]) {
  const a = Array.from({ length: 3 }, (_,row) => [matrix[row*4],matrix[row*4+1],matrix[row*4+2],local[row]]);
  for (let col=0;col<3;col++) {
    let pivot=col; for(let row=col+1;row<3;row++) if(Math.abs(a[row][col])>Math.abs(a[pivot][col])) pivot=row;
    if(Math.abs(a[pivot][col])<1e-10) return geometric; [a[pivot],a[col]]=[a[col],a[pivot]];
    const d=a[col][col]; for(let k=col;k<4;k++) a[col][k]/=d;
    for(let row=0;row<3;row++) if(row!==col) { const factor=a[row][col]; for(let k=col;k<4;k++) a[row][k]-=factor*a[col][k]; }
  }
  const n=a.map(row=>row[3]), len=Math.hypot(...n); return n.map(v=>v/len);
}
try {
  owner = new FrameInstanceTransforms(device, undefined, true); await owner.ready;
  const localPositions = [[-0.7,-0.6,0.5,1],[0.7,-0.6,0.5,1],[0,0.7,0.5,1]];
  const matrices = [I, [-0.7,0,0,0, 0,1.3,0,0, 0,0,0.4,0, 0.12,0,0,1],
    [0.6,0.15,0,0, -0.2,0.8,0,0, 0,0,1.1,0, 0,0.05,0,1],
    [1,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,1], I];
  const source = buffer(sourceBytes(matrices)), camera = buffer(cameraBytes(I), GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const work = buffer(queueBytes([0,0,1,2,3,2],1)), allocation = owner.prepare({ camera, source, work, workCapacity:192, instanceCapacity:5 });
  const recordsRead = readback(allocation.records.size), controlRead = readback(16);
  const geo = new Uint32Array(60); geo[12]=3; geo[30]=12; geo[31]=1;
  const meshlet = new Uint32Array(28); meshlet[1]=3; meshlet[3]=1;
  const metadata = buffer(new Uint32Array([...geo,...meshlet]));
  const positions = new Float32Array(localPositions.flatMap(p=>p.slice(0,3)));
  const payloadBytes = new Uint8Array(16+positions.byteLength); new Uint32Array(payloadBytes.buffer,0,4).set([0,1,2,0x020100]); payloadBytes.set(new Uint8Array(positions.buffer),16);
  const payload = buffer(payloadBytes);
  const viewBytes = new Uint8Array(240); new Uint32Array(viewBytes.buffer).set([width,height,1,1,1,1,0,1,0,60,0,0,3,4]);
  const shadingView = buffer(viewBytes,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const visible = texture("r32uint"), depth = texture("depth32float");
  const out = buffer(width*height*64), outRead = readback(out.size), keyRead = readback(width*height*4);
  const localNormal = [0.3,0.4,0.5];
  const consumer = await compute(`requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_SPARSE_SHADING_VIEW_WGSL}
@group(0) @binding(0) var<storage,read> instance_records:array<OEngineFrameInstanceRecord>;
@group(0) @binding(1) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage,read> asset_metadata_heap:array<u32>;
@group(0) @binding(3) var<storage,read> vertex_payload_heap:array<u32>;
@group(0) @binding(4) var<uniform> shading_view:OEngineSparseShadingView;
@group(0) @binding(5) var visibility:texture_2d<u32>;
struct Output { weights:vec4f, normal:vec4f, clip:vec4f, source_identity:vec4u, }
@group(0) @binding(6) var<storage,read_write> output:array<Output>;
${SURFACE_FRAME_INSTANCE_WGSL}
var<private> surface_identity_failed:bool;
fn sparse_identity_error(){surface_identity_failed=true;}
const SAMPLE_COUNTER_setupBuilds:u32=0u; const SAMPLE_COUNTER_setupHits:u32=1u; const SAMPLE_COUNTER_setupMisses:u32=2u;
fn sample_add(a:u32,b:u32){}
${geometryWgsl(false)}
${SURFACE_TRIANGLE_SETUP_WGSL}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if any(id.xy>=vec2u(shading_view.width,shading_view.height)){return;}
  let key=textureLoad(visibility,vec2i(id.xy),0).x; var value:Output;
  if oengine_visibility_key_is_valid(key) && meshlet_work.header.generation!=0u {
    let work=meshlet_work.elements[oengine_visibility_key_meshlet_work_slot(key)];
    let setup=surface_setup_direct(work,oengine_visibility_key_local_primitive(key));
    let bary=sparse_barycentric(vec2f(id.xy)+vec2f(0.5),setup.c0,setup.c1,setup.c2);
    value.weights=vec4f(bary.weights,select(0.0,1.0,bary.valid));
    value.normal=vec4f(surface_world_normal(work.instance_slot,vec3f(0.3,0.4,0.5),vec3f(0,0,1)),1.0);
    value.clip=setup.c0; value.source_identity=vec4u(surface_instance_record(work.instance_slot).debug_id,
      surface_instance_record(work.instance_slot).geometry_record_index,work.instance_slot,0u);
  }
  output[id.y*shading_view.width+id.x]=value;
}`,"main");
  const consumeGroup = group(consumer,[[0,allocation.records],[1,work],[2,metadata],[3,payload],[4,shadingView],[5,visible.createView()],[6,out]]);
  const rasterModule = await module(MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL);
  const raster = await device.createRenderPipelineAsync({ layout:"auto",vertex:{module:rasterModule,entryPoint:"raster_meshlet_bucket"},
    fragment:{module:rasterModule,entryPoint:"write_meshlet_opaque",targets:[{format:"r32uint"}]},
    primitive:{topology:"triangle-list",cullMode:"back",frontFace:"ccw"},
    depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:"greater"} });
  const buckets = new Uint32Array(64*4); buckets[0]=1;
  const rasterGroup = group(raster,[[1,allocation.records],[2,buffer(meshlet)],[3,buffer(new Uint32Array([0,1,2]))],
    [4,buffer(new Uint32Array([0x020100]))],[5,buffer(positions)],[6,buffer(geo)],[7,work],[8,buffer(buckets)],
    [9,buffer(new Uint32Array([0,0,0,0]),GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)]]);
  let pixels=0,maxClipError=0,maxNormalError=0,maxBaryError=0;
  const inputs = [
    {name:"duplicate-nonuniform-mirrored-singular",slots:[0,0,1,2,3,2],generation:1,raster:true,camera:I},
    {name:"mirrored-raster",slots:[1,1],generation:2,raster:true,camera:I},
    {name:"shear-raster",slots:[2,2],generation:3,raster:true,camera:I},
    {name:"camera-change",slots:[0,1,2],generation:4,raster:true,camera:[0.9,0,0,0,0,0.9,0,0,0,0,1,0,0.05,-0.02,0,1]},
    {name:"empty-after-visible",slots:[],generation:5,raster:false,camera:I},
    {name:"zero-generation",slots:[0,1],generation:0,raster:false,camera:I},
    {name:"invalid-slot-bounded",slots:[0,5,0xffffffff,2],generation:6,raster:false,camera:I},
    {name:"header-count-clamp",slots:Array.from({length:192},(_,i)=>i%5),count:0xffffffff,generation:7,raster:false,camera:I},
    {name:"instance-motion-change",slots:[0,0],generation:8,raster:true,camera:I,mutate:true},
    {name:"generation-all-bits",slots:[0,1,2],generation:0x7fffffff,raster:false,camera:I},
  ];
  for(const input of inputs){
    if(input.mutate) { matrices[0]=[0.8,0.1,0,0,-0.1,0.7,0,0,0,0,1,0,-0.1,0.06,0,1]; device.queue.writeBuffer(source,0,sourceBytes(matrices)); }
    device.queue.writeBuffer(camera,0,cameraBytes(input.camera)); device.queue.writeBuffer(work,0,queueBytes(input.slots,input.generation,192,input.count));
    device.pushErrorScope("validation"); const encoder=device.createCommandEncoder(); owner.encode(encoder,allocation);
    const pass=encoder.beginRenderPass({colorAttachments:[{view:visible.createView(),loadOp:"clear",storeOp:"store",clearValue:{r:0xffffffff,g:0,b:0,a:0}}],
      depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:"clear",depthStoreOp:"store"}});
    if(input.raster){pass.setPipeline(raster);pass.setBindGroup(0,rasterGroup);pass.draw(3,1);} pass.end();
    const cp=encoder.beginComputePass();cp.setPipeline(consumer);cp.setBindGroup(0,consumeGroup);cp.dispatchWorkgroups(width/8,height/8);cp.end();
    for(const [a,b] of [[allocation.records,recordsRead],[allocation.control,controlRead],[out,outRead]])encoder.copyBufferToBuffer(a,0,b,0,a.size);
    encoder.copyTextureToBuffer({texture:visible},{buffer:keyRead,bytesPerRow:width*4},[width,height]); device.queue.submit([encoder.finish()]);
    const [records,control,values,keys]=await Promise.all([mapped(recordsRead,Uint8Array),mapped(controlRead,Uint32Array),mapped(outRead),mapped(keyRead,Uint32Array)]);
    assert.equal(await device.popErrorScope(),null); const valid=input.generation===0?[]:input.slots.filter(slot=>slot<5);
    const selected=new Set(valid); assert.equal(control[0],selected.size);assert.equal(control[1],input.generation===0?0:input.slots.length-valid.length);
    const sourceExpected=sourceBytes(matrices), recordFloat=new Float32Array(records.buffer), recordUint=new Uint32Array(records.buffer);
    for(const slot of selected){
      assert.deepEqual(records.slice(slot*288,slot*288+176),sourceExpected.slice(slot*176,(slot+1)*176));
      assert.equal(recordUint[slot*72+67],input.generation);
      for(let column=0;column<4;column++){
        const expected=transformPosition(input.camera,matrices[slot].slice(column*4,column*4+4));
        for(let lane=0;lane<4;lane++){const error=Math.abs(recordFloat[slot*72+44+column*4+lane]-expected[lane]);maxClipError=Math.max(maxClipError,error);assert.ok(error<0.000002);}
      }
    }
    let coverage=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const at=y*width+x,b=at*16;if(keys[at]===0xffffffff){assert.equal(values[b+3],0);continue;}coverage++;
      const slot=input.slots[0], clips=localPositions.map(p=>transformPosition(input.camera,transformPosition(matrices[slot],p)));
      const expected=homogeneousInterpolationReference(clips,[x+0.5,y+0.5],[width,height]);assert.ok(expected.flags&1);assert.equal(values[b+3],1);
      const normal=normalReference(matrices[slot],localNormal);
      for(let lane=0;lane<3;lane++){
        const be=Math.abs(values[b+lane]-expected.weights[lane]),ne=Math.abs(values[b+4+lane]-normal[lane]);
        maxBaryError=Math.max(maxBaryError,be);maxNormalError=Math.max(maxNormalError,ne);assert.ok(be<0.000003&&ne<0.000002);
      }
      for(let lane=0;lane<4;lane++)assert.ok(Math.abs(values[b+8+lane]-clips[0][lane])<0.000002);
      assert.equal(new Uint32Array(values.buffer)[b+12],slot+100);
    }
    if(input.raster)assert.ok(coverage>200);else assert.equal(coverage,0);pixels+=coverage;
    cases.push({name:input.name,selected:control[0],invalid:control[1],covered:coverage});
  }
  // Compile every affected production family, including the 16-storage envelope.
  const compiled=[];
  console.log(`GPU transform/raster/Surface cases passed: ${pixels} pixels`);
  Object.assign(report,{passed:true,coveredPixels:pixels,maxClipError,maxNormalError,maxBaryError,compiled,apiErrors:errors,deviceLost:lost??null});
  await writeFile(reportPath,JSON.stringify(report,null,2));
  // Full native PSO compilation is optional; production compilation is also
  // checked in installed Chrome by frame-instance-chrome-compile.mjs.
  if(process.argv.includes("--compile-consumers")) {
  report.passed=false;
  report.compilePending="Product module";await writeFile(reportPath,JSON.stringify(report,null,2));
  await module(VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL);compiled.push("Product-raster-module");
  for(const virtual of [false,true]){
    report.compilePending=`Probe-${virtual}`;await writeFile(reportPath,JSON.stringify(report,null,2));
    await compute(surfaceProbeWgsl(virtual,virtual?4:0,false),"probe");compiled.push(`Probe-${virtual}`);
    const {plan}=compileSurfaceProgramLayout({kernel:{programId:15,outputDependencyMask:0,textureBankMask:1},
      virtualGeometry:virtual,virtualBankCount:virtual?4:0,lighting:"direct",physicalEnvironment:true,shadowProfile:"off",aoProfile:"scalar-high",
      source:"surface-samples-v1",capabilityFingerprint:"diagnostic",formatProfile:"rgba16float"},device.limits);
    assert.ok(plan.totals.storageBuffers<=16);
    await compute(surfaceSampleWorkerWgsl(plan,true,virtual,false,virtual?4:0,1,true,false),"shade");compiled.push(`Worker-${virtual}`);
    const lighting=planSurfaceClosureLightingBindings(plan,device.limits);
    await compute(surfaceSampleWorkerWgsl(lighting,true,virtual,false,virtual?4:0,1,true,true),"shade_closure");compiled.push(`Closure-${virtual}`);
  }
  }
  assert.deepEqual(errors,[]);assert.equal(lost,undefined);
  Object.assign(report,{passed:true,coveredPixels:pixels,maxClipError,maxNormalError,maxBaryError,compiled,apiErrors:errors,deviceLost:lost??null});
}catch(error){report.error=String(error.stack??error);throw error;}
finally{await writeFile(reportPath,JSON.stringify(report,null,2));owner?.destroy();disposing=true;resources.forEach(r=>r.destroy());device.destroy();clearInterval(keepAlive);}
console.log(JSON.stringify(report,null,2));
