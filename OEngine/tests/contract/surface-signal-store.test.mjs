import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeSurfaceSignalStoreKey,
  planSurfaceSignalStoreCapacity,
  SURFACE_SIGNAL_STORE_ENTRY_BYTES,
  SURFACE_SIGNAL_STORE_WAYS,
  SURFACE_SIGNAL_STORE_KEY_WORDS,
} from "../../.test-dist/gpu/GpuSurfaceSignalStoreAbi.js";
test("SignalStore requires the entire selected-source identity, without a dependency digest", () => {
  const words = Array.from({ length: SURFACE_SIGNAL_STORE_KEY_WORDS }, (_, i) => i);
  const encoded = encodeSurfaceSignalStoreKey({ words });
  assert.equal(encoded.length, 72);
  for (const word of [0, 1, 2, 3, 4, 5, 38, 39, 40, 55, 69, 71]) {
    const changed = [...words];
    changed[word]++;
    assert.notDeepEqual(encoded, encodeSurfaceSignalStoreKey({ words: changed }));
  }
  assert.throws(() => encodeSurfaceSignalStoreKey({ words: words.slice(0, -1) }), RangeError);
  assert.throws(() => encodeSurfaceSignalStoreKey({ words: [-1, ...words.slice(1)] }), RangeError);
});
test("SignalStore packet/spill store is bounded and segmented", () => {
  const p = planSurfaceSignalStoreCapacity({
    maxBufferSize: 1024 ** 3,
    maxStorageBufferBindingSize: 2 * 1024 ** 2,
  });
  assert.ok(p.bytes <= 64 * 1024 ** 2);
  assert.equal(p.entries * SURFACE_SIGNAL_STORE_ENTRY_BYTES, p.bytes);
  assert.equal(p.entries % SURFACE_SIGNAL_STORE_WAYS, 0);
  assert.ok(p.segmentBytes.every((v) => v <= 2 * 1024 ** 2));
});
