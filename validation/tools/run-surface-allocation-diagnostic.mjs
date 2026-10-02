import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root=process.cwd(),out=resolve(root,process.argv[2]??".local/validation/surface-v3-allocation-analysis");
const port=Number(process.argv[3]??4185);
await mkdir(out,{recursive:true});
const server=await createServer({configFile:resolve(root,"examples/vite.config.ts"),clearScreen:false,
 server:{host:"127.0.0.1",port,strictPort:true},plugins:[{name:"surface-allocation-observation",enforce:"pre",
 transform(code,id){if(id.replaceAll("\\","/").split("?")[0].endsWith("next-renderer-showcase/main.ts"))
 return code.replace('get adapter() {', 'get allocation() { return { buffers: renderer?.graphics.buffer_allocator_main.evidence(), textures: renderer?.graphics.allocator_textures.evidence(), accounting: renderer?.graphics.resource_accounting.snapshot() }; }, get adapter() {');}
 }]});
const report={evidenceRole:"diagnostic",accepted:false,errors:[]};let browser;
try{
 await server.listen();browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:false,
 ignoreDefaultArgs:["--enable-unsafe-swiftshader","--no-sandbox","--unsafely-disable-devtools-self-xss-warnings"]});
 const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 await context.addInitScript(()=>{
  const state={createdCount:0,createdBytes:0,destroyedCount:0,destroyedBytes:0,clearedBytes:0,events:[]};
  const buffers=new WeakMap();let serial=0;
  const create=GPUDevice.prototype.createBuffer, destroy=GPUBuffer.prototype.destroy, clear=GPUCommandEncoder.prototype.clearBuffer;
  GPUDevice.prototype.createBuffer=function(desc){const b=create.call(this,desc);buffers.set(b,++serial);state.createdCount++;state.createdBytes+=desc.size;
   if(desc.size>=64*1024*1024)state.events.push({action:"create",id:serial,size:desc.size,label:desc.label,frame:globalThis.__eengineShowcase?.runtime.frameCount??-1});return b;};
  GPUBuffer.prototype.destroy=function(){state.destroyedCount++;state.destroyedBytes+=this.size;
   if(this.size>=64*1024*1024)state.events.push({action:"destroy",id:buffers.get(this),size:this.size,frame:globalThis.__eengineShowcase?.runtime.frameCount??-1});return destroy.call(this);};
  GPUCommandEncoder.prototype.clearBuffer=function(b,offset=0,size){state.clearedBytes+=size??b.size-offset;return clear.call(this,b,offset,size);};
  globalThis.__allocationObservation=state;
 });
 const page=await context.newPage();page.on("pageerror",e=>report.errors.push(String(e)));
 page.on("console",m=>{if(m.type()==="error")report.errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${port}/demos/14-integrated/next-renderer-showcase/`);
 await page.waitForFunction(()=>!!globalThis.__eengineShowcase);await page.evaluate(()=>globalThis.__eengineShowcase.start());
 await page.evaluate(()=>globalThis.__eengineShowcase.capture({width:1920,height:1080,frames:1,warmup:5,coverage:"preset",distanceScale:0.885,retainView:true,surfaceMode:"timing"}));
 report.start=await page.evaluate(()=>({runtime:globalThis.__eengineShowcase.runtime,allocation:globalThis.__eengineShowcase.allocation,observation:globalThis.__allocationObservation}));
 const begin=report.start.runtime.frameCount;
 await page.waitForFunction(n=>globalThis.__eengineShowcase.runtime.frameCount>=n+40,begin,{timeout:120000});
 report.end=await page.evaluate(()=>({runtime:globalThis.__eengineShowcase.runtime,allocation:globalThis.__eengineShowcase.allocation,observation:globalThis.__allocationObservation}));
 console.log(JSON.stringify({start:report.start.allocation,end:report.end.allocation,createdDelta:report.end.observation.createdCount-report.start.observation.createdCount,
  createdBytesDelta:report.end.observation.createdBytes-report.start.observation.createdBytes,clearedBytesDelta:report.end.observation.clearedBytes-report.start.observation.clearedBytes}));
 await page.evaluate(()=>globalThis.__eengineShowcase.dispose());await context.close();
}catch(error){report.errors.push(String(error));}
finally{await browser?.close();await server.close();await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2));console.log(`Artifacts: ${out}`);
 if(report.errors.length){console.error(report.errors);process.exitCode=1;}}
