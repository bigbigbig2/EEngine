export const VSM_ATLAS_PAGE_CLEAR_WGSL = /* wgsl */ `
struct Constants {
  light_view: mat4x4f,
  clip_origin_extent: array<vec4f, 6>,
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

const VSM_PAGE_ALLOCATED = 1,
  VSM_PAGE_DIRTY = 2,
  VSM_PAGE_GENERATION_VALID = 8;
export const VSM_ATLAS_PAGE_MATH = /* wgsl */ `
fn atlas_position(light: vec3f, entry: VsmPageEntry, virtual_page: u32) -> vec4f {
  let pages = constants.dimensions.x;
  let coordinates = vsm_page_entry_coordinates(virtual_page, pages);
  let level = min(5u, coordinates.x);
  let page_axis = max(1u, pages >> min(entry.mip, 5u));
  let page_x = coordinates.z;
  let page_y = coordinates.w;
  let extent = constants.clip_origin_extent[level].z;
  let uv = (light.xy - constants.clip_origin_extent[level].xy) / max(extent, 1e-5) * f32(page_axis) - vec2f(f32(page_x), f32(page_y));
  let slot_x = entry.slot_x;
  let slot_y = entry.slot_y;
  let texel = vec2f(f32(slot_x * (constants.dimensions.y + constants.dimensions.z * 2u) + constants.dimensions.z), f32(slot_y * (constants.dimensions.y + constants.dimensions.z * 2u) + constants.dimensions.z)) + uv * f32(constants.dimensions.y);
  let ndc = vec2f(texel.x / f32(constants.dimensions.w) * 2.0 - 1.0, 1.0 - texel.y / f32(constants.dimensions.w) * 2.0);
  let depth = clamp(0.5 - light.z / max(extent * 8.0, 1.0), 0.0, 1.0);
  return vec4f(ndc, depth, 1.0);
}
fn valid_page(record: VsmCasterRecord) -> VsmPageEntry {
  if (record.virtual_page >= arrayLength(&page_table.entries)) { return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u); }
  let entry = page_table.entries[record.virtual_page];
  if (entry.slot_x + entry.slot_y * max(1u, constants.dimensions.w / (constants.dimensions.y + constants.dimensions.z * 2u)) != record.page_slot ||
      entry.generation != constants.control.x ||
      (entry.flags & (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) !=
        (${VSM_PAGE_ALLOCATED}u | ${VSM_PAGE_DIRTY}u | ${VSM_PAGE_GENERATION_VALID}u)) {
    return VsmPageEntry(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
  }
  return entry;
}
`;
