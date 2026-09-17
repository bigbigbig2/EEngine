import assert from "node:assert/strict";
import test from "node:test";

import {
  HIERARCHICAL_VIRTUAL_HZB_WORK_GENERATION_WGSL,
  HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL,
  HIERARCHICAL_WORK_GENERATION_WGSL
} from "../.test-dist/shaders/hierarchical_work_generation.js";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from
  "../.test-dist/shaders/virtual_geometry_product.js";

test("Product work specialization preserves the V2 feature-off shader and existing wavefront ABI", () => {
  assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, /hierarchy_product_heap|traversal_product_heap/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /oengine_geometry_product_resolve_asset_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /hierarchy_product_heap\[child_begin \+ child\]/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /oengine_virtual_hierarchy_node_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /oengine_virtual_group_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /oengine_geometry_product_lookup_page_heap_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /hierarchy_emit_page_demand_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /traversal_page_demand/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /hierarchy_virtual_find_resident_ancestor_v1/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /selected_cluster = fallback.group_id/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /hierarchy_try_reserve_profiled/u);
  assert.match(HIERARCHICAL_VIRTUAL_WORK_GENERATION_WGSL, /r3_traverse_clusters/u);
  assert.match(HIERARCHICAL_VIRTUAL_HZB_WORK_GENERATION_WGSL, /hierarchy_virtual_traversal_hzb_occluded/u);
});

test("V3 Product decoder retains hierarchy, Group and Meshlet record boundaries", () => {
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /local_node \* 12u/u);
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /group_word_offset \+ local_group \* 4u/u);
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /OENGINE_VIRTUAL_GEOMETRY_GROUP_HEADER_BYTES_V1: u32 = 64u/u);
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /OENGINE_VIRTUAL_GEOMETRY_MESHLET_HEADER_BYTES_V1: u32 = 48u/u);
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /meshlet_count <= \(payload_bytes - meshlet_offset\)/u);
  assert.match(VIRTUAL_GEOMETRY_PRODUCT_WGSL, /triangle_count \* 3u <= header\.vertex_data_offset - triangle_offset/u);
});
