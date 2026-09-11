import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  GPU_MATERIAL_TILE_WORK_WGSL
} from "../gpu/GpuMaterialTileWorkAbi.js";
import {
  PACKED_MATERIAL_SHARED_WGSL,
  PACKED_MATERIAL_TEXTURE_SAMPLING_WGSL
} from "./packed_material_resolve.js";

/**
 * ADR-0009 visibility-driven EvaluateShading kernel.
 *
 * The material expressions intentionally mirror the legacy fragment producer,
 * but reconstruction, perspective-correct gradients, textureGrad sampling and
 * output ownership are compute-native. Lighting composition remains a later
 * stage of the same ShadeLighting semantic while consumers migrate from
 * Surface V1.
 */
export const PACKED_MATERIAL_COMPUTE_WGSL = /* wgsl */ `
${PACKED_MATERIAL_SHARED_WGSL}
${PACKED_MATERIAL_TEXTURE_SAMPLING_WGSL}
${GPU_MATERIAL_TILE_WORK_WGSL}

const COMPUTE_TILE_WIDTH: u32 = 8u;
const COMPUTE_TILE_HEIGHT: u32 = 8u;
const COMPUTE_QUEUE_HEADER_WORD_STRIDE: u32 = 8u;
const COMPUTE_QUEUE_HEADER_WORD_COUNT: u32 =
  ${GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT}u * COMPUTE_QUEUE_HEADER_WORD_STRIDE;
const COMPUTE_WORK_RECORD_WORD_STRIDE: u32 = 4u;
const COMPUTE_HEADER_WRITTEN: u32 = 1u;
const COMPUTE_HEADER_CONSUMED: u32 = 2u;
const COMPUTE_HEADER_INVALID: u32 = 6u;

struct ComputeMaterialSettings {
  dispatch_class: u32,
  velocity_enabled: u32,
  _padding0: u32,
  _padding1: u32,
};

@group(2) @binding(0) var<storage, read_write> compute_queue_words: array<atomic<u32>>;
@group(2) @binding(1) var<storage, read_write> compute_pixel_claims: array<atomic<u32>>;
@group(2) @binding(2) var compute_normal_output: texture_storage_2d<rgba16uint, write>;
@group(2) @binding(3) var compute_albedo_ao_output: texture_storage_2d<rgba8unorm, write>;
@group(2) @binding(4) var compute_emissive_output: texture_storage_2d<r32uint, write>;
@group(2) @binding(5) var compute_pbr_metadata_velocity_output:
  texture_storage_2d<rgba32uint, write>;
@group(2) @binding(6) var<uniform> compute_settings: ComputeMaterialSettings;

fn compute_tile_count() -> u32 {
  return ((view.width + COMPUTE_TILE_WIDTH - 1u) / COMPUTE_TILE_WIDTH) *
    ((view.height + COMPUTE_TILE_HEIGHT - 1u) / COMPUTE_TILE_HEIGHT);
}

fn compute_header_word(dispatch_class: u32, field: u32) -> u32 {
  return dispatch_class * COMPUTE_QUEUE_HEADER_WORD_STRIDE + field;
}

fn compute_work_word(dispatch_class: u32, element: u32, field: u32) -> u32 {
  return COMPUTE_QUEUE_HEADER_WORD_COUNT +
    (dispatch_class * compute_tile_count() + element) *
      COMPUTE_WORK_RECORD_WORD_STRIDE + field;
}

fn compute_material_invalid(dispatch_class: u32) {
  atomicAdd(
    &compute_queue_words[compute_header_word(dispatch_class, COMPUTE_HEADER_INVALID)],
    1u
  );
}

@compute @workgroup_size(8, 8, 1)
fn clear_compute_material_outputs(@builtin(global_invocation_id) global_id: vec3u) {
  let pixel = global_id.xy;
  if any(pixel >= vec2u(view.width, view.height)) { return; }
  textureStore(compute_normal_output, vec2i(pixel), vec4u(0u));
  textureStore(compute_albedo_ao_output, vec2i(pixel), vec4f(0.0));
  textureStore(compute_emissive_output, vec2i(pixel), vec4u(0u));
  textureStore(compute_pbr_metadata_velocity_output, vec2i(pixel), vec4u(0u));
}

@compute @workgroup_size(8, 8, 1)
fn evaluate_compute_material_tiles(
  @builtin(workgroup_id) group_id: vec3u,
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(local_invocation_index) lane: u32
) {
  let dispatch_class = compute_settings.dispatch_class;
  if dispatch_class >= OENGINE_MATERIAL_TILE_DISPATCH_CLASS_COUNT { return; }
  let kernel_class = dispatch_class % OENGINE_MATERIAL_KERNEL_CLASS_COUNT;
  let binding_set = dispatch_class / OENGINE_MATERIAL_KERNEL_CLASS_COUNT;
  let record_index = group_id.x;
  let written = atomicLoad(
    &compute_queue_words[compute_header_word(dispatch_class, COMPUTE_HEADER_WRITTEN)]
  );
  if record_index >= written {
    if lane == 0u { compute_material_invalid(dispatch_class); }
    return;
  }
  let record_generation = atomicLoad(
    &compute_queue_words[compute_work_word(dispatch_class, record_index, 3u)]
  );
  let record_kernel = atomicLoad(
    &compute_queue_words[compute_work_word(dispatch_class, record_index, 1u)]
  );
  let record_set = atomicLoad(
    &compute_queue_words[compute_work_word(dispatch_class, record_index, 2u)]
  );
  if record_generation == 0u || record_kernel != kernel_class ||
      record_set != binding_set {
    if lane == 0u { compute_material_invalid(dispatch_class); }
    return;
  }
  if lane == 0u {
    atomicAdd(
      &compute_queue_words[compute_header_word(dispatch_class, COMPUTE_HEADER_CONSUMED)],
      1u
    );
  }

  let tile_linear_id = atomicLoad(
    &compute_queue_words[compute_work_word(dispatch_class, record_index, 0u)]
  );
  let tiles_x = (view.width + COMPUTE_TILE_WIDTH - 1u) / COMPUTE_TILE_WIDTH;
  let tile_origin = vec2u(tile_linear_id % tiles_x, tile_linear_id / tiles_x) *
    vec2u(COMPUTE_TILE_WIDTH, COMPUTE_TILE_HEIGHT);
  let pixel = tile_origin + local_id.xy;
  if any(pixel >= vec2u(view.width, view.height)) { return; }

  let key = textureLoad(visibility_keys, vec2i(pixel), 0).r;
  if !oengine_visibility_key_is_valid(key) { return; }
  let decoded = oengine_visibility_key_decode(key);
  let work_slot = decoded.meshlet_work_slot;
  if meshlet_work.header.generation == 0u ||
      work_slot >= min(meshlet_work.header.written_count, meshlet_work.header.capacity) ||
      work_slot >= arrayLength(&meshlet_work.elements) {
    compute_material_invalid(dispatch_class);
    return;
  }
  let work = meshlet_work.elements[work_slot];
  if (work.packed_profile_lod >> 24u) != OENGINE_VISIBILITY_KEY_PARTITION ||
      work.instance_slot >= arrayLength(&instances) ||
      work.geometry_slot >= arrayLength(&geometries) ||
      work.meshlet_slot >= arrayLength(&meshlets) ||
      work.material_slot_or_range >= arrayLength(&materials) {
    compute_material_invalid(dispatch_class);
    return;
  }
  let instance = instances[work.instance_slot];
  let geometry = geometries[work.geometry_slot];
  let meshlet = meshlets[work.meshlet_slot];
  if !oengine_instance_active(instance) ||
      instance.geometry_record_index != work.geometry_slot ||
      instance.material_handle != work.material_slot_or_range ||
      work.meshlet_slot < geometry.meshlet_begin ||
      work.meshlet_slot - geometry.meshlet_begin >= geometry.meshlet_count ||
      decoded.local_primitive >= meshlet.triangle_count {
    compute_material_invalid(dispatch_class);
    return;
  }
  let material_info = materials[work.material_slot_or_range];
  if (material_info.flags & OENGINE_MATERIAL_VISIBILITY_VALID) == 0u {
    compute_material_invalid(dispatch_class);
    return;
  }
  let pixel_dispatch_class = oengine_material_dispatch_class_id(
    material_info.kernel_class,
    material_info.texture_binding_set_id
  );
  if pixel_dispatch_class != dispatch_class { return; }

  let vertices = triangle_source_vertices(meshlet, decoded.local_primitive);
  let local0 = read_position_direct(geometry, vertices.x);
  let local1 = read_position_direct(geometry, vertices.y);
  let local2 = read_position_direct(geometry, vertices.z);
  let world0 = oengine_instance_current_object_to_world(instance) * vec4f(local0, 1.0);
  let world1 = oengine_instance_current_object_to_world(instance) * vec4f(local1, 1.0);
  let world2 = oengine_instance_current_object_to_world(instance) * vec4f(local2, 1.0);
  let projected0 = view.projection_matrix * world0;
  let projected1 = view.projection_matrix * world1;
  let projected2 = view.projection_matrix * world2;
  let pixel_position = vec2f(pixel) + vec2f(0.5);
  let bary = perspective_barycentric_with_derivatives(
    pixel_position,
    projected0,
    projected1,
    projected2
  );

  let face_local = safe_normalize(
    cross(local2 - local1, local0 - local1),
    vec3f(0.0, 0.0, 1.0)
  );
  let normal0 = read_normal_direct(geometry, vertices.x, vec4f(face_local, 0.0));
  let normal1 = read_normal_direct(geometry, vertices.y, vec4f(face_local, 0.0));
  let normal2 = read_normal_direct(geometry, vertices.z, vec4f(face_local, 0.0));
  let tangent0 = read_tangent_direct(geometry, vertices.x, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent1 = read_tangent_direct(geometry, vertices.y, vec4f(1.0, 0.0, 0.0, 1.0));
  let tangent2 = read_tangent_direct(geometry, vertices.z, vec4f(1.0, 0.0, 0.0, 1.0));
  let color0 = read_color_direct(geometry, vertices.x, vec4f(1.0));
  let color1 = read_color_direct(geometry, vertices.y, vec4f(1.0));
  let color2 = read_color_direct(geometry, vertices.z, vec4f(1.0));
  let empty_uv = ReconstructedMaterialUv(vec2f(0.0), vec2f(0.0), vec2f(0.0));
  var albedo_uv = empty_uv;
  var normal_uv = empty_uv;
  var orm_uv = empty_uv;
  var emissive_uv = empty_uv;
  if kernel_class != OENGINE_MATERIAL_KERNEL_BASE_FACTOR {
    albedo_uv = reconstruct_material_uv(material_info, 0u, geometry, vertices, bary);
  }
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    normal_uv = reconstruct_material_uv(material_info, 1u, geometry, vertices, bary);
  }
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    orm_uv = reconstruct_material_uv(material_info, 2u, geometry, vertices, bary);
  }
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    emissive_uv = reconstruct_material_uv(material_info, 3u, geometry, vertices, bary);
  }

  let vertex_color = color0 * bary.weights.x + color1 * bary.weights.y +
    color2 * bary.weights.z;
  let local_normal = safe_normalize(
    normal0 * bary.weights.x + normal1 * bary.weights.y + normal2 * bary.weights.z,
    face_local
  );
  let local_tangent4 = tangent0 * bary.weights.x + tangent1 * bary.weights.y +
    tangent2 * bary.weights.z;
  let frame = object_transform_frame(oengine_instance_current_object_to_world(instance));
  let shading_normal = safe_normalize(frame.normal_matrix * local_normal, face_local);
  let geometric_normal = safe_normalize(frame.normal_matrix * face_local, shading_normal);
  var tangent = frame.tangent_matrix * local_tangent4.xyz;
  tangent = safe_normalize(
    tangent - shading_normal * dot(shading_normal, tangent),
    safe_normalize(
      cross(vec3f(0.0, 1.0, 0.0), shading_normal),
      vec3f(1.0, 0.0, 0.0)
    )
  );
  let tangent_handedness = select(-1.0, 1.0, local_tangent4.w >= 0.0);
  let bitangent = safe_normalize(
    cross(shading_normal, tangent) * tangent_handedness * frame.orientation,
    safe_normalize(cross(shading_normal, tangent), vec3f(0.0, 1.0, 0.0))
  );

  var mapped_normal = shading_normal;
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    var sampled_normal = sample_material_texture(
      material_info.normal_texture_ref,
      material_sampler_class(material_info, 1u),
      normal_uv.uv,
      normal_uv.ddx,
      normal_uv.ddy,
      bary.valid != 0u,
      vec4f(0.5, 0.5, 1.0, 1.0)
    ).xyz * 2.0 - 1.0;
    sampled_normal = vec3f(sampled_normal.xy * material_info.pbr_factors.z,
      sampled_normal.z);
    mapped_normal = safe_normalize(
      mat3x3f(tangent, bitangent, shading_normal) * sampled_normal,
      shading_normal
    );
  }
  var orm = vec4f(1.0);
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL ||
      kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    orm = sample_material_texture(
      material_info.orm_texture_ref,
      material_sampler_class(material_info, 2u),
      orm_uv.uv,
      orm_uv.ddx,
      orm_uv.ddy,
      bary.valid != 0u,
      vec4f(1.0)
    );
  }
  var albedo_sample = vec4f(1.0);
  if kernel_class != OENGINE_MATERIAL_KERNEL_BASE_FACTOR {
    albedo_sample = sample_material_texture(
      material_info.texture_ref,
      material_sampler_class(material_info, 0u),
      albedo_uv.uv,
      albedo_uv.ddx,
      albedo_uv.ddy,
      bary.valid != 0u,
      vec4f(1.0)
    );
  }
  var emissive_sample = vec4f(1.0);
  if kernel_class == OENGINE_MATERIAL_KERNEL_BASE_ORM_NORMAL_EMISSIVE ||
      kernel_class == OENGINE_MATERIAL_KERNEL_GENERIC_STANDARD_PBR {
    emissive_sample = sample_material_texture(
      material_info.emissive_texture_ref,
      material_sampler_class(material_info, 3u),
      emissive_uv.uv,
      emissive_uv.ddx,
      emissive_uv.ddy,
      bary.valid != 0u,
      vec4f(1.0)
    );
  }

  let albedo = albedo_sample.rgb * vertex_color * material_info.base_color_factor.rgb;
  let is_unlit = (material_info.flags & OENGINE_MATERIAL_UNLIT) != 0u;
  let ambient = select(
    1.0,
    mix(1.0, orm.r, material_info.pbr_factors.w),
    (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u
  );
  let metallic_sample = select(
    1.0,
    orm.b,
    (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u
  );
  let roughness_sample = select(
    1.0,
    orm.g,
    (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u
  );
  var pbr = vec2f(
    metallic_sample * material_info.pbr_factors.x,
    clamp(roughness_sample * material_info.pbr_factors.y, 0.0, 1.0)
  );
  var output_normal = vec4u(
    encode_g_buffer_normal(mapped_normal),
    encode_g_buffer_normal(geometric_normal)
  );
  var output_albedo = vec4f(albedo, ambient);
  var output_emissive = rgbe9995_encode(
    emissive_sample.rgb * material_info.emissive_factor.rgb
  );
  if is_unlit {
    pbr = vec2f(0.0, 1.0);
    output_normal = vec4u(
      encode_g_buffer_normal(shading_normal),
      encode_g_buffer_normal(geometric_normal)
    );
    output_albedo = vec4f(vec3f(0.0), 1.0);
    output_emissive = rgbe9995_encode(albedo);
  }

  var surface_flags = OENGINE_SURFACE_FLAG_VALID;
  if (material_info.flags & OENGINE_MATERIAL_HAS_NORMAL_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;
  }
  if (material_info.flags & OENGINE_MATERIAL_HAS_ORM_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_ORM_TEXTURE;
  }
  if (material_info.flags & OENGINE_MATERIAL_HAS_EMISSIVE_TEXTURE) != 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;
  }
  if is_unlit { surface_flags |= OENGINE_SURFACE_FLAG_UNLIT; }
  if bary.valid == 0u {
    surface_flags |= OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK |
      OENGINE_SURFACE_FLAG_REACTIVE;
  }

  var velocity = vec2f(0.0);
  if compute_settings.velocity_enabled != 0u &&
      oengine_instance_motion_valid(instance) && bary.valid != 0u {
    let current_world = world0 * bary.weights.x + world1 * bary.weights.y +
      world2 * bary.weights.z;
    let previous_world_h = oengine_instance_previous_from_current(instance) *
      current_world;
    if previous_world_h.w > 1e-8 {
      let previous_clip = previous_view_projection *
        vec4f(previous_world_h.xyz / previous_world_h.w, 1.0);
      if previous_clip.w > 1e-8 {
        let previous_ndc = previous_clip.xy / previous_clip.w;
        let resolution = vec2f(f32(view.width), f32(view.height));
        let previous_pixel = vec2f(
          (previous_ndc.x + 1.0) * 0.5 * resolution.x,
          (1.0 - previous_ndc.y) * 0.5 * resolution.y
        );
        velocity = pixel_position - previous_pixel;
        surface_flags |= OENGINE_SURFACE_FLAG_MOTION_VALID;
      } else {
        surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
      }
    } else {
      surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
    }
  } else {
    surface_flags |= OENGINE_SURFACE_FLAG_REACTIVE;
  }

  let metadata = oengine_surface_pack(work.material_slot_or_range, surface_flags);
  textureStore(compute_normal_output, vec2i(pixel), output_normal);
  textureStore(compute_albedo_ao_output, vec2i(pixel), output_albedo);
  textureStore(compute_emissive_output, vec2i(pixel), vec4u(output_emissive, 0u, 0u, 0u));
  textureStore(
    compute_pbr_metadata_velocity_output,
    vec2i(pixel),
    vec4u(pack2x16unorm(pbr), metadata, pack2x16float(velocity), 0u)
  );
  atomicAdd(&compute_pixel_claims[pixel.y * view.width + pixel.x], 1u);
}
`;
