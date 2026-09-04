/**
 * Sharpen 的生产 WGSL source-of-truth。
 * 该 pass 运行在线性 HDR（Bloom/Color Grading 之后、Tonemap 之前）。
 */

export const SHARPEN_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VertexOutput; out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0); return out;
}
`;

export const SHARPEN_WGSL = /* wgsl */ `
struct SharpenSettings { sharpness: f32, };
@group(0) @binding(0) var input_hdr: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: SharpenSettings;
const RCAS_LIMIT: f32 = 0.1875;

fn luminance(rgb: vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.212639, 0.715169, 0.072192));
}

@fragment
fn main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let coord = vec2<i32>(position.xy);
  let center = textureLoad(input_hdr, coord, 0);
  let north = textureLoad(input_hdr, coord + vec2<i32>(0, -1), 0).rgb;
  let west = textureLoad(input_hdr, coord + vec2<i32>(-1, 0), 0).rgb;
  let east = textureLoad(input_hdr, coord + vec2<i32>(1, 0), 0).rgb;
  let south = textureLoad(input_hdr, coord + vec2<i32>(0, 1), 0).rgb;
  let average = (north + west + east + south) * 0.25;
  let contrast = abs(luminance(center.rgb) - luminance(average));
  let amount = min(max(settings.sharpness, 0.0), 1.0) * min(RCAS_LIMIT, contrast + RCAS_LIMIT);
  return vec4<f32>(max(center.rgb + (center.rgb - average) * amount, vec3<f32>(0.0)), center.a);
}
`;

export const SHARPEN_FORMAT = "rgba16float" as const;
