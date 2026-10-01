import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const root=resolve('.'),dir=resolve('.local/validation/surface-geometry');await mkdir(dir,{recursive:true});
const server=createServer(async(req,res)=>{
  try{const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="importmap">{"imports":{"gl-matrix":"/OEngine/node_modules/gl-matrix/esm/index.js"}}</script><title>EEngine shared vertices GPU diagnostic</title><h1>Actual selected geometry / Raster / HZB / winner execution</h1>');return;}
    const path=resolve(root,`.${pathname}`);if(!path.startsWith(root+sep)||!(/\.(js|mjs)$/.test(path)))throw new Error('Unsupported resource');
    res.setHeader('Content-Type','application/javascript');res.end(await readFile(path));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
const report={evidenceRole:'diagnostic',headless:false,passed:false};
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false,args:[],
    ignoreDefaultArgs:['--enable-unsafe-swiftshader','--no-sandbox','--unsafely-disable-devtools-self-xss-warnings']});
  report.browser=browser.version();const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  Object.assign(report,await page.evaluate(async()=>{
    const {runFrameVerticesFixture}=await import('/validation/labs/surface-geometry/frame-vertices-fixture.mjs');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter||adapter.info.isFallbackAdapter)throw new Error('Hardware WebGPU adapter required');
    const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}}),errors=[];let disposing=false,lost=null;
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));void device.lost.then(info=>{if(!disposing)lost={reason:info.reason,message:info.message};});
    try{const result=await runFrameVerticesFixture(device);if(errors.length||lost)throw new Error(JSON.stringify({errors,lost}));
      return {...result,apiErrors:errors,deviceLost:lost,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter}};
    }finally{disposing=true;device.destroy();}
  }));
}catch(error){report.passed=false;report.error=String(error.stack??error);throw error;}
finally{await writeFile(resolve(dir,'frame-vertices-chrome.json'),JSON.stringify(report,null,2));await browser?.close();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify(report,null,2));
