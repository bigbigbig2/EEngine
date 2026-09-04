/**
 * Bloom 的生产 WGSL source-of-truth。
 * legacy generated shader 不再参与生产构建。
 */

export const BLOOM_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let ndc = positions[vertex_index]; var out: VertexOutput;
  out.position = vec4<f32>(ndc, 0.0, 1.0); out.uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5); return out;
}
`;

export const BLOOM_PREFILTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var source_hdr: texture_2d<f32>;
@group(0) @binding(1) var linear_clamp: sampler;
@fragment
fn main(@builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let color = textureSampleLevel(source_hdr, linear_clamp, uv, 0.0).rgb;
  let luma = dot(color, vec3<f32>(0.212639, 0.715169, 0.072192));
  return vec4<f32>(max(color - vec3<f32>(max(0.25, luma * 0.25)), vec3<f32>(0.0)), 1.0);
}
`;

export const BLOOM_DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source_mip: texture_2d<f32>;
@group(0) @binding(1) var linear_clamp: sampler;
@fragment
fn main(@builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(source_mip)); var sum = vec3<f32>(0.0);
  sum += textureSampleLevel(source_mip, linear_clamp, uv + texel * vec2<f32>(-1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source_mip, linear_clamp, uv + texel * vec2<f32>( 1.0, -1.0), 0.0).rgb;
  sum += textureSampleLevel(source_mip, linear_clamp, uv + texel * vec2<f32>(-1.0,  1.0), 0.0).rgb;
  sum += textureSampleLevel(source_mip, linear_clamp, uv + texel * vec2<f32>( 1.0,  1.0), 0.0).rgb;
  return vec4<f32>(sum * 0.25, 1.0);
}
`;

export const BLOOM_UPSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var current_mip: texture_2d<f32>;
@group(0) @binding(1) var lower_mip: texture_2d<f32>;
@group(0) @binding(2) var linear_clamp: sampler;
@fragment
fn main(@builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(lower_mip)); var blur = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    blur += textureSampleLevel(lower_mip, linear_clamp, uv + vec2<f32>(f32(x), f32(y)) * texel, 0.0).rgb;
  }}
  let base = textureSampleLevel(current_mip, linear_clamp, uv, 0.0).rgb;
  return vec4<f32>(base + blur / 9.0 * 0.85, 1.0);
}
`;

export const BLOOM_COMPOSITE_WGSL = /* wgsl */ `
struct BloomSettings { intensity: f32, };
@group(0) @binding(0) var bloom: texture_2d<f32>;
@group(0) @binding(1) var scene_hdr: texture_2d<f32>;
@group(0) @binding(2) var linear_clamp: sampler;
@group(0) @binding(3) var<uniform> settings: BloomSettings;
@fragment
fn main(@builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let scene = textureLoad(scene_hdr, vec2<i32>(position.xy), 0);
  let bloom_color = textureSampleLevel(bloom, linear_clamp, uv, 0.0);
  return vec4<f32>(scene.rgb + bloom_color.rgb * settings.intensity, scene.a);
}
`;

export const BLOOM_FORMAT = "rgba16float" as const;
export const BLOOM_MIP_COUNT = 5;
export const BLOOM_UPSAMPLE_FACTOR = 0.85;
