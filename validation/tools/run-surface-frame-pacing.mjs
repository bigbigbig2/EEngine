import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const run = promisify(execFile), root = process.cwd();
const out = resolve(root, process.argv[2] ?? ".local/validation/surface-v3-frame-pacing");
await mkdir(out, { recursive: true });
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"), clearScreen: false,
  server: { host: "127.0.0.1", port: 4183, strictPort: true } });
const report = { evidenceRole: "diagnostic", accepted: false, errors: [], samples: [], captures: [] };
let browser, timer, stage = "startup", pending = Promise.resolve(), busy = false;
async function sensor() {
  if (busy) return; busy = true;
  try { const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.used,temperature.gpu,utilization.gpu,clocks.current.graphics,clocks_event_reasons.sw_thermal_slowdown", "--format=csv,noheader,nounits"], { windowsHide: true });
    report.samples.push({ time: Date.now(), stage, values: stdout.trim() });
  } finally { busy = false; }
}
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: false,
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", msg => { if (msg.type() === "error") report.errors.push(msg.text()); });
  timer = setInterval(() => { pending = sensor().catch(error => report.errors.push(String(error))); }, 1000);
  await page.goto("http://127.0.0.1:4183/demos/14-integrated/next-renderer-showcase/");
  await page.waitForFunction(() => !!globalThis.__eengineShowcase);
  await page.evaluate(() => globalThis.__eengineShowcase.start());
  await page.evaluate(() => globalThis.__eengineShowcase.capture({ width: 1920, height: 1080, frames: 1,
    warmup: 5, coverage: "preset", distanceScale: 0.885, retainView: true }));
  if (process.argv.includes("--rotate")) {
    await page.locator("#panel-toggle").click();
    await page.getByText("自动旋转", { exact: true }).click();
    await page.locator("#panel-toggle").click();
    report.motion = "continuous auto rotation";
  }
  for (const profiling of [false, true]) {
    stage = profiling ? "profiling-on" : "profiling-off";
    if (profiling) {
      await page.locator("#panel-toggle").click();
      await page.getByText("实时诊断", { exact: true }).click();
      await page.getByText("GPU 采样", { exact: true }).click();
      await page.locator("#panel-toggle").click();
    }
    const result = await page.evaluate(async () => {
      const api = globalThis.__eengineShowcase;
      const start = api.runtime.frameCount, times = [];
      let last = start;
      while (api.runtime.frameCount < start + 45) {
        await new Promise(requestAnimationFrame);
        if (api.runtime.frameCount !== last) { times.push(performance.now()); last = api.runtime.frameCount; }
      }
      const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a,b) => a-b);
      return { p50: intervals[Math.ceil(intervals.length*.5)-1], p95: intervals[Math.ceil(intervals.length*.95)-1],
        elapsed: times.at(-1)-times[0], intervals, runtime: api.runtime,
        profiles: api.profiles.filter(f => f.gpu.sampled && !f.gpu.pending).slice(-20) };
    });
    report.captures.push({ stage, ...result });
    console.log(`${stage}: frame interval P50 ${result.p50.toFixed(2)} / P95 ${result.p95.toFixed(2)} ms`);
  }
  await page.evaluate(() => globalThis.__eengineShowcase.dispose());
  await context.close();
} catch (error) { report.errors.push(String(error)); }
finally {
  clearInterval(timer); await pending;
  await browser?.close(); await server.close();
  await writeFile(resolve(out, "report.json"), JSON.stringify(report,null,2));
  console.log(`Artifacts: ${out}`);
  if (report.errors.length) { console.error(report.errors); process.exitCode=1; }
}
