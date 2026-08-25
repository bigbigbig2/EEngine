/**
 * nss：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const NSS_SETTINGS_WGSL = /* wgsl */ `
struct NssSettings {
  jitter: vec2<f32>,
  render_resolution: vec2<u32>,
  output_resolution: vec2<u32>,
  jitter_tile_offset: vec2<u32>,
  history_validity: f32,
  upscale_ratio: f32,
  frame_index: u32,
  alpha_blend_scale: f32,
  theta_override: f32,
  debug_view: u32,
  network_acc_scale: f32,
  feedback_scale: f32,
  quantize_inputs: f32,
  _padding: f32,
  jitter_sign: vec2<f32>,
};
`;

export const NSS_CONCAT_WGSL = /* wgsl */ `
struct ConcatSettings { split_groups: u32 };
@group(0) @binding(0) var tA: texture_3d<f32>;
@group(0) @binding(1) var tB: texture_3d<f32>;
@group(0) @binding(2) var chunk_sh2: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> settings: ConcatSettings;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimensions = textureDimensions(chunk_sh2);
  if (any(gid >= dimensions)) { return; }
  let xy = vec2<i32>(gid.xy);
  let z = gid.z;
  var value: vec4<f32>;
  if (z < settings.split_groups) {
    value = textureLoad(tA, vec3<i32>(xy, i32(z)), 0);
  } else {
    value = textureLoad(tB, vec3<i32>(xy, i32(z - settings.split_groups)), 0);
  }
  textureStore(chunk_sh2, vec3<i32>(xy, i32(z)), value);
}
`;

export const NSS_LAYER_WGSL = /* wgsl */ `
${NSS_SETTINGS_WGSL}
struct NssLayerConfig {
  in_channels: u32,
  out_channels: u32,
  kernel_size: u32,
  weights_offset: u32,
  bias_offset: u32,
  rescale_offset: u32,
  lut_offset: u32,
  activation_kind: u32,
  output_layer_offset: u32,
  has_bias: u32,
  has_lut: u32,
  output_zp: i32,
};
@group(0) @binding(0) var this_hit: texture_3d<f32>;
@group(0) @binding(1) var chunk_sh2: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> weights: array<u32>;
@group(0) @binding(3) var<storage, read> leaf_count: array<f32>;
@group(0) @binding(4) var<storage, read> rescales: array<f32>;
@group(0) @binding(5) var<storage, read> new_solution: array<u32>;
@group(0) @binding(6) var<uniform> layer_config: NssLayerConfig;
@group(0) @binding(7) var<uniform> settings: NssSettings;

fn nss_activation(value: vec4<f32>, activation: u32) -> vec4<f32> {
  if (activation == 1u) { return max(vec4<f32>(0.0), value); }
  if (activation == 2u) {
    return select(value, 0.1 * value, value < vec4<f32>(0.0));
  }
  return value;
}

fn nss_load_input_pixel(position: vec2<i32>, group: u32) -> vec4<f32> {
  let dimensions = textureDimensions(this_hit);
  let clamped = clamp(position, vec2<i32>(0), vec2<i32>(dimensions.xy) - vec2<i32>(1));
  return textureLoad(this_hit, vec3<i32>(clamped, i32(group)), 0);
}

fn nss_apply_lut(value: f32, lut_offset: u32, output_zp: i32) -> f32 {
  let quantized = i32(round(value * 127.0));
  let cursor = clamp(quantized + output_zp, -128, 127);
  let index = u32(cursor + 128);
  let packed = unpack4xI8(new_solution[lut_offset + index / 4u]);
  let lane = index % 4u;
  let result = max(packed[lane], -127);
  return f32(result + 127) / 255.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimensions = textureDimensions(chunk_sh2);
  let output_groups = layer_config.out_channels / 4u;
  if (any(gid.xy >= dimensions.xy) || gid.z >= output_groups) { return; }

  let input_groups = layer_config.in_channels / 4u;
  let radius = i32(layer_config.kernel_size) / 2;
  let weights_per_input_group = layer_config.kernel_size * input_groups;
  let weights_per_output_channel = layer_config.kernel_size * weights_per_input_group;
  let xy = vec2<i32>(gid.xy);
  let output_group = gid.z;
  let output_channel = output_group * 4u;

  var accumulator = vec4<f32>(0.0);
  if (layer_config.has_bias != 0u) {
    accumulator = vec4<f32>(
      leaf_count[layer_config.bias_offset + output_channel + 0u],
      leaf_count[layer_config.bias_offset + output_channel + 1u],
      leaf_count[layer_config.bias_offset + output_channel + 2u],
      leaf_count[layer_config.bias_offset + output_channel + 3u]
    );
  }

  for (var ky = 0u; ky < layer_config.kernel_size; ky++) {
    for (var kx = 0u; kx < layer_config.kernel_size; kx++) {
      let source_xy = xy + vec2<i32>(i32(kx) - radius, i32(ky) - radius);
      for (var input_group = 0u; input_group < input_groups; input_group++) {
        let input_value = nss_load_input_pixel(source_xy, input_group);
        let base = layer_config.weights_offset
          + ky * weights_per_input_group
          + kx * input_groups
          + input_group;
        let stride = weights_per_output_channel;
        accumulator.x += dot(input_value, unpack4x8snorm(weights[base + (output_channel + 0u) * stride]));
        accumulator.y += dot(input_value, unpack4x8snorm(weights[base + (output_channel + 1u) * stride]));
        accumulator.z += dot(input_value, unpack4x8snorm(weights[base + (output_channel + 2u) * stride]));
        accumulator.w += dot(input_value, unpack4x8snorm(weights[base + (output_channel + 3u) * stride]));
      }
    }
  }

  let scale = vec4<f32>(
    rescales[layer_config.rescale_offset + output_channel + 0u],
    rescales[layer_config.rescale_offset + output_channel + 1u],
    rescales[layer_config.rescale_offset + output_channel + 2u],
    rescales[layer_config.rescale_offset + output_channel + 3u]
  );
  let normalized = clamp(
    accumulator * scale * settings.network_acc_scale,
    vec4<f32>(-1.0),
    vec4<f32>(1.0)
  );
  var result: vec4<f32>;
  if (layer_config.has_lut != 0u) {
    result = vec4<f32>(
      nss_apply_lut(normalized.x, layer_config.lut_offset, layer_config.output_zp),
      nss_apply_lut(normalized.y, layer_config.lut_offset, layer_config.output_zp),
      nss_apply_lut(normalized.z, layer_config.lut_offset, layer_config.output_zp),
      nss_apply_lut(normalized.w, layer_config.lut_offset, layer_config.output_zp)
    );
  } else {
    result = nss_activation(normalized, layer_config.activation_kind);
  }
  textureStore(
    chunk_sh2,
    vec3<i32>(xy, i32(layer_config.output_layer_offset + output_group)),
    result
  );
}
`;

