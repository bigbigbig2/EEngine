import assert from "node:assert/strict";
import test from "node:test";
import { GPUTimer } from "../../.test-dist/framegraph/GPUTimer.js";

globalThis.GPUBufferUsage = { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 };
globalThis.GPUMapMode = { READ: 1 };

test("one frame crosses query pages without losing intervals or overflowing a query set", async () => {
  const resources = [];
  const device = {
    createQuerySet(descriptor) {
      assert.ok(descriptor.count <= 4096);
      const resource = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      resources.push(resource);
      return resource;
    },
    createBuffer(descriptor) {
      const bytes = new ArrayBuffer(descriptor.size);
      const resource = { ...descriptor, bytes, destroyed: false,
        async mapAsync() {}, getMappedRange(_offset, size) { return bytes.slice(0, size); },
        unmap() {}, destroy() { this.destroyed = true; } };
      resources.push(resource);
      return resource;
    }
  };
  const timer = new GPUTimer(device);
  const first = timer.getComputeWrites("0");
  for (let index = 1; index < 2050; index++) {
    const writes = index % 2 ? timer.getRenderWrites(String(index)) : timer.getComputeWrites(String(index));
    assert.equal(writes.beginningOfPassWriteIndex, (index % 1024) * 2);
    if (index === 1024) assert.notEqual(writes.querySet, first.querySet);
  }
  const resolves = [];
  const base = 2n ** 63n + 1000n;
  timer.resolve({
    resolveQuerySet(_set, _first, count, buffer) {
      resolves.push(count);
      const values = new BigUint64Array(buffer.bytes);
      for (let index = 0; index < count; index++) values[index] = base + BigInt(index);
    },
    copyBufferToBuffer(source, _sourceOffset, destination, _destinationOffset, size) {
      new Uint8Array(destination.bytes).set(new Uint8Array(source.bytes, 0, size));
    }
  });
  await timer.download_results();
  const results = timer.results_to_console_table();
  assert.deepEqual(resolves, [2048, 2048, 4]);
  assert.equal(timer.readbackByteLength, 2050 * 16);
  assert.equal(results.length, 2050);
  assert.equal(results[1024].label, "1024");
  assert.equal(results[2049].type, "render");
  assert.equal(results[2049].start, base + 2n);
  assert.equal(results[2049].duration_ms, 0.000001);
  timer.destroy();
  assert.ok(resources.every(resource => resource.destroyed));
  assert.throws(() => new GPUTimer(device, 2049), /1..2048/);
});
