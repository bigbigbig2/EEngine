// Component diagnostic only: actual half-moment upload/filter -> coupled normal/roughness WGSL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AppearanceGraphBuilder, snapshotAppearanceTexture } from "../../../OEngine/.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../../OEngine/.test-dist/material/AppearanceGraphCompiler.js";
import { cookAppearanceNormalProduct } from "../../../OEngine/.test-dist/material/AppearanceNormalCooker.js";
import { decodeAppearanceNormalMoment, referenceAppearanceNormalMoment } from "../../../OEngine/.test-dist/material/AppearanceNormalFilter.js";
import { sampleAppearanceCookedField } from "../../../OEngine/.test-dist/material/AppearanceMipCooker.js";
import { writeAppearanceAssetPackage, openAppearanceAssetPackage } from "../../../OEngine/.test-dist/assets/AppearanceAssetPackage.js";
import { stageAppearanceAssetUpload } from "../../../OEngine/.test-dist/gpu/AppearanceAssetUpload.js";
import { AppearanceProgramRegistry } from "../../../OEngine/.test-dist/gpu/AppearanceProgramRegistry.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "../../../OEngine/.test-dist/shaders/appearance_normal_filter.js";
import { ShadeTexture } from "../../../OEngine/.test-dist/texture/ShadeTexture.js";

const runtime = process.argv[2];
if (!runtime) throw new Error("Usage: node validation/labs/surface-appearance/appearance-normal-gpu-oracle.mjs <external webgpu runtime directory>");
const { create, globals } = createRequire(resolve(runtime, "package.json"))("webgpu"); Object.assign(globalThis, globals);
const gpu = create(["backend=d3d12"]), adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
assert.ok(adapter); assert.equal(adapter.info.isFallbackAdapter, false);
const device = await adapter.requestDevice(), registry = new AppearanceProgramRegistry(device);
const errors = [], resources = []; let disposing = false, lost;
device.addEventListener("uncapturederror", event => errors.push(event.error.message));
device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
const summary = { evidenceRole: "diagnostic", component: "coupled-vmf-normal-filter", passed: false,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
    description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter } };
const directory = resolve(".local/validation/surface-appearance"); await mkdir(directory, { recursive: true });
const g = new AppearanceGraphBuilder(), uv = g.input("uv", 2, "surface", undefined, "uv0");
const s = g.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), uv);
g.output("normalTS", g.swizzle(s, [0, 1, 2])); g.output("roughness", g.swizzle(s, [3]));
const p = compileAppearanceGraph(g.build());
const product = cookAppearanceNormalProduct(p, [{ momentField: "baseMoment", normalOutput: "normalTS",
  roughnessOutput: "roughness", normal: p.outputs.normalTS, roughness: p.outputs.roughness,
  // Explicit diagnostic budgets: hardware interpolation is measured separately from the CPU cook.
  maxAngleRadians: 0.01, maxRoughnessError: 0.025 }], { width: 5, height: 3, mipCount: 3,
  byteBudget: 4096, validationProbeBudget: 4096, domainMin: [0, 0], domainMax: [1, 1],
  error: { absolute: 0.005, relative: 0 }, storagePrecision: "float16",
  sample: (_binding, position) => position[0] < 0.5 ? [0.6, 0, 0.8, 0.5] : [-0.6, 0, 0.8, 0.8] });
const asset = await openAppearanceAssetPackage(await writeAppearanceAssetPackage(product, {
  uri: "diagnostic/coupled-vmf-normal", contentHash: "a".repeat(64), dependencies: [] }));
const events = () => ({ callbacks: [], addOne(fn) { this.callbacks.push(fn); }, send() { for (const fn of this.callbacks.splice(0)) fn(); } });
const encoder = device.createCommandEncoder({ label: "Appearance/normal-oracle" });
const command = { device, closed: false, onFinished: events(), onAborted: events(),
  allocateTextureUploadBuffer(data) {
    const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data)); buffer.unmap(); resources.push(buffer); return buffer;
  }, copyBufferToTexture(source, destination, size) { encoder.copyBufferToTexture(source, destination, size); },
  finish() { device.queue.submit([encoder.finish()]); this.closed = true; this.onFinished.send(); },
  abort() { this.closed = true; this.onAborted.send(); } };
