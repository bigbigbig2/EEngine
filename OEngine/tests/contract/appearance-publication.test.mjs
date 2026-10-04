import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { GpuAppearancePublication, APPEARANCE_DIRECTORY_STRIDE } from "../../.test-dist/gpu/GpuAppearancePublication.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { encodeGpuTextureRef } from "../../.test-dist/gpu/GpuTextureRefAbi.js";
import { cookAppearanceMipProduct } from "../../.test-dist/material/AppearanceMipCooker.js";
import { writeAppearanceAssetPackage, openAppearanceAssetPackage } from "../../.test-dist/assets/AppearanceAssetPackage.js";
import { bindAppearanceProducts } from "../../.test-dist/material/AppearanceProductBinding.js";
import { surfaceDemandLayout } from "../../.test-dist/gpu/GpuSurfaceDemandAbi.js";

globalThis.GPUShaderStage = { COMPUTE: 4 };
globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8, UNIFORM: 64, INDIRECT: 256 };

const deferred = () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const limits = { maxBindGroups: 4, maxBindingsPerBindGroup: 1000,
  maxComputeWorkgroupSizeX: 256, maxComputeInvocationsPerWorkgroup: 256,
  maxBufferSize: 1e8, maxStorageBufferBindingSize: 1e8, maxUniformBufferBindingSize: 65536,
  maxStorageBuffersPerShaderStage: 16, maxUniformBuffersPerShaderStage: 12,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 4 };
function fixture(auto = false, maxPrograms = 2) {
  const loss = deferred(), compiled = [], buffers = [];
  let scopeDepth = 0, creates = 0;
  const device = { limits: { ...limits }, lost: loss.promise,
    pushErrorScope() { scopeDepth++; }, popErrorScope() { assert.equal(scopeDepth, 1); scopeDepth--; return Promise.resolve(null); },
    createShaderModule({ code }) { creates++; return { code, getCompilationInfo: async () => ({ messages: [] }) }; },
    createBindGroupLayout(value) { return value; },
    createPipelineLayout(value) { return value; },
    createSampler(value) { return { descriptor: value }; },
    createBindGroup(value) { return value; },
    queue: { writeBuffer(buffer, offset, data) { buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset); } },
    createComputePipelineAsync(descriptor) {
      assert.equal(scopeDepth, 0, "no error scope may span async compilation");
      const d = deferred(); compiled.push({ ...d, descriptor });
      if (auto) d.resolve({ descriptor });
      return d.promise;
    },
    createBuffer(descriptor) { const buffer = { ...descriptor, bytes: new Uint8Array(descriptor.size), destroyed: 0,
      destroy() { this.destroyed++; } }; buffers.push(buffer); return buffer; }
  };
  const registry = new AppearanceProgramRegistry(device, { maxPrograms, maxConcurrentCompiles: 1, maxSourceBytes: 200000 });
  const cache = { prepare() { return {}; }, release() {} };
  return { device, registry, loss, compiled, buffers, cache, creates: () => creates };
}
const descriptor = (name = "a") => ({ source: `@compute @workgroup_size(64) fn ${name}() {}`,
  entryPoint: name, workgroupSize: 64, groups: [] });
function command(device) {
  const event = () => ({ callbacks: [], addOne(callback) { this.callbacks.push(callback); },
    send() { for (const callback of this.callbacks.splice(0)) callback(); } });
  const done = deferred();
  const encoded = [];
  return { device, closed: false, gpuDone: done.promise, done, encoded,
    onBeforeFinish: event(), onFinished: event(), onAborted: event(),
    writeBuffer(buffer, offset, data, start, length) { buffer.bytes.set(new Uint8Array(data, start, length), offset); },
    allocateTransientBuffer(usage, size) { return { usage, size, bytes: new Uint8Array(size) }; },
    beginComputePass() {
      const pass = { setPipeline(pipeline) { this.pipeline = pipeline; }, setBindGroup() {},
        dispatchWorkgroupsIndirect() {}, end() { encoded.push(this.pipeline); } };
      return pass;
    },
    finish() { this.onBeforeFinish.send(); this.closed = true; this.onFinished.send(); },
    abort() { this.closed = true; this.onAborted.send(); } };
}
function encodeFields(publication, c) {
  const layout = surfaceDemandLayout(64, Math.max(1, publication.surfaceProgramCount));
  publication.encodeSurfaceFields(c, { geometry: {}, demand: {}, indirect: {}, values: {}, layout,
    textureBanks: [Array.from({ length: 9 }, () => ({}))] });
  return c.encoded;
}

test("registry shares async PSOs, bounds compilation and evicts only unreferenced ready families", async () => {
  const f = fixture();
  const a = f.registry.acquire(descriptor()), again = f.registry.acquire(descriptor());
  const b = f.registry.acquire(descriptor("b"));
  assert.throws(() => f.registry.acquire(descriptor("c")), /capacity exhausted/);
  await tick(); assert.equal(f.compiled.length, 1); assert.equal(f.creates(), 1);
  f.compiled[0].resolve({ id: "a" });
  assert.equal((await a.ready).pipeline, (await again.ready).pipeline);
  a.release(); again.release(); await tick(); assert.equal(f.compiled.length, 2);
  const c = f.registry.acquire(descriptor("c"));
  f.compiled[1].resolve({ id: "b" }); await b.ready; await tick();
  assert.equal(f.compiled.length, 3); f.compiled[2].resolve({ id: "c" }); await c.ready;
  b.release(); c.release(); f.registry.destroy();
});

