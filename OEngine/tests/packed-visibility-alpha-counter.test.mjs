import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage = { COMPUTE: 4 };

const {
  PACKED_ALPHA_COUNTER_WORKGROUP_SIZE,
  PACKED_VISIBILITY_ALPHA_COUNTER_WGSL,
  packedVisibilityAlphaCounterDispatchSize
} = await import("../.test-dist/render/passes/PackedVisibilityAlphaCounterPass.js");

test("R4-A-06 alpha counter uses the real RasterWork material lookup", () => {
  assert.equal(PACKED_ALPHA_COUNTER_WORKGROUP_SIZE, 64);
  assert.match(PACKED_VISIBILITY_ALPHA_COUNTER_WGSL, /raster_work\.elements\[raster_slot\]/);
  assert.match(PACKED_VISIBILITY_ALPHA_COUNTER_WGSL, /visible_clusters\.elements\[visible_slot\]\.material_handle/);
  assert.match(PACKED_VISIBILITY_ALPHA_COUNTER_WGSL, /material\.alpha_mode == 1u/);
  assert.match(PACKED_VISIBILITY_ALPHA_COUNTER_WGSL, /frame_counters\[10u\]/);
});

test("R4-A-06 alpha counter maps large capacities to a legal 2D dispatch", () => {
  assert.deepEqual(packedVisibilityAlphaCounterDispatchSize(64, 65535), [1, 1]);
  assert.deepEqual(
    packedVisibilityAlphaCounterDispatchSize(65535 * 64 + 1, 65535),
    [65535, 2]
  );
  assert.throws(
    () => packedVisibilityAlphaCounterDispatchSize(65, 1),
    /adapter 2D limit/
  );
});
