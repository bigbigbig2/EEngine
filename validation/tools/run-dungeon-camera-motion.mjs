import { chromium } from "../node_modules/playwright-core/index.mjs";
import { launchChrome } from "../../tools/gpu-oracle/browser.mjs";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile, readdir } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Ordinary interactive host and real OrbitControls events. This is a bounded
// diagnosis, not the fixed-scene formal renderer qualification runner.
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`--${name} requires a value`);
  return args[index + 1];
};
const root = resolve(import.meta.dirname, "../..");
const demo = "integrated/dungeon-warkarma-texture-compression";
const dist = resolve(root, option("dist", `examples/${demo}/dist`));
const out = resolve(root, option("out", ".local/camera-motion-20261012/interactive"));
const ticks = Number(option("ticks", "240"));
if (!Number.isSafeInteger(ticks) || ticks < 120 || ticks > 1200)
  throw new RangeError("ticks must be 120 through 1200");
await mkdir(out, { recursive: true });
const report = { schema: "dungeon-camera-motion-v1", dist, ticks, errors: [], captures: [], build: {} };
for (const name of await readdir(resolve(dist, "assets"))) {
  if (!name.endsWith(".js")) continue;
  report.build[name] = createHash("sha256")
    .update(await readFile(resolve(dist, "assets", name)))
    .digest("hex");
}
const server = createServer(async (request, response) => {
  try {
    const path = resolve(dist, "." + decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    if (relative(dist, path).startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }
    const headers = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".wasm": "application/wasm",
        }[extname(path)] ?? "application/octet-stream",
    };
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) {
        response.writeHead(416).end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    response.writeHead(status, headers);
    createReadStream(path, { start, end }).pipe(response);
  } catch (error) {
    response.writeHead(404).end(String(error));
  }
});
await new Promise((yes, no) => {
  server.once("error", no);
  server.listen(0, "127.0.0.1", yes);
});
const sensor = () => {
  try {
    return execFileSync(
      "nvidia-smi",
      ["--query-gpu=temperature.gpu,clocks.gr,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  } catch (error) {
    return { error: String(error) };
  }
};
let run;
try {
  run = await launchChrome({
    chromium,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: !args.includes("--headed"),
    extraArgs: ["--enable-unsafe-webgpu", "--enable-dawn-features=allow_unsafe_apis"],
  });
  report.chrome = run.chromeVersion;
  await run.page.setViewportSize({ width: 1920, height: 1080 });
  run.page.on("pageerror", (error) => report.errors.push(String(error)));
  run.page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(message.text());
  });
  await run.page.addInitScript(() => {
    window.__cameraMotionAudit = {
      skyUpdates: [],
      skyTextures: 0,
      liveSkyTextures: 0,
      longTasks: [],
      lightingBuffers: 0,
      liveLightingBuffers: 0,
      noiseUploads: 0,
      duplicateNoiseUploads: 0,
    };
    const lighting = new WeakMap();
    const createBuffer = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (descriptor) {
      const buffer = createBuffer.call(this, descriptor);
      if (descriptor.label === "Final Pixel/lighting directory") {
        const entry = { uploads: 0, destroyed: false };
        lighting.set(buffer, entry);
        window.__cameraMotionAudit.lightingBuffers++;
        window.__cameraMotionAudit.liveLightingBuffers++;
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => {
          if (!entry.destroyed) {
            entry.destroyed = true;
            window.__cameraMotionAudit.liveLightingBuffers--;
          }
          destroy();
        };
      }
      return buffer;
    };
    const writeBuffer = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (buffer, offset, data, ...rest) {
      const entry = lighting.get(buffer);
      if (entry && data.byteLength === 1050624) {
        entry.uploads++;
        window.__cameraMotionAudit.noiseUploads++;
        if (entry.uploads > 1) window.__cameraMotionAudit.duplicateNoiseUploads++;
      }
      return writeBuffer.call(this, buffer, offset, data, ...rest);
    };
    const begin = GPUCommandEncoder.prototype.beginComputePass;
    GPUCommandEncoder.prototype.beginComputePass = function (descriptor = {}) {
      if (descriptor.label === "PhysicalSkyIBL/sky radiance")
        window.__cameraMotionAudit.skyUpdates.push(performance.now());
      return begin.call(this, descriptor);
    };
    const create = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (descriptor) {
      const texture = create.call(this, descriptor);
      if (descriptor.label?.startsWith("PhysicalSkyIBL/")) {
        window.__cameraMotionAudit.skyTextures++;
        window.__cameraMotionAudit.liveSkyTextures++;
        const destroy = texture.destroy.bind(texture);
        let destroyed = false;
        texture.destroy = () => {
          if (!destroyed) {
            destroyed = true;
            window.__cameraMotionAudit.liveSkyTextures--;
          }
          destroy();
        };
      }
      return texture;
    };
    new PerformanceObserver((list) => {
      for (const item of list.getEntries())
        window.__cameraMotionAudit.longTasks.push({ at: item.startTime, ms: item.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  await run.page.goto(`http://127.0.0.1:${server.address().port}/${demo}/index.html`, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await run.page.waitForFunction(
    () =>
      window.dungeonDemo?.report().renderState.frame > 120 &&
      window.dungeonDemo.report().texture?.maximumResidentMinimumMip === 0,
    null,
    { timeout: 120000 },
  );
  await run.page.locator("#profile").evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const scale of [1, 0.667]) {
    await run.page.locator("#render-scale").evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, scale);
    const at = await run.page.evaluate(() => window.dungeonDemo.report().renderState.frame);
    await run.page.waitForFunction((at) => window.dungeonDemo.report().renderState.frame > at + 100, at, {
      timeout: 120000,
    });
    for (const action of ["idle", "rotate", "pan", "zoom"]) {
      const canvas = run.page.locator("canvas").first();
      const bounds = await canvas.boundingBox();
      const x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2;
      await run.page.mouse.move(x, y);
      await canvas.evaluate((element) =>
        element.addEventListener(
          "pointerdown",
          (event) => {
            window.__motionPointerId = event.pointerId;
          },
          { once: true },
        ),
      );
      if (action === "rotate" || action === "pan")
        await run.page.mouse.down({ button: action === "pan" ? "right" : "left" });
      const temperatureBefore = sensor();
      const capture = await run.page.evaluate(
        async ({ action, ticks, x, y }) => {
          const canvas = document.querySelector("canvas");
          const before = window.dungeonDemo.report();
          const started = performance.now();
          const raf = [];
          let previous = started;
          for (let tick = 0; tick < ticks; tick++) {
            const now = await new Promise(requestAnimationFrame);
            raf.push(now - previous);
            previous = now;
            const angle = (tick / 90) * Math.PI * 2;
            if (action === "rotate" || action === "pan") {
              canvas.dispatchEvent(
                new PointerEvent("pointermove", {
                  pointerId: window.__motionPointerId,
                  pointerType: "mouse",
                  buttons: action === "pan" ? 2 : 1,
                  clientX: x + Math.sin(angle) * 100,
                  clientY: y + Math.sin(angle) * 35,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            } else if (action === "zoom") {
              canvas.dispatchEvent(
                new WheelEvent("wheel", { deltaY: Math.cos(angle) * 12, bubbles: true, cancelable: true }),
              );
            }
          }
          const ended = performance.now();
          const after = window.dungeonDemo.report();
          return {
            started,
            ended,
            raf,
            before,
            after,
            audit: structuredClone(window.__cameraMotionAudit),
            submitted: after.renderState.frame - before.renderState.frame,
          };
        },
        { action, ticks, x, y },
      );
      if (action === "rotate" || action === "pan")
        await run.page.mouse.up({ button: action === "pan" ? "right" : "left" });
      capture.action = action;
      capture.scale = scale;
      capture.temperatureBefore = temperatureBefore;
      capture.temperatureAfter = sensor();
      capture.skyUpdates = capture.audit.skyUpdates.filter(
        (at) => at >= capture.started && at < capture.ended,
      ).length;
      capture.fps = (capture.submitted * 1000) / (capture.ended - capture.started);
      report.captures.push(capture);
      console.log(
        JSON.stringify({
          scale,
          action,
          fps: capture.fps,
          skyUpdates: capture.skyUpdates,
          skyTextures: capture.audit.skyTextures,
          liveSkyTextures: capture.audit.liveSkyTextures,
        }),
      );
      await run.page.screenshot({ path: resolve(out, `${scale}-${action}.png`) });
      await run.page.waitForTimeout(1200);
    }
  }
  if (args.includes("--review-vsm")) {
    report.filterReview = [];
    for (const [mode, radius] of [
      ["disk4", 1.5],
      ["gather2x2", 1.5],
      ["point", 1.5],
      ["disk4", 0],
      ["disk4", 1.5],
    ]) {
      await run.page.locator("#vsm-filter").evaluate((input, value) => {
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, mode);
      if (mode === "disk4")
        await run.page.locator("#vsm-radius").evaluate((input, value) => {
          input.value = String(value);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, radius);
      const at = await run.page.evaluate(() => window.dungeonDemo.report().renderState.frame);
      await run.page.waitForFunction((at) => window.dungeonDemo.report().renderState.frame >= at + 64, at);
      const sample = await run.page.evaluate(() => ({
        settings: window.dungeonDemo.report().renderState.vsmSettings,
        radiusDisabled: document.querySelector("#vsm-radius").disabled,
        audit: structuredClone(window.__cameraMotionAudit),
      }));
      if (sample.settings.filterMode !== mode || sample.radiusDisabled !== (mode !== "disk4"))
        throw new Error("VSM controls disagree with the Renderer");
      report.filterReview.push({ mode, radius, ...sample });
      await run.page.screenshot({ path: resolve(out, `filter-${mode}-${radius}.png`) });
    }
  }
  await run.page.evaluate(() => window.dungeonDemo.release());
  await run.page.waitForTimeout(300);
  report.teardown = await run.page.evaluate(() => window.__cameraMotionAudit);
  if (report.teardown.liveSkyTextures !== 0) throw new Error("Sky textures leaked after Renderer release");
  if (report.teardown.liveLightingBuffers !== 0 || report.teardown.duplicateNoiseUploads !== 0)
    throw new Error("VSM lighting/noise allocation leaked or reuploaded immutable bytes");
  if (args.includes("--review-vsm") && report.teardown.noiseUploads === 0)
    throw new Error("Actual VSM never initialized its blue-noise segment");
  if (report.errors.length) throw new Error("Browser reported errors; raw errors retained");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.errors.push(String(error));
  process.exitCode = 1;
} finally {
  if (run) await run.close();
  await new Promise((yes) => server.close(yes));
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, status: report.status, errors: report.errors }));
}
