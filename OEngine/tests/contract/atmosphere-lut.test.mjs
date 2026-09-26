import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import "../webgpu-test-globals.mjs";
import { AtmosphereLutResources } from "../../.test-dist/render/environment/AtmosphereLutResources.js";
import { PhysicalEnvironmentRuntime } from "../../.test-dist/render/environment/PhysicalEnvironmentRuntime.js";
globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
globalThis.GPUTextureUsage = { STORAGE_BINDING: 4, TEXTURE_BINDING: 8, COPY_SRC: 16 };

test("Non-Geospatial port has no direct or transitive Takram npm dependency", () => {
  const lock = JSON.parse(readFileSync(new URL("../../../tools/atmosphere-port/package-lock.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(lock.packages).some(name => name.includes("node_modules/@takram/")), false);
  const manifest = JSON.parse(readFileSync(new URL("../../../tools/atmosphere-port/sources.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.some(file => file.path.endsWith("NonGeospatial-Story.tsx")));
});

test("Takram copied assets match pinned LFS objects, not pointer files", () => {
  const root = new URL("../../src/render/assets/takram/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("provenance.json", root), "utf8"));
  for (const file of manifest.files) {
    const data = readFileSync(new URL(file.path, root));
    assert.equal(data.length, file.bytes, file.path);
    assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256, file.path);
  }
});

function harness() {
  const dispatches = [];
  let destroyed = 0;
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048,
      maxStorageTexturesPerShaderStage: 4, maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeZ: 64, maxComputeWorkgroupStorageSize: 16384 },
    createTexture: () => ({ createView: () => ({}), destroy: () => destroyed++ }),
    createSampler: () => ({}),
    createBuffer: () => ({ getMappedRange: () => new ArrayBuffer(96), unmap() {}, destroy: () => destroyed++ }),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({})
  };
  const encoder = { beginComputePass: ({ label }) => ({
    setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: (...size) => dispatches.push([label, size]), end() {}
  }) };
  return { device, encoder, dispatches, destroyed: () => destroyed };
}

test("aborted LUT encoding is regenerated; only successful submission publishes the complete generation", () => {
  const h = harness();
  const luts = new AtmosphereLutResources(h.device);
  const first = luts.record(h.encoder);
  assert.equal(luts.ready, false);
  assert.throws(() => luts.record(h.encoder), /recorded/);
  luts.abort(first);
  const second = luts.record(h.encoder);
  assert.throws(() => luts.commit(first), /Stale/);
  luts.commit(second);
  assert.equal(luts.ready, true);
  assert.equal(luts.record(h.encoder), null);
  assert.deepEqual(h.dispatches.slice(0, 4), [
    ["Atmosphere/Transmittance", [32, 8, 1]],
    ["Atmosphere/MultipleScattering", [64, 64, 1]],
    ["Atmosphere/Scattering", [64, 32, 8]],
    ["Atmosphere/Irradiance", [8, 2, 1]]
  ]);
  assert.equal(h.dispatches.length, 8);
  luts.destroy(); luts.destroy();
  assert.equal(h.destroyed(), 6);
  assert.throws(() => luts.record(h.encoder), /destroyed/);
});

test("unsupported atmosphere limits fail before allocating resources", () => {
  const h = harness();
  h.device.limits.maxComputeWorkgroupSizeZ = 32;
  h.device.createTexture = () => assert.fail("allocation before capability check");
  assert.throws(() => new AtmosphereLutResources(h.device), /limits/);
});

test("sun and sky edits publish parameters without regenerating the fixed Earth LUT", () => {
  const h = harness();
  const environment = new PhysicalEnvironmentRuntime(h.device);
  const initial = { lutGeneration: 1, worldToUnit: 0.001,
    sunDirectionWorld: [0, 1, 0], sunIrradiance: [1, 1, 1],
    skyLuminanceScale: 1, shadowLength: [0, 0] };
  const first = environment.record(h.encoder, initial);
  environment.commit(first);
  assert.equal(h.dispatches.length, 4);
  const second = environment.record(h.encoder, { ...initial,
    sunIrradiance: [2, 1, 1], skyLuminanceScale: 1.5 });
  let parameters;
  environment.writeParameters((_buffer, data) => { parameters = new DataView(data); });
  assert.equal(parameters.getFloat32(16, true), 2);
  assert.equal(parameters.getFloat32(32, true), 1.5);
  environment.commit(second);
  assert.equal(h.dispatches.length, 4);
  environment.destroy();
});

test("replaced LUT generation retires only after the submitted frame completes", async () => {
  const h = harness();
  let complete;
  h.device.queue = { onSubmittedWorkDone: () => new Promise(resolve => { complete = resolve; }) };
  const environment = new PhysicalEnvironmentRuntime(h.device);
  const snapshot = { lutGeneration: 1, worldToUnit: 0.001,
    sunDirectionWorld: [0, 1, 0], sunIrradiance: [1, 1, 1],
    skyLuminanceScale: 1, shadowLength: [0, 0] };
  environment.commit(environment.record(h.encoder, snapshot));
  environment.commit(environment.record(h.encoder, { ...snapshot, lutGeneration: 2 }));
  assert.equal(h.destroyed(), 0);
  complete();
  await Promise.resolve();
  assert.equal(h.destroyed(), 6);
  environment.destroy();
});
