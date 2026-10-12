/** Native-resolution port of NVIDIA Donut TAA (single sample, Catmull-Rom).
 * Source: e50042f4bbd762971cc90431261e967404855b81, shaders/passes/taa_cs.hlsl.
 * Native qualification/own motion and scene-linear exposure are explicit
 * integration differences. Feedback is PQ; RCAS consumes a distinct HDR output.
 * Manual point filtering avoids requiring float32-filterable. See source map.
 *
 * Copyright (c) 2014-2021, NVIDIA CORPORATION. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
export const NATIVE_TEMPORAL_V2_DONUT_PROFILE = Object.freeze({
  revision: "e50042f4bbd762971cc90431261e967404855b81",
  newFrameWeight: 0.1,
  clampingFactor: 1,
  // Source host range is 1e-4..1e8. Its upper bound covers physical HDR;
  // this is still a bounded profile, not an unbounded radiance claim.
  maxRadiance: 1e8,
});

const FRAME = /* wgsl */ `
struct TemporalFrame {
  size: vec2u,
  valid: u32,
  padding: u32,
  jitter: vec2f,
  previous_jitter: vec2f,
}
@group(0) @binding(0) var<uniform> frame: TemporalFrame;
@group(0) @binding(2) var seed: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> current_exposure: array<f32>;
fn current_p() -> f32 {
  return max(current_exposure[0], 1e-8);
}
fn point(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(frame.size) - 1);
}
fn on_screen(p: vec2i) -> bool {
  return all(p >= vec2i(0)) && all(p < vec2i(frame.size));
}
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
`;

// Language port of PQEncode/PQDecode and BicubicSampleCatmullRom's weights.
export const NATIVE_TEMPORAL_V2_DONUT_MATH_WGSL = /* wgsl */ `
const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;
const PQ_MAX: f32 = ${NATIVE_TEMPORAL_V2_DONUT_PROFILE.maxRadiance}.0;
fn pq_encode(image: vec3f) -> vec3f {
  let lm = pow(max(image / PQ_MAX, vec3f(0.0)), vec3f(PQ_M1));
  let n = (vec3f(PQ_C1) + PQ_C2 * lm) / (vec3f(1.0) + PQ_C3 * lm);
  return clamp(pow(n, vec3f(PQ_M2)), vec3f(0.0), vec3f(1.0));
}
fn pq_decode(image: vec3f) -> vec3f {
  let np = pow(max(image, vec3f(0.0)), vec3f(1.0 / PQ_M2));
  let l = (np - vec3f(PQ_C1)) / (vec3f(PQ_C2) - PQ_C3 * np);
  return pow(max(l, vec3f(0.0)), vec3f(1.0 / PQ_M1)) * PQ_MAX;
}
fn catmull_weights(f: f32) -> vec4f {
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = f2 - 0.5 * (f3 + f);
  let w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  let w3 = 0.5 * (f3 - f2);
  return vec4f(w0, w1, 1.0 - w0 - w1 - w3, w3);
}
`;

export const NATIVE_TEMPORAL_V2_ANALYZE_WGSL =
  FRAME +
  /* wgsl */ `
@group(0) @binding(7) var response: texture_2d<f32>;
@group(0) @binding(8) var identity: texture_2d<u32>;
@group(0) @binding(9) var previous_identity: texture_2d<u32>;
@group(0) @binding(10) var previous_depth: texture_2d<f32>;
@group(0) @binding(11) var analysis: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var current_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= frame.size)) {
    return;
  }
  let p = vec2i(id.xy);
  let receiver = point(p + vec2i(round(frame.jitter)));
  let facts = textureLoad(seed, receiver, 0);
  let native = textureLoad(response, receiver, 0);
  let current = textureLoad(identity, receiver, 0);
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
  if (!sky && min_depth > 0.0 && min_depth < facts.z - max(facts.z * 2e-5, slope * 1.5)) {
    coverage = 0.0;
  }
  textureStore(analysis, p, vec4f(select(0.0, coverage, eligible), reactive, 0.0, 0.0));
  // Geometry histories retain their raw input lattice, independent of color.
  textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));
  if (all(id.xy == vec2u(0u))) {
    textureStore(sharpen_exposure, vec2i(0), vec4f(1.0 / current_p(), 0.0, 0.0, 0.0));
  }
}
`;

