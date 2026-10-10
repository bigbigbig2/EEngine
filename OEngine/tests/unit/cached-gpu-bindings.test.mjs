import assert from "node:assert/strict";
import test from "node:test";
const { GpuBindGroupCache } = await import("../../.test-dist/gpu/GpuBindGroupResourceCache.js");
import { createNativeTextureView } from "../../.test-dist/gpu/GPUTextureDescriptors.js";

test("native texture views reuse equivalent descriptors and distinguish subresources", () => {
  let count = 0;
  const texture = { createView: (descriptor) => ({ descriptor, serial: ++count }) };
  const base = createNativeTextureView(texture);
  assert.equal(createNativeTextureView(texture, { baseMipLevel: 0, aspect: "all" }), base);
  const mip = createNativeTextureView(texture, { baseMipLevel: 1, mipLevelCount: 1 });
  assert.notEqual(mip, base);
  assert.equal(createNativeTextureView(texture, { mipLevelCount: 1, baseMipLevel: 1 }), mip);
  assert.equal(count, 2);
  assert.notEqual(createNativeTextureView(texture, { usage: 4 }), base);
  assert.notEqual(createNativeTextureView(texture, { swizzle: "bgra" }), base);
});

test("bind groups reuse rotating tuples and distinguish layouts, binding numbers and buffer ranges", () => {
  assert.equal(
    typeof GpuBindGroupCache,
    "function",
    "the GPU binding owner must provide bounded descriptor reuse",
  );
  const cache = new GpuBindGroupCache(2);
  let count = 0;
  const device = { createBindGroup: (descriptor) => ({ descriptor, serial: ++count }) };
  const layout = {},
    buffer = {};
  const obtain = (offset, binding = 0, targetLayout = layout) =>
    cache.create(device, {
      layout: targetLayout,
      entries: [{ binding, resource: { buffer, offset, size: 16 } }],
    });
  const a = obtain(0),
    b = obtain(256);
  assert.equal(obtain(0), a);
  assert.equal(obtain(256), b);
  assert.notEqual(obtain(256, 1), b);
  assert.notEqual(obtain(256, 0, {}), b);
  assert.equal(count, 4);
  cache.clear();
  assert.notEqual(obtain(256), b);
});

test("bind group retention is bounded and descriptor mutation cannot corrupt identity", () => {
  assert.equal(
    typeof GpuBindGroupCache,
    "function",
    "the GPU binding owner must provide bounded descriptor reuse",
  );
  const cache = new GpuBindGroupCache(2);
  const device = { createBindGroup: (descriptor) => ({ descriptor }) };
  const layout = {};
  const descriptor = { layout, entries: [{ binding: 0, resource: { buffer: {}, offset: 0, size: 16 } }] };
  const first = cache.create(device, descriptor);
  descriptor.entries[0].resource.offset = 256;
  assert.notEqual(cache.create(device, descriptor), first);
  const replacement = { layout, entries: [{ binding: 0, resource: { buffer: {} } }] };
  cache.create(device, replacement);
  descriptor.entries[0].resource.offset = 0;
  assert.notEqual(
    cache.create(device, descriptor),
    first,
    "evicted descriptors must not retain GPU resources",
  );
});
