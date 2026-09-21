import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative) => readFileSync(path.join(root, "src", ...relative), "utf8");

test("Product shadow consumes the shared hierarchy and Product MeshletWork ABI", () => {
  const pass = source(["render", "passes", "PackedCsmShadowPass.ts"]);
  assert.match(pass, /VirtualGeometryMeshletWorkCandidate/u);
  assert.match(pass, /rasterExpansionEnabled: false/u);
  assert.match(pass, /virtualGeometry: product/u);
  assert.match(pass, /packed_csm_product_vertex/u);
  assert.match(pass, /packed_csm_product_evidence/u);
  assert.match(pass, /GEOMETRY_PAGE_DEMAND_FLAG_SHADOW/u);
  assert.doesNotMatch(pass, /SecondaryRasterWork.*Product/u);
});

test("Product page demand flags are an explicit hierarchy-view contract", () => {
  const generator = source(["render", "HierarchicalWorkGenerator.ts"]);
  const shader = source(["shaders", "hierarchical_work_generation.ts"]);
  assert.match(generator, /pageDemandFlags\?: number/u);
  assert.match(generator, /HIERARCHICAL_VIEW_OFFSETS\.limits \+ 8/u);
  assert.match(shader, /traversal_view\.limits\.z/u);
});

test("Shadow demand uses a separate delayed ring while sharing the Product scheduler", () => {
  const runtime = source(["gpu", "GeometryPageStreamingRuntime.ts"]);
  const pass = source(["render", "passes", "PackedCsmShadowPass.ts"]);
  assert.match(runtime, /encodeShadowDemandReadback/u);
  assert.match(runtime, /#shadowReadback/u);
  assert.match(runtime, /shadowResults/u);
  assert.match(pass, /encodeShadowDemandReadback/u);
  assert.match(pass, /job\.cascadeIndex === 0/u);
});

test("Main frame completion consumes Product demand through the streaming runtime", () => {
  const pipeline = source(["render", "pipeline", "MainRenderPipeline.ts"]);
  assert.match(pipeline, /streamingRuntime\.consumeAfterCompletion\(/u);
  assert.match(pipeline, /cmd\.gpuDone/u);
  assert.match(pipeline, /Date\.now\(\)/u);
});

test("MainRenderPipeline publishes Product bindings into shadow jobs", () => {
  const pipeline = source(["render", "pipeline", "MainRenderPipeline.ts"]);
  assert.match(pipeline, /virtualGeometry: bindings\.geometry\.visibilityJob\.virtualGeometry \?\? null/u);
});

test("Product scenes remain isolated from package geometry owners", () => {
  const world = source(["gpu", "GpuRenderWorld.ts"]);
  assert.match(world, /stageVirtualProduct/u);
  assert.match(world, /Virtual Product scenes cannot include package geometry residency/u);
  assert.match(world, /sourceKind: virtualProduct !== undefined/u);
});

test("Product visibility samples alpha masks through the active texture binding set", () => {
  const raster = source(["render", "MeshletBucketRaster.ts"]);
  const shader = source(["shaders", "meshlet_bucket_visibility.ts"]);
  assert.match(raster, /binding: index \+ 9/u);
  assert.match(raster, /bindingSet\.textureBanks/u);
  assert.match(raster, /constants: \{ OENGINE_ACTIVE_TEXTURE_BINDING_SET: bindingSet\.id \}/u);
  assert.match(shader, /product_raster_uv/u);
  assert.match(shader, /OENGINE_ACTIVE_TEXTURE_BINDING_SET/u);
  assert.match(shader, /product_sample_alpha\(record\.texture_ref/u);
  assert.match(shader, /OENGINE_MATERIAL_SAMPLER_LINEAR/u);
  assert.match(shader, /product_alpha_texel/u);
  assert.match(shader, /GPU_TEXTURE_BANK_ALPHA_LOAD_WGSL/u);
});

test("Product shadow routes textured alpha masks through TextureBindingSet UV sampling", () => {
  const shader = source(["shaders", "packed_csm_shadow.ts"]);
  const pass = source(["render", "passes", "PackedCsmShadowPass.ts"]);
  assert.match(pass, /PACKED_CSM_PRODUCT_GROUP/u);
  assert.match(pass, /bindingSet\.textureBanks/u);
  assert.match(pass, /packedCsmProductPipeline\(bindingSet\.id\)/u);
  assert.match(shader, /product_uv/u);
  assert.match(shader, /product_sample_alpha/u);
  assert.match(shader, /OENGINE_ACTIVE_TEXTURE_BINDING_SET/u);
  assert.match(shader, /OENGINE_MATERIAL_VISIBILITY_HAS_ALPHA_TEXTURE/u);
  assert.doesNotMatch(shader, /Product shadow has no texture binding\/UV dependency yet/u);
});

test("Product recovery preserves identity and re-publishes through the unified runtime", () => {
  const pipeline = source(["render", "pipeline", "MainRenderPipeline.ts"]);
  assert.match(pipeline, /productGeneration: state\.residency\.productGeneration/u);
  assert.match(pipeline, /productTableSlot: state\.residency\.productTableSlot/u);
  assert.match(pipeline, /abandonForDeviceLoss\(\)/u);
  assert.match(pipeline, /VirtualGeometryResidency\.create\(/u);
  assert.match(pipeline, /entry\.sceneSource/u);
  assert.doesNotMatch(pipeline, /re-admission through GeometryProductAdmissionController/u);
});
