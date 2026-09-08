import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_VISIBILITY_KEY_ABI_VERSION,
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_INVALID,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
  GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  GPU_VISIBILITY_KEY_SLOT_MASK,
  GPU_VISIBILITY_KEY_CLASS_SHIFT,
  GPU_VISIBILITY_KEY_MAX_KERNEL_CLASS,
  GPU_VISIBILITY_KEY_SCHEMA,
  GPU_VISIBILITY_KEY_WGSL,
  assertGpuVisibilityRasterWorkCapacity,
  decodeVisibilityKey,
  encodeVisibilityKey,
  getGpuVisibilityRasterWorkCapacity,
  isVisibilityKeyEmpty,
  isVisibilityKeyValid,
  resolveVisibilityKeyReference,
  tryEncodeVisibilityKey,
  visibilityRasterWorkBufferByteLength
} from "../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { GPU_EXACT_RASTER_RECORD_STRIDE } from "../.test-dist/gpu/GpuExactRasterAbi.js";
import {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
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
  assert.equal(GPU_VISIBILITY_KEY_ABI_VERSION, 3);
  assert.deepEqual(GPU_VISIBILITY_KEY_SCHEMA.fields, [{
    name: "rasterWorkSlot",
    bitOffset: 0,
    bitCount: 29,
    mask: GPU_VISIBILITY_KEY_SLOT_MASK,
    maxValue: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT
  }, {
    name: "kernelClass",
    bitOffset: GPU_VISIBILITY_KEY_CLASS_SHIFT,
    bitCount: 3,
    mask: 0xe0000000,
    maxValue: GPU_VISIBILITY_KEY_MAX_KERNEL_CLASS
  }]);
  for (const [name, value] of [
    ["OENGINE_VISIBILITY_KEY_INVALID", GPU_VISIBILITY_KEY_INVALID],
    ["OENGINE_VISIBILITY_KEY_EMPTY", GPU_VISIBILITY_KEY_EMPTY]
  ]) {
    assert.match(GPU_VISIBILITY_KEY_WGSL, new RegExp(`const ${name}: u32 =\\s*${value}u;`));
  }
  assert.doesNotMatch(GPU_VISIBILITY_KEY_WGSL, /local_triangle|LOCAL_TRIANGLE/);
});

test("VisibilityKey codec preserves direct slots and sentinels", () => {
  for (const rasterWorkSlot of [0, 1, GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT]) {
    const key = encodeVisibilityKey(rasterWorkSlot, 6);
    assert.equal(key, ((6 << 29) | rasterWorkSlot) >>> 0);
    assert.deepEqual(decodeVisibilityKey(key), { kind: "valid", rasterWorkSlot, kernelClass: 6 });
    assert.equal(isVisibilityKeyValid(key), true);
    assert.equal(isVisibilityKeyEmpty(key), false);
  }
  assert.deepEqual(decodeVisibilityKey(GPU_VISIBILITY_KEY_EMPTY), { kind: "empty" });
  assert.deepEqual(decodeVisibilityKey(GPU_VISIBILITY_KEY_INVALID), {
    kind: "invalid",
    key: GPU_VISIBILITY_KEY_INVALID
  });
  for (const value of [-1, 0.5, GPU_VISIBILITY_KEY_INVALID, GPU_VISIBILITY_KEY_EMPTY]) {
    assert.throws(() => encodeVisibilityKey(value, 0), /must be an integer/);
  }
  assert.deepEqual(tryEncodeVisibilityKey(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT, 6), {
    key: (((6 << 29) | GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT) >>> 0), valid: true
  });
  assert.deepEqual(tryEncodeVisibilityKey(0x20000000, 0), {
    key: GPU_VISIBILITY_KEY_INVALID, valid: false
  });
  assert.deepEqual(tryEncodeVisibilityKey(0, 7), {
    key: GPU_VISIBILITY_KEY_INVALID, valid: false
  });
  for (let kernelClass = 0; kernelClass <= 6; kernelClass++) {
    for (const rasterWorkSlot of [0, 17, 0x1fffffff]) {
      const encoded = tryEncodeVisibilityKey(rasterWorkSlot, kernelClass);
      assert.equal(encoded.valid, true);
      assert.deepEqual(decodeVisibilityKey(encoded.key), {
        kind: "valid",
        rasterWorkSlot,
        kernelClass
      });
    }
  }
  assert.match(
    GPU_VISIBILITY_KEY_WGSL,
    /raster_work_slot > OENGINE_VISIBILITY_KEY_SLOT_MASK \|\|\s*kernel_class >= OENGINE_VISIBILITY_KEY_CLASS_INVALID/s
  );
  const wgslEncode = GPU_VISIBILITY_KEY_WGSL.slice(
    GPU_VISIBILITY_KEY_WGSL.indexOf("fn oengine_visibility_key_try_encode"),
    GPU_VISIBILITY_KEY_WGSL.indexOf("fn oengine_visibility_key_decode")
  );
  assert.doesNotMatch(wgslEncode, /raster_work_slot\s*&/);
  assert.throws(() => decodeVisibilityKey(0x1_0000_0000), /must be a u32/);
});

test("RasterWork capacity obeys direct-key and adapter limits", () => {
  const keyLimitBytes = visibilityRasterWorkBufferByteLength(
    GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY
  );
  assert.equal(
    keyLimitBytes,
    GPU_CLASSIFIED_RASTER_HEADER_BYTES +
      GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY * 2 * GPU_EXACT_RASTER_RECORD_STRIDE
  );
  assert.throws(
    () => visibilityRasterWorkBufferByteLength(GPU_VISIBILITY_KEY_MAX_CLASS_CAPACITY + 1),
    /class capacity/
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
  const resolved = resolveVisibilityKeyReference(encodeVisibilityKey(1, 0), records);
  assert.deepEqual(resolved, {
    kind: "valid",
    key: 1,
    rasterWorkSlot: 1,
    kernelClass: 0,
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
    resolveVisibilityKeyReference(encodeVisibilityKey(2, 0), records).reason,
    "raster-work-out-of-range"
  );
  assert.equal(
    resolveVisibilityKeyReference(0, [exactWork({ localTriangleIndex: -1 })]).reason,
    "invalid-raster-work"
  );
});
