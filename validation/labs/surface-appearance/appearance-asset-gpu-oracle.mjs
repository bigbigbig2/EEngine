// Component diagnostic: cooked asset -> transactional buffer/texture copies -> actual GPU filtering.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../../OEngine/.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js";
import { cookAppearanceMipProduct, sampleAppearanceCookedField } from "../../../OEngine/.test-dist/material/AppearanceMipCooker.js";
import { writeAppearanceAssetPackage, openAppearanceAssetPackage } from "../../../OEngine/.test-dist/assets/AppearanceAssetPackage.js";
import { stageAppearanceAssetUpload } from "../../../OEngine/.test-dist/gpu/AppearanceAssetUpload.js";
import { AppearanceProgramRegistry } from "../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js";
import { ShadeTexture } from "../../../OEngine/.test-dist/texture/ShadeTexture.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node validation/labs/surface-appearance/appearance-asset-gpu-oracle.mjs <external webgpu runtime directory>");
const { create, globals } = createRequire(resolve(runtime, "package.json"))("webgpu"); Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]), adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter); assert.equal(adapter.info.isFallbackAdapter, false);
const device = await adapter.requestDevice(), registry = new AppearanceProgramRegistry(device);
const errors = [], resources = []; let disposing = false, lost;
device.addEventListener("uncapturederror", event => errors.push(event.error.message));
device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const summary = { evidenceRole: "diagnostic", component: "cooked-appearance-asset", passed: false,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
    description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter } };
const directory = resolve(".local/validation/surface-appearance"); await mkdir(directory, { recursive: true });

const g = new AppearanceGraphBuilder(), uv = g.input("uv0", 2, "surface", undefined, "uv0");
const sample = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
for (const [name, channels] of [["r", [0]], ["rg", [0, 1]], ["rgb", [0, 1, 2]], ["rgba", [0, 1, 2, 3]]])
  g.output(name, g.swizzle(sample, channels));
g.output("hdrConstant", g.constant([16, -0, 0.25]));
const program = compileAppearanceGraph(g.build());
const product = cookAppearanceMipProduct(program, program.outputs, { width: 5, height: 3, mipCount: 3,
  byteBudget: 4096, validationProbeBudget: 4096, domainMin: [2, 4], domainMax: [6, 8],
  error: { absolute: 0.025, relative: 0 }, storagePrecision: "float16",
  sample: (_binding, position, footprint) => [0.125 + footprint.chartLod * 0.125 + position[0] * 0.01,
    0.375 + position[1] * 0.005, 0.75, 1] });
const asset = await openAppearanceAssetPackage(await writeAppearanceAssetPackage(product, {
  uri: "diagnostic/half-appearance-fields", contentHash: "a".repeat(64), dependencies: [] }));
const events = () => ({ callbacks: [], addOne(fn) { this.callbacks.push(fn); }, send() { for (const fn of this.callbacks.splice(0)) fn(); } });
const encoder = device.createCommandEncoder({ label: "Appearance/asset-oracle" });
const command = { device, closed: false, onFinished: events(), onAborted: events(),
  allocateTextureUploadBuffer(data) {
    const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data)); buffer.unmap(); resources.push(buffer); return buffer;
  }, copyBufferToTexture(source, destination, size) { encoder.copyBufferToTexture(source, destination, size); },
  finish() { device.queue.submit([encoder.finish()]); this.closed = true; this.onFinished.send(); },
  abort() { this.closed = true; this.onAborted.send(); } };
