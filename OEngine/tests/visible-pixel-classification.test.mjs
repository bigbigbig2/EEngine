import test from "node:test";
import assert from "node:assert/strict";

const { VISIBLE_PIXEL_CLASSIFICATION_WGSL } = await import(
  "../.test-dist/shaders/visible_pixel_classification.js"
);

test("visible-pixel classification is count + recursive prefix + scatter without per-pixel global append", () => {
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn count_visible_pixels/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn scan_blocks/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn add_block_prefixes/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn prepare_classes/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn scatter_visible_pixels/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /var<workgroup> local_counts: array<atomic<u32>/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /var<workgroup> local_scatter: array<atomic<u32>/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /group_prefixes\[kernel \* settings\.group_count \+ group_index\]/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /@builtin\(num_workgroups\) grid/);
  assert.doesNotMatch(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /scatter_states\[kernel\]\.cursor/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /destination < limit && destination < pixel_count/);
  const groups = [...VISIBLE_PIXEL_CLASSIFICATION_WGSL.matchAll(/@group\((\d+)\)/g)]
    .map((match) => Number(match[1]));
  assert.ok(Math.max(...groups) <= 3, "classification must fit the WebGPU four-bind-group baseline");
});

test("classification validates a direct VisibilityKey slot before reading exact RasterWork", () => {
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /fn key_addresses_published_work/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /slot >= settings\.raster_class_capacity/);
  assert.match(VISIBLE_PIXEL_CLASSIFICATION_WGSL, /return raster_work\.elements\[oengine_visibility_key_raster_work_slot\(key\)\]/);
});
