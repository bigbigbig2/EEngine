/**
 * Automatic exposure 的生产 WGSL source-of-truth。
 * generated 文件只作为历史参考，不能成为生产 shader owner。
 */

export const EXPOSURE_HISTOGRAM_WGSL = /* wgsl */ `
const BIN_COUNT: u32 = 128u;
const MIN_LOG_LUMINANCE: f32 = -10.0;
const MAX_LOG_LUMINANCE: f32 = 15.0;
struct Histogram { bins: array<atomic<u32>, 128>, };
@group(0) @binding(0) var source_hdr: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: Histogram;
var<workgroup> local_histogram: Histogram;
fn luminance(rgb: vec3<f32>) -> f32 { return dot(rgb, vec3<f32>(0.212639, 0.715169, 0.072192)); }
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) local_index: u32) {
  if (local_index < BIN_COUNT) { atomicStore(&local_histogram.bins[local_index], 0u); }
  workgroupBarrier();
  let size = textureDimensions(source_hdr);
  if (all(gid.xy < size)) {
    let color = textureLoad(source_hdr, vec2<i32>(gid.xy), 0).rgb;
    let value = luminance(max(color, vec3<f32>(0.0)));
    if (value >= 0.0009765625 && value <= 32768.0) {
      let t = clamp((log2(value) - MIN_LOG_LUMINANCE) / (MAX_LOG_LUMINANCE - MIN_LOG_LUMINANCE), 0.0, 1.0);
      let bin = min(BIN_COUNT - 1u, u32(t * f32(BIN_COUNT - 1u)));
      atomicAdd(&local_histogram.bins[bin], 1u);
    }
  }
  workgroupBarrier();
  if (local_index < BIN_COUNT) { atomicAdd(&histogram.bins[local_index], atomicLoad(&local_histogram.bins[local_index])); }
}
`;

export const EXPOSURE_REDUCE_WGSL = /* wgsl */ `
const BIN_COUNT: u32 = 128u;
const MIN_LOG_LUMINANCE: f32 = -10.0;
const MAX_LOG_LUMINANCE: f32 = 15.0;
const LOW_PERCENTILE: f32 = 0.70;
const HIGH_PERCENTILE: f32 = 0.95;
struct Histogram { bins: array<u32, 128>, };
struct ExposureValue { value: f32, };
@group(0) @binding(0) var<storage, read> histogram: Histogram;
@group(0) @binding(1) var<storage, read_write> output: ExposureValue;
@compute @workgroup_size(1)
fn main() {
  var total = 0u;
  for (var i = 0u; i < BIN_COUNT; i++) { total += histogram.bins[i]; }
  if (total == 0u) { output.value = exp2(MIN_LOG_LUMINANCE); return; }
  let total_f = f32(total);
  var cursor = 0.0; var weighted = 0.0; var accepted = 0.0;
  for (var i = 0u; i < BIN_COUNT; i++) {
    let count = f32(histogram.bins[i]);
    let begin = cursor / total_f; let end = (cursor + count) / total_f;
    let overlap = max(0.0, min(end, HIGH_PERCENTILE) - max(begin, LOW_PERCENTILE));
    let samples = overlap * total_f; let t = f32(i) / f32(BIN_COUNT - 1u);
    weighted += (MIN_LOG_LUMINANCE + t * (MAX_LOG_LUMINANCE - MIN_LOG_LUMINANCE)) * samples;
    accepted += samples; cursor += count;
  }
  output.value = select(exp2(MIN_LOG_LUMINANCE), exp2(weighted / accepted), accepted > 0.0);
}
`;

export const EXPOSURE_ADAPT_WGSL = /* wgsl */ `
struct ExposureValue { value: f32, };
struct AdaptSettings { speed_up: f32, speed_down: f32, time_delta: f32, transition_distance: f32, compensation: f32, };
@group(0) @binding(0) var<uniform> goal: ExposureValue;
@group(0) @binding(1) var<uniform> previous: ExposureValue;
@group(0) @binding(2) var<uniform> settings: AdaptSettings;
@group(0) @binding(3) var<storage, read_write> adapted: ExposureValue;
@group(0) @binding(4) var<storage, read_write> multiplier: ExposureValue;
@compute @workgroup_size(1)
fn main() {
  let previous_log = log2(max(previous.value, 1e-7)); let goal_log = log2(max(goal.value, 1e-7));
  let delta = goal_log - previous_log; let speed = select(settings.speed_down, settings.speed_up, delta > 0.0);
  let distance = max(settings.transition_distance, 0.001);
  let step = min(abs(delta), speed * settings.time_delta * max(abs(delta) / distance, 1.0));
  let value = exp2(previous_log + sign(delta) * step);
  adapted.value = value; multiplier.value = (0.18 / max(value, 1e-7)) * (1.0 + settings.compensation);
}
`;

export const EXPOSURE_HISTOGRAM_BIN_COUNT = 128;
export const EXPOSURE_HISTOGRAM_BUFFER_SIZE = EXPOSURE_HISTOGRAM_BIN_COUNT * 4;
export const EXPOSURE_VALUE_BUFFER_SIZE = 4;
export const EXPOSURE_SETTINGS_BUFFER_SIZE = 20;
