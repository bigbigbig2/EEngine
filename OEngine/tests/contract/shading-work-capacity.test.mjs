import assert from "node:assert/strict";
import test from "node:test";

import "../webgpu-test-globals.mjs";
import {
  shadingWorkCapacity, SHADING_WORK_HEADER_BYTES, SHADING_WORK_RECORD_BYTES,
  SHADING_WORK_THREADS, SHADING_WORK_CLASS_COUNT,
  SHADING_WORK_CLASS_BUFFER_BYTES, SHADING_WORK_INDIRECT_BYTES,
  shadingWorkClassIndirectOffset
} from "../../.test-dist/render/surface/ShadingWorkAbi.js";

const limits = {
  maxBufferSize: 128 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
};

test("full coverage reserves exactly one bounded record per pixel", () => {
  const selected = shadingWorkCapacity(1920, 1080, limits);
  assert.equal(selected.capacity, 1920 * 1080);
  assert.equal(selected.queueBytes,
    SHADING_WORK_HEADER_BYTES + 1920 * 1080 * SHADING_WORK_RECORD_BYTES);
  assert.equal(SHADING_WORK_THREADS, 64);
  assert.equal(SHADING_WORK_CLASS_BUFFER_BYTES, 64 * 16);
  assert.equal(SHADING_WORK_INDIRECT_BYTES, 65 * 16);
  assert.equal(shadingWorkClassIndirectOffset(0), 16);
  assert.equal(shadingWorkClassIndirectOffset(SHADING_WORK_CLASS_COUNT - 1), 64 * 16);
  assert.throws(() => shadingWorkClassIndirectOffset(64), /outside/);
});

test("unsupported extents fail before GPU allocation instead of truncating samples", () => {
  assert.throws(() => shadingWorkCapacity(1920, 1080, {
    ...limits, maxStorageBufferBindingSize: 8 * 1024 * 1024
  }), /storage-buffer limit/);
  assert.throws(() => shadingWorkCapacity(1920, 1080, {
    ...limits, maxComputeWorkgroupsPerDimension: 64
  }), /workgroup limit/);
  assert.throws(() => shadingWorkCapacity(0, 1080, limits), /positive integers/);
});