export const NATIVE_TEMPORAL_V2_RESOLVE_WGSL =
  FRAME +
  NATIVE_TEMPORAL_V2_DONUT_MATH_WGSL +
  /* wgsl */ `
@group(0) @binding(1) var current_color: texture_2d<f32>;
@group(0) @binding(3) var previous_color: texture_2d<f32>;
@group(0) @binding(7) var analysis: texture_2d<f32>;
@group(0) @binding(8) var output_color: texture_storage_2d<rgba32float, write>;
@group(0) @binding(9) var output_hdr: texture_storage_2d<rgba16float, write>;
var<workgroup> source_tile: array<vec3f, 100>;
fn source_index(p: vec2i) -> u32 {
  return u32(p.y * 10 + p.x);
}
fn feedback_load(p: vec2i) -> vec3f {
  // Source sampler has a zero border, not clamp-to-edge.
  if (!on_screen(p)) {
    return vec3f(0.0);
  }
  return textureLoad(previous_color, p, 0).rgb;
}
fn history_at(sample: vec2f) -> vec3f {
  let base = vec2i(floor(sample));
  let fraction = fract(sample);
  let wx = catmull_weights(fraction.x);
  let wy = catmull_weights(fraction.y);
  var result = vec3f(0.0);
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      result += feedback_load(base + vec2i(x - 1, y - 1)) * wx[x] * wy[y];
    }
  }
  return max(result, vec3f(0.0));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u) {
  let shift = vec2i(round(frame.jitter));
  let origin = vec2i(group.xy * 8u) + shift - 1;
  for (var i = lane; i < 100u; i += 64u) {
    let raw = origin + vec2i(i32(i % 10u), i32(i / 10u));
    var value = vec3f(0.0);
    if (on_screen(raw)) {
      value = textureLoad(current_color, raw, 0).rgb / current_p();
    }
    source_tile[i] = pq_encode(value);
  }
  workgroupBarrier();
  if (any(id.xy >= frame.size)) {
    return;
  }
  let p = vec2i(id.xy);
  let at = vec2i(local.xy) + 1;
  let source_pixel = point(p + shift);
  let facts = textureLoad(seed, source_pixel, 0);
  let masks = textureLoad(analysis, p, 0);
  let motion = facts.xy * vec2f(frame.size) - (frame.jitter - frame.previous_jitter);
  let history_pixel = vec2f(p) - motion;
  let uv = (history_pixel + 0.5) / vec2f(frame.size);
  let current = source_tile[source_index(at)];
  var first = vec3f(0.0);
  var second = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let color = source_tile[source_index(at + vec2i(x, y))];
      first += color;
    }
  }
  first /= 9.0;
  // Same population variance as the donor's E[x*x]-E[x]*E[x]. Evaluate
  // it centered in f32 so a constant PQ neighborhood cannot acquire a
  // spurious sqrt(roundoff) clamp radius. This is a numeric representation
  // adaptation, not an added temporal estimator or a changed sample domain.
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let delta = source_tile[source_index(at + vec2i(x, y))] - first;
      second += delta * delta;
    }
  }
  second /= 9.0;
  let sigma = sqrt(max(vec3f(0.0), second)) * ${NATIVE_TEMPORAL_V2_DONUT_PROFILE.clampingFactor}.0;
  let minimum = first - sigma;
  let maximum = first + sigma;
  var result_pq = current;
  let supported = frame.valid != 0u && masks.x > 0.0 && masks.y < 1.0 && inside(uv);
  if (supported) {
    let history = history_at(history_pixel);
    let clamped_history = clamp(history, minimum, maximum);
    let motion_weight = smoothstep(0.0, 1.0, length(motion));
    let distance = frame.jitter - round(frame.jitter);
    let sample_weight = clamp(1.0 - dot(distance, distance), 0.0, 1.0);
    let source_weight = clamp(max(motion_weight, sample_weight) * ${NATIVE_TEMPORAL_V2_DONUT_PROFILE.newFrameWeight}, 0.0, 1.0);
    // Native qualification only removes rejected source history weight.
    let accepted_history = clamp(masks.x, 0.0, 1.0) * (1.0 - masks.y);
    let blend_weight = 1.0 - (1.0 - source_weight) * accepted_history;
    result_pq = mix(clamped_history, current, blend_weight);
  }
  let result = pq_decode(result_pq);
  textureStore(output_color, p, vec4f(result_pq, 0.0));
  textureStore(output_hdr, p, vec4f(result * current_p(), 1.0));
}
`;
