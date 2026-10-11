/** AMD-derived filter mathematics; other V5 logic is local.
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
/** V5 native-resolution candidate. No geometry reconstruction or same-frame
 * depth scatter. 8x8 Analyze uses two 16x16 f32 halo tiles (2 KiB), one uniform
 * barrier; Resolve streams current 3x3 and fractional history 4x4 support.
 * Depth and RG32 moment inputs use point loads, without float32-filterable.
 * Not selected by production until the complete phase quality gate passes. */
const FRAME = /* wgsl */ `
struct TemporalFrame {
  size: vec2u,
  valid: u32,
  padding: u32,
  jitter: vec2f,
  previous_jitter: vec2f,
}
// Frame coordinates
@group(0) @binding(0) var<uniform> frame: TemporalFrame;
// Native inputs
@group(0) @binding(1) var current_color: texture_2d<f32>;
@group(0) @binding(2) var seed: texture_2d<f32>;
// Effect-private history
@group(0) @binding(3) var previous_color: texture_2d<f32>;
@group(0) @binding(4) var previous_state: texture_2d<f32>;
// Physical exposure publication
@group(0) @binding(5) var<storage, read> current_exposure: array<f32>;
@group(0) @binding(6) var<storage, read> previous_exposure: array<f32>;
fn current_p() -> f32 {
  return max(current_exposure[0], 1e-8);
}
fn previous_p() -> f32 {
  return max(previous_exposure[0], 1e-8);
}
fn point(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(frame.size) - 1);
}
// Reproject the frontmost local contributor at mixed geometric footprints.
// Only Seed depth/motion are selected: geometry is never reconstructed here.
fn temporal_receiver(p: vec2i) -> vec2i {
  var receiver = p;
  var closest = textureLoad(seed, p, 0).w;
  // The unjittered pixel lies in this 2x2 current sampling footprint.
  // Side-lobe neighbors outside it do not own its reprojection motion.
  let fraction = frame.jitter - round(frame.jitter);
  let direction = vec2i(sign(fraction));
  let offsets = array<vec2i, 3>(vec2i(direction.x, 0), vec2i(0, direction.y), direction);
  for (var i = 0u; i < 3u; i++) {
    let q = point(p + offsets[i]);
    let depth = textureLoad(seed, q, 0).w;
    if (depth > 0.0 && (closest == 0.0 || depth < closest)) {
      receiver = q;
      closest = depth;
    }
  }
  return receiver;
}
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
// Raw point samples accumulate moments at the output footprint; that
// distribution must not be transported as a fixed jittered sampling grid.
// Moments use scene-linear luminance after removing physical P. f32
// preserves HDR distinctions. Finite rgba16 input and P >= 1e-8 keep squares finite.
fn scene_luma(rgb: vec3f) -> f32 {
  return dot(max(rgb, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
}
fn state_at(uv: vec2f) -> vec2f {
  let p = uv * vec2f(frame.size) - 0.5;
  let base = vec2i(floor(p));
  let f = fract(p);
  let a = textureLoad(previous_state, point(base), 0).xy;
  let b = textureLoad(previous_state, point(base + vec2i(1, 0)), 0).xy;
  let c = textureLoad(previous_state, point(base + vec2i(0, 1)), 0).xy;
  let d = textureLoad(previous_state, point(base + vec2i(1, 1)), 0).xy;
  let means = vec4f(a.x, b.x, c.x, d.x);
  let variances = max(vec4f(a.y, b.y, c.y, d.y) - means * means, vec4f(0.0));
  let weights = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y, f.x * f.y);
  let mean = dot(means, weights);
  // Interpolate within-pixel temporal variance, not the variance of a
  // spatial mixture. A zero-variance HDR edge must remain zero-variance
  // when sampled fractionally; otherwise it falsely bypasses rectification.
  return vec2f(mean, mean * mean + dot(variances, weights));
}
`;

