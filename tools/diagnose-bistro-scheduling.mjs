import { chromium } from "../validation/node_modules/playwright-core/index.mjs";
import { launchChrome } from "./gpu-oracle/browser.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transform } from "../examples/node_modules/esbuild/lib/main.js";
const execFileAsync = promisify(execFile),
  driver = [];
const name = process.argv[2] ?? "diagnostic";
if (!/^[a-z0-9-]+$/.test(name)) throw Error("Use a plain diagnostic run name");
const options = new Set(process.argv.slice(3));
if ([...options].some((option) => !["--window", "--owner-baseline", "--gpu-details"].includes(option))) {
  throw Error("Options: --window, --owner-baseline, --gpu-details");
}
const windowed = options.has("--window");
const ownerBaseline = options.has("--owner-baseline");
const output = new URL("../.local/bistro-texture-compression/", import.meta.url);
await mkdir(output, { recursive: true });
const run = await launchChrome({
  chromium,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: !windowed,
  extraArgs: [
    "--enable-unsafe-webgpu",
    ...(windowed ? ["--window-position=-32000,-32000", "--disable-backgrounding-occluded-windows"] : [])
  ]
});
let driverPending = false;
const driverTimer = setInterval(async () => {
  if (driverPending) return;
  driverPending = true;
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=memory.used,utilization.gpu,utilization.memory",
      "--format=csv,noheader,nounits"
    ]);
    driver.push({ atMs: Date.now(), values: stdout.trim() });
  } catch (error) {
    driver.push({ atMs: Date.now(), unavailable: String(error) });
  } finally {
    driverPending = false;
  }
}, 1000);
const { page } = run,
  errors = [],
  samples = [];
