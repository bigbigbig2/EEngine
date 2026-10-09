import type { NativeSurfaceAuxProfile } from "../render/surface/NativeSurfaceAux.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

/** Composable Surface fragment; one winner/background write, no new dispatch. */
export function nativeSurfaceAuxWgsl(profile: NativeSurfaceAuxProfile, group = 0, startBinding = 8): string {
  if (!Number.isSafeInteger(group) || group < 0 || !Number.isSafeInteger(startBinding) || startBinding < 0) {
    throw new RangeError("Invalid native Surface Aux binding coordinates");
  }
  if (profile === "ReflectionGI") {
    throw new Error("ReflectionGI requires an implemented native effect consumer and precision contract");
  }
  if (profile === "Base") {
    return /* wgsl */ `
fn native_surface_aux_write(pixel: vec2i, opaque_reactive: vec2f) {}
`;
  }
  if (profile !== "Temporal") {
    throw new RangeError("Unknown native Surface Aux profile");
  }
  return /* wgsl */ `
@group(${group}) @binding(${startBinding}) var native_surface_opaque_reactive: texture_storage_2d<rgba8unorm, write>;

// Static emission and MASK interiors can accumulate. Shading Change owns
// radiance variation; G marks surfaces whose exact coverage edge needs a hint.
fn native_surface_aux_reactive(alpha_mask: bool) -> vec2f {
  return vec2f(0.0, select(0.0, 1.0, alpha_mask));
}

fn native_surface_aux_write(pixel: vec2i, opaque_reactive: vec2f) {
  textureStore(native_surface_opaque_reactive, pixel, vec4f(clamp(opaque_reactive, vec2f(0.0), vec2f(1.0)), 0.0, 0.0));
}
`;
}

/**
 * Production native TemporalFacts. Resource identity is separate from raster
 * winners and LOD; local hard replacement is separate from soft reactive.
 * Workgroup 8x8, sequential full-domain writes, random bounded geometry/version
 * reads and one previous-identity point read. No atomics, barriers or submission.
 * RG32 motion retains f32 UV precision: RG16 can exceed 0.1 render pixel for
 * valid large motion at 1080p. Mask stores exact booleans/byte bits and quantized
 * reactive (error <= 0.5/255). There is no packed normal or UniversalRecord.
 */
export const NATIVE_TEMPORAL_FACTS_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}

struct NativeTemporalFactsConstants {
  width: u32,
  height: u32,
  previous_valid: u32,
  material_slot_count: u32,
  source: vec4u,
};

@group(0) @binding(0) var visibility_key: texture_2d<u32>;
@group(0) @binding(2) var surface_depth: texture_depth_2d;
@group(0) @binding(3) var previous_identity: texture_2d<u32>;
@group(0) @binding(4) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(5) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(7) var<uniform> current_camera: CommandEncoder;
@group(0) @binding(8) var<uniform> previous_camera: CommandEncoder;
@group(0) @binding(9) var<uniform> facts: NativeTemporalFactsConstants;
@group(0) @binding(10) var output_motion: texture_storage_2d<rg32float, write>;
@group(0) @binding(11) var output_mask: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(12) var output_identity: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(15) var<storage, read> asset_metadata: array<u32>;
@group(0) @binding(16) var<storage, read> vertex_payload: array<u32>;
// Native publication-owned, slot-indexed [signature, valueRevision]. Zero
// revision rejects history; sparse/unpublished slots also publish zero.
@group(0) @binding(17) var<storage, read> native_material_versions: array<vec2u>;
@group(0) @binding(18) var opaque_reactive: texture_2d<f32>;

fn native_facts_hash_step(value: u32, word: u32) -> u32 {
  return (value ^ word) * 16777619u;
}

fn native_facts_geometry_signature(instance: OEngineInstanceRecord, work: OEngineMeshletRasterWork) -> u32 {
  var signature = native_facts_hash_step(2166136261u, instance.instance_set_generation);
  signature = native_facts_hash_step(signature, oengine_instance_geometry_generation(instance));
  // Representation winners are not resource identity: adjacent triangles,
  // meshlets and LODs must retain history through ordinary jitter coverage.
  return native_facts_hash_step(signature, work.geometry_slot);
}

fn native_facts_material_signature(instance: OEngineInstanceRecord, material_slot: u32) -> u32 {
  var signature = native_facts_hash_step(2166136261u, instance.material_handle);
  signature = native_facts_hash_step(signature, instance.flags);
  // A same-slot publication change is hard; different visibility/material
  // winners use depth/shading confidence. The signature covers graph/parameters,
  // raster, texture content/residency and Product revisions atomically.
  signature = native_facts_hash_step(signature, material_slot);
  let version = native_material_versions[material_slot];
  signature = native_facts_hash_step(signature, version.x);
  signature = native_facts_hash_step(signature, version.y);
  return signature;
}

fn native_facts_inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}

fn native_facts_previous_clip(uv: vec2f, depth: f32, instance: OEngineInstanceRecord) -> vec4f {
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let current_view = current_camera.projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  let current_world = current_camera.view_matrix_inverse * vec4f(current_view.xyz / current_view.w, 1.0);
  return previous_camera.projection_matrix * previous_camera.view_matrix *
    oengine_instance_previous_from_current(instance) * current_world;
}

