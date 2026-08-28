import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_VISIBILITY_KEY_ABI_VERSION,
  GPU_VISIBILITY_KEY_EMPTY,
  GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS,
  GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK,
  GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT,
  GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
  GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
  GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK,
  GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS,
  GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT,
  GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT,
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
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} from "../.test-dist/gpu/GpuWorkGenerationAbi.js";

test("R4-A-01 TS and WGSL share VisibilityKey v1 bit layout", () => {
  assert.equal(GPU_VISIBILITY_KEY_ABI_VERSION, 1);
  assert.equal(GPU_VISIBILITY_KEY_SCHEMA.bitCount, 32);
  assert.deepEqual(GPU_VISIBILITY_KEY_SCHEMA.fields, [
    {
      name: "localTriangle",
      bitOffset: 0,
      bitCount: 7,
      mask: 0x7f,
      maxValue: 0x7f
    },
    {
      name: "rasterWorkSlot",
      bitOffset: 7,
      bitCount: 25,
      mask: 0x01ffffff,
      maxValue: 0x01fffffe
    }
  ]);
  assert.equal(GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS, 7);
  assert.equal(GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK, 0x7f);
  assert.equal(GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT, 7);
  assert.equal(GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK, 0x01ffffff);
  assert.equal(GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT, 0x01ffffff);
  assert.equal(GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY, 0x01ffffff);
  assert.equal(GPU_VISIBILITY_KEY_EMPTY, 0xffffffff);

  for (const [name, value] of [
    ["OENGINE_VISIBILITY_KEY_ABI_VERSION", GPU_VISIBILITY_KEY_ABI_VERSION],
    ["OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS", GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_BITS],
    ["OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT", GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_SHIFT],
    ["OENGINE_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK", GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK],
    ["OENGINE_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE", GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE],
    ["OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS", GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_BITS],
    ["OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT", GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_SHIFT],
    ["OENGINE_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK", GPU_VISIBILITY_KEY_RASTER_WORK_SLOT_MASK],
    ["OENGINE_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT", GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT],
    ["OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT", GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT],
    ["OENGINE_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY", GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY],
    ["OENGINE_VISIBILITY_KEY_EMPTY", GPU_VISIBILITY_KEY_EMPTY]
  ]) {
    assert.match(
      GPU_VISIBILITY_KEY_WGSL,
      new RegExp(`const ${name}: u32 = ${value}u;`)
    );
  }
  assert.match(GPU_VISIBILITY_KEY_WGSL, /oengine_visibility_key_try_encode/);
  assert.match(GPU_VISIBILITY_KEY_WGSL, /OEngineVisibilityKeyEncodeResult\(OENGINE_VISIBILITY_KEY_EMPTY, 0u\)/);
});

test("R4-A-01 codec covers empty, invalid and maximum values", () => {
  for (const rasterWorkSlot of [0, GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT]) {
    for (const localTriangle of [0, GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE]) {
      const key = encodeVisibilityKey(rasterWorkSlot, localTriangle);
      assert.deepEqual(decodeVisibilityKey(key), {
        kind: "valid",
        rasterWorkSlot,
        localTriangle
      });
      assert.equal(isVisibilityKeyValid(key), true);
      assert.equal(isVisibilityKeyEmpty(key), false);
    }
  }

  assert.equal(
    encodeVisibilityKey(
      GPU_VISIBILITY_KEY_MAX_RASTER_WORK_SLOT,
      GPU_VISIBILITY_KEY_MAX_LOCAL_TRIANGLE
    ),
    0xffffff7f
  );
  assert.deepEqual(decodeVisibilityKey(GPU_VISIBILITY_KEY_EMPTY), {
    kind: "empty"
  });
  assert.equal(isVisibilityKeyEmpty(GPU_VISIBILITY_KEY_EMPTY), true);
  assert.equal(isVisibilityKeyValid(GPU_VISIBILITY_KEY_EMPTY), false);

  for (const key of [0xffffff80, 0xfffffffe]) {
    assert.deepEqual(decodeVisibilityKey(key), {
      kind: "invalid",
      reason: "reserved-raster-work-slot",
      rasterWorkSlot: GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT,
      localTriangle: key & GPU_VISIBILITY_KEY_LOCAL_TRIANGLE_MASK
    });
    assert.equal(isVisibilityKeyValid(key), false);
  }
});

test("R4-A-01 encoder rejects values instead of masking or truncating", () => {
  for (const rasterWorkSlot of [
    -1,
    0.5,
    GPU_VISIBILITY_KEY_RESERVED_RASTER_WORK_SLOT,
    0x1_0000_0000
  ]) {
    assert.throws(
      () => encodeVisibilityKey(rasterWorkSlot, 0),
      /rasterWorkSlot must be an integer/
    );
  }
  for (const localTriangle of [-1, 0.5, 128, 0x1_0000_0000]) {
    assert.throws(
      () => encodeVisibilityKey(0, localTriangle),
      /localTriangle must be an integer/
    );
  }
  for (const key of [-1, 0.5, 0x1_0000_0000]) {
    assert.throws(() => decodeVisibilityKey(key), /must be a u32/);
  }
});

