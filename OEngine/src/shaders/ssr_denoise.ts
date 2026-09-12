/** Three.js r186-derived SSR temporal reprojection and recurrent denoise. */

import {
  SSR_CAMERA_WGSL,
  SSR_COLOR_HISTORY_WGSL,
  SSR_FULLSCREEN_VERTEX_WGSL,
  SSR_MATH_WGSL
} from "./ssr_common.js";

export const SSR_DENOISE_FORMAT = "rgba16float" as const;

/** Full-resolution joint bilateral reconstruction for half-resolution SSR. */
export const SSR_UPSAMPLE_WGSL = /* wgsl */ `
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
@group(0) @binding(0) var reflection_half: texture_2d<f32>;
@group(0) @binding(1) var depth_full: texture_2d<f32>;
@group(0) @binding(2) var normal_full: texture_2d<u32>;

fn bilateral_weight(center_depth: f32, sample_depth: f32, center_normal: vec3f, sample_normal: vec3f) -> f32 {
  let depth_term = exp(-abs(center_depth - sample_depth) * max(abs(center_depth), 1.0) * 8.0);
  let normal_term = pow(max(dot(center_normal, sample_normal), 0.0), 64.0);
  return depth_term * normal_term;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let full_size = vec2i(textureDimensions(depth_full));
  let half_size = vec2i(textureDimensions(reflection_half));
  let full_pixel = clamp(vec2i(coord.xy), vec2i(0), full_size - vec2i(1));
  let source = (vec2f(full_pixel) + 0.5) * vec2f(half_size) / vec2f(full_size) - 0.5;
  let base = vec2i(floor(source));
  let center_depth = textureLoad(depth_full, full_pixel, 0).r;
  let center_normal = decode_g_buffer_normal(textureLoad(normal_full, full_pixel, 0).xy);
  var sum = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = 0; y <= 1; y++) {
    for (var x = 0; x <= 1; x++) {
      let half_pixel = clamp(base + vec2i(x, y), vec2i(0), half_size - vec2i(1));
      let mapped_full = clamp(
        vec2i((vec2f(half_pixel) + 0.5) * vec2f(full_size) / vec2f(half_size)),
        vec2i(0), full_size - vec2i(1)
      );
      let sample_depth = textureLoad(depth_full, mapped_full, 0).r;
      let sample_normal = decode_g_buffer_normal(textureLoad(normal_full, mapped_full, 0).xy);
      let bilinear = vec2f(1.0) - abs(source - vec2f(half_pixel));
      let weight = max(0.001, bilinear.x * bilinear.y) *
        bilateral_weight(center_depth, sample_depth, center_normal, sample_normal);
      let raw_sample = textureLoad(reflection_half, half_pixel, 0);
      let sample_value = select(
        vec4f(0.0), raw_sample,
        all(raw_sample == raw_sample) && all(abs(raw_sample) < vec4f(65504.0))
      );
      sum += sample_value * weight;
      weight_sum += weight;
    }
  }
  let resolved = sum / max(weight_sum, 1e-5);
  return select(
    vec4f(0.0), resolved,
    all(resolved == resolved) && all(abs(resolved) < vec4f(65504.0))
  );
}
`;

export const SSR_TEMPORAL_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}
${SSR_COLOR_HISTORY_WGSL}

struct SsrTemporalSettings {
  history_valid: u32,
  history_strength: f32,
  max_motion_pixels: f32,
  pre_exposure_scale: f32,
};

@group(0) @binding(0) var raw_specular: texture_2d<f32>;
@group(0) @binding(1) var velocity_source: texture_2d<f32>;
@group(0) @binding(2) var occlusion_confidence_source: texture_2d<f32>;
@group(0) @binding(3) var history_source: texture_2d<f32>;
@group(0) @binding(4) var<uniform> camera_current: CommandEncoder;
@group(0) @binding(5) var<uniform> settings: SsrTemporalSettings;
@group(0) @binding(6) var surface_validity_source: texture_2d<f32>;
@group(0) @binding(7) var trace_source: texture_2d<u32>;
@group(0) @binding(8) var depth_source: texture_2d<f32>;
@group(0) @binding(9) var normal_source: texture_2d<u32>;

fn trace_confidence(position: vec2i) -> f32 {
  return f32(textureLoad(trace_source, position, 0).y & 0xffu) / 255.0;
}

