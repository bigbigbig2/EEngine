import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(resolve('validation/package.json'))('playwright-core');
const {createServer}=await import('../../../OEngine/node_modules/vite/dist/node/index.js');
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:5187,strictPort:true},logLevel:'error'});
const logs=[],errors=[];let browser,context;
try {
 await server.listen();browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-webgpu']});
 context=await browser.newContext({viewport:{width:320,height:240},serviceWorkers:'block'});const page=await context.newPage();
 page.on('console',message=>{logs.push({type:message.type(),message:message.text()});console.log(message.text());});page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:5187/validation/labs/surface-optimization-v1/production-cell-browser.html',{waitUntil:'load'});
 let report;
 for(let poll=0;poll<30;poll++){
  try{await page.waitForFunction(()=>!!window.cellOracleResult,{},{timeout:10000});}catch(error){if(error.name!=='TimeoutError')throw error;}
  report=await page.evaluate(()=>window.cellOracleResult);if(report)break;
  console.log(`Waiting for ${await page.evaluate(()=>window.cellOracleStage??'module initialization')}`);
 }
 assert.ok(report,'Component oracle timed out');report.browser=browser.version();report.pageErrors=errors;report.logs=logs;
 await mkdir('.local/validation/surface-optimization-v1',{recursive:true});
 await writeFile('.local/validation/surface-optimization-v1/production-cell-browser.json',JSON.stringify(report,null,2));
 const code=await page.evaluate(()=>window.cellOracleSource);if(code)await writeFile('.local/validation/surface-optimization-v1/production-cell-browser.wgsl',code);
 console.log(JSON.stringify({...report,logs:undefined}));assert.equal(report.passed,true,report.failure);assert.deepEqual(errors,[]);
}finally{await context?.close();await browser?.close();await server.close();}
