import { SURFACE_SAMPLE_WGSL, SURFACE_SAMPLE_PROFILES, SURFACE_SAMPLE_THREADS, SURFACE_SAMPLE_RECORD_WORDS } from "../render/surface/SurfaceSampleAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
export const SURFACE_SAMPLE_FINALIZE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read_write> work:SurfaceSampleWork;
@group(0) @binding(1) var<storage,read_write> indirect:array<vec4u>;
${SURFACE_SAMPLE_WGSL}
@compute @workgroup_size(4)
fn finalize(@builtin(local_invocation_index) profile:u32) {
  let base=sample_profile(profile); let maximum=sample_load(SAMPLE_HEADER_maxDispatch);
  let descriptors=sample_load(base);
  let compact=(min(sample_load(base+SAMPLE_TILE_profile),sample_load(SAMPLE_HEADER_records))+${SURFACE_SAMPLE_THREADS-1}u)/${SURFACE_SAMPLE_THREADS}u;
  let descriptor_x=min(descriptors,maximum); let compact_x=min(compact,maximum);
  sample_store(base+SAMPLE_TILE_rate,descriptor_x); sample_store(base+3u,compact_x);
  indirect[profile*2u]=vec4u(descriptor_x,(descriptors+max(1u,descriptor_x)-1u)/max(1u,descriptor_x),1u,0u);
  indirect[profile*2u+1u]=vec4u(compact_x,(compact+max(1u,compact_x)-1u)/max(1u,compact_x),1u,0u);
}
`;
export function surfaceSampleBuilderWgsl(hasLit: boolean, scalarAo: boolean): string {
  return /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_SPARSE_SHADING_VIEW_WGSL}
@group(0) @binding(0) var<storage,read_write> work:SurfaceSampleWork;
@group(0) @binding(1) var keys:texture_2d<u32>;
@group(0) @binding(2) var rates:texture_2d<u32>;
@group(0) @binding(3) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage,read> material_records:array<OEngineShadingMaterialRecord>;
@group(0) @binding(5) var<uniform> shading_view:OEngineSparseShadingView;
@group(0) @binding(6) var<uniform> policy:vec4u;
${hasLit ? "@group(0) @binding(7) var<storage,read> lighting_words:array<u32>;" : ""}
${scalarAo ? "@group(0) @binding(8) var<storage,read> ao_words:array<u32>;" : ""}
${SURFACE_SAMPLE_WGSL}
var<workgroup> pixel_profiles:array<u32,64>;
var<workgroup> cell_rates:array<u32,16>;
fn sample_classify(key:u32)->u32 {
  if !oengine_visibility_key_is_valid(key) { return 4u; }
  let slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || slot>=meshlet_work.header.written_count { return sample_load(SAMPLE_HEADER_errorProfile); }
  let item=meshlet_work.elements[slot]; let material_slot=item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) { return sample_load(SAMPLE_HEADER_errorProfile); }
  let material=material_records[material_slot];
  if material.texture_binding_set_id>=${SURFACE_SAMPLE_PROFILES}u || material.family>2u ||
    ((item.packed_raster_flags>>8u)&63u)!=material.texture_binding_set_id*16u+material.program_id ||
    material.material_generation!=shading_view.material_generation ||
    material.texture_generation!=shading_view.texture_generation ||
    material.publication_revision!=shading_view.publication_revision { return sample_load(SAMPLE_HEADER_errorProfile); }
  return material.texture_binding_set_id;
}
${scalarAo ? `fn sample_ao(pixel:vec2u)->u32 {
  let index=pixel.y*shading_view.width+pixel.x;
  return (ao_words[index>>2u]>>((index&3u)*8u))&255u;
}` : ""}
@compute @workgroup_size(8,8)
fn build(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  let tile=group.y*sample_load(SAMPLE_HEADER_tilesX)+group.x; let origin=group.xy*8u;
  let pixel=origin+vec2u(thread%8u,thread/8u);
  var profile=4u;
  if pixel.x<shading_view.width && pixel.y<shading_view.height {
    profile=sample_classify(textureLoad(keys,vec2i(pixel),0).x);
  }
  pixel_profiles[thread]=profile;
  if thread<16u {
    let cell=origin+sample_cell_origin(thread); var rate=textureLoad(rates,vec2i(cell/2u),0).x;
    if cell.x+1u>=shading_view.width || cell.y+1u>=shading_view.height { rate=0u; }
    let unsafe_lighting=policy.x!=0u${hasLit ? " || arrayLength(&lighting_words)<5u || lighting_words[4u]!=0u" : ""};
    if surface_signal_rate(rate,SURFACE_SIGNAL_LIGHTING_SHIFT)!=0u && unsafe_lighting {
      rate=surface_signal_set(rate,SURFACE_SIGNAL_LIGHTING_SHIFT,0u); sample_add(SAMPLE_COUNTER_lightingRejected,1u);
    }
    ${scalarAo ? `if surface_signal_rate(rate,SURFACE_SIGNAL_LIGHTING_SHIFT)!=0u {
      let visibility=sample_ao(cell);
      if visibility!=sample_ao(cell+vec2u(1u,0u)) || visibility!=sample_ao(cell+vec2u(0u,1u)) ||
        visibility!=sample_ao(cell+vec2u(1u,1u)) { rate=0u; sample_add(SAMPLE_COUNTER_lightingRejected,1u); }
    }` : ""}
    cell_rates[thread]=rate;
  }
  workgroupBarrier();
  if thread!=0u { return; }
  let tile_base=sample_tile(tile); var homogeneous=true; var empty=true;
  for(var index=0u;index<64u;index++) {
    homogeneous=homogeneous && pixel_profiles[index]==pixel_profiles[0u];
    empty=empty && pixel_profiles[index]==4u;
  }
  for(var cell=0u;cell<16u;cell++) {
    let local=sample_cell_origin(cell); let first=local.y*8u+local.x;
    if cell_rates[cell]!=0u && (pixel_profiles[first]>=4u ||
      pixel_profiles[first]!=pixel_profiles[first+1u] || pixel_profiles[first]!=pixel_profiles[first+8u] ||
      pixel_profiles[first]!=pixel_profiles[first+9u]) { cell_rates[cell]=0u; }
    homogeneous=homogeneous && cell_rates[cell]==cell_rates[0u];
    sample_store(tile_base+SAMPLE_TILE_cellRates+cell,cell_rates[cell]);
  }
  if empty { sample_store(tile_base,0u); return; }
  homogeneous=homogeneous && pixel_profiles[0u]<4u;
  var records=0u; var results=0u;
  for(var cell=0u;cell<16u;cell++) {
    let rate=sample_effective_rate(cell_rates[cell]); let stride=sample_stride(rate); let local_origin=sample_cell_origin(cell);
    sample_store(tile_base+SAMPLE_TILE_cellResults+cell,results);
    for(var vertical=0u;vertical<2u;vertical+=stride.y) {
      for(var horizontal=0u;horizontal<2u;horizontal+=stride.x) {
        let local=local_origin+vec2u(horizontal,vertical);
        if pixel_profiles[local.y*8u+local.x]<4u {
          if !homogeneous { records++; }
          if rate!=0u { results++; }
        }
      }
    }
  }
  var record_base=0u; var result_base=0u;
  if records!=0u { record_base=sample_add(SAMPLE_COUNTER_records,records); }
  if results!=0u { result_base=sample_add(SAMPLE_COUNTER_results,results); }
  let records_valid=record_base+records<=sample_load(SAMPLE_HEADER_records);
  let results_valid=result_base+results<=sample_load(SAMPLE_HEADER_results);
  if !records_valid || !results_valid {
    sample_store(tile_base,3u); sample_add(SAMPLE_COUNTER_fallback,1u);
    if !records_valid { sample_add(SAMPLE_COUNTER_recordOverflow,1u); }
    if !results_valid { sample_add(SAMPLE_COUNTER_resultOverflow,1u); }
    return;
  }
  sample_store(tile_base+SAMPLE_TILE_profile,pixel_profiles[0u]); sample_store(tile_base+SAMPLE_TILE_rate,cell_rates[0u]);
  sample_store(tile_base+SAMPLE_TILE_result,result_base);
  for(var cell=0u;cell<16u;cell++) {
    sample_store(tile_base+SAMPLE_TILE_cellResults+cell,sample_load(tile_base+SAMPLE_TILE_cellResults+cell)+result_base);
  }
  if homogeneous {
    let profile=pixel_profiles[0u]; let slot=sample_add(sample_profile(profile),1u);
    sample_store(sample_load(SAMPLE_HEADER_descriptors)+profile*sample_load(SAMPLE_HEADER_tileCount)+slot,tile);
    sample_store(tile_base,1u); sample_add(SAMPLE_COUNTER_implicit,1u); return;
  }
  var record_offset=0u;
  for(var cell=0u;cell<16u;cell++) {
    let rate=sample_effective_rate(cell_rates[cell]); let stride=sample_stride(rate); let local_origin=sample_cell_origin(cell);
    var result_offset=0u;
    for(var vertical=0u;vertical<2u;vertical+=stride.y) {
      for(var horizontal=0u;horizontal<2u;horizontal+=stride.x) {
        let local=local_origin+vec2u(horizontal,vertical); let profile=pixel_profiles[local.y*8u+local.x];
        if profile>=4u { continue; }
        let record=record_base+record_offset; record_offset++;
        let offset=sample_load(SAMPLE_HEADER_recordsBase)+record*${SURFACE_SAMPLE_RECORD_WORDS}u; let representative=origin+local;
        let mask=sample_mask(local.y*8u+local.x,rate);
        sample_store(offset,tile); sample_store(offset+SAMPLE_RECORD_pixel,representative.y*shading_view.width+representative.x);
        sample_store(offset+SAMPLE_RECORD_low,mask.x); sample_store(offset+SAMPLE_RECORD_high,mask.y);
        sample_store(offset+SAMPLE_RECORD_result,select(0xffffffffu,sample_load(tile_base+SAMPLE_TILE_cellResults+cell)+result_offset,rate!=0u));
        sample_store(offset+SAMPLE_RECORD_profile,profile); result_offset++;
        let slot=sample_add(sample_profile(profile)+1u,1u);
        sample_store(sample_load(SAMPLE_HEADER_indicesBase)+profile*sample_load(SAMPLE_HEADER_records)+slot,record);
      }
    }
  }
  sample_store(tile_base,2u); sample_add(SAMPLE_COUNTER_mixed,1u);
}
`;
}
export const SURFACE_SAMPLE_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read_write> work:SurfaceSampleWork;
@group(0) @binding(1) var results:texture_2d<f32>;
@group(0) @binding(2) var output_hdr:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var resolve_keys:texture_2d<u32>;
@group(0) @binding(4) var resolve_depth:texture_depth_2d;
${GPU_VISIBILITY_KEY_WGSL}
${SURFACE_SAMPLE_WGSL}
@compute @workgroup_size(8,8)
fn resolve(@builtin(global_invocation_id) id:vec3u) {
  let pixel=id.xy; if pixel.x>=sample_load(SAMPLE_HEADER_width) || pixel.y>=sample_load(SAMPLE_HEADER_height) { return; }
  if !oengine_visibility_key_is_valid(textureLoad(resolve_keys,vec2i(pixel),0).x) { return; }
  let depth=textureLoad(resolve_depth,vec2i(pixel),0);
  if !(depth>=0.0 && depth<=1.0) { return; }
  let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u; let base=sample_tile(tile);
  let mode=sample_load(base); if mode!=1u && mode!=2u { return; }
  let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
  let packed=sample_load(base+SAMPLE_TILE_cellRates+cell); let rate=sample_effective_rate(packed); if rate==0u { return; }
  let stride=sample_stride(rate); let child=(local%2u)/stride;
  let result=sample_load(base+SAMPLE_TILE_cellResults+cell)+child.y*(2u/stride.x)+child.x;
  if result>=sample_load(SAMPLE_HEADER_results) { return; }
  textureStore(output_hdr,vec2i(pixel),textureLoad(results,sample_result_pixel(result),0));
}
`;
