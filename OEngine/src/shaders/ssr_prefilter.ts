/**
 * ssr_prefilter：定义对应渲染阶段使用的 WGSL 着色器代码。
 */


import { SSR_FULLSCREEN_VERTEX_WGSL, SSR_MATH_WGSL } from "./ssr_common.js";

export const SSR_PREFILTER_FORMAT = "rgba16float" as const;

export const SSR_PREFILTER_COPY_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var this_hit: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  return textureLoad(this_hit, vec2u(coord.xy), 0);
}
`;

export const SSR_PREFILTER_DEPTH_AWARE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var segment_height: sampler;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  // 深度感知累积使用 textureLoad，但绑定布局仍要求采样器保持静态可见。
  if (coord.x < 0.0) {
    _ = textureSampleLevel(this_hit, segment_height, uv, 0.0);
  }
  let input_size = textureDimensions(this_hit).xy;
  let output_size = input_size >> vec2u(1u);
  let half_texel = 0.5 / vec2f(output_size);
  let minimum = max(vec2u(uv_to_texel_coordinate(uv - half_texel, input_size)), vec2u(0u));
  let maximum = min(vec2u(ceil(uv_to_texel_coordinate(uv + half_texel, input_size))), input_size - 1u);
  var color = vec4f(0.0);
  var weight = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    for (var x = minimum.x; x <= maximum.x; x++) {
      let sample_color = textureLoad(this_hit, vec2u(x, y), 0);
      let depth = textureLoad(gr_bucket, vec2u(x, y), 0).r;
      let valid = step(1e-7, depth);
      let sample_weight = valid / (1.0 + rgb_to_luminance(sample_color.rgb));
      color += sample_color * sample_weight;
      weight += sample_weight;
    }
  }
  return select(color, color / weight, weight > 1e-7);
}
`;

export const SSR_PREFILTER_DOWNSAMPLE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
@group(0) @binding(0) var this_hit: texture_2d<f32>;
@group(0) @binding(1) var low_pos: sampler;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  return textureSample(this_hit, low_pos, uv);
}
`;
