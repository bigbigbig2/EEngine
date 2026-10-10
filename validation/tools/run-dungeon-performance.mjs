import { chromium } from "../node_modules/playwright-core/index.mjs";
import { launchChrome } from "../../tools/gpu-oracle/browser.mjs";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat, readdir, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, extname, relative } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { installDungeonGpuAudit } from "./dungeon-gpu-audit.mjs";
import { summarizeVsmReceiverRequests } from "./vsm-receiver-statistics.mjs";
const runFile = promisify(execFile);
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (value == null || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}
const root = resolve(import.meta.dirname, "../..");
const demo = "examples/demos/14-integrated/dungeon-warkarma-texture-compression";
const out = resolve(root, option("out", ".local/validation/dungeon-performance-2026-10-10"));
const frames = Number(option("frames", "240"));
const nativeCostSlice = option("native-slice", null);
const vsmDemandDiagnostics = args.includes("--vsm-demand-diagnostics");
const gpuSampleInterval = Number(option("gpu-sample-interval", "4"));
if (nativeCostSlice !== null && !/^(?:[A-G]|B0)$/.test(nativeCostSlice))
  throw new Error("--native-slice must be A through G, or B0 (center inputs)");
if (vsmDemandDiagnostics && nativeCostSlice !== null && nativeCostSlice !== "G")
  throw new Error("VSM statistics require full native shading");
const scenarios = args.includes("--load-only")
  ? []
  : option(
      "scenarios",
      "normal-1,normal-2,normal-3,coarse,full,no-vsm,pcf-1,no-fsr,scale-75,scale-50,ao-on,bloom-on,baseline-repeat"
    )
      .split(",")
      .filter(Boolean);
await mkdir(out, { recursive: true });
const sourceFiles = execFileSync("rg", ["--files", "OEngine/src", demo], { cwd: root, encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter((p) => /\.(ts|mjs|html|css)$/.test(p) && !/[\\/]dist[\\/]/.test(p));
const fingerprint = {};
for (const p of sourceFiles)
  fingerprint[p.replaceAll("\\", "/")] = createHash("sha256")
    .update(await readFile(resolve(root, p)))
    .digest("hex");
await writeFile(resolve(out, "source-fingerprint.json"), JSON.stringify(fingerprint, null, 2));
const manifest = JSON.parse(
  await readFile(resolve(root, demo, "assets/playground-cooked/scene.materials.json"), "utf8")
);
const modelManifest = JSON.parse(
  await readFile(resolve(root, demo, "assets/cooked/scene.materials.json"), "utf8")
);
function modelBounds(glb) {
  const { mat4, vec3 } = createRequire(resolve(root, "OEngine/package.json"))("gl-matrix");
  const source = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)));
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  function visit(index, parent) {
    const n = source.nodes[index],
      local =
        n.matrix ??
        mat4.fromRotationTranslationScale(
          mat4.create(),
          n.rotation ?? [0, 0, 0, 1],
          n.translation ?? [0, 0, 0],
          n.scale ?? [1, 1, 1]
        ),
      world = mat4.multiply(mat4.create(), parent, local);
    for (const p of source.meshes[n.mesh]?.primitives ?? []) {
      const b = source.accessors[p.attributes.POSITION];
      for (let corner = 0; corner < 8; corner++) {
        const v = vec3.transformMat4(
          vec3.create(),
          [0, 1, 2].map((a) => (corner & (1 << a) ? b.max : b.min)[a]),
          world
        );
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], v[a]);
          max[a] = Math.max(max[a], v[a]);
        }
      }
    }
    for (const child of n.children ?? []) visit(child, world);
  }
  for (const node of source.scenes[source.scene ?? 0].nodes) visit(node, mat4.create());
  return {
    min,
    max,
    center: min.map((v, a) => (v + max[a]) / 2),
    radius: Math.hypot(...max.map((v, a) => (v - min[a]) / 2))
  };
}
const report = {
  schema: "dungeon-performance-diagnostic-v1",
  accepted: false,
  startedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
  options: {
    frames,
    scenarios,
    width: 1920,
    height: 1080,
    headless: !args.includes("--headed"),
    geometryMiB: option("geometryMiB", "1536")
  },
  manifest,
  captures: [],
  errors: [],
  sensors: [],
  osSamples: [],
  processSamples: [],
  network: []
};
// Built example, HTTP Range and isolation headers match the development host.
const dist = resolve(root, demo, "dist");
await mkdir(resolve(out, "maps"), { recursive: true });
const buildFingerprint = {};
for (const name of await readdir(resolve(dist, "assets"))) {
  if (!/\.(js|css|map)$/.test(name)) continue;
  buildFingerprint[name] = createHash("sha256")
    .update(await readFile(resolve(dist, "assets", name)))
    .digest("hex");
  if (name.endsWith(".map")) await copyFile(resolve(dist, "assets", name), resolve(out, "maps", name));
}
await writeFile(resolve(out, "build-fingerprint.json"), JSON.stringify(buildFingerprint, null, 2));
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
    if (relative(dist, path).startsWith("..")) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm"
      }[extname(path)] ?? "application/octet-stream"
    );
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (req.headers.range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!m) {
        res.writeHead(416).end();
        return;
      }
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), end) : end;
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    res.writeHead(status);
    if (req.method === "HEAD") res.end();
    else createReadStream(path, { start, end }).pipe(res);
  } catch (error) {
    res.writeHead(404).end(String(error));
  }
});
await new Promise((r) => server.listen(5186, "127.0.0.1", r));
let run, browserCdp, pageCdp, sensorTimer, osTimer, processTimer;
let scenario = "before-browser",
  sensorBusy = false,
  osBusy = false,
  procBusy = false,
  processIds = [];
