/**
 * Shared HDR color-pyramid kernels.
 *
 * The producer is intentionally algorithm-neutral: semantic ownership lives in
 * FrameProducts/SharedColorPyramidPass.  Opaque mip 1 keeps the depth-aware,
 * inverse-luminance reduction previously embedded in SSR; later opaque mips
 * and every final-color mip use the same bounded 2x2 linear reduction.
 */

import { SSR_FULLSCREEN_VERTEX_WGSL, SSR_MATH_WGSL } from "./ssr_common.js";

export const SHARED_COLOR_PYRAMID_FORMAT = "rgba16float" as const;

export const SHARED_COLOR_PYRAMID_COPY_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source_color: texture_2d<f32>;
@group(0) @binding(1) var linear_clamp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(source_color, linear_clamp, uv, 0.0);
}
`;

export const SHARED_OPAQUE_PYRAMID_DEPTH_AWARE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
@group(0) @binding(0) var source_color: texture_2d<f32>;
@group(0) @binding(1) var source_depth: texture_depth_2d;

@fragment
fn fs_main(
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let input_size = textureDimensions(source_color);
  let output_size = max(input_size >> vec2u(1u), vec2u(1u));
  let half_texel = 0.5 / vec2f(output_size);
  let minimum = max(
    vec2i(floor(uv_to_texel_coordinate(uv - half_texel, input_size))),
    vec2i(0)
  );
  let maximum = min(
    vec2i(ceil(uv_to_texel_coordinate(uv + half_texel, input_size))),
    vec2i(input_size) - vec2i(1)
  );
  var color = vec4f(0.0);
  var weight = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    for (var x = minimum.x; x <= maximum.x; x++) {
      let sample_color = textureLoad(source_color, vec2i(x, y), 0);
      let depth = textureLoad(source_depth, vec2i(x, y), 0);
      let valid = select(0.0, 1.0, depth > 1e-7);
      let sample_weight = valid / (1.0 + rgb_to_luminance(sample_color.rgb));
      color += sample_color * sample_weight;
      weight += sample_weight;
    }
  }
  return select(vec4f(0.0), color / max(weight, 1e-7), weight > 1e-7);
}
`;

export const SHARED_COLOR_PYRAMID_DOWNSAMPLE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var source_mip: texture_2d<f32>;
@group(0) @binding(1) var linear_clamp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(source_mip, linear_clamp, uv, 0.0);
}
`;
