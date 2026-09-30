import { surfaceSampleWgsl } from "../render/surface/SurfaceSampleAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";

/** Local bounded bilinear reconstruction over immutable, compatible samples.
 * Missing/rejected neighbors normalize the surviving weights, including owner. */
export const SURFACE_SAMPLE_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read_write> work:SurfaceSampleWork;
@group(0) @binding(1) var results:texture_2d<u32>;
@group(0) @binding(2) var output_hdr:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var resolve_keys:texture_2d<u32>;
@group(0) @binding(4) var resolve_depth:texture_depth_2d;
struct ResolveBudget { color:f32, parameter:f32, normal:f32, depth:f32, rest:vec4f, }
@group(0) @binding(5) var<uniform> budget:ResolveBudget;
${GPU_VISIBILITY_KEY_WGSL}
${surfaceSampleWgsl(true)}
fn resolve_sample(pixel:vec2u,packed:u32)->u32 {
  if any(pixel>=vec2u(sample_load(SAMPLE_HEADER_width),sample_load(SAMPLE_HEADER_height))) { return 0xffffffffu; }
  if !oengine_visibility_key_is_valid(textureLoad(resolve_keys,vec2i(pixel),0).x) { return 0xffffffffu; }
  let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u; let base=sample_tile(tile);
  let mode=sample_load(base); if mode!=1u && mode!=2u { return 0xffffffffu; }
  let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
  let current=sample_load(base+SAMPLE_TILE_cellRates+cell); let rate=sample_material_rate(current);
  if rate==0u || current!=packed || rate!=surface_signal_rate(current,SURFACE_SIGNAL_LIGHTING_SHIFT) { return 0xffffffffu; }
  let stride=sample_stride(rate); let child=(local%2u)/stride;
  return sample_load(base+SAMPLE_TILE_cellResults+cell)+child.y*(2u/stride.x)+child.x;
}
fn resolve_field(result:u32,field:u32)->vec4f { return bitcast<vec4f>(textureLoad(results,sample_field_pixel(result,field),0)); }
@compute @workgroup_size(8,8)
fn resolve(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) thread:u32) {
  sample_initialize_header(thread);
  if sample_load(SAMPLE_COUNTER_results)==0u { return; }
  let pixel=id.xy; if any(pixel>=vec2u(sample_load(SAMPLE_HEADER_width),sample_load(SAMPLE_HEADER_height))) { return; }
  let tile=(pixel.y/8u)*sample_load(SAMPLE_HEADER_tilesX)+pixel.x/8u;
  let local=pixel%8u; let cell=(local.y/2u)*4u+local.x/2u;
  let packed=sample_load(sample_tile(tile)+SAMPLE_TILE_cellRates+cell);
  let owner=resolve_sample(pixel,packed); if owner>=sample_load(SAMPLE_HEADER_results) { return; }
  if ((textureLoad(results,sample_field_pixel(owner,SAMPLE_FIELD_closure),0).w>>SAMPLE_RESULT_kindShift)&SAMPLE_RESULT_kindMask)!=SAMPLE_KIND_fused { return; }
  let owner_color=resolve_field(owner,SAMPLE_FIELD_value);
  let identity=textureLoad(results,sample_field_pixel(owner,SAMPLE_FIELD_identity),0);
  let footprint=textureLoad(results,sample_field_pixel(owner,SAMPLE_FIELD_footprint),0);
  let origin=footprint.yz; let stride=sample_stride(sample_material_rate(packed));
  let fraction=clamp(vec2f(pixel-origin)/vec2f(stride),vec2f(0.0),vec2f(1.0));
  let target_depth=textureLoad(resolve_depth,vec2i(pixel),0);
  let owner_normal=resolve_field(owner,SAMPLE_FIELD_normal).xyz;
  var sum=owner_color*(1.0-fraction.x)*(1.0-fraction.y);
  var total=(1.0-fraction.x)*(1.0-fraction.y);
  for(var corner=1u;corner<4u;corner++) {
    let offset=vec2u(corner&1u,corner>>1u);
    let weight=select(1.0-fraction.x,fraction.x,offset.x!=0u)*select(1.0-fraction.y,fraction.y,offset.y!=0u);
    if weight<=0.0 { continue; }
    let position=origin+offset*stride; let candidate=resolve_sample(position,packed);
    var valid=candidate<sample_load(SAMPLE_HEADER_results) && identity.w!=0u;
    if valid {
      let neighbor_identity=textureLoad(results,sample_field_pixel(candidate,SAMPLE_FIELD_identity),0);
      let neighbor_footprint=textureLoad(results,sample_field_pixel(candidate,SAMPLE_FIELD_footprint),0);
      let normal=resolve_field(candidate,SAMPLE_FIELD_normal).xyz; let depth=bitcast<f32>(neighbor_footprint.x);
      let color=resolve_field(candidate,SAMPLE_FIELD_value);
      valid=all(neighbor_identity==identity) && neighbor_footprint.w==footprint.w &&
        all(neighbor_footprint.yz==position) &&
        ((textureLoad(results,sample_field_pixel(candidate,SAMPLE_FIELD_closure),0).w>>SAMPLE_RESULT_kindShift)&SAMPLE_RESULT_kindMask)==SAMPLE_KIND_fused &&
        (textureLoad(results,sample_field_pixel(candidate,SAMPLE_FIELD_closure),0).w>>SAMPLE_RESULT_rateShift)==packed &&
        all(abs(normal-owner_normal)<=vec3f(budget.normal)) && abs(depth-target_depth)<=budget.depth &&
        all(abs(color)<=vec4f(65504.0)) && target_depth>=0.0 && target_depth<=1.0;
      if valid { sum+=color*weight; total+=weight; }
    }
    if valid { sample_add(SAMPLE_COUNTER_reconstructionAccepted,1u); }
    else { sample_add(SAMPLE_COUNTER_reconstructionRejected,1u); }
  }
  textureStore(output_hdr,vec2i(pixel),select(owner_color,sum/max(total,1e-8),total>0.0));
}
`;
