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
 * depth scatter. 8x8 Analyze uses a reconstructed 16x16 halo (7232 B total), two
 * uniform barriers; Resolve uses a 10x10 raw observation halo (1600 B), one
 * barrier. Radiance estimates and observation noise have separate responsibilities.
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
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
// State contains the last output-domain luminance observation and centered
// innovation variance. Color history is an accumulated estimate; it is never
// used as a previous observation when measuring illumination transport.
// Direct centered variance avoids subtracting two ~L*L f32 values at HDR L.
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
  let variances = max(vec4f(a.y, b.y, c.y, d.y), vec4f(0.0));
  let weights = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y, f.x * f.y);
  let mean = dot(means, weights);
  // Interpolate within-pixel innovation variance, not the variance of a
  // spatial mixture. A zero-variance HDR edge must remain zero-variance
  // when sampled fractionally; otherwise it falsely bypasses rectification.
  return vec2f(mean, dot(variances, weights));
}
`;

const RECONSTRUCTION = /* wgsl */ `

// One output-pixel estimand for both consumers. Source points are sampled at
// p + .5 - jitter; the reconstructed estimate is centered at output p + .5.
// Integrate the separable local quadratic interpolant over the unit output box.
// The first and second coordinate moments are j and j*j + 1/12. The bounded
// estimate is exact on locally quadratic radiance while its raw samples bound
// ringing. It makes no area-coverage claim at discontinuities or silhouettes.
fn source_index(p: vec2i) -> u32 {
  return u32(p.y * SOURCE_WIDTH + p.x);
}
fn integral_weight(offset: i32, fraction: f32) -> f32 {
  let second = fraction * fraction + 1.0 / 12.0;
  if (offset < 0) {
    return 0.5 * (second - fraction);
  }
  if (offset > 0) {
    return 0.5 * (second + fraction);
  }
  return 1.0 - second;
}
fn reconstruct(at: vec2i) -> vec3f {
  let fraction = frame.jitter - round(frame.jitter);
  var value = vec3f(0.0);
  var minimum = vec3f(3.402823466e38);
  var maximum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let rgb = source_tile[source_index(at + vec2i(x, y))].rgb;
      let weight = integral_weight(x, fraction.x) * integral_weight(y, fraction.y);
      value += rgb * weight;
      minimum = min(minimum, rgb);
      maximum = max(maximum, rgb);
    }
  }
  return clamp(value, minimum, maximum);
}
fn lanczos(x_in: f32) -> f32 {
  let x = min(abs(x_in), 2.0);
  if (x < 0.000061) {
    return 1.0;
  }
  let pi_x = 3.141592653589793 * x;
  return sin(pi_x) / pi_x * sin(pi_x * 0.5) / (pi_x * 0.5);
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

`;

export const NATIVE_TEMPORAL_V2_ANALYZE_WGSL =
  FRAME +
  RECONSTRUCTION +
  /* wgsl */ `
@group(0) @binding(7) var response: texture_2d<f32>;
@group(0) @binding(8) var identity: texture_2d<u32>;
@group(0) @binding(9) var previous_identity: texture_2d<u32>;
@group(0) @binding(10) var previous_depth: texture_2d<f32>;
// Analyze products
@group(0) @binding(11) var analysis: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var current_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;
const SOURCE_WIDTH: i32 = 18;
var<workgroup> source_tile: array<vec4f, 324>;
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
  let shift = vec2i(round(frame.jitter));
  // Populate source points once. Every lane reaches both barriers, including
  // lanes outside a partial output extent. The extra one-point halo supports
  // the same 3x3 reconstruction used by Resolve.
  for (var i = lane; i < 324u; i += 64u) {
    let raw = point(origin - 1 + shift + vec2i(i32(i % 18u), i32(i / 18u)));
    source_tile[i] = vec4f(max(textureLoad(current_color, raw, 0).rgb / current_p(), vec3f(0.0)), 0.0);
  }
  workgroupBarrier();
  for (var i = lane; i < 256u; i += 64u) {
    let local_pixel = vec2i(i32(i % 16u), i32(i / 16u));
    let p = point(origin + local_pixel);
    let value = scene_luma(reconstruct(local_pixel + 1));
    let facts = textureLoad(seed, point(p + shift), 0);
    let motion = facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter);
    let history_pixel = vec2f(p) - motion;
    let history_uv = (history_pixel + 0.5) / vec2f(frame.size);
    // Pull the last observation, not the temporally averaged color estimate.
    let prior = state_at(history_uv).x;
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
  let receiver = point(p + shift);
  let facts = textureLoad(seed, receiver, 0);
  let native = textureLoad(response, receiver, 0);
  let current = textureLoad(identity, receiver, 0);
  // Geometry is tested in the original jittered point domain. Radiance
  // and moments are reprojected in the unjittered output-pixel domain.
  let uv = (vec2f(receiver) + 0.5) / vec2f(frame.size) - facts.xy;
  var eligible = frame.valid != 0u && native.y > 0.5 && inside(uv);
  let prior = textureLoad(previous_identity, point(vec2i(uv * vec2f(frame.size))), 0);
  let hard = prior.x == current.x && (prior.y != current.y ||
    (prior.w == current.w && prior.z != current.z));
  eligible = eligible && !hard;
  var reactive = native.x;
  let pixel_motion = facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter);
  var footprint_velocity = length(pixel_motion);
  var slopes: array<f32, 4>;
  var continuous: array<bool, 4>;
  let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  for (var i = 0u; i < 4u; i++) {
    let neighbor = textureLoad(identity, point(receiver + offsets[i]), 0);
    if (native.z > 0.5 && neighbor.x != current.x) {
      reactive = max(reactive, 0.1);
    }
    continuous[i] = all(neighbor == current);
    let neighbor_facts = textureLoad(seed, point(receiver + offsets[i]), 0);
    slopes[i] = neighbor_facts.z - facts.z;
    footprint_velocity = max(footprint_velocity, length((neighbor_facts.xy - facts.xy) * vec2f(frame.size)));
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
  var change3 = 0.0;
  var delta_second3 = 0.0;
  var cross3 = 0.0;
  var prior_second3 = 0.0;
  var current_second3 = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let i = tile_index(at + vec2i(x, y));
      let value = luminance[i];
      mean += value;
      change3 += difference[i];
      delta_second3 += difference[i] * difference[i];
      let prior = value - difference[i];
      cross3 += value * prior;
      prior_second3 += prior * prior;
      current_second3 += value * value;
    }
  }
  mean /= 9.0;
  var change4 = 0.0;
  var change8 = 0.0;
  var delta_second4 = 0.0;
  var delta_second8 = 0.0;
  var cross4 = 0.0;
  var prior_second4 = 0.0;
  var current_second4 = 0.0;
  var cross8 = 0.0;
  var prior_second8 = 0.0;
  var current_second8 = 0.0;
  for (var y = -4; y < 4; y++) {
    for (var x = -4; x < 4; x++) {
      let delta = difference[tile_index(at + vec2i(x, y))];
      let value = luminance[tile_index(at + vec2i(x, y))];
      let prior = value - delta;
      change8 += delta;
      delta_second8 += delta * delta;
      cross8 += value * prior;
      prior_second8 += prior * prior;
      current_second8 += value * value;
      if (x >= -2 && x < 2 && y >= -2 && y < 2) {
        change4 += delta;
        delta_second4 += delta * delta;
        cross4 += value * prior;
        prior_second4 += prior * prior;
        current_second4 += value * value;
      }
    }
  }
  // The 3/4 and 4/8 support pairs describe local and broad changes. Requiring
  // a local light patch to fill the 8x8 support would erase its evidence.
  let local_difference = select(0.0, min(abs(change3 / 9.0), abs(change4 / 16.0)), change3 * change4 > 0.0);
  let broad_difference = select(0.0, min(abs(change4 / 16.0), abs(change8 / 64.0)), change4 * change8 > 0.0);
  // Test the paired innovation, not the spatial radiance variance. A textured
  // surface can change lighting coherently while retaining high spatial variance.
  // Overlapping reconstruction supports reduce the effective sample count;
  // use one independent observation per four points. This is confidence in a
  // change hypothesis, never a multiplier applied to accumulated history RGB.
  let variance3 = max(delta_second3 / 9.0 - (change3 / 9.0) * (change3 / 9.0), 0.0);
  let variance4 = max(delta_second4 / 16.0 - (change4 / 16.0) * (change4 / 16.0), 0.0);
  let variance8 = max(delta_second8 / 64.0 - (change8 / 64.0) * (change8 / 64.0), 0.0);
  let local_noise = 2.0 * max(sqrt(variance3 / 2.25), sqrt(variance4 / 4.0));
  let broad_noise = 2.0 * max(sqrt(variance4 / 4.0), sqrt(variance8 / 16.0));
  let history_uv = (vec2f(p) + 0.5 - pixel_motion) / vec2f(frame.size);
  let moments = state_at(history_uv);
  let observation_noise = sqrt(max(moments.y, 0.0));
  let rounding_floor = max(mean * 0.003, 1e-6);
  let local_change = clamp(1.0 - (max(local_noise, observation_noise) + rounding_floor) / max(local_difference, 1e-6), 0.0, 1.0);
  let broad_change = clamp(1.0 - (max(broad_noise, observation_noise) + rounding_floor) / max(broad_difference, 1e-6), 0.0, 1.0);
  var change = max(local_change, broad_change);
  var discontinuity = false;
  for (var i = 0u; i < 4u; i++) {
    discontinuity = discontinuity || !continuous[i] ||
      abs(slopes[i]) > max(facts.z * 2e-5, slope * 2.0);
  }
  let moving_edge = discontinuity && footprint_velocity > 0.1;
  // A moving geometric footprint is not an illumination step. Depth support
  // and rectification own its history confidence; neighborhood radiance means
  // span different surfaces at this boundary and cannot prove light change.
  if (moving_edge) {
    change = 0.0;
  }
  // A shape-preserving gain is fitted to two consecutive observations. A
  // cumulative estimate is not fed into this fit, avoiding lag feedback.
  // Symmetric norm ratios do not introduce the one-way attenuation of a
  // least-squares slope when both observations contain sampling noise.
  let gain3 = sqrt(current_second3 / max(prior_second3, 1e-12));
  let gain4 = sqrt(current_second4 / max(prior_second4, 1e-12));
  let gain8 = sqrt(current_second8 / max(prior_second8, 1e-12));
  let agreement3 = cross3 * cross3 / max(current_second3 * prior_second3, 1e-12);
  let agreement8 = cross8 * cross8 / max(current_second8 * prior_second8, 1e-12);
  let local_trust = clamp((agreement3 - 0.99) / 0.01, 0.0, 1.0) *
    clamp(1.0 - abs(gain3 - gain4) / 0.05, 0.0, 1.0);
  let broad_trust = clamp((agreement8 - 0.99) / 0.01, 0.0, 1.0) *
    clamp(1.0 - abs(gain4 - gain8) / 0.05, 0.0, 1.0);
  let gain = select(gain8, gain3, local_trust > broad_trust);
  let gain_trust = max(local_trust, broad_trust) * select(0.0, 1.0, eligible && !moving_edge);
  // Model confidence controls history mass, not the physical gain value. A
  // partially supported 4x observation must not become an invented 3x light.
  let transport = gain_trust > 0.5;
  let illumination = select(0.0, clamp(log2(max(gain, 1e-6)), -4.0, 4.0), transport);
  if (transport) {
    change = max(change * (1.0 - gain_trust), 1.0 - gain_trust);
  }
  textureStore(analysis, p, vec4f(select(0.0, coverage, eligible), reactive, change, illumination));
  textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));
}
`;

export const NATIVE_TEMPORAL_V2_RESOLVE_WGSL =
  FRAME +
  RECONSTRUCTION +
  /* wgsl */ `