test("invalid resource profiles reject before any GPU object is created", () => {
  const f = fixture();
  assert.throws(() => f.registry.acquire({ ...descriptor(), workgroupSize: 512 }), /negotiated profile/);
  assert.throws(() => f.registry.acquire({ ...descriptor(), groups: [[
    { binding: 0, visibility: 4, buffer: { type: "storage", minBindingSize: 1e9 } }]] }), /byte limit/);
  assert.throws(() => f.registry.acquire({ ...descriptor(), groups: [Array.from({ length: 17 }, (_, binding) =>
    ({ binding, visibility: 4, buffer: { type: "storage" } }))] }), /storage buffers/);
  assert.equal(f.creates(), 0); f.registry.destroy();
});

test("cancelled queued requests never compile; failed family can retry after release", async () => {
  const f = fixture();
  const a = f.registry.acquire(descriptor()), b = f.registry.acquire(descriptor("b"));
  b.release(); await assert.rejects(b.ready, /cancelled/);
  await tick(); f.compiled[0].reject(new Error("real compile failure"));
  await assert.rejects(a.ready, /real compile failure/); a.release(); await tick();
  const retry = f.registry.acquire(descriptor()); await tick();
  assert.equal(f.compiled.length, 2); f.compiled[1].resolve({}); await retry.ready;
  retry.release(); f.registry.destroy();
});

test("device loss rejects all queued/in-flight waiters immediately and forbids new admission", async () => {
  const f = fixture();
  const a = f.registry.acquire(descriptor()), b = f.registry.acquire(descriptor("b"));
  await tick(); f.loss.resolve({ reason: "unknown", message: "injected" });
  await assert.rejects(a.ready, /GPUDevice lost/); await assert.rejects(b.ready, /GPUDevice lost/);
  assert.throws(() => f.registry.acquire(descriptor()), /GPUDevice lost/);
  f.compiled[0].resolve({}); await tick(); assert.equal(f.compiled.length, 1);
  a.release(); b.release(); assert.equal(f.registry.evidence().programs, 0);
});

function source(value, materialSlot, texture) {
  const g = new AppearanceGraphBuilder(); const p = g.parameter("gain", value);
  const uv = g.input("uv", 2, "surface", undefined, "uv0");
  const binding = snapshotAppearanceTexture(texture, "linear-rgb", [0.2, 0.3], [2, 3], Math.PI / 2,
    undefined, [0.5, 0.5, 1, 1]);
  g.output("field", g.operation("multiply", p, g.swizzle(g.texture(binding, uv), [0])));
  g.output("alpha", g.constant(1));
  return { material: new StandardShadeMaterial(), materialSlot, program: compileAppearanceGraph(g.build()), textureBindingSetId: 0,
    textureRefs: new Map([[texture, encodeGpuTextureRef(0, 1)]]) };
}

async function bakedSource(value, materialSlot) {
  const original = source(value, materialSlot, new ShadeTexture()), p = original.program;
  const product = cookAppearanceMipProduct(p, { baked: p.outputs.field }, { width: 2, height: 2, mipCount: 2,
    byteBudget: 4096, validationProbeBudget: 4096, domainMin: [0, 0], domainMax: [1, 1],
    error: { absolute: 0.001, relative: 0 }, storagePrecision: "float16", sample: () => [0.5, 0.25, 0.75, 1] });
  const asset = await openAppearanceAssetPackage(await writeAppearanceAssetPackage(product, {
    uri: "test/publication-product", contentHash: "a".repeat(64), dependencies: [] }));
  return { ...original, program: bindAppearanceProducts(p, [{ source: p, asset, roots: { baked: p.outputs.field } }]) };
}

test("shared PSO does not merge distinct physical product resource sets; capability preflight precedes asset allocation", async () => {
  const sources = await Promise.all([bakedSource(0.25, 17), bakedSource(0.5, 18)]);
  const f = fixture(true, 32), c = command(f.device), allocations = [], released = [];
  const owner = { acquire(asset) {
    const texture = { asset: asset.runtime.manifest.assetId, createView() { return { texture: this }; } }; allocations.push(texture);
    return { destination: () => ({ texture, layer: 0 }), variation: () => null, release: () => released.push(texture) };
  } };
  const p = new GpuAppearancePublication(f.device, f.registry, sources, c, new Map(), new Map(), undefined, owner, f.cache);
  await p.ready;
  assert.notEqual(p.entries[0].programIndex, p.entries[1].programIndex);
  const encoded = encodeFields(p, command(f.device));
  assert.equal(encoded[0], encoded[1], 'Actual Surface field consumer shares the compiled PSO');
  assert.notEqual(p.entries[0].resourceSetIndex, p.entries[1].resourceSetIndex);
  assert.notEqual(p.entries[0].productTextures[0], p.entries[1].productTextures[0]);
  assert.equal(allocations.length, 2); c.finish(); p.destroy(); assert.equal(released.length, 2); f.registry.destroy();
  const capped = fixture(true); capped.device.limits.maxSampledTexturesPerShaderStage = 0;
  let attempts = 0;
  assert.throws(() => new GpuAppearancePublication(capped.device, capped.registry, sources, command(capped.device),
    new Map(), new Map(), undefined, { acquire() { attempts++; throw new Error("must not allocate"); } }), /textures exceed/);
  assert.equal(attempts, 0); assert.equal(capped.buffers.length, 0); assert.equal(capped.creates(), 0); capped.registry.destroy();
});