export const NSS_COPY_FEEDBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var e: texture_3d<f32>;
@group(0) @binding(1) var px_sample_probe_index: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dimensions = textureDimensions(px_sample_probe_index);
  if (any(gid.xy >= dimensions)) { return; }
  let xy = vec2<i32>(gid.xy);
  textureStore(px_sample_probe_index, xy, textureLoad(e, vec3<i32>(xy, 0), 0));
}
`;

const NSS_COMMON_WGSL = /* wgsl */ `
${NSS_SETTINGS_WGSL}
fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn rgb_to_luminance(value: vec3<f32>) -> f32 {
  return dot(value, vec3<f32>(0.2126, 0.7152, 0.0722));
}
`;

export const NSS_PREPROCESS_WGSL = /* wgsl */ `
${NSS_COMMON_WGSL}
@group(0) @binding(0) var segment_height: sampler;
@group(0) @binding(1) var scale: texture_2d<f32>;
@group(0) @binding(2) var l2: texture_2d<f32>;
@group(0) @binding(3) var header: texture_2d<f32>;
@group(0) @binding(4) var loading_overlay_mode: texture_2d<f32>;
@group(0) @binding(5) var mean: texture_2d<f32>;
@group(0) @binding(6) var view: texture_2d<f32>;
@group(0) @binding(7) var<uniform> settings: NssSettings;
@group(0) @binding(8) var results: texture_storage_3d<rgba16float, write>;
@group(0) @binding(9) var b2: texture_storage_2d<rg8unorm, write>;

fn in_bounds(position: vec2<i32>, dimensions: vec2<i32>) -> bool {
  return all(position >= vec2<i32>(0)) && all(position < dimensions);
}

