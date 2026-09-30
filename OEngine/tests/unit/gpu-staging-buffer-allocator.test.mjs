import assert from "node:assert/strict";
import test from "node:test";

import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";

test("staging allocator reuses unmapped copy buffers without remapping", () => {
  const previousUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { COPY_SRC: 1, COPY_DST: 2 };
  let destroyed = false;
  let descriptor;
  const buffer = {
    size: 64,
    destroy() { destroyed = true; }
  };
  try {
    const allocator = new GPUStagingBufferAllocator({
      createBuffer(value) { descriptor = value; return buffer; }
    });
    const allocated = allocator.get(64);
    assert.equal(allocator.gpu_memory_usage, 64, "active upload buffers remain allocated");
    assert.equal(allocated, buffer);
    assert.equal(descriptor.usage, 3);
    assert.equal(descriptor.mappedAtCreation, undefined);
    allocator.release(buffer);
    assert.equal(allocator.get(32), buffer);
    allocator.release(buffer);
    allocator.destroy();
    assert.equal(destroyed, true);
    assert.equal(allocator.gpu_memory_usage, 0);
    allocator.destroy();
  } finally {
    globalThis.GPUBufferUsage = previousUsage;
  }
});

test("staging allocator waits for submitted work before reusing upload memory", async () => {
  const previousUsage = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { COPY_SRC: 1, COPY_DST: 2 };
  let complete;
  const submitted = new Promise(resolve => { complete = resolve; });
  try {
    const allocator = new GPUStagingBufferAllocator({
      createBuffer({ size }) {
        return { size, destroy() {} };
      }
    });
    const inFlight = allocator.get(64);
    allocator.release(inFlight, submitted);
    assert.equal(allocator.gpu_memory_usage, 64, "in-flight uploads remain charged");
    const next = allocator.get(64);
    assert.equal(allocator.gpu_memory_usage, 128);
    assert.notEqual(next, inFlight);
    complete();
    await submitted;
    await Promise.resolve();
    assert.equal(allocator.get(64), inFlight);
    allocator.destroy();
  } finally {
    globalThis.GPUBufferUsage = previousUsage;
  }
});
