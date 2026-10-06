import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(resolve('validation/package.json'))('playwright-core');
const {createServer}=await import('../../../OEngine/node_modules/vite/dist/node/index.js');
const fixture=process.argv[2]??'phase5-production';
if(!['phase7-unlit','phase6-lifecycle','phase5-production','phase5-demand','phase5-lighting','phase4-production','phase4-tree','phase3-record','phase3-proof','phase3-geometry','phase3-production','phase1-production','phase2-geometry','repair-step-one','repair-certificate','repair-field-lookup','repair-signal-lookup','repair-timing','repair-compile'].includes(fixture))throw new RangeError('Unknown GPU fixture');
const outputDirectory=process.argv[3]??'.local/validation/surface-optimization-v1';
const pollBudget=Number(process.argv[4]??30);
if(!Number.isSafeInteger(pollBudget)||pollBudget<1||pollBudget>90)throw new RangeError('GPU fixture host wait budget must be 1..90 ten-second polls');
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:5187,strictPort:true,hmr:false,watch:{ignored:['**']}},logLevel:'error'});
const logs=[],errors=[];let browser,context;
const startedAt=Date.now();
const deadline=startedAt+pollBudget*10000;
async function bounded(operation,label,maximum=5000) {
 let timer;
 const remaining=Math.min(maximum,deadline-Date.now());
 if(remaining<=0)throw new Error(`Host deadline exhausted at ${label}`);
 try {
  return await Promise.race([operation(),new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(new Error(`Host deadline at ${label} (${remaining} ms)`)),remaining);
  })]);
 } finally {clearTimeout(timer);}
}
try {
 await server.listen();
 const browserExecutable='C:/Program Files/Google/Chrome/Application/chrome.exe';
 browser=await chromium.launch({executablePath:browserExecutable,headless:true,args:['--enable-unsafe-webgpu']});
 context=await browser.newContext({viewport:{width:320,height:240},serviceWorkers:'block'});const page=await context.newPage();
 page.on('console',message=>{logs.push({type:message.type(),message:message.text(),elapsedMs:Date.now()-startedAt});console.log(message.text());});page.on('pageerror',error=>errors.push(error.message));
 const fixturePage=`${fixture}-browser.html`;
 await page.goto(`http://127.0.0.1:5187/validation/labs/surface-optimization-v1/${fixturePage}`,{waitUntil:'load'});
 let report;
 let lastSnapshot={stage:'module initialization'};
 try {
  for(let poll=0;poll<pollBudget&&Date.now()<deadline;poll++){
   try{await page.waitForFunction(()=>!!window.cellOracleResult,{},{timeout:Math.min(10000,deadline-Date.now())});}catch(error){if(error.name!=='TimeoutError')throw error;}
   lastSnapshot=await bounded(()=>page.evaluate(()=>({result:window.cellOracleResult,stage:window.cellOracleStage,progress:window.cellOracleProgress})),'reading fixture progress');
   report=lastSnapshot.result;if(report)break;
   console.log(`Waiting for ${lastSnapshot.stage??'module initialization'} (${Date.now()-startedAt} ms host elapsed)`);
  }
 } catch(error) {
  report={passed:false,evidenceRole:'diagnostic',failure:error.message,stage:lastSnapshot.stage,progress:lastSnapshot.progress};
 }
 if(!report){report={passed:false,evidenceRole:'diagnostic',failure:`Component oracle exceeded ${pollBudget*10000} ms host deadline`,stage:lastSnapshot.stage,progress:lastSnapshot.progress};}
 report.hostElapsedMs=Date.now()-startedAt;
 report.browser=browser.version();report.pageErrors=errors;report.logs=logs;
 report.capability=Date.now()>=deadline?null:await bounded(()=>page.evaluate(async()=>{
   const adapter=await navigator.gpu?.requestAdapter();if(!adapter)return null;
   const limits={};for(const key of Object.getOwnPropertyNames(Object.getPrototypeOf(adapter.limits))) {
     if(typeof adapter.limits[key]==='number')limits[key]=adapter.limits[key];
   }
   return {info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,
     description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},features:[...adapter.features],limits};
 }),'reading capability').catch(error=>({unavailable:error.message}));
 await mkdir(outputDirectory,{recursive:true});
 await writeFile(resolve(outputDirectory,`${fixture}-browser.json`),JSON.stringify(report,null,2));
 const code=Date.now()>=deadline?null:await bounded(()=>page.evaluate(()=>window.cellOracleSource),'reading shader source').catch(()=>null);if(code)await writeFile(resolve(outputDirectory,`${fixture}-browser.wgsl`),code);
 console.log(JSON.stringify({...report,logs:undefined,order:undefined}));assert.equal(report.passed,true,report.failure);assert.deepEqual(errors,[]);
}finally{await context?.close();await browser?.close();await server.close();}
