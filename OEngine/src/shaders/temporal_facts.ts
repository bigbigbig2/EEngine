import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

/**
 * Local Temporal Facts integration, not part of the pinned FSR3 algorithm.
 * Workgroup: 8x8; one visibility/work/instance/material read per covered pixel,
 * one previous identity read, three bounded storage-texture writes. No atomics.
 */
export const TEMPORAL_FACTS_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}

struct TemporalFactsConstants {
  width: u32,
  height: u32,
  previous_valid: u32,
  _pad: u32,
};
// Mask A bits: 0 instance-set, 1 geometry/LOD, 2 material/residency,
// 3 transform publication, 4 invalid motion, 5 emissive, 6 alpha-mask.
@group(0) @binding(0) var visibility_key: texture_2d<u32>;
@group(0) @binding(2) var surface_depth: texture_depth_2d;
@group(0) @binding(3) var previous_identity: texture_2d<u32>;
@group(0) @binding(4) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(5) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(6) var<storage, read> materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(7) var<uniform> current_camera: CommandEncoder;
@group(0) @binding(8) var<uniform> previous_camera: CommandEncoder;
@group(0) @binding(9) var<uniform> facts: TemporalFactsConstants;
@group(0) @binding(10) var output_motion: texture_storage_2d<rg16float, write>;
@group(0) @binding(11) var output_mask: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(12) var output_identity: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(13) var<storage, read> texture_routes: array<OEngineShadingTextureRoute>;
@group(0) @binding(14) var<storage, read> texture_residency: array<u32>;

