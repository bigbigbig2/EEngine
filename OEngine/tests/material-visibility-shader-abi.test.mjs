import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const {
  PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL,
  PACKED_OPAQUE_VISIBILITY_RASTER_WGSL
} = await import("../.test-dist/shaders/packed_visibility.js");
const { PACKED_MATERIAL_RESOLVE_WGSL } = await import(
  "../.test-dist/shaders/packed_material_resolve.js"
);
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

test("M2 visibility producers encode the instance-owned kernel class without adding an OPAQUE material binding", () => {
  for (const source of [
    PACKED_OPAQUE_VISIBILITY_RASTER_WGSL,
    PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
  ]) {
    assert.match(
      source,
      /oengine_visibility_key_try_encode\(\s*work_index,\s*oengine_instance_material_kernel_class\(instance\.flags\)\s*\)/s
    );
  }
  assert.doesNotMatch(PACKED_OPAQUE_VISIBILITY_RASTER_WGSL, /OEngineMaterialVisibilityRecord/);
  assert.doesNotMatch(PACKED_OPAQUE_VISIBILITY_RASTER_WGSL, /opaque_material/);
});

test("M2 legacy Surface consumers decode only the v3 raster slot through the central helper", () => {
  for (const source of [PACKED_MATERIAL_RESOLVE_WGSL]) {
    assert.match(source, /oengine_visibility_key_raster_work_slot\(key\)/);
    assert.doesNotMatch(source, /key\s*&\s*0x1fffffff|key\s*>>\s*29/);
  }
});