const texture = device.createTexture({ size: [5, 3, 1], format: "rgba16float", mipLevelCount: 3,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); resources.push(texture);
const lanes = 256, stride = 8;
const output = device.createBuffer({ size: lanes * stride * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
resources.push(output, readback);
const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
  { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: "2d-array", sampleType: "float" } }];
const specials = [[0, 0, 0], [0, 0, -1], [1, 0, 0], [1e-6, 0, 0], [0, 0, 1.0001]];
const source = `@group(0) @binding(0) var<storage, read_write> result: array<f32>;
@group(0) @binding(1) var field_sampler: sampler;
@group(0) @binding(2) var moments: texture_2d_array<f32>;
${APPEARANCE_NORMAL_FILTER_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${lanes}u { return; }
  let coordinate = vec2f(f32(id.x % 37u) / 36.0, f32(id.x % 19u) / 18.0);
  let lod = f32(id.x % 9u) / 4.0;
  var moment = textureSampleLevel(moments, field_sampler, coordinate, 0, lod).xyz;
  ${specials.map((m, i) => `if id.x == ${i}u { moment = vec3f(${m.map(n => Number.isInteger(n) ? `${n}.0` : n).join(", ")}); }`).join("\n")}
  let filtered = appearance_decode_normal_moment(moment);
  let base = id.x * ${stride}u;
  result[base] = moment.x; result[base+1u] = moment.y; result[base+2u] = moment.z;
  result[base+3u] = filtered.normal.x; result[base+4u] = filtered.normal.y; result[base+5u] = filtered.normal.z;
  result[base+6u] = filtered.roughness; result[base+7u] = f32(filtered.direction_valid);
}`;
let lease;
device.pushErrorScope("validation");
try {
  const upload = stageAppearanceAssetUpload(device, asset, new Map([["baseMoment", { texture, layer: 0 }]]), command,
    { maxUploadBytes: 4096, maxResidentBytes: 4096, maxStagingBytes: 4096 });
  lease = registry.acquire({ source, entryPoint: "main", workgroupSize: 64, groups: [entries] });
  const compiled = await lease.ready;
  const sampler = device.createSampler({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
  const pass = encoder.beginComputePass(); pass.setPipeline(compiled.pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: compiled.layouts[0], entries: [
    { binding: 0, resource: { buffer: output } }, { binding: 1, resource: sampler },
    { binding: 2, resource: texture.createView({ dimension: "2d-array" }) }] }));
  pass.dispatchWorkgroups(4); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
  command.finish(); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
  const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
  let maxFilterError = 0, maxDecodeError = 0, maxFinalAngleRadians = 0, maxFinalRoughnessError = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const u = Math.fround((lane % 37) / 36), v = Math.fround((lane % 19) / 18), lod = (lane % 9) / 4;
    const expectedMoment = specials[lane]?.map(Math.fround) ?? sampleAppearanceCookedField(product.fields.baseMoment, u, v, lod);
    const gpuMoment = [...actual.slice(lane * stride, lane * stride + 3)], expected = decodeAppearanceNormalMoment(gpuMoment);
    const dense = referenceAppearanceNormalMoment(expectedMoment);
    const decoded = [...expected.normal, expected.roughness, Number(expected.directionValid)];
    expectedMoment.forEach((value, c) => {
      const error = Math.abs(gpuMoment[c] - value); maxFilterError = Math.max(maxFilterError, error);
      assert.ok(Number.isFinite(gpuMoment[c]), `moment lane ${lane}/${c} is nonfinite`);
    });
    decoded.forEach((value, c) => {
      const got = actual[lane * stride + 3 + c], error = Math.abs(got - value); maxDecodeError = Math.max(maxDecodeError, error);
      assert.ok(Number.isFinite(got) && error <= 0.00001, `decode lane ${lane}/${c}: ${got} vs ${value}`);
    });
    if (dense.directionValid && expected.directionValid) {
      const a = dense.normal, b = [...actual.slice(lane * stride + 3, lane * stride + 6)];
      const cross = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      maxFinalAngleRadians = Math.max(maxFinalAngleRadians, Math.atan2(Math.hypot(...cross), a.reduce((sum, n, c) => sum+n*b[c], 0)));
    } else assert.equal(expected.directionValid, dense.directionValid);
    maxFinalRoughnessError = Math.max(maxFinalRoughnessError, Math.abs(actual[lane * stride + 6] - dense.roughness));
  }
  Object.assign(summary, { maxFilterError, maxDecodeError, maxFinalAngleRadians, maxFinalRoughnessError });
  assert.ok(maxFilterError <= asset.errorBudget.absolute, `GPU texture filter maximum ${maxFilterError}`);
  assert.ok(maxFinalAngleRadians <= asset.normalFilters[0].maxAngleRadians, `GPU final direction error ${maxFinalAngleRadians}`);
  assert.ok(maxFinalRoughnessError <= asset.normalFilters[0].maxRoughnessError, `GPU final roughness error ${maxFinalRoughnessError}`);
  const scope = await device.popErrorScope(); assert.equal(scope, null, scope?.message);
  assert.deepEqual(errors, []); assert.equal(lost, undefined);
  Object.assign(summary, { passed: true, lanes, values: actual.length, upload: upload.evidence,
    filterContract: asset.normalFilters, maxFilterError, maxDecodeError, maxFinalAngleRadians, maxFinalRoughnessError,
    specialDirectionCases: specials.length, qualityScope: "fixture budgets; CPU cook probes do not include hardware filtering error" });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) { if (!command.closed) command.abort(); summary.error = { name: error.name, message: error.message }; throw error; }
finally {
  summary.uncapturedErrors = errors; summary.deviceLost = lost ?? null;
  await writeFile(resolve(directory, "normal-gpu-oracle.json"), JSON.stringify(summary, null, 2));
  disposing = true; lease?.release(); registry.destroy(); for (const resource of resources) resource.destroy(); device.destroy();
}
