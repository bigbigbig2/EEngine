import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
export const VSM_ATLAS_PAGE_CLEAR_WGSL = /* wgsl */ `
struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  dimensions: vec4u, // pages/axis, page size, border, atlas dimension
  control: vec4u,    // generation, work capacity, caster capacity, resident slots
};
struct PageWork {
  virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32,
};
struct Allocation {
  attempted: u32, written: u32, overflow: u32, generation: u32,
  records: array<PageWork>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> allocation: Allocation;
const corners = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
@vertex fn clear_page(@builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) record_index: u32) -> @builtin(position) vec4f {
  if (record_index >= min(allocation.written, constants.control.w)) { return vec4f(2.0); }
  let record = allocation.records[record_index];
  if (record.generation != constants.control.x || (record.flags & 2u) == 0u ||
      record.slot >= constants.control.w) { return vec4f(2.0); }
  let pitch = constants.dimensions.y + constants.dimensions.z * 2u;
  let slots_per_axis = max(1u, constants.dimensions.w / pitch);
  let origin = vec2f(f32((record.slot % slots_per_axis) * pitch),
    f32((record.slot / slots_per_axis) * pitch));
  let texel = origin + corners[vertex_index] * f32(pitch);
  let extent = f32(constants.dimensions.w);
  return vec4f(texel.x / extent * 2.0 - 1.0,
    1.0 - texel.y / extent * 2.0, 0.0, 1.0);
}
@fragment fn clear_depth() -> @builtin(frag_depth) f32 { return 0.0; }
`;
