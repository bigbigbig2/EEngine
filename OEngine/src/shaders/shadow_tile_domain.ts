import { VSM_MAX_CLIP_LEVELS, VSM_SHADOW_DOMAIN_HEADER_BYTES } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

// Two conservative toroidal 32x32 grids per clip. One bit is eight fine tiles.
// Aliasing can add work, but cannot reject a true intersection.
export const SHADOW_TILE_DOMAIN_BYTES = VSM_SHADOW_DOMAIN_HEADER_BYTES + 2 * VSM_MAX_CLIP_LEVELS * 32 * 4;

export const SHADOW_TILE_QUERY_WGSL = /* wgsl */ `
struct ShadowTileDomain {
  light_view: mat4x4f,
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  padding: array<vec4u, ${(VSM_SHADOW_DOMAIN_HEADER_BYTES - 64 - VSM_MAX_CLIP_LEVELS * 16) / 16}>,
  rows: array<u32>,
};
@group(2) @binding(15) var<storage, read> shadow_tiles: ShadowTileDomain;

fn shadow_column_mask(low: i32, high: i32) -> u32 {
  let count = u32(clamp(high - low + 1, 0, 32));
  if (count == 32u) { return 0xffffffffu; }
  let bits = (1u << count) - 1u;
  let shift = u32(low) & 31u;
  return (bits << shift) | (bits >> ((32u - shift) & 31u));
}
fn hierarchy_shadow_intersects(sphere: OEngineWorldSphere, domain: u32) -> bool {
  let light = shadow_tiles.light_view * vec4f(sphere.center, 1.0);
  let radius = sphere.radius * vec2f(
    length(vec3f(shadow_tiles.light_view[0].x, shadow_tiles.light_view[1].x, shadow_tiles.light_view[2].x)),
    length(vec3f(shadow_tiles.light_view[0].y, shadow_tiles.light_view[1].y, shadow_tiles.light_view[2].y))
  );
  if (any(light != light) || any(abs(light) > vec4f(1e30)) ||
      any(radius != radius) || any(radius > vec2f(1e30))) { return true; }
  for (var level = 0u; level < ${VSM_MAX_CLIP_LEVELS}u; level++) {
    let clip = shadow_tiles.clips[level];
    if (clip.z <= 0.0) { continue; }
    let cell = clip.z / 16.0;
    let lower = floor((light.xy - radius) / cell);
    let upper = floor((light.xy + radius) / cell);
    if (any(abs(lower) > vec2f(1e9)) || any(abs(upper) > vec2f(1e9))) { return true; }
    let lo = vec2i(lower);
    let hi = vec2i(upper);
    let mask = shadow_column_mask(lo.x, hi.x);
    let rows = min(32, hi.y - lo.y + 1);
    for (var y = 0; y < rows; y++) {
      let index = domain * ${VSM_MAX_CLIP_LEVELS * 32}u + level * 32u + (u32(lo.y + y) & 31u);
      if ((shadow_tiles.rows[index] & mask) != 0u) { return true; }
    }
  }
  return false;
}
fn hierarchy_shadow_requested(sphere: OEngineWorldSphere) -> bool {
  return hierarchy_shadow_intersects(sphere, 0u);
}
fn hierarchy_shadow_selected(sphere: OEngineWorldSphere) -> bool {
  return hierarchy_shadow_intersects(sphere, 1u);
}
`;

export const SHADOW_TILE_BUILD_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
struct Constants {
  light_view: mat4x4f,
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  control: vec4u, // virtual entries, pages per axis, page size, border
};
struct PageWork {
  virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, world: vec2i,
};
struct Allocation {
  attempted: u32, written: u32, overflow: u32, generation: u32,
  records: array<PageWork>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> requested: array<u32>;
@group(0) @binding(2) var<storage, read> allocation: Allocation;
@group(0) @binding(3) var<storage, read_write> rows: array<atomic<u32>>;
fn mark_page(level: u32, mip: u32, world: vec2i, domain: u32) {
  let page_size = constants.clips[level].z / f32(constants.control.y >> mip);
  let gutter = page_size * f32(constants.control.w) / f32(constants.control.z);
  let cell = constants.clips[level].z / 16.0;
  let lo = vec2i(floor((vec2f(world) * page_size - gutter) / cell));
  let hi = vec2i(floor((vec2f(world + vec2i(1)) * page_size + gutter) / cell));
  var mask = 0u;
  for (var x = lo.x; x <= hi.x; x++) { mask |= 1u << (u32(x) & 31u); }
  for (var y = lo.y; y <= hi.y; y++) {
    atomicOr(&rows[domain * ${VSM_MAX_CLIP_LEVELS * 32}u + level * 32u + (u32(y) & 31u)], mask);
  }
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let word_count = (constants.control.x + 31u) / 32u;
  if (id.x < word_count) {
    var bits = requested[id.x];
    while (bits != 0u) {
      let bit = firstTrailingBit(bits);
      bits &= bits - 1u;
      let page = id.x * 32u + bit;
      if (page >= constants.control.x) { continue; }
      let coordinate = vsm_page_entry_coordinates(page, constants.control.y);
      let clip = constants.clips[coordinate.x];
      let minimum = vsm_window_minimum(clip, coordinate.y, constants.control.y);
      let axis = vsm_storage_axis(constants.control.y, coordinate.y);
      let world = minimum + vec2i(
        i32(vsm_floor_mod(i32(coordinate.z) - minimum.x, axis)),
        i32(vsm_floor_mod(i32(coordinate.w) - minimum.y, axis)));
      mark_page(coordinate.x, coordinate.y, world, 0u);
    }
  }
  if (id.x < allocation.written) {
    let page = allocation.records[id.x];
    let coordinate = vsm_page_entry_coordinates(page.virtual_page, constants.control.y);
    mark_page(coordinate.x, coordinate.y, page.world, 1u);
    // Backlog pages may no longer be requested, but still need complete casters.
    mark_page(coordinate.x, coordinate.y, page.world, 0u);
  }
}
`;
