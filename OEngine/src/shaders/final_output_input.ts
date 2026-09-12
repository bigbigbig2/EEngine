export interface FinalOutputShaderOptions {
  readonly bloom: boolean;
  readonly sharpening: boolean;
  readonly colorGrading: boolean;
}

export interface FinalOutputBindingPlan {
  readonly source: number;
  readonly bloom: number | null;
  readonly sampler: number | null;
  readonly effects: number | null;
  readonly next: number;
}

/** Shared binding arithmetic used by WGSL generation and TonemapPass layouts. */
export function finalOutputBindingPlan(
  options: FinalOutputShaderOptions
): FinalOutputBindingPlan {
  let next = 1;
  const bloom = options.bloom ? next++ : null;
  const sampler = options.bloom ? next++ : null;
  const effects = options.bloom || options.sharpening || options.colorGrading
    ? next++
    : null;
  return Object.freeze({ source: 0, bloom, sampler, effects, next });
}

/**
 * Produces the scene-linear input stage fused into the swapchain pass.
 * Static variants physically omit Bloom and/or the 4-neighbor sharpen reads.
 */
export function finalOutputInputWgsl(
  options: FinalOutputShaderOptions
): string {
  const bindings = finalOutputBindingPlan(options);
  const effects = bindings.effects === null ? "" : `
struct FinalOutputEffects {
  lift: vec3f,
  gamma: vec3f,
  gain: vec3f,
  saturation: f32,
  contrast: f32,
  sharpening: f32,
  bloom_intensity: f32,
  _padding0: f32,
}
@group(0) @binding(${bindings.effects}) var<uniform> final_effects: FinalOutputEffects;
`;
  const bloomBindings = !options.bloom ? "" : `
@group(0) @binding(${bindings.bloom}) var final_bloom: texture_2d<f32>;
@group(0) @binding(${bindings.sampler}) var final_linear_clamp: sampler;
`;
  const grading = !options.colorGrading ? "" : `
fn final_grade(input: vec3f) -> vec3f {
  let slope = input * final_effects.gain + final_effects.lift;
  var color = pow(
    max(slope, vec3f(0.0)),
    vec3f(1.0) / max(final_effects.gamma, vec3f(1e-4))
  );
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, final_effects.saturation);
  return exp2(log2(max(color, vec3f(1e-5))) * final_effects.contrast);
}
`;
  const bloom = !options.bloom ? "" : `
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  color += textureSampleLevel(
    final_bloom,
    final_linear_clamp,
    uv,
    0.0
  ).rgb * final_effects.bloom_intensity;
`;
  const gradeCall = options.colorGrading ? "color = final_grade(color);" : "";
  const sharpen = !options.sharpening ? `
fn load_final_hdr(pixel: vec2i) -> vec4f {
  return load_post_color(pixel);
}
` : `
fn final_luminance(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.212639, 0.715169, 0.072192));
}

fn load_final_hdr(pixel: vec2i) -> vec4f {
  let center = load_post_color(pixel);
  let north = load_post_color(pixel + vec2i(0, -1)).rgb;
  let west = load_post_color(pixel + vec2i(-1, 0)).rgb;
  let east = load_post_color(pixel + vec2i(1, 0)).rgb;
  let south = load_post_color(pixel + vec2i(0, 1)).rgb;
  let average = (north + west + east + south) * 0.25;
  let local_contrast = abs(final_luminance(center.rgb) - final_luminance(average));
  let amount = clamp(final_effects.sharpening, 0.0, 1.0) *
    min(0.1875, local_contrast + 0.1875);
  return vec4f(
    max(center.rgb + (center.rgb - average) * amount, vec3f(0.0)),
    center.a
  );
}
`;
  return `
@group(0) @binding(0) var input_color: texture_2d<f32>;
${bloomBindings}
${effects}
${grading}
fn load_post_color(requested_pixel: vec2i) -> vec4f {
  let size = vec2i(textureDimensions(input_color));
  let pixel = clamp(requested_pixel, vec2i(0), size - vec2i(1));
  let source = textureLoad(input_color, pixel, 0);
  var color = max(source.rgb, vec3f(0.0));
${bloom}
  ${gradeCall}
  return vec4f(color, source.a);
}
${sharpen}
`;
}
