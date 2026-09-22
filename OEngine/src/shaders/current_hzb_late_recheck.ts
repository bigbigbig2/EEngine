import { counterByteOffset } from "../debug/GpuFrameCounters.js";

/**
 * Phase I GPU producer/consumer contract. The caller supplies conservative
 * projection metadata; invalid metadata always remains visible (fail-open).
 */
export const CURRENT_HZB_LATE_RECHECK_WGSL = /* wgsl */ `
struct OEngineCurrentHzbLateRecheckHeader {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  consumed_count: atomic<u32>,
  capacity: u32,
  overflow_count: atomic<u32>,
  generation: atomic<u32>,
  invalid_count: atomic<u32>,
  reserved: u32,
};

struct OEngineCurrentHzbLateRecheckCandidate {
  work_slot: u32,
  flags: u32,
  screen_min: vec2f,
  screen_max: vec2f,
  nearest_depth: f32,
  raster_vertices: u32,
};

struct OEngineCurrentHzbLateRecheckQueue {
  header: OEngineCurrentHzbLateRecheckHeader,
  records: array<OEngineCurrentHzbLateRecheckCandidate>,
};

struct OEngineCurrentHzbLateRecheckSettings {
  view_size: vec2u,
  mip_count: u32,
  epsilon: f32,
  counters_enabled: u32,
  reserved: vec3u,
};

@group(0) @binding(0) var<storage, read> recheck_input: OEngineCurrentHzbLateRecheckQueue;
@group(0) @binding(1) var<storage, read_write> recheck_output: OEngineCurrentHzbLateRecheckQueue;
@group(0) @binding(2) var current_hzb: texture_2d<f32>;
@group(0) @binding(3) var<uniform> recheck_settings: OEngineCurrentHzbLateRecheckSettings;

const CURRENT_HZB_RECHECK_UNCERTAIN: u32 = 1u;
const CURRENT_HZB_RECHECK_EXPENSIVE: u32 = 2u;
const CURRENT_HZB_RECHECK_CONSERVATIVE: u32 = 4u;
const CURRENT_HZB_RECHECK_INVALID_OFFSET: u32 = 0xffffffffu;
const CURRENT_HZB_RECHECK_WORKGROUP_SIZE: u32 = 64u;

fn recheck_candidate_valid(candidate: OEngineCurrentHzbLateRecheckCandidate) -> bool {
  return all(candidate.screen_min == candidate.screen_min) &&
    all(candidate.screen_max == candidate.screen_max) &&
    candidate.screen_min.x >= 0.0 && candidate.screen_min.y >= 0.0 &&
    candidate.screen_max.x <= 1.0 && candidate.screen_max.y <= 1.0 &&
    all(candidate.screen_min < candidate.screen_max) &&
    candidate.nearest_depth == candidate.nearest_depth;
}

fn recheck_occluded(candidate: OEngineCurrentHzbLateRecheckCandidate) -> bool {
  let footprint = max(
    max((candidate.screen_max.x - candidate.screen_min.x) * f32(recheck_settings.view_size.x),
      (candidate.screen_max.y - candidate.screen_min.y) * f32(recheck_settings.view_size.y)),
    1.0
  );
  let mip = min(u32(ceil(log2(footprint))), recheck_settings.mip_count - 1u);
  let size = max(recheck_settings.view_size >> vec2u(mip), vec2u(1u));
  let lo = clamp(vec2i(floor(candidate.screen_min * vec2f(size))), vec2i(0), vec2i(size - 1u));
  let hi = clamp(vec2i(floor(candidate.screen_max * vec2f(size))), vec2i(0), vec2i(size - 1u));
  let farthest = min(
    min(textureLoad(current_hzb, lo, i32(mip)).x,
      textureLoad(current_hzb, vec2i(hi.x, lo.y), i32(mip)).x),
    min(textureLoad(current_hzb, vec2i(lo.x, hi.y), i32(mip)).x,
      textureLoad(current_hzb, hi, i32(mip)).x)
  );
  return candidate.nearest_depth + recheck_settings.epsilon < farthest;
}

fn recheck_try_reserve(count: u32) -> u32 {
  atomicAdd(&recheck_output.header.attempted_count, count);
  var observed = atomicLoad(&recheck_output.header.written_count);
  loop {
    if count == 0u || count > recheck_output.header.capacity -
      min(observed, recheck_output.header.capacity) {
      atomicAdd(&recheck_output.header.overflow_count, count);
      return CURRENT_HZB_RECHECK_INVALID_OFFSET;
    }
    let result = atomicCompareExchangeWeak(
      &recheck_output.header.written_count, observed, observed + count);
    if result.exchanged { return observed; }
    observed = result.old_value;
  }
}

@compute @workgroup_size(${64})
fn current_hzb_late_recheck(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let count = min(atomicLoad(&recheck_input.header.written_count), recheck_input.header.capacity);
  if index >= count { return; }
  let candidate = recheck_input.records[index];
  var keep = true;
  if !recheck_candidate_valid(candidate) {
    atomicAdd(&recheck_output.header.invalid_count, 1u);
  } else {
    let eligible = (candidate.flags &
      (CURRENT_HZB_RECHECK_UNCERTAIN | CURRENT_HZB_RECHECK_EXPENSIVE)) != 0u;
    let parity_safe = (candidate.flags & CURRENT_HZB_RECHECK_CONSERVATIVE) != 0u;
    keep = !(eligible && parity_safe && recheck_occluded(candidate));
  }
  if !keep { return; }
  let slot = recheck_try_reserve(1u);
  if slot == CURRENT_HZB_RECHECK_INVALID_OFFSET { return; }
  recheck_output.records[slot] = candidate;
}
`;

export const CURRENT_HZB_LATE_RECHECK_COUNTER_OFFSETS = Object.freeze({
  attempted: counterByteOffset("meshletQueueAttempted"),
  written: counterByteOffset("meshletQueueWritten"),
  overflow: counterByteOffset("meshletQueueOverflow")
});