async function sensor() {
  if (sensorBusy) return;
  sensorBusy = true;
  const at = Date.now(),
    phase = scenario;
  try {
    const { stdout } = await runFile(
      "nvidia-smi",
      [
        "--query-gpu=uuid,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,clocks.current.graphics,clocks.current.memory,power.draw,pstate,clocks_event_reasons.sw_thermal_slowdown,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.hw_power_brake_slowdown,clocks_event_reasons.sw_power_cap,memory.used,memory.total",
        "--format=csv,noheader,nounits"
      ],
      { windowsHide: true, timeout: 6000 }
    );
    const fields = [
      "uuid",
      "name",
      "driver",
      "temperatureC",
      "gpuUtilPercent",
      "memoryUtilPercent",
      "graphicsMHz",
      "memoryMHz",
      "powerW",
      "pstate",
      "swThermal",
      "hwThermal",
      "powerBrake",
      "powerCap",
      "memoryUsedMiB",
      "memoryTotalMiB"
    ];
    const values = stdout
      .trim()
      .split(",")
      .map((v) => v.trim());
    report.sensors.push({
      at,
      end: Date.now(),
      scenario: phase,
      ...Object.fromEntries(
        fields.map((k, i) => [k, /^[\d.]+$/.test(values[i]) ? Number(values[i]) : values[i]])
      )
    });
  } catch (e) {
    report.sensors.push({ at, scenario: phase, error: String(e) });
  } finally {
    sensorBusy = false;
  }
}
async function processes() {
  if (!browserCdp || procBusy) return;
  procBusy = true;
  try {
    const info = await browserCdp.send("SystemInfo.getProcessInfo");
    processIds = info.processInfo.map((p) => p.id);
    report.processSamples.push({ at: Date.now(), scenario, ...info });
  } catch (e) {
    report.errors.push({ observer: "process-info", error: String(e) });
  } finally {
    procBusy = false;
  }
}
async function osMemory() {
  if (osBusy || !processIds.length) return;
  osBusy = true;
  const at = Date.now(),
    phase = scenario;
  try {
    const cmd = `$ids = @(${processIds.join(",")}); $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64,VirtualMemorySize64); $gp = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$Matches[1] } | Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted); @{ processes=$ps; gpuProcessMemory=$gp } | ConvertTo-Json -Depth 5 -Compress`;
    const { stdout } = await runFile("powershell", ["-NoProfile", "-Command", cmd], {
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 1024 ** 2
    });
    report.osSamples.push({ at, end: Date.now(), scenario: phase, ...JSON.parse(stdout) });
  } catch (e) {
    report.osSamples.push({ at, scenario: phase, error: String(e) });
  } finally {
    osBusy = false;
  }
}
async function metrics() {
  return {
    at: Date.now(),
    ...(await pageCdp.send("Performance.getMetrics")),
    heap: await run.page.evaluate(() =>
      performance.memory
        ? {
            used: performance.memory.usedJSHeapSize,
            total: performance.memory.totalJSHeapSize,
            limit: performance.memory.jsHeapSizeLimit
          }
        : null
    )
  };
}
async function control(id, value, checkbox = false) {
  await run.page.locator(`#${id}`).evaluate(
    (el, [v, check]) => {
      if (check) el.checked = v;
      else el.value = String(v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [value, checkbox]
  );
}
try {
  await sensor();
  run = await launchChrome({
    chromium,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: report.options.headless,
    extraArgs: [
      "--enable-unsafe-webgpu",
      "--enable-dawn-features=allow_unsafe_apis",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--js-flags=--expose-gc",
      "--enable-precise-memory-info"
    ]
  });
  report.chromeVersion = run.chromeVersion;
  report.transport = run.transport;
  await run.page.setViewportSize({ width: 1920, height: 1080 });
  browserCdp = await run.browser.newBrowserCDPSession();
  pageCdp = await run.context.newCDPSession(run.page);
  report.systemInfo = await browserCdp.send("SystemInfo.getInfo");
  await pageCdp.send("Performance.enable");
  await pageCdp.send("Network.enable");
  await pageCdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  pageCdp.on("Network.requestWillBeSent", (e) =>
    report.network.push({
      type: "request",
      at: Date.now(),
      id: e.requestId,
      url: e.request.url,
      timestamp: e.timestamp
    })
  );
  pageCdp.on("Network.responseReceived", (e) =>
    report.network.push({
      type: "response",
      at: Date.now(),
      id: e.requestId,
      status: e.response.status,
      timing: e.response.timing,
      timestamp: e.timestamp,
      encodedDataLength: e.response.encodedDataLength,
      fromDiskCache: e.response.fromDiskCache
    })
  );
  pageCdp.on("Network.loadingFinished", (e) =>
    report.network.push({
      type: "finished",
      at: Date.now(),
      id: e.requestId,
      timestamp: e.timestamp,
      encodedDataLength: e.encodedDataLength
    })
  );
  run.page.on("pageerror", (e) => report.errors.push({ scenario, type: "page", message: String(e) }));
  run.page.on("console", (m) => {
    if (m.type() === "error") report.errors.push({ scenario, type: "console", message: m.text() });
  });
  await run.page.addInitScript(() => {
    performance.setResourceTimingBufferSize(10000);
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  if (args.includes("--near") || args.includes("--audit"))
    await run.page.addInitScript(installDungeonGpuAudit);
  await processes();
  await osMemory();
  sensorTimer = setInterval(sensor, 1500);
  processTimer = setInterval(processes, 2000);
  osTimer = setInterval(osMemory, 6000);
  scenario = "cold-load";
  const loadStart = Date.now();
  const urlObject = new URL(
    `http://127.0.0.1:5186/demos/14-integrated/dungeon-warkarma-texture-compression/index.html?performanceCapture=1&geometryMiB=${report.options.geometryMiB}`
  );
  if (nativeCostSlice !== null) urlObject.searchParams.set("nativeCostSlice", nativeCostSlice);
  if (vsmDemandDiagnostics) urlObject.searchParams.set("vsmDemandDiagnostics", "1");
  if (args.includes("--near") && !args.includes("--camera-search")) {
    const b = modelBounds(await readFile(resolve(root, demo, "assets/dungeon_warkarma.glb")));
    const offset = option("cameraOffset", "-7,-2,-7").split(",").map(Number),
      target = b.center.map((v, a) => v + offset[a]),
      distance = b.radius * 2.24 * Number(option("cameraFactor", ".15")),
      position = [0.6, 0.65, 0.466].map((v, a) => target[a] + v * distance);
    urlObject.searchParams.set("performanceCamera", [...position, ...target].join(","));
  }
  const url = urlObject.href;
  if (args.includes("--load-profile")) {
    await pageCdp.send("Profiler.enable");
    await pageCdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await pageCdp.send("Profiler.start");
  }
  await run.page.goto(url);
  await run.page.waitForFunction(
    () => window.dungeonDemo?.report().failure || window.dungeonDemo?.report().load.fullQualityMs != null,
    null,
    { timeout: 240000, polling: 1000 }
  );
  if (args.includes("--load-profile")) {
    const { profile } = await pageCdp.send("Profiler.stop");
    await writeFile(resolve(out, "load.cpuprofile"), JSON.stringify(profile));
  }
  report.load = {
    start: loadStart,
    end: Date.now(),
    report: await run.page.evaluate(() => window.dungeonDemo.report()),
    metrics: await metrics(),
    longTasks: await run.page.evaluate(() => window.__longTasks),
    resources: await run.page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.toJSON())),
    navigation: await run.page.evaluate(() =>
      performance.getEntriesByType("navigation").map((e) => e.toJSON())
    ),
    gpuAudit: await run.page.evaluate(() => window.dungeonGpuAudit?.snapshot())
  };
  if (report.load.report.failure) throw new Error(JSON.stringify(report.load.report.failure));
  report.options.nativeCostSlice = nativeCostSlice;
  report.options.vsmDemandDiagnostics = vsmDemandDiagnostics;
  report.options.gpuSampleInterval = gpuSampleInterval;
  if (nativeCostSlice !== null && !report.load.gpuAudit?.nativeCostSlices?.includes(nativeCostSlice)) {
    throw new Error(
      "Requested Native cost slice was not compiled; use EENGINE_PERFORMANCE_DIAGNOSTICS=1 build"
    );
  }
  console.log(
    JSON.stringify({
      phase: "loaded",
      first: report.load.report.load.firstUsefulMs,
      full: report.load.report.load.fullQualityMs,
      adapter: report.load.report.adapter,
      resolution: report.load.report.renderState.resolution
    })
  );
  if (args.includes("--near")) {
    scenario = "near-camera-selection";
    const bounds = modelBounds(await readFile(resolve(root, demo, "assets/dungeon_warkarma.glb")));
    report.cameraSelection = { bounds, attempts: [] };
    const candidates = args.includes("--camera-search")
      ? [
          { factor: 0.25, offset: [-7, -2, -7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.2, offset: [-7, -2, -7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.15, offset: [-7, -2, -7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.2, offset: [7, -2, -7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.15, offset: [7, -2, -7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.2, offset: [-7, -2, 7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.15, offset: [-7, -2, 7], direction: [0.6, 0.65, 0.466] },
          { factor: 0.15, offset: [0, -2, 0], direction: [0, 1, 0.25] }
        ]
      : [
          {
            factor: Number(option("cameraFactor", ".15")),
            offset: option("cameraOffset", "-7,-2,-7").split(",").map(Number),
            direction: [0.6, 0.65, 0.466]
          }
        ];
    for (const { factor, offset, direction } of candidates) {
      const distance = bounds.radius * 2.24 * factor,
        target = bounds.center.map((v, a) => v + offset[a]);
      const position = direction.map((v, a) => target[a] + v * distance);
      await run.page.evaluate(([p, t]) => window.dungeonPerformance.setCamera(p, t), [position, target]);
      const frame = await run.page.evaluate(() => window.dungeonDemo.report().renderState.frame);
      await run.page.waitForFunction((n) => window.dungeonDemo.report().renderState.frame > n + 60, frame, {
        polling: 1000,
        timeout: 120000
      });
      await control("pause", true, true);
      const instanceBegin = await run.page.evaluate(() => window.dungeonPerformance.samples().instanceBegin);
      const coverage = await run.page.evaluate(
        ([begin, count]) => window.dungeonGpuAudit.coverage(begin, count),
        [instanceBegin, modelManifest.instanceMaterials.length]
      );
      report.cameraSelection.attempts.push({ factor, offset, position, target, instanceBegin, coverage });
      await run.page.screenshot({ path: resolve(out, `camera-${factor}.png`) });
      await control("pause", false, true);
      console.log(
        JSON.stringify({
          phase: "coverage",
          factor,
          ratio: coverage.ratio,
          invalid: coverage.invalid,
          queue: coverage.queueHeader
        })
      );
      if (coverage.ratio >= 0.8 && coverage.invalid === 0) {
        report.cameraSelection.selected = report.cameraSelection.attempts.at(-1);
        break;
      }
    }
    if (!report.cameraSelection.selected) throw new Error("No camera met >=80% Dungeon-only pixel coverage");
  }
  for (const name of scenarios) {
    scenario = `${name}-warmup`;
    // Reset identical defaults before each controlled experiment.
    await control("vsm", true, true);
    await control("fsr3", true, true);
    await control("gtao", false, true);
    await control("bloom", false, true);
    await control("render-scale", 1);
    await run.page.locator("#vsm-reset").dispatchEvent("click");
    if (name === "no-vsm") await control("vsm", false, true);
    if (name.startsWith("pcf-1")) await control("vsm-taps", 1);
    if (name === "no-fsr") await control("fsr3", false, true);
    if (name === "scale-75") await control("render-scale", 0.75);
    if (name === "scale-50") await control("render-scale", 0.5);
    if (name === "ao-on") await control("gtao", true, true);
    if (name === "bloom-on") await control("bloom", true, true);
    if (name === "motion") {
      const { position, target } = report.cameraSelection.selected;
      await run.page.evaluate(
        ([p, t]) => {
          const begun = performance.now();
          window.__dungeonMotion = setInterval(() => {
            const angle = Math.sin((performance.now() - begun) / 3000) * 0.06,
              dx = p[0] - t[0],
              dz = p[2] - t[2];
            window.dungeonPerformance.setCamera(
              [
                t[0] + dx * Math.cos(angle) + dz * Math.sin(angle),
                p[1],
                t[2] - dx * Math.sin(angle) + dz * Math.cos(angle)
              ],
              t,
              false
            );
          }, 16);
        },
        [position, target]
      );
    }
    const mode =
      name.startsWith("normal") || name === "baseline-repeat"
        ? "production"
        : name.startsWith("coarse") || name === "counters"
          ? "coarse"
          : "full";
    const startFrame = await run.page.evaluate(
      ([mode, counters, interval]) =>
        window.dungeonPerformance.configure(mode, mode === "full", counters, interval),
      [mode, name === "counters", gpuSampleInterval]
    );
    await run.page.waitForFunction(
      (n) => window.dungeonDemo.report().renderState.frame >= n + 60,
      startFrame,
      { polling: 1000, timeout: 120000 }
    );
    const start = Date.now(),
      before = await metrics(),
      pageStart = await run.page.evaluate(() => performance.now());
    scenario = name;
    const targetStart = await run.page.evaluate(() => window.dungeonDemo.report().renderState.frame);
    await run.page.waitForFunction(
      (n) => window.dungeonDemo.report().failure || window.dungeonDemo.report().renderState.frame >= n,
      targetStart + frames,
      { polling: 1000, timeout: 180000 }
    );
    const end = Date.now(),
      after = await metrics(),
      pageEnd = await run.page.evaluate(() => performance.now());
    const capture = {
      name,
      mode,
      start,
      end,
      pageStart,
      pageEnd,
      targetStart,
      targetEnd: targetStart + frames,
      before,
      after,
      report: await run.page.evaluate(() => window.dungeonDemo.report()),
      raw: await run.page.evaluate(() => window.dungeonPerformance.samples()),
      longTasks: await run.page.evaluate(() => window.__longTasks)
    };
    if (args.includes("--near") || args.includes("--audit")) {
      await control("pause", true, true);
      capture.coverage = await run.page.evaluate(
        ([begin, count]) => window.dungeonGpuAudit.coverage(begin, count),
        [capture.raw.instanceBegin, modelManifest.instanceMaterials.length]
      );
      capture.vsmHeaders = await run.page.evaluate(() =>
        window.dungeonGpuAudit.vsmHeaders(window.dungeonPerformance.vsmDiagnostics())
      );
      if (vsmDemandDiagnostics) {
        if (!capture.vsmHeaders?.receiverWorkgroups)
          throw new Error("VSM receiver instrumentation was not compiled");
        capture.vsmReceiverStatistics = summarizeVsmReceiverRequests(capture.vsmHeaders);
      } else if (capture.vsmHeaders?.receiverWorkgroups) {
        throw new Error("Instrumentation is active during a timing run");
      }
      capture.gpuResources = await run.page.evaluate(() => window.dungeonGpuAudit.snapshot());
      await control("pause", false, true);
      if (args.includes("--near") && (capture.coverage.ratio < 0.8 || capture.coverage.invalid))
        throw new Error(`Coverage guard failed in ${name}: ${capture.coverage.ratio}`);
    }
    await writeFile(resolve(out, `${name}.json`), JSON.stringify(capture));
    report.captures.push({
      name,
      mode,
      start,
      end,
      targetStart,
      targetEnd: capture.targetEnd,
      file: `${name}.json`,
      stable: capture.report.stable,
      failure: capture.report.failure
    });
    await run.page.screenshot({ path: resolve(out, `${name}.png`) });
    await writeFile(resolve(out, "suite.json"), JSON.stringify(report, null, 2));
    if (report.cameraSelection?.selected && name !== "motion") {
      const selected = report.cameraSelection.selected;
      const camera = capture.report.renderState.camera;
      if (["position", "target"].some((field) =>
        camera[field].some((value, axis) => Math.abs(value - selected[field][axis]) > 1e-6))) {
        throw new Error(`Fixed camera changed during ${name}; raw capture saved`);
      }
    }
    if (nativeCostSlice !== null && mode === "full") {
      const windowFrames = capture.raw.frames.filter(
        (frame) => frame.frameIndex >= capture.targetStart && frame.frameIndex < capture.targetEnd
      );
      const interval = capture.raw.gpuSampleInterval;
      const expected = windowFrames.filter((frame) => frame.frameIndex % interval === 0).length;
      const complete = windowFrames.filter(
        (frame) => frame.gpu.sampled && frame.gpu.mode === "full" && !frame.gpu.pending &&
          !frame.counters["gpu.timing.truncated"] &&
          frame.gpu.segments.some((segment) => segment.label.includes("native winner shading"))
      ).length;
      if (windowFrames.length !== frames || !expected || complete !== expected) {
        throw new Error(`Native slice ${nativeCostSlice} incomplete full timing window: ` +
          `${complete}/${expected} GPU samples, ${windowFrames.length}/${frames} frames; raw capture saved`);
      }
    }
    console.log(
      JSON.stringify({
        phase: "capture",
        name,
        frame: capture.report.renderState.frame,
        cpu: capture.report.stable[mode === "production" ? "normal" : "profiled"].cpuFrameMs,
        fps: capture.report.stable.submissions.framesPerSecond,
        gpu: capture.report.stable.profiled.gpuCommandSpanMs,
        errors: report.errors.length
      })
    );
    if (capture.report.failure) throw new Error(JSON.stringify(capture.report.failure));
    if (name === "motion") {
      await run.page.evaluate(() => clearInterval(window.__dungeonMotion));
      const { position, target } = report.cameraSelection.selected;
      await run.page.evaluate(([p, t]) => window.dungeonPerformance.setCamera(p, t), [position, target]);
    }
  }
  if (args.includes("--cpu-profile")) {
    scenario = "cpu-profile";
    await run.page.evaluate(() => window.dungeonPerformance.configure("production"));
    await pageCdp.send("Profiler.enable");
    await pageCdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await pageCdp.send("Profiler.start");
    const frame = await run.page.evaluate(() => window.dungeonDemo.report().renderState.frame);
    await run.page.waitForFunction((n) => window.dungeonDemo.report().renderState.frame >= n + 240, frame, {
      polling: 1000,
      timeout: 180000
    });
    const { profile } = await pageCdp.send("Profiler.stop");
    await writeFile(resolve(out, "cpu.cpuprofile"), JSON.stringify(profile));
  }
  scenario = "release";
  report.beforeRelease = await run.page.evaluate(() => window.dungeonDemo.report());
  await run.page.evaluate(() => window.dungeonDemo.release());
  report.afterRelease = await run.page.evaluate(() => window.dungeonDemo.report());
  await processes();
  await osMemory();
  await sensor();
  report.completedAt = new Date().toISOString();
} catch (e) {
  report.errors.push({ scenario, type: "runner", message: String(e), stack: e.stack });
  console.error(e);
  process.exitCode = 1;
} finally {
  clearInterval(sensorTimer);
  clearInterval(processTimer);
  clearInterval(osTimer);
  while (sensorBusy || osBusy || procBusy) await new Promise((r) => setTimeout(r, 100));
  await writeFile(resolve(out, "suite.json"), JSON.stringify(report, null, 2));
  await run?.close();
  await new Promise((r) => server.close(r));
  console.log(JSON.stringify({ out, completed: report.captures.length, errors: report.errors }));
}
