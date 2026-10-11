// Frozen production 015548a7d5707975701a844c3b06df3ba8a28303; test-only.
/** Native-resolution temporal execution, retaining the SDK 1.1.4 reconstruction,
 * locks, four-frame luminance response, sixteen-point history and RCAS contract.
 * Native receiver classification and fused reconstruction are local
 * execution adaptations of AMD c6efa6bf7f2027b3ec94f28578bb5965eabb9e55.
 *
 * MIT License
 *
 * Copyright (C) 2024 Advanced Micro Devices, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "../../../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
// Two sets of nine f32 weights, each padded to three uniform vec4s.
export const NATIVE_TEMPORAL_FILTER_WEIGHTS_BYTES = 2 * 3 * 16;
const NATIVE_CONSTANTS = FSR3_UPSCALER_CONSTANTS_WGSL +
    `
@group(0) @binding(0) var<uniform> constants: Fsr3Constants;
struct NativeFilterWeights {
  gaussian: array<vec4f, 3>,
  reconstruction: array<vec4f, 3>,
};
`;
// The native-only 3x3 domain is fixed. Emit each tap in its own scope, with
// constant uniform addresses; dynamic array indexing regressed on the target.
const NATIVE_CURRENT_TAPS_WGSL = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const component = (field, r, c) => {
        const i = r * 3 + c;
        return `filter_weights.${field}[${Math.floor(i / 4)}].${"xyzw"[i % 4]}`;
    };
    const weight = (field) => {
        const atRow = (r) => col === 1
            ? component(field, r, col)
            : `select(${component(field, r, col)}, ${component(field, r, 2 - col)}, flip_col)`;
        return row === 1 ? atRow(row) : `select(${atRow(row)}, ${atRow(2 - row)}, flip_row)`;
    };
    const coordinate = (value, flip) => value === 1 ? "0" : `select(${value - 1}, ${1 - value}, ${flip})`;
    return `
  {
    let offset = vec2i(${coordinate(col, "flip_col")}, ${coordinate(row, "flip_row")});
    let source = pixel + offset;
    let on_screen = all(source >= vec2i(0)) && all(source < constants.render_size);
    let clamped = clamp(source, vec2i(0), constants.render_size - vec2i(1));
    var sample = prepared_color(clamped);
    if (initial) { sample = rgb_to_ycocg(tonemap(ycocg_to_rgb(sample))); }
    minimum = min(minimum, sample);
    maximum = max(maximum, sample);
    let box_weight = ${weight("gaussian")} * select(0.0, 1.0, on_screen);
    center_sum += sample * box_weight;
    variance_sum += sample * sample * box_weight;
    center_weight += box_weight;
    if (!initial) {
      let weight = ${weight("reconstruction")} * select(0.0, 1.0, on_screen);
      color_sum += sample * weight;
      color_weight += weight;
    }
  }`;
}).join("\n");
export const NATIVE_TEMPORAL_CLASSIFY_WGSL = NATIVE_CONSTANTS +
    `
@group(0) @binding(1) var<storage, read> reconstructed_depth: array<u32>;
@group(0) @binding(2) var dilated_motion: texture_2d<f32>;
@group(0) @binding(3) var dilated_depth: texture_2d<f32>;
@group(0) @binding(4) var reactive_mask: texture_2d<f32>;
@group(0) @binding(5) var temporal_mask: texture_2d<f32>;
@group(0) @binding(6) var classified_masks: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(7) var shading_change: texture_2d<f32>;
@group(0) @binding(8) var previous_accumulation: texture_2d<f32>;
@group(0) @binding(9) var linear_clamp: sampler;
@group(0) @binding(10) var current_accumulation: texture_storage_2d<r8unorm, write>;
@group(0) @binding(11) var<storage, read_write> filter_weights: NativeFilterWeights;
fn clamp_load(pixel: vec2i, offset: vec2i, size: vec2i) -> vec2i {
  return clamp(pixel + offset, vec2i(0), size - vec2i(1));
}
fn clamp_uv(uv: vec2f, active_size: vec2i, resource_size: vec2u) -> vec2f {
  return clamp(uv * vec2f(active_size), vec2f(0.5), vec2f(active_size) - vec2f(0.5)) /
    vec2f(resource_size);
}
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}
fn view_depth(device_depth: f32) -> f32 {
  return constants.device_to_view_depth.y /
    (device_depth - constants.device_to_view_depth.x);
}
fn velocity_4k(motion: vec2f) -> f32 {
  return length(motion * vec2f(3840.0, 2160.0));
}
fn min_divided_by_max(a: f32, b: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return 0.0;
}

fn compute_disocclusion(uv: vec2f, motion: vec2f, current_view_depth: f32) -> f32 {
  let nearest_meters = min(current_view_depth * constants.view_space_to_meters_factor, 65504.0);
  let threshold = mix(0.25, 0.75, clamp(nearest_meters / 100.0, 0.0, 1.0));
  var reprojection_motion = motion;
  if (velocity_4k(motion) <= threshold) { reprojection_motion = vec2f(0.0); }
  let sample = (uv + reprojection_motion) * vec2f(constants.render_size) - vec2f(0.5);
  let base = vec2i(floor(sample));
  let fraction = fract(sample);
  let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  let weights = array<f32, 4>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  var disocclusion = 0.0;
  var weight_sum = 0.0;
  var potential = true;
  for (var i = 0; i < 4 && potential; i++) {
    let sample_pos = clamp_load(base, offsets[i], constants.render_size);
    let weight = weights[i];
    if (weight > 0.0006100000) {
      let index = u32(sample_pos.y * constants.render_size.x + sample_pos.x);
      let previous_view_depth = view_depth(bitcast<f32>(reconstructed_depth[index]));
      let depth_difference = current_view_depth - previous_view_depth;
      potential = potential && depth_difference > 1.175494351e-38;
      if (potential) {
        let half_viewport_width = length(vec2f(constants.render_size) * 0.5);
        let depth_threshold = max(current_view_depth, previous_view_depth);
        let required_separation = 1.37e-05 * half_viewport_width * depth_threshold;
        disocclusion += clamp(required_separation / depth_difference, 0.0, 1.0) * weight;
        weight_sum += weight;
      }
    }
  }
  if (potential && weight_sum > 0.0) {
    return clamp(1.0 - disocclusion / weight_sum, 0.0, 1.0);
  }
  return 0.0;
}

fn motion_divergence(uv: vec2f, motion: vec2f, current_depth: f32) -> f32 {
  let reprojected = vec2i((uv + motion) * vec2f(constants.render_size));
  let other_depth = textureLoad(dilated_depth, reprojected, 0).x;
  let other_motion = textureLoad(dilated_motion, reprojected, 0).xy;
  let other_velocity = velocity_4k(other_motion);
  let velocity = velocity_4k(motion);
  if (velocity == 0.0) {
    return 0.0;
  }
  let distance_factor = min_divided_by_max(
    view_depth(other_depth) * constants.view_space_to_meters_factor,
    view_depth(current_depth) * constants.view_space_to_meters_factor);
  return (1.0 - clamp(other_velocity / velocity, 0.0, 1.0)) *
    distance_factor * clamp(velocity / 10.0, 0.0, 1.0);
}

fn dilate_reactive(pixel: vec2i) -> f32 {
  var result = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let sample = clamp_load(pixel, vec2i(x, y), constants.render_size);
      result = max(result, textureLoad(reactive_mask, sample, 0).x * constants.reactiveness_scale);
    }
  }
  return result;
}


@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let pixel = vec2i(id.xy);
    if (any(pixel >= constants.render_size)) { return; }
    if (all(pixel == vec2i(0))) {
      for (var block = 0u; block < 3u; block++) {
        filter_weights.gaussian[block] = vec4f(0.0);
        filter_weights.reconstruction[block] = vec4f(0.0);
      }
      for (var i = 0u; i < 9u; i++) {
        let offset = vec2f(vec2i(i32(i % 3u) - 1, i32(i / 3u) - 1)) - constants.jitter_offset;
        let distance_squared = dot(offset, offset);
        filter_weights.gaussian[i / 4u][i % 4u] = exp(-2.3 * distance_squared);
        let distance = min(distance_squared, 4.0);
        let a = 0.4 * distance - 1.0;
        let b = 0.25 * distance - 1.0;
        filter_weights.reconstruction[i / 4u][i % 4u] =
          (1.5625 * a * a - 0.5625) * (b * b);
      }
    }
    let uv = (vec2f(pixel) + 0.5) / vec2f(constants.render_size);
    let motion = textureLoad(dilated_motion, pixel, 0).xy;
    let depth = textureLoad(dilated_depth, pixel, 0).x;
    let facts = textureLoad(temporal_mask, pixel, 0);
    let invalid = facts.y < 0.5 || facts.z > 0.5;
    let disocclusion = max(compute_disocclusion(uv, motion, view_depth(depth)), select(0.0, 1.0, invalid));
    let shade_uv = clamp_uv(uv - constants.jitter_offset / vec2f(constants.render_size),
      constants.render_size / 2, textureDimensions(shading_change));
    let change = max(dilate_reactive(pixel), clamp(textureSampleLevel(
      shading_change, linear_clamp, shade_uv, 0.0).x * constants.shading_change_scale, 0.0, 1.0));
    var accumulation = 0.0;
    if (inside(uv + motion)) {
      let previous_uv = clamp_uv(uv + motion, constants.previous_render_size,
        textureDimensions(previous_accumulation));
      accumulation = clamp(textureSampleLevel(previous_accumulation, linear_clamp,
        previous_uv, 0.0).x, 0.0, 1.0);
    }
    accumulation = mix(accumulation, 0.0, change);
    accumulation = mix(accumulation, min(constants.min_disocclusion_accumulation, accumulation), disocclusion);
    accumulation *= select(0.0, 1.0, round(accumulation * 100.0) > 1.0);
    textureStore(current_accumulation, pixel, vec4f(clamp(accumulation +
      constants.accumulation_added_per_frame, 0.0, 1.0), 0.0, 0.0, 0.0));
    let reactive = motion_divergence(uv, motion, depth);
    // Preserve the original RGBA8 boundary AFTER full-precision confidence.
    textureStore(classified_masks, pixel, vec4f(reactive, disocclusion, change, accumulation));
}
`;
export const NATIVE_TEMPORAL_RESOLVE_WGSL = NATIVE_CONSTANTS +
    `

@group(0) @binding(1) var input_color: texture_2d<f32>;
@group(0) @binding(2) var dilated_motion: texture_2d<f32>;
@group(0) @binding(3) var classified_masks: texture_2d<f32>;
@group(0) @binding(4) var previous_history: texture_2d<f32>;
@group(0) @binding(5) var linear_clamp: sampler;
@group(0) @binding(6) var current_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var input_exposure: texture_2d<f32>;
@group(0) @binding(10) var current_luma: texture_2d<f32>;
@group(0) @binding(11) var previous_luma_history: texture_2d<f32>;
@group(0) @binding(13) var output_luma_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(14) var farthest_depth_mip1: texture_2d<f32>;
@group(0) @binding(15) var<uniform> filter_weights: NativeFilterWeights;
fn exposure() -> f32 {
  let value = textureLoad(input_exposure, vec2i(0), 0).x;
  if (value == 0.0) { return 1.0; }
  return value;
}
fn clamp_uv(uv: vec2f, active_size: vec2i, resource_size: vec2u) -> vec2f {
  return clamp(uv * vec2f(active_size), vec2f(0.5), vec2f(active_size) - vec2f(0.5)) /
    vec2f(resource_size);
}
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}
fn rgb_to_ycocg(rgb: vec3f) -> vec3f {
  return vec3f(0.25 * rgb.r + 0.5 * rgb.g + 0.25 * rgb.b,
    0.5 * rgb.r - 0.5 * rgb.b,
    -0.25 * rgb.r + 0.5 * rgb.g - 0.25 * rgb.b);
}
fn ycocg_to_rgb(color: vec3f) -> vec3f {
  return vec3f(color.x + color.y - color.z, color.x + color.z,
    color.x - color.y - color.z);
}
fn tonemap(rgb: vec3f) -> vec3f {
  return rgb / (max(max(0.0, rgb.r), max(rgb.g, rgb.b)) + 1.0);
}
fn inverse_tonemap(rgb: vec3f) -> vec3f {
  return rgb / max(0.000061, 1.0 - max(rgb.r, max(rgb.g, rgb.b)));
}
fn lanczos2(x_in: f32) -> f32 {
  let x = min(abs(x_in), 2.0);
  if (abs(x) < 0.000061) { return 1.0; }
  let pi = 3.141592653589793;
  return sin(pi * x) / (pi * x) * sin(0.5 * pi * x) / (0.5 * pi * x);
}
fn history_sample(uv: vec2f) -> vec4f {
  let size = constants.previous_upscale_size;
  let sample = uv * vec2f(size) - vec2f(0.5);
  let fraction = fract(sample);
  let base = vec2i(floor(clamp(sample, vec2f(0.0), vec2f(size - vec2i(1)))));
  // Exact texel-center support: Lanczos(integer) is zero except L(0)=1.
  // No motion epsilon or shortened fractional-position filter is used.
  if (all(fraction == vec2f(0.0))) {
    return textureLoad(previous_history, base, 0);
  }
  let column_weights = vec4f(
    lanczos2(-1.0 - fraction.x), lanczos2(-fraction.x),
    lanczos2(1.0 - fraction.x), lanczos2(2.0 - fraction.x));
  var min_center = vec4f(3.402823466e+38);
  var max_center = vec4f(-3.402823466e+38);
  var result = vec4f(0.0);
  var row_weight_sum = 0.0;
  for (var row = 0; row < 4; row++) {
    var weighted = vec4f(0.0);
    var weight_sum = 0.0;
    for (var col = 0; col < 4; col++) {
      let pixel = clamp(base + vec2i(col - 1, row - 1), vec2i(0), size - vec2i(1));
      let color = textureLoad(previous_history, pixel, 0);
      if (row >= 1 && row <= 2 && col >= 1 && col <= 2) {
        min_center = min(min_center, color);
        max_center = max(max_center, color);
      }
      let weight = column_weights[col];
      weighted += weight * color;
      weight_sum += weight;
    }
    let weight = lanczos2(f32(row - 1) - fraction.y);
    result += weight * (weighted / weight_sum);
    row_weight_sum += weight;
  }
  return clamp(result / row_weight_sum, min_center, max_center);
}

struct RectificationBox {
  center: vec3f,
  variance: vec3f,
  minimum: vec3f,
  maximum: vec3f,
};
struct UpsampleResult {
  color: vec3f,
  weight: f32,
  history_weight: f32,
  box: RectificationBox,
};
fn prepared_color(pixel: vec2i) -> vec3f {
  return rgb_to_ycocg(max(vec3f(0.0), textureLoad(input_color, pixel, 0).rgb) * exposure());
}
fn upsample(pixel: vec2i, accumulation: f32, history_weight: f32) -> UpsampleResult {
  // Only actual 1:1 frames use this pipeline. The SDK's kernelMin/Max/Bias
  // all equal one; both 3x3 weight sets are spatially invariant this frame.
  let flip_col = constants.jitter_offset.x < 0.0;
  let flip_row = constants.jitter_offset.y < 0.0;
  let initial = accumulation == 0.0;
  var minimum = vec3f(3.402823466e+38);
  var maximum = vec3f(-3.402823466e+38);
  var center_sum = vec3f(0.0);
  var variance_sum = vec3f(0.0);
  var center_weight = 0.0;
  var color_sum = vec3f(0.0);
  var color_weight = 0.0;
${NATIVE_CURRENT_TAPS_WGSL}
  if (abs(center_weight) <= 1.175494351e-38) { center_weight = 1.0; }
  let center = center_sum / center_weight;
  let variance = sqrt(abs(variance_sum / center_weight - center * center));
  let box = RectificationBox(center, variance, minimum, maximum);
  var color = vec3f(0.0);
  var weight = color_weight * select(0.0, 1.0, color_weight > 0.000061);
  var out_history_weight = history_weight;
  if (weight > 0.000061) {
    color = clamp(color_sum / weight, minimum, maximum);
    weight *= 0.74 / 16.0;
  }
  if (initial) {
    color = rgb_to_ycocg(inverse_tonemap(ycocg_to_rgb(center)));
    weight = 1.0;
    out_history_weight = 0.0;
  }
  return UpsampleResult(color, weight, out_history_weight, box);
}

fn thin_feature_confidence(pixel: vec2i) -> f32 {
  let offsets = array<vec2i, 9>(
    vec2i(0, 0), vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
    vec2i(-1, 0), vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1));
  var samples: array<f32, 9>;
  var luma_min = 3.402823466e+38;
  var luma_max = 1.175494351e-38;
  for (var i = 0; i < 9; i++) {
    let source = clamp(pixel + offsets[i], vec2i(0), constants.render_size - vec2i(1));
    samples[i] = textureLoad(current_luma, source, 0).x * exposure();
    luma_min = min(luma_min, samples[i]);
    luma_max = max(luma_max, samples[i]);
  }
  var dissimilar_min = 3.402823466e+38;
  var dissimilar_max = 0.0;
  var pattern = 1u;
  for (var i = 1; i < 9; i++) {
    let difference = abs(samples[i] - samples[0]) / (luma_max - luma_min);
    if (difference < 0.9) {
      pattern |= 1u << u32(i);
    } else {
      dissimilar_min = min(dissimilar_min, samples[i]);
      dissimilar_max = max(dissimilar_max, samples[i]);
    }
  }
  if (!(samples[0] > dissimilar_max || samples[0] < dissimilar_min)) { return 0.0; }
  let masks = array<u32, 4>(
    (1u << 1u) | (1u << 2u) | (1u << 4u) | 1u,
    (1u << 2u) | (1u << 3u) | (1u << 5u) | 1u,
    (1u << 4u) | (1u << 6u) | (1u << 7u) | 1u,
    (1u << 5u) | (1u << 7u) | (1u << 8u) | 1u);
  for (var i = 0; i < 4; i++) {
    if ((pattern & masks[i]) == masks[i]) { return 0.0; }
  }
  return 1.0 - luma_min / luma_max;
}

fn native_thin_feature(pixel: vec2i) -> f32 {
  // Invert PrepareReactivity's original producer-to-output lock mapping.
  let producer = pixel - vec2i(floor(vec2f(0.5) - constants.jitter_offset));
  if (any(producer < vec2i(0)) || any(producer >= constants.render_size)) {
    return 0.0;
  }
  return thin_feature_confidence(producer);
}

struct InstabilityData {
  history: vec4f,
  factor: f32,
};

fn compute_instability(history_in: vec4f, current: f32) -> InstabilityData {
  var history = history_in;
  let diff0 = current - history[0];
  let similarity0 = native_similarity(current, history[0], 1.0);
  var max_similarity = similarity0;
  var instability = 0.0;
  if (similarity0 < 1.0) {
    for (var i = 1; i <= 3; i++) {
      let diff1 = current - history[i];
      let similarity1 = native_similarity(current, history[i], 0.0);
      if (sign(diff0) == sign(diff1)) {
        max_similarity = max(max_similarity, similarity1);
      }
    }
    if (max_similarity > similarity0) { instability = 1.0; }
  }
  history[3] = history[2];
  history[2] = history[1];
  history[1] = history[0];
  history[0] = current;
  history /= exposure();
  var factor = 0.0;
  if (history[3] != 0.0) { factor = instability; }
  return InstabilityData(history, factor);
}


fn native_similarity(a: f32, b: f32, zero: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return zero;
}
fn native_instability(pixel: vec2i, uv: vec2f, motion: vec2f, masks: vec4f) -> f32 {
  var data = InstabilityData(vec4f(0.0), 0.0);
  let reprojection = uv + constants.previous_jitter_offset /
    vec2f(constants.previous_render_size) + motion;
  if (constants.frame_index != 0.0 && inside(reprojection) && masks.w > 0.9) {
    let current_uv = clamp_uv(uv + constants.jitter_offset / vec2f(constants.render_size),
      constants.render_size, textureDimensions(current_luma));
    let current = textureSampleLevel(current_luma, linear_clamp, current_uv, 0.0).x * exposure();
    let history_uv = clamp_uv(reprojection, constants.previous_render_size,
      textureDimensions(previous_luma_history));
    let history = textureSampleLevel(previous_luma_history, linear_clamp, history_uv, 0.0) *
      constants.delta_pre_exposure * exposure();
    data = compute_instability(history, current);
    let velocity_weight = 1.0 - clamp(length(motion * vec2f(3840.0, 2160.0)) / 20.0, 0.0, 1.0);
    data.factor *= velocity_weight * (1.0 - masks.y) * (1.0 - masks.x) * (1.0 - masks.z);
  }
  textureStore(output_luma_history, pixel, data.history);
  // Preserve the removed R16Float instability write/load boundary.
  return unpack2x16float(pack2x16float(vec2f(data.factor, 0.0))).x;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= constants.upscale_size)) { return; }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.upscale_size);
  let jittered_uv = uv + constants.jitter_offset / vec2f(constants.render_size);
  let motion_pixel = vec2i(uv * vec2f(constants.render_size));
  let motion = textureLoad(dilated_motion, motion_pixel, 0).xy;
  let reprojected_uv = uv + motion;
  let existing = inside(reprojected_uv);
  let new_sample = !existing || constants.frame_index == 0.0;
  let masks_uv = clamp_uv(jittered_uv, constants.render_size, textureDimensions(classified_masks));
  let masks = textureSampleLevel(classified_masks, linear_clamp, masks_uv, 0.0);
  let instability = native_instability(pixel, uv, motion, masks);
  let farthest_uv = clamp_uv(jittered_uv, constants.render_size / 2,
    textureDimensions(farthest_depth_mip1));
  let farthest = textureSampleLevel(farthest_depth_mip1, linear_clamp, farthest_uv, 0.0).x;

  let reactive = clamp(masks.x, 0.0, 1.0);
  let disocclusion = clamp(masks.y, 0.0, 1.0);
  let shading_change = clamp(masks.z, 0.0, 1.0);
  var accumulation = clamp(masks.w, 0.0, 1.0);
  accumulation *= select(0.0, 1.0, round(accumulation * 100.0) > 1.0);
  var history_color = vec3f(0.0);
  var lock = 0.0;
  if (existing && !new_sample) {
    let old = history_sample(reprojected_uv);
    history_color = rgb_to_ycocg(old.rgb * constants.delta_pre_exposure * exposure());
    lock = old.a;
  }
  lock *= select(0.0, 1.0, !new_sample);
  let lifetime_factor = max(clamp(shading_change, 0.0, 1.0), max(reactive, disocclusion));
  lock = max(0.0, lock - lifetime_factor * 2.0);
  let lock_contribution = clamp(clamp(lock - 1.0, 0.0, 1.0) * (2.0 - 1.0), 0.0, 1.0);
  let velocity = length(motion * vec2f(3840.0, 2160.0));
  let motion_limit = clamp(max(0.0, velocity * constants.velocity_factor / 0.5), 0.0, 1.0);
  let base_weight = min(accumulation, mix(accumulation, 0.15, motion_limit));
  var sampled = upsample(pixel, accumulation, base_weight);
  let thin = native_thin_feature(pixel);
  let new_lock = select(0.0, round(clamp(thin, 0.0, 1.0) * 255.0) / 255.0, thin > 0.01) * (1.0 - reactive);
  lock = max(0.0, min(lock + new_lock, 2.0));
  lock = max(0.0, lock - (0.1 / constants.jitter_phase_count) * (1.0 - lifetime_factor));
  lock *= select(0.0, 1.0, inside(uv - motion));

  let box_scale_t = max(clamp(velocity / 20.0, 0.0, 1.0),
    max(clamp(0.75 - farthest / 20.0, 0.0, 1.0),
      max(1.0 - accumulation, max(pow(reactive, 0.5), shading_change))));
  let box_scale = mix(3.0, 1.0, box_scale_t);
  let scaled_box = sampled.box.variance * vec3f(1.7, 1.0, 1.0) * box_scale;
  let transformed = (history_color - sampled.box.center) / max(scaled_box, vec3f(1.193e-7));
  if (length(transformed) > 1.0) {
    let clamped_history = normalize(transformed) * scaled_box + sampled.box.center;
    let contribution = max(instability, lock_contribution) * accumulation * (1.0 - disocclusion);
    history_color = mix(clamped_history, history_color, clamp(contribution, 0.0, 1.0));
  }
  sampled.history_weight *= select(0.0, 1.0, sampled.history_weight > 0.000061);
  let total_weight = max(0.000061, sampled.history_weight + sampled.weight);
  let upsampled_tonemapped = rgb_to_ycocg(tonemap(ycocg_to_rgb(sampled.color)));
  let history_tonemapped = rgb_to_ycocg(tonemap(ycocg_to_rgb(history_color)));
  let alpha = clamp(sampled.weight / total_weight, 0.0, 1.0);
  let mixed_ycocg = mix(history_tonemapped, upsampled_tonemapped, alpha);
  let result = max(vec3f(0.0), inverse_tonemap(ycocg_to_rgb(mixed_ycocg)) / exposure());
  textureStore(current_history, pixel, vec4f(result, lock));
}
`;
