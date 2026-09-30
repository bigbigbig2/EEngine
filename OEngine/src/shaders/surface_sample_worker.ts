import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import { SURFACE_SAMPLE_WGSL, SURFACE_SAMPLE_RECORD_WORDS } from "../render/surface/SurfaceSampleAbi.js";
import type { SurfacePhysicalBindingPlan } from "../render/surface/SurfaceKernelBindingPlan.js";
import { bindingDeclaration } from "./surface_binding_declarations.js";
import { geometryWgsl, lightingWgsl, materialEvaluationWgsl, textureWgsl } from "./surface_material_kernel.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";
export type SurfaceSampleWorkerMode = "implicit" | "compact" | "fallback";
export function surfaceSampleWorkerWgsl(plan: SurfacePhysicalBindingPlan,
  mode: SurfaceSampleWorkerMode, hasLit: boolean, virtualGeometry: boolean,
  vsmShadowEnabled = false, virtualBankCount = 4, textureBankMask = 0x1ff,
  physicalEnvironment = true): string {
  const kernel = { programId: 15, outputDependencyMask: 0, textureBankMask };
  const unlit = materialEvaluationWgsl({ ...kernel, programId: 3 }, true)
    .replace("fn sparse_evaluate_geometry(", "fn sparse_evaluate_unlit_geometry(");
  const lit = hasLit ? materialEvaluationWgsl(kernel, false, true) : "";
  const scalarAo = plan.bindings.some(binding => binding.role === "indirect-visibility");
  const names = plan.bindings.map(bindingDeclaration).join("\n");
  const surfaceType = /* wgsl */ `
struct RadiometryPreExposure { value: f32, _pad: vec3f, }
struct OEngineSparseSurface {
  base_color: vec3f, alpha: f32,
  shading_normal: vec3f, roughness: f32,
  geometric_normal: vec3f, metallic: f32,
  emissive: vec3f, material_ao: f32,
  position_ws: vec3f, velocity: vec2f,
  view_depth: f32, flags: u32,
  specular_weight: f32, specular_color: vec3f, ior: f32,
  coat_factor: f32, coat_roughness: f32, coat_normal: vec3f,
}
fn sparse_invalid_surface() -> OEngineSparseSurface {
  return OEngineSparseSurface(vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),0.0,
    vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,0u,
    1.0,vec3f(1.0),1.5,0.0,0.0,vec3f(0.0,0.0,1.0));
}`;
  const route = /* wgsl */ `
fn sparse_texture_route_valid(material_slot:u32,slot:u32,texture_ref:u32)->bool {
  let route=texture_descriptor_routing_heap[material_slot*${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u+slot];
  return route.texture_ref==texture_ref &&
    route.texture_generation==shading_view.texture_generation &&
    route.publication_revision==shading_view.publication_revision &&
    route.texture_binding_set_id==material_records[material_slot].texture_binding_set_id;
}`;
  const geometryCheck = virtualGeometry
    ? "if work_item.instance_slot >= arrayLength(&instance_records) { surface_identity_error(); }"
    : `if work_item.instance_slot >= arrayLength(&instance_records) ||
      work_item.geometry_slot >= shading_view.geometry_count ||
      instance_records[work_item.instance_slot].geometry_record_index != work_item.geometry_slot ||
      asset_metadata_heap[shading_view.geometry_generation_word_base+work_item.geometry_slot] !=
        oengine_instance_geometry_generation(instance_records[work_item.instance_slot]) {
      surface_identity_error();
    }`;
  const evaluation = /* wgsl */ `
fn surface_classify(key:u32)->u32 {
  if !oengine_visibility_key_is_valid(key) { return 4u; }
  let slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || slot>=meshlet_work.header.written_count { return sample_load(SAMPLE_HEADER_errorProfile); }
  let item=meshlet_work.elements[slot]; let material_slot=item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) { return sample_load(SAMPLE_HEADER_errorProfile); }
  let material=material_records[material_slot];
  if material.family>2u || material.texture_binding_set_id>3u ||
    ((item.packed_raster_flags>>8u)&63u)!=material.texture_binding_set_id*16u+material.program_id ||
    material.material_generation!=shading_view.material_generation ||
    material.texture_generation!=shading_view.texture_generation ||
    material.publication_revision!=shading_view.publication_revision { return sample_load(SAMPLE_HEADER_errorProfile); }
  return material.texture_binding_set_id;
}
fn surface_evaluate(pixel:vec2u,key:u32)->vec4f {
  let slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || slot>=meshlet_work.header.written_count { return vec4f(1.0,0.0,1.0,1.0); }
  let work_item=meshlet_work.elements[slot]; let material_slot=work_item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) { return vec4f(1.0,0.0,1.0,1.0); }
  let material=material_records[material_slot];
  if material.family>2u || material.texture_binding_set_id!=sample_selected_profile ||
    ((work_item.packed_raster_flags>>8u)&63u)!=material.texture_binding_set_id*16u+material.program_id ||
    material.material_generation!=shading_view.material_generation ||
    material.texture_generation!=shading_view.texture_generation ||
    material.publication_revision!=shading_view.publication_revision { return vec4f(1.0,0.0,1.0,1.0); }
  surface_identity_failed=false;
  ${geometryCheck}
  if surface_identity_failed { return vec4f(1.0,0.0,1.0,1.0); }
  let primitive=oengine_visibility_key_local_primitive(key); var surface:OEngineSparseSurface;
  sample_add(SAMPLE_COUNTER_material,1u);
  if material.family==0u {
    surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);
  } else {
    ${hasLit ? "surface=sparse_evaluate_geometry(pixel,work_item,primitive,material_slot,material);" :
      "surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);"}
  }
  if surface_identity_failed { return vec4f(1.0,0.0,1.0,1.0); }
  var radiance=surface.base_color;
  ${hasLit ? "if material.family!=0u { sample_add(SAMPLE_COUNTER_lighting,1u); radiance=sparse_direct(surface,pixel); }" : ""}
  return vec4f(radiance,surface.alpha);
}
fn surface_count_signal_work(pixel:vec2u,result:u32) {
  if result==0xffffffffu { return; }
  let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u;
  let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
  let packed=sample_load(sample_tile(tile)+SAMPLE_TILE_cellRates+cell);
  if surface_signal_rate(packed,SURFACE_SIGNAL_MATERIAL_SHIFT)!=0u { sample_add(SAMPLE_COUNTER_materialCoarse,1u); }
  if surface_signal_rate(packed,SURFACE_SIGNAL_LIGHTING_SHIFT)!=0u { sample_add(SAMPLE_COUNTER_lightingCoarse,1u); }
}
fn surface_write(pixel:vec2u,result:u32) {
  let key=textureLoad(visibility_texture,vec2i(pixel),0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  let linear=surface_evaluate(pixel,key);
  let color=vec4f(oengine_linear_rec709_to_rec2020(linear.rgb)*radiometry_pre_exposure.value,linear.a);
  if result==0xffffffffu { textureStore(output_hdr,vec2i(pixel),color); sample_add(SAMPLE_COUNTER_full,1u); }
  else { textureStore(sample_results,sample_result_pixel(result),color); sample_add(SAMPLE_COUNTER_coarse,1u); surface_count_signal_work(pixel,result); }
}
`;
  const entry = mode === "implicit" ? /* wgsl */ `
@compute @workgroup_size(8,8)
fn shade(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  let profile=sample_profile(sample_selected_profile);
  let index=group.y*sample_load(profile+2u)+group.x;
  if index>=sample_load(profile) { return; }
  let tile=sample_load(sample_load(SAMPLE_HEADER_descriptors)+sample_selected_profile*sample_load(SAMPLE_HEADER_tileCount)+index);
  let base=sample_tile(tile); if sample_load(base)!=1u { return; }
  let packed_rate=sample_load(base+SAMPLE_TILE_rate); let rate=sample_effective_rate(packed_rate); let stride=sample_stride(rate); let local=vec2u(thread%8u,thread/8u);
  if any(local%stride!=vec2u(0u)) { return; }
  let cell=(local.y/2u)*4u+local.x/2u; let child=(local%2u)/stride;
  let result=select(0xffffffffu,sample_load(base+SAMPLE_TILE_cellResults+cell)+child.y*(2u/stride.x)+child.x,rate!=0u);
  surface_write(sample_origin(tile)+local,result);
}` : mode === "compact" ? /* wgsl */ `
@compute @workgroup_size(64)
fn shade(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  let profile=sample_profile(sample_selected_profile);
  let index=(group.y*sample_load(profile+3u)+group.x)*64u+thread;
  if index>=sample_load(profile+1u) || index>=sample_load(SAMPLE_HEADER_records) { return; }
  let record=sample_load(sample_load(SAMPLE_HEADER_indicesBase)+sample_selected_profile*sample_load(SAMPLE_HEADER_records)+index);
  let offset=sample_load(SAMPLE_HEADER_recordsBase)+record*${SURFACE_SAMPLE_RECORD_WORDS}u; let tile=sample_load(offset);
  if sample_load(sample_tile(tile))!=2u { return; }
  let linear=sample_load(offset+SAMPLE_RECORD_pixel); let pixel=vec2u(linear%shading_view.width,linear/shading_view.width);
  let local=pixel-sample_origin(tile); let bit=local.y*8u+local.x;
  let mask=select(sample_load(offset+SAMPLE_RECORD_low),sample_load(offset+SAMPLE_RECORD_high),bit>=32u);
  if (mask&(1u<<(bit%32u)))==0u || sample_load(offset+SAMPLE_RECORD_profile)!=sample_selected_profile { return; }
  surface_write(pixel,sample_load(offset+SAMPLE_RECORD_result));
}` : /* wgsl */ `
@compute @workgroup_size(8,8)
fn shade(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  let tile=group.y*sample_load(SAMPLE_HEADER_tilesX)+group.x;
  if sample_load(sample_tile(tile))!=3u { return; }
  let pixel=sample_origin(tile)+vec2u(thread%8u,thread/8u);
  if pixel.x>=shading_view.width || pixel.y>=shading_view.height { return; }
  let key=textureLoad(visibility_texture,vec2i(pixel),0).x;
  if surface_classify(key)!=sample_selected_profile { return; }
  surface_write(pixel,0xffffffffu);
}`;
  return ["requires unrestricted_pointer_parameters;", SURFACE_SAMPLE_WGSL,
    GPU_VISIBILITY_KEY_WGSL,GPU_MESHLET_RASTER_WORK_WGSL,GPU_INSTANCE_RECORD_WGSL,
    GPU_SHADING_MATERIAL_WGSL,GPU_SPARSE_SHADING_VIEW_WGSL,GPU_SHADING_SURFACE_LITE_WGSL,
    surfaceType,names,"var<private> surface_identity_failed:bool=false;",
    "fn sparse_identity_error(){surface_identity_failed=true;}",
    "fn surface_identity_error(){surface_identity_failed=true;}",
    route,geometryWgsl(virtualGeometry,virtualBankCount),textureWgsl(kernel),
    hasLit ? lightingWgsl(vsmShadowEnabled,physicalEnvironment,scalarAo,
      vsmShadowEnabled ? "vsm" : "legacy") : "",
    hasLit && physicalEnvironment ? ATMOSPHERE_RUNTIME_WGSL : "",
    unlit,lit,LINEAR_REC709_TO_REC2020_WGSL,evaluation,entry].filter(Boolean).join("\n");
}