test("actual-sized GPU publication shares pipelines while retaining different instance data and snapshot sampling", async () => {
  const f = fixture(true, 32), c = command(f.device), texture = new ShadeTexture();
  const sources = [source(0.25, 17, texture), source(0.5, 18, texture)];
  texture.wrapS = 2; texture.wrapT = 2;
  const p = new GpuAppearancePublication(f.device, f.registry, sources, c, new Map(),
    new Map([[texture, { slot: 12, revision: 43 }]]), undefined, undefined, f.cache);
  assert.throws(() => encodeFields(p, command(f.device)), /open resident frame/);
  await p.ready; c.finish();
  assert.equal(f.compiled.filter(item => item.descriptor.compute.entryPoint === "surface_fields").length, 1,
    "two material instances share one Surface program");
  const constants = new Float32Array(p.constants.bytes.buffer), directory = new Uint32Array(p.directory.bytes.buffer);
  assert.equal(constants[p.entries[0].constantBase], 0.25);
  assert.equal(constants[p.entries[1].constantBase], 0.5);
  assert.equal(directory[0], 17); assert.equal(directory[8], 18);
  assert.equal(p.fields.bytes.byteLength, 4 * 4 * 4);
  assert.equal(p.allocatedBytes, f.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0));
  const route = new DataView(p.routes.bytes.buffer);
  assert.equal(route.getUint32(8, true), 12); assert.equal(route.getUint32(12, true), 43);
  assert.equal(route.getUint32(4, true) & 3, 1, "use authored repeat snapshot, not later mirror mutation");
  assert.ok(Math.abs(route.getFloat32(32, true)) < 1e-6);
  assert.equal(route.getFloat32(36, true), 1); assert.equal(route.getFloat32(48, true), 0.5);
  assert.equal(p.entries[0].programIndex, p.entries[1].programIndex);
  const abort = command(f.device); p.release(abort); abort.abort(); assert.equal(encodeFields(p, command(f.device)).length, 1);
  const release = command(f.device); p.release(release); release.finish();
  assert.ok(f.buffers.every(buffer => buffer.destroyed === 0));
  release.done.resolve(); await tick(); assert.ok(f.buffers.every(buffer => buffer.destroyed === 1));
  assert.throws(() => encodeFields(p, command(f.device)), /open resident frame/); f.registry.destroy();
});

test("aborting a publication rejects its readiness even if a shared driver compile has not settled", async () => {
  const f = fixture(false, 32), c = command(f.device), texture = new ShadeTexture();
  const p = new GpuAppearancePublication(f.device, f.registry, [source(0.4, 1, texture)], c, new Map(), new Map(), undefined, undefined, f.cache);
  await tick(); c.abort(); await assert.rejects(p.ready, /cancelled/);
  assert.ok(f.buffers.every(buffer => buffer.destroyed === 1));
  for (const compiled of f.compiled) compiled.resolve({}); await tick(); assert.equal(f.registry.evidence().referenced, 0);
  f.registry.destroy();
});

test("publication rejects before buffer allocation when negotiated storage capacity is too small", () => {
  const f = fixture(), c = command(f.device);
  f.device.limits.maxStorageBufferBindingSize = 63;
  assert.throws(() => new GpuAppearancePublication(f.device, f.registry,
    [source(0.4, 1, new ShadeTexture())], c, new Map(), new Map()), /negotiated storage limit/);
  assert.equal(f.buffers.length, 0); assert.equal(f.registry.evidence().referenced, 0); f.registry.destroy();
});

test("device loss disposes a resident publication and revokes its pipeline access", async () => {
  const f = fixture(true, 32), c = command(f.device);
  const p = new GpuAppearancePublication(f.device, f.registry,
    [source(0.4, 1, new ShadeTexture())], c, new Map(), new Map(), undefined, undefined, f.cache);
  await p.ready; c.finish(); assert.equal(encodeFields(p, command(f.device)).length, 1);
  f.loss.resolve({ reason: "unknown", message: "resident loss" }); await tick();
  assert.ok(f.buffers.every(buffer => buffer.destroyed === 1));
  assert.throws(() => encodeFields(p, command(f.device)), /open resident frame/);
});
