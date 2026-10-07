import test from "node:test";
import assert from "node:assert/strict";
import {
  planAppearanceClosureCache,
  APPEARANCE_CACHE_REQUEST_WORDS,
  APPEARANCE_CACHE_CELL_WORDS,
} from "../../.test-dist/gpu/GpuAppearanceClosureCacheAbi.js";
import { planSurfaceWorkCapacity } from "../../.test-dist/gpu/GpuSurfaceWorkAbi.js";

test("optional cache preflight accounts disjoint map/request/nomination/queue/args/store regions", () => {
  const c = planAppearanceClosureCache(4096, 1920 * 1088, 128 * 1024 ** 2, true);
  assert.equal(c.perBin, 128);
  assert.equal(c.requestBase - c.mapBase, 1920 * 1088);
  assert.equal(c.nominationBase - c.requestBase, 32 * 128 * APPEARANCE_CACHE_REQUEST_WORDS);
  assert.equal(c.binBase - c.nominationBase, c.slots);
  assert.equal(c.queueBase - c.binBase, 64);
  assert.equal(c.argsBase - c.queueBase, 32 * 128);
  assert.equal(c.storeBase - c.argsBase, 128);
  assert.equal(c.end - c.storeBase, c.slots * APPEARANCE_CACHE_CELL_WORDS);
  assert.equal(c.persistentBytes, (c.end - c.storeBase) * 4);
  assert.equal(c.bytes, (c.end - 4096) * 4);
  assert.equal(c.slots & (c.slots - 1), 0);
  assert.equal(planAppearanceClosureCache(4096, 1920 * 1088, c.end * 4 - 4, true).bytes, 0);
  assert.equal(planAppearanceClosureCache(4096, 1920 * 1088, c.end * 4, false).bytes, 0);
  assert.equal(planAppearanceClosureCache(4096, 1920 * 1088, c.end * 4, true, 0).bytes, 0);
});

test("cache budget cannot displace mandatory destinations or exceed the existing control binding", () => {
  const limits = {
    maxBufferSize: 1024 ** 3,
    maxStorageBufferBindingSize: 128 * 1024 ** 2,
    maxTextureDimension2D: 8192,
    maxComputeWorkgroupsPerDimension: 65535,
  };
  const direct = planSurfaceWorkCapacity(1920, 1080, limits, 0x7fff, 16 * 1024 ** 2);
  const cached = planSurfaceWorkCapacity(
    1920,
    1080,
    limits,
    0x7fff,
    16 * 1024 ** 2,
    true,
    1,
    undefined,
    true,
  );
  assert.equal(direct.heapBytes, cached.heapBytes);
  assert.equal(direct.signalBytes, cached.signalBytes);
  assert.equal(cached.scratchBytes - direct.scratchBytes, cached.closureCache.bytes + 32 * 16);
  assert.ok(cached.scratchBytes <= 768 * 1024 ** 2);
  assert.ok(cached.controlBytes <= limits.maxStorageBufferBindingSize);
});

test("history reuses current signal destinations and adds only one signal set plus owner recipes", () => {
  const limits = { maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 128 * 1024 ** 2,
    maxTextureDimension2D: 8192, maxComputeWorkgroupsPerDimension: 65535 };
  const direct = planSurfaceWorkCapacity(1920, 1080, limits, 0x7fff, 16 * 1024 ** 2);
  const history = planSurfaceWorkCapacity(1920, 1080, limits, 0x7fff, 16 * 1024 ** 2, true, 1, undefined, false, undefined, true);
  assert.ok(history.signalHistoryBytes > 0);
  assert.equal(history.scratchBytes, direct.scratchBytes - 4 * direct.signalBytes);
  assert.equal(history.physicalBytes - direct.physicalBytes, 4 * direct.signalBytes + 2 * history.signalHistoryRecipeBytes);
  assert.ok(history.physicalBytes <= 768 * 1024 ** 2);
  assert.equal(direct.signalHistoryBytes, 0);
});
