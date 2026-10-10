import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Receiver-driven directional VSM demand. GPU allocation consumes this bounded buffer next. */
export const VSM_RECEIVER_DEMAND_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}

struct Camera {
  transform: mat4x4f,
  transform_inverse: mat4x4f,
  view_matrix: mat4x4f,
  view_matrix_inverse: mat4x4f,
  projection_matrix: mat4x4f,
  projection_matrix_inverse: mat4x4f,
  view_projection_matrix: mat4x4f,
  view_projection_matrix_inverse: mat4x4f,
  frustum: array<vec4f,
  6>,
  device_depth_to_view_space: vec4f,
};

struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
  viewport: vec4f,
  depth_range: vec4f,
  identity: vec4u,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var receiver_depth: texture_depth_2d;
@group(0) @binding(2) var visibility_key: texture_2d<u32>;
@group(0) @binding(3) var<uniform> constants: Constants;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(6) var<storage, read> instances: array<OEngineInstanceRecord>;

fn world_from_depth(pixel: vec2u, depth: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) * constants.viewport.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let projected = camera.view_projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  return projected.xyz / projected.w;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= constants.dimensions.x || id.y >= constants.dimensions.y) {
    return;
  }
  let pixel = id.xy;
  let depth = textureLoad(receiver_depth, vec2i(pixel), 0);
  if (depth <= 0.0001) {
    return;
  }
  let key = textureLoad(visibility_key, vec2i(pixel), 0).x;
  if (key == 0xffffffffu || key == 0xfffffffeu) {
    return;
  }
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (decoded.valid == 0u || decoded.meshlet_work_slot >= min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {
    return;
  }
  let instance_slot = meshlet_work.elements[decoded.meshlet_work_slot].instance_slot;
  if (instance_slot >= arrayLength(&instances)) {
    return;
  }
  let instance = instances[instance_slot];
  if ((instance.flags & ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u) != ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.ReceivesShadow}u ||
      (instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u || oengine_instance_shading_bin_id(instance.flags) < 4u) { return; }
  let world = world_from_depth(pixel, depth);
  let light_position = (constants.light_view * vec4f(world, 1.0)).xyz;
  let level = vsm_select_clip(light_position.xy, constants.clip_origin_extent, constants.control.x, constants.dimensions.w);
  if (level == VSM_INVALID_SLOT) {
    return;
  }
  let mip = 0u;
  let clip = constants.clip_origin_extent[level];
  let world_page = vsm_world_page(light_position.xy, clip, mip, constants.dimensions.w);
  let virtual_page = vsm_world_page_entry_index(level, mip, world_page, constants.dimensions.w);
  atomicOr(&requested[virtual_page / 32u], 1u << (virtual_page % 32u));
}
@compute @workgroup_size(64)
fn mark_coarse(@builtin(global_invocation_id) id: vec3u) {
  let pages = constants.dimensions.w;
  let axis = vsm_storage_axis(pages, 5u);
  let level = id.x / (axis * axis);
  if (level >= constants.control.x || constants.depth_range.w == 0.0) {
    return;
  }
  let local = id.x % (axis * axis);
  let clip = constants.clip_origin_extent[level];
  let minimum = vsm_window_minimum(clip, 5u, pages);
  let world = minimum + vec2i(i32(local % axis), i32(local / axis));
  if (!vsm_world_in_window(world, clip, 5u, pages)) {
    return;
  }
  let entry = vsm_world_page_entry_index(level, 5u, world, pages);
  atomicOr(&requested[entry / 32u], 1u << (entry % 32u));
}

`;
