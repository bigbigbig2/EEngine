// Diagnostic production-component execution; no browser/Surface/performance adoption claim.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppearanceProgramRegistry } from "../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js";
import { GpuAppearancePublication } from "../../../OEngine/.test-dist/gpu/GpuAppearancePublication.js";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../../OEngine/.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js";
import { evaluateCompiledAppearance } from "../../../OEngine/.test-dist/material/AppearanceGraphEvaluation.js";
import { compileCanonicalMaterial } from "../../../OEngine/.test-dist/material/CanonicalMaterial.js";
import { StandardShadeMaterial } from "../../../OEngine/.test-dist/material/StandardShadeMaterial.js";
import { ShadeTexture } from "../../../OEngine/.test-dist/texture/ShadeTexture.js";
import { ShadeImage } from "../../../OEngine/.test-dist/texture/ShadeImage.js";
import { Sampler2D } from "../../../OEngine/.test-dist/texture/Sampler2D.js";
import { encodeGpuTextureRef, decodeGpuTextureRef } from "../../../OEngine/.test-dist/gpu/GpuTextureRefAbi.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node validation/labs/surface-appearance/appearance-resident-gpu-oracle.mjs <external webgpu runtime directory>");
const { create, globals } = createRequire(resolve(runtime, "package.json"))("webgpu");
Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]);
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter); assert.equal(adapter.info.isFallbackAdapter, false);
const device = await adapter.requestDevice();
const registry = new AppearanceProgramRegistry(device);
const uncaptured = []; device.addEventListener("uncapturederror", event => uncaptured.push(event.error.message));
let disposing = false, lost;
device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const artifacts = resolve(".local/validation/surface-appearance");
await mkdir(artifacts, { recursive: true });
const summary = { evidenceRole: "diagnostic", component: "resident-appearance-publication", adapter: {
  vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
  description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter
}, cases: [], passed: false };
const resources = [];
const sourceBytes = new Uint8Array([
  51, 102, 179, 153, 204, 26, 77, 255,
  13, 230, 128, 102, 153, 153, 51, 204
]);
function logicalTexture() {
  const t = ShadeTexture.from(ShadeImage.fromSampler2D(new Sampler2D(sourceBytes, 4, 2, 2)));
  t.minFilter = t.magFilter = t.mipmapFilter = 0;
  return t;
}
function material(value, coated = true) {
  const m = new StandardShadeMaterial();
  for (const role of ["texture_albedo", "texture_normal", "texture_orm", "texture_emissive", "texture_occlusion",
    "texture_specular", "texture_specular_color"]) m[role] = logicalTexture();
  m.diffuse_color.set(value, 0.6, 0.9, 0.8); m.metallic_factor = 0.7; m.roughness_factor = 0.4;
  m.normal_scale = 0.3; m.emissive_factor.set(2, 0.5, 0.1); m.specular_uv_set = 1;
  if (coated) {
    for (const role of ["texture_clearcoat", "texture_clearcoat_roughness", "texture_clearcoat_normal"])
      m[role] = logicalTexture();
    m.clearcoat_factor = 0.9; m.clearcoat_roughness_factor = 0.5; m.clearcoat_normal_scale = 0.7;
    m.clearcoat_normal_uv_set = 2;
  }
  return compileCanonicalMaterial(m).appearance;
}
function affineGraph() {
  const g = new AppearanceGraphBuilder(), t = logicalTexture();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  const binding = snapshotAppearanceTexture(t, "linear-rgb", [0.13, 0.27], [2, 3], Math.PI / 2,
    undefined, [0.5, 0.5, 1, 1]);
  const s = g.texture(binding, uv);
  g.output("rgb", g.operation("multiply", g.swizzle(s, [0, 1, 2]), g.parameter("gain", 0.75)));
  g.output("alpha", g.swizzle(s, [3]));
  return compileAppearanceGraph(g.build());
}
function constantGraph() {
  const g = new AppearanceGraphBuilder(); g.output("hdr", g.parameter("hdr", [0.25, 1, 16]));
  return compileAppearanceGraph(g.build());
}
function events() { return { callbacks: [], addOne(callback) { this.callbacks.push(callback); },
  send() { for (const callback of this.callbacks.splice(0)) callback(); } }; }
