import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage ??= { COPY_SRC: 1, MAP_WRITE: 2 };
globalThis.GPUMapMode ??= { WRITE: 1 };

const { GPUStagingBufferAllocator } = await import(
  "../.test-dist/gpu/GPUStagingBufferAllocator.js"
);
const { ResourceAccounting } = await import(
  "../.test-dist/debug/profiling/ResourceAccounting.js"
);

test("staging allocator classifies upload buffers and releases checked-out buffers", () => {
  const device = {
    createBuffer(descriptor) {
      return {
        size: descriptor.size,
        mapState: "mapped",
        destroyCount: 0,
        destroy() { this.destroyCount++; }
      };
    }
  };
  const accounting = new ResourceAccounting();
  const allocator = new GPUStagingBufferAllocator(device, accounting);
  const checkedOut = allocator.get(7);

  assert.deepEqual(accounting.snapshot().categories.upload, {
    bytes: 8,
    peakBytes: 8,
    count: 1
  });
  allocator.destroy();
  assert.equal(checkedOut.destroyCount, 1);
  assert.equal(accounting.snapshot().totalBytes, 0);
});