fn native_facts_sky_previous_clip(uv: vec2f) -> vec4f {
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let view_point = current_camera.projection_matrix_inverse * vec4f(ndc, 1.0, 1.0);
  let view_direction = normalize(view_point.xyz / max(abs(view_point.w), 1e-6));
  let world_direction = (current_camera.view_matrix_inverse * vec4f(view_direction, 0.0)).xyz;
  return previous_camera.projection_matrix * previous_camera.view_matrix * vec4f(world_direction, 0.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= facts.width || id.y >= facts.height) {
    return;
  }
  let pixel = vec2i(id.xy);
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(f32(facts.width), f32(facts.height));
  let key = textureLoad(visibility_key, pixel, 0).x;
  let depth = textureLoad(surface_depth, pixel, 0);
  var motion = vec2f(0.0);
  var identity = vec4u(0u);
  var valid = false;
  var change_bits = 0u;
  let opaque_response = textureLoad(opaque_reactive, pixel, 0);
  var reactive = clamp(opaque_response.x, 0.0, 1.0);
  if (key == OENGINE_VISIBILITY_KEY_EMPTY && depth == 0.0) {
    // Infinite sky reprojection includes rotation/jitter and excludes translation.
    let previous_clip = native_facts_sky_previous_clip(uv);
    let previous_uv = previous_clip.xy / previous_clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
    motion = uv - previous_uv;
    identity = vec4u(0xffffffffu, 0u, 0u, 0u);
    valid = all(abs(previous_clip) < vec4f(3.402823466e38)) &&
      previous_clip.w > 1e-6 && native_facts_inside(previous_uv);
  } else {
    let resolved_key = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
    if (resolved_key.valid != 0u) {
      let work = meshlet_work.elements[resolved_key.meshlet_work_slot];
      let material_slot = work.material_slot_or_range;
      if (work.instance_slot < arrayLength(&instances) &&
          material_slot < facts.material_slot_count && material_slot < arrayLength(&native_material_versions)) {
        let instance = instances[work.instance_slot];
        identity = vec4u(work.instance_slot + 1u,
          native_facts_geometry_signature(instance, work),
          native_facts_material_signature(instance, material_slot), material_slot + 1u);
        let previous_clip = native_facts_previous_clip(uv, depth, instance);
        let previous_uv = previous_clip.xy / previous_clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
        motion = uv - previous_uv;
        valid = all(abs(previous_clip) < vec4f(3.402823466e38)) &&
          native_material_versions[material_slot].y != 0u && oengine_instance_motion_valid(instance) &&
          // Infinite reverse-Z has valid geometry arbitrarily close to zero.
          // A fixed depth epsilon silently invalidates distant buildings.
          depth > 0.0 && previous_clip.w > 1e-6 && previous_clip.z >= 0.0 &&
          previous_clip.z <= previous_clip.w && native_facts_inside(previous_uv);
      }
    }
  }
  // NaN comparisons fail. UV range already bounds finite motion; a reset/cut
  // rejects both background and geometry, rather than publishing valid motion.
  valid = valid && facts.previous_valid != 0u && all(abs(motion) < vec2f(2.0));
  var mismatch = false;
  if (valid) {
    let previous_pixel = clamp(vec2i((uv - motion) * vec2f(f32(facts.width), f32(facts.height))),
      vec2i(0), vec2i(i32(facts.width), i32(facts.height)) - vec2i(1));
    let previous = textureLoad(previous_identity, previous_pixel, 0);
    // A different visibility winner is handled by depth and shading evidence,
    // not a hard rejection dilated across its silhouette. Within the same
    // instance, topology/replacement and same-slot publication changes are hard.
    let same_instance = previous.x == identity.x;
    mismatch = same_instance && (previous.y != identity.y ||
      (previous.w == identity.w && previous.z != identity.z));
    if (previous.x != identity.x) {
      change_bits |= 1u;
    }
    if (previous.y != identity.y) {
      change_bits |= 2u;
    }
    if (previous.z != identity.z) {
      change_bits |= 4u;
    }
    if (previous.w != identity.w) {
      change_bits |= 8u;
    }
  }
  if (!valid) {
    change_bits |= 16u;
  }
  if (opaque_response.y > 0.5) {
    // Visibility has already applied exact R8 coverage with the authored cutoff.
    // Only actual coverage/winner edges get a bounded soft hint; no extra R8
    // sample and no blanket penalty on the leaf interior.
    let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
    for (var i = 0u; i < 4u; i++) {
      let neighbor_pixel = clamp(pixel + offsets[i], vec2i(0), vec2i(i32(facts.width), i32(facts.height)) - 1);
      let neighbor = oengine_visibility_key_resolve(textureLoad(visibility_key, neighbor_pixel, 0).x,
        meshlet_work.header.generation, meshlet_work.header.written_count);
      if (neighbor.valid == 0u) {
        reactive = max(reactive, 0.1);
      } else if (neighbor.meshlet_work_slot != (key & OENGINE_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK) &&
                 meshlet_work.elements[neighbor.meshlet_work_slot].instance_slot + 1u != identity.x) {
        reactive = max(reactive, 0.1);
      }
    }
  }
  textureStore(output_motion, pixel, vec4f(select(vec2f(0.0), motion, valid), 0.0, 0.0));
  // R soft reactive; G valid jittered motion; B local hard replacement.
  textureStore(output_mask, pixel, vec4f(reactive, select(0.0, 1.0, valid), select(0.0, 1.0, mismatch), f32(change_bits) / 255.0));
  textureStore(output_identity, pixel, identity);
}
`;