fn nss_find_nearest_depth(
  depth_texture: texture_2d<f32>,
  position: vec2<i32>,
  dimensions: vec2<i32>,
  nearest_offset: ptr<function, vec2<i32>>
) -> f32 {
  const offsets = array<vec2<i32>, 9>(
    vec2<i32>(0, 0), vec2<i32>(1, 0), vec2<i32>(0, 1),
    vec2<i32>(0, -1), vec2<i32>(-1, 0), vec2<i32>(-1, 1),
    vec2<i32>(1, 1), vec2<i32>(-1, -1), vec2<i32>(1, -1)
  );
  var best_offset = vec2<i32>(0);
  var best_depth = textureLoad(depth_texture, position, 0).r;
  for (var index = 1; index < 9; index++) {
    let sample_position = position + offsets[index];
    if (in_bounds(sample_position, dimensions)) {
      let depth = textureLoad(depth_texture, sample_position, 0).r;
      if (depth > best_depth) {
        best_offset = offsets[index];
        best_depth = depth;
      }
    }
  }
  *nearest_offset = best_offset;
  return best_depth;
}

fn nss_luma_derivative(current: vec3<f32>, history: vec3<f32>) -> f32 {
  let current_luma = rgb_to_luminance(current);
  let history_luma = rgb_to_luminance(history);
  let current_mapped = current_luma / (1.0 + current_luma);
  let history_mapped = history_luma / (1.0 + history_luma);
  return saturate(abs(current_mapped - history_mapped) * 4.0);
}