@group(0) @binding(7) var analysis: texture_2d<f32>;
@group(0) @binding(8) var output_color: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var output_state: texture_storage_2d<rg32float, write>;
const SOURCE_WIDTH: i32 = 10;
var<workgroup> source_tile: array<vec4f, 100>;
fn to_ycocg(rgb: vec3f) -> vec3f {
  return vec3f(dot(rgb, vec3f(0.25, 0.5, 0.25)), 0.5 * (rgb.r - rgb.b),
    dot(rgb, vec3f(-0.25, 0.5, -0.25)));
}
fn to_rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u) {
  let origin = vec2i(group.xy * 8u);
  let shift = vec2i(round(frame.jitter));
  for (var i = lane; i < 100u; i += 64u) {
    let raw = point(origin - 1 + shift + vec2i(i32(i % 10u), i32(i / 10u)));
    source_tile[i] = vec4f(max(textureLoad(current_color, raw, 0).rgb / current_p(), vec3f(0.0)), 0.0);
  }
  workgroupBarrier();
  if (any(id.xy >= frame.size)) {
    return;
  }
  let p = vec2i(id.xy);
  let source_pixel = point(p + shift);
  let facts = textureLoad(seed, source_pixel, 0);
  let masks = textureLoad(analysis, p, 0);
  let pixel_motion = facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter);
  let history_pixel = vec2f(id.xy) - pixel_motion;
  let uv = (history_pixel + 0.5) / vec2f(frame.size);
  let coverage = masks.x;
  let change = max(masks.y, masks.z);
  let supported = frame.valid != 0u && coverage > 0.0 && change < 1.0 && inside(uv);
  var old = vec4f(0.0);
  if (supported) {
    old = history_at(history_pixel);
  }
  let at = vec2i(local.xy) + 1;
  let current_rgb = reconstruct(at);
  let current = to_ycocg(current_rgb);
  var center = vec3f(0.0);
  var second = vec3f(0.0);
  var weight_sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = at + vec2i(x, y);
      let value = to_ycocg(source_tile[source_index(q)].rgb);
      let offset = vec2f(f32(x), f32(y)) - (frame.jitter - round(frame.jitter));
      let weight = exp(-2.3 * dot(offset, offset));
      center += value * weight;
      second += value * value * weight;
      weight_sum += weight;
    }
  }
  center /= weight_sum;
  let spatial_variance = max(second / weight_sum - center * center, vec3f(0.0));
  let prior_moments = state_at(uv);
  let illumination = exp2(masks.w);
  let temporal_sigma = sqrt(max(0.0, prior_moments.y)) * illumination;
  var history = to_ycocg(max(old.rgb / previous_p() * illumination, vec3f(0.0)));
  // The box uses the current spatial observation distribution. Its variance
  // and the temporal jitter-observation variance describe uncertainty of this
  // phase, not uncertainty of the accumulated color estimator. They may relax
  // rejection of already observed history but never manufacture radiance.
  let velocity = length(pixel_motion);
  // The current phase alone can contain no line sample anywhere in the local
  // spatial window. Its zero spatial variance cannot disprove already observed
  // temporal variation at this output footprint. Include that variation in
  // rectification, without replacing or lifting the actual history color.
  // Project scalar luminance uncertainty along observed chromatic directions;
  // all factors are bounded for nonnegative RGB. Rejection/change own support.
  let observed_luma = max(scene_luma(to_rgb(center)), scene_luma(to_rgb(history)));
  let direction = max(abs(center), abs(history)) / max(observed_luma, 1e-8);
  let temporal_support = select(0.0, coverage * (1.0 - change), supported);
  let deviation = sqrt(spatial_variance + direction * direction *
    temporal_sigma * temporal_sigma * temporal_support);
  let scale = mix(3.0, 1.0, max(clamp(velocity / 10.0, 0.0, 1.0), change));
  let box = max(deviation * vec3f(1.7, 1.0, 1.0) * scale, vec3f(1.193e-7));
  let transformed = (history - center) / box;
  if (length(transformed) > 1.0) {
    history = normalize(transformed) * box + center;
  }
  // Alpha carries effective observation mass. Growing it by an unrelated
  // 1/3 while adding only .74/16 radiance weight overtrusted the initial phase.
  // The same mass now governs accumulation and the next frame's confidence.
  let observation_mass = 0.74 / 16.0;
  let history_weight = select(0.0,
    min(old.a, mix(old.a, 0.15, clamp(velocity / 0.25, 0.0, 1.0))) * coverage * (1.0 - change), supported);
  let confidence = clamp(history_weight + observation_mass, 0.0, 1.0);
  let current_weight = select(1.0, observation_mass, supported);
  let alpha = current_weight / max(current_weight + history_weight, 0.000061);
  let result = max(to_rgb(mix(history, current, alpha)), vec3f(0.0));
  // Keep the last observation separate from color estimation. Subtract the
  // supported illumination transport before estimating stationary process noise.
  let value = scene_luma(current_rgb);
  var variance = 0.0;
  if (supported) {
    let innovation = value - prior_moments.x * illumination;
    variance = mix(prior_moments.y * illumination * illumination,
      0.5 * innovation * innovation, 0.125) * (1.0 - change);
  }
  let moments = vec2f(value, variance);
  textureStore(output_color, p, vec4f(result * current_p(), confidence));
  textureStore(output_state, p, vec4f(moments, 0.0, 0.0));
}
`;
