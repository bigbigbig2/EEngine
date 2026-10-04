import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replaceAll(/[^0-9]/g,'');
const out=resolve(process.argv[2]??`.local/validation/showcase-5173-surface-repair-${stamp}`);
const url='http://localhost:5173/demos/14-integrated/next-renderer-showcase/';
await mkdir(out,{recursive:false});
await mkdir(resolve(out,"shaders"));
const git=args=>execFileSync('git',args,{encoding:'utf8'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const diff=git(['diff','--binary','HEAD']);await writeFile(resolve(out,'source-diff.patch'),diff);
const paths=git(['ls-files','OEngine/src','examples/demos/14-integrated/next-renderer-showcase']).trim().split('\n');
const fingerprints={};for(const path of paths)fingerprints[path]=hash(await readFile(path));
await writeFile(resolve(out,'source-fingerprints.json'),JSON.stringify(fingerprints,null,2));
const asset=hash(await readFile('examples/assets/three/rendering-lab/dungeon_warkarma.glb'));
const report={url,out,evidenceRole:'diagnostic',accepted:false,startedAt:new Date().toISOString(),revision:git(['rev-parse','HEAD']).trim(),dirty:git(['status','--short']),diffSha256:hash(diff),sourceFingerprintSha256:hash(JSON.stringify(fingerprints)),assetSha256:asset,
 viewport:[1920,1080],deviceScaleFactor:1,errors:[],shots:[],progress:[],thermalState:'unknown',driver:'unknown'};
const runnerSource=await readFile(new URL(import.meta.url));
report.runnerSha256=hash(runnerSource);
await writeFile(resolve(out,'runner-snapshot.mjs'),runnerSource);
let browser,page;
const loadedSources=[];
let sourceSaves=Promise.resolve();
let shaderCount=0;
const thermal=()=>{try {return execFileSync('nvidia-smi',['--query-gpu=name,driver_version,temperature.gpu,utilization.gpu,clocks.gr,clocks.mem,power.draw','--format=csv,noheader'],{encoding:'utf8'}).trim();}catch{return 'unknown';}};
report.gpuTelemetryStart=thermal();
let saves=Promise.resolve();const save=()=>{const bytes=JSON.stringify(report,null,2);saves=saves.then(()=>writeFile(resolve(out,'report.json'),bytes));return saves;};
const bounded=async(promise,milliseconds)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Host operation exceeded ${milliseconds} ms`)),milliseconds);})]);}finally{clearTimeout(timer);}};
const state=()=>bounded(page.evaluate(()=>({ready:globalThis.__eengineShowcase?.ready,failed:globalThis.__eengineShowcase?.failed,runtime:globalThis.__eengineShowcase?.runtime,scene:document.querySelector('#scene-state')?.textContent,benchmark:document.querySelector('#benchmark-state')?.textContent})),20000);
async function shot(name,snapshot){
 const status=await state().catch(error=>({error:String(error)}));
 await page.screenshot({path:resolve(out,`${name}.png`),timeout:20000});
 snapshot??=await bounded(page.evaluate(()=>globalThis.__eengineShowcase?.snapshot),20000);
 report.shots.push({file:`${name}.png`,...snapshot,scene:status.scene});await save();
}
async function capture(name,request,deadlineSeconds=900){
 report[`${name}Request`]=request;await save();
 await bounded(page.evaluate(({name,request})=>{
  globalThis.__repairCaptures??={};globalThis.__repairCaptures[name]={state:'running'};
  void globalThis.__eengineShowcase.capture(request).then(result=>{globalThis.__repairCaptures[name]={state:'complete',result};},error=>{globalThis.__repairCaptures[name]={state:'failed',error:String(error)};});
 },{name,request}),20000);
 const begin=Date.now();
 while(Date.now()-begin<deadlineSeconds*1000){
  await page.waitForTimeout(3000);
  const status=await bounded(page.evaluate(name=>({state:globalThis.__repairCaptures[name]?.state,error:globalThis.__repairCaptures[name]?.error}),name),20000);
  const runtime=await state();report.progress.push({at:new Date().toISOString(),phase:name,status,...runtime});await save();
  if(runtime.failed)throw new Error('Showcase rendering failed during '+name);
  console.log(JSON.stringify({phase:name,frame:runtime.runtime?.frameCount,status,benchmark:runtime.benchmark}));
  if(status.state==='failed')throw new Error(`${name}: ${status.error}`);
  if(status.state==='complete'){
   const result=await bounded(page.evaluate(name=>globalThis.__repairCaptures[name].result,name),20000);
   await writeFile(resolve(out,name==='timing'?'capture.json':`${name}-capture.json`),JSON.stringify(result,null,2));
   report[name]={complete:result.complete,issues:result.issues,summary:result.summary,conditions:result.conditions};
   if(name==='detailed')await writeFile(resolve(out,'detailed-counters.json'),JSON.stringify({
    complete:result.complete,issues:result.issues,
    unavailable:['classifier candidate tests','certificate/query/reuse counts (workspace counters not exported by snapshot)','actual lookup/read traffic bytes','measured GPU allocation bytes','light/shadow/environment loop counts (not wired into snapshot)'],
    frames:result.frames.map(frame=>({frameIndex:frame.frameIndex,surfaceDiagnostics:frame.surfaceDiagnostics,gpuCounters:frame.gpuCounters}))
   },null,2));
   if(!result.complete)throw new Error(`${name}: incomplete actual GPU samples`);
   return result;
  }
 }
 throw new Error(`${name}: bounded capture exceeded ${deadlineSeconds} seconds`);
}
try{
 if(asset!=='cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1')throw new Error('Dungeon fingerprint differs from pinned scene');
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist'],ignoreDefaultArgs:['--enable-unsafe-swiftshader']});
 report.browser=browser.version();page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 // Only this diagnostic Document suppresses HMR; the user's server stays intact.
 await page.route('**/@vite/client',async route=>{
  const response=await route.fetch();
  // Keep Vite's worker URL/style exports. Disable only the websocket connection.
  const original=await response.text();
  const connection='transport.connect(createHMRHandler(handleMessage));';
  if(!original.includes(connection))throw new Error('Vite HMR connection shape changed');
  const client=original.replace(connection,'/* Diagnostic Document: no HMR connection. */');
  await route.fulfill({response,body:client});
 });
 await page.exposeFunction('__repairSaveShader',async(label,code)=>{
  const file=`shaders/${String(shaderCount++).padStart(3,'0')}.wgsl`;
  await writeFile(resolve(out,file),code);
  report.shaders??=[];report.shaders.push({file,label,sha256:hash(code)});await save();
 });
 await page.exposeFunction('__repairTrajectoryShot',async snapshot=>{
  if(!snapshot.benchmark?.startsWith('采集'))return;
  await shot(`03-orbit-${String(snapshot.trajectoryFrame).padStart(2,'0')}`,snapshot);
 });
 page.on('response',response=>{
  if(!/\.ts(?:\?|$)/.test(response.url()))return;
  sourceSaves=sourceSaves.then(async()=>{
   const code=await response.text();
   const map=/sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(code);
   if(!map)return;
   const data=JSON.parse(Buffer.from(map[1],'base64').toString());
   for(let index=0;index<(data.sourcesContent?.length??0);index++){
    const source=data.sourcesContent[index];
    if(source==null)continue;
    const pathname=decodeURIComponent(new URL(response.url()).pathname);
    const local=pathname.startsWith('/@fs/')?pathname.slice(5):resolve('examples','.'+pathname);
    let localHash;try{localHash=hash(await readFile(local));}catch{continue;}
    loadedSources.push({url:response.url(),local,sha256:hash(source),matchesDisk:hash(source)===localHash});
   }
  }).catch(error=>report.errors.push('module freshness: '+error));
 });
 page.on('console',message=>{const value=message.text();if(message.type()==='error'&&!value.includes('404 (Not Found)')){report.errors.push(value);void save();}if(value.startsWith('SURFACE_COMPILED')) {report.compiledPipelines??=[];report.compiledPipelines.push(JSON.parse(value.slice('SURFACE_COMPILED '.length)));void save();} if(value.startsWith('SURFACE_PIPELINE')) {report.pipelineInitialization??=[];report.pipelineInitialization.push(JSON.parse(value.slice('SURFACE_PIPELINE '.length)));void save();} if(value.startsWith('SURFACE_')||message.type()==='error')console.log(value.slice(0,2000));});
 page.on('pageerror',error=>{report.errors.push(String(error));console.log(String(error));void save();});
 await page.addInitScript(()=>{globalThis.__surfaceDiagnostic={vsm:false,prepare:async renderer=>{
  const device=renderer.device;
  const shaders=new WeakMap();globalThis.__repairCompilation=[];
  const module=device.createShaderModule.bind(device);
  device.createShaderModule=descriptor=>{const result=module(descriptor);shaders.set(result,{label:descriptor.label,bytes:descriptor.code.length});void globalThis.__repairSaveShader(descriptor.label,descriptor.code);
    void result.getCompilationInfo().then(info=>{for(const message of info.messages)if(message.type==='error')console.error(`WGSL ${descriptor.label} ${message.lineNum}:${message.linePos} ${message.message}`);});return result;};
  const pipeline=device.createComputePipeline.bind(device);
  const asyncPipeline=device.createComputePipelineAsync.bind(device);
  device.createComputePipeline=descriptor=>{
   const event={label:descriptor.label,entryPoint:descriptor.compute.entryPoint,source:shaders.get(descriptor.compute.module),begin:performance.now()};
   globalThis.__repairCompilation.push(event);
   console.info(`SURFACE_PIPELINE ${JSON.stringify(event)}`);
   const result=pipeline(descriptor);event.returned=performance.now();
   console.info(`SURFACE_PIPELINE ${JSON.stringify(event)}`);
   void asyncPipeline(descriptor).then(()=>console.info(`SURFACE_COMPILED ${JSON.stringify({...event,ready:performance.now()})}`),error=>console.error(`Pipeline ${descriptor.label}: ${error}`));return result;
  };
 }};});
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
 report.servedModules=await page.locator('script[type=module]').evaluateAll(nodes=>nodes.map(node=>node.src));
 await page.locator('#start-scene').click();
 const begin=Date.now();let ready=false;
 while(Date.now()-begin<900000){
  await page.waitForTimeout(3000);
  const status=await state().catch(error=>({hostPending:String(error)}));
  report.progress.push({at:new Date().toISOString(),phase:'startup',...status});await save();
  console.log(JSON.stringify({phase:'startup',frame:status.runtime?.frameCount,ready:status.ready,failed:status.failed,scene:status.scene,hostPending:status.hostPending}));
  if(status.failed)throw new Error('Showcase startup/render failed');
  if(report.errors.length)throw new Error('Showcase startup reported a browser error');
  if(page.isClosed())throw new Error('Diagnostic page closed during startup');
  if(status.ready&&(status.runtime?.frameCount??0)>=5){ready=true;break;}
 }
 if(!ready)throw new Error('No completed startup within finite 900-second budget');
 report.adapter=await page.evaluate(()=>globalThis.__eengineShowcase.adapter);
 if(/swiftshader|software|llvmpipe/i.test(JSON.stringify(report.adapter)))throw new Error('Software fallback adapter');
 await sourceSaves;report.loadedSources=loadedSources;
 if(!loadedSources.length||loadedSources.some(source=>!source.matchesDisk))throw new Error('Served source does not match frozen working tree');
 await bounded(page.evaluate(()=>globalThis.__eengineShowcase.pause()),30000);
 report.pipelineInitialization=await page.evaluate(()=>globalThis.__repairCompilation??[]);
 await shot('00-default-camera');
 const request={width:1920,height:1080,frames:30,warmup:8,view:'overview',profile:'full',coverage:'preset',distanceScale:1,lockCamera:true,counters:false,surfaceMode:'timing',retainView:true,trajectory:'static',vsm:false};
 const timing=await capture('timing',request);
 await writeFile(resolve(out,'performance-summary.json'),JSON.stringify(timing.summary,null,2));
 await writeFile(resolve(out,'profiles.json'),JSON.stringify(timing.frames,null,2));
 await bounded(page.evaluate(()=>globalThis.__eengineShowcase.pause()),30000);
 await shot('01-overview');
 for(let frame=0;frame<3;frame++){const snapshot=await bounded(page.evaluate(()=>globalThis.__eengineShowcase.stepFrames()),30000);await shot(`02-overview-static-${frame}`,snapshot);}
 const detailed=await capture('detailed',{...request,frames:3,warmup:2,counters:true,surfaceMode:'detailed'});
 // A separate movement capture retains its own request/frames and never enters
 // the static timing distribution. Snapshot independently while it runs.
 await page.evaluate(()=>{globalThis.__surfaceDiagnostic.onTrajectoryFrame=snapshot=>globalThis.__repairTrajectoryShot(snapshot);});
 const movement=capture('movement',{...request,frames:12,warmup:2,trajectory:'orbit-return'});
 await movement;
 await page.evaluate(()=>{delete globalThis.__surfaceDiagnostic.onTrajectoryFrame;});
 await bounded(page.evaluate(()=>globalThis.__eengineShowcase.pause()),30000);await shot('04-return');
 await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(100);
 await bounded(page.evaluate(()=>globalThis.__eengineShowcase.stepFrames(3)),120000);await shot('05-resize');
 await page.setViewportSize({width:1920,height:1080});await page.waitForTimeout(100);
 await bounded(page.evaluate(()=>globalThis.__eengineShowcase.stepFrames(3)),120000);await shot('06-resize-return');
 report.final=await state();report.gpuTelemetryEnd=thermal();
 await sourceSaves;report.loadedSources=loadedSources;
 const endDiff=git(['diff','--binary','HEAD']);report.sourceDrift=endDiff!==diff;
 if(report.sourceDrift)throw new Error('Tracked source changed during sampling');
 const diagnostics=report.final.runtime.diagnostics;
 report.complete=['validationErrorCount','uncapturedErrorCount','deviceLostCount','failedGpuTimestampBatches','failedGpuCounterSamples'].every(key=>diagnostics[key]===0)&&report.errors.length===0&&report.timing.complete&&report.detailed.complete&&report.movement.complete;
}catch(error){
 report.errors.push(String(error));console.error(String(error));
 if(page){report.final=await state().catch(error=>({error:String(error)}));report.pipelineInitialization=await bounded(page.evaluate(()=>globalThis.__repairCompilation??[]),15000).catch(()=>[]);await shot('failure').catch(error=>report.errors.push(`screenshot: ${error}`));
  const profiles=await bounded(page.evaluate(()=>globalThis.__eengineShowcase?.profiles??[]),15000).catch(()=>[]);await writeFile(resolve(out,'diagnostic-profiles.json'),JSON.stringify(profiles,null,2));}
}finally{
 report.finishedAt=new Date().toISOString();report.loadedSources=loadedSources;await save();
 const summary=[`# Surface V3 Showcase 第五步诊断`, ``,
  `完成：${Boolean(report.complete)}；正式 evidence accepted=false。`,
  `HEAD：${report.revision}；dirty 与 diff/fingerprints 见 report.json/source-diff.patch。`,
  `资产 SHA256：${asset}。浏览器：${report.browser??'unknown'}；adapter：${JSON.stringify(report.adapter??'unknown')}。`,
  `热状态起点：${report.gpuTelemetryStart}；终点：${report.gpuTelemetryEnd??'unknown'}。`,
  ``, `timing：${JSON.stringify(report.timing??'未完成')}。`,
  `detailed：${JSON.stringify(report.detailed??'未完成')}。`,
  `movement：${JSON.stringify(report.movement??'未完成')}。`,
  ``, `错误：${JSON.stringify(report.errors)}。`,
  ``, ...report.shots.map(shot=>`- [${shot.file}](${shot.file})：submitted frame ${shot.submittedFrame}；output ${shot.output}；相机见 report.json。`),
  ``, `旧报告只有预热/准备 23 帧，非相同正式测量范围；不报告严格提升倍数。完整 Phase 7/四版本/矩阵验收未运行，来源与 claims 未提升。`];
 await writeFile(resolve(out,'summary.md'),summary.join('\n'));
 await bounded(browser?.close()??Promise.resolve(),10000).catch(()=>{});
 console.log(JSON.stringify({out,accepted:report.accepted,errors:report.errors.slice(-4),shots:report.shots}));
 process.exitCode=report.complete?0:1;
}
