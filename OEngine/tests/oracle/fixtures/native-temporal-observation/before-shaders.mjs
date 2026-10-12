/** Native-resolution temporal execution, retaining the SDK 1.1.4 reconstruction,
 * locks, four-frame luminance response, sixteen-point history and RCAS contract.
 * Native receiver classification and fused reconstruction are local
 * execution adaptations of AMD c6efa6bf7f2027b3ec94f28578bb5965eabb9e55.
 *
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
const FRAME = /* wgsl */ `
struct NativeFilterWeights {
  gaussian: array<vec4f, 3>,
  reconstruction: array<vec4f, 3>,
};
struct TemporalFrame {
  size: vec2u,
  valid: u32,
  padding: u32,
  jitter: vec2f,
  previous_jitter: vec2f,
  delta_time: f32,
  sky_depth: f32,
  padding2: vec2f,
}
@group(0) @binding(0) var<uniform> frame: TemporalFrame;
fn point(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(frame.size) - 1);
}
fn output_motion(raw_motion: vec2f) -> vec2f {
  // Seed stores current-minus-previous raw UV including jitter. Cancel in
  // pixel coordinates before converting to the unjittered output UV domain.
  return (-raw_motion * vec2f(frame.size) + frame.jitter - frame.previous_jitter) / vec2f(frame.size);
}
fn half_value(v: f32) -> f32 {
  // Preserve the selected R16/RG16 storage profile after eliminating its
  // write/load boundary. Do not depend on the compiler's choice of half
  // conversion rounding for a fused arithmetic expression. The selected
  // source storage profile truncates; make that boundary explicit.
  var bits = pack2x16float(vec2f(v, 0.0)) & 0xffffu;
  let nearest = unpack2x16float(bits).x;
  if (abs(nearest) > abs(v)) { bits -= 1u; }
  return unpack2x16float(bits).x;
}
fn history_motion(raw_motion: vec2f, valid: bool) -> vec2f {
  let motion = output_motion(raw_motion);
  // Preserve the SDK's removed RG16 dilated-motion storage boundary.
  return select(vec2f(0.0), vec2f(half_value(motion.x), half_value(motion.y)), valid);
}
fn receiver_pixel(receivers: texture_2d<u32>, pixel: vec2i) -> vec2i {
  let index = textureLoad(receivers, point(pixel), 0).x;
  return vec2i(vec2u(index % frame.size.x, index / frame.size.x));
}
fn bilinear(image: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(image));
  let position = uv * vec2f(size) - 0.5;
  let base = vec2i(floor(position));
  let f = fract(position);
  return mix(mix(textureLoad(image, clamp(base, vec2i(0), size - 1), 0),
                 textureLoad(image, clamp(base + vec2i(1, 0), vec2i(0), size - 1), 0), f.x),
             mix(textureLoad(image, clamp(base + vec2i(0, 1), vec2i(0), size - 1), 0),
                 textureLoad(image, clamp(base + vec2i(1, 1), vec2i(0), size - 1), 0), f.x), f.y);
}
`;
// The native-only 3x3 domain is fixed. Emit each tap in its own scope, with
// constant uniform addresses; dynamic array indexing regressed on the target.
const NATIVE_CURRENT_TAPS_WGSL = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const component = (field, r, c) => {
        const i = r * 3 + c;
        return `filter_weights.${field}[${Math.floor(i / 4)}].${"xyzw"[i % 4]}`;
    };
    const weight = (field) => {
        const atRow = (r) => col === 1
            ? component(field, r, col)
            : `select(${component(field, r, col)}, ${component(field, r, 2 - col)}, flip_col)`;
        return row === 1 ? atRow(row) : `select(${atRow(row)}, ${atRow(2 - row)}, flip_row)`;
    };
    const coordinate = (value, flip) => value === 1 ? "0" : `select(${value - 1}, ${1 - value}, ${flip})`;
    return `
  {
    let offset = vec2i(${coordinate(col, "flip_col")}, ${coordinate(row, "flip_row")});
    let source = pixel + offset;
    let on_screen = all(source >= vec2i(0)) && all(source < vec2i(frame.size));
    let clamped = clamp(source, vec2i(0), vec2i(frame.size) - vec2i(1));
    var sample = prepared_color(clamped);
    if (initial) { sample = rgb_to_ycocg(tonemap(ycocg_to_rgb(sample))); }
    minimum = min(minimum, sample);
    maximum = max(maximum, sample);
    let box_weight = ${weight("gaussian")} * select(0.0, 1.0, on_screen);
    center_sum += sample * box_weight;
    variance_sum += sample * sample * box_weight;
    center_weight += box_weight;
    if (!initial) {
      let weight = ${weight("reconstruction")} * select(0.0, 1.0, on_screen);
      color_sum += sample * weight;
      color_weight += weight;
    }
  }`;
}).join("\n");
export const NATIVE_TEMPORAL_V2_MEASURE_WGSL = FRAME +
    /* wgsl */ `
@group(0) @binding(1) var input_color: texture_2d<f32>;
@group(0) @binding(2) var output_luma: texture_storage_2d<r16float, write>;
@group(0) @binding(3) var log_tiles: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var seed: texture_2d<f32>;
@group(0) @binding(5) var farthest_mip: texture_storage_2d<r16float, write>;
@group(0) @binding(6) var<storage, read_write> filter_weights: NativeFilterWeights;
@group(0) @binding(7) var color_receivers: texture_storage_2d<r32uint, write>;
// SDK FindDepthExtents/DilateMotionVector's sample order and strict nearest
// comparison, expressed in linear view-space depth (sky is the zero sentinel).
// This effect-local index never changes the Seed producer's own facts.
fn nearest_color_receiver(pixel: vec2i) -> vec2i {
  let offsets = array<vec2i, 8>(vec2i(1, 0), vec2i(0, 1), vec2i(0, -1), vec2i(-1, 0),
    vec2i(-1, 1), vec2i(1, 1), vec2i(-1, -1), vec2i(1, -1));
  var nearest = textureLoad(seed, pixel, 0).w;
  var receiver = pixel;
  for (var i = 0u; i < 8u; i++) {
    let candidate = pixel + offsets[i];
    if (any(candidate < vec2i(0)) || any(candidate >= vec2i(frame.size))) { continue; }
    let depth = textureLoad(seed, candidate, 0).w;
    if (depth > 0.0 && (nearest == 0.0 || depth < nearest)) {
      nearest = depth;
      receiver = candidate;
    }
  }
  return receiver;
}
// SDK SPD's 64x64 domain and ordered 2x2 reduction, including the mip5
// half boundary. Only the exposure scalar survives across workgroups.
var<workgroup> logs: array<f32, 4096>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  if (all(group.xy == vec2u(0u)) && lane < 9u) {
    let offset = vec2f(vec2i(i32(lane % 3u) - 1, i32(lane / 3u) - 1)) - frame.jitter;
    let squared = dot(offset, offset);
    filter_weights.gaussian[lane / 4u][lane % 4u] = exp(-2.3 * squared);
    let distance = min(squared, 4.0);
    let a = 0.4 * distance - 1.0;
    let b = 0.25 * distance - 1.0;
    filter_weights.reconstruction[lane / 4u][lane % 4u] = (1.5625 * a * a - 0.5625) * (b * b);
  }
  for (var i = lane; i < 4096u; i += 256u) {
    let local = vec2u(i % 64u, i / 64u);
    let p = group.xy * 64u + local;
    let rgb = max(textureLoad(input_color, point(vec2i(p)), 0).rgb, vec3f(0.0));
    let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    logs[i] = max(0.000061, log(half_value(luma)));
    if (all(p < frame.size)) {
      let receiver = nearest_color_receiver(vec2i(p));
      textureStore(color_receivers, vec2i(p), vec4u(u32(receiver.y) * frame.size.x + u32(receiver.x), 0u, 0u, 0u));
      textureStore(output_luma, vec2i(p), vec4f(half_value(luma), 0.0, 0.0, 0.0));
      if (all((p & vec2u(1u)) == vec2u(0u))) {
        var sum = 0.0;
        for (var y = 0; y < 2; y++) {
          for (var x = 0; x < 2; x++) {
            let z = textureLoad(seed, point(vec2i(p) + vec2i(x, y)), 0).w;
            sum += half_value(select(min(z, 65504.0), frame.sky_depth, z == 0.0));
          }
        }
        // In the selected PrepareInputs permutation farthest starts at
        // center and is updated with min only when sample > nearest >=
        // center: it remains center. Preserve that scalar, not depth search.
        textureStore(farthest_mip, vec2i(p / 2u), vec4f(half_value(sum * 0.25), 0.0, 0.0, 0.0));
      }
    }
  }
  workgroupBarrier();
  var side = 64u;
  var scale = 1u;
  loop {
    let next_side = side / 2u;
    var values: array<f32, 4>;
    for (var i = lane; i < next_side * next_side; i += 256u) {
      let p = vec2u(i % next_side, i / next_side);
      let active_size = (frame.size + vec2u(scale - 1u)) / scale;
      let limit = min(vec2u(side), active_size - group.xy * side) - 1u;
      let a = min(p * 2u, limit);
      let b = min(p * 2u + 1u, limit);
      // Each phase stores in a disjoint four-point block's first slot.
      // All reads precede writes; keep compact destination in private state.
      let value = (logs[a.y * 64u + a.x] + logs[b.y * 64u + a.x] +
                   logs[a.y * 64u + b.x] + logs[b.y * 64u + b.x]) * 0.25;
      // Destination uses the original stride. Compacting needs a second
      // uniform barrier, so the 256 lanes each hold up to four results.
      values[i / 256u] = value;
    }
    workgroupBarrier();
    for (var i = lane; i < next_side * next_side; i += 256u) {
      logs[(i / next_side) * 64u + i % next_side] = values[i / 256u];
    }
    workgroupBarrier();
    side = next_side;
    scale *= 2u;
    if (side == 1u) { break; }
  }
  if (lane == 0u) {
    let value = select(logs[0], half_value(logs[0]), max(frame.size.x, frame.size.y) > 64u);
    textureStore(log_tiles, vec2i(group.xy), vec4f(value, 0.0, 0.0, 0.0));
  }
}
`;
export const NATIVE_TEMPORAL_V2_EXPOSURE_WGSL = FRAME +
    /* wgsl */ `
@group(0) @binding(1) var log_tiles: texture_2d<f32>;
@group(0) @binding(2) var previous_info: texture_2d<f32>;
@group(0) @binding(3) var current_info: texture_storage_2d<rgba32float, write>;
// At the negotiated maximum 4096x4096 this is 64x64 scalar tiles,
// not a pixel-sized history or reconstructed-depth buffer.
var<workgroup> logs: array<f32, 4096>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lane: u32) {
  let size = textureDimensions(log_tiles);
  for (var i = lane; i < size.x * size.y; i += 256u) {
    logs[(i / size.x) * 64u + i % size.x] =
      textureLoad(log_tiles, vec2i(vec2u(i % size.x, i / size.x)), 0).x;
  }
  workgroupBarrier();
  var active_size = size;
  loop {
    if (all(active_size == vec2u(1u))) { break; }
    let next = (active_size + 1u) / 2u;
    var values: array<f32, 4>;
    for (var i = lane; i < next.x * next.y; i += 256u) {
      let p = vec2u(i % next.x, i / next.x);
      let a = min(p * 2u, active_size - 1u);
      let b = min(p * 2u + 1u, active_size - 1u);
      values[i / 256u] = (logs[a.y * 64u + a.x] + logs[b.y * 64u + a.x] +
                         logs[a.y * 64u + b.x] + logs[b.y * 64u + b.x]) * 0.25;
    }
    workgroupBarrier();
    for (var i = lane; i < next.x * next.y; i += 256u) {
      logs[(i / next.x) * 64u + i % next.x] = values[i / 256u];
    }
    workgroupBarrier();
    active_size = next;
  }
  if (lane == 0u) {
    let previous = select(1.0, textureLoad(previous_info, vec2i(0), 0).y, frame.valid != 0u);
    let log_luma = max(0.0, previous + (logs[0] - previous) * (1.0 - exp(-frame.delta_time)));
    let lavg = exp(log_luma);
    let iso100 = log2((lavg * 100.0) / 12.5);
    let lmax = (78.0 / (0.65 * 100.0)) * pow(2.0, iso100);
    textureStore(current_info, vec2i(0), vec4f(1.0 / lmax, log_luma, 0.0, 0.0));
  }
}
`;
export const NATIVE_TEMPORAL_V2_SHADING_PYRAMID_WGSL = FRAME +
    `

@group(0) @binding(1) var current_luma: texture_2d<f32>;
@group(0) @binding(2) var seed: texture_2d<f32>;
@group(0) @binding(3) var previous_luma: texture_2d<f32>;
@group(0) @binding(4) var input_exposure: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> current_exposure: array<f32>;
@group(0) @binding(6) var<storage, read> prior_exposure: array<f32>;
@group(0) @binding(7) var response: texture_2d<f32>;
@group(0) @binding(16) var color_receivers: texture_2d<u32>;
@group(0) @binding(8) var mip2: texture_storage_2d<rg16float, write>;
@group(0) @binding(9) var mip4: texture_storage_2d<rg16float, write>;
@group(0) @binding(10) var mip8: texture_storage_2d<rg16float, write>;
fn inside(uv: vec2f) -> bool { return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0)); }

fn compare_swap(values: ptr<function, array<f32, 5>>, i: i32, j: i32) {
  let low = min((*values)[i], (*values)[j]);
  (*values)[j] = max((*values)[i], (*values)[j]);
  (*values)[i] = low;
}
fn sort_set(values: ptr<function, array<f32, 5>>) {
  compare_swap(values, 0, 3); compare_swap(values, 1, 4);
  compare_swap(values, 0, 2); compare_swap(values, 1, 3);
  compare_swap(values, 0, 1); compare_swap(values, 2, 4);
  compare_swap(values, 1, 2); compare_swap(values, 3, 4);
  compare_swap(values, 2, 3);
}
fn difference(current_in: array<f32, 5>, previous_in: array<f32, 5>) -> f32 {
  var current = current_in;
  var previous = previous_in;
  sort_set(&current); sort_set(&previous);
  var minimum = 65503.0;
  var a = 0;
  var b = 0;
  if (min(current[4], previous[4]) > 1.175494351e-38) {
    for (var i = 0; i < 5 && minimum < 65504.0; i++) {
      var diff = current[a] - previous[b];
      if (abs(diff) > 0.000061) {
        diff = sign(diff) * (1.0 - min(current[a], previous[b]) / max(current[a], previous[b]));
        if (abs(diff) < abs(minimum)) { minimum = diff; }
        if (current[a] < previous[b]) { a += 1; }
        if (current[a] >= previous[b]) { b += 1; }
      } else {
        minimum = 65504.0;
      }
    }
  }
  return minimum * select(0.0, 1.0, minimum < 65503.0);
}
fn source_difference(pixel_in: vec2i) -> vec2f {
  let p = point(pixel_in);
  let receiver = receiver_pixel(color_receivers, p);
  let motion = history_motion(textureLoad(seed, receiver, 0).xy, textureLoad(response, receiver, 0).y > 0.5);
  let uv = (vec2f(p) + 0.5) / vec2f(frame.size);
  let previous_uv = uv + frame.previous_jitter / vec2f(frame.size) + motion;
  var diff = 0.0;
  if (frame.valid != 0u && inside(previous_uv)) {
    let offsets = array<vec2i, 5>(vec2i(0, 0), vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
    let base = vec2i(floor(vec2f(p) + 0.5 + frame.jitter));
    let previous_base = vec2i(floor(previous_uv * vec2f(frame.size)));
    let exposure = textureLoad(input_exposure, vec2i(0), 0).x;
    let delta = current_exposure[0] / max(prior_exposure[0], 1e-8);
    var current: array<f32, 5>;
    var previous: array<f32, 5>;
    for (var i = 0; i < 5; i++) {
      current[i] = max(textureLoad(current_luma, point(base + offsets[i]), 0).x * exposure, 0.000061);
      previous[i] = max(textureLoad(previous_luma, point(previous_base + offsets[i]), 0).x * delta * exposure, 0.000061);
    }
    diff = difference(current, previous);
  }
  return vec2f(diff, sign(diff));
}
// AMD SPD's first three box levels, no device-wide counter or global tail.
// Exactly one source_difference per source pixel; partial blocks clamp before
// every reduction just as the source ClampLoad domain does.
var<workgroup> source_tile: array<vec2f, 64>;
var<workgroup> box2: array<vec2f, 16>;
var<workgroup> box4: array<vec2f, 4>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lane: vec3u,
        @builtin(local_invocation_index) index: u32) {
  let origin = vec2i(group.xy * 8u);
  source_tile[index] = source_difference(origin + vec2i(lane.xy));
  workgroupBarrier();
  if (index < 16u) {
    let local = vec2i(i32(index % 4u), i32(index / 4u));
    let pixel = origin / 2 + local;
    let base = clamp(pixel, vec2i(0), (vec2i(frame.size) + 1) / 2 - 1) * 2 - origin;
    let offset = u32(base.y * 8 + base.x);
    box2[index] = (source_tile[offset] + source_tile[offset + 1u] + source_tile[offset + 8u] + source_tile[offset + 9u]) * 0.25;
    if (all(pixel < vec2i(textureDimensions(mip2)))) { textureStore(mip2, pixel, vec4f(box2[index], 0.0, 0.0)); }
  }
  workgroupBarrier();
  if (index < 4u) {
    let local = vec2i(i32(index % 2u), i32(index / 2u));
    let pixel = origin / 4 + local;
    let base = clamp(pixel, vec2i(0), (vec2i(frame.size) + 3) / 4 - 1) * 2 - origin / 2;
    let offset = u32(base.y * 4 + base.x);
    box4[index] = (box2[offset] + box2[offset + 1u] + box2[offset + 4u] + box2[offset + 5u]) * 0.25;
    if (all(pixel < vec2i(textureDimensions(mip4)))) { textureStore(mip4, pixel, vec4f(box4[index], 0.0, 0.0)); }
  }
  workgroupBarrier();
  if (index == 0u) {
    textureStore(mip8, origin / 8, vec4f((box4[0] + box4[1] + box4[2] + box4[3]) * 0.25, 0.0, 0.0));
  }
}
`;
export const NATIVE_TEMPORAL_V2_ANALYZE_WGSL = FRAME +
    /* wgsl */ `
@group(0) @binding(2) var seed: texture_2d<f32>;
@group(0) @binding(4) var input_exposure: texture_2d<f32>;
@group(0) @binding(7) var response: texture_2d<f32>;
@group(0) @binding(8) var identity: texture_2d<u32>;
@group(0) @binding(9) var previous_identity: texture_2d<u32>;
@group(0) @binding(10) var previous_depth: texture_2d<f32>;
@group(0) @binding(11) var analysis: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(12) var current_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(13) var previous_confidence: texture_2d<f32>;
@group(0) @binding(14) var sharpen_exposure: texture_storage_2d<r32float, write>;
@group(0) @binding(17) var linear_clamp: sampler;
@group(0) @binding(15) var current_confidence: texture_storage_2d<r8unorm, write>;
@group(0) @binding(16) var color_receivers: texture_2d<u32>;
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0));
}
// SDK PrepareReactivity::ComputeDisocclusions, consuming actual previous
// view-space depth instead of this frame's scattered reconstructed depth.
// Seed.z is already the current receiver in previous-view coordinates.
// The source's small-motion snapping belongs to scatter construction; an
// actual depth history must be pulled at the receiver's unsnapped own UV.
fn depth_history_confidence(uv: vec2f, expected_depth: f32, sky: bool) -> f32 {
  let position = uv * vec2f(frame.size) - 0.5;
  let base = vec2i(floor(position));
  let fraction = fract(position);
  var confidence = 0.0;
  var weight_sum = 0.0;
  var nearest_confidence = 1.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) *
        select(1.0 - fraction.y, fraction.y, y == 1);
      if (weight <= 0.00061) { continue; }
      let previous = textureLoad(previous_depth, point(base + vec2i(x, y)), 0).x;
      if (sky) {
        confidence += weight * select(0.0, 1.0, previous == 0.0);
        weight_sum += weight;
      } else if (previous > 0.0) {
        let difference = expected_depth - previous;
        if (difference > 1.175494351e-38) {
          let separation = 1.37e-05 * length(vec2f(frame.size) * 0.5) * max(expected_depth, previous);
          nearest_confidence = min(nearest_confidence, clamp(separation / difference, 0.0, 1.0));
        }
        weight_sum += weight;
      }
    }
  }
  if (weight_sum == 0.0) { return 0.0; }
  if (sky) { return clamp(confidence / weight_sum, 0.0, 1.0); }
  // Scatter contains nearest receiver depths. Raw previous-depth pull must
  // test the nearest contributor itself; a background tap cannot qualify an
  // overlapping foreground color history. Preserve the source Ksep response.
  return nearest_confidence;
}
// SDK PrepareReactivity's motion-divergence term. The motion/depth field is
// the associated Native Seed, rather than a nearest-neighbor dilated field.
fn source_motion_divergence(p: vec2i, motion: vec2f, depth: f32) -> f32 {
  let velocity = length(motion * vec2f(3840.0, 2160.0));
  if (velocity == 0.0) { return 0.0; }
  let uv = (vec2f(p) + 0.5) / vec2f(frame.size);
  let other_pixel = vec2i((uv + motion) * vec2f(frame.size));
  if (any(other_pixel < vec2i(0)) || any(other_pixel >= vec2i(frame.size))) { return 0.0; }
  let other_receiver = receiver_pixel(color_receivers, other_pixel);
  let other = textureLoad(seed, other_receiver, 0);
  let other_motion = history_motion(other.xy, textureLoad(response, other_receiver, 0).y > 0.5);
  let other_velocity = length(other_motion * vec2f(3840.0, 2160.0));
  let maximum_depth = max(depth, other.w);
  let distance_factor = select(0.0, min(depth, other.w) / max(maximum_depth, 1e-8), maximum_depth > 0.0);
  return (1.0 - clamp(other_velocity / velocity, 0.0, 1.0)) * distance_factor * clamp(velocity / 10.0, 0.0, 1.0);
}
@group(0) @binding(19) var shading_mip2: texture_2d<f32>;
@group(0) @binding(20) var shading_mip4: texture_2d<f32>;
@group(0) @binding(21) var shading_mip8: texture_2d<f32>;
fn mip_sample(uv: vec2f, level: i32) -> vec2f {
  // Preserve the SDK's filtered RG16 sampling boundary. Manual f32 bilinear
  // interpolation changes confidence around thin features on real hardware.
  if (level == 0) { return textureSampleLevel(shading_mip2, linear_clamp, uv, 0.0).xy; }
  if (level == 1) { return textureSampleLevel(shading_mip4, linear_clamp, uv, 0.0).xy; }
  return textureSampleLevel(shading_mip8, linear_clamp, uv, 0.0).xy;
}
fn low_change(p_in: vec2i) -> f32 {
  let size = max(vec2i(1), vec2i(frame.size) / 2);
  let p = clamp(p_in, vec2i(0), size - 1);
  let uv = (vec2f(p) + 0.5) / vec2f(size) + frame.jitter / vec2f(frame.size);
  let mip0_size = (vec2i(frame.size) + 1) / 2;
  let mip_uv = clamp(uv * vec2f(size), vec2f(0.5), vec2f(size) - 0.5) / vec2f(mip0_size);
  var change = 0.0;
  for (var i = 0; i < 3; i++) {
    let pair = mip_sample(mip_uv, i);
    change = max(change, abs(pair.x * pair.y));
  }
  // The removed R8 UAV store rounds half-way values toward the lower byte
  // on the qualified source profile; WGSL round() chooses another tie.
  // Keep that boundary without materializing a shading-change image.
  return max(0.0, ceil(clamp(change, 0.0, 1.0) * 255.0 - 0.5)) / 255.0;
}
fn shading_change(p: vec2i) -> f32 {
  let size = max(vec2i(1), vec2i(frame.size) / 2);
  let uv = (vec2f(p) + 0.5 - frame.jitter) / vec2f(frame.size);
  let position = clamp(uv * vec2f(size), vec2f(0.5), vec2f(size) - 0.5) - 0.5;
  let base = vec2i(floor(position));
  let f = fract(position);
  return mix(mix(low_change(base), low_change(base + vec2i(1, 0)), f.x),
    mix(low_change(base + vec2i(0, 1)), low_change(base + vec2i(1, 1)), f.x), f.y);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id3: vec3u) {
  let id = id3.xy;
  if (any(id >= frame.size)) { return; }
  let p = vec2i(id);
  let receiver = receiver_pixel(color_receivers, p);
  let facts = textureLoad(seed, receiver, 0);
  let native = textureLoad(response, receiver, 0);
  let current = textureLoad(identity, receiver, 0);
  // The color footprint is anchored at p; q only supplies the front receiver's
  // motion/previous-view depth. Previous identity validates q's own lifetime.
  let identity_uv = (vec2f(receiver) + 0.5) / vec2f(frame.size) - facts.xy;
  let uv = (vec2f(p) + 0.5) / vec2f(frame.size) - facts.xy;
  let motion = history_motion(facts.xy, native.y > 0.5);
  let output_uv = (vec2f(p) + 0.5) / vec2f(frame.size);
  var eligible = frame.valid != 0u && native.y > 0.5 && inside(output_uv + motion);
  let prior = textureLoad(previous_identity, point(vec2i(identity_uv * vec2f(frame.size))), 0);
  let hard = prior.x == current.x && (prior.y != current.y || (prior.w == current.w && prior.z != current.z));
  eligible = eligible && !hard;
  var reactive = native.x;
  let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  for (var i = 0u; i < 4u; i++) {
    let neighbor = textureLoad(identity, point(receiver + offsets[i]), 0);
    if (native.z > 0.5 && neighbor.x != current.x) { reactive = max(reactive, 0.1); }
  }
  let sky = current.x == 0xffffffffu;
  let coverage = select(0.0, depth_history_confidence(uv, facts.z, sky), eligible);
  reactive = max(reactive, source_motion_divergence(p, motion, facts.w));
  var change = shading_change(p);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) { change = max(change, textureLoad(response, point(p + vec2i(x, y)), 0).x); }
  }
  var confidence = 0.0;
  if (frame.valid != 0u && inside(output_uv + motion)) { confidence = textureSampleLevel(previous_confidence, linear_clamp, output_uv + motion, 0.0).x; }
  confidence = mix(confidence, 0.0, change);
  confidence = mix(confidence, min(-1.0 / 3.0, confidence), 1.0 - coverage);
  confidence *= select(0.0, 1.0, round(confidence * 100.0) > 1.0);
  let stored = clamp(confidence + 1.0 / 3.0, 0.0, 1.0);
  textureStore(current_confidence, p, vec4f(stored, 0.0, 0.0, 0.0));
  // These products retain their real UNORM stores; quantize exactly once.
  textureStore(analysis, p, vec4f(coverage, reactive, change, confidence));
  textureStore(current_depth, p, vec4f(textureLoad(seed, p, 0).w, 0.0, 0.0, 0.0));
  if (all(id == vec2u(0u))) {
    textureStore(sharpen_exposure, vec2i(0), vec4f(textureLoad(input_exposure, vec2i(0), 0).x, 0.0, 0.0, 0.0));
  }
}
`;
export const NATIVE_TEMPORAL_V2_RESOLVE_WGSL = FRAME +
    `

@group(0) @binding(1) var input_color: texture_2d<f32>;
@group(0) @binding(2) var dilated_motion: texture_2d<f32>;
@group(0) @binding(3) var classified_masks: texture_2d<f32>;
@group(0) @binding(4) var previous_history: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> current_exposure: array<f32>;
@group(0) @binding(8) var<storage, read> prior_exposure: array<f32>;
@group(0) @binding(6) var current_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var input_exposure: texture_2d<f32>;
@group(0) @binding(10) var current_luma: texture_2d<f32>;
@group(0) @binding(11) var previous_luma_history: texture_2d<f32>;
@group(0) @binding(13) var output_luma_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(17) var linear_clamp: sampler;
@group(0) @binding(15) var<uniform> filter_weights: NativeFilterWeights;
@group(0) @binding(14) var farthest_depth_mip1: texture_2d<f32>;
@group(0) @binding(16) var color_receivers: texture_2d<u32>;
@group(0) @binding(18) var native_response: texture_2d<f32>;

fn source_farthest(uv: vec2f) -> f32 {
  let active_size = max(vec2i(1), vec2i(frame.size) / 2);
  let sample_uv = clamp(uv * vec2f(active_size), vec2f(0.5), vec2f(active_size) - 0.5) / vec2f(textureDimensions(farthest_depth_mip1));
  return textureSampleLevel(farthest_depth_mip1, linear_clamp, sample_uv, 0.0).x;
}
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
fn history_sample(uv: vec2f) -> vec4f {
  let size = vec2i(frame.size);
  let sample = uv * vec2f(size) - vec2f(0.5);
  let fraction = fract(sample);
  let base = vec2i(floor(clamp(sample, vec2f(0.0), vec2f(size - vec2i(1)))));
  // Exact texel-center support: Lanczos(integer) is zero except L(0)=1.
  // No motion epsilon or shortened fractional-position filter is used.
  if (all(fraction == vec2f(0.0))) {
    return textureLoad(previous_history, base, 0);
  }
  let column_weights = vec4f(
    lanczos2(-1.0 - fraction.x), lanczos2(-fraction.x),
    lanczos2(1.0 - fraction.x), lanczos2(2.0 - fraction.x));
  var min_center = vec4f(3.402823466e+38);
  var max_center = vec4f(-3.402823466e+38);
  var result = vec4f(0.0);
  var row_weight_sum = 0.0;
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
      let weight = column_weights[col];
      weighted += weight * color;
      weight_sum += weight;
    }
    let weight = lanczos2(f32(row - 1) - fraction.y);
    result += weight * (weighted / weight_sum);
    row_weight_sum += weight;
  }
  return clamp(result / row_weight_sum, min_center, max_center);
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
fn upsample(pixel: vec2i, accumulation: f32, history_weight: f32) -> UpsampleResult {
  // Only actual 1:1 frames use this pipeline. The SDK's kernelMin/Max/Bias
  // all equal one; both 3x3 weight sets are spatially invariant this frame.
  let flip_col = frame.jitter.x < 0.0;
  let flip_row = frame.jitter.y < 0.0;
  let initial = accumulation == 0.0;
  var minimum = vec3f(3.402823466e+38);
  var maximum = vec3f(-3.402823466e+38);
  var center_sum = vec3f(0.0);
  var variance_sum = vec3f(0.0);
  var center_weight = 0.0;
  var color_sum = vec3f(0.0);
  var color_weight = 0.0;
${NATIVE_CURRENT_TAPS_WGSL}
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

fn thin_feature_confidence(pixel: vec2i) -> f32 {
  let offsets = array<vec2i, 9>(
    vec2i(0, 0), vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
    vec2i(-1, 0), vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1));
  var samples: array<f32, 9>;
  var luma_min = 3.402823466e+38;
  var luma_max = 1.175494351e-38;
  for (var i = 0; i < 9; i++) {
    let source = clamp(pixel + offsets[i], vec2i(0), vec2i(frame.size) - vec2i(1));
    samples[i] = textureLoad(current_luma, source, 0).x * exposure();
    luma_min = min(luma_min, samples[i]);
    luma_max = max(luma_max, samples[i]);
  }
  var dissimilar_min = 3.402823466e+38;
  var dissimilar_max = 0.0;
  var pattern = 1u;
  for (var i = 1; i < 9; i++) {
    let difference = abs(samples[i] - samples[0]) / (luma_max - luma_min);
    if (difference < 0.9) {
      pattern |= 1u << u32(i);
    } else {
      dissimilar_min = min(dissimilar_min, samples[i]);
      dissimilar_max = max(dissimilar_max, samples[i]);
    }
  }
  if (!(samples[0] > dissimilar_max || samples[0] < dissimilar_min)) { return 0.0; }
  let masks = array<u32, 4>(
    (1u << 1u) | (1u << 2u) | (1u << 4u) | 1u,
    (1u << 2u) | (1u << 3u) | (1u << 5u) | 1u,
    (1u << 4u) | (1u << 6u) | (1u << 7u) | 1u,
    (1u << 5u) | (1u << 7u) | (1u << 8u) | 1u);
  for (var i = 0; i < 4; i++) {
    if ((pattern & masks[i]) == masks[i]) { return 0.0; }
  }
  return 1.0 - luma_min / luma_max;
}

fn native_thin_feature(pixel: vec2i) -> f32 {
  // Invert PrepareReactivity's original producer-to-output lock mapping.
  let producer = pixel - vec2i(floor(vec2f(0.5) - frame.jitter));
  if (any(producer < vec2i(0)) || any(producer >= vec2i(frame.size))) {
    return 0.0;
  }
  return thin_feature_confidence(producer);
}

struct InstabilityData {
  history: vec4f,
  factor: f32,
};

fn compute_instability(history_in: vec4f, current: f32) -> InstabilityData {
  var history = history_in;
  let diff0 = current - history[0];
  let similarity0 = native_similarity(current, history[0], 1.0);
  var max_similarity = similarity0;
  var instability = 0.0;
  if (similarity0 < 1.0) {
    for (var i = 1; i <= 3; i++) {
      let diff1 = current - history[i];
      let similarity1 = native_similarity(current, history[i], 0.0);
      if (sign(diff0) == sign(diff1)) {
        max_similarity = max(max_similarity, similarity1);
      }
    }
    if (max_similarity > similarity0) { instability = 1.0; }
  }
  history[3] = history[2];
  history[2] = history[1];
  history[1] = history[0];
  history[0] = current;
  history /= exposure();
  var factor = 0.0;
  if (history[3] != 0.0) { factor = instability; }
  return InstabilityData(history, factor);
}


fn native_similarity(a: f32, b: f32, zero: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return zero;
}
fn native_instability(pixel: vec2i, uv: vec2f, motion: vec2f, masks: vec4f) -> f32 {
  var data = InstabilityData(vec4f(0.0), 0.0);
  let reprojection = uv + frame.previous_jitter /
    vec2f(vec2i(frame.size)) + motion;
  if (f32(frame.valid) != 0.0 && inside(reprojection) && masks.w > 0.9) {
    let current_uv = clamp_uv(uv + frame.jitter / vec2f(vec2i(frame.size)),
      vec2i(frame.size), textureDimensions(current_luma));
    let current = textureSampleLevel(current_luma, linear_clamp, current_uv, 0.0).x * exposure();
    let history_uv = clamp_uv(reprojection, vec2i(frame.size),
      textureDimensions(previous_luma_history));
    let history = textureSampleLevel(previous_luma_history, linear_clamp, history_uv, 0.0) *
      (current_exposure[0] / max(prior_exposure[0], 1e-8)) * exposure();
    data = compute_instability(history, current);
    let velocity_weight = 1.0 - clamp(length(motion * vec2f(3840.0, 2160.0)) / 20.0, 0.0, 1.0);
    data.factor *= velocity_weight * (1.0 - masks.y) * (1.0 - masks.x) * (1.0 - masks.z);
  }
  textureStore(output_luma_history, pixel, data.history);
  // Preserve the removed R16Float instability write/load boundary.
  // The frozen Native T3 profile already fused this particular boundary
  // using pack2x16float. Preserve that profile's nearest conversion.
  return unpack2x16float(pack2x16float(vec2f(data.factor, 0.0))).x;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= vec2i(frame.size))) { return; }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(vec2i(frame.size));
  let jittered_uv = uv + frame.jitter / vec2f(vec2i(frame.size));
  let receiver = receiver_pixel(color_receivers, pixel);
  let motion = history_motion(textureLoad(dilated_motion, receiver, 0).xy, textureLoad(native_response, receiver, 0).y > 0.5);
  let reprojected_uv = uv + motion;
  let existing = inside(reprojected_uv);
  let new_sample = !existing || f32(frame.valid) == 0.0;
  let masks_uv = clamp_uv(jittered_uv, vec2i(frame.size), textureDimensions(classified_masks));
  let qualified = textureSampleLevel(classified_masks, linear_clamp, masks_uv, 0.0);
  let masks = vec4f(qualified.y, 1.0 - qualified.x, qualified.zw);
  let instability = native_instability(pixel, uv, motion, masks);
  let farthest = source_farthest(jittered_uv);

  let reactive = clamp(masks.x, 0.0, 1.0);
  let disocclusion = clamp(masks.y, 0.0, 1.0);
  let shading_change = clamp(masks.z, 0.0, 1.0);
  var accumulation = clamp(masks.w, 0.0, 1.0);
  accumulation *= select(0.0, 1.0, round(accumulation * 100.0) > 1.0);
  var history_color = vec3f(0.0);
  var lock = 0.0;
  if (existing && !new_sample) {
    let old = history_sample(reprojected_uv);
    history_color = rgb_to_ycocg(old.rgb * (current_exposure[0] / max(prior_exposure[0], 1e-8)) * exposure());
    lock = old.a;
  }
  lock *= select(0.0, 1.0, !new_sample);
  let lifetime_factor = max(clamp(shading_change, 0.0, 1.0), max(reactive, disocclusion));
  lock = max(0.0, lock - lifetime_factor * 2.0);
  let lock_contribution = clamp(clamp(lock - 1.0, 0.0, 1.0) * (2.0 - 1.0), 0.0, 1.0);
  let velocity = length(motion * vec2f(3840.0, 2160.0));
  let motion_limit = clamp(max(0.0, velocity * 1.0 / 0.5), 0.0, 1.0);
  let base_weight = min(accumulation, mix(accumulation, 0.15, motion_limit));
  var sampled = upsample(pixel, accumulation, base_weight);
  let thin = native_thin_feature(pixel);
  let new_lock = select(0.0, round(clamp(thin, 0.0, 1.0) * 255.0) / 255.0, thin > 0.01) * (1.0 - reactive);
  lock = max(0.0, min(lock + new_lock, 2.0));
  lock = max(0.0, lock - (0.1 / 8.0) * (1.0 - lifetime_factor));
  lock *= select(0.0, 1.0, inside(uv - motion));

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
}
`;