const NSS_EXPOSURE: f32 = 7.38905609893;
fn nss_tonemap_exposure(value: vec3<f32>) -> vec3<f32> {
  let exposed = value * NSS_EXPOSURE;
  return exposed / (1.0 + max(max(exposed.r, exposed.g), exposed.b));
}
fn nss_arm_quantize(value: f32) -> f32 {
  return clamp(value * (255.0 / 127.0) - (128.0 / 127.0), -1.0, 1.0);
}
fn nss_arm_quantize_v3(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(nss_arm_quantize(value.r), nss_arm_quantize(value.g), nss_arm_quantize(value.b));
}
fn nss_arm_quantize_v4(value: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(nss_arm_quantize(value.x), nss_arm_quantize(value.y), nss_arm_quantize(value.z), nss_arm_quantize(value.w));
}
fn nss_warp_history_sample(uv: vec2<f32>) -> vec3<f32> {
  if (!all(uv >= vec2<f32>(0.0)) || !all(uv <= vec2<f32>(1.0))) { return vec3<f32>(0.0); }
  return max(vec3<f32>(0.0), textureSampleLevel(mean, segment_height, uv, 0.0).rgb);
}
fn nss_warp_feedback_sample(uv: vec2<f32>) -> vec4<f32> {
  if (!all(uv >= vec2<f32>(0.0)) || !all(uv <= vec2<f32>(1.0))) { return vec4<f32>(0.0); }
  return textureSampleLevel(view, segment_height, uv, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let render_resolution = settings.render_resolution;
  if (any(gid.xy >= render_resolution)) { return; }
  let position = vec2<i32>(gid.xy);
  let dimensions = vec2<i32>(render_resolution);
  var nearest_offset = vec2<i32>(0);
  _ = nss_find_nearest_depth(l2, position, dimensions, &nearest_offset);
  let velocity = textureLoad(header, position + nearest_offset, 0).rg;
  let source_position = vec2<f32>(position) + 0.5 - velocity;
  let history_uv = source_position / vec2<f32>(dimensions);
  let history = nss_warp_history_sample(history_uv);
  let disocclusion = textureLoad(loading_overlay_mode, position, 0).r;
  let history_validity = (1.0 - saturate(disocclusion)) * saturate(settings.history_validity);
  let feedback = nss_warp_feedback_sample(history_uv);
  let feedback_input = mix(
    vec4<f32>(0.5),
    feedback,
    saturate(settings.history_validity) * saturate(settings.feedback_scale)
  );
  let current = max(vec3<f32>(0.0), textureLoad(scale, position, 0).rgb);
  let derivative = nss_luma_derivative(current, history);
  let mapped_history = nss_tonemap_exposure(history);
  let mapped_current = nss_tonemap_exposure(current);
  let quantize = saturate(settings.quantize_inputs);
  let q_history = mix(mapped_history, nss_arm_quantize_v3(mapped_history), quantize);
  let q_current = mix(mapped_current, nss_arm_quantize_v3(mapped_current), quantize);
  let q_validity = mix(history_validity, nss_arm_quantize(history_validity), quantize);
  let q_feedback = mix(feedback_input, nss_arm_quantize_v4(feedback_input), quantize);
  let q_derivative = mix(derivative, nss_arm_quantize(derivative), quantize);
  textureStore(results, vec3<i32>(position, 0), vec4<f32>(q_history, q_current.r));
  textureStore(results, vec3<i32>(position, 1), vec4<f32>(q_current.g, q_current.b, q_validity, q_feedback.r));
  textureStore(results, vec3<i32>(position, 2), vec4<f32>(q_feedback.gba, q_derivative));
  let encoded_offset = (vec2<f32>(nearest_offset) + 1.0) * 0.5;
  textureStore(b2, position, vec4<f32>(encoded_offset, 0.0, 0.0));
}
`;

export const NSS_RESOLVE_WGSL = /* wgsl */ `
${NSS_COMMON_WGSL}
@group(0) @binding(0) var segment_height: sampler;
@group(0) @binding(1) var e: texture_3d<f32>;
@group(0) @binding(2) var scale: texture_2d<f32>;
@group(0) @binding(3) var header: texture_2d<f32>;
@group(0) @binding(4) var b2: texture_2d<f32>;
@group(0) @binding(5) var mean: texture_2d<f32>;
@group(0) @binding(6) var<uniform> settings: NssSettings;
@group(0) @binding(7) var chunk_sh2: texture_storage_2d<rgba16float, write>;

const NSS_EXPOSURE: f32 = 7.38905609893;
fn nss_tonemap(value: vec3<f32>) -> vec3<f32> {
  return value / (1.0 + max(max(value.r, value.g), value.b));
}
fn nss_tonemap_inv(value: vec3<f32>) -> vec3<f32> {
  let clamped = clamp(value, vec3<f32>(0.0), vec3<f32>(0.99999));
  return clamped / (1.0 - max(max(clamped.r, clamped.g), clamped.b));
}
fn nss_warped_history(uv: vec2<f32>) -> vec3<f32> {
  if (!all(uv >= vec2<f32>(0.0)) || !all(uv <= vec2<f32>(1.0))) { return vec3<f32>(0.0); }
  return max(vec3<f32>(0.0), textureSampleLevel(mean, segment_height, uv, 0.0).rgb);
}
fn nss_sample_layer_bilinear(position: vec2<f32>, maximum: vec2<i32>, layer: i32) -> vec4<f32> {
  let shifted = position - 0.5;
  let base_f = floor(shifted);
  let fraction = shifted - base_f;
  let base = vec2<i32>(base_f);
  let zero = vec2<i32>(0);
  let a = textureLoad(e, vec3<i32>(clamp(base, zero, maximum), layer), 0);
  let b = textureLoad(e, vec3<i32>(clamp(base + vec2<i32>(1, 0), zero, maximum), layer), 0);
  let c = textureLoad(e, vec3<i32>(clamp(base + vec2<i32>(0, 1), zero, maximum), layer), 0);
  let d = textureLoad(e, vec3<i32>(clamp(base + vec2<i32>(1, 1), zero, maximum), layer), 0);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}
fn nss_solve_input_location(output_pixel: i32, scale_factor: f32, jitter: f32) -> i32 {
  let left = f32(output_pixel) / scale_factor - (-jitter + 0.5);
  let right = f32(output_pixel + 1) / scale_factor - (-jitter + 0.5);
  let input_pixel = i32(floor(right));
  if (left < f32(input_pixel)) { return input_pixel; }
  return -1;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let output_resolution = settings.output_resolution;
  let render_resolution = settings.render_resolution;
  if (any(gid.xy >= output_resolution)) { return; }
  let output_pixel = vec2<i32>(gid.xy);
  let render_maximum = vec2<i32>(render_resolution) - vec2<i32>(1);
  let upscale = vec2<f32>(output_resolution) / vec2<f32>(render_resolution);
  let input_position = (vec2<f32>(output_pixel) + 0.5) / upscale;
  let nearest_input = clamp(vec2<i32>(floor(input_position)), vec2<i32>(0), render_maximum);

  let kernel3 = nss_sample_layer_bilinear(input_position, render_maximum, 5);
  let kernel2 = nss_sample_layer_bilinear(input_position, render_maximum, 4);
  let kernel1 = nss_sample_layer_bilinear(input_position, render_maximum, 3);
  let kernel0 = nss_sample_layer_bilinear(input_position, render_maximum, 2);
  let kernels = array<vec4<f32>, 4>(
    max(kernel3, vec4<f32>(1e-7)), max(kernel2, vec4<f32>(1e-7)),
    max(kernel1, vec4<f32>(1e-7)), max(kernel0, vec4<f32>(1e-7))
  );
  var weighted_color = vec3<f32>(0.0);
  var weight_sum = 0.0;
  var center_color = vec3<f32>(0.0);
  var center_valid = 0.0;
  for (var y = 0; y < 4; y++) {
    let row = kernels[y];
    for (var x = 0; x < 4; x++) {
      let weight = row[x];
      let candidate = output_pixel + vec2<i32>(y - 1, x - 1);
      let source_x = nss_solve_input_location(candidate.x, upscale.x, settings.jitter.x * settings.jitter_sign.x);
      let source_y = nss_solve_input_location(candidate.y, upscale.y, settings.jitter.y * settings.jitter_sign.y);
      if (source_x < 0 || source_y < 0) { continue; }
      let source = clamp(vec2<i32>(source_x, source_y), vec2<i32>(0), render_maximum);
      let color = max(vec3<f32>(0.0), textureLoad(scale, source, 0).rgb) * NSS_EXPOSURE;
      weighted_color += color * weight;
      weight_sum += weight;
      if (y == 1 && x == 1) { center_color = color; center_valid = 1.0; }
    }
  }
  let reconstructed = weighted_color / max(weight_sum, 1e-5);
  let encoded_offset = textureLoad(b2, nearest_input, 0).rg;
  let nearest_offset = vec2<i32>(round(encoded_offset * 2.0 - 1.0));
  var velocity = textureLoad(header, nearest_input + nearest_offset, 0).rg;
  if (length(velocity) <= 0.1) { velocity = vec2<f32>(0.0); }
  let scaled_velocity = velocity / (vec2<f32>(render_resolution) / vec2<f32>(output_resolution));
  let history_position = vec2<f32>(output_pixel) + 0.5 - scaled_velocity;
  let history_uv = history_position / vec2<f32>(output_resolution);
  let history = nss_warped_history(history_uv) * NSS_EXPOSURE;
  let history_in_bounds = select(0.0, 1.0, all(history_uv >= vec2<f32>(0.0)) && all(history_uv <= vec2<f32>(1.0)));
  let theta_alpha = nss_sample_layer_bilinear(input_position, render_maximum, 1);
  let learned_theta = saturate(theta_alpha.x);
  let theta = select(learned_theta, saturate(settings.theta_override), settings.theta_override >= 0.0);
  let history_weight = theta * saturate(settings.history_validity) * history_in_bounds;
  let alpha = (0.35 * saturate(theta_alpha.y) + 0.05) * settings.alpha_blend_scale;
  var result = mix(reconstructed, history, history_weight);
  result = mix(nss_tonemap(result), nss_tonemap(center_color), alpha * center_valid);
  var color = max(vec3<f32>(0.0), nss_tonemap_inv(result)) / NSS_EXPOSURE;
  if (settings.debug_view == 1u) { color = vec3<f32>(learned_theta); }
  else if (settings.debug_view == 2u) { color = vec3<f32>(saturate(theta_alpha.y)); }
  else if (settings.debug_view == 3u) { color = vec3<f32>(kernels[0].x); }
  else if (settings.debug_view == 4u) {
    let sum = kernels[0] + kernels[1] + kernels[2] + kernels[3];
    color = vec3<f32>((sum.x + sum.y + sum.z + sum.w) * 0.25);
  } else if (settings.debug_view == 5u) {
    color = vec3<f32>(nss_sample_layer_bilinear(input_position, render_maximum, 0).x);
  }
  textureStore(chunk_sh2, output_pixel, vec4<f32>(color, history_weight));
}
`;
