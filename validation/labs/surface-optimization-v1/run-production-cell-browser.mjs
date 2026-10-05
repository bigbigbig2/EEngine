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
try {
 await server.listen();
 const browserExecutable='C:/Program Files/Google/Chrome/Application/chrome.exe';
 browser=await chromium.launch({executablePath:browserExecutable,headless:true,args:['--enable-unsafe-webgpu']});
 context=await browser.newContext({viewport:{width:320,height:240},serviceWorkers:'block'});const page=await context.newPage();
 page.on('console',message=>{logs.push({type:message.type(),message:message.text()});console.log(message.text());});page.on('pageerror',error=>errors.push(error.message));
 const fixturePage=`${fixture}-browser.html`;
 await page.goto(`http://127.0.0.1:5187/validation/labs/surface-optimization-v1/${fixturePage}`,{waitUntil:'load'});
 let report;
 for(let poll=0;poll<pollBudget;poll++){
  try{await page.waitForFunction(()=>!!window.cellOracleResult,{},{timeout:10000});}catch(error){if(error.name!=='TimeoutError')throw error;}
  report=await page.evaluate(()=>window.cellOracleResult);if(report)break;
  console.log(`Waiting for ${await page.evaluate(()=>window.cellOracleStage??'module initialization')}`);
 }
 if(!report){report={passed:false,evidenceRole:'diagnostic',failure:`Component oracle exceeded ${pollBudget} x 10 second host waits`,stage:await page.evaluate(()=>window.cellOracleStage??'module initialization')};}
 report.browser=browser.version();report.pageErrors=errors;report.logs=logs;
 report.capability=await page.evaluate(async()=>{
   const adapter=await navigator.gpu?.requestAdapter();if(!adapter)return null;
   const limits={};for(const key of Object.getOwnPropertyNames(Object.getPrototypeOf(adapter.limits))) {
     if(typeof adapter.limits[key]==='number')limits[key]=adapter.limits[key];
   }
   return {info:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,
     description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},features:[...adapter.features],limits};
 });
 await mkdir(outputDirectory,{recursive:true});
 await writeFile(resolve(outputDirectory,`${fixture}-browser.json`),JSON.stringify(report,null,2));
 const code=await page.evaluate(()=>window.cellOracleSource);if(code)await writeFile(resolve(outputDirectory,`${fixture}-browser.wgsl`),code);
 console.log(JSON.stringify({...report,logs:undefined,order:undefined}));assert.equal(report.passed,true,report.failure);assert.deepEqual(errors,[]);
}finally{await context?.close();await browser?.close();await server.close();}
