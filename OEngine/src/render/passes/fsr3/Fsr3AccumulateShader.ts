import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// Selected SDK 1.1.4 permutation: f32 arithmetic, HDR input, low-resolution
// motion vectors, reference Lanczos2 history sampling, approximate-squared
// Lanczos2 3x3 upsample. Source: accumulate/reproject/upsample/sample/common.
export const FSR3_ACCUMULATE_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var dilated_motion: texture_2d<f32>;
@group(0) @binding(2) var luma_instability: texture_2d<f32>;
@group(0) @binding(3) var farthest_depth_mip1: texture_2d<f32>;
@group(0) @binding(4) var dilated_reactive: texture_2d<f32>;
@group(0) @binding(5) var new_locks: texture_2d<f32>;
@group(0) @binding(6) var previous_history: texture_2d<f32>;
@group(0) @binding(7) var input_exposure: texture_2d<f32>;
@group(0) @binding(8) var linear_clamp: sampler;
@group(0) @binding(9) var<uniform> constants: Fsr3Constants;
@group(0) @binding(10) var current_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var upscaled_output: texture_storage_2d<rgba16float, write>;

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
fn lanczos2_approx_sq(x_in: f32) -> f32 {
  let x = min(x_in, 4.0);
  let a = 0.4 * x - 1.0;
  let b = 0.25 * x - 1.0;
  return (1.5625 * a * a - 0.5625) * (b * b);
}
fn history_sample(uv: vec2f) -> vec4f {
  let size = constants.previous_upscale_size;
  let sample = uv * vec2f(size) - vec2f(0.5);
  let fraction = fract(sample);
  let base = vec2i(floor(clamp(sample, vec2f(0.0), vec2f(size - vec2i(1)))));
  var rows: array<vec4f, 4>;
  var min_center = vec4f(3.402823466e+38);
  var max_center = vec4f(-3.402823466e+38);
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
      let weight = lanczos2(f32(col - 1) - fraction.x);
      weighted += weight * color;
      weight_sum += weight;
    }
    rows[row] = weighted / weight_sum;
  }
  var result = vec4f(0.0);
  var weight_sum = 0.0;
  for (var row = 0; row < 4; row++) {
    let weight = lanczos2(f32(row - 1) - fraction.y);
    result += weight * rows[row];
    weight_sum += weight;
  }
  return clamp(result / weight_sum, min_center, max_center);
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
fn upsample(pixel: vec2i, accumulation: f32, history_weight: f32,
  disocclusion: f32, shading_change: f32) -> UpsampleResult {
  let destination = vec2f(pixel) + vec2f(0.5);
  let source_position = destination * constants.downscale_factor;
  let input_position = vec2i(floor(source_position));
  let unjittered = vec2f(input_position) + vec2f(0.5) - constants.jitter_offset;
  let base_offset = unjittered - source_position;
  let flip_col = unjittered.x > source_position.x;
  let flip_row = unjittered.y > source_position.y;
  let top_left = vec2i(select(-1, -2, flip_col), select(-1, -2, flip_row));
  let initial = accumulation == 0.0;
  let kernel_max = min(1.99, 1.0 / constants.downscale_factor.x);
  let kernel_min = max(1.0, (1.0 + kernel_max) * 0.3);
  let kernel_weight = min(1.0 - disocclusion * 0.5,
    min(1.0 - shading_change, clamp(history_weight * 5.0, 0.0, 1.0)));
  let kernel_bias = mix(kernel_min, kernel_max, kernel_weight);
  var minimum = vec3f(3.402823466e+38);
  var maximum = vec3f(-3.402823466e+38);
  var center_sum = vec3f(0.0);
  var variance_sum = vec3f(0.0);
  var center_weight = 0.0;
  var color_sum = vec3f(0.0);
  var color_weight = 0.0;
  for (var row = 0; row < 3; row++) {
    for (var col = 0; col < 3; col++) {
      let sample_col = select(col, 3 - col, flip_col);
      let sample_row = select(row, 3 - row, flip_row);
      let offset = top_left + vec2i(sample_col, sample_row);
      let source_pixel = input_position + offset;
      let on_screen = all(source_pixel >= vec2i(0)) && all(source_pixel < constants.render_size);
      let clamped = clamp(source_pixel, vec2i(0), constants.render_size - vec2i(1));
      var sample = prepared_color(clamped);
      if (initial) { sample = rgb_to_ycocg(tonemap(ycocg_to_rgb(sample))); }
      minimum = min(minimum, sample);
      maximum = max(maximum, sample);
      let sample_offset = base_offset + vec2f(offset);
      let box_weight = exp(-2.3 * dot(sample_offset, sample_offset)) * select(0.0, 1.0, on_screen);
      center_sum += sample * box_weight;
      variance_sum += sample * sample * box_weight;
      center_weight += box_weight;
      if (!initial) {
        let biased = sample_offset * kernel_bias;
        let lanczos = lanczos2_approx_sq(dot(biased, biased)) * select(0.0, 1.0, on_screen);
        color_sum += sample * lanczos;
        color_weight += lanczos;
      }
    }
  }
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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= constants.upscale_size)) { return; }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.upscale_size);
  let jittered_uv = uv + constants.jitter_offset / vec2f(constants.render_size);
  let low_uv = clamp_uv(jittered_uv, constants.render_size, textureDimensions(dilated_reactive));
  let motion_pixel = vec2i(uv * vec2f(constants.render_size));
  let motion = textureLoad(dilated_motion, motion_pixel, 0).xy;
  let reprojected_uv = uv + motion;
  let existing = inside(reprojected_uv);
  let new_sample = !existing || constants.frame_index == 0.0;
  let instability_uv = clamp_uv(uv, constants.render_size, textureDimensions(luma_instability));
  let instability = textureSampleLevel(luma_instability, linear_clamp, instability_uv, 0.0).x;
  let farthest_uv = clamp_uv(jittered_uv, constants.render_size / 2,
    textureDimensions(farthest_depth_mip1));
  let farthest = textureSampleLevel(farthest_depth_mip1, linear_clamp, farthest_uv, 0.0).x;
  let masks = textureSampleLevel(dilated_reactive, linear_clamp, low_uv, 0.0);
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
  let new_lock = textureLoad(new_locks, pixel, 0).x * (1.0 - max(shading_change * 0.0, reactive));
  lock = max(0.0, min(lock + new_lock, 2.0));
  lock = max(0.0, lock - (0.1 / constants.jitter_phase_count) * (1.0 - lifetime_factor));
  lock *= select(0.0, 1.0, inside(uv - motion));
  let velocity = length(motion * vec2f(3840.0, 2160.0));
  let motion_limit = clamp(max(0.0, velocity * constants.velocity_factor / 0.5), 0.0, 1.0);
  let base_weight = min(accumulation, mix(accumulation, 0.15, motion_limit));
  var sampled = upsample(pixel, accumulation, base_weight, disocclusion, shading_change);
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
  textureStore(upscaled_output, pixel, vec4f(result, 1.0));
}
`;
