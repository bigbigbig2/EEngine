import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { SURFACE_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import { surfaceSampleWgsl, SURFACE_SAMPLE_RECORD_WORDS, SURFACE_SAMPLE_THREADS,
  SURFACE_SAMPLE_DISPATCH } from "../render/surface/SurfaceSampleAbi.js";
import type { SurfacePhysicalBindingPlan } from "../render/surface/SurfaceKernelBindingPlan.js";
import { bindingDeclaration } from "./surface_binding_declarations.js";
import { geometryWgsl, lightingWgsl, materialEvaluationWgsl, textureWgsl } from "./surface_material_kernel.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";
import { SURFACE_SAMPLE_SURFACE_WGSL, SURFACE_SAMPLE_LOAD_WGSL, SURFACE_SAMPLE_STORE_WGSL } from "./surface_sample_result.js";
import { surfaceContinuityWgsl } from "./surface_continuity.js";
import { SURFACE_TRIANGLE_SETUP_WGSL, SURFACE_TRIANGLE_SETUP_LOCAL_WGSL } from "./surface_triangle_setup.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";
export function surfaceSampleWorkerWgsl(plan: SurfacePhysicalBindingPlan,
  hasLit: boolean, virtualGeometry: boolean,
  vsmShadowEnabled = false, virtualBankCount = 4, textureBankMask = 0x1ff,
  physicalEnvironment = true, closureLighting = false): string {
  const kernel = { programId: 15, outputDependencyMask: 0, textureBankMask };
  const unlit = materialEvaluationWgsl({ ...kernel, programId: 3 }, true, true,
    SURFACE_TRIANGLE_SETUP_LOCAL_WGSL).replace("fn sparse_evaluate_geometry(", "fn sparse_evaluate_unlit_geometry(");
  const lit = hasLit ? materialEvaluationWgsl(kernel, false, true, SURFACE_TRIANGLE_SETUP_LOCAL_WGSL) : "";
  const scalarAo = plan.bindings.some(binding => binding.role === "indirect-visibility");
  const names = plan.bindings.map(bindingDeclaration).join("\n");
  const surfaceType = SURFACE_SAMPLE_SURFACE_WGSL;
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
      surface_instance_record(work_item.instance_slot).geometry_record_index != work_item.geometry_slot ||
      asset_metadata_heap[shading_view.geometry_generation_word_base+work_item.geometry_slot] !=
        oengine_instance_geometry_generation(surface_instance_record(work_item.instance_slot)) {
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
fn surface_evaluate(pixel:vec2u,key:u32)->OEngineSparseSurface {
  let slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || slot>=meshlet_work.header.written_count { return surface_error(); }
  let work_item=meshlet_work.elements[slot]; let material_slot=work_item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) { return surface_error(); }
  let material=material_records[material_slot];
  if material.family>2u || material.texture_binding_set_id!=sample_dispatch.x ||
    ((work_item.packed_raster_flags>>8u)&63u)!=material.texture_binding_set_id*16u+material.program_id ||
    material.material_generation!=shading_view.material_generation ||
    material.texture_generation!=shading_view.texture_generation ||
    material.publication_revision!=shading_view.publication_revision { return surface_error(); }
  surface_identity_failed=false;
  ${geometryCheck}
  if surface_identity_failed { return surface_error(); }
  let primitive=oengine_visibility_key_local_primitive(key); var surface:OEngineSparseSurface;
  sample_add(SAMPLE_COUNTER_material,1u);
  if material.family==0u {
    surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);
  } else {
    ${hasLit ? "surface=sparse_evaluate_geometry(pixel,work_item,primitive,material_slot,material);" :
      "surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);"}
  }
  if surface_identity_failed { return surface_error(); }
  return surface;
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
  let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u;
  let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
  let packed=sample_load(sample_tile(tile)+SAMPLE_TILE_cellRates+cell);
  let surface=surface_evaluate(pixel,key);
  let split=result!=0xffffffffu && sample_material_rate(packed)!=surface_signal_rate(packed,SURFACE_SIGNAL_LIGHTING_SHIFT);
  var linear=surface.base_color;
  ${hasLit ? "if !split && (surface.flags&OENGINE_SURFACE_FLAG_UNLIT)==0u && surface.flags!=0u { sample_add(SAMPLE_COUNTER_lighting,1u); linear=sparse_direct(surface,pixel); }" : ""}
  let color=vec4f(oengine_linear_rec709_to_rec2020(linear)*radiometry_pre_exposure.value,surface.alpha);
  if result==0xffffffffu { textureStore(output_hdr,vec2i(pixel),color); sample_add(SAMPLE_COUNTER_full,1u); }
  else {
    let slot=oengine_visibility_key_meshlet_work_slot(key);
    if slot>=meshlet_work.header.written_count { return; }
    let item=meshlet_work.elements[slot];
    let triangle=surface_triangle(item,oengine_visibility_key_local_primitive(key));
    surface_store(result,surface,select(color,vec4f(surface.base_color,surface.alpha),split),pixel,item,
      select(0u,triangle.metadata.x,triangle.valid),packed,select(SAMPLE_KIND_fused,SAMPLE_KIND_split,split));
    sample_add(SAMPLE_COUNTER_coarse,1u); surface_count_signal_work(pixel,result);
  }
}
`;
  // Dispatch mode is uniform across a workgroup. Resolve addressing first, then
  // call the expensive material/lighting body once for all three work kinds.
  const entry = /* wgsl */ `
fn surface_address(group:vec3u,thread:u32)->vec3u {
  var pixel:vec2u;
  var result=0xffffffffu;
  let profile=sample_profile(sample_dispatch.x);
  if sample_dispatch.y==${SURFACE_SAMPLE_DISPATCH.implicit}u {
  let index=group.y*sample_load(profile+2u)+group.x;
  if index>=sample_load(profile) { return vec3u(0xffffffffu); }
  let tile=sample_load(sample_load(SAMPLE_HEADER_descriptors)+sample_dispatch.x*sample_load(SAMPLE_HEADER_tileCount)+index);
  let base=sample_tile(tile); if sample_load(base)!=1u { return vec3u(0xffffffffu); }
  let packed_rate=sample_load(base+SAMPLE_TILE_rate); let rate=sample_material_rate(packed_rate); let stride=sample_stride(rate); let local=vec2u(thread%8u,thread/8u);
  if any(local%stride!=vec2u(0u)) { return vec3u(0xffffffffu); }
  let cell=(local.y/2u)*4u+local.x/2u; let child=(local%2u)/stride;
  result=select(0xffffffffu,sample_load(base+SAMPLE_TILE_cellResults+cell)+child.y*(2u/stride.x)+child.x,rate!=0u);
  pixel=sample_origin(tile)+local;
  } else if sample_dispatch.y==${SURFACE_SAMPLE_DISPATCH.compact}u {
  let index=(group.y*sample_load(profile+3u)+group.x)*${SURFACE_SAMPLE_THREADS}u+thread;
  if index>=sample_load(profile+1u) || index>=sample_load(SAMPLE_HEADER_records) { return vec3u(0xffffffffu); }
  let record=sample_load(sample_load(SAMPLE_HEADER_indicesBase)+sample_dispatch.x*sample_load(SAMPLE_HEADER_records)+index);
  let offset=sample_load(SAMPLE_HEADER_recordsBase)+record*${SURFACE_SAMPLE_RECORD_WORDS}u; let tile=sample_load(offset);
  if sample_load(sample_tile(tile))!=2u { return vec3u(0xffffffffu); }
  let linear=sample_load(offset+SAMPLE_RECORD_pixel); pixel=vec2u(linear%shading_view.width,linear/shading_view.width);
  let local=pixel-sample_origin(tile); let bit=local.y*8u+local.x;
  let mask=select(sample_load(offset+SAMPLE_RECORD_low),sample_load(offset+SAMPLE_RECORD_high),bit>=32u);
  if (mask&(1u<<(bit%32u)))==0u || sample_load(offset+SAMPLE_RECORD_profile)!=sample_dispatch.x { return vec3u(0xffffffffu); }
  result=sample_load(offset+SAMPLE_RECORD_result);
  } else if sample_dispatch.y==${SURFACE_SAMPLE_DISPATCH.fallback}u {
  let tile=group.y*sample_load(SAMPLE_HEADER_tilesX)+group.x;
  if sample_load(sample_tile(tile))!=3u { return vec3u(0xffffffffu); }
  pixel=sample_origin(tile)+vec2u(thread%8u,thread/8u);
  if pixel.x>=shading_view.width || pixel.y>=shading_view.height { return vec3u(0xffffffffu); }
  let key=textureLoad(visibility_texture,vec2i(pixel),0).x;
  if surface_classify(key)!=sample_dispatch.x { return vec3u(0xffffffffu); }
  } else { return vec3u(0xffffffffu); }
  return vec3u(pixel,result);
}
@compute @workgroup_size(${SURFACE_SAMPLE_THREADS})
fn shade(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  sample_initialize_header(thread);
  let address=surface_address(group,thread);
  var key=OENGINE_VISIBILITY_KEY_EMPTY;
  if address.x!=0xffffffffu { key=textureLoad(visibility_texture,vec2i(address.xy),0).x; }
  surface_sample_key=key;
  surface_setup_prepare(key,thread);
  if address.x==0xffffffffu { return; }
  surface_write(address.xy,address.z);
}`;
  const lightingEntry = /* wgsl */ `
@compute @workgroup_size(8,8)
fn shade_closure(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) thread:u32) {
  sample_initialize_header(thread);
  let pixel=id.xy;
  var result=0xffffffffu; var key=OENGINE_VISIBILITY_KEY_EMPTY;
  if all(pixel<vec2u(shading_view.width,shading_view.height)) {
    let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u;
    let base=sample_tile(tile); let mode=sample_load(base);
    let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
    let packed=sample_load(base+SAMPLE_TILE_cellRates+cell); let rate=sample_material_rate(packed);
    if (mode==1u || mode==2u) && rate!=0u && rate!=surface_signal_rate(packed,SURFACE_SIGNAL_LIGHTING_SHIFT) {
      let stride=sample_stride(rate); let child=(local%2u)/stride;
      result=sample_load(base+SAMPLE_TILE_cellResults+cell)+child.y*(2u/stride.x)+child.x;
      if result<sample_load(SAMPLE_HEADER_results) { key=textureLoad(visibility_texture,vec2i(pixel),0).x; }
    }
  }
  surface_sample_key=key;
  surface_setup_prepare(key,thread);
  if !oengine_visibility_key_is_valid(key) || result>=sample_load(SAMPLE_HEADER_results) { return; }
  var surface=surface_load_closure(result);
  let kind=(textureLoad(sample_results,sample_field_pixel(result,SAMPLE_FIELD_closure),0).w>>SAMPLE_RESULT_kindShift)&SAMPLE_RESULT_kindMask;
  if kind!=SAMPLE_KIND_split { return; }
  let slot=oengine_visibility_key_meshlet_work_slot(key);
  if slot>=meshlet_work.header.written_count { return; }
  let item=meshlet_work.elements[slot];
  surface_identity_failed=false;
  let setup=surface_setup_for_work(item,oengine_visibility_key_local_primitive(key));
  let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),setup.c0,setup.c1,setup.c2);
  var linear=surface.base_color;
  if surface.flags!=0u && !surface_identity_failed && bary.valid {
    surface.position_ws=setup.p0.xyz*bary.weights.x+setup.p1.xyz*bary.weights.y+setup.p2.xyz*bary.weights.z;
    surface.view_depth=textureLoad(visibility_depth,vec2i(pixel),0);
    // The split profile only accepts texture-free normals. Restore the target
    // pixel normal to retain view/geometry dependence across the certified cell.
    let geometric=normalize(cross(setup.p1.xyz-setup.p0.xyz,setup.p2.xyz-setup.p0.xyz));
    let local_normal=normalize(sparse_normal_ref(setup.ref0)*bary.weights.x+sparse_normal_ref(setup.ref1)*bary.weights.y+sparse_normal_ref(setup.ref2)*bary.weights.z);
    surface.geometric_normal=geometric; surface.shading_normal=surface_world_normal(item.instance_slot,local_normal,geometric);
    ${hasLit ? "if (surface.flags&OENGINE_SURFACE_FLAG_UNLIT)==0u { linear=sparse_direct(surface,pixel); sample_add(SAMPLE_COUNTER_lighting,1u); }" : ""}
  } else { linear=vec3f(1.0,0.0,1.0); }
  textureStore(output_hdr,vec2i(pixel),vec4f(oengine_linear_rec709_to_rec2020(linear)*radiometry_pre_exposure.value,surface.alpha));
  sample_add(SAMPLE_COUNTER_splitPixels,1u);
}
`;
  return ["requires unrestricted_pointer_parameters;", surfaceSampleWgsl(true),
    GPU_VISIBILITY_KEY_WGSL,GPU_MESHLET_RASTER_WORK_WGSL,GPU_INSTANCE_RECORD_WGSL,
    SURFACE_FRAME_INSTANCE_WGSL,
    GPU_SHADING_MATERIAL_WGSL,GPU_SPARSE_SHADING_VIEW_WGSL,GPU_SHADING_SURFACE_LITE_WGSL,
    surfaceType,names,"var<private> surface_identity_failed:bool=false;",
    "fn sparse_identity_error(){surface_identity_failed=true;}",
    "fn surface_identity_error(){surface_identity_failed=true;}",
    geometryWgsl(virtualGeometry,virtualBankCount),SURFACE_TRIANGLE_SETUP_WGSL,
    closureLighting ? SURFACE_SAMPLE_LOAD_WGSL : surfaceContinuityWgsl(virtualGeometry,virtualBankCount),
    closureLighting ? "" : SURFACE_SAMPLE_STORE_WGSL,
    closureLighting ? "" : route,closureLighting ? "" : textureWgsl(kernel),
    hasLit ? lightingWgsl(vsmShadowEnabled,physicalEnvironment,scalarAo,
      vsmShadowEnabled ? "vsm" : "legacy") : "",
    hasLit && physicalEnvironment ? ATMOSPHERE_RUNTIME_WGSL : "",
    closureLighting ? "" : unlit,closureLighting ? "" : lit,LINEAR_REC709_TO_REC2020_WGSL,
    closureLighting ? lightingEntry : evaluation,closureLighting ? "" : entry].filter(Boolean).join("\n");
}
