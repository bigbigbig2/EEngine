import assert from "node:assert/strict";
import test from "node:test";

import { GPUStagingBufferAllocator } from "../.test-dist/gpu/GPUStagingBufferAllocator.js";

test("staging allocator suppresses expected remap abort after teardown", async () => {
  const previousUsage = globalThis.GPUBufferUsage;
  const previousMapMode = globalThis.GPUMapMode;
  globalThis.GPUBufferUsage = { COPY_SRC: 1, MAP_WRITE: 2 };
  globalThis.GPUMapMode = { WRITE: 1 };
  let rejectMapping;
  let destroyed = false;
  const buffer = {
    size: 64,
    mapState: "mapped",
    destroy() { destroyed = true; },
    mapAsync() {
      return new Promise((_resolve, reject) => { rejectMapping = reject; });
    }
  };
  const errors = [];
  const previousError = console.error;
  console.error = (error) => errors.push(error);
  try {
    const allocator = new GPUStagingBufferAllocator({
      createBuffer() { return buffer; }
    });
    const allocated = allocator.get(64);
    assert.equal(allocated, buffer);
    buffer.mapState = "unmapped";
    allocator.release(buffer);
    allocator.destroy();
    rejectMapping(new DOMException("Buffer was destroyed before mapping was resolved", "AbortError"));
    await Promise.resolve();
    assert.equal(destroyed, true);
    assert.deepEqual(errors, []);
    assert.equal(allocator.gpu_memory_usage, 0);
    allocator.destroy();
  } finally {
    console.error = previousError;
    globalThis.GPUBufferUsage = previousUsage;
    globalThis.GPUMapMode = previousMapMode;
  }
});
