import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "./fullscreen_triangle.js";
import {
  TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD,
  TEMPORAL_MAX_HISTORY_WEIGHT,
  TEMPORAL_MOTION_FADE_PIXELS,
  TEMPORAL_REACTIVE_REJECT_THRESHOLD
} from "../render/TemporalResolveContract.js";

export const TAA_FORMAT = "rgba16float" as const;
export const TAA_VERTEX_WGSL = FULLSCREEN_TRIANGLE_VERTEX_WGSL;

/** FX-06A authored minimum reference; final TAAU quality belongs to FX-06B. */
export const TAA_WGSL = /* wgsl */ `
struct TemporalSettings {
  jitter: vec2f,
  history_validity: f32,
  _padding0: f32,
  internal_resolution: vec2f,
  output_resolution: vec2f,
}

@group(0) @binding(0) var linear_clamp: sampler;
@group(0) @binding(1) var velocity_texture: texture_2d<f32>;
@group(0) @binding(2) var history_color: texture_2d<f32>;
@group(0) @binding(3) var current_color: texture_2d<f32>;
@group(0) @binding(4) var disocclusion_confidence: texture_2d<f32>;
@group(0) @binding(5) var current_depth: texture_depth_2d;
@group(0) @binding(6) var temporal_classification: texture_2d<f32>;
@group(0) @binding(7) var<uniform> settings: TemporalSettings;

fn luminance(color: vec3f) -> f32 {
  return dot(max(color, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
}

fn inside_unit_square(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}

struct NeighborhoodBounds {
  minimum: vec3f,
  maximum: vec3f,
}

fn current_neighborhood_bounds(center: vec2i) -> NeighborhoodBounds {
  let size = vec2i(textureDimensions(current_color));
  var bounds: NeighborhoodBounds;
  bounds.minimum = vec3f(65504.0);
  bounds.maximum = vec3f(-65504.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let pixel = clamp(center + vec2i(x, y), vec2i(0), size - vec2i(1));
      let color = max(textureLoad(current_color, pixel, 0).rgb, vec3f(0.0));
      bounds.minimum = min(bounds.minimum, color);
      bounds.maximum = max(bounds.maximum, color);
    }
  }
  return bounds;
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
  let half_texel = vec2f(0.5) / internal_size;
  let current_uv = clamp(
    output_uv,
    half_texel,
    vec2f(1.0) - half_texel
  );
  let current = max(
    textureSampleLevel(current_color, linear_clamp, current_uv, 0.0),
    vec4f(0.0)
  );

  let velocity = textureLoad(velocity_texture, current_pixel, 0).rg;
  let history_uv = (current_pixel_f - velocity) / internal_size;
  let classification = textureLoad(temporal_classification, current_pixel, 0).rg;
  let reactive = clamp(classification.r, 0.0, 1.0);
  let motion_valid = classification.g >= 0.5;
  let confidence = clamp(
    textureLoad(disocclusion_confidence, current_pixel, 0).r,
    0.0,
    1.0
  );
  let depth = textureLoad(current_depth, current_pixel, 0);

  let globally_valid = settings.history_validity >= 0.5;
  let history_inside = inside_unit_square(history_uv);
  let accepted = globally_valid && motion_valid && history_inside &&
    reactive < ${TEMPORAL_REACTIVE_REJECT_THRESHOLD} &&
    confidence >= ${TEMPORAL_DISOCCLUSION_REJECT_THRESHOLD} &&
    depth >= 0.0;
  if !accepted {
    return vec4f(current.rgb, 1.0);
  }

  var history = max(
    textureSampleLevel(history_color, linear_clamp, history_uv, 0.0),
    vec4f(0.0)
  );
  let bounds = current_neighborhood_bounds(current_pixel);
  history = vec4f(clamp(history.rgb, bounds.minimum, bounds.maximum), history.a);

  let motion_confidence = clamp(
    1.0 - length(velocity) / ${TEMPORAL_MOTION_FADE_PIXELS},
    0.0,
    1.0
  );
  let luminance_confidence = 1.0 /
    (1.0 + abs(luminance(current.rgb) - luminance(history.rgb)));
  let history_weight = clamp(
    ${TEMPORAL_MAX_HISTORY_WEIGHT} * motion_confidence *
      luminance_confidence * (1.0 - reactive) * confidence,
    0.0,
    ${TEMPORAL_MAX_HISTORY_WEIGHT}
  );
  return vec4f(mix(current.rgb, history.rgb, history_weight), 1.0);
}
`;
