import assert from "node:assert/strict";
import test from "node:test";
import { PhysicalSkyIblResources } from "../../.test-dist/render/environment/PhysicalSkyIblResources.js";

globalThis.GPUTextureUsage = { STORAGE_BINDING: 1, TEXTURE_BINDING: 2 };
globalThis.GPUBufferUsage = { UNIFORM: 1 };

function fixture() {
  const textures = [];
  const passes = [];
  let failTexture = null;
  const device = {
    limits: { maxTextureDimension2D: 4096, maxComputeWorkgroupsPerDimension: 65535 },
    createSampler: () => ({}),
    createShaderModule: (descriptor) => descriptor,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (descriptor) => descriptor,
    createBuffer(descriptor) {
      const data = new ArrayBuffer(descriptor.size);
      return { getMappedRange: () => data, unmap() {}, destroy() {} };
    },
    createTexture(descriptor) {
      if (failTexture === descriptor.label) throw new Error("injected allocation failure");
      const texture = {
        label: descriptor.label,
        destroyed: false,
        destroyCalls: 0,
        createView: () => ({ texture }),
        destroy() {
          this.destroyed = true;
          this.destroyCalls++;
        }
      };
      textures.push(texture);
      return texture;
    }
  };
  const encoder = {
    beginComputePass(descriptor) {
      passes.push(descriptor.label);
      return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
    }
  };
  const luts = { transmittance: {}, scattering: {}, higherOrderScattering: {} };
  const sampler = {};
  const snapshot = {
    lutGeneration: 1,
    worldToUnit: 0.001,
    sunDirectionWorld: [0, 1, 0],
    skyLuminanceScale: 1
  };
  const owner = new PhysicalSkyIblResources(device);
  return {
    owner,
    textures,
    passes,
    luts,
    sampler,
    snapshot,
    record(position, input = snapshot, sources = luts, sampling = sampler) {
      const before = passes.length;
      owner.record(encoder, sources, sampling, input, position);
      return passes.length - before;
    },
    fail(label) {
      failTexture = label;
    }
  };
}

test("sky revisit publishes immutable output without re-encoding; aborted hits preserve the active probe", async () => {
  const f = fixture();
  assert.equal(f.record([0, 0, 0]), 18);
  const a = f.owner.views;
  f.owner.commit(Promise.resolve());
  assert.equal(f.record([25, 0, 0]), 17);
  const b = f.owner.views;
  f.owner.commit(Promise.resolve());
  assert.equal(f.record([0, 0, 0]), 0);
  assert.equal(f.owner.views.specular, a.specular);
  f.owner.abort();
  assert.equal(f.owner.views.specular, b.specular);
  assert.equal(a.specular.texture.destroyed, false);
  assert.equal(f.record([0, 0, 0]), 0);
  f.owner.commit(Promise.resolve());
  assert.equal(f.owner.views.diffuse, a.diffuse);
  f.owner.destroy();
  await Promise.resolve();
  assert.ok(f.textures.every((texture) => texture.destroyCalls === 1));
});

test("sky cache is four-entry LRU; eviction waits for the covering submission fence", async () => {
  const f = fixture();
  const outputs = [];
  for (const x of [0, 25, 50, 75]) {
    f.record([x, 0, 0]);
    outputs.push(f.owner.views.specular.texture);
    f.owner.commit(Promise.resolve());
  }
  f.record([0, 0, 0]);
  f.owner.commit(Promise.resolve());
  assert.equal(f.record([100, 0, 0]), 17);
  let complete;
  f.owner.commit(
    new Promise((resolve) => {
      complete = resolve;
    })
  );
  assert.ok(outputs.every((texture) => !texture.destroyed));
  complete();
  await Promise.resolve();
  assert.equal(outputs[1].destroyed, true);
  assert.equal(outputs[0].destroyed, false);
  assert.equal(f.record([0, 0, 0]), 0);
  f.owner.abort();
  assert.equal(f.record([25, 0, 0]), 17);
  f.owner.abort();
  f.owner.destroy();
});

test("sky cache key includes exact producer values, LUT identity and sampler", () => {
  const f = fixture();
  f.record([0, 0, 0]);
  f.owner.commit(Promise.resolve());
  for (const [position, snapshot, luts, sampler] of [
    [[0, 0, 0], { ...f.snapshot, skyLuminanceScale: 1.0001 }, f.luts, f.sampler],
    [[0, 0, 0], { ...f.snapshot, sunDirectionWorld: [0.0001, 1, 0] }, f.luts, f.sampler],
    [[0, 0, 0], { ...f.snapshot, worldToUnit: 0.002 }, f.luts, f.sampler],
    [[0, 0, 0], { ...f.snapshot, lutGeneration: 2 }, f.luts, f.sampler],
    [[0, 0, 0], f.snapshot, { ...f.luts, scattering: {} }, f.sampler],
    [[0, 0, 0], f.snapshot, f.luts, {}],
    [[-0, 0, 0], f.snapshot, f.luts, f.sampler]
  ]) {
    assert.equal(f.record(position, snapshot, luts, sampler), 17);
    f.owner.abort();
  }
  assert.equal(f.record([0, 0, 0]), 0);
  f.owner.abort();
  f.owner.destroy();
});

test("failed sky allocation rolls back partial resources and allows retry", () => {
  const f = fixture();
  f.record([0, 0, 0]);
  f.owner.commit(Promise.resolve());
  const active = f.owner.views.specular;
  f.fail("PhysicalSkyIBL/diffuse irradiance");
  assert.throws(() => f.record([25, 0, 0]), /allocation failure/);
  assert.equal(f.owner.hasPending, false);
  assert.equal(f.owner.views.specular, active);
  assert.ok(f.textures.slice(-2).every((texture) => texture.destroyed));
  f.fail(null);
  assert.equal(f.record([25, 0, 0]), 17);
  f.owner.abort();
  f.owner.destroy();
});

test("destroy includes cached, pending and fence-retired probes exactly once", async () => {
  const f = fixture();
  let complete;
  const done = new Promise((resolve) => {
    complete = resolve;
  });
  for (const x of [0, 25, 50, 75, 100]) {
    f.record([x, 0, 0]);
    f.owner.commit(done);
  }
  f.record([125, 0, 0]);
  f.owner.destroy();
  f.owner.destroy();
  complete();
  await Promise.resolve();
  assert.ok(f.textures.every((texture) => texture.destroyCalls === 1));
  assert.throws(() => f.record([0, 0, 0]), /destroyed/);
});