const destinations = new Map();
for (const field of asset.fields) if (field.format !== null) {
  const texture = device.createTexture({ label: field.name, size: [5, 3, 3], format: field.format, mipLevelCount: 3,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  resources.push(texture); destinations.set(field.name, { texture, layer: 2 });
}
const lanes = 256, stride = asset.fields.reduce((sum, field) => sum + field.width, 0);
const output = device.createBuffer({ size: lanes * stride * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
resources.push(output, readback);
const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }];
let declarations = "", assignments = "", slot = 0, binding = 2;
const floatLiteral = n => Object.is(n, -0) ? "-0.0" : Number.isInteger(n) ? `${n}.0` : String(n);
for (const [index, field] of asset.fields.entries()) {
  if (field.format !== null) {
    entries.push({ binding, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d-array", sampleType: "float" } });
    declarations += `@group(0) @binding(${binding++}) var field_${index}: texture_2d_array<f32>;\n`;
    assignments += `let value_${index} = textureSampleLevel(field_${index}, field_sampler, coordinate, 2, lod);\n`;
  }
  for (let channel = 0; channel < field.width; channel++) assignments +=
    `result[id.x * ${stride}u + ${slot++}u] = ${field.format === null
      ? floatLiteral(field.constant[channel]) : `value_${index}[${channel}]`};\n`;
}
const source = `@group(0) @binding(0) var<storage, read_write> result: array<f32>;
@group(0) @binding(1) var field_sampler: sampler;
${declarations}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${lanes}u { return; }
  let coordinate = vec2f(f32(id.x % 37u) / 36.0, f32(id.x % 19u) / 18.0);
  let lod = f32(id.x % 9u) / 4.0;
  ${assignments}
}`;

device.pushErrorScope("validation");
let lease;
try {
  const upload = stageAppearanceAssetUpload(device, asset, destinations, command,
    { maxUploadBytes: 4096, maxResidentBytes: 4096, maxStagingBytes: 4096 });
  lease = registry.acquire({ source, entryPoint: "main", workgroupSize: 64, groups: [entries] });
  const compiled = await lease.ready;
  const sampler = device.createSampler({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
  const bindings = [{ binding: 0, resource: { buffer: output } }, { binding: 1, resource: sampler }];
  binding = 2;
  for (const field of asset.fields) if (field.format !== null) bindings.push({ binding: binding++,
    resource: destinations.get(field.name).texture.createView({ dimension: "2d-array" }) });
  const pass = encoder.beginComputePass(); pass.setPipeline(compiled.pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: compiled.layouts[0], entries: bindings }));
  pass.dispatchWorkgroups(4); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
  command.finish(); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
  const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
  let maximum = 0, maximumSourceError = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const u = Math.fround((lane % 37) / 36), v = Math.fround((lane % 19) / 18), lod = (lane % 9) / 4;
    const expected = asset.fields.flatMap(field => sampleAppearanceCookedField(product.fields[field.name], u, v, lod));
    const originalSample = [0.125 + lod * 0.125 + (2 + u * 4) * 0.01, 0.375 + (4 + v * 4) * 0.005, 0.75, 1];
    const original = asset.fields.flatMap(field => field.constant ?? originalSample.slice(0, field.width));
    expected.forEach((value, channel) => {
      const error = Math.abs(actual[lane * stride + channel] - value); maximum = Math.max(maximum, error);
      assert.ok(Number.isFinite(actual[lane * stride + channel]) && error <= 0.0003,
        `lane ${lane} channel ${channel}: ${actual[lane * stride + channel]} vs ${value}, error ${error}`);
      const sourceError = Math.abs(actual[lane * stride + channel] - original[channel]);
      maximumSourceError = Math.max(maximumSourceError, sourceError);
      assert.ok(sourceError <= asset.errorBudget.absolute, "actual GPU filtered field must satisfy the declared source budget");
    });
  }
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message);
  assert.deepEqual(errors, []); assert.equal(lost, undefined);
  assert.equal(upload.residency.evidence().residentChunkCount, 12);
  Object.assign(summary, { passed: true, lanes, values: actual.length, formats: asset.fields.map(field => field.format),
    upload: upload.evidence, cookedValidation: product.validation, maxAbsoluteFilterError: maximum,
    maxAbsoluteSourceError: maximumSourceError });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) { if (!command.closed) command.abort(); summary.error = { name: error.name, message: error.message }; throw error; }
finally {
  summary.uncapturedErrors = errors; summary.deviceLost = lost ?? null;
  await writeFile(resolve(directory, "asset-gpu-oracle.json"), JSON.stringify(summary, null, 2));
  disposing = true; lease?.release(); registry.destroy(); for (const resource of resources) resource.destroy(); device.destroy();
}
