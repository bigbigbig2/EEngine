import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root=process.cwd(),out=resolve(root,".local/validation/surface-bandwidth-oracle");
await mkdir(out,{recursive:true});
const server=await createServer({configFile:resolve(root,"examples/vite.config.ts"),clearScreen:false,
 server:{host:"127.0.0.1",port:4202,strictPort:true,fs:{allow:[root]}},plugins:[{name:"bandwidth-oracle",configureServer(dev){
 dev.middlewares.use("/oracle",(_req,res)=>{res.setHeader("Content-Type","text/html");res.end("<!doctype html><title>Surface traffic oracle</title>");});}}]});
const report={evidenceRole:"diagnostic",accepted:false,checks:[],errors:[]};let browser;
try{
 await server.listen();browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:false,
 ignoreDefaultArgs:["--enable-unsafe-swiftshader","--no-sandbox","--unsafely-disable-devtools-self-xss-warnings"]});
 const page=await browser.newPage();await page.goto("http://127.0.0.1:4202/oracle");
 report.checks=await page.evaluate(async()=>{
  const base="/@fs/D:/code/EEngine/OEngine/src/";
  const {SurfaceDiagnosticsPass}=await import(base+"render/surface/SurfaceDiagnosticsPass.ts");
  const abi=await import(base+"gpu/SurfaceDiagnosticsAbi.ts");
  const adapter=await navigator.gpu.requestAdapter();const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:8}});
  device.pushErrorScope("validation");const owner=new SurfaceDiagnosticsPass(device),resources=[];
  const b=(size,uniform=false)=>{const x=device.createBuffer({size,usage:(uniform?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});resources.push(x);return x;};
  const write=(buffer,words)=>device.queue.writeBuffer(buffer,0,new Uint32Array(words));
  const settings=b(32,true),surface=b(128),material=b(48),audit=b(16),geometry=b(96),miss=b(32),lighting=b(96),snapshot=b(abi.SURFACE_DIAGNOSTICS_BYTE_SIZE),reconstruct=b(32);
  write(settings,[8,8,1,0,0,12,0,0]);const g=new Uint32Array(24);g[3]=1;g[4]=1;g[22]=36;write(geometry,g);
  const l=new Uint32Array(24);l[12]=1;l[20]=1;l[21]=1;l[22]=1;l[23]=1;write(lighting,l);
  const group=device.createBindGroup({layout:owner.pipeline.getBindGroupLayout(0),entries:[settings,surface,material,audit,geometry,miss,lighting,snapshot,reconstruct].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const checks=[];const check=(name,actual,expected)=>{checks.push({name,actual,expected});if(actual!==expected)throw new Error(`${name}: ${actual} != ${expected}`);};
  const run=async()=>{const dst=device.createBuffer({size:snapshot.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(owner.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    encoder.copyBufferToBuffer(snapshot,0,dst,0,snapshot.size);device.queue.submit([encoder.finish()]);await dst.mapAsync(GPUMapMode.READ);const words=new Uint32Array(dst.getMappedRange().slice(0));dst.unmap();dst.destroy();
    return name=>words[abi.SURFACE_DIAGNOSTICS_HEADER_WORDS+abi.SURFACE_DIAGNOSTICS_COUNTERS[name]];};
  // One representative serves 64 pixels. Read traffic follows targets, not samples.
  write(reconstruct,[64,0,64,0,0,64,256,64]);let value=await run();
  check("one sample / 64 covered pixels / four histories: reads",value("reconstructReadBytes"),9472);
  check("all 64 outputs write four histories plus facts/HDR",value("reconstructWriteBytes"),4096);
  check("geometry hit metadata writes are not zero",value("geometryRecordWriteBytes"),36);
  check("zero coat packet still consumes bytes",value("packetWriteBytes"),64);
  write(reconstruct,[0,64,0,64,0,64,0,2]);value=await run();
  check("two invalid mapped targets read only validity packet",value("reconstructReadBytes"),3360);
  check("empty output still writes full reconstruction products",value("reconstructWriteBytes"),4096);
  const error=await device.popErrorScope();if(error)throw new Error(error.message);owner.destroy();for(const x of resources)x.destroy();device.destroy();return checks;
 });
}catch(error){report.errors.push(String(error));}
finally{await browser?.close();await server.close();await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;}
