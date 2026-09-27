import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Receiver-driven directional VSM demand. GPU allocation consumes this bounded buffer next. */
export const VSM_RECEIVER_DEMAND_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}

struct Camera {
  transform: mat4x4f, transform_inverse: mat4x4f,
  view_matrix: mat4x4f, view_matrix_inverse: mat4x4f,
  projection_matrix: mat4x4f, projection_matrix_inverse: mat4x4f,
  view_projection_matrix: mat4x4f, view_projection_matrix_inverse: mat4x4f,
  frustum: array<vec4f, 6>, device_depth_to_view_space: vec4f,
};

struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
  dimensions: vec4u,
  control: vec4u,
  viewport: vec4f,
};

struct VsmDemandRecord {
  virtual_page: u32,
  mip: u32,
  priority: u32,
  flags: u32,
  receiver_bounds: vec4f,
};

struct VsmDemandBuffer {
  attempted: atomic<u32>,
  written: atomic<u32>,
  overflow: atomic<u32>,
  generation: atomic<u32>,
  records: array<VsmDemandRecord>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var receiver_depth: texture_depth_2d;
@group(0) @binding(2) var visibility_key: texture_2d<u32>;
@group(0) @binding(3) var<uniform> constants: Constants;
@group(0) @binding(4) var<storage, read_write> demand: VsmDemandBuffer;

fn world_from_depth(pixel: vec2u, depth: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) * constants.viewport.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let projected = camera.view_projection_matrix_inverse * vec4f(ndc, depth, 1.0);
  return projected.xyz / projected.w;
}

fn choose_clip_level(light_xy: vec2f, footprint: f32) -> vec3u {
  var selected = constants.control.x - 1u;
  var uv = vec2f(0.0);
  var mip = min(constants.control.x - 1u, u32(max(0.0, ceil(log2(max(1.0, footprint))))));
  for (var level = 0u; level < 6u; level++) {
    if (level >= constants.control.x) { break; }
    let extent = constants.clip_origin_extent[level].z;
    let candidate = (light_xy - constants.clip_origin_extent[level].xy) / max(extent, 1e-5);
    if (all(candidate >= vec2f(0.0)) && all(candidate <= vec2f(1.0))) {
      selected = level;
      uv = candidate;
      mip = min(level, mip);
      break;
    }
  }
  return vec3u(selected, u32(clamp(f32(mip), 0.0, f32(constants.control.x - 1u))),
    bitcast<u32>(uv.x));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= constants.dimensions.x || id.y >= constants.dimensions.y) { return; }
  let pixel = id.xy;
  let depth = textureLoad(receiver_depth, vec2i(pixel), 0);
  if (depth <= 0.0001) { return; }
  let key = textureLoad(visibility_key, vec2i(pixel), 0).x;
  if (key == 0xffffffffu || key == 0xfffffffeu) { return; }
  let world = world_from_depth(pixel, depth);
  let light_position = (constants.light_view * vec4f(world, 1.0)).xyz;
  let footprint = max(1.0, abs(camera.device_depth_to_view_space.y /
    max(depth + camera.device_depth_to_view_space.x, 1e-5)) * constants.viewport.z);
  let selection = choose_clip_level(light_position.xy, footprint);
  let level = selection.x;
  let mip = selection.y;
  let extent = constants.clip_origin_extent[level].z;
  let uv = clamp((light_position.xy - constants.clip_origin_extent[level].xy) /
    max(extent, 1e-5), vec2f(0.0), vec2f(0.999999));
  let page_axis = constants.dimensions.w >> mip;
  let page = vec2u(min(page_axis - 1u, u32(uv.x * f32(page_axis))),
    min(page_axis - 1u, u32(uv.y * f32(page_axis))));
  let virtual_page = vsm_page_entry_index(level, page.x, page.y, constants.dimensions.w);
  let ticket = atomicAdd(&demand.attempted, 1u);
  if (ticket >= constants.control.z) {
    atomicAdd(&demand.overflow, 1u);
    return;
  }
  demand.records[ticket].virtual_page = virtual_page;
  demand.records[ticket].mip = mip;
  demand.records[ticket].priority = 0xffffffffu - min(0xffffu, u32(footprint));
  demand.records[ticket].flags = 1u;
  demand.records[ticket].receiver_bounds = vec4f(light_position.xy, light_position.z, f32(level));
  atomicAdd(&demand.written, 1u);
}
`;
