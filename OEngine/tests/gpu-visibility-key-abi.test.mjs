import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_VISIBILITY_KEY_ABI_VERSION,
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
  GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  GPU_VISIBILITY_KEY_SCHEMA,
  GPU_VISIBILITY_KEY_WGSL,
  assertGpuVisibilityRasterWorkCapacity,
  decodeVisibilityKey,
  encodeVisibilityKey,
  getGpuVisibilityRasterWorkCapacity,
  isVisibilityKeyEmpty,
  isVisibilityKeyValid,
  resolveVisibilityKeyReference,
  visibilityRasterWorkBufferByteLength
} from "../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} from "../.test-dist/gpu/GpuWorkGenerationAbi.js";

const exactWork = (overrides = {}) => ({
  instanceRecordIndex: 11,
  geometryRecordIndex: 17,
  meshletRecordIndex: 23,
  localTriangleIndex: 5,
  materialHandle: 29,
  rasterFlags: 31,
  ...overrides
});

test("VisibilityKey directly addresses one exact RasterWork slot", () => {
  assert.equal(GPU_VISIBILITY_KEY_ABI_VERSION, 2);
  assert.deepEqual(GPU_VISIBILITY_KEY_SCHEMA.fields, [{
    name: "rasterWorkSlot",
    bitOffset: 0,
    bitCount: 32,
    mask: 0xffffffff,
    maxValue: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT
  }]);
  for (const [name, value] of [
    ["OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT", GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT],
    ["OENGINE_VISIBILITY_KEY_INVALID", GPU_VISIBILITY_KEY_INVALID],
    ["OENGINE_VISIBILITY_KEY_EMPTY", GPU_VISIBILITY_KEY_EMPTY]
  ]) {
    assert.match(GPU_VISIBILITY_KEY_WGSL, new RegExp(`const ${name}: u32 =\\s*${value}u;`));
  }
  assert.doesNotMatch(GPU_VISIBILITY_KEY_WGSL, /local_triangle|LOCAL_TRIANGLE/);
});

test("VisibilityKey codec preserves direct slots and sentinels", () => {
  for (const rasterWorkSlot of [0, 1, GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT]) {
    const key = encodeVisibilityKey(rasterWorkSlot);
    assert.equal(key, rasterWorkSlot);
    assert.deepEqual(decodeVisibilityKey(key), { kind: "valid", rasterWorkSlot });
    assert.equal(isVisibilityKeyValid(key), true);
    assert.equal(isVisibilityKeyEmpty(key), false);
  }
  assert.deepEqual(decodeVisibilityKey(GPU_VISIBILITY_KEY_EMPTY), { kind: "empty" });
  assert.deepEqual(decodeVisibilityKey(GPU_VISIBILITY_KEY_INVALID), {
    kind: "invalid",
    key: GPU_VISIBILITY_KEY_INVALID
  });
  for (const value of [-1, 0.5, GPU_VISIBILITY_KEY_INVALID, GPU_VISIBILITY_KEY_EMPTY]) {
    assert.throws(() => encodeVisibilityKey(value), /must be an integer/);
  }
  assert.throws(() => decodeVisibilityKey(0x1_0000_0000), /must be a u32/);
});

test("RasterWork capacity obeys direct-key and adapter limits", () => {
  const keyLimitBytes = visibilityRasterWorkBufferByteLength(
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY
  );
  assert.equal(
    keyLimitBytes,
    GPU_CLASSIFIED_RASTER_HEADER_BYTES +
      GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY * 2 * GPU_RASTER_WORK_SCHEMA.stride
  );
  const adapterCapacity = 13;
  const adapterBytes = visibilityRasterWorkBufferByteLength(adapterCapacity);
  assert.deepEqual(getGpuVisibilityRasterWorkCapacity({
    maxBufferSize: adapterBytes + 1024,
    maxStorageBufferBindingSize: adapterBytes
  }), {
    keyCapacity: GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
    adapterCapacity,
    effectiveCapacity: adapterCapacity,
    effectiveByteLimit: adapterBytes,
    queueHeaderFits: true
  });
  assertGpuVisibilityRasterWorkCapacity(adapterCapacity, {
    maxBufferSize: adapterBytes,
    maxStorageBufferBindingSize: adapterBytes
  });
  assert.throws(() => assertGpuVisibilityRasterWorkCapacity(adapterCapacity + 1, {
    maxBufferSize: adapterBytes,
    maxStorageBufferBindingSize: adapterBytes
  }), /exceeds effective capacity 13/);
  assert.throws(() => assertGpuVisibilityRasterWorkCapacity(0, {
    maxBufferSize: GPU_CLASSIFIED_RASTER_HEADER_BYTES - 1,
    maxStorageBufferBindingSize: GPU_CLASSIFIED_RASTER_HEADER_BYTES - 1
  }), /headers require 64 bytes/);
});

test("VisibilityKey lookup returns the exact triangle record without cluster indirection", () => {
  const records = [exactWork(), exactWork({ meshletRecordIndex: 101, localTriangleIndex: 7 })];
  const resolved = resolveVisibilityKeyReference(encodeVisibilityKey(1), records);
  assert.deepEqual(resolved, {
    kind: "valid",
    key: 1,
    rasterWorkSlot: 1,
    rasterWork: records[1]
  });
  assert.deepEqual(resolveVisibilityKeyReference(GPU_VISIBILITY_KEY_EMPTY, records), {
    kind: "empty"
  });
  assert.equal(
    resolveVisibilityKeyReference(GPU_VISIBILITY_KEY_INVALID, records).reason,
    "reserved-key"
  );
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(2), records).reason,
    "raster-work-out-of-range"
  );
  assert.equal(
    resolveVisibilityKeyReference(0, [exactWork({ localTriangleIndex: -1 })]).reason,
    "invalid-raster-work"
  );
});