fn trace_hit_position(position: vec2i) -> vec2u {
  let packed = textureLoad(trace_source, position, 0).x;
  return vec2u(packed & 0xffffu, packed >> 16u);
}

fn surface_position(effect_position: vec2i, effect_size: vec2i, surface_size: vec2i) -> vec2i {
  return clamp(
    vec2i((vec2f(effect_position) + 0.5) * vec2f(surface_size) / vec2f(effect_size)),
    vec2i(0), surface_size - vec2i(1)
  );
}

fn history_sample_4tap(
  history_pixel: vec2f,
  center_depth: f32,
  center_normal: vec3f,
  effect_size: vec2i,
  surface_size: vec2i
) -> vec4f {
  let base = vec2i(floor(history_pixel - 0.5));
  let fraction = fract(history_pixel - 0.5);
  let bilinear = vec4f(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y
  );
  const offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  var result = vec4f(0.0);
  var weight_sum = 0.0;
  for (var i = 0; i < 4; i++) {
    let tap = base + offsets[i];
    if (any(tap < vec2i(0)) || any(tap >= effect_size)) { continue; }
    let tap_surface = surface_position(tap, effect_size, surface_size);
    let tap_depth = textureLoad(depth_source, tap_surface, 0).r;
    let tap_normal = decode_g_buffer_normal(textureLoad(normal_source, tap_surface, 0).xy);
    let geometry = exp(-abs(center_depth - tap_depth) * max(abs(center_depth), 1.0) * 8.0) *
      pow(max(dot(center_normal, tap_normal), 0.0), 64.0);
    let history = max(textureLoad(history_source, tap, 0), vec4f(0.0));
    let weight = bilinear[i] * geometry * saturate(history.a);
    result += history * weight;
    weight_sum += weight;
  }
  return select(
    vec4f(0.0),
    result / max(weight_sum, 1e-5),
    weight_sum > 1e-5
  );
}

fn neighborhood_bounds(
  position: vec2i,
  gamma: f32,
  minimum: ptr<function, vec3f>,
  maximum: ptr<function, vec3f>
) {
  let limit = vec2i(textureDimensions(raw_specular)) - vec2i(1);
  var sum = vec3f(0.0);
  var sum_squared = vec3f(0.0);
  var count = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let color = max(textureLoad(raw_specular, clamp(position + vec2i(x, y), vec2i(0), limit), 0).rgb, vec3f(0.0));
      let encoded = rgb_to_YCoCg(color / (1.0 + rgb_to_luminance(color) * 10.0));
      sum += encoded;
      sum_squared += encoded * encoded;
      count += 1.0;
    }
  }
  let mean = sum / count;
  let deviation = sqrt(max(sum_squared / count - mean * mean, vec3f(0.0)));
  *minimum = mean - deviation * gamma;
  *maximum = mean + deviation * gamma;
}

