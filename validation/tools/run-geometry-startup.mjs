// GRS diagnostic: full scenes, serial devices, cold HTTP/application state and
// warm HTTP with a fresh document/device. Driver/OS caches are not controlled.
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { build, loadConfigFromFile } from "../../examples/node_modules/vite/dist/node/index.js";
import { launchChrome } from "../../tools/gpu-oracle/browser.mjs";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const out = resolve(root, option("out", ".local/validation/grs-3"));
const dist = resolve(out, "dist");
const scenes = option("scenes", "bistro,dungeon").split(",");
const repetitions = Number(option("repetitions", "3"));
const timeoutMs = Number(option("timeout", "180000"));
await mkdir(out, { recursive: true });
const sourcePaths = execFileSync("git", [
  "ls-files", "OEngine/src", "examples/demos/14-integrated", "examples/vite.config.ts",
], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).sort();
sourcePaths.push("validation/tools/run-geometry-startup.mjs");
const sourceHash = createHash("sha256");
for (const path of sourcePaths) {
  sourceHash.update(path).update("\0").update(await readFile(resolve(root, path))).update("\0");
}
const sourceSha256 = sourceHash.digest("hex");
const names = {
  bistro: "bistro-texture-compression",
  dungeon: "dungeon-warkarma-texture-compression",
};
for (const scene of scenes) {
  if (!names[scene]) throw new Error(`Unknown scene ${scene}`);
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetitions");

if (!args.includes("--skip-build")) {
  // Instrument only the validation build. No route interception (Playwright
  // routing disables HTTP cache), production switches or replacement shaders.
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" }, resolve(root, "examples/vite.config.ts"),
  );
  await build({
    ...loaded.config,
    configFile: false,
    plugins: [...loaded.config.plugins, {
      name: "grs-startup-observation",
      enforce: "pre",
      transform(code, id) {
        if (!Object.values(names).some(name => id.replaceAll("\\", "/").endsWith(`/${name}/main.ts`))) {
          return;
        }
        const anchor = "renderer.profiler.configure({ enabled: false });";
        if (!code.includes(anchor)) throw new Error(`Missing preparation anchor: ${id}`);
        const setup = `${anchor}
          renderer.fsr3_enabled = true;
          renderer.temporal_jitter_enabled = true;
          renderer.internal_resolution_scale = 1;
          renderer.setAmbientOcclusionSettings({enabled:true});
          renderer.setScreenSpaceReflectionsSettings({enabled:true, quality:"balanced"});
          window.__grs = {
            report() { return {...report(), workerPreparation: grsAssetPreparation().evidence()}; },
            release,
            capture() {
              renderer.profiler.configure({enabled:true,gpuTimingMode:"full",
                gpuSampleInterval:1,historyCapacity:256,warmupFrames:0});
              renderer.profiler.clear();
            },
            history() { return renderer.profiler.history; },
            closeView() {
              const c=framing.center, r=framing.radius;
              camera.transform.position.set(c[0]+r*.08,c[1]+r*.08,c[2]+r*.22);
              camera.transform.lookAt({x:c[0],y:c[1],z:c[2]});
              controls?.target?.set(c[0],c[1],c[2]);
              camera.update();
            }
          };`;
        const observationImport = `import { cookedAssetPreparation as grsAssetPreparation } from
          "../../../../OEngine/src/assets/codec/CookedAssetPreparation.ts";\n`;
        return { code: observationImport + code.replace(anchor, setup), map: null };
      },
    }],
    build: {
      outDir: dist,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: Object.values(names).map(name =>
          resolve(root, `examples/demos/14-integrated/${name}/index.html`)),
      },
    },
  });
}