function context(encoder) {
  const done = {};
  done.promise = new Promise((yes, no) => { done.resolve = yes; done.reject = no; });
  return { device, closed: false, gpuDone: done.promise, onBeforeFinish: events(), onFinished: events(), onAborted: events(),
    writeBuffer(buffer, offset, data, start, length) {
      const staging = device.createBuffer({ size: length, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint8Array(staging.getMappedRange()).set(new Uint8Array(data, start, length)); staging.unmap();
      resources.push(staging); encoder.copyBufferToBuffer(staging, 0, buffer, offset, length);
    },
    finish() { this.onBeforeFinish.send(); device.queue.submit([encoder.finish()]); this.closed = true;
      this.onFinished.send(); device.queue.onSubmittedWorkDone().then(done.resolve, done.reject); },
    abort() { this.closed = true; this.onAborted.send(); } };
}
function buffer(data, usage = GPUBufferUsage.STORAGE) {
  const value = device.createBuffer({ size: Math.max(data.byteLength, 16), usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength) device.queue.writeBuffer(value, 0, data);
  resources.push(value); return value;
}
const samplers = ["clamp-to-edge", "mirror-repeat", "repeat"].map(address => device.createSampler({
  addressModeU: address, addressModeV: address, minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }))
  .concat(["clamp-to-edge", "mirror-repeat", "repeat"].map(address => device.createSampler({
    addressModeU: address, addressModeV: address, minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest" })));
const banks = Array.from({ length: 9 }, (_, index) => {
  const texture = device.createTexture({ label: `oracle/resident-bank-${index}`, size: [2, 2, 2],
    format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  // These are resident scene-linear values, not author sRGB encoded pixels.
  device.queue.writeTexture({ texture, origin: [0, 0, 1] }, sourceBytes, { bytesPerRow: 8 }, [2, 2, 1]);
  resources.push(texture); return texture.createView({ dimension: "2d-array" });
});
function sample(_binding, uv) {
  const repeat = n => n - Math.floor(n);
  const x = Math.min(Math.floor(repeat(uv[0]) * 2), 1), y = Math.min(Math.floor(repeat(uv[1]) * 2), 1);
  return [...sourceBytes.slice((y * 2 + x) * 4, (y * 2 + x + 1) * 4)].map(n => n / 255);
}

async function run(name, programs, allBanks = false, invalid = false) {
  const texturePublications = new Map();
  const sources = programs.map((program, index) => {
    const refs = new Map(); program.samples.forEach((sample, sampleIndex) => {
      refs.set(sample.binding.texture, invalid ? 0xffffffff : encodeGpuTextureRef(allBanks ? sampleIndex % 9 : 0, 1));
      texturePublications.set(sample.binding.texture, { slot: sampleIndex + 1, revision: 43 });
    });
    return { materialSlot: index + 7, program, textureBindingSetId: 0, textureRefs: refs };
  });
  const encoder = device.createCommandEncoder({ label: name }), command = context(encoder);
  const publication = new GpuAppearancePublication(device, registry, sources, command, new Map(), texturePublications);
  try {
    await publication.ready;
    const outputCount = publication.entries[0].kernel.lowered.outputCount;
    assert.ok(publication.entries.every(entry => entry.programIndex === publication.entries[0].programIndex),
      "different values of one family must share its actual compiled PSO");
    const lanes = 256, inputCount = publication.entries[0].kernel.inputVectorCount;
    const values = new Float32Array(Math.max(lanes * inputCount * 4, 4));
    const tasks = new Uint32Array(lanes * 4);
    const expected = [];
    for (let lane = 0; lane < lanes; lane++) {
      const entry = publication.entries[lane % programs.length];
      const inputs = { uv0: [0.05 + lane / 173, 0.08 + lane / 367], uv1: [0.3 + lane / 503, 0.75],
        uv2: [0.65, 0.07 + lane / 291], vertexColor: [0.1 + lane / 300, 0.7, 0.9] };
      entry.program.inputs.forEach((input, index) => {
        values.set(inputs[input.name], (lane * inputCount + index) * 4);
      });
      entry.program.samples.forEach((_sample, index) => {
        values.set([0.001, 0, 0, 0, 0, 0.001, 0, 0],
          (lane * inputCount + entry.program.inputs.length + index * 2) * 4);
      });
      tasks.set([entry.constantBase, entry.routeBase, lane * inputCount, lane * outputCount], lane * 4);
      const result = evaluateCompiledAppearance(entry.program, { inputs,
        sample: (binding, uv) => invalid ? binding.fallback : sample(binding, uv) });
      expected.push(...Object.values(result).flat());
    }
    const taskBuffer = buffer(tasks), inputBuffer = buffer(values);
    const output = device.createBuffer({ size: lanes * outputCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }); resources.push(output);
    const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    resources.push(readback);
    const dispatch = buffer(new Uint32Array([lanes, 0, 0, 0]), GPUBufferUsage.UNIFORM);
    const compiled = publication.program(0);
    const bind = device.createBindGroup({ layout: compiled.layouts[0], entries:
      [publication.constants, publication.routes, taskBuffer, inputBuffer, output, dispatch]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const pass = encoder.beginComputePass({ label: name }); pass.setPipeline(compiled.pipeline); pass.setBindGroup(0, bind);
    if (compiled.layouts.length > 1) {
      const mask = publication.entries[0].kernel.bankMask;
      const entries = compiled.layouts.length > 1 ? publication.entries[0].kernel.descriptor.groups[1]
        .map(entry => ({ binding: entry.binding,
          resource: entry.binding < 9 ? banks[entry.binding] : samplers[entry.binding - 9] })) : [];
      pass.setBindGroup(1, device.createBindGroup({ layout: compiled.layouts[1], entries }));
    }
    pass.dispatchWorkgroups(Math.ceil(lanes / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    command.finish(); await command.gpuDone;
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
    let maximum = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(actual[i] - expected[i]); maximum = Math.max(maximum, error);
      assert.ok(Number.isFinite(actual[i]) && error <= 2e-5 * Math.max(1, Math.abs(expected[i])),
        `${name} value ${i}: ${actual[i]} vs ${expected[i]} error ${error}`);
    }
    summary.cases.push({ name, lanes, values: expected.length, materialInstances: programs.length,
      sharedProgramCount: new Set(publication.entries.map(entry => entry.programIndex)).size,
      bankMask: publication.entries[0].kernel.bankMask, publicationBytes: publication.allocatedBytes, maxAbsoluteError: maximum });
  } catch (error) { if (!command.closed) command.abort(); throw error; }
  finally { publication.destroy(); }
}

device.pushErrorScope("validation");
try {
  await run("coated-two-instances-one-pso-multi-uv", [material(0.3), material(0.7)]);
  await run("coated-all-nine-bank-bindings", [material(0.4)], true);
  await run("affine-route-and-linear-alpha", [affineGraph()]);
  await run("invalid-resident-role-fallback", [affineGraph()], false, true);
  await run("uniform-no-texture-profile", [constantGraph()]);
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message);
  assert.deepEqual(uncaptured, []); assert.equal(lost, undefined);
  summary.registry = registry.evidence(); summary.passed = true;
  console.log(JSON.stringify(summary, null, 2));
} catch (error) { summary.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
finally {
  summary.uncapturedErrors = uncaptured; summary.deviceLost = lost ?? null;
  await writeFile(resolve(artifacts, "resident-gpu-oracle.json"), JSON.stringify(summary, null, 2));
  disposing = true; registry.destroy(); for (const resource of resources) resource.destroy(); device.destroy();
}