// Stable instance slot is exact within one Scene allocation. The other lanes
// are 32-bit local change detectors, not exact cross-frame object identifiers.
fn hash_step(value: u32, word: u32) -> u32 {
  return (value ^ word) * 16777619u;
}
fn geometry_signature(instance: OEngineInstanceRecord,
  work: OEngineMeshletRasterWork, primitive: u32) -> u32 {
  var signature = hash_step(2166136261u, instance.instance_set_generation);
  signature = hash_step(signature, oengine_instance_geometry_generation(instance));
  signature = hash_step(signature, work.geometry_slot);
  signature = hash_step(signature, work.meshlet_slot);
  signature = hash_step(signature, primitive);
  return hash_step(signature, work.packed_profile_lod);
}
fn material_signature(instance: OEngineInstanceRecord,
  material: OEngineShadingMaterialRecord, material_slot: u32) -> u32 {
  var signature = hash_step(2166136261u, instance.material_handle);
  signature = hash_step(signature, instance.flags);
  signature = hash_step(signature, material.material_generation);
  signature = hash_step(signature, material.texture_generation);
  signature = hash_step(signature, material.publication_revision);
  signature = hash_step(signature, material.temporal_signature);
  for (var role = 0u; role < ${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u; role++) {
    let index = material_slot * ${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u + role;
    if index < arrayLength(&texture_routes) {
      let route = texture_routes[index];
      if route.texture_ref != OENGINE_TEXTURE_REF_INVALID && route.residency_slot < arrayLength(&texture_residency) {
        signature = hash_step(signature, texture_residency[route.residency_slot]);
      }
    }
  }
  return signature;
}

fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
fn finite_motion(motion: vec2f) -> bool {
  // Comparisons with NaN are false; reject half-float overflow as well.
  return all(abs(motion) < vec2f(65000.0));
}
fn previous_at(uv: vec2f) -> vec4u {
  let pixel = clamp(vec2i(uv * vec2f(f32(facts.width), f32(facts.height))),
    vec2i(0), vec2i(i32(facts.width), i32(facts.height)) - vec2i(1));
  return textureLoad(previous_identity, pixel, 0);
}
fn previous_clip_for_surface(uv: vec2f, depth: f32,
  instance: OEngineInstanceRecord) -> vec4f {
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let current_view = current_camera.projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  let current_world = current_camera.view_matrix_inverse *
    vec4f(current_view.xyz / current_view.w, 1.0);
  return previous_camera.projection_matrix * previous_camera.view_matrix *
    oengine_instance_previous_from_current(instance) * current_world;
}
fn sky_motion(uv: vec2f) -> vec2f {
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let view_point = current_camera.projection_matrix_inverse * vec4f(ndc, 1.0, 1.0);
  let view_direction = normalize(view_point.xyz / max(abs(view_point.w), 1e-6));
  let world_direction = (current_camera.view_matrix_inverse * vec4f(view_direction, 0.0)).xyz;
  let previous_view = previous_camera.view_matrix * vec4f(world_direction, 0.0);
  let previous_clip = previous_camera.projection_matrix * previous_view;
  let previous_uv = previous_clip.xy / previous_clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  return uv - previous_uv;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= facts.width || id.y >= facts.height) { return; }
  let pixel = vec2i(id.xy);
  let uv = (vec2f(id.xy) + vec2f(0.5)) /
    vec2f(f32(facts.width), f32(facts.height));
  let key = textureLoad(visibility_key, pixel, 0).x;
  let depth = textureLoad(surface_depth, pixel, 0);
  var motion = vec2f(0.0);
  var identity = vec4u(0u);
  var valid = false;
  var opaque_reactive = 0.0;
  var change_bits = 0u;
  if (key == OENGINE_VISIBILITY_KEY_EMPTY && depth <= 0.0001) {
    // Infinite-distance background follows camera rotation, never translation.
    motion = sky_motion(uv);
    identity = vec4u(0xffffffffu, 0u, 0u, 0u);
    valid = finite_motion(motion) && inside(uv - motion);
  } else if (oengine_visibility_key_is_valid(key)) {
    let work_slot = oengine_visibility_key_meshlet_work_slot(key);
    if (meshlet_work.header.generation != 0u &&
        work_slot < meshlet_work.header.written_count) {
      let work = meshlet_work.elements[work_slot];
      if (work.instance_slot < arrayLength(&instances) &&
          work.material_slot_or_range < arrayLength(&materials)) {
        let instance = instances[work.instance_slot];
        let material = materials[work.material_slot_or_range];
        identity = vec4u(work.instance_slot + 1u,
          geometry_signature(instance, work, oengine_visibility_key_local_primitive(key)),
          material_signature(instance, material, work.material_slot_or_range), instance.dynamic_revision);
        let previous_clip = previous_clip_for_surface(uv, depth, instance);
        let previous_uv = previous_clip.xy / previous_clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
        motion = uv - previous_uv;
        valid = oengine_instance_motion_valid(instance) && finite_motion(motion) &&
          inside(uv - motion) && depth > 0.0001 &&
          previous_clip.w > 1e-6 && previous_clip.z >= 0.0 &&
          previous_clip.z <= previous_clip.w &&
          all(abs(previous_clip.xy) <= vec2f(previous_clip.w));
        let emissive = max(material.payload.emissive_factor.x,
          max(material.payload.emissive_factor.y, material.payload.emissive_factor.z));
        if (emissive > 1.0 ||
            (material.payload.flags & OENGINE_MATERIAL_HAS_EMISSIVE_TEXTURE) != 0u) {
          opaque_reactive = 1.0;
          change_bits |= 32u;
        }
        if (material.payload.alpha_mode == OENGINE_MATERIAL_ALPHA_MASK) {
          opaque_reactive = max(opaque_reactive, 0.25);
          change_bits |= 64u;
        }
      }
    }
  }
  var mismatch = true;
  if (facts.previous_valid != 0u && valid) {
    let previous = previous_at(uv - motion);
    mismatch = any(previous.xyz != identity.xyz);
    if (previous.x != identity.x) { change_bits |= 1u; }
    if (previous.y != identity.y) { change_bits |= 2u; }
    if (previous.z != identity.z) { change_bits |= 4u; }
    if (previous.w != identity.w) { change_bits |= 8u; }
  }
  if (!valid) { change_bits |= 16u; }
  let reactive = max(opaque_reactive, select(0.0, 1.0, mismatch || !valid));
  textureStore(output_motion, pixel, vec4f(select(vec2f(0.0), motion, valid), 0.0, 0.0));
  textureStore(output_mask, pixel,
    vec4f(reactive, select(0.0, 1.0, valid), select(0.0, 1.0, mismatch),
      f32(change_bits) / 255.0));
  textureStore(output_identity, pixel, identity);
}
`;
