// Actual installed, headed Chrome; compile affected production consumers.
import "../../../OEngine/tests/webgpu-test-globals.mjs";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import { surfaceProbeWgsl } from "../../../OEngine/.test-dist/shaders/surface_probe.js";
import { surfaceSampleWorkerWgsl } from "../../../OEngine/.test-dist/shaders/surface_sample_worker.js";
import { frameInstanceTransformsWgsl } from "../../../OEngine/.test-dist/shaders/frame_instance_transforms.js";
import { MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL, VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL } from "../../../OEngine/.test-dist/shaders/meshlet_bucket_visibility.js";
import { compileSurfaceProgramLayout, planSurfaceClosureLightingBindings } from "../../../OEngine/.test-dist/render/surface/SurfaceKernelBindingPlan.js";
const server = createServer((_req,res) => { res.writeHead(200,{"Content-Type":"text/html"});res.end("<!doctype html><title>EEngine GPU compile oracle</title><h1>Shared frame geometry: production shader validation</h1>"); });
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({ executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:false,args:[],
  ignoreDefaultArgs:["--enable-unsafe-swiftshader","--no-sandbox","--unsafely-disable-devtools-self-xss-warnings"] });
const artifacts=resolve(".local/validation/surface-geometry");await mkdir(artifacts,{recursive:true});
const report={evidenceRole:"diagnostic",browser:browser.version(),headless:false,passed:false,stages:[]};
try {
  const page=await browser.newPage();page.on("console",message=>console.log(message.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
    if(!a)throw new Error("Chrome returned no adapter");globalThis.oracleDevice=await a.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}});
    globalThis.oracleErrors=[];globalThis.oracleLost=null;oracleDevice.addEventListener("uncapturederror",e=>oracleErrors.push(e.error.message));
    void oracleDevice.lost.then(info=>{oracleLost={reason:info.reason,message:info.message};});
    const info=a.info;return {vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter,
      limits:Object.fromEntries(["maxBindGroups","maxBindingsPerBindGroup","maxStorageBuffersPerShaderStage","maxStorageTexturesPerShaderStage","maxSampledTexturesPerShaderStage","maxSamplersPerShaderStage","maxUniformBuffersPerShaderStage"].map(k=>[k,oracleDevice.limits[k]]))};});
  report.adapter=adapter;if(adapter.isFallbackAdapter)throw new Error("Hardware adapter required");
  const tasks=[{label:"Frame-instance",code:frameInstanceTransformsWgsl(false),entries:["frame_instance_begin","frame_instance_select","frame_instance_finalize","frame_instance_build"]},
    {label:"Ordinary-raster",code:MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL,render:["raster_meshlet_bucket","write_meshlet_opaque"]},
    {label:"Ordinary-mask",code:MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL,render:["raster_meshlet_bucket","write_meshlet_mask"]},
    {label:"Product-raster",code:VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL,render:["raster_virtual_meshlet","write_virtual_meshlet"]}];
  for(const virtual of [false,true]) {
    tasks.push({label:`Probe-${virtual}`,code:surfaceProbeWgsl(virtual,virtual?4:0,false),entries:["probe"]});
    const {plan}=compileSurfaceProgramLayout({kernel:{programId:15,outputDependencyMask:0,textureBankMask:1},virtualGeometry:virtual,virtualBankCount:virtual?4:0,
      lighting:"direct",physicalEnvironment:true,shadowProfile:"off",aoProfile:"scalar-high",source:"surface-samples-v1",capabilityFingerprint:"chrome-diagnostic",formatProfile:"rgba16float"},adapter.limits);
    tasks.push({label:`Worker-${virtual}`,storageBuffers:plan.totals.storageBuffers,code:surfaceSampleWorkerWgsl(plan,true,virtual,false,virtual?4:0,1,true,false),entries:["shade"]});
    const lighting=planSurfaceClosureLightingBindings(plan,adapter.limits);
    tasks.push({label:`Closure-${virtual}`,code:surfaceSampleWorkerWgsl(lighting,true,virtual,false,virtual?4:0,1,true,true),entries:["shade_closure"]});
  }
  for(const task of tasks){
    console.log(`Chrome compile ${task.label}`);
    const result=await page.evaluate(async task=>{
      const started=performance.now();oracleDevice.pushErrorScope("validation");
      try {const module=oracleDevice.createShaderModule({label:task.label,code:task.code}),info=await module.getCompilationInfo();
        const errors=info.messages.filter(m=>m.type==="error").map(m=>({line:m.lineNum,message:m.message}));if(errors.length)throw new Error(JSON.stringify(errors));
        for(const entryPoint of task.entries??[])await oracleDevice.createComputePipelineAsync({label:task.label,layout:"auto",compute:{module,entryPoint}});
        if(task.render)await oracleDevice.createRenderPipelineAsync({label:task.label,layout:"auto",vertex:{module,entryPoint:task.render[0]},
          fragment:{module,entryPoint:task.render[1],targets:[{format:"r32uint"}]},primitive:{topology:"triangle-list",cullMode:"none"},
          depthStencil:{format:"depth32float",depthWriteEnabled:true,depthCompare:"greater"}});
        return {label:task.label,passed:true,ms:performance.now()-started};
      }catch(error){return {label:task.label,passed:false,error:String(error.stack??error),ms:performance.now()-started};}
      finally {const error=await oracleDevice.popErrorScope();if(error)oracleErrors.push(error.message);}
    },task);report.stages.push(result);await writeFile(resolve(artifacts,"frame-instance-chrome-compile.json"),JSON.stringify(report,null,2));
    if(!result.passed)throw new Error(JSON.stringify(result));
  }
  Object.assign(report,await page.evaluate(()=>({apiErrors:oracleErrors,deviceLost:oracleLost})));report.passed=report.apiErrors.length===0&&report.deviceLost===null;
  if(!report.passed)throw new Error("Chrome validation/device failure");
}catch(error){report.error=String(error.stack??error);throw error;}
finally {await writeFile(resolve(artifacts,"frame-instance-chrome-compile.json"),JSON.stringify(report,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify(report,null,2));
