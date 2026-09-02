import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "./fullscreen_triangle.js";
export const TAA_FORMAT = "rgba16float" as const;
export const TAA_VERTEX_WGSL = FULLSCREEN_TRIANGLE_VERTEX_WGSL;

/** FX-06B authored final TAA/TAAU resolve at output resolution. */
export const TAA_WGSL = /* wgsl */ `
struct TemporalSettings {
  history_validity: f32,
  history_strength: f32,
  internal_resolution: vec2f,
  output_resolution: vec2f,
  variance_gamma: f32,
  minimum_history_weight: f32,
  maximum_history_weight: f32,
  history_lock_step: f32,
  reactive_threshold: f32,
  disocclusion_threshold: f32,
  motion_fade_pixels: f32,
  _padding0: f32,
  _padding1: f32,
  _padding2: f32,
}

@group(0) @binding(0) var linear_clamp: sampler;
@group(0) @binding(1) var velocity_texture: texture_2d<f32>;
@group(0) @binding(2) var history_color: texture_2d<f32>;
@group(0) @binding(3) var current_color: texture_2d<f32>;
@group(0) @binding(4) var disocclusion_confidence: texture_2d<f32>;
@group(0) @binding(5) var temporal_classification: texture_2d<f32>;
@group(0) @binding(6) var current_depth: texture_2d<f32>;
@group(0) @binding(7) var<uniform> settings: TemporalSettings;

fn luminance(color: vec3f) -> f32 {
  return dot(max(color, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
}

fn inside_unit_square(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}

fn rgb_to_ycocg(rgb: vec3f) -> vec3f {
  return vec3f(
    dot(rgb, vec3f(0.25, 0.5, 0.25)),
    dot(rgb, vec3f(0.5, 0.0, -0.5)),
    dot(rgb, vec3f(-0.25, 0.5, -0.25))
  );
}

fn ycocg_to_rgb(value: vec3f) -> vec3f {
  return vec3f(
    value.x + value.y - value.z,
    value.x + value.z,
    value.x - value.y - value.z
  );
}

fn sample_current(uv: vec2f) -> vec3f {
  return max(
    textureSampleLevel(current_color, linear_clamp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb,
    vec3f(0.0)
  );
}

fn catmull_rom_weights(value: f32) -> vec4f {
  let x2 = value * value;
  let x3 = x2 * value;
  return vec4f(
    -0.5 * value + x2 - 0.5 * x3,
    1.0 - 2.5 * x2 + 1.5 * x3,
    0.5 * value + 2.0 * x2 - 1.5 * x3,
    -0.5 * x2 + 0.5 * x3
  );
}

fn sample_current_catmull_rom(uv: vec2f, internal_size: vec2f) -> vec3f {
  let texel_position = uv * internal_size - 0.5;
  let base = floor(texel_position);
  let fraction = fract(texel_position);
  let wx = catmull_rom_weights(fraction.x);
  let wy = catmull_rom_weights(fraction.y);
  var result = vec3f(0.0);
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let sample_uv = (base + vec2f(f32(x - 1), f32(y - 1)) + 0.5) / internal_size;
      result += sample_current(sample_uv) * wx[x] * wy[y];
    }
  }
  return max(result, vec3f(0.0));
}

fn reconstruct_current(uv: vec2f, pixel: vec2i, internal_size: vec2f) -> vec3f {
  if all(settings.output_resolution <= internal_size) {
    return max(textureLoad(current_color, pixel, 0).rgb, vec3f(0.0));
  }
  return sample_current_catmull_rom(uv, internal_size);
}

fn closest_depth_pixel(center: vec2i) -> vec2i {
  let size = vec2i(textureDimensions(current_depth));
  var closest = clamp(center, vec2i(0), size - vec2i(1));
  var closest_depth = textureLoad(current_depth, closest, 0).r;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let candidate = clamp(center + vec2i(x, y), vec2i(0), size - vec2i(1));
      let depth = textureLoad(current_depth, candidate, 0).r;
      if (depth > closest_depth) {
        closest = candidate;
        closest_depth = depth;
      }
    }
  }
  return closest;
}

struct NeighborhoodStats {
  minimum: vec3f,
  maximum: vec3f,
  mean: vec3f,
  deviation: vec3f,
}

fn current_neighborhood_stats(center: vec2i, current: vec3f) -> NeighborhoodStats {
  let size = vec2i(textureDimensions(current_color));
  let center_value = rgb_to_ycocg(current);
  var minimum = center_value;
  var maximum = center_value;
  var sum = center_value;
  var squared = center_value * center_value;
  let offsets = array<vec2i, 4>(
    vec2i(-1, 0),
    vec2i(1, 0),
    vec2i(0, -1),
    vec2i(0, 1)
  );
  for (var index = 0; index < 4; index++) {
    let pixel = clamp(center + offsets[index], vec2i(0), size - vec2i(1));
    let value = rgb_to_ycocg(max(textureLoad(current_color, pixel, 0).rgb, vec3f(0.0)));
    minimum = min(minimum, value);
    maximum = max(maximum, value);
    sum += value;
    squared += value * value;
  }
  let mean = sum / 5.0;
  let deviation = sqrt(max(squared / 5.0 - mean * mean, vec3f(0.0)));
  return NeighborhoodStats(minimum, maximum, mean, deviation);
}

fn clip_history(history: vec3f, stats: NeighborhoodStats) -> vec3f {
  let lower = max(stats.minimum, stats.mean - stats.deviation * settings.variance_gamma);
  let upper = min(stats.maximum, stats.mean + stats.deviation * settings.variance_gamma);
  let clipped = clamp(rgb_to_ycocg(history), lower, upper);
  return max(ycocg_to_rgb(clipped), vec3f(0.0));
}

@fragment
fn main(
  @builtin(position) position: vec4f,
  @location(0) output_uv: vec2f
) -> @location(0) vec4f {
  let internal_size = max(settings.internal_resolution, vec2f(1.0));
  let current_pixel_f = output_uv * internal_size;
  let current_pixel = clamp(
    vec2i(current_pixel_f),
    vec2i(0),
    vec2i(internal_size) - vec2i(1)
  );
  let current_uv = clamp(output_uv, vec2f(0.0), vec2f(1.0));
  let current = reconstruct_current(current_uv, current_pixel, internal_size);
  let reprojection_pixel = closest_depth_pixel(current_pixel);
  let surface_classification = textureLoad(
    temporal_classification,
    reprojection_pixel,
    0
  ).rg;
  // Velocity follows the closest opaque depth sample, but final-layer reactive
  // coverage belongs to the output pixel. Combining both prevents a transparent
  // foreground from losing its rejection mask when the closest-depth search
  // selects the opaque surface behind it.
  let output_reactive = textureLoad(
    temporal_classification,
    current_pixel,
    0
  ).r;
  let reactive = clamp(max(surface_classification.r, output_reactive), 0.0, 1.0);
  let motion_valid = surface_classification.g >= 0.5;
  let globally_valid = settings.history_validity >= 0.5;
  // Final-layer reactive coverage may not own a dedicated transparent velocity.
  // It is allowed to rebuild a heavily clamped zero-motion history; opaque
  // motion-invalid pixels still reject immediately.
  if !globally_valid || (!motion_valid && reactive < settings.reactive_threshold) {
    return vec4f(current, 0.0);
  }

  let confidence = clamp(
    textureLoad(disocclusion_confidence, reprojection_pixel, 0).r,
    0.0,
    1.0
  );
  if confidence < settings.disocclusion_threshold {
    return vec4f(current, 0.0);
  }

  let velocity = textureLoad(velocity_texture, reprojection_pixel, 0).rg;
  // Output/current sampling is already jittered by the projection contract;
  // only velocity is selected from the closest-depth surface.
  let history_uv = (current_pixel_f - velocity) / internal_size;
  let history_inside = inside_unit_square(history_uv);
  if !history_inside {
    return vec4f(current, 0.0);
  }

  let history_sample = max(
    textureSampleLevel(history_color, linear_clamp, history_uv, 0.0),
    vec4f(0.0)
  );
  let stats = current_neighborhood_stats(current_pixel, current);
  let history = clip_history(history_sample.rgb, stats);

  let motion_confidence = clamp(
    1.0 - length(velocity) / max(settings.motion_fade_pixels, 1.0),
    0.0,
    1.0
  );
  let luminance_confidence = 1.0 /
    (1.0 + abs(luminance(current) - luminance(history)));
  let history_lock = clamp(
    history_sample.a + settings.history_lock_step,
    0.0,
    1.0
  );
  let locked_weight_limit = mix(
    min(settings.minimum_history_weight, settings.maximum_history_weight),
    max(settings.minimum_history_weight, settings.maximum_history_weight),
    history_lock
  );
  let reactive_rejection = smoothstep(
    settings.reactive_threshold,
    1.0,
    reactive
  );
  let history_weight = clamp(
    locked_weight_limit * settings.history_strength * motion_confidence *
      luminance_confidence * (1.0 - reactive_rejection) * confidence,
    0.0,
    max(settings.minimum_history_weight, settings.maximum_history_weight)
  );
  return vec4f(mix(current, history, history_weight), history_lock);
}
`;
