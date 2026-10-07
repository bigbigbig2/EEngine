import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { SurfaceFrameResources } from "../../.test-dist/render/surface/SurfaceFrameResources.js";

globalThis.GPUBufferUsage ??= { STORAGE: 4 };

test("Surface queue-ordered allocation is shared and resize retirement waits for GPU completion", async () => {
  const allocations = [];
  const device = {
    limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
    createBuffer(descriptor) {
      const resource = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      allocations.push(resource);
      return resource;
    },
  };
  const owner = new SurfaceFrameResources(device);
  const graph = { import_resource: (_name, _descriptor, binding) => binding };
  const bind = (_name, resolve) => resolve;
  owner.prepare(4, 2);
  const originalRecipe = owner.importBuffer(graph, bind, "records", 64, GPUBufferUsage.STORAGE);
  const a = originalRecipe();
  let complete;
  owner.commit(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  owner.prepare(4, 2);
  assert.equal(originalRecipe(), a, "in-flight frames use the same queue-ordered physical allocation");
  owner.prepare(8, 2);
  const larger = owner.importBuffer(graph, bind, "records", 128, GPUBufferUsage.STORAGE)();
  assert.notEqual(larger, a);
  assert.equal(a.destroyed, false);
  complete();
  await Promise.resolve();
  assert.equal(a.destroyed, true);
  owner.commit(Promise.resolve());
  owner.prepare(4, 2);
  const returned = originalRecipe();
  assert.notEqual(returned, a, "cached graph resolves a new allocation after returning to its old extent");
  assert.equal(returned.size, 64);
  assert.throws(() => owner.importBuffer(graph, bind, "too-large", 8192, GPUBufferUsage.STORAGE), RangeError);
  owner.destroy();
  await Promise.resolve();
  assert(allocations.every((resource) => resource.destroyed));
});

test("Retired bytes remain in the physical quota until the actual fence completes", async () => {
  const made = [],
    device = {
      limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
      createBuffer(d) {
        const b = { ...d, destroy() {} };
        made.push(b);
        return b;
      },
    };
  const owner = new SurfaceFrameResources(device, undefined, 192);
  const graph = { import_resource: (_name, _descriptor, binding) => binding },
    bind = (_name, resolve) => resolve();
  owner.prepare(1, 1);
  owner.importBuffer(graph, bind, "pool", 128, GPUBufferUsage.STORAGE);
  let done;
  owner.commit(new Promise((resolve) => (done = resolve)));
  owner.prepare(2, 2);
  assert.equal(owner.physicalBytes().retired, 128);
  assert.throws(() => owner.importBuffer(graph, bind, "pool", 128, GPUBufferUsage.STORAGE), RangeError);
  assert.equal(made.length, 1, "Reject before allocating the new physical buffer");
  done();
  await Promise.resolve();
  assert.equal(owner.physicalBytes().retired, 0);
  owner.importBuffer(graph, bind, "pool", 128, GPUBufferUsage.STORAGE);
  assert.equal(made.length, 2);
  owner.destroy();
  await Promise.resolve();
});

test("Surface native bindings reuse exact resource/range tuples and invalidate at retirement", () => {
  let created = 0,
    layouts = 0;
  const device = { createBindGroup: (descriptor) => ({ ...descriptor, id: ++created }) };
  const owner = new SurfaceFrameResources(device);
  const pipeline = {
    getBindGroupLayout: (index) => {
      layouts++;
      return { index };
    },
  };
  const first = {},
    second = {};
  const entries = (buffer, offset = 0, size = 64, binding = 2) => [
    { binding, resource: { buffer, offset, size } },
  ];
  const original = owner.obtainBindGroup(pipeline, 0, entries(first));
  assert.equal(owner.obtainBindGroup(pipeline, 0, entries(first)), original);
  for (const variant of [
    entries(second),
    entries(first, 256),
    entries(first, 0, 32),
    entries(first, 0, 64, 3),
  ]) {
    assert.notEqual(owner.obtainBindGroup(pipeline, 0, variant), original);
  }
  assert.notEqual(owner.obtainBindGroup(pipeline, 1, entries(first)), original);
  const otherPipeline = { getBindGroupLayout: () => ({}) };
  assert.notEqual(owner.obtainBindGroup(otherPipeline, 0, entries(first)), original);
  assert.equal(created, 7);
  assert.equal(layouts, 2);
  owner.prepare(4, 4);
  assert.notEqual(owner.obtainBindGroup(pipeline, 0, entries(first)), original);
  assert.equal(owner.bindingEvidence().requests, 9);
  assert.equal(owner.bindingEvidence().creations, 8);
});

test("rapid resize admission waits for real fence and coalesces to the latest requested extent", async () => {
  const device = {
    limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
    createBuffer: (d) => ({ ...d, destroy() {} }),
  };
  const owner = new SurfaceFrameResources(device, undefined, 192);
  const graph = { import_resource: (_name, _descriptor, binding) => binding },
    bind = (_name, resolve) => resolve();
  owner.prepare(4, 4);
  owner.importBuffer(graph, bind, "payload", 128, GPUBufferUsage.STORAGE);
  let complete;
  owner.commit(new Promise((resolve) => (complete = resolve)));
  assert.equal(owner.canPrepare(8, 8, 128), false);
  assert.equal(owner.canPrepare(16, 16, 128), false);
  assert.equal(owner.canPrepare(4, 4, 128), true, "Current extent stays queue-ordered while resize waits");
  assert.equal(owner.physicalBytes().active, 128, "Denied resize does not retire or allocate");
  complete();
  await Promise.resolve();
  owner.prepare(16, 16);
  await Promise.resolve();
  assert.equal(owner.canPrepare(16, 16, 128), true);
  owner.importBuffer(graph, bind, "payload", 128, GPUBufferUsage.STORAGE);
  assert.equal(owner.physicalBytes().active + owner.physicalBytes().retired, 128);
  owner.destroy();
  await Promise.resolve();
});

test("Surface views use actual native texture identity and preserve wrapper generation invalidation", () => {
  const owner = new SurfaceFrameResources({});
  let nativeViews = 0;
  const texture = { createView: () => ({ id: ++nativeViews }) };
  const first = owner.resolveTextureView(texture);
  assert.equal(owner.resolveTextureView(texture), first);
  assert.equal(nativeViews, 1);
  assert.notEqual(owner.resolveTextureView({ createView: () => ({ id: ++nativeViews }) }), first);
  let current = {};
  const wrapper = { isGPUTextureContext: true, createView: () => current };
  assert.equal(owner.resolveTextureView(wrapper), current);
  current = {};
  assert.equal(owner.resolveTextureView(wrapper), current);
  owner.prepare(2, 2);
  assert.notEqual(owner.resolveTextureView(texture), first);
});

test("history active and retired bytes participate in admission without double-counting retired scratch", async () => {
  const device = { limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
    createBuffer: descriptor => ({ ...descriptor, destroy() {} }) };
  const owner = new SurfaceFrameResources(device, undefined, 192);
  const graph = { import_resource: (_name, _descriptor, binding) => binding };
  owner.prepare(4, 4);
  owner.importBuffer(graph, (_name, resolve) => resolve(), "payload", 128, GPUBufferUsage.STORAGE);
  owner.setExternalMemory(64, 0);
  assert.equal(owner.physicalBytes().active, 192);
  assert.equal(owner.canPrepare(4, 4, 128, "", 64), true);
  assert.equal(owner.canPrepare(4, 4, 128, "", 68), false);
  let complete;
  owner.commit(new Promise(resolve => { complete = resolve; }));
  owner.prepare(8, 8);
  assert.equal(owner.physicalBytes().active, 64);
  assert.equal(owner.physicalBytes().retired, 128);
  assert.equal(owner.physicalBytes().physicalPeak, 192);
  complete();
  await Promise.resolve();
  owner.destroy();
});