fn clip_history_to_aabb(history: vec3f, minimum: vec3f, maximum: vec3f) -> vec3f {
  let center = (minimum + maximum) * 0.5;
  let extent = (maximum - minimum) * 0.5 + vec3f(1e-7);
  let direction = history - center;
  let unit = abs(direction / extent);
  let maximum_unit = max(unit.x, max(unit.y, unit.z));
  return select(
    history,
    center + direction / max(maximum_unit, 1e-7),
    maximum_unit > 1.0
  );
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let position = vec2i(coord.xy);
  let effect_size = vec2i(textureDimensions(raw_specular));
  let surface_size = vec2i(textureDimensions(velocity_source));
  let receiver = surface_position(position, effect_size, surface_size);
  let validity = textureLoad(surface_validity_source, receiver, 0).rg;
  let trace_validity = trace_confidence(position);
  let disocclusion = textureLoad(occlusion_confidence_source, receiver, 0).r;
  let current = max(textureLoad(raw_specular, position, 0), vec4f(0.0));
  let current_confidence = trace_validity * disocclusion *
    select(1.0, 0.0, validity.g < 0.5 || validity.r >= 0.5) *
    select(0.0, 1.0, current.a > 1e-5);
  if (current_confidence <= 0.001) { return vec4f(0.0); }
  if (settings.history_valid == 0u || settings.pre_exposure_scale <= 0.0) {
    return vec4f(current.rgb, current_confidence);
  }

  let receiver_velocity = taa_get_velocity(velocity_source, receiver) *
    vec2f(effect_size) / vec2f(surface_size);
  let hit_pixel = min(trace_hit_position(position), vec2u(surface_size) - vec2u(1u));
  let hit_validity = textureLoad(surface_validity_source, vec2i(hit_pixel), 0).rg;
  let hit_candidate_valid = hit_validity.g >= 0.5 && hit_validity.r < 0.5;
  let hit_velocity = textureLoad(velocity_source, vec2i(hit_pixel), 0).rg *
    vec2f(effect_size) / vec2f(surface_size);
  let center_depth = textureLoad(depth_source, receiver, 0).r;
  let center_uv = texel_coordinate_to_uv(vec2f(receiver), vec2u(surface_size));
  let view_position = project_position_from_depth(
    center_uv, center_depth, camera_current.projection_matrix_inverse
  );
  let center_normal = decode_g_buffer_normal(textureLoad(normal_source, receiver, 0).xy);
  let hit_depth = textureLoad(depth_source, vec2i(hit_pixel), 0).r;
  let hit_normal = decode_g_buffer_normal(
    textureLoad(normal_source, vec2i(hit_pixel), 0).xy
  );
  let surface_history_pixel = coord.xy - receiver_velocity;
  let hit_effect_pixel = (vec2f(hit_pixel) + 0.5) *
    vec2f(effect_size) / vec2f(surface_size);
  let hit_history_pixel = hit_effect_pixel - hit_velocity;
  let surface_history = history_sample_4tap(
    surface_history_pixel, center_depth, center_normal, effect_size, surface_size
  );
  let hit_history = history_sample_4tap(
    hit_history_pixel, hit_depth, hit_normal, effect_size, surface_size
  );
  // Preserve the two physical reprojection candidates. Blending their
  // velocities first would sample a third point that represents neither the
  // receiver nor the reflected hit and causes motion-dependent ghosting. The
  // hit candidate starts at the current hit texel, not the receiver texel.
  let hit_trust = saturate(current.a / max(current.a + abs(view_position.z), 1e-5));
  let surface_weight = (1.0 - hit_trust) * surface_history.a;
  let hit_weight = hit_trust * hit_history.a *
    select(0.0, 1.0, hit_candidate_valid);
  let history_weight_sum = surface_weight + hit_weight;
  var history = select(
    vec4f(0.0),
    vec4f(
      (surface_history.rgb * surface_weight + hit_history.rgb * hit_weight) /
        max(history_weight_sum, 1e-5),
      (surface_history.a * surface_weight + hit_history.a * hit_weight) /
        max(history_weight_sum, 1e-5)
    ),
    history_weight_sum > 1e-5
  );
  if (history.a <= 0.001) { return vec4f(current.rgb, current_confidence); }
  history.rgb *= settings.pre_exposure_scale;

  // Three's motion factor is based on the receiver reprojection even when the
  // specular hit candidate is also sampled.
  let motion_confidence = saturate(
    1.0 - length(receiver_velocity) / max(settings.max_motion_pixels, 1.0)
  );
  let motion_factor = 1.0 - motion_confidence;
  let variance_gamma = mix(0.5, 1.0, motion_confidence * motion_confidence);
  var minimum: vec3f;
  var maximum: vec3f;
  neighborhood_bounds(position, variance_gamma, &minimum, &maximum);
  let history_scale = 1.0 + rgb_to_luminance(history.rgb) * 10.0;
  let encoded_history = rgb_to_YCoCg(history.rgb / history_scale);
  let clipped_encoded = clip_history_to_aabb(encoded_history, minimum, maximum);
  let clipped_linear = max(construct_pass(clipped_encoded) * history_scale, vec3f(0.0));
  let clamp_intensity = max(min(motion_factor * 10.0, 1.0), 0.25);
  let original_history = history.rgb;
  let history_linear = mix(original_history, clipped_linear, clamp_intensity);
  let clip_confidence = exp(
    -length(original_history - clipped_linear) * clamp_intensity * 30.0
  );
  history.a *= clip_confidence;
  let current_luma_weight = 1.0 / (1.0 + rgb_to_luminance(current.rgb));
  let history_luma_weight = 1.0 / (1.0 + rgb_to_luminance(history_linear));
  let history_weight = clamp(
    settings.history_strength * current_confidence * history.a * motion_confidence,
    0.0,
    0.97
  );
  let weighted_history = history_weight * history_luma_weight;
  let weighted_current = (1.0 - history_weight) * current_luma_weight;
  let resolved = (history_linear * weighted_history + current.rgb * weighted_current) /
    max(weighted_history + weighted_current, 1e-5);
  let resolved_confidence = mix(current_confidence, min(current_confidence, history.a), history_weight);
  let finite = all(resolved == resolved) && all(abs(resolved) < vec3f(65504.0));
  return vec4f(select(current.rgb, resolved, finite), resolved_confidence);
}
`;

export const SSR_RECURRENT_DENOISE_WGSL = /* wgsl */ `
${SSR_CAMERA_WGSL}
${SSR_FULLSCREEN_VERTEX_WGSL}
${SSR_MATH_WGSL}