const mounts = [
  ["/assets/local-bistro/cooked/", resolve(root, ".local/models/bistro-cooked")],
  ["/assets/local-dungeon/cooked/", resolve(root, ".local/models/dungeon-vt-cooked")],
];
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
    const base = mount?.[1] ?? dist;
    const path = resolve(base, mount ? pathname.slice(mount[0].length) : `.${pathname}`);
    if (relative(base, path).startsWith("..") || relative(base, path).includes(":")) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Not a file");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Accept-Ranges", "bytes");
    // These are immutable inputs within this process. Cold runs explicitly clear
    // browser HTTP and application caches; warm runs preserve only HTTP caches.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Type", {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".json": "application/json", ".wasm": "application/wasm",
    }[extname(path)] ?? "application/octet-stream");
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range) throw new Error("Invalid range");
      start = Number(range[1]);
      end = range[2] ? Number(range[2]) : end;
      if (start < 0 || end < start || end >= info.size) {
        res.writeHead(416).end();
        return;
      }
      res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    res.writeHead(req.headers.range ? 206 : 200);
    if (req.method === "HEAD") res.end();
    else createReadStream(path, { start, end }).on("error", e => res.destroy(e)).pipe(res);
  } catch (error) {
    res.writeHead(404).end(String(error));
  }
});
await new Promise(resolveStarted => server.listen(0, "127.0.0.1", resolveStarted));
const origin = `http://127.0.0.1:${server.address().port}`;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const records = [];
let run;
try {
  run = await launchChrome({
    chromium, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, extraArgs: ["--enable-unsafe-webgpu"],
  });
  const { page, context } = run;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    window.__grsEvents = [];
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        window.__grsEvents.push({ at: e.startTime, ms: e.duration });
      }
    }).observe({ type: "longtask", buffered: true });
    window.__grsGpuErrors = [];
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...parameters) {
      const device = await request.apply(this, parameters);
      device.addEventListener("uncapturederror", e => window.__grsGpuErrors.push(String(e.error)));
      device.lost.then(info => {
        if (info.reason !== "destroyed") window.__grsGpuErrors.push(`device lost: ${info.message}`);
      });
      return device;
    };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let active;
  page.on("pageerror", error => active?.errors.push(String(error)));
  cdp.on("Network.loadingFinished", event => {
    if (active) active.networkEncodedBytes += event.encodedDataLength;
  });
  for (const scene of scenes) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const cache of ["cold-http-new-device", "warm-http-new-device"]) {
        await page.goto("about:blank");
        if (cache.startsWith("cold")) await cdp.send("Network.clearBrowserCache");
        await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
        const row = {
          scene, repetition, cache, revision, sourceSha256, chrome: run.chromeVersion,
          driverCache: "uncontrolled", osFileCache: "warm/uncontrolled",
          width: 1920, height: 1080, errors: [], samples: [],
          networkEncodedBytes: 0,
          networkObservation: "Main-page CDP only; excludes Worker IO. Use owner streaming/provider counters for asset IO.",
          passed: false, startedAt: new Date().toISOString(),
        };
        try {
          row.sensorBefore = execFileSync("nvidia-smi", [
            "--query-gpu=name,memory.total,driver_version,temperature.gpu",
            "--format=csv,noheader,nounits",
          ], { encoding: "utf8", windowsHide: true, timeout: 6000 }).trim();
        } catch (error) {
          row.sensorUnavailable = String(error);
        }
        active = row;
        records.push(row);
        const filename = resolve(out, `${scene}-${repetition}-${cache}.json`);
        const save = () => writeFile(filename, JSON.stringify(row, null, 2));
        try {
          const query = scene === "dungeon" ? "?cookedBase=/assets/local-dungeon/cooked/" : "";
          await page.goto(`${origin}/demos/14-integrated/${names[scene]}/index.html${query}`,
            { waitUntil: "domcontentloaded", timeout: 60000 });
          const until = Date.now() + timeoutMs;
          let closeView = false;
          while (Date.now() < until) {
            await page.waitForTimeout(2000);
            const value = await page.evaluate(() => ({
              now: performance.now(), report: window.__grs?.report(),
              errors: window.__grsGpuErrors,
            }));
            row.samples.push(value);
            if (row.errors.length || value.errors.length || value.report?.failure) {
              throw new Error(JSON.stringify({ errors: row.errors, gpu: value.errors, failure: value.report?.failure }));
            }
            if (!closeView && value.report?.load?.rendererInitialization?.firstCompletedAtMs != null) {
              row.firstCompleted = value;
              await page.evaluate(() => window.__grs.closeView());
              closeView = true;
            } else if (closeView && value.report?.load?.refinement?.phase === "view-settled") {
              row.settled = value;
              break;
            }
            await save();
            console.log(JSON.stringify({
              scene, repetition, cache, seconds: Math.round(value.now / 1000),
              phase: value.report?.load?.refinement?.phase ?? value.report?.phase,
              geometry: value.report?.load?.refinement?.geometryTarget,
            }));
          }
          if (!row.settled) throw new Error("Full target view did not settle before timeout");
          await page.waitForTimeout(2500);
          row.normal = await page.evaluate(() => window.__grs.report());
          await page.evaluate(() => window.__grs.capture());
          await page.waitForTimeout(4500);
          row.steady = await page.evaluate(() => ({
            report: window.__grs.report(), frames: window.__grs.history(),
            longtasks: window.__grsEvents, gpuErrors: window.__grsGpuErrors,
          }));
          const state = row.steady.report.renderState;
          if (state.temporal?.temporalPolicy !== "native" || !state.jitter ||
              !state.gtao || !state.ssr?.enabled || !state.vsm ||
              state.resolution.output.join("x") !== "1920x1080" ||
              state.resolution.internal.join("x") !== "1920x1080" ||
              !row.steady.report.texture?.virtual?.sources) {
            throw new Error("Actual production configuration differs from GRS full-scene profile");
          }
          await page.screenshot({ path: resolve(out, `${scene}-${repetition}-${cache}.png`) });
          await page.evaluate(() => window.__grs.release());
          row.release = await page.evaluate(() => window.__grs.report().teardown);
          if (!row.release?.textureOwnerZero || row.release?.geometry?.totalBytes !== 0) {
            throw new Error("Scene owners did not reach zero after release");
          }
          if (row.steady.gpuErrors.length || row.errors.length) throw new Error("Browser/GPU errors");
          row.passed = true;
        } catch (error) {
          row.error = String(error.stack ?? error);
          row.last = await page.evaluate(() => window.__grs?.report()).catch(() => null);
          await page.evaluate(() => window.__grs?.release()).catch(e => row.errors.push(String(e)));
        } finally {
          row.longtasks = await page.evaluate(() => window.__grsEvents).catch(() => null);
          await save();
          console.log(JSON.stringify({ scene, repetition, cache, passed: row.passed, error: row.error }));
        }
        if (!row.passed) throw new Error(`${scene}/${cache} failed; preserved ${filename}`);
      }
    }
  }
} finally {
  await writeFile(resolve(out, "index.json"), JSON.stringify({
    revision, sourceSha256,
    startedFromDirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    records: records.map(({ samples, steady, ...row }) => ({ ...row, samples: samples.length })),
  }, null, 2));
  await run?.close();
  server.close();
}
