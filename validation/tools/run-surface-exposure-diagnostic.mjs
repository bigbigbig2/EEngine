import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root=process.cwd(), out=resolve(root,".local/validation/surface-v3-exposure-analysis");
await mkdir(out,{recursive:true});
let variant={name:"exposure-8",exposure:8};
const server=await createServer({configFile:resolve(root,"examples/vite.config.ts"),clearScreen:false,
 server:{host:"127.0.0.1",port:4184,strictPort:true},plugins:[{name:"surface-exposure-diagnostic",enforce:"pre",
 transform(code,id){
   const path=id.replaceAll("\\","/").split("?")[0];
   if(path.endsWith("next-renderer-showcase/main.ts")) return code.replace("fixedExposure: 8,",`fixedExposure: ${variant.exposure},`);
   if(path.endsWith("SurfaceLightingWorkPass.ts")&&variant.lambert) return code.replace("diffuse_env * material.diffuse * material.occlusion * ao","diffuse_env * material.diffuse * material.occlusion * ao / PI");
   if(path.endsWith("AerialPerspectivePass.ts")&&variant.noAerial) return code.replace("scene_color.rgb * transport.transmittance +", "scene_color.rgb + 0.0 *");
 }}]});
const report={evidenceRole:"diagnostic",accepted:false,errors:[],variants:[]};
let browser;
try{
 await server.listen();
 for(const config of [{name:"exposure-8",exposure:8},{name:"exposure-4",exposure:4},{name:"exposure-2",exposure:2},
   {name:"exposure-4-lambert",exposure:4,lambert:true},{name:"exposure-4-no-aerial",exposure:4,noAerial:true}]){
  variant=config;server.moduleGraph.invalidateAll();
  browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:false,
   ignoreDefaultArgs:["--enable-unsafe-swiftshader","--no-sandbox","--unsafely-disable-devtools-self-xss-warnings"]});
  const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
  const page=await context.newPage();page.on("pageerror",e=>report.errors.push({variant:config.name,error:String(e)}));
  page.on("console",m=>{if(m.type()==="error")report.errors.push({variant:config.name,error:m.text()});});
  await page.goto("http://127.0.0.1:4184/demos/14-integrated/next-renderer-showcase/");
  await page.waitForFunction(()=>!!globalThis.__eengineShowcase);
  await page.evaluate(()=>globalThis.__eengineShowcase.start());
  const begin=await page.evaluate(()=>globalThis.__eengineShowcase.runtime.frameCount);
  await page.waitForFunction(n=>globalThis.__eengineShowcase.runtime.frameCount>=n+30,begin,{timeout:120000});
  await page.screenshot({path:resolve(out,config.name+".png")});
  report.variants.push({...config,runtime:await page.evaluate(()=>globalThis.__eengineShowcase.runtime)});
  console.log(`EXPOSURE ${config.name}`);
  await page.evaluate(()=>globalThis.__eengineShowcase.dispose());
  await context.close();await browser.close();browser=undefined;
 }
}catch(error){report.errors.push(String(error));}
finally{await browser?.close();await server.close();await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2));
 console.log(`Artifacts: ${out}`);if(report.errors.length){console.error(report.errors);process.exitCode=1;}}
