/** Compute HZB：reverse-Z min/max pyramid，8x8 workgroup。 */

export const HZB_WORKGROUP_SIZE = 8;

const HZB_COMMON_WGSL = /* wgsl */ `
fn sanitize_reverse_z(depth: f32) -> f32 {
  // NaN is the only floating-point value that is not equal to itself.
  return select(clamp(depth, 0.0, 1.0), 0.0, depth != depth);
}

fn conservative_rg16_bounds(farthest: f32, nearest: f32) -> vec2f {
  // RG16F stores must not round reverse-Z minima toward the viewer. Round
  // outward once here; subsequent pyramid levels preserve representable bounds.
  var lo = pack2x16float(vec2f(farthest, 0.0)) & 0xffffu;
  var hi = pack2x16float(vec2f(nearest, 0.0)) & 0xffffu;
  if (unpack2x16float(lo).x > farthest && lo > 0u) { lo -= 1u; }
  if (unpack2x16float(hi).x < nearest) { hi += 1u; }
  // Also conservative on implementations that flush f16 subnormals.
  if (farthest < 0.00006103515625) { lo = 0u; }
  if (nearest > 0.0 && nearest < 0.00006103515625) { hi = 0x0400u; }
  return vec2f(unpack2x16float(lo).x, unpack2x16float(hi).x);
}

fn coverage_first(coord: u32, source_size: u32, output_size: u32) -> u32 {
  return (coord * source_size) / output_size;
}

fn coverage_end(coord: u32, source_size: u32, output_size: u32) -> u32 {
  return min(source_size, max(
    coverage_first(coord, source_size, output_size) + 1u,
    ((coord + 1u) * source_size + output_size - 1u) / output_size
  ));
}
`;

export const HZB_FROM_DEPTH_COMPUTE_WGSL = /* wgsl */ `
requires texture_formats_tier1;

${HZB_COMMON_WGSL}

struct SourceRegion {
  origin: vec2u,
  extent: vec2u,
};

@group(0) @binding(0) var source_depth: texture_depth_2d;
@group(0) @binding(1) var output_hzb: texture_storage_2d<rg16float, write>;
@group(0) @binding(2) var<uniform> source_region: SourceRegion;

@compute @workgroup_size(${HZB_WORKGROUP_SIZE}, ${HZB_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let output_size = textureDimensions(output_hzb);
  if (any(gid.xy >= output_size)) { return; }
  let first = vec2u(
    coverage_first(gid.x, source_region.extent.x, output_size.x),
    coverage_first(gid.y, source_region.extent.y, output_size.y)
  );
  let end = vec2u(
    coverage_end(gid.x, source_region.extent.x, output_size.x),
    coverage_end(gid.y, source_region.extent.y, output_size.y)
  );
  var farthest = 1.0;
  var nearest = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let coord = source_region.origin + vec2u(x, y);
      let depth = sanitize_reverse_z(textureLoad(source_depth, vec2i(coord), 0));
      farthest = min(farthest, depth);
      nearest = max(nearest, depth);
    }
  }
  textureStore(output_hzb, vec2i(gid.xy), vec4f(conservative_rg16_bounds(farthest, nearest), 0.0, 0.0));
}
`;

export const HZB_REDUCE_COMPUTE_WGSL = /* wgsl */ `
requires texture_formats_tier1;

${HZB_COMMON_WGSL}

@group(0) @binding(0) var source_hzb: texture_2d<f32>;
@group(0) @binding(1) var output_hzb: texture_storage_2d<rg16float, write>;

@compute @workgroup_size(${HZB_WORKGROUP_SIZE}, ${HZB_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let source_size = textureDimensions(source_hzb);
  let output_size = textureDimensions(output_hzb);
  if (any(gid.xy >= output_size)) { return; }
  let first = vec2u(
    coverage_first(gid.x, source_size.x, output_size.x),
    coverage_first(gid.y, source_size.y, output_size.y)
  );
  let end = vec2u(
    coverage_end(gid.x, source_size.x, output_size.x),
    coverage_end(gid.y, source_size.y, output_size.y)
  );
  var farthest = 1.0;
  var nearest = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let min_max = textureLoad(source_hzb, vec2i(i32(x), i32(y)), 0).xy;
      farthest = min(farthest, sanitize_reverse_z(min_max.x));
      nearest = max(nearest, sanitize_reverse_z(min_max.y));
    }
  }
  textureStore(output_hzb, vec2i(gid.xy), vec4f(conservative_rg16_bounds(farthest, nearest), 0.0, 0.0));
}
`;
