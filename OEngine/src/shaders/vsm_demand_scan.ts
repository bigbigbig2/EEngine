import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";

/** Complete-domain unique requests. Portable 64-lane hierarchical prefix;
 * no wave assumptions, global tickets, or pixel-dependent capacity. */
export const VSM_DEMAND_SCAN_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
struct Constants {
  control: vec4u,
  dimensions: vec4u,
  identity: vec4u,
  clips: array<vec4f, 6>,
};
struct Request {
  virtual_page: u32,
  slot: u32,
  world: vec2i,
};
struct Requests {
  fine_count: u32,
  written: u32,
  overflow: u32,
  generation: u32,
  records: array<Request>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> bits: array<u32>;
@group(0) @binding(2) var<storage, read_write> scan: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> requests: Requests;
@group(0) @binding(4) var<storage, read_write> indirect: array<u32>;
var<workgroup> prefix: array<vec2u, 64>;

fn scan_lanes(lane: u32, value: vec2u) -> vec2u {
  prefix[lane] = value;
  workgroupBarrier();
  for (var stride = 1u; stride < 64u; stride *= 2u) {
    var prior = vec2u(0u);
    if (lane >= stride) {
      prior = prefix[lane - stride];
    }
    workgroupBarrier();
    prefix[lane] += prior;
    workgroupBarrier();
  }
  return prefix[lane] - value;
}
fn word_count() -> u32 {
  return (constants.dimensions.z + 31u) / 32u;
}
fn group_count() -> u32 {
  return (word_count() + 63u) / 64u;
}
fn coarse_mask(word: u32) -> u32 {
  let per_level = vsm_entries_per_clip_level(constants.dimensions.x);
  let coarse_axis = vsm_storage_axis(constants.dimensions.x, 5u);
  var mask = 0u;
  let first = word * 32u;
  for (var level = 0u; level < constants.control.w; level++) {
    let begin = (level + 1u) * per_level - coarse_axis * coarse_axis;
    let end = (level + 1u) * per_level;
    let low = max(first, begin);
    let high = min(first + 32u, end);
    if (low < high) {
      let length = high - low;
      let range_mask = select((1u << (length % 32u)) - 1u, 0xffffffffu, length == 32u);
      mask |= range_mask << (low - first);
    }
  }
  return mask;
}
@compute @workgroup_size(64)
fn count_words(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  var value = vec2u(0u);
  if (id.x < word_count()) {
    let mask = coarse_mask(id.x);
    value = vec2u(countOneBits(bits[id.x] & mask), countOneBits(bits[id.x] & ~mask));
  }
  let local_prefix = scan_lanes(lane, value);
  if (id.x < word_count()) {
    scan[id.x] = local_prefix;
  }
  if (lane == 63u) {
    scan[word_count() + group.x] = local_prefix + value;
  }
}
fn publish_prefix(lane: u32) -> vec2u {
  let groups = group_count();
  let span = (groups + 63u) / 64u;
  let begin = lane * span;
  var sum = vec2u(0u);
  for (var i = begin; i < min(begin + span, groups); i++) {
    sum += scan[word_count() + i];
  }
  var base = scan_lanes(lane, sum);
  for (var i = begin; i < min(begin + span, groups); i++) {
    scan[word_count() + groups + i] = base;
    base += scan[word_count() + i];
  }
  if (lane == 63u) {
    let total = prefix[63];
    scan[word_count() + groups * 2u] = total;
    indirect[0] = max(1u, (total.x + total.y + 63u) / 64u);
    indirect[1] = 1u;
    indirect[2] = 1u;
  }
  return prefix[63];
}
@compute @workgroup_size(64)
fn prefix_requests(@builtin(local_invocation_index) lane: u32) {
  let total = publish_prefix(lane);
  if (lane == 63u) {
    requests.fine_count = total.y;
    requests.written = total.x + total.y;
    requests.overflow = 0u;
    requests.generation = constants.control.x;
  }
}
@compute @workgroup_size(64)
fn prefix_misses(@builtin(local_invocation_index) lane: u32) {
  _ = publish_prefix(lane);
}
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= word_count()) {
    return;
  }
  let groups = group_count();
  let total = scan[word_count() + groups * 2u];
  var at = scan[id.x] + scan[word_count() + groups + id.x / 64u];
  var marked = bits[id.x];
  let coarse = coarse_mask(id.x);
  for (var bit = 0u; bit < 32u; bit++) {
    let mask = 1u << bit;
    if ((marked & mask) == 0u) {
      continue;
    }
    let page = id.x * 32u + bit;
    let coordinate = vsm_page_entry_coordinates(page, constants.dimensions.x);
    let clip = constants.clips[coordinate.x];
    let minimum = vsm_window_minimum(clip, coordinate.y, constants.dimensions.x);
    let axis = vsm_storage_axis(constants.dimensions.x, coordinate.y);
    let wrapped = vec2u(coordinate.z, coordinate.w);
    let world = minimum + vec2i(i32(vsm_floor_mod(i32(wrapped.x) - minimum.x, axis)),
      i32(vsm_floor_mod(i32(wrapped.y) - minimum.y, axis)));
    let is_coarse = (coarse & mask) != 0u;
    let index = select(total.x + at.y, at.x, is_coarse);
    requests.records[index] = Request(page, VSM_INVALID_SLOT, world);
    at += select(vec2u(0u, 1u), vec2u(1u, 0u), is_coarse);
  }
}
`;
