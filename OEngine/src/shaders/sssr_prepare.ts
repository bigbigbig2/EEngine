import { SSSR_FRAME_WGSL } from "./sssr_common.js";

export const SSSR_DEPTH_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_depth_2d;
@group(0) @binding(1) var output_depth: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output_depth))) {
    return;
  }
  textureStore(output_depth, vec2i(id.xy), vec4f(textureLoad(source, vec2i(id.xy), 0)));
}
`;

// Native reverse-Z nearest reduction. NPOT coverage is conservative in the
// normalized grids actually used by traversal; no cross-workgroup spin barrier.
export const SSSR_DEPTH_REDUCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output_depth: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let target_size = textureDimensions(output_depth);
  if (any(id.xy >= target_size)) {
    return;
  }
  let source_size = textureDimensions(source);
  let first = id.xy * source_size / target_size;
  let end = ((id.xy + 1u) * source_size + target_size - 1u) / target_size;
  var nearest = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      nearest = max(nearest, textureLoad(source, vec2i(vec2u(x, y)), 0).x);
    }
  }
  textureStore(output_depth, vec2i(id.xy), vec4f(nearest));
}
`;

// AMD MIT: prepare_blue_noise_texture.h::SampleRandomNumber/Vector2D.
export const SSSR_BLUE_NOISE_WGSL = /* wgsl */ `
${SSSR_FRAME_WGSL}
@group(0) @binding(0) var<uniform> frame: SssrFrame;
@group(0) @binding(1) var<storage, read> tables: array<u32>;
@group(0) @binding(2) var noise: texture_storage_2d<rg8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = id.xy;
  let index = (pixel.x + pixel.y * 128u) * 8u;
  let rotation = f32(frame.state.x & 255u) * 1.61803398875;
  let a = (f32(tables[0] ^ tables[65536u + index]) + 0.5) / 256.0;
  let b = (f32(tables[1] ^ tables[65537u + index]) + 0.5) / 256.0;
  textureStore(noise, vec2i(pixel), vec4f(fract(vec2f(a, b) + rotation), 0.0, 0.0));
}
`;

export const SSSR_INDIRECT_WGSL = /* wgsl */ `
${SSSR_FRAME_WGSL}
@group(0) @binding(0) var<uniform> frame: SssrFrame;
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let ray_groups = counts[0] / 64u + select(0u, 1u, counts[0] % 64u != 0u);
  let tile_groups = counts[1];
  var ray_x = min(ray_groups, frame.capacity.y);
  var tile_x = min(tile_groups, frame.capacity.y);
  if (ray_groups > frame.capacity.y) {
    ray_x = min(u32(ceil(sqrt(f32(ray_groups)))), frame.capacity.y);
  }
  if (tile_groups > frame.capacity.y) {
    tile_x = min(u32(ceil(sqrt(f32(tile_groups)))), frame.capacity.y);
  }
  args[0] = ray_x;
  args[1] = (ray_groups + max(ray_x, 1u) - 1u) / max(ray_x, 1u);
  args[2] = 1u;
  args[3] = tile_x;
  args[4] = (tile_groups + max(tile_x, 1u) - 1u) / max(tile_x, 1u);
  args[5] = 1u;
}
`;
