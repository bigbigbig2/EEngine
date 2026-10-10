// Independent pre-repair per-mip reference, pinned to EEngine 57f1499a.
// Test-only numerical oracle; never imported by production.
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "../../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
export const SOURCE_WGSL = `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var current_luma: texture_2d<f32>;
@group(0) @binding(1) var farthest_depth: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: Fsr3Constants;
@group(0) @binding(3) var mip0: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var farthest_mip1: texture_storage_2d<r16float, write>;

fn source_value(pixel: vec2i) -> vec4f {
  let clamped = clamp(pixel, vec2i(0), constants.render_size - vec2i(1));
  let luma = textureLoad(current_luma, clamped, 0).x;
  let log_luma = max(0.000061, log(luma));
  let farthest = textureLoad(farthest_depth, clamped, 0).x;
  return vec4f(log_luma, luma, farthest, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dst = vec2i(id.xy);
  if (any(dst >= vec2i(textureDimensions(mip0)))) { return; }
  let src = dst * 2;
  let value = (source_value(src) + source_value(src + vec2i(0, 1)) +
    source_value(src + vec2i(1, 0)) + source_value(src + vec2i(1, 1))) * 0.25;
  textureStore(mip0, dst, value);
  textureStore(farthest_mip1, dst, vec4f(value.z, 0.0, 0.0, 0.0));
}
`;
export const REDUCE_F32_WGSL = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float, write>;
fn load_clamped(pixel: vec2i) -> vec4f {
  return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source)) - vec2i(1)), 0);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dst = vec2i(id.xy);
  if (any(dst >= vec2i(textureDimensions(destination)))) { return; }
  let src = dst * 2;
  let value = (load_clamped(src) + load_clamped(src + vec2i(0, 1)) +
    load_clamped(src + vec2i(1, 0)) + load_clamped(src + vec2i(1, 1))) * 0.25;
  textureStore(destination, dst, value);
}
`;
export const QUANTIZE_MIP5_WGSL = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rg16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= vec2i(textureDimensions(destination)))) { return; }
  let value = textureLoad(source, pixel, 0);
  textureStore(destination, pixel, vec4f(value.xy, 0.0, 0.0));
}
`;
export const FRAME_INFO_WGSL = `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var final_mip: texture_2d<f32>;
@group(0) @binding(1) var previous_frame_info: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: Fsr3Constants;
@group(0) @binding(3) var current_frame_info: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(1, 1, 1)
fn main() {
  let value = textureLoad(final_mip, vec2i(0), 0);
  var previous = textureLoad(previous_frame_info, vec2i(0), 0);
  var log_luma = value.x;
  if (previous.y < 10000.0) {
    log_luma = max(0.0, previous.y + (log_luma - previous.y) *
      (1.0 - exp(-constants.delta_time)));
  }
  let lavg = exp(log_luma);
  let iso100 = log2((lavg * 100.0) / 12.5);
  let lmax = (78.0 / (0.65 * 100.0)) * pow(2.0, iso100);
  previous.x = 1.0 / lmax;
  previous.y = log_luma;
  previous.z = value.y;
  textureStore(current_frame_info, vec2i(0), previous);
}
`;
