import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "./fullscreen_triangle.js";
import {
  TEMPORAL_HISTORY_LOCK_STEP,
  TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD,
  TEMPORAL_MAX_HISTORY_WEIGHT,
  TEMPORAL_MIN_LOCKED_HISTORY_WEIGHT,
  TEMPORAL_MOTION_FADE_PIXELS,
  TEMPORAL_REACTIVE_REJECT_THRESHOLD,
  TEMPORAL_VARIANCE_GAMMA
} from "../render/TemporalResolveContract.js";

export const TAA_FORMAT = "rgba16float" as const;
export const TAA_VERTEX_WGSL = FULLSCREEN_TRIANGLE_VERTEX_WGSL;

/** FX-06B authored final TAA/TAAU resolve at output resolution. */
export const TAA_WGSL = /* wgsl */ `
struct TemporalSettings {
  jitter: vec2f,
  history_validity: f32,
  history_strength: f32,
  internal_resolution: vec2f,
  output_resolution: vec2f,
}

@group(0) @binding(0) var linear_clamp: sampler;
@group(0) @binding(1) var velocity_texture: texture_2d<f32>;
@group(0) @binding(2) var history_color: texture_2d<f32>;
@group(0) @binding(3) var current_color: texture_2d<f32>;
@group(0) @binding(4) var disocclusion_confidence: texture_2d<f32>;
@group(0) @binding(5) var temporal_classification: texture_2d<f32>;
@group(0) @binding(6) var<uniform> settings: TemporalSettings;

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

fn reconstruct_current(uv: vec2f, pixel: vec2i, internal_size: vec2f) -> vec3f {
  if all(settings.output_resolution <= internal_size) {
    return max(textureLoad(current_color, pixel, 0).rgb, vec3f(0.0));
  }
  let center = sample_current(uv);
  let texel = vec2f(1.0) / internal_size;
  let neighbors =
    sample_current(uv + vec2f(texel.x, 0.0)) +
    sample_current(uv - vec2f(texel.x, 0.0)) +
    sample_current(uv + vec2f(0.0, texel.y)) +
    sample_current(uv - vec2f(0.0, texel.y));
  let ratio = max(
    settings.output_resolution.x / internal_size.x,
    settings.output_resolution.y / internal_size.y
  );
  let reconstruction_strength = clamp((ratio - 1.0) * 0.18, 0.0, 0.22);
  let detail = center * 4.0 - neighbors;
  return max(center + detail * reconstruction_strength, vec3f(0.0));
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
  let lower = max(stats.minimum, stats.mean - stats.deviation * ${TEMPORAL_VARIANCE_GAMMA});
  let upper = min(stats.maximum, stats.mean + stats.deviation * ${TEMPORAL_VARIANCE_GAMMA});
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
  let classification = textureLoad(temporal_classification, current_pixel, 0).rg;
  let reactive = clamp(classification.r, 0.0, 1.0);
  let motion_valid = classification.g >= 0.5;
  let globally_valid = settings.history_validity >= 0.5;
  if !globally_valid || !motion_valid || reactive >= ${TEMPORAL_REACTIVE_REJECT_THRESHOLD} {
    return vec4f(current, 0.0);
  }

  let confidence = clamp(
    textureLoad(disocclusion_confidence, current_pixel, 0).r,
    0.0,
    1.0
  );
  if confidence < ${TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD} {
    return vec4f(current, 0.0);
  }

  let velocity = textureLoad(velocity_texture, current_pixel, 0).rg;
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
    1.0 - length(velocity) / ${TEMPORAL_MOTION_FADE_PIXELS},
    0.0,
    1.0
  );
  let luminance_confidence = 1.0 /
    (1.0 + abs(luminance(current) - luminance(history)));
  let history_lock = clamp(
    history_sample.a + ${TEMPORAL_HISTORY_LOCK_STEP},
    0.0,
    1.0
  );
  let locked_weight_limit = mix(
    ${TEMPORAL_MIN_LOCKED_HISTORY_WEIGHT},
    ${TEMPORAL_MAX_HISTORY_WEIGHT},
    history_lock
  );
  let history_weight = clamp(
    locked_weight_limit * settings.history_strength * motion_confidence *
      luminance_confidence * (1.0 - reactive) * confidence,
    0.0,
    ${TEMPORAL_MAX_HISTORY_WEIGHT}
  );
  return vec4f(mix(current, history, history_weight), history_lock);
}
`;
