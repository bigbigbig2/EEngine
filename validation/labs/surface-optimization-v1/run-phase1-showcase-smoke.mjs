import {chromium} from '../../node_modules/playwright-core/index.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const out=resolve(process.argv[2]??'.local/validation/surface-phase1-showcase');
await mkdir(out,{recursive:true});
const git=args=>execFileSync('git',args,{encoding:'utf8'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=git(['ls-files','--cached','--others','--exclude-standard','OEngine/src','examples/demos/14-integrated/next-renderer-showcase']).trim().split('\n');
const fingerprints={};for(const path of paths)fingerprints[path]=hash(await readFile(path));
await writeFile(resolve(out,'fingerprints.json'),JSON.stringify(fingerprints,null,2));
const diff=git(['diff','--binary','HEAD']);await writeFile(resolve(out,'source-diff.patch'),diff);
const report={evidenceRole:'diagnostic',accepted:false,passed:false,revision:git(['rev-parse','HEAD']).trim(),dirty:git(['status','--short']),
  sourceFingerprintSha256:hash(JSON.stringify(fingerprints)),errors:[],progress:[],startedAt:new Date().toISOString()};
let browser,page;
const save=()=>writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
const state=()=>page.evaluate(()=>({ready:globalThis.__eengineShowcase?.ready,failed:globalThis.__eengineShowcase?.failed,runtime:globalThis.__eengineShowcase?.runtime}));
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--enable-unsafe-webgpu','--ignore-gpu-blocklist'],ignoreDefaultArgs:['--enable-unsafe-swiftshader']});
  report.browser=browser.version();page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('Failed to load resource'))report.errors.push(message.text());});
  await page.route('**/@vite/client',async route=>{const response=await route.fetch();const body=(await response.text()).replace('transport.connect(createHMRHandler(handleMessage));','/* Phase 1 isolated smoke: HMR disabled. */');await route.fulfill({response,body});});
  await page.goto('http://localhost:5173/demos/14-integrated/next-renderer-showcase/',{waitUntil:'domcontentloaded'});
  await page.locator('#start-scene').click();
  const began=Date.now();
  for(;;){
    const current=await state();report.progress.push(current);await save();console.log(JSON.stringify(current));
    if(current.failed)throw new Error('Showcase failed during initialization');
    if(current.ready)break;
    if(Date.now()-began>900000)throw new Error('Showcase initialization exceeded 15 minutes');
    await page.waitForTimeout(5000);
  }
  await page.evaluate(()=>globalThis.__eengineShowcase.pause());
  const request={width:1920,height:1080,frames:3,warmup:2,view:'overview',profile:'full',coverage:'preset',distanceScale:1,
    lockCamera:true,counters:false,surfaceMode:'timing',retainView:true,trajectory:'static',vsm:false};
  for(const [name,config] of [['timing',request],['detailed',{...request,frames:1,warmup:1,counters:true,surfaceMode:'detailed'}]]){
    console.log(`Starting ${name}`);
    await page.evaluate(({name,config})=>{
      globalThis.__phase1Capture={name};void globalThis.__eengineShowcase.capture(config).then(result=>globalThis.__phase1Capture={name,result},error=>globalThis.__phase1Capture={name,error:String(error)});
    },{name,config});
    for(;;){
      await page.waitForTimeout(3000);
      const status=await page.evaluate(()=>globalThis.__phase1Capture);
      if(status.error)throw new Error(status.error);
      if(status.result){
        const result=status.result;await writeFile(resolve(out,`${name}.json`),JSON.stringify(result,null,2));
        report[name]={complete:result.complete,issues:result.issues,summary:result.summary,conditions:result.conditions};
        if(!result.complete)throw new Error(`${name}: incomplete GPU capture`);
        break;
      }
      console.log(JSON.stringify(await state()));
    }
    await page.evaluate(()=>globalThis.__eengineShowcase.pause());
  }
  await page.screenshot({path:resolve(out,'overview.png')});
  report.final=await state();report.sourceDrift=git(['diff','--binary','HEAD'])!==diff;
  const diagnostics=report.final.runtime.diagnostics;
  report.passed=!report.sourceDrift&&report.errors.length===0&&['validationErrorCount','uncapturedErrorCount','deviceLostCount','failedGpuTimestampBatches','failedGpuCounterSamples'].every(key=>diagnostics[key]===0);
}catch(error){report.errors.push(error.stack??String(error));console.error(String(error));}
finally{
  report.finishedAt=new Date().toISOString();await save();await browser?.close();
  console.log(JSON.stringify({out,passed:report.passed,errors:report.errors.slice(-3),timing:report.timing,detailed:report.detailed}));
  process.exitCode=report.passed?0:1;
}