test("R4-A-01 RasterWork capacity obeys key and adapter limits", () => {
  const keyLimitBytes = visibilityRasterWorkBufferByteLength(
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY
  );
  assert.equal(
    keyLimitBytes,
    GPU_WORK_QUEUE_HEADER_SCHEMA.stride +
      GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY * GPU_RASTER_WORK_SCHEMA.stride
  );
  const keyLimited = assertGpuVisibilityRasterWorkCapacity(
    GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
    {
      maxBufferSize: keyLimitBytes,
      maxStorageBufferBindingSize: keyLimitBytes
    }
  );
  assert.equal(keyLimited.effectiveCapacity, GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY);
  assert.throws(
    () => assertGpuVisibilityRasterWorkCapacity(
      GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY + 1,
      {
        maxBufferSize: keyLimitBytes + GPU_RASTER_WORK_SCHEMA.stride,
        maxStorageBufferBindingSize: keyLimitBytes + GPU_RASTER_WORK_SCHEMA.stride
      }
    ),
    /exceeds VisibilityKey v1 capacity/
  );

  const adapterCapacity = 13;
  const adapterBytes = visibilityRasterWorkBufferByteLength(adapterCapacity);
  const adapterLimited = getGpuVisibilityRasterWorkCapacity({
    maxBufferSize: adapterBytes + 1024,
    maxStorageBufferBindingSize: adapterBytes
  });
  assert.deepEqual(adapterLimited, {
    keyCapacity: GPU_VISIBILITY_KEY_MAX_RASTER_WORK_CAPACITY,
    adapterCapacity,
    effectiveCapacity: adapterCapacity,
    effectiveByteLimit: adapterBytes,
    queueHeaderFits: true
  });
  assertGpuVisibilityRasterWorkCapacity(adapterCapacity, {
    maxBufferSize: adapterBytes,
    maxStorageBufferBindingSize: adapterBytes
  });
  assert.throws(
    () => assertGpuVisibilityRasterWorkCapacity(adapterCapacity + 1, {
      maxBufferSize: adapterBytes,
      maxStorageBufferBindingSize: adapterBytes
    }),
    /exceeds adapter capacity 13/
  );
  assert.throws(
    () => assertGpuVisibilityRasterWorkCapacity(0, {
      maxBufferSize: GPU_WORK_QUEUE_HEADER_SCHEMA.stride - 1,
      maxStorageBufferBindingSize: GPU_WORK_QUEUE_HEADER_SCHEMA.stride - 1
    }),
    /queue header requires 32 bytes/
  );
});

test("R4-A-01 multi-Meshlet fixture resolves through RasterWork uniquely", () => {
  const visibleClusters = [{
    instanceRecordIndex: 11,
    geometryRecordIndex: 17,
    clusterRecordIndex: 23,
    materialHandle: 29
  }];
  const rasterWork = [
    { visibleClusterSlot: 0, meshletRecordIndex: 101 },
    { visibleClusterSlot: 0, meshletRecordIndex: 202 }
  ];
  const localTriangle = 7;
  const first = resolveVisibilityKeyReference(
    encodeVisibilityKey(0, localTriangle),
    rasterWork,
    visibleClusters
  );
  const second = resolveVisibilityKeyReference(
    encodeVisibilityKey(1, localTriangle),
    rasterWork,
    visibleClusters
  );

  assert.equal(first.kind, "valid");
  assert.equal(second.kind, "valid");
  assert.equal(first.rasterWork.meshletRecordIndex, 101);
  assert.equal(second.rasterWork.meshletRecordIndex, 202);
  assert.equal(first.visibleCluster, second.visibleCluster);
  assert.notEqual(first.rasterWorkSlot, second.rasterWorkSlot);

  const ambiguousLegacyIdentity = rasterWork.map((work) =>
    `${work.visibleClusterSlot}:${localTriangle}`
  );
  assert.equal(new Set(ambiguousLegacyIdentity).size, 1);
});

test("R4-A-01 lookup reports sentinel and table range failures", () => {
  const visibleClusters = [{
    instanceRecordIndex: 1,
    geometryRecordIndex: 2,
    clusterRecordIndex: 3,
    materialHandle: 4
  }];

  assert.deepEqual(
    resolveVisibilityKeyReference(GPU_VISIBILITY_KEY_EMPTY, [], []),
    { kind: "empty" }
  );
  assert.equal(
    resolveVisibilityKeyReference(0xffffff80, [], []).reason,
    "reserved-raster-work-slot"
  );
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(1, 0), [
      { visibleClusterSlot: 0, meshletRecordIndex: 0 }
    ], visibleClusters).reason,
    "raster-work-out-of-range"
  );
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(0, 0), [
      { visibleClusterSlot: 2, meshletRecordIndex: 0 }
    ], visibleClusters).reason,
    "visible-cluster-out-of-range"
  );
  assert.equal(
    resolveVisibilityKeyReference(encodeVisibilityKey(0, 0), [
      { visibleClusterSlot: -1, meshletRecordIndex: 0 }
    ], visibleClusters).reason,
    "invalid-raster-work-record"
  );
});
