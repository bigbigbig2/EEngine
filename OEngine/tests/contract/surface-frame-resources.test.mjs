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
      const resource = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      allocations.push(resource); return resource;
    }
  };
  const owner = new SurfaceFrameResources(device);
  const graph = { import_resource: (_name, _descriptor, binding) => binding };
  const bind = (_name, resolve) => resolve;
  owner.prepare(4, 2);
  const originalRecipe = owner.importBuffer(graph, bind, "records", 64, GPUBufferUsage.STORAGE);
  const a = originalRecipe();
  let complete;
  owner.commit(new Promise(resolve => { complete = resolve; }));
  owner.prepare(4, 2);
  assert.equal(originalRecipe(), a, "in-flight frames use the same queue-ordered physical allocation");
  owner.prepare(8, 2);
  const larger = owner.importBuffer(graph, bind, "records", 128, GPUBufferUsage.STORAGE)();
  assert.notEqual(larger, a);
  assert.equal(a.destroyed, false);
  complete(); await Promise.resolve();
  assert.equal(a.destroyed, true);
  owner.commit(Promise.resolve()); owner.prepare(4, 2);
  const returned = originalRecipe();
  assert.notEqual(returned, a, "cached graph resolves a new allocation after returning to its old extent");
  assert.equal(returned.size, 64);
  assert.throws(() => owner.importBuffer(graph, bind, "too-large", 8192, GPUBufferUsage.STORAGE), RangeError);
  owner.destroy(); await Promise.resolve();
  assert(allocations.every(resource => resource.destroyed));
});