export const NATIVE_TEMPORAL_V2_ANALYZE_WGSL =
  FRAME +
  /* wgsl */ `
@group(0) @binding(7) var response: texture_2d<f32>;
@group(0) @binding(8) var identity: texture_2d<u32>;
@group(0) @binding(9) var previous_identity: texture_2d<u32>;
@group(0) @binding(10) var previous_depth: texture_2d<f32>;
// Analyze products
@group(0) @binding(11) var analysis: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var current_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(13) var linear_clamp: sampler;
@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;
var<workgroup> luminance: array<f32, 256>;
var<workgroup> difference: array<f32, 256>;
fn tile_index(p: vec2i) -> u32 {
  return u32(p.y * 16 + p.x);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u) {
  let origin = vec2i(group.xy * 8u) - 4;
  // All lanes initialize their four halo texels before the partial-domain guard.
  for (var i = lane; i < 256u; i += 64u) {
    let p = point(origin + vec2i(i32(i % 16u), i32(i / 16u)));
    let value = scene_luma(textureLoad(current_color, p, 0).rgb / current_p());
    let facts = textureLoad(seed, p, 0);
    let uv = (vec2f(p) + 0.5) / vec2f(frame.size) - facts.xy;
    let history_uv = uv - frame.previous_jitter / vec2f(frame.size);
    let prior = scene_luma(textureSampleLevel(previous_color, linear_clamp,
      clamp(history_uv, vec2f(0.5) / vec2f(frame.size), vec2f(1.0) - vec2f(0.5) / vec2f(frame.size)), 0.0).rgb / previous_p());
    luminance[i] = value;
    difference[i] = value - prior;
  }
  workgroupBarrier();
  if (any(id.xy >= frame.size)) {
    return;
  }
  if (all(id.xy == vec2u(0u))) {
    textureStore(sharpen_exposure, vec2i(0), vec4f(1.0 / current_p(), 0.0, 0.0, 0.0));
  }
  let p = vec2i(id.xy);
  let at = vec2i(local.xy) + 4;
  let receiver = temporal_receiver(p);
  let facts = textureLoad(seed, receiver, 0);
  let native = textureLoad(response, receiver, 0);
  let current = textureLoad(identity, receiver, 0);
  // The selected Seed describes q, not the output footprint p. Validate
  // its previous geometry at q's projected location; reproject color at p.
  let uv = (vec2f(receiver) + 0.5) / vec2f(frame.size) - facts.xy;
  var eligible = frame.valid != 0u && native.y > 0.5 && inside(uv);
  let prior = textureLoad(previous_identity, point(vec2i(uv * vec2f(frame.size))), 0);
  let hard = prior.x == current.x && (prior.y != current.y ||
    (prior.w == current.w && prior.z != current.z));
  eligible = eligible && !hard;
  var reactive = native.x;
  var slopes: array<f32, 4>;
  var continuous: array<bool, 4>;
  let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  for (var i = 0u; i < 4u; i++) {
    let neighbor = textureLoad(identity, point(receiver + offsets[i]), 0);
    if (native.z > 0.5 && neighbor.x != current.x) {
      reactive = max(reactive, 0.1);
    }
    continuous[i] = all(neighbor == current);
    slopes[i] = textureLoad(seed, point(receiver + offsets[i]), 0).z - facts.z;
  }
  // One-sided jumps do not prove a plane slope, even inside one instance.
  // Opposite signed, two-sided differences establish local continuous support.
  var slope = 0.0;
  for (var axis = 0u; axis < 2u; axis++) {
    let a = axis * 2u;
    let b = a + 1u;
    if (continuous[a] && continuous[b] && slopes[a] * slopes[b] <= 0.0) {
      slope += min(abs(slopes[a]), abs(slopes[b]));
    }
  }
  let sample = uv * vec2f(frame.size) - 0.5;
  let base = vec2i(floor(sample));
  let fraction = fract(sample);
  var coverage = 0.0;
  var min_depth = 3.402823466e38;
  let sky = current.x == 0xffffffffu;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let z = textureLoad(previous_depth, point(base + vec2i(x, y)), 0).x;
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) *
        select(1.0 - fraction.y, fraction.y, y == 1);
      let tolerance = max(2e-5 * max(z, facts.z), slope * 1.5);
      let depth_matches = select(z > 0.0 && abs(z - facts.z) <= tolerance, z == 0.0, sky);
      coverage += select(0.0, weight, depth_matches);
      if (weight > 0.00061) {
        min_depth = min(min_depth, z);
      }
    }
  }

  // A nearer history sample is an occluder, not fractional confidence in
  // the current background. A farther tap at a foreground edge may belong
  // to the uncovered footprint and is handled by color rectification.
  if (!sky && min_depth > 0.0 && min_depth < facts.z - max(facts.z * 2e-5, slope * 1.5)) {
    coverage = 0.0;
  }
  var mean = 0.0;
  var second = 0.0;
  var minimum = 3.402823466e38;
  var maximum = 0.0;
  var prior_second3 = 0.0;
  var change3 = 0.0;
  var positive = 0u;
  var negative = 0u;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let i = tile_index(at + vec2i(x, y));
      let value = luminance[i];
      mean += value;
      second += value * value;
      minimum = min(minimum, value);
      maximum = max(maximum, value);
      let prior_value = value - difference[i];
      prior_second3 += prior_value * prior_value;
      change3 += difference[i];
      positive += select(0u, 1u, difference[i] > 0.05);
      negative += select(0u, 1u, difference[i] < -0.05);
    }
  }
  mean /= 9.0;
  let deviation = sqrt(max(0.0, second / 9.0 - mean * mean));
  var change4 = 0.0;
  var positive4 = 0u;
  var negative4 = 0u;
  var change8 = 0.0;
  var mean4 = 0.0;
  var mean8 = 0.0;
  var second8 = 0.0;
  var prior_second8 = 0.0;
  var cross8 = 0.0;
  for (var y = -4; y < 4; y++) {
    for (var x = -4; x < 4; x++) {
      let delta = difference[tile_index(at + vec2i(x, y))];
      let value = luminance[tile_index(at + vec2i(x, y))];
      let prior_value = value - delta;
      change8 += delta;
      mean8 += value;
      second8 += value * value;
      prior_second8 += prior_value * prior_value;
      cross8 += value * prior_value;
      if (x >= -2 && x < 2 && y >= -2 && y < 2) {
        change4 += delta;
        mean4 += luminance[tile_index(at + vec2i(x, y))];
        positive4 += select(0u, 1u, delta > 0.05);
        negative4 += select(0u, 1u, delta < -0.05);
      }
    }
  }
  let history_uv = (vec2f(p) + 0.5) / vec2f(frame.size) - facts.xy -
    frame.previous_jitter / vec2f(frame.size);
  let moments = state_at(history_uv);
  let temporal_sigma = sqrt(max(0.0, moments.y - moments.x * moments.x));
  let coherent_difference = max(abs(change3 / 9.0), max(abs(change4 / 16.0), abs(change8 / 64.0)));
  let prior_mean3 = mean - change3 / 9.0;
  let prior_deviation3 = sqrt(max(0.0, prior_second3 / 9.0 - prior_mean3 * prior_mean3));
  let spatial_noise = max(deviation, prior_deviation3);
  let noise = max(spatial_noise, temporal_sigma);
  var change = clamp((coherent_difference - max(spatial_noise * 0.5, temporal_sigma * 2.0)) / max(0.05, noise + mean * 0.1), 0.0, 1.0);
  if ((positive >= 8u && positive4 == 16u) || (negative >= 8u && negative4 == 16u)) {
    change = max(change, clamp(abs(change3 / 9.0) / max(0.05, spatial_noise + mean * 0.1), 0.0, 1.0));
  }
  if (change3 * change4 > 0.0 && change4 * change8 > 0.0) {
    let relative = min(abs(change3) / max(mean * 9.0, 1e-6),
      min(abs(change4) / max(mean4, 1e-6), abs(change8) / max(mean8, 1e-6)));
    let periodic = clamp(max(temporal_sigma / max(moments.x, 0.05),
      spatial_noise / max(max(mean, prior_mean3), 0.05)), 0.0, 1.0);
    change = max(change, clamp((relative - 0.01) * 10.0, 0.0, 1.0) * (1.0 - periodic));
  }
  var discontinuity = false;
  for (var i = 0u; i < 4u; i++) {
    discontinuity = discontinuity || !continuous[i] ||
      abs(slopes[i]) > max(facts.z * 2e-5, slope * 2.0);
  }
  let pixel_velocity = length(facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter));
  let moving_edge = discontinuity && pixel_velocity > 0.1;
  // A moving geometric footprint is not an illumination step. Depth support
  // and rectification own its history confidence; neighborhood radiance means
  // span different surfaces at this boundary and cannot prove light change.
  if (moving_edge) {
    change = 0.0;
  }
  // An illumination gain preserves neighborhood shape. Reproject its scalar
  // amplitude as well as its position, without resetting spatial AA detail.
  let agreement = cross8 * cross8 / max(second8 * prior_second8, 1e-12);
  let gain3 = mean / max(prior_mean3, 1e-6);
  let gain4 = mean4 / max(mean4 - change4, 1e-6);
  let gain8 = mean8 / max(mean8 - change8, 1e-6);
  let gain_spread = abs(gain4 - gain8);
  let gain_trust = clamp((agreement - 0.99) / 0.01, 0.0, 1.0) *
    clamp(1.0 - gain_spread / 0.05, 0.0, 1.0);
  let signed_gain = (gain3 - 1.0) * (gain4 - 1.0) > 0.0 &&
    (gain4 - 1.0) * (gain8 - 1.0) > 0.0;
  let gain_signal = min(abs(gain3 - 1.0), min(abs(gain4 - 1.0), abs(gain8 - 1.0)));
  let illumination = clamp(log2(max(gain8, 1e-6)), -4.0, 4.0) * gain_trust *
    select(0.0, smoothstep(0.015, 0.02, gain_signal), signed_gain && !moving_edge);
  // Signed coverage preserves an edge fact without a fifth channel. Zero
  // always rejects; a negative magnitude denotes a geometric discontinuity.
  let signed_coverage = select(coverage, -coverage, discontinuity);
  textureStore(analysis, p, vec4f(select(0.0, signed_coverage, eligible), reactive, change, illumination));
  textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));
}
`;

