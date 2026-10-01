import type { SparseLightingProfile } from "../gpu/GpuSparseLightingAbi.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { winnerPrimitiveArenaConsumerWgsl } from "./winner_primitive_work.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { productionSurfaceLightMathWgsl } from "./lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { OENGINE_ENVIRONMENT_BRDF_WGSL } from "./environment_brdf.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";
import { surfaceGeometrySourceReaderWgsl } from "./surface_geometry_reader.js";
import { APPEARANCE_SURFACE_READ_WGSL, APPEARANCE_FIELD_COUNT } from "../gpu/GpuAppearanceCacheAbi.js";

/** Cluster-local primary packets, with no subgroup-width assumption. The cheap
 * classifier is 64 lanes per 16x16 tile (one quad per lane). Only compacted
 * primaries enter the 64-lane light consumer. Result publication, temporal
 * references and reconstruction have separate dispatch boundaries. */
export function surfaceSparseLightingWgsl(profile: SparseLightingProfile): string {
  return /* wgsl */ `requires unrestricted_pointer_parameters;
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${productionSurfaceLightMathWgsl(profile.vsm)}
${OCTAHEDRAL_SAMPLE_WGSL}
${profile.environment ? OENGINE_ENVIRONMENT_BRDF_WGSL : ""}
${LINEAR_REC709_TO_REC2020_WGSL}
${APPEARANCE_SURFACE_READ_WGSL}
struct LightingSettings {
  extent: vec4u, // width, height, frame index, history valid
  geometry: vec4u, // arena header, directory, light epoch, environment epoch
  spatial: vec4f, // normal cosine, relative position, minimum roughness, view cosine
  temporal: vec4f, // normal cosine, relative position, unused, unused
  ages: vec4u, // per-signal bounded refresh age, indirect grid limit
  reserved: vec4u,
  source: vec4u,
  source_payload: vec4u,
}
struct ShadingView { width: u32, height: u32, }
@group(0) @binding(0) var<uniform> settings: LightingSettings;
@group(0) @binding(1) var<uniform> camera: CommandEncoder;
@group(0) @binding(2) var fields: texture_2d_array<f32>;
@group(0) @binding(3) var guide: texture_2d_array<f32>;
@group(0) @binding(4) var signature: texture_2d<u32>;
@group(0) @binding(5) var motion: texture_2d<f32>;
@group(0) @binding(6) var mask: texture_2d<f32>;
@group(0) @binding(7) var identity: texture_2d<u32>;
@group(0) @binding(8) var previous_identity: texture_2d<u32>;
@group(0) @binding(9) var previous_guide: texture_2d_array<f32>;
@group(0) @binding(10) var previous_signature: texture_2d<u32>;
@group(0) @binding(11) var previous_signals: texture_2d_array<f32>;
@group(0) @binding(12) var primary_radiance: texture_2d_array<f32>;
@group(0) @binding(13) var<uniform> previous_camera: CommandEncoder;
@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(1) var<uniform> cluster_parameters: vec3f;
@group(1) @binding(2) var<storage, read> cluster_lookup: array<ClusterMetadata>;
@group(1) @binding(3) var<storage, read> cluster_data: ClusterData;
${profile.vsm ? /* wgsl */ `
@group(1) @binding(4) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(1) @binding(5) var vsm_atlas: texture_depth_2d;
@group(1) @binding(6) var<uniform> vsm_constants: VsmSamplingConstants;
fn lighting_shadow_stamp(position: vec3f) -> u32 {
  let light = (vsm_constants.light_view * vec4f(position, 1.0)).xyz;
  let selected = vsm_clip_level(light.xy);
  let levels = max(1u, min(6u, vsm_constants.control.x));
  for (var level = selected; level < levels; level++) {
    let uv = vsm_clip_uv(light.xy, level);
    for (var mip = 0u; mip < 6u; mip++) {
      let entry = vsm_lookup(level, uv, mip);
      if vsm_page_is_current(entry, vsm_constants.control.y) && (entry.flags & 2u) == 0u {
        var stamp = light_hash(2166136261u, entry.generation);
        stamp = light_hash(stamp, entry.reserved_0);
        stamp = light_hash(stamp, entry.slot_x | (entry.slot_y << 16u));
        return light_hash(stamp, entry.mip | (level << 16u));
      }
    }
  }
  return light_hash(0u, vsm_constants.control.y);
}` : "fn lighting_shadow_stamp(_position: vec3f) -> u32 { return 0u; }"}
${profile.environment ? /* wgsl */ `
@group(1) @binding(7) var ibl_diffuse: texture_2d<f32>;
@group(1) @binding(8) var ibl_specular: texture_2d<f32>;
@group(1) @binding(9) var dfg: texture_2d<f32>;
@group(1) @binding(12) var ibl_sampler: sampler;` : ""}
${profile.ao ? "@group(1) @binding(10) var<storage, read> scalar_ao: array<u32>;" : ""}
@group(1) @binding(11) var<storage, read> pre_exposure: array<f32>;
@group(2) @binding(0) var<storage, read> geometry_arena: array<u32>;
@group(2) @binding(1) var<storage, read> attributes: array<vec4f>;
@group(2) @binding(2) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(2) @binding(3) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(2) @binding(4) var visibility: texture_2d<u32>;
@group(2) @binding(5) var depth: texture_depth_2d;
@group(2) @binding(6) var<storage, read> vertex_payload: array<u32>;
${profile.product ? `@group(2) @binding(7) var<storage, read> product_heap: array<u32>;
${Array.from({length:4},(_,i)=>`@group(2) @binding(${8+i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}` : ""}
@group(3) @binding(0) var output_guide: texture_storage_2d_array<rgba32float, write>;
@group(3) @binding(1) var output_signature: texture_storage_2d<rgba32uint, write>;
@group(3) @binding(2) var<storage, read_write> references: array<vec4u>;
@group(3) @binding(3) var<storage, read_write> packets: array<vec2u>;
@group(3) @binding(4) var<storage, read_write> packet_control: array<atomic<u32>>;
@group(3) @binding(5) var<storage, read_write> packet_indirect: vec4u;
@group(3) @binding(6) var output_primary: texture_storage_2d_array<rgba16float, write>;
@group(3) @binding(7) var output_hdr: texture_storage_2d<rgba16float, write>;
@group(3) @binding(8) var output_history: texture_storage_2d_array<rgba16float, write>;
@group(3) @binding(9) var output_reactive: texture_storage_2d<rgba8unorm, write>;
@group(3) @binding(10) var<storage, read> packet_dispatch: vec4u;
@group(3) @binding(11) var<storage, read> primary_packets: array<vec2u>;
@group(3) @binding(12) var<storage, read> target_references: array<vec4u>;
${winnerPrimitiveArenaConsumerWgsl("geometry_arena", false)}
${surfaceGeometrySourceReaderWgsl(profile.product, "geometry_arena")}
var<private> shading_view: ShadingView;
const HISTORY_REF: u32 = 0x80000000u;
const NO_SIGNAL: u32 = 0xffffffffu;
fn light_hash(seed: u32, value: u32) -> u32 { return (seed ^ value) * 16777619u; }
// Half RGB plus an exact half-representable scale/age integer. Scale protects
// unexposed scene-linear HDR from binary16 range overflow; temporal age remains
// attached to the original evaluation rather than the reconstruction frame.
fn signal_age(value: vec4f) -> u32 { return u32(value.w) & 15u; }
fn signal_rgb(value: vec4f) -> vec3f { return value.xyz * exp2(f32(u32(value.w) >> 4u)); }
fn pack_signal(rgb: vec3f) -> vec4f {
  let magnitude=max(max(abs(rgb.x),abs(rgb.y)),abs(rgb.z));
  let exponent=u32(max(0.0,ceil(log2(max(magnitude,1.0)))-15.0));
  return vec4f(rgb*exp2(-f32(exponent)),f32(exponent*16u+1u));
}
fn pixel_coord(index: u32) -> vec2i { return vec2i(i32(index % settings.extent.x), i32(index / settings.extent.x)); }
fn pixel_index(p: vec2i) -> u32 { return u32(p.y) * settings.extent.x + u32(p.x); }
fn f(p: vec2i, field: u32) -> vec4f { return surface_field(fields,p,field); }
fn view_direction(p: vec2i) -> vec3f { return normalize(camera.transform[3].xyz-textureLoad(guide,p,0,0).xyz); }
fn g(p: vec2i, layer: u32) -> vec4f {
  if layer==0u { let value=textureLoad(guide,p,0,0); return vec4f(value.xyz,abs(value.w)); }
  if layer==3u {
    let depth=textureLoad(guide,p,0,0).w;
    return vec4f(vec3f(0.0),select(select(1.0,2.0,depth>0.0),0.0,depth==0.0));
  }
  let encoded=textureLoad(guide,p,1,0);
  return vec4f(oct_decode(select(encoded.xy,encoded.zw,layer==2u)),f(p,select(3u,11u,layer==2u)).x);
}
fn attribute_at(ids: vec3u, weights: vec3f, layer: u32) -> vec4f {
  if surface_direct_source { return surface_source_attribute(ids,weights,layer); }
  return attributes[ids.x * ${GPU_FRAME_ATTRIBUTE_VECTORS}u + layer] * weights.x +
    attributes[ids.y * ${GPU_FRAME_ATTRIBUTE_VECTORS}u + layer] * weights.y +
    attributes[ids.z * ${GPU_FRAME_ATTRIBUTE_VECTORS}u + layer] * weights.z;
}
fn normalize_or(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 { return value * inverseSqrt(length2); }
  return fallback;
}
@compute @workgroup_size(8, 8)
fn prepare_surface(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= settings.extent.xy) { return; }
  let p = vec2i(id.xy);
  let key = textureLoad(visibility, p, 0).x;
  let decoded = oengine_visibility_key_decode(key);
  var values: array<vec4f, 2>;
  var sig = vec4u(0u);
  if decoded.valid != 0u {
    let work = meshlet_work.elements[decoded.meshlet_work_slot];
    let at = settings.geometry.y + 4u + decoded.meshlet_work_slot * 4u;
    surface_direct_source=false;
    var interpolation: WinnerInterpolation;
    var ids: vec3u;
    if geometry_arena[at+2u]!=0u {
      interpolation=winner_arena_interpolate_key(key,vec2f(id.xy)+0.5,vec2f(settings.extent.xy),settings.geometry.x,settings.geometry.y);
      let packed=geometry_arena[geometry_arena[settings.geometry.x+7u]+geometry_arena[at+1u]+decoded.local_primitive];
      ids=vec3u(packed&255u,(packed>>8u)&255u,(packed>>16u)&255u)+vec3u(geometry_arena[at]);
    } else {
      interpolation=winner_interpolate(surface_source_coefficients(work,decoded.local_primitive),vec2f(id.xy)+0.5,vec2f(settings.extent.xy));
      ids=vec3u(0u,1u,2u);
    }
    if (interpolation.flags & WINNER_VALUE_VALID) != 0u {
      let instance = frame_instances[work.instance_slot];
      let transform = oengine_instance_current_object_to_world(instance.source);
      let a = attribute_at(ids,vec3f(1.0,0.0,0.0),5u).xyz;
      let b = attribute_at(ids,vec3f(0.0,1.0,0.0),5u).xyz;
      let c = attribute_at(ids,vec3f(0.0,0.0,1.0),5u).xyz;
      let geometric = normalize_or(cross((transform * vec4f(b-a, 0.0)).xyz,
        (transform * vec4f(c-a, 0.0)).xyz), vec3f(0.0, 0.0, 1.0));
      let local_normal = attribute_at(ids, interpolation.weights, 0u).xyz;
      var normal = oengine_frame_instance_normal(instance.normal_x, instance.normal_y, instance.normal_z.xyz, local_normal, geometric);
      let local_tangent = attribute_at(ids, interpolation.weights, 1u);
      let tangent_raw = (transform * vec4f(local_tangent.xyz, 0.0)).xyz;
      var tangent = normalize_or(tangent_raw - normal * dot(normal, tangent_raw),
        normalize_or(cross(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(normal.z)>0.99),normal),vec3f(1.0,0.0,0.0)));
      let position = (transform * vec4f(attribute_at(ids, interpolation.weights, 5u).xyz, 1.0)).xyz;
      let view_dir = normalize_or(camera.transform[3].xyz-position, normal);
      // Two-sided normals follow the actual visible side, including mirrored
      // transforms. Tangent handedness changes only with determinant sign.
      if (instance.source.flags & 16u) != 0u && dot(normal, view_dir) < 0.0 { normal = -normal; tangent = -tangent; }
      let bitangent = cross(normal, tangent) * sign(local_tangent.w) * sign(instance.normal_x.w);
      let tbn = mat3x3f(tangent, bitangent, normal);
      var base_normal = normal;
      var coat_normal = normal;
      if f(p,13u).x>0.5 { base_normal=normalize_or(tbn*f(p,6u).xyz,normal); }
      if f(p,14u).x>0.5 { coat_normal=normalize_or(tbn*f(p,12u).xyz,normal); }
      let view_depth = -(camera.view_matrix * vec4f(position,1.0)).z;
      let lit = ((instance.source.flags >> 8u) & 15u) >= 4u;
      values[0] = vec4f(position, select(-view_depth, view_depth, lit));
      values[1] = vec4f(oct_encode(base_normal), oct_encode(coat_normal));
      // Signatures are change detectors in addition to the exact Temporal
      // identity and geometric tests; they are not Appearance cache keys.
      var hash = vec3u(2166136261u);
${Array.from({length:6},(_,layer)=>`      let words_${layer}=bitcast<vec4u>(textureLoad(fields,p,${layer},0));
${(layer===1?[3]:layer===0||layer===5?[0,1,2]:[0,1,2,3]).map(channel=>
  `      hash.y=light_hash(hash.y,words_${layer}[${channel}]);`).join("\n")}`).join("\n")}
      hash.x=light_hash(hash.x,words_5.z);
      hash.x=light_hash(hash.x,u32(bitcast<f32>(words_5.w))&1u);
      hash.z=light_hash(hash.z,words_5.z);
      hash.z=light_hash(hash.z,u32(bitcast<f32>(words_5.w))&2u);
      for(var i=0u;i<4u;i++) { hash.z=light_hash(hash.z,words_4[i]); }
      let shadow = lighting_shadow_stamp(position);
      hash = (hash ^ vec3u(shadow)) * vec3u(16777619u);
      ${profile.ao ? `let pixel=id.y*settings.extent.x+id.x;
      let ao=(scalar_ao[pixel/4u]>>((pixel&3u)*8u))&255u;
      hash.y=light_hash(hash.y,ao); hash.z=light_hash(hash.z,ao);` : ""}
      sig = vec4u(hash, light_hash(settings.geometry.z, settings.geometry.w));
    }
  }
  for (var layer=0u;layer<2u;layer++) { textureStore(output_guide,p,i32(layer),values[layer]); }
  textureStore(output_signature,p,sig);
}
fn signal_exists(p: vec2i, signal: u32) -> bool {
  if g(p,3u).w != 2.0 { return false; }
  if signal == 0u { return f(p,2u).x < 1.0 && any(f(p,0u).xyz != vec3f(0.0)); }
  if signal == 2u { return f(p,10u).x > 0.0; }
  return f(p,8u).x > 0.0 || f(p,2u).x > 0.0;
}
fn previous_reference(p: vec2i, signal: u32) -> u32 {
  if settings.extent.w == 0u { return NO_SIGNAL; }
  let facts = textureLoad(mask,p,0);
  if facts.y < 0.5 || facts.z > 0.5 || (u32(round(facts.w*255.0)) & 24u) != 0u { return NO_SIGNAL; }
  let uv = (vec2f(p)+0.5)/vec2f(settings.extent.xy)-textureLoad(motion,p,0).xy;
  if any(uv<vec2f(0.0)) || any(uv>=vec2f(1.0)) { return NO_SIGNAL; }
  let q = vec2i(uv*vec2f(settings.extent.xy));
  if any(textureLoad(identity,p,0) != textureLoad(previous_identity,q,0)) { return NO_SIGNAL; }
  let a = textureLoad(signature,p,0); let b = textureLoad(previous_signature,q,0);
  if a[signal] != b[signal] || a.w != b.w { return NO_SIGNAL; }
  let old = textureLoad(previous_signals,q,i32(signal),0);
  // Age is carried from the original evaluation, including spatial copies.
  // Reprojection never resets it. Phase rotation prevents periodic starvation.
  if signal_age(old) < 1u || signal_age(old) >= settings.ages[signal] ||
    (pixel_index(p)+settings.extent.z) % settings.ages[signal] == 0u { return NO_SIGNAL; }
  let layer = select(1u,2u,signal==2u);
  let now_position = g(p,0u); let old_position = textureLoad(previous_guide,q,0,0);
  let scale = max(now_position.w,0.001);
  if distance(now_position.xyz,old_position.xyz) > settings.temporal.y*scale { return NO_SIGNAL; }
  let old_normals=textureLoad(previous_guide,q,1,0);
  let old_normal=oct_decode(select(old_normals.xy,old_normals.zw,signal==2u));
  if dot(g(p,layer).xyz,old_normal) < settings.temporal.x { return NO_SIGNAL; }
  if signal != 0u || f(p,10u).x > 0.0 {
    let old_view=normalize(previous_camera.transform[3].xyz-old_position.xyz);
    if dot(view_direction(p),old_view) < settings.spatial.w { return NO_SIGNAL; }
    if signal != 0u && g(p,layer).w < settings.spatial.z { return NO_SIGNAL; }
  }
  return pixel_index(q) | HISTORY_REF;
}
${profile.vsm ? /* wgsl */ `
// One classifier invocation owns one aligned quad. Cache the exact PCF pair
// decision across independent lobe partitions, rather than querying both
// receivers again for diffuse/specular and identical coat normals.
var<private> shadow_pairs_known: vec2u;
var<private> shadow_pairs_equal: vec2u;
fn shadow_pair_equal(p:vec2i,q:vec2i,signal:u32)->bool {
  let pi=u32(p.x&1)|(u32(p.y&1)<<1u); let qi=u32(q.x&1)|(u32(q.y&1)<<1u);
  let bit=1u<<(min(pi,qi)*4u+max(pi,qi));
  var layer=select(1u,2u,signal==2u);
  if layer==2u && all(g(p,1u).xyz==g(p,2u).xyz) && all(g(q,1u).xyz==g(q,2u).xyz) { layer=1u; }
  let lobe=layer-1u;
  if (shadow_pairs_known[lobe]&bit)!=0u { return (shadow_pairs_equal[lobe]&bit)!=0u; }
  var equal=true;
  var directional=directional_lights_iteration_mask(&node);
  while directional!=0u {
    let index=countTrailingZeros(directional); directional&=~(1u<<index);
    if shadowmap_get_directional_light_visibility(&node,index,g(p,0u).xyz,view_direction(p),g(p,layer).xyz)!=
      shadowmap_get_directional_light_visibility(&node,index,g(q,0u).xyz,view_direction(q),g(q,layer).xyz) {
      equal=false; break;
    }
  }
  shadow_pairs_known[lobe]|=bit;
  if equal { shadow_pairs_equal[lobe]|=bit; }
  return equal;
}` : ""}
fn can_share(p: vec2i, q: vec2i, signal: u32) -> bool {
  if any(textureLoad(identity,p,0) != textureLoad(identity,q,0)) { return false; }
  let p_position = g(p,0u); let q_position = g(q,0u);
  ${profile.direct ? `shading_view = ShadingView(settings.extent.x,settings.extent.y);
  if any(cluster_from_fragment_coord(vec3f(vec2f(p)+0.5,p_position.w)) !=
    cluster_from_fragment_coord(vec3f(vec2f(q)+0.5,q_position.w))) { return false; }` : ""}
  let layer=select(1u,2u,signal==2u);
  // Reject separation from the local surface plane. Euclidean pixel spacing
  // grows with FOV/resolution and must not disable every planar 2x2 footprint.
  let delta=q_position.xyz-p_position.xyz;
  let plane_error=max(abs(dot(delta,g(p,layer).xyz)),abs(dot(delta,g(q,layer).xyz)));
  if plane_error>settings.spatial.y*max(p_position.w,0.001) { return false; }
  if dot(g(p,layer).xyz,g(q,layer).xyz)<settings.spatial.x { return false; }
  if signal != 0u || f(p,10u).x > 0.0 {
    if dot(view_direction(p),view_direction(q)) < settings.spatial.w { return false; }
    if signal != 0u && min(g(p,layer).w,g(q,layer).w)<settings.spatial.z { return false; }
  }
  // Inspect the current fields, never last-frame low contrast alone. No
  // authored texture detail, discontinuity or independent coat is inferred.
  for (var field=0u;field<${APPEARANCE_FIELD_COUNT}u;field++) {
    if field==1u || field==5u || field==6u || field==12u { continue; }
    if signal==0u && field!=10u { continue; }
    if signal==2u && field<10u { continue; }
    if any(f(p,field)!=f(q,field)) { return false; }
  }
  ${profile.ao ? `let pi=pixel_index(p); let qi=pixel_index(q);
  if signal!=0u && ((scalar_ao[pi/4u]>>((pi&3u)*8u))&255u)!=((scalar_ao[qi/4u]>>((qi&3u)*8u))&255u) { return false; }` : ""}
  ${profile.vsm ? `if lighting_shadow_stamp(p_position.xyz)!=lighting_shadow_stamp(q_position.xyz) { return false; }
  // A shared page/content version is not proof of equal visibility at its
  // two receivers. Current PCF visibility guards a moving shadow boundary.
  if !shadow_pair_equal(p,q,signal) { return false; }` : ""}
  return true;
}
var<workgroup> local_packets: array<vec2u,256>;
var<workgroup> local_count: atomic<u32>;
var<workgroup> packet_base: u32;
@compute @workgroup_size(1)
fn reset_packets() { for(var i=0u;i<4u;i++) { atomicStore(&packet_control[i],0u); } }
@compute @workgroup_size(8,8)
fn classify(@builtin(workgroup_id) tile: vec3u, @builtin(local_invocation_id) lane: vec3u,
  @builtin(local_invocation_index) lane_index: u32) {
  if lane_index==0u { atomicStore(&local_count,0u); }
  workgroupBarrier();
  let base=vec2i(tile.xy*16u+lane.xy*2u);
  var coords: array<vec2i,4>;
  var refs: array<vec4u,4>;
  var masks: array<u32,4>;
  var valid: array<bool,4>;
  for(var i=0u;i<4u;i++) {
    coords[i]=base+vec2i(i32(i&1u),i32(i>>1u));
    valid[i]=all(vec2u(coords[i])<settings.extent.xy);
    refs[i]=vec4u(NO_SIGNAL,NO_SIGNAL,NO_SIGNAL,0u);
    if valid[i] {
      for(var signal=0u;signal<3u;signal++) {
        if signal_exists(coords[i],signal) { refs[i][signal]=previous_reference(coords[i],signal); }
      }
    }
  }
  // Independent greedy lobe partitions cover 1x1, 2x1, 1x2 and 2x2. Each
  // primary belongs to this aligned 16x16 tile; depth cluster cuts are tested.
  for(var signal=0u;signal<3u;signal++) {
    var assigned=0u;
    for(var rotation=0u;rotation<4u;rotation++) {
      let i=(rotation+settings.extent.z)&3u;
      if !valid[i] || (assigned&(1u<<i))!=0u { continue; }
      if !signal_exists(coords[i],signal) || refs[i][signal]!=NO_SIGNAL { continue; }
      refs[i][signal]=pixel_index(coords[i]); assigned|=1u<<i; masks[i]|=1u<<signal;
      for(var j=0u;j<4u;j++) {
        if i==j || !valid[j] || (assigned&(1u<<j))!=0u { continue; }
        if signal_exists(coords[j],signal) && refs[j][signal]==NO_SIGNAL && can_share(coords[i],coords[j],signal) {
          refs[j][signal]=pixel_index(coords[i]); assigned|=1u<<j;
        }
      }
    }
  }
  for(var i=0u;i<4u;i++) {
    if !valid[i] { continue; }
    references[pixel_index(coords[i])]=refs[i];
    if masks[i]!=0u {
      let slot=atomicAdd(&local_count,1u);
      local_packets[slot]=vec2u(pixel_index(coords[i]),masks[i]);
    }
  }
  workgroupBarrier();
  if lane_index==0u {
    let count=atomicLoad(&local_count);
    packet_base=atomicAdd(&packet_control[0],count);
    if settings.reserved.x!=0u {
      var per_signal=vec3u(0u);
      for(var i=0u;i<count;i++) {
        let mask=local_packets[i].y;
        per_signal+=vec3u(mask&1u,(mask>>1u)&1u,(mask>>2u)&1u);
      }
      for(var signal=0u;signal<3u;signal++) { atomicAdd(&packet_control[signal+1u],per_signal[signal]); }
    }
  }
  workgroupBarrier();
  for(var i=lane_index;i<atomicLoad(&local_count);i+=64u) { packets[packet_base+i]=local_packets[i]; }
}
@compute @workgroup_size(1)
fn finalize_packets() {
  let count=atomicLoad(&packet_control[0]);
  let groups=(count+63u)/64u; let x=min(groups,settings.ages.w);
  packet_indirect=vec4u(x,select((groups+max(x,1u)-1u)/max(x,1u),1u,count==0u),1u,count);
}
fn material_at(p: vec2i) -> StandardMaterial {
  var material: StandardMaterial;
  let metallic=saturate(f(p,2u).x); let albedo=f(p,0u).xyz;
  let ior=f(p,7u).x; let dielectric=(ior-1.0)/(ior+1.0);
  material.diffuse=albedo*(1.0-metallic);
  material.specularF0=mix(vec3f(dielectric*dielectric)*f(p,9u).xyz*f(p,8u).x,albedo,metallic);
  material.specularF90=1.0;
  material.roughness=max(f(p,3u).x,0.02);
  material.occlusion=saturate(f(p,4u).x);
  material.coatFactor=saturate(f(p,10u).x);
  material.coatRoughness=max(f(p,11u).x,0.02);
  material.coatNormal=g(p,2u).xyz;
  material.energyCompensation=vec3f(1.0);
  ${profile.environment ? `let no_v=saturate(dot(g(p,1u).xyz,view_direction(p)));
  let dfg_value=textureSampleLevel(dfg,ibl_sampler,vec2f(no_v,material.roughness),0.0).xy;
  material.energyCompensation=vec3f(1.0)+material.specularF0*(1.0/max(dfg_value.y,1e-4)-1.0);` : ""}
  return material;
}
struct LightingSignals { diffuse: vec3f, specular: vec3f, coat: vec3f, diffuse_environment: vec3f, }
fn accumulate_light(incident: GpuPrimitiveTypeTable, base_visibility: f32, coat_visibility: f32,
  normal: vec3f, view_dir: vec3f, material: StandardMaterial, signal_mask: u32,
  result: ptr<function,LightingSignals>) {
  let h=normalize_or(incident.direction+view_dir,normal);
  let vo_h=saturate(dot(view_dir,h));
  let coat_fresnel=(0.04+0.96*pow(1.0-vo_h,5.0))*material.coatFactor;
  let base_attenuation=1.0-coat_fresnel;
  let no_l=saturate(dot(normal,incident.direction));
  if (signal_mask&1u)!=0u {
    (*result).diffuse+=incident.color*(base_visibility*no_l*base_attenuation*RECIPROCAL_PI);
  }
  if (signal_mask&2u)!=0u {
    let no_h=saturate(dot(normal,h));
    let specular=BRDF_GGX(no_l,saturate(dot(normal,view_dir)),no_h*no_h,vo_h,
      material.specularF0,material.specularF90,max(material.roughness*material.roughness,0.002));
    (*result).specular+=incident.color*(base_visibility*no_l*base_attenuation)*specular*material.energyCompensation;
  }
  if (signal_mask&4u)!=0u {
    let nh=saturate(dot(material.coatNormal,h));
    let nl=saturate(dot(material.coatNormal,incident.direction));
    let a=max(material.coatRoughness*material.coatRoughness,0.002);
    let coat_brdf=D_GGX(a*a,nh*nh)*(0.25/max(vo_h*vo_h,0.0000039))*coat_fresnel;
    (*result).coat+=incident.color*(coat_visibility*nl*coat_brdf);
  }
}
fn shade_light(type: u32,index: u32,position: vec3f,normal: vec3f,view_dir: vec3f,
  material: StandardMaterial,signal_mask: u32,result: ptr<function,LightingSignals>) {
  var incident: GpuPrimitiveTypeTable;
  var base_visibility=1.0; var coat_visibility=1.0;
  if type==0u {
    incident=get_point_light_info_by_index(&node,index,position);
    base_visibility=shadowmap_get_point_light_visibility(&node,index,position,normal);
    coat_visibility=shadowmap_get_point_light_visibility(&node,index,position,material.coatNormal);
  } else if type==1u {
    incident=get_spot_light_info_by_index(&node,index,position);
    base_visibility=shadowmap_get_spot_light_visibility(&node,index,position,normal);
    coat_visibility=shadowmap_get_spot_light_visibility(&node,index,position,material.coatNormal);
  } else {
    incident=get_directional_light_info_by_index(&node,index);
    if (signal_mask&3u)!=0u { base_visibility=shadowmap_get_directional_light_visibility(&node,index,position,view_dir,normal); }
    if (signal_mask&4u)!=0u { coat_visibility=shadowmap_get_directional_light_visibility(&node,index,position,view_dir,material.coatNormal); }
  }
  accumulate_light(incident,base_visibility,coat_visibility,normal,view_dir,material,signal_mask,result);
}
@compute @workgroup_size(64)
fn evaluate_packets(@builtin(workgroup_id) group: vec3u,@builtin(local_invocation_index) lane: u32) {
  let slot=(group.y*packet_dispatch.x+group.x)*64u+lane;
  if slot>=packet_dispatch.w { return; }
  let packet=primary_packets[slot]; let p=pixel_coord(packet.x); let signal_mask=packet.y;
  let material=material_at(p); let position=g(p,0u).xyz; let normal=g(p,1u).xyz;
  let view_dir=view_direction(p); var result: LightingSignals;
  ${profile.direct ? `shading_view=ShadingView(settings.extent.x,settings.extent.y);
  var directional=directional_lights_iteration_mask(&node);
  while directional!=0u {
    let index=countTrailingZeros(directional); directional&=~(1u<<index);
    shade_light(2u,index,position,normal,view_dir,material,signal_mask,&result);
  }
  let metadata=light_cluster_metadata_by_position(vec2f(p)+0.5,g(p,0u).w,settings.extent.xy);
  if (metadata.flags&CLUSTER_METADATA_FLAG_FALLBACK)!=0u {
    for(var i=0u;i<cluster_data.active_written;i++) {
      let tuple=cluster_data.data[i];
      shade_light(cluster_light_tuple_type(tuple),cluster_light_tuple_id(tuple),position,normal,view_dir,material,signal_mask,&result);
    }
  } else {
    for(var i=0u;i<metadata.point_count+metadata.spot_count;i++) {
      let type=select(1u,0u,i<metadata.point_count);
      shade_light(type,cluster_data.data[metadata.offset+i],position,normal,view_dir,material,signal_mask,&result);
    }
  }` : ""}
  ${profile.environment ? `
  let no_v=saturate(dot(normal,view_dir));
  let base_dfg=textureSampleLevel(dfg,ibl_sampler,vec2f(no_v,material.roughness),0.0).xy;
  let directional_albedo=oengine_ibl_directional_albedo(vec2f(base_dfg.y-base_dfg.x,base_dfg.x),material.specularF0,1.0);
  let coat_nv=saturate(dot(material.coatNormal,view_dir));
  let coat_fresnel=(0.04+0.96*pow(1.0-coat_nv,5.0))*material.coatFactor;
  let base_attenuation=(1.0-coat_fresnel)*(1.0-coat_fresnel);
  var ao=material.occlusion;
  ${profile.ao ? "ao*=f32((scalar_ao[packet.x/4u]>>((packet.x&3u)*8u))&255u)/255.0;" : ""}
  if (signal_mask&1u)!=0u {
    let irradiance=sample_octahedral_bilinear(ibl_diffuse,vec2u(0u),textureDimensions(ibl_diffuse).x,normal,0u).xyz;
    result.diffuse_environment=irradiance*RECIPROCAL_PI;
  }
  if (signal_mask&2u)!=0u {
    let reflected=reflect(-view_dir,normal);
    let radiance=sample_prefiltered_environment(ibl_specular,reflected,material.roughness);
    result.specular+=radiance*directional_albedo*(ao*base_attenuation);
  }
  if (signal_mask&4u)!=0u {
    let coat_dfg=textureSampleLevel(dfg,ibl_sampler,vec2f(coat_nv,material.coatRoughness),0.0).xy;
    let coat_response=0.04*(coat_dfg.y-coat_dfg.x)+coat_dfg.x;
    let radiance=sample_prefiltered_environment(ibl_specular,reflect(-view_dir,material.coatNormal),material.coatRoughness);
    result.coat+=radiance*(material.coatFactor*coat_response*ao);
  }` : ""}
  let values=array<vec3f,3>(result.diffuse,result.specular,result.coat);
  for(var signal=0u;signal<3u;signal++) {
    if (signal_mask&(1u<<signal))!=0u { textureStore(output_primary,p,i32(signal),pack_signal(values[signal])); }
  }
  if (signal_mask&1u)!=0u { textureStore(output_primary,p,3,pack_signal(result.diffuse_environment)); }
}
@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy>=settings.extent.xy) { return; }
  let p=vec2i(id.xy); let refs=target_references[id.y*settings.extent.x+id.x];
  var sum=vec3f(0.0); var refresh=0.0;
  for(var signal=0u;signal<3u;signal++) {
    let ref=refs[signal]; var value=vec4f(0.0);
    if ref!=NO_SIGNAL {
      if (ref&HISTORY_REF)!=0u {
        value=textureLoad(previous_signals,pixel_coord(ref&~HISTORY_REF),i32(signal),0);
        value.w+=1.0;
      } else {
        value=textureLoad(primary_radiance,pixel_coord(ref),i32(signal),0);
        refresh=1.0;
      }
    }
    textureStore(output_history,p,i32(signal),value);
    if signal==0u {
      var environment_value=vec4f(0.0);
      if ref!=NO_SIGNAL {
        if (ref&HISTORY_REF)!=0u {
          environment_value=textureLoad(previous_signals,pixel_coord(ref&~HISTORY_REF),3,0);
          environment_value.w+=1.0;
        } else { environment_value=textureLoad(primary_radiance,pixel_coord(ref),3,0); }
      }
      textureStore(output_history,p,3,environment_value);
      let diffuse=f(p,0u).xyz*(1.0-saturate(f(p,2u).x));
      sum+=signal_rgb(value)*diffuse;
      ${profile.environment ? `let material=material_at(p);
      let no_v=saturate(dot(g(p,1u).xyz,view_direction(p)));
      let base_dfg=textureSampleLevel(dfg,ibl_sampler,vec2f(no_v,material.roughness),0.0).xy;
      let energy=oengine_ibl_directional_albedo(vec2f(base_dfg.y-base_dfg.x,base_dfg.x),material.specularF0,1.0);
      let coat_nv=saturate(dot(g(p,2u).xyz,view_direction(p)));
      let coat_f=(0.04+0.96*pow(1.0-coat_nv,5.0))*material.coatFactor;
      var ao=material.occlusion;
      ${profile.ao ? "let pixel=id.y*settings.extent.x+id.x; ao*=f32((scalar_ao[pixel/4u]>>((pixel&3u)*8u))&255u)/255.0;" : ""}
      sum+=signal_rgb(environment_value)*diffuse*oengine_ibl_diffuse_energy(energy)*(ao*(1.0-coat_f)*(1.0-coat_f));` : ""}
    } else { sum+=signal_rgb(value); }
  }
  let valid=g(p,3u).w>0.0;
  if g(p,3u).w==1.0 { sum=f(p,0u).xyz; }
  let hdr=oengine_linear_rec709_to_rec2020(sum+select(vec3f(0.0),f(p,5u).xyz,valid))*max(pre_exposure[0],1e-6);
  textureStore(output_hdr,p,vec4f(hdr,select(0.0,1.0,valid)));
  let facts=textureLoad(mask,p,0);
  // Propagate actual refresh/disocclusion to the existing FSR3 authority.
  textureStore(output_reactive,p,vec4f(max(facts.x,refresh*0.25),facts.yzw));
}
`;
}
