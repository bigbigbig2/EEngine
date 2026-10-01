import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { sensitivityModes } from "../labs/surface-performance/ShaderSensitivity.mjs";
import { prewarmSurfaceOwner, prewarmRendererRoot } from "../labs/surface-performance/PipelinePrewarm.mjs";

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; }
const frames = Number(option("frames", "120")), warmup = Number(option("warmup", "60"));
const batches = Number(option("batches", "2")), width = Number(option("width", "1280")), height = Number(option("height", "720"));
const modes = option("modes", sensitivityModes.join(",")).split(",");
const asyncPrewarm = args.includes("--async-prewarm");
if (modes.some(mode => !sensitivityModes.includes(mode))) throw new Error("Unknown --modes");
const coverageGroups = option("coverage", "low,high").split(",");
if (!coverageGroups.length || coverageGroups.some(group => !["low", "high"].includes(group)) || new Set(coverageGroups).size !== coverageGroups.length) throw new Error("Invalid --coverage; use low,high");
for (const [name, value] of Object.entries({ frames, batches, width, height, warmup })) {
  if (!Number.isSafeInteger(value) || value < (name === "warmup" ? 0 : 1) || value > 8192) throw new Error(`Invalid --${name}`);
}
const out = resolve(root, option("out", `.local/validation/surface-performance-${new Date().toISOString().replace(/[:.]/g, "-")}`));
await mkdir(out, { recursive: true });
const revision = execFileSync("git", ["-c", "core.commitGraph=false", "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirtyPaths = execFileSync("git", ["-c", "core.commitGraph=false", "status", "--short"], { cwd: root, encoding: "utf8" }).trim();
const fixture = resolve(root, "examples/assets/three/rendering-lab/dungeon_warkarma.glb");
const fixtureSha256 = createHash("sha256").update(await readFile(fixture)).digest("hex");
// Hash the actual source closure, including uncommitted and imported files.
const sourceFingerprint = {};
const sourcePaths = execFileSync("rg", ["--files", "OEngine/src", "examples/demos/14-integrated/next-renderer-showcase", "examples/demos/14-integrated/shared", "validation/labs/surface-performance", "validation/tools"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(path => /\.(?:ts|mjs|html|css)$/.test(path));
for (const path of sourcePaths) sourceFingerprint[path.replaceAll("\\", "/")] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
await writeFile(resolve(out, "source-fingerprint.json"), JSON.stringify(sourceFingerprint, null, 2));

const sensors = { provider: "nvidia-smi", available: false, errors: [], samples: [] };
let sensorPending = Promise.resolve(), sensorBusy = false;
async function sampleSensor() {
  if (sensorBusy) return;
  sensorBusy = true;
  const queryStartUnixMs = Date.now();
  try {
    const { stdout } = await runFile("nvidia-smi", ["--query-gpu=index,uuid,name,temperature.gpu,utilization.gpu,clocks.current.graphics,clocks.current.memory,power.draw,pstate,clocks_event_reasons.sw_thermal_slowdown,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.sw_power_cap", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5000 });
    for (const line of stdout.trim().split(/\r?\n/)) {
      const [index, uuid, name, temperatureC, utilizationPercent, graphicsMHz, memoryMHz, powerW, pstate, swThermalSlowdown, hwThermalSlowdown, hwPowerBrakeSlowdown, swPowerCap] = line.split(",").map(value => value.trim());
      const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
      sensors.samples.push({ queryStartUnixMs, queryEndUnixMs: Date.now(), index: numeric(index), uuid, name,
        temperatureC: numeric(temperatureC), utilizationPercent: numeric(utilizationPercent), graphicsMHz: numeric(graphicsMHz), memoryMHz: numeric(memoryMHz), powerW: numeric(powerW),
        pstate, swThermalSlowdown, hwThermalSlowdown, hwPowerBrakeSlowdown, swPowerCap });
    }
    sensors.available = true;
  } catch (error) { if (!sensors.errors.length) sensors.errors.push(String(error)); }
  finally { sensorBusy = false; }
}
if (!args.includes("--no-sensors")) await sampleSensor();
const sensorTimer = args.includes("--no-sensors") ? null : setInterval(() => { sensorPending = sampleSensor(); }, 1000);
let mode = "production";
const normalize = path => path.replaceAll("\\", "/");
const helper = normalize(resolve(root, "validation/labs/surface-performance/ShaderSensitivity.mjs"));
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"), clearScreen: false,
  server: { host: "127.0.0.1", port: Number(option("port", "4180")), strictPort: true, fs: { allow: [root] } },
  plugins: [{ name: "surface-diagnostic-only", enforce: "pre",
    transform(source, id) {
      if (asyncPrewarm && normalize(id).endsWith("/OEngine/src/render/surface/SurfaceMaterialPass.ts")) return prewarmSurfaceOwner(source);
      if (asyncPrewarm && normalize(id).endsWith("/OEngine/src/render/pipeline/RendererCore.ts")) return prewarmRendererRoot(source);
      if (!normalize(id).endsWith("/OEngine/src/shaders/surface_sample_worker.ts") || mode === "production") return;
      if (!source.includes("export function surfaceSampleWorkerWgsl(")) throw new Error("Missing worker generator diagnostic seam");
      return source.replace("export function surfaceSampleWorkerWgsl(", "function productionSurfaceSampleWorkerWgsl(") + `
import { rewriteSurfaceWorker } from ${JSON.stringify(helper)};
export function surfaceSampleWorkerWgsl(...args: Parameters<typeof productionSurfaceSampleWorkerWgsl>) {
  const source = productionSurfaceSampleWorkerWgsl(...args);
  const specialization = { hasLit: args[1], physicalEnvironment: args[6] ?? true, closureLighting: args[7] ?? false };
  const rewritten = rewriteSurfaceWorker(source, ${JSON.stringify(mode)}, specialization);
  const diagnostic = (globalThis as unknown as { __surfaceDiagnostic?: { rewrites: unknown[] } }).__surfaceDiagnostic;
  diagnostic?.rewrites.push({ ...specialization, mode: ${JSON.stringify(mode)}, changed: rewritten !== source });
  return rewritten;
}`;
    },
    configureServer(dev) {
      dev.middlewares.use("/__surface-performance/", async (request, response) => {
        if (request.url?.split("?")[0] === "/config.json") {
          response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify({ mode, asyncPrewarm, evidenceRole: "diagnostic", accepted: false })); return;
        }
        const html = await readFile(resolve(root, "validation/labs/surface-performance/index.html"), "utf8");
        response.setHeader("Content-Type", "text/html");
        response.end(html.replace('src="./main.ts"', `src="/@fs/${normalize(resolve(root, "validation/labs/surface-performance/main.ts"))}"`));
      });
    }
  }] });
let browser;
const report = { schema: "eengine-surface-performance-suite-v1", evidenceRole: "diagnostic", accepted: false,
  revision, dirtyPaths, fixtureSha256, startedAt: new Date().toISOString(), browser: null, errors: [], captures: [], sensors,
  options: { frames, warmup, batches, width, height, modes, coverageGroups, view: option("view", "overview"),
    headless: args.includes("--headless"), asyncPrewarm, counters: !args.includes("--no-counters"),
    chrome: option("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe") },
  measurement: "completed fixed consecutive GPU frame ranges; pass interval sum; ablation differences are non-additive",
  sensorMapping: "sensor query UTC intervals overlap CPU encode→GPU result observation windows; not calibrated per-GPU-frame attribution" };
const save = () => writeFile(resolve(out, "suite.json"), JSON.stringify(report, null, 2));
async function bounded(operation, timeoutMs, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const cameraDistances = new Map();
  // Alternate order across batches; each experiment gets a new Document/device.
  for (let batch = 0; batch < batches; batch++) {
    const ordered = batch % 2 ? [...modes].reverse() : [...modes].sort((a, b) => (a === "production" ? -1 : b === "production" ? 1 : 0));
    for (const coverage of batch % 2 ? [...coverageGroups].reverse() : coverageGroups) {
    for (const selected of ordered) {
      mode = selected; server.moduleGraph.invalidateAll();
      browser = await chromium.launch({ executablePath: option("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"),
        headless: args.includes("--headless"), args: [],
        ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
      report.browser = browser.version();
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.bringToFront();
      if (!args.includes("--headless")) {
        const session = await context.newCDPSession(page);
        const { windowId } = await session.send("Browser.getWindowForTarget");
        await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await session.detach();
      }
      const errors = [];
      page.on("pageerror", error => errors.push({ source: "pageerror", message: String(error) }));
      page.on("console", message => {
        if (message.type() === "error") errors.push({ source: "console", message: message.text() });
        if (message.text().startsWith("SURFACE_CAPTURE ")) console.log(message.text());
      });
      page.on("crash", () => errors.push({ source: "crash", message: "Page crashed" }));
      try {
        console.log(`BATCH ${batch + 1}/${batches} ${coverage}/${mode}: load/compile/warmup`);
        await page.goto(`${base}__surface-performance/index.html?mode=${mode}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(globalThis.__eengineShowcase), undefined, { timeout: 30000 });
        await bounded(page.evaluate(() => globalThis.__eengineShowcase.start()), asyncPrewarm ? 600000 : 180000, "Scene preparation");
        const distanceScale = cameraDistances.get(coverage);
        const capture = await bounded(page.evaluate(request => globalThis.__eengineShowcase.capture(request), { width, height, frames, warmup,
          coverage, ...(distanceScale === undefined ? {} : { distanceScale, lockCamera: true }),
          counters: !args.includes("--no-counters"), view: option("view", "overview"), profile: "full" }), 600000, "Calibration/capture");
        if (capture.complete && distanceScale === undefined) cameraDistances.set(coverage, capture.cameraDistanceScale);
        capture.caseId = `surface-performance-${coverage}-${mode}-${batch}`; capture.mode = mode; capture.batch = batch; capture.coverageGroup = coverage;
        capture.errors = errors;
        capture.conditions.browser = { version: report.browser, headless: args.includes("--headless"), asyncPrewarm, processIsolation: "per-case" };
        capture.shaderRewrites = await page.evaluate(() => globalThis.__surfaceDiagnostic.rewrites);
        capture.pipelinePrewarm = await page.evaluate(() => ({ hits: globalThis.__surfaceDiagnostic.prewarmCacheHits, misses: globalThis.__surfaceDiagnostic.prewarmCacheMisses }));
        if (asyncPrewarm && (!capture.pipelinePrewarm.hits.some(key => key.startsWith("true:")) || capture.pipelinePrewarm.misses.some(key => key.startsWith("true:")))) {
          capture.complete = false; capture.issues.push("Async prewarm did not cover the actual lit consumer profile");
        }
        if (mode !== "production" && !capture.shaderRewrites.some(rewrite => rewrite.changed)) {
          capture.complete = false; capture.issues.push("No diagnostic shader rewrite actually applied");
        }
        if (errors.length) { capture.complete = false; capture.issues.push("Browser errors"); }
        report.captures.push(capture);
        await writeFile(resolve(out, `${batch}-${coverage}-${mode}.json`), JSON.stringify(capture, null, 2));
        console.log(`${coverage}/${mode}: ${capture.summary.completedGpu}/${frames} frames; coverage ${(capture.calibration.at(-1).coverage * 100).toFixed(2)}%; worker ${capture.summary.passes.find(p => p.label.endsWith("Surface/material and lighting samples"))?.p50.toFixed(3)} ms; total ${capture.summary.gpuPassSumMs?.p50.toFixed(3)} / ${capture.summary.gpuPassSumMs?.p95.toFixed(3)} ms`);
        if (!capture.complete) report.errors.push(`${batch}-${coverage}-${mode}: ${capture.issues.join("; ")}`);
      } catch (error) {
        report.errors.push(`${batch}-${coverage}-${mode}: ${String(error)}; browser: ${JSON.stringify(errors)}`); console.error(String(error));
        const runtime = await bounded(page.evaluate(() => ({ runtime: globalThis.__eengineShowcase?.runtime,
          sceneState: document.querySelector("#scene-state")?.textContent, captureState: document.querySelector("#benchmark-state")?.textContent })), 5000, "Failure diagnostics").catch(error => ({ error: String(error) }));
        await writeFile(resolve(out, `${batch}-${coverage}-${mode}-failure.json`), JSON.stringify({ error: String(error), errors, runtime }, null, 2));
        await page.screenshot({ path: resolve(out, `${batch}-${coverage}-${mode}-failure.png`), timeout: 5000 }).catch(() => {});
      }
      finally {
        try { await page.evaluate(() => globalThis.__eengineShowcase?.dispose()); } catch (error) { report.errors.push(`dispose ${coverage}/${mode}: ${String(error)}`); }
        await context.close(); await browser.close(); browser = undefined; await save();
      }
    }
    }
  }
} catch (error) { report.errors.push(String(error)); }
finally {
  if (sensorTimer) clearInterval(sensorTimer); await sensorPending;
  await browser?.close(); await server.close();
  const sourceChanged = [];
  for (const [path, hash] of Object.entries(sourceFingerprint)) {
    if (createHash("sha256").update(await readFile(resolve(root, path))).digest("hex") !== hash) sourceChanged.push(path);
  }
  if (sourceChanged.length) report.errors.push(`Source changed during capture: ${sourceChanged.join(", ")}`);
  report.finishedAt = new Date().toISOString(); await save();
  console.log(`Artifacts: ${out}`);
  if (report.errors.length) { console.error(report.errors); process.exitCode = 1; }
}