try {
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // Diagnostic-only source A/B: Vite continues serving the actual production
  // module URLs. No alternative implementation is added to the renderer.
  if (ownerBaseline) {
    for (const path of ["gpu/GpuNativeMaterialScene.ts", "render/surface/SurfaceV4.ts"]) {
      const { stdout } = await execFileAsync("git", ["show", `57f1499a:OEngine/src/${path}`]);
      const { code } = await transform(stdout, { loader: "ts", format: "esm", target: "es2022" });
      const body = code.replace(/(from\s+["'][^"']+)\.js(["'])/g, "$1.ts$2");
      await page.route(`**/OEngine/src/${path}*`, (route) =>
        route.fulfill({ contentType: "text/javascript", body })
      );
    }
  }
  await page.route("**/demos/14-integrated/bistro-texture-compression/main.ts*", async (route) => {
    const response = await route.fetch(),
      source = await response.text();
    const needle = "Object.assign(window, { bistroDemo: { report, release } });";
    if (!source.includes(needle)) throw Error("Missing probe target");
    const hook = `${needle}
 let probeOrigin=null, probeMotion=false, probeStart=0;
 const probeTick=now=>{
  if(probeMotion&&controls){
   const angle=0.15*(now-probeStart)/1000, x=probeOrigin[0]-controls.target.x,z=probeOrigin[2]-controls.target.z;
   camera.transform.position.set(controls.target.x+x*Math.cos(angle)+z*Math.sin(angle),probeOrigin[1],controls.target.z+z*Math.cos(angle)-x*Math.sin(angle));
   camera.transform.lookAt(controls.target);
  }
  if(!closing)requestAnimationFrame(probeTick);
 };
 requestAnimationFrame(probeTick);
 window.scheduleProbe={
  ready(){window.surfaceBuilds=0;const surface=renderer._surface,create=surface.createState.bind(surface);surface.createState=(...args)=>{window.surfaceBuilds++;return create(...args);};controls.enableDamping=false;probeOrigin=[camera.transform.position.x,camera.transform.position.y,camera.transform.position.z];const target=controls.target;camera.transform.position.set(target.x+(probeOrigin[0]-target.x)*0.3,target.y+(probeOrigin[1]-target.y)*0.3,target.z+(probeOrigin[2]-target.z)*0.3);camera.transform.lookAt(target);controls.update();probeOrigin=[camera.transform.position.x,camera.transform.position.y,camera.transform.position.z];},
  configure({limit,moving,profile,effects,hzb=true,late=false,wake=true}){
   probeMotion=false;camera.transform.position.set(...probeOrigin);camera.transform.lookAt(controls.target);controls.update();
   renderer.maxFramesInFlight=limit;renderer.packed_visibility_hzb_enabled=hzb;renderer.packed_visibility_current_hzb_late_recheck_enabled=late;
   renderer.onFrameAvailable.silent=!wake;
   renderer.fsr3_enabled=effects!=="off";renderer.temporal_jitter_enabled=effects!=="off";renderer.vsm_enabled=false;renderer.xe_gtao_enabled=false;renderer.bloom_enabled=false;
   profiled=profile;renderer.perf_gpu_counters_enabled=profile;
   if(profile)renderer.profiler.setMode("record");
   renderer.profiler.configure({enabled:profile,gpuTimingMode:profile?"full":"production",gpuSampleInterval:1,gpuCounterSampleInterval:4,historyCapacity:1024,warmupFrames:0,cpuPassTimings:profile});
   renderer.profiler.clear();resetFrameSamples();probeStart=performance.now();probeMotion=moving;
  },
  startCapture(){renderer.profiler.configure({gpuTimingMode:"full"});},
  sample(){return {report:report(),history:renderer.profiler.history,surfaceBuilds:window.surfaceBuilds};}
 };`;
    await route.fulfill({ response, body: source.replace(needle, hook) });
  });
  async function capture(config) {
    await page.evaluate((config) => window.scheduleProbe.configure(config), config);
    await page.waitForTimeout(1500);
    const beforeSample = await page.evaluate(() => window.scheduleProbe.sample()),
      before = beforeSample.report,
      atMs = Date.now();
    if (config.profile) await page.evaluate(() => window.scheduleProbe.startCapture());
    await page.waitForTimeout(5000);
    const data = await page.evaluate(() => window.scheduleProbe.sample());
    const row = {
      ...config,
      atMs,
      endMs: Date.now(),
      before,
      ...data,
      surfaceBuildDelta: data.surfaceBuilds - beforeSample.surfaceBuilds,
      history: data.history.filter((f) => f.frameIndex >= before.renderState.frame)
    };
    samples.push(row);
    const stable = data.report.stable;
    console.log(
      JSON.stringify({
        name,
        ...config,
        fps: stable.submissions.framesPerSecond,
        cpu: stable.normal.cpuFrameMs ?? stable.profiled.cpuFrameMs,
        completion: stable.completionLatencyMs,
        deferrals:
          data.report.stable.submission.completionDeferredTicks -
          before.stable.submission.completionDeferredTicks,
        historyDeferrals:
          data.report.stable.submission.historyDeferredTicks - before.stable.submission.historyDeferredTicks,
        errors
      })
    );
    if (errors.length) throw Error(errors.join(String.fromCharCode(10)));
    await writeFile(
      new URL(`scheduling-${name}-progress.json`, output),
      JSON.stringify({ name, errors, samples }, null, 2)
    );
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("http://127.0.0.1:5174/demos/14-integrated/bistro-texture-compression/?mode=cooked");
  await page.waitForFunction(
    () =>
      window.bistroDemo &&
      (window.bistroDemo.report().load.fullQualityMs !== null || window.bistroDemo.report().failure),
    undefined,
    { timeout: 180000 }
  );
  if (await page.evaluate(() => !!window.bistroDemo.report().failure)) throw Error("Bistro load failed");
  await page.evaluate(() => window.scheduleProbe.ready());
  await page.waitForTimeout(6000);
  if (ownerBaseline) {
    for (const width of [1920, 2560]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1440 });
      for (const moving of [false, true])
        for (const profile of [false, true])
          await capture({ width, limit: 2, moving, profile, effects: "default", wake: false });
    }
  } else if (options.has("--gpu-details")) {
    for (const width of [1920, 2560]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1440 });
      for (const effects of ["default", "off"])
        await capture({ width, limit: 2, moving: true, profile: true, effects, wake: false });
    }
  } else {
    for (const width of [1920, 2560]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1440 });
      for (const effects of ["default", "off"]) {
        for (const moving of effects === "default" ? [false, true] : [true]) {
          for (const profile of effects === "default" ? [false, true] : [false]) {
            for (const limit of [2, 3])
              await capture({ width, limit, moving, profile, effects, wake: false });
          }
        }
      }
      for (const moving of [false, true])
        await capture({ width, limit: 2, moving, profile: false, effects: "default", wake: true });
      for (const hzb of [false, true])
        await capture({ width, limit: 2, moving: true, profile: true, effects: "default", hzb, wake: false });
    }
  }
  await page.evaluate(() => window.bistroDemo.release());
  const release = await page.evaluate(() => window.bistroDemo.report().teardown);
  const rafOnly = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const samples = [];
        const begin = performance.now();
        let previous = null;
        const tick = (now) => {
          if (previous !== null) samples.push(now - previous);
          previous = now;
          if (now - begin < 3000) requestAnimationFrame(tick);
          else resolve(samples);
        };
        requestAnimationFrame(tick);
      })
  );
  await writeFile(
    new URL(`scheduling-${name}.json`, output),
    JSON.stringify(
      {
        name,
        chrome: run.chromeVersion,
        headless: !windowed,
        ownerBaselineRevision: ownerBaseline ? "57f1499a" : null,
        errors,
        samples,
        driver,
        release,
        rafOnly
      },
      null,
      2
    )
  );
  if (errors.length || !release.textureOwnerZero || release.geometry.totalBytes)
    throw Error("Errors or owner leak");
} finally {
  clearInterval(driverTimer);
  await run.close();
}
