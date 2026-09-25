import assert from "node:assert/strict";
import test from "node:test";

import { shadingFrequencyPlanCapacity, SHADING_FREQUENCY_COARSE4_BIT } from
  "../../.test-dist/render/surface/ShadingFrequencyPlanAbi.js";

const limits = {
  maxBufferSize: 256 * 1024,
  maxStorageBufferBindingSize: 128 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
};

test("frequency plan admits odd extents without losing edge tiles", () => {
  assert.deepEqual(shadingFrequencyPlanCapacity(639, 359, limits), {
    tilesX: 160, tilesY: 90, bytes: 57600
  });
  assert.equal(SHADING_FREQUENCY_COARSE4_BIT, 16);
});

test("frequency plan rejects unsupported storage and dispatch limits before GPU allocation", () => {
  assert.throws(() => shadingFrequencyPlanCapacity(1920, 1080, limits),
    /exceeds negotiated WebGPU limits/u);
  assert.throws(() => shadingFrequencyPlanCapacity(639, 359, {
    ...limits, maxComputeWorkgroupsPerDimension: 10
  }), /exceeds negotiated WebGPU limits/u);
  assert.throws(() => shadingFrequencyPlanCapacity(0, 359, limits), /positive integers/u);
});
