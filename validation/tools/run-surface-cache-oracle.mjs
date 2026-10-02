import assert from "node:assert/strict";
import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Numerical GPU regression against the actual production shader modules.
const root = process.cwd(), out = resolve(root, ".local/validation/surface-p0p5-cache-oracle");
await mkdir(out, { recursive: true });
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"), clearScreen: false,
  server: { host: "127.0.0.1", port: 4187, strictPort: true, fs: { allow: [root] } },
  plugins: [{ name: "surface-oracle-host", configureServer(dev) {
    dev.middlewares.use("/oracle", (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Surface cache GPU oracle</title>"); });
  } }] });
const report = { evidenceRole: "diagnostic", accepted: false, cases: [], errors: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: false,
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4187/oracle");
  report.cases = await page.evaluate(async () => {
    const base = "/@fs/D:/code/EEngine/OEngine/src/";
    const [{ SurfaceCacheIdentityPass }, { SurfaceDependencyEpochPass }, { SurfaceMaterialCachePass }, { PACKED_CAMERA_TYPE },
      { GPU_FRAME_INSTANCE_STRIDE }, { GPU_SHADING_MATERIAL_RECORD_STRIDE }] = await Promise.all([
      import(base + "render/surface/SurfaceCacheIdentityPass.ts"), import(base + "render/surface/SurfaceDependencyEpochPass.ts"),
      import(base + "render/surface/SurfaceMaterialCachePass.ts"), import(base + "shaders/packed_camera.ts"),
      import(base + "gpu/GpuFrameInstanceAbi.ts"), import(base + "gpu/GpuShadingMaterialAbi.ts")]);
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
    const errors = []; device.addEventListener("uncapturederror", e => errors.push(e.error.message));
    device.pushErrorScope("validation");
    const owner = new SurfaceCacheIdentityPass(device, {}), residency = new SurfaceDependencyEpochPass(device, {});
    const material = new SurfaceMaterialCachePass(device, {});
    const resources = [], cases = [];
    const buffer = (size, uniform = false) => {
      const b = device.createBuffer({ size, usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      resources.push(b); return b;
    };
    const write = (b, words, offset = 0) => device.queue.writeBuffer(b, offset, new Uint32Array(words));
    const run = (pipeline, entries) => {
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end(); device.queue.submit([encoder.finish()]);
    };
    const bindings = list => list.map((b, binding) => ({ binding, resource: { buffer: b } }));
    const read = async b => {
      const copy = device.createBuffer({ size: b.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(b, 0, copy, 0, b.size); device.queue.submit([encoder.finish()]);
      await copy.mapAsync(GPUMapMode.READ); const result = [...new Uint32Array(copy.getMappedRange())]; copy.unmap(); copy.destroy(); return result;
    };
    const check = (name, actual, expected) => {
      cases.push({ name, actual, expected });
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    };
    const settings = buffer(16, true), work = buffer(32), counts = buffer(16), meshlets = buffer(56), instances = buffer(GPU_FRAME_INSTANCE_STRIDE);
    const keys = buffer(52), view = buffer(PACKED_CAMERA_TYPE.size + 4), camera = buffer(PACKED_CAMERA_TYPE.size, true);
    write(settings, [0, 1, 1, 1]); write(counts, [1]); write(meshlets, [1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    run(owner.viewPipeline, bindings([camera, view]));
    const identity = async name => { run(owner.pipeline, bindings([settings, work, counts, meshlets, instances, keys, view])); return (await read(work))[7]; };
    check("cold geometry witness", await identity(), 1);
    check("unchanged geometry witness", await identity(), 5);
    write(camera, [1], 0); run(owner.viewPipeline, bindings([camera, view]));
    check("one camera bit invalidates (including sub-epsilon jitter)", await identity(), 1);
    check("camera settles", await identity(), 5);
    write(instances, [16], 8); check("double-sided flags invalidate", await identity(), 1);
    write(instances, [7], 160); check("dynamic/transform revision invalidates", await identity(), 1);
    write(meshlets, [2], 52); check("LOD/profile invalidates", await identity(), 1);
    write(keys, [0xffffffff], 48); check("saturated geometry epoch fails closed", await identity(), 1);
    check("saturated epoch never aliases", await identity(), 1);
    const current = buffer(16), state = buffer(64);
    const dependency = async () => { run(residency.pipeline, bindings([current, state])); return (await read(state))[0]; };
    check("initial residency", await dependency(), 1); check("unchanged residency", await dependency(), 1);
    write(current, [2], 8); check("residency change", await dependency(), 2);
    write(state, [0xffffffff]); write(current, [3], 8); check("residency epoch saturation", await dependency(), 0xffffffff);

    const ms = buffer(48, true), versions = buffer(64), cache = buffer(76), values = buffer(48), misses = buffer(8);
    const counters = buffer(48), hit = buffer(4), lookup = buffer(4), publication = buffer(80), materials = buffer(GPU_SHADING_MATERIAL_RECORD_STRIDE);
    const visibility = device.createTexture({ size: [1, 1], format: "r32uint", usage: GPUTextureUsage.TEXTURE_BINDING });
    const fields = device.createTexture({ size: [1, 1, 6], format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING });
    const pub = new Uint32Array(20).fill(0xffffffff); pub.set([0, 0, 4, 10, 0, 1, 2, 3]);
    write(publication, pub); write(ms, [1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0]);
    write(versions, [1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 2, 1, 0, 0, 8]);
    write(cache, [10, 0, 3, 4, 1, 1, 1, 1]); write(keys, [3], 48); write(state, [4]); write(work, [5], 28);
    const lookupEntries = [ms, visibility.createView(), work, meshlets, versions, state, cache, values, misses, counters, hit,
      fields.createView({ dimension: "2d-array" }), counts, lookup, publication, materials, keys]
      .map((resource, binding) => ({ binding, resource: binding === 1 || binding === 11 ? resource : { buffer: resource } }));
    const missing = async () => { write(counters, new Uint32Array(12)); run(material.lookupPipeline, lookupEntries); return (await read(work))[4]; };
    check("dynamic field always misses", await missing(), 8);
    write(versions, [2]); check("parameter invalidates only its field", await missing(), 9); write(versions, [1]);
    write(keys, [4], 48); check("camera/geometry preserves material-only field", await missing(), 10); write(keys, [3], 48);
    write(state, [5]); check("residency invalidates only texture field", await missing(), 12); write(state, [4]);
    write(publication, [0xffffffff], 28); check("all stable fields hit", await missing(), 0);
    check("hit mask published", (await read(hit))[0], 1);
    write(publication, [11], 12); check("publication replacement also clears absent fields", await missing(), 0x7fff);

    const { SurfaceLightingWorkPass } = await import(base + "render/surface/SurfaceLightingWorkPass.ts");
    const lighting = new SurfaceLightingWorkPass(device, {});
    const ls = buffer(80, true), geometry = buffer(192), ao = buffer(4), signalCache = buffer(32);
    const packets = [buffer(16), buffer(16), buffer(16), buffer(16)], queue = buffer(8), dirty = buffer(32), lightingCounters = buffer(96);
    write(ls, [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0]);
    write(geometry, [0x3f800000], 28); write(ao, [255]); write(work, [0, 0, 0, 11, 0, 0, 0, 5]);
    const planEntries = bindings([ls, geometry, work, counts, ao, keys, signalCache, ...packets, queue, dirty, lightingCounters]);
    const plan = async () => {
      write(dirty, new Uint32Array(8)); write(lightingCounters, new Uint32Array(24));
      run(lighting.planPipeline, planEntries); run(lighting.finalizePipeline, bindings([dirty]));
      const result = await read(dirty), item = await read(queue);
      return [result[0], result[4], result[0] ? item[1] : 0];
    };
    check("cold signal queues all enabled lobes", await plan(), [1, 1, 11]);
    check("signal hit dispatches zero heavy workgroups", await plan(), [0, 0, 0]);
    write(ao, [128]); check("AO change queues only IBL", await plan(), [1, 1, 8]);
    write(ls, [2], 68); check("light revision queues only direct", await plan(), [1, 1, 3]);
    write(ls, [2], 64); check("environment revision queues direct solar and IBL", await plan(), [1, 1, 11]);
    write(work, [15], 12); check("coat feature change initializes all packets", await plan(), [1, 1, 15]);
    write(ao, [64]); check("coat combined direct/IBL refresh remains complete", await plan(), [1, 1, 15]);
    write(ls, [1], 28); check("VSM direct conservatively refreshes", await plan(), [1, 1, 15]);
    write(geometry, [0], 28); check("invalid geometry never queues shading", await plan(), [0, 0, 0]);
    check("invalid geometry clears packet validity", (await read(packets[0]))[3], 0);
    const error = await device.popErrorScope(); if (error || errors.length) throw new Error(error?.message ?? errors.join("\n"));
    owner.destroy(); material.destroy(); lighting.destroy(); for (const b of resources) b.destroy(); visibility.destroy(); fields.destroy(); device.destroy();
    return cases;
  });
  assert(report.cases.length >= 20);
} catch (error) { report.errors.push(String(error)); }
finally {
  await browser?.close(); await server.close(); await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (report.errors.length) process.exitCode = 1;
}
