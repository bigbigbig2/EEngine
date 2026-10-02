import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const root=process.cwd(),out=resolve(root,".local/validation/surface-v3-capacity-analysis"),run=promisify(execFile);
await mkdir(out,{recursive:true});let capacity=2097152, browser, timer, pending=Promise.resolve(),busy=false;
const report={evidenceRole:"diagnostic",accepted:false,description:"Capacity sensitivity only; identical sample workload, never a production capacity recommendation",errors:[],samples:[],captures:[]};
const server=await createServer({configFile:resolve(root,"examples/vite.config.ts"),clearScreen:false,
 server:{host:"127.0.0.1",port:4186,strictPort:true},plugins:[{name:"bounded-capacity-sensitivity",enforce:"pre",
 transform(code,id){const path=id.replaceAll("\\","/").split("?")[0];
  if(path.endsWith("render/pipeline/RendererCore.ts")) return code.replace("maxSamples: 2097152",`maxSamples: ${capacity}`).replace("maxGeometryRecords: 2097152",`maxGeometryRecords: ${capacity}`);
  if(path.endsWith("next-renderer-showcase/main.ts")) return code.replace('get adapter() {','get allocation() { return { buffers: renderer?.graphics.buffer_allocator_main.evidence(), textures: renderer?.graphics.allocator_textures.evidence(), accounting: renderer?.graphics.resource_accounting.snapshot() }; }, get adapter() {');
 }}]});
async function sensor(){if(busy)return;busy=true;try{const {stdout}=await run("nvidia-smi",["--query-gpu=memory.used,temperature.gpu,utilization.gpu,clocks.current.graphics,clocks_event_reasons.sw_thermal_slowdown","--format=csv,noheader,nounits"],{windowsHide:true});report.samples.push({time:Date.now(),capacity,values:stdout.trim()});}finally{busy=false;}}
try{
 await server.listen();timer=setInterval(()=>{pending=sensor().catch(e=>report.errors.push(String(e)));},1000);
 for(const cap of [2097152,1048576]){
  capacity=cap;server.moduleGraph.invalidateAll();
  browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:false,
   ignoreDefaultArgs:["--enable-unsafe-swiftshader","--no-sandbox","--unsafely-disable-devtools-self-xss-warnings"]});
  const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1}),page=await context.newPage();
  page.on("pageerror",e=>report.errors.push(String(e)));page.on("console",m=>{if(m.type()==="error")report.errors.push(m.text());});
  await page.goto("http://127.0.0.1:4186/demos/14-integrated/next-renderer-showcase/");
  await page.waitForFunction(()=>!!globalThis.__eengineShowcase);await page.evaluate(()=>globalThis.__eengineShowcase.start());
  const capture=await page.evaluate(()=>globalThis.__eengineShowcase.capture({width:1920,height:1080,frames:45,warmup:20,coverage:"preset",distanceScale:0.885,retainView:true,surfaceMode:"detailed"}));
  const allocation=await page.evaluate(()=>globalThis.__eengineShowcase.allocation);
  report.captures.push({capacity:cap,capture,allocation});
  console.log(`CAPACITY ${cap}: ${capture.complete}; GPU ${capture.summary.gpuPassSumMs.p50.toFixed(2)} ms; wall ${capture.captureEndUnixMs-capture.captureStartUnixMs} ms / 45 frames; allocated ${allocation.accounting.totalBytes}`);
  if(!capture.complete)report.errors.push(...capture.issues);
  await page.evaluate(()=>globalThis.__eengineShowcase.dispose());await context.close();await browser.close();browser=undefined;
 }
}catch(error){report.errors.push(String(error));}
finally{clearInterval(timer);await pending;await browser?.close();await server.close();await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2));
 console.log(`Artifacts: ${out}`);if(report.errors.length){console.error(report.errors);process.exitCode=1;}}