struct SsrDenoiseSettings {
  frame_index: u32,
  radius: f32,
  strength: f32,
  mode_flags: u32,
};

@group(0) @binding(0) var temporal_source: texture_2d<f32>;
@group(0) @binding(1) var raw_source: texture_2d<f32>;
@group(0) @binding(2) var depth_source: texture_2d<f32>;
@group(0) @binding(3) var normal_source: texture_2d<u32>;
@group(0) @binding(4) var pbr_source: texture_2d<u32>;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
@group(0) @binding(6) var<uniform> settings: SsrDenoiseSettings;
@group(0) @binding(7) var trace_source: texture_2d<u32>;

fn effect_to_surface(position: vec2i, effect_size: vec2i, surface_size: vec2i) -> vec2i {
  return clamp(
    vec2i((vec2f(position) + 0.5) * vec2f(surface_size) / vec2f(effect_size)),
    vec2i(0), surface_size - vec2i(1)
  );
}

fn view_position_at(position: vec2i, surface_size: vec2i) -> vec3f {
  let uv = texel_coordinate_to_uv(vec2f(position), vec2u(surface_size));
  return project_position_from_depth(
    uv, textureLoad(depth_source, position, 0).r, camera.projection_matrix_inverse
  );
}

fn view_normal_at(position: vec2i) -> vec3f {
  let world = decode_g_buffer_normal(textureLoad(normal_source, position, 0).xy);
  let view = camera.view_matrix;
  return normalize(mat3x3f(view[0].xyz, view[1].xyz, view[2].xyz) * world);
}

fn vogel_disk(index: f32) -> vec2f {
  let theta = (index + 0.5) * 2.399827721492203;
  let radius = sqrt((index + 0.5) / 8.0);
  return vec2f(cos(theta), sin(theta)) * radius;
}

fn noise_angle(pixel: vec2u, frame_index: u32) -> f32 {
  let hash = resolve_trigonometric_moments(vec3u(pixel, frame_index));
  return 2.0 * PI * f32(hash & 0xffffu) / 65535.0;
}

fn trace_confidence(position: vec2i) -> f32 {
  return f32(textureLoad(trace_source, position, 0).y & 0xffu) / 255.0;
}

fn neighborhood_ray_length(position: vec2i, effect_size: vec2i) -> f32 {
  const offsets = array<vec2i, 5>(
    vec2i(0, 0), vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1)
  );
  var weighted_sum = 0.0;
  var weight_sum = 0.0;
  for (var i = 0; i < 5; i++) {
    let tap = clamp(position + offsets[i], vec2i(0), effect_size - vec2i(1));
    let sample = max(textureLoad(raw_source, tap, 0), vec4f(0.0));
    let valid = trace_confidence(tap) > 0.0 && sample.a > 1e-5;
    let weight = select(0.0, 1.0 / (sample.a + 0.001), valid);
    weighted_sum += sample.a * weight;
    weight_sum += weight;
  }
  return select(0.001, weighted_sum / max(weight_sum, 1e-5), weight_sum > 1e-5);
}

fn hit_distance_factor(ray_length: f32, view_z: f32, tan_half_fov_y: f32) -> f32 {
  let frustum_height = 2.0 * abs(view_z) * tan_half_fov_y;
  return saturate(ray_length / max(frustum_height, 1e-6));
}

fn specular_lobe_tan_half_angle(roughness: f32, percent: f32) -> f32 {
  let alpha = roughness * roughness;
  return alpha * sqrt(percent / max(1.0 - percent, 1e-6));
}