export const NATIVE_TEMPORAL_V2_RESOLVE_WGSL =
  FRAME +
  /* wgsl */ `
@group(0) @binding(7) var analysis: texture_2d<f32>;
// Resolve products
@group(0) @binding(8) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var output_state: texture_storage_2d<rg32float, write>;
fn to_ycocg(rgb: vec3f) -> vec3f {
  return vec3f(dot(rgb, vec3f(0.25, 0.5, 0.25)), 0.5 * (rgb.r - rgb.b),
    dot(rgb, vec3f(-0.25, 0.5, -0.25)));
}
fn to_rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
fn lanczos(x_in: f32) -> f32 {
  let x = min(abs(x_in), 2.0);
  if (x < 0.000061) {
    return 1.0;
  }
  let pi_x = 3.141592653589793 * x;
  return sin(pi_x) / pi_x * sin(pi_x * 0.5) / (pi_x * 0.5);
}
// Integrate the three-point quadratic interpolant over a unit pixel box.
// E[t] = jitter and E[t^2] = jitter^2 + 1/12. The weights sum to one,
// preserve linear radiance, and reproduce the exact integral of a quadratic.
fn pixel_integral_weight(offset: i32, jitter: f32) -> f32 {
  let second = jitter * jitter + 1.0 / 12.0;
  if (offset < 0) {
    return 0.5 * (second - jitter);
  }
  if (offset > 0) {
    return 0.5 * (second + jitter);
  }
  return 1.0 - second;
}
// AMD SDK c6efa6bf history filter support, adapted to point/manual loads.
// Four by four streamed texels, center-range clamp, exact integer special case.
// Pixel coordinates avoid normalizing and denormalizing a large integer
// center, which can spuriously enter the sixteen-tap fractional path.
fn history_at(sample: vec2f) -> vec4f {
  let fraction = fract(sample);
  let base = vec2i(floor(sample));
  if (all(fraction == vec2f(0.0))) {
    return textureLoad(previous_color, point(base), 0);
  }
  var result = vec4f(0.0);
  var sum = 0.0;
  var minimum = vec4f(3.402823466e38);
  var maximum = vec4f(-3.402823466e38);
  for (var y = -1; y <= 2; y++) {
    for (var x = -1; x <= 2; x++) {
      let value = textureLoad(previous_color, point(base + vec2i(x, y)), 0);
      let weight = lanczos(f32(x) - fraction.x) * lanczos(f32(y) - fraction.y);
      result += value * weight;
      sum += weight;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        minimum = min(minimum, value);
        maximum = max(maximum, value);
      }
    }
  }
  return clamp(result / sum, minimum, maximum);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= frame.size)) {
    return;
  }
  let p = vec2i(id.xy);
  let shift = vec2i(round(frame.jitter));
  let source_pixel = point(p + shift);
  let facts = textureLoad(seed, temporal_receiver(source_pixel), 0);
  let masks = textureLoad(analysis, source_pixel, 0);
  let pixel_motion = facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter);
  let history_pixel = vec2f(id.xy) - pixel_motion;
  let uv = (history_pixel + 0.5) / vec2f(frame.size);
  let coverage = abs(masks.x);
  let continuous_surface = masks.x >= 0.0;
  // Illumination rejection affects history, not this frame's reconstruction.
  // Only missing geometry/identity support selects the bootstrap filter.
  let supported = frame.valid != 0u && coverage > 0.0 && masks.y < 1.0 && inside(uv);
  let valid = supported && masks.z < 1.0;
  var old = vec4f(0.0);
  if (valid) {
    old = history_at(history_pixel);
  }
  let point_luma = scene_luma(textureLoad(current_color, source_pixel, 0).rgb / current_p());
  var quadrant_deviation = vec4f(0.0);
  var local_luma_min = 3.402823466e38;
  var local_luma_max = 0.0;
  var minimum = vec3f(3.402823466e38);
  var maximum = vec3f(-3.402823466e38);
  var center = vec3f(0.0);
  var second = vec3f(0.0);
  var center_sum = 0.0;
  var reconstructed = vec3f(0.0);
  var reconstruction_sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let color = max(textureLoad(current_color, point(source_pixel + vec2i(x, y)), 0).rgb / current_p(), vec3f(0.0));
      let value = to_ycocg(color);
      // Preserve thin-feature morphology from the already streamed taps.
      // A coherent 2x2 plateau is not a thin feature merely because its
      // center differs from the 3x3 mean. No nine-element live array/load pass.
      let sample_luma = scene_luma(color);
      let delta = abs(sample_luma - point_luma);
      if (x <= 0 && y <= 0) {
        quadrant_deviation.x = max(quadrant_deviation.x, delta);
      }
      if (x >= 0 && y <= 0) {
        quadrant_deviation.y = max(quadrant_deviation.y, delta);
      }
      if (x <= 0 && y >= 0) {
        quadrant_deviation.z = max(quadrant_deviation.z, delta);
      }
      if (x >= 0 && y >= 0) {
        quadrant_deviation.w = max(quadrant_deviation.w, delta);
      }
      local_luma_min = min(local_luma_min, scene_luma(color));
      local_luma_max = max(local_luma_max, scene_luma(color));
      minimum = min(minimum, value);
      maximum = max(maximum, value);
      let offset = vec2f(f32(x), f32(y)) - (frame.jitter - vec2f(shift));
      let distance = dot(offset, offset);
      let gaussian = exp(-2.3 * distance);
      let statistic = value;
      center += statistic * gaussian;
      second += statistic * statistic * gaussian;
      center_sum += gaussian;
      let fractional_jitter = frame.jitter - vec2f(shift);
      var weight = pixel_integral_weight(x, fractional_jitter.x) *
        pixel_integral_weight(y, fractional_jitter.y);
      if (!continuous_surface) {
        // Geometric coverage boundaries retain the established radial support;
        // a quadratic irradiance model does not describe a silhouette step.
        let a = 0.4 * min(distance, 4.0) - 1.0;
        let b = 0.25 * min(distance, 4.0) - 1.0;
        weight = (1.5625 * a * a - 0.5625) * b * b;
      }
      reconstructed += value * weight;
      reconstruction_sum += weight;
    }
  }
  center /= center_sum;
  let deviation = sqrt(abs(second / center_sum - center * center));
  var current = clamp(reconstructed / max(reconstruction_sum, 0.000061), minimum, maximum);
  if (!supported) {
    current = center;
  }
  let change = max(masks.y, masks.z);
  let confidence = clamp(old.a * coverage * (1.0 - change) + 1.0 / 3.0, 0.0, 1.0);
  let velocity = length(pixel_motion);
  let luma_range = local_luma_max - local_luma_min;
  let thin = select(0.0, 1.0 - local_luma_min / max(local_luma_max, 1e-6),
    luma_range > 1e-6 && all(quadrant_deviation >= vec4f(luma_range * 0.9)));
  let illumination = exp2(masks.w);
  var history = to_ycocg(max(old.rgb / previous_p() * illumination, vec3f(0.0)));
  let prior_moments = state_at(uv) * vec2f(illumination, illumination * illumination);
  let temporal_sigma = sqrt(max(0.0, prior_moments.y - prior_moments.x * prior_moments.x));
  let intermittent = clamp(temporal_sigma * 4.0 / max(prior_moments.x, 0.05) - 1.0, 0.0, 1.0);
  // Temporal point moments bound the history without replacing it with
  // their phase-dependent mean. Retain a central variance interval.
  if (valid && continuous_surface && velocity < 0.1 && change == 0.0 && intermittent > 0.0) {
    let history_luma = scene_luma(to_rgb(history));
    let bounded_luma = max(history_luma, prior_moments.x);
    let ratio = clamp(bounded_luma / max(history_luma, 1e-6), 0.5, 2.0);
    history *= mix(1.0, ratio, intermittent);
  }
  let depth_limit = select(clamp(0.75 - facts.w / 20.0, 0.0, 1.0), 0.0, facts.w == 0.0);
  let scale = mix(3.0, 1.0, max(depth_limit, max(clamp(velocity / 10.0, 0.0, 1.0), change)));
  let box = max(deviation * vec3f(1.7, 1.0, 1.0) * scale, vec3f(1.193e-7));
  let transformed = (history - center) / box;
  if (length(transformed) > 1.0) {
    let clipped = normalize(transformed) * box + center;
    // Intermittent thin samples protect accumulated bright coverage on a
    // missing-sample phase. A history below the current lower envelope needs
    // newly observed evidence, rather than protection for an underlit start.
    let missing_sample = scene_luma(to_rgb(history)) > scene_luma(to_rgb(center));
    history = mix(clipped, history,
      select(0.0, max(thin * confidence, intermittent), continuous_surface && missing_sample) * (1.0 - change));
  }
  let reconstruction_weight = max(reconstruction_sum * 0.74 / 16.0, 0.000061);
  if (supported && continuous_surface) {
    // The raw temporal moment envelope also bounds reconstruction ringing.
    // Include this frame's point sample, so a genuine new signal is never
    // discarded merely because its old moments are small.
    let low = min(point_luma, max(0.0, prior_moments.x - temporal_sigma * 3.0));
    let high = max(point_luma, prior_moments.x + temporal_sigma * 3.0);
    let current_luma = scene_luma(to_rgb(current));
    let history_luma = scene_luma(to_rgb(history));
    let contrast = (local_luma_max - local_luma_min) / max(max(point_luma, prior_moments.x), 0.05);
    let ringing = clamp((contrast - 3.0) / 3.0, 0.0, 1.0);
    if (current_luma > 1e-6) {
      current *= mix(1.0, clamp(current_luma, low, high) / current_luma, ringing);
    }
    if (history_luma > 1e-6) {
      history *= mix(1.0, clamp(history_luma, low, high) / history_luma, ringing);
    }
  }
  let moving_history = select(0.15, mix(reconstruction_weight, 0.18, max(thin, intermittent)), continuous_surface);
  let history_weight = select(0.0,
    min(old.a, mix(old.a, moving_history, clamp(velocity / 0.25, 0.0, 1.0))) * coverage * (1.0 - change), valid);
  let current_weight = select(1.0, reconstruction_weight, valid);
  let alpha = current_weight / max(current_weight + history_weight, 0.000061);
  // Accumulate scene-linear radiance; Reinhard blending biases a fluctuating
  // HDR footprint toward its darker phases even with a stable inverse formula.
  let linear_result = max(to_rgb(mix(history, current, alpha)), vec3f(0.0));
  let history_rgb = max(to_rgb(history), vec3f(0.0));
  let current_rgb = max(to_rgb(current), vec3f(0.0));
  let history_peak = max(max(history_rgb.r, history_rgb.g), history_rgb.b);
  let current_peak = max(max(current_rgb.r, current_rgb.g), current_rgb.b);
  let numerator = mix(history_rgb * (9.6 + current_peak), current_rgb * (9.6 + history_peak), alpha);
  let denominators = mix((vec3f(9.6) + (vec3f(history_peak) - history_rgb)) * (9.6 + current_peak),
    (vec3f(9.6) + (vec3f(current_peak) - current_rgb)) * (9.6 + history_peak), alpha);
  let robust_result = numerator * 9.6 / min(min(denominators.r, denominators.g), denominators.b);
  // Limit transient HDR influence while evidence is still immature. Once the
  // history has accumulated confidence, preserve scene-linear signal energy.
  let result = mix(robust_result, linear_result, smoothstep(0.5, 1.0, old.a));
  let value = scene_luma(textureLoad(current_color, source_pixel, 0).rgb / current_p());
  var moments = vec2f(value, value * value);
  if (valid) {
    moments = mix(prior_moments, moments, max(0.125, change));
  }
  textureStore(output_color, p, vec4f(result * current_p(), confidence));
  textureStore(output_state, p, vec4f(moments, 0.0, 0.0));
}
`;
