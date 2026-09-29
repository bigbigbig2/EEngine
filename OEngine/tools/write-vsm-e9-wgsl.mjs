import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VSM_RECEIVER_DEMAND_WGSL } from "../.test-dist/shaders/vsm_receiver_demand.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../.test-dist/shaders/vsm_allocate_pages.js";
import { VSM_CASTER_RECORDS_WGSL } from "../.test-dist/shaders/vsm_caster_records.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL, VSM_ATLAS_RASTER_WGSL,
  VSM_ATLAS_PRODUCT_RASTER_WGSL } from "../.test-dist/shaders/vsm_atlas_raster.js";
import { VSM_SAMPLING_WGSL } from "../.test-dist/shaders/vsm_sampling.js";

const root = fileURLToPath(new URL("../.test-dist/vsm-e9-wgsl/", import.meta.url));
mkdirSync(root, { recursive: true });
const samplingDeclarations = /* wgsl */ `
struct GpuPrimitiveTypeTable { direction: vec3f };
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@compute @workgroup_size(1) fn sampling_check() {
  _ = vsm_sample_directional(vec3f(0.0), vec3f(0.0, 1.0, 0.0),
    GpuPrimitiveTypeTable(vec3f(0.0, 1.0, 0.0)));
}
`;
const modules = {
  "receiver-demand": VSM_RECEIVER_DEMAND_WGSL,
  "allocate-pages": VSM_ALLOCATE_PAGES_WGSL,
  "caster-records": VSM_CASTER_RECORDS_WGSL,
  "atlas-page-clear": VSM_ATLAS_PAGE_CLEAR_WGSL,
  "atlas-raster": VSM_ATLAS_RASTER_WGSL,
  "atlas-product-raster": VSM_ATLAS_PRODUCT_RASTER_WGSL,
  "sampling": `${VSM_SAMPLING_WGSL}\n${samplingDeclarations}`
};
for (const [name, source] of Object.entries(modules)) {
  writeFileSync(new URL(`../.test-dist/vsm-e9-wgsl/${name}.wgsl`, import.meta.url), source);
  console.log(name);
}
