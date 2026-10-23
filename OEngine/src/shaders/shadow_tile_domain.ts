import { VSM_MAX_CLIP_LEVELS, VSM_SHADOW_DOMAIN_HEADER_BYTES } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

// Fine 64^2 -> 1^2 pyramid (172 words), coarse 4^2 -> 1^2 (one word).
// Each clip starts on a 16B boundary. Both products contain SELECTED pages only.
export const SHADOW_TILE_WORDS_PER_CLIP = 176;
export const SHADOW_TILE_DOMAIN_BYTES =
  VSM_SHADOW_DOMAIN_HEADER_BYTES + VSM_MAX_CLIP_LEVELS * SHADOW_TILE_WORDS_PER_CLIP * 4;
const MATH = /* wgsl */ `
fn shadow_pyramid_offset(mip: u32) -> u32 {
  var bits = 0u;
  for (var level = 0u; level < mip; level++) { bits += (64u >> level) * (64u >> level); }
  return bits;
}
fn shadow_pyramid_bit(world: vec2i, mip: u32) -> u32 {
  let axis = 64u >> mip;
  return shadow_pyramid_offset(mip) + (u32(world.y) & (axis - 1u)) * axis + (u32(world.x) & (axis - 1u));
}
`;
export const SHADOW_TILE_QUERY_WGSL = /* wgsl */ `
struct ShadowTileDomain {
  light_view: mat4x4f,
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
  padding: array<vec4u, ${(VSM_SHADOW_DOMAIN_HEADER_BYTES - 64 - VSM_MAX_CLIP_LEVELS * 16) / 16}>,
  rows: array<u32>,
}
@group(2) @binding(15) var<storage, read> shadow_tiles: ShadowTileDomain;
${MATH}
fn shadow_domain_hit(light: vec2f, radius: vec2f, level: u32, coarse: bool) -> bool {
  if any(light != light) || any(radius != radius) || any(radius < vec2f(0.0)) { return true; }
  let cell = shadow_tiles.clips[level].z / select(64.0, 2.0, coarse);
  let rounding = (abs(light) + radius + vec2f(1.0)) * 0.000004;
  let padded_radius = radius + vec2f(cell * (4.0 / 64.0)) + rounding;
  let domain_axis = select(64.0, 4.0, coarse);
  if max(padded_radius.x, padded_radius.y) * 2.0 >= cell * domain_axis {
    let root_bit = select(5460u, 20u, coarse);
    let root_word = level * ${SHADOW_TILE_WORDS_PER_CLIP}u + select(root_bit / 32u, 172u, coarse);
    return (shadow_tiles.rows[root_word] & (1u << (root_bit & 31u))) != 0u;
  }
  let diameter = max(padded_radius.x, padded_radius.y) * 2.0 / cell;
  let mip = u32(clamp(ceil(log2(max(diameter, 1.0))), 0.0, select(6.0, 2.0, coarse)));
  let size = cell * exp2(f32(mip));
  let lo_float = floor((light - padded_radius) / size);
  let hi_float = floor((light + padded_radius) / size);
  if any(abs(lo_float) > vec2f(1e9)) || any(abs(hi_float) > vec2f(1e9)) { return true; }
  let lo = vec2i(lo_float);
  let hi = vec2i(hi_float);
  for (var y = lo.y; y <= hi.y; y++) {
    for (var x = lo.x; x <= hi.x; x++) {
      var bit = shadow_pyramid_bit(vec2i(x, y), mip);
      if coarse {
        let axis = 4u >> mip;
        bit = select(select(20u, 16u, mip == 1u), 0u, mip == 0u) +
          (u32(y) & (axis - 1u)) * axis + (u32(x) & (axis - 1u));
      }
      let word = level * ${SHADOW_TILE_WORDS_PER_CLIP}u + select(bit / 32u, 172u, coarse);
      if (shadow_tiles.rows[word] & (1u << (bit & 31u))) != 0u { return true; }
    }
  }
  return false;
}
fn hierarchy_shadow_texel(sphere: OEngineWorldSphere) -> f32 {
  let light = (shadow_tiles.light_view * vec4f(sphere.center, 1.0)).xy;
  let radius = sphere.radius * vec2f(
    length(vec3f(shadow_tiles.light_view[0].x, shadow_tiles.light_view[1].x, shadow_tiles.light_view[2].x)),
    length(vec3f(shadow_tiles.light_view[0].y, shadow_tiles.light_view[1].y, shadow_tiles.light_view[2].y)));
  var finest = 3.402823466e38;
  for (var level = 0u; level < ${VSM_MAX_CLIP_LEVELS}u; level++) {
    let clip = shadow_tiles.clips[level];
    if clip.z <= 0.0 { continue; }
    if shadow_domain_hit(light, radius, level, false) { finest = min(finest, clip.w); }
    if shadow_domain_hit(light, radius, level, true) { finest = min(finest, clip.w * 32.0); }
  }
  return finest;
}
fn hierarchy_shadow_requested(sphere: OEngineWorldSphere) -> bool {
  return hierarchy_shadow_texel(sphere) < 3.402823466e38;
}
fn hierarchy_shadow_selected(sphere: OEngineWorldSphere) -> bool {
  return hierarchy_shadow_requested(sphere);
}
fn hierarchy_shadow_error(world_error: f32, sphere: OEngineWorldSphere) -> f32 {
  return world_error / max(hierarchy_shadow_texel(sphere), 1e-20);
}
`;

export const SHADOW_TILE_BUILD_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
${MATH}
struct Constants { light_view: mat4x4f, clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>, control: vec4u, }
struct PageWork { virtual_page: u32, slot: u32, priority: u32, generation: u32,
  flags: u32, fallback_mip: u32, world: vec2i, }
struct Allocation { attempted: u32, written: u32, overflow: u32, generation: u32, records: array<PageWork>, }
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(2) var<storage, read> allocation: Allocation;
@group(0) @binding(3) var<storage, read_write> rows: array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= allocation.written { return; }
  let page = allocation.records[id.x];
  let coordinate = vsm_page_entry_coordinates(page.virtual_page, constants.control.y);
  let coarse = coordinate.y == 5u;
  // Query expands caster bounds by the actual gutter; do not mark entire
  // neighbour pages and spuriously refine their full interiors at fine LOD.
  for (var mip = 0u; mip <= select(6u, 2u, coarse); mip++) {
    let parent = vec2i(floor(vec2f(page.world) / exp2(f32(mip))));
    var bit = shadow_pyramid_bit(parent, mip);
    if coarse {
      let axis = 4u >> mip;
      bit = select(select(20u, 16u, mip == 1u), 0u, mip == 0u) +
        (u32(parent.y) & (axis - 1u)) * axis + (u32(parent.x) & (axis - 1u));
    }
    let word = coordinate.x * ${SHADOW_TILE_WORDS_PER_CLIP}u + select(bit / 32u, 172u, coarse);
    atomicOr(&rows[word], 1u << (bit & 31u));
  }
}
`;
