import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { SurfaceWorkRuntime } from "../../.test-dist/render/surface/SurfaceWorkRuntime.js";
globalThis.GPUBufferUsage = { UNIFORM: 64, STORAGE: 128, INDIRECT: 256, COPY_SRC: 4, COPY_DST: 8 };
globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_SRC: 1, COPY_DST: 2 };

// Batch planner/FieldRef/SignalRef owners are retired. Rendering and temporal
// wiring assertions migrate to surface-work GPU V09/V12 and frame-program;
// resource identity/fence assertions live in surface-frame-resources. This
// CPU case preserves transaction assertions, not mocked rendering results.
test("current Surface transaction rejects use after abort and commit without prepare", async () => {
  const buffers = [];
  const device = {
    limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 128 * 1024 ** 2,
      maxTextureDimension2D: 8192, maxComputeWorkgroupsPerDimension: 65535 },
    createShaderModule: descriptor => descriptor,
    createComputePipeline: descriptor => ({ ...descriptor, getBindGroupLayout: () => ({}) }),
    createSampler: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: descriptor => {
      const buffer = { ...descriptor, destroyed: 0, destroy() { this.destroyed++; } };
      buffers.push(buffer);
      return buffer;
    },
  };
  const owner = new SurfaceWorkRuntime(device);
  assert.throws(() => owner.commit(Promise.resolve()), /without prepare/);
  owner.prepareFrame(4, 2, 1);
  assert.throws(() => owner.prepareFrame(4, 2, 1), /already prepared/);
  owner.abort();
  assert.throws(() => owner.addToGraph({}, {}), /prepared capacity/);
  assert.throws(() => owner.commit(Promise.resolve()), /without prepare/);
  owner.prepareFrame(4, 2, 1);
  owner.commit(Promise.resolve());
  assert.throws(() => owner.commit(Promise.resolve()), /without prepare/);
  owner.destroy();
  assert.ok(buffers.filter(buffer => buffer.label?.startsWith("Surface/signal history/")).every(buffer => buffer.destroyed === 0));
  await Promise.resolve();
  assert.ok(buffers.every(buffer => buffer.destroyed === 1));
  assert.throws(() => owner.prepareFrame(4, 2, 1), /destroyed/);
});