fn lobe_normal_falloff(roughness: f32, aggressivity: f32) -> f32 {
  // RecurrentDenoiseNode r186 defaults normalPhi=5; oneMinus().pow2() is 16.
  let percent = clamp(mix(16.0, 0.0, sqrt(aggressivity)), 0.1, 0.99);
  let half_angle = max(
    atan(specular_lobe_tan_half_angle(roughness, percent)),
    1.5 / 65535.0
  );
  return 8.0 / (half_angle * half_angle);
}

fn mirror_screen_uv(value: vec2f) -> vec2f {
  // Three r186 mirrors projected Vogel taps at the viewport boundary instead
  // of dropping them, preserving the fixed eight-sample kernel near edges.
  return clamp(vec2f(1.0) - abs(vec2f(1.0) - abs(value)), vec2f(0.0), vec2f(1.0));
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let position = vec2i(coord.xy);
  let effect_size = vec2i(textureDimensions(temporal_source));
  let surface_size = vec2i(textureDimensions(depth_source));
  let surface = effect_to_surface(position, effect_size, surface_size);
  let raw = max(textureLoad(raw_source, position, 0), vec4f(0.0));
  var center = max(textureLoad(temporal_source, position, 0), vec4f(0.0));
  center.a = select(
    trace_confidence(position) * select(0.0, 1.0, raw.a > 1e-5),
    center.a,
    (settings.mode_flags & 1u) != 0u
  );
  if (center.a <= 0.001) { return vec4f(0.0); }
  let center_view = view_position_at(surface, surface_size);
  let center_normal = view_normal_at(surface);
  let center_pbr = textureLoad(pbr_source, surface, 0);
  let center_roughness = decode_g_buffer_roughness(center_pbr);
  let view_direction = normalize(-center_view);
  let dominant_direction = normalize(mix(
    center_normal,
    reflect(-view_direction, center_normal),
    1.0 - center_roughness
  ));
  let reflection_axis = normalize(reflect(-dominant_direction, center_normal));
  var tangent = cross(center_normal, reflection_axis);
  if (dot(tangent, tangent) < 1e-6) {
    tangent = build_orthonormal_matrix_n(reflection_axis)[0];
  } else {
    tangent = normalize(tangent);
  }
  let bitangent = normalize(cross(reflection_axis, tangent));
  let view_angle = saturate(acos(clamp(abs(center_normal.z), 0.0, 1.0)) / (0.5 * PI));
  tangent *= mix(1.0, center_roughness, view_angle);

  let history_aggressivity = select(
    0.0,
    saturate(center.a * settings.strength),
    (settings.mode_flags & 2u) != 0u
  );
  let ray_length = neighborhood_ray_length(position, effect_size);
  let world_radius = settings.radius * ray_length * abs(center_view.z) *
    max(sqrt(center_roughness), 0.01) * mix(1.0, 0.001, history_aggressivity);
  let tan_half_fov_y = max(abs(camera.device_depth_to_view_space.w), 1e-6);
  let center_hit_distance = hit_distance_factor(
    ray_length, center_view.z, tan_half_fov_y
  );
  let normal_falloff = lobe_normal_falloff(center_roughness, history_aggressivity);
  let angle = noise_angle(vec2u(position), settings.frame_index);
  let rotation = mat2x2f(vec2f(cos(angle), sin(angle)), vec2f(-sin(angle), cos(angle)));
  var accumulated = center.rgb;
  var accumulated_raw = raw.rgb;
  var confidence_sum = center.a;
  var weight_sum = 1.0;
  var raw_weight_sum = 1.0;
  var radius_shrink = 1.0;
  var polar_bias = vec2f(0.0);
  // Three defines the kernel's luma edge stop from the unfiltered input. The
  // temporal source may contain history and must not reshape the current-frame
  // raw filter or its adaptive feedback.
  let center_raw_luma = rgb_to_luminance(raw.rgb);

  for (var i = 0; i < 8; i++) {
    let base = vogel_disk(f32(i));
    let base_direction = normalize(base);
    let has_bias = dot(polar_bias, polar_bias) > 0.001;
    let bias_direction = polar_bias / max(length(polar_bias), 1e-6);
    let biased_direction = mix(base_direction, bias_direction,
      select(0.0, 0.5 * history_aggressivity, has_bias));
    let disk = rotation * (biased_direction * length(base) * radius_shrink);
    let sample_view = center_view + (bitangent * disk.x + tangent * disk.y) * world_radius;
    let sample_ndc = v3_matrix4_project(sample_view, camera.projection_matrix);
    let sample_uv = mirror_screen_uv(ndc_to_uv(sample_ndc.xy));
    let sample_position = clamp(
      vec2i(sample_uv * vec2f(effect_size)), vec2i(0), effect_size - vec2i(1)
    );
    let sample_surface = effect_to_surface(sample_position, effect_size, surface_size);
    var sample_value = max(textureLoad(temporal_source, sample_position, 0), vec4f(0.0));
    let sample_raw = max(textureLoad(raw_source, sample_position, 0), vec4f(0.0));
    sample_value.a = select(
      trace_confidence(sample_position) * select(0.0, 1.0, sample_raw.a > 1e-5),
      sample_value.a,
      (settings.mode_flags & 1u) != 0u
    );
    let sample_view_position = view_position_at(sample_surface, surface_size);
    let sample_normal = view_normal_at(sample_surface);
    let sample_roughness = decode_g_buffer_roughness(textureLoad(pbr_source, sample_surface, 0));
    let plane_distance = abs(dot(center_view - sample_view_position, center_normal));
    let depth_difference = plane_distance * 2500.0 * abs(center_normal.z) /
      max(abs(center_view.z), 1e-4);
    let normal_weight = exp(
      (clamp(dot(center_normal, sample_normal), -1.0, 1.0) - 1.0) * normal_falloff
    );
    let sample_hit_distance = hit_distance_factor(
      sample_raw.a, sample_view_position.z, tan_half_fov_y
    );
    let ray_difference = abs(center_hit_distance - sample_hit_distance) /
      max(abs(center_view.z), 1e-4);
    let luma_difference = abs(
      center_raw_luma - rgb_to_luminance(sample_raw.rgb)
    ) * 50.0;
    let roughness_difference = abs(center_roughness - sample_roughness) * 100.0;
    let kernel_difference = luma_difference + roughness_difference + ray_difference;
    let spatial_weight = exp(
      -(kernel_difference * history_aggressivity + depth_difference)
    ) * normal_weight;
    let temporal_weight = sample_value.a * spatial_weight;
    let raw_confidence = trace_confidence(sample_position) *
      select(0.0, 1.0, sample_raw.a > 1e-5);
    let raw_spatial_weight = raw_confidence * spatial_weight;
    accumulated += sample_value.rgb * temporal_weight;
    accumulated_raw += sample_raw.rgb * raw_spatial_weight;
    confidence_sum += sample_value.a * temporal_weight;
    weight_sum += temporal_weight;
    raw_weight_sum += raw_spatial_weight;
    // Three feeds the unmodified spatial edge weight back into the adaptive
    // radius and polar direction with adapt=0.5. OEngine has no environment
    // sample in the SSR buffer, so a miss is absent rather than a valid env ray
    // and must not reshape subsequent taps.
    let feedback_weight = spatial_weight * select(0.0, 1.0, raw_confidence > 0.0);
    radius_shrink = max(0.001, mix(radius_shrink, feedback_weight, 0.5));
    polar_bias = mix(polar_bias, base_direction * (feedback_weight - 0.5), 0.5);
  }
  let denoised_temporal = accumulated / max(weight_sum, 1e-5);
  let denoised_raw = accumulated_raw / max(raw_weight_sum, 1e-5);
  // RecurrentDenoise accumulate=true: Karis-style inverse-luminance blend
  // between spatially filtered temporal input and filtered current raw SSR.
  let current_weight = clamp(1.0 - history_aggressivity, 0.05, 1.0);
  let temporal_weight = (1.0 - current_weight) /
    (1.0 + rgb_to_luminance(denoised_temporal) * 10.0);
  let raw_weight = current_weight /
    (1.0 + rgb_to_luminance(denoised_raw) * 10.0);
  let resolved = (denoised_temporal * temporal_weight + denoised_raw * raw_weight) /
    max(temporal_weight + raw_weight, 1e-5);
  let confidence = min(center.a, confidence_sum / max(weight_sum, 1e-5));
  let finite = all(resolved == resolved) && all(abs(resolved) < vec3f(65504.0));
  return vec4f(select(center.rgb, resolved, finite), confidence);
}
`;
