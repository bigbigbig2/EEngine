import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const {
  PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
} = await import("../.test-dist/shaders/packed_visibility.js");
const { PACKED_CSM_SHADOW_WGSL } = await import(
  "../.test-dist/shaders/packed_csm_shadow.js"
);
const {
  PACKED_TRANSPARENT_MOMENT_WGSL,
  PACKED_TRANSPARENT_FORWARD_WGSL
} = await import("../.test-dist/shaders/packed_transparent_oit.js");
const { PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/render_debug_view.js"
);

test("material consumers use the indexed v4 ABI without the removed material_id field", () => {
  for (const source of [
    PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL,
    PACKED_CSM_SHADOW_WGSL,
    PACKED_TRANSPARENT_MOMENT_WGSL,
    PACKED_TRANSPARENT_FORWARD_WGSL,
    PACKED_VISIBILITY_DEBUG_RESOLVE_WGSL
  ]) {
    assert.doesNotMatch(source, /\.material_id\b/);
  }
});
