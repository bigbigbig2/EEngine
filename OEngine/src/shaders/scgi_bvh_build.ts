import {
  SCGI_BVH_MAX_DEPTH,
  SCGI_BVH_WORKGROUP_SIZE as W,
  type ScgiBvhPlan
} from "../render/gi/ScgiBvhLayout.js";

/* Altered WGSL adaptation of RadeonRays c8890b96b1f976bedd2cd280cc170dff5d655e0a:
 * dx/kernels/build_hlbvh_fallback.hlsl ExpandBits, CalculateMortonCode,
 * delta, FindSpan, FindSplit, EmitTopology. Refit uses dispatch-separated
 * pointer jumping and levels rather than HLSL global-coherent atomics.
 *
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 * Bullet Continuous Collision Detection and Physics Library
 * Copyright (c) 2003-2011 Erwin Coumans http://bulletphysics.org
 *
 * This software is provided 'as-is', without any express or implied warranty.
 * In no event will the authors be held liable for any damages arising from the use of this software.
 * Permission is granted to anyone to use this software for any purpose,
 * including commercial applications, and to alter it and redistribute it freely,
 * subject to the following restrictions:
 *
 * 1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
 * 2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
 * 3. This notice may not be removed or altered from any source distribution.
 */

export function scgiBvhBuildWgsl(plan: ScgiBvhPlan): string {
  const h = plan.hierarchy.ranges;
  const s = plan.scratch.ranges;
  const constants = Object.entries(s)
    .map(([name, range]) => `const S_${name}: u32 = ${range.offset / 4}u;`)
    .join("\n");
  return /* wgsl */ `
struct BuildSettings {
  count: u32,
  phase: u32,
  source: u32,
  mode: u32,
}
@group(0) @binding(0) var<storage, read_write> hierarchy: array<u32>;
@group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> settings: BuildSettings;
${constants}
const H_NODES: u32 = ${h.nodes!.offset / 4}u;
const H_LINKS: u32 = ${h.links!.offset / 4}u;
const MAX_DEPTH: u32 = ${SCGI_BVH_MAX_DEPTH}u;
const INVALID: u32 = 0xffffffffu;
const CAPACITY: u32 = ${plan.primitiveCapacity}u;
const BLOCKS: u32 = ${plan.blocks}u;

struct Bounds {
  low: vec3f,
  high: vec3f,
}
var<workgroup> low_values: array<vec3f, ${W}>;
var<workgroup> high_values: array<vec3f, ${W}>;

fn scratch_float(at: u32) -> f32 {
  return bitcast<f32>(atomicLoad(&scratch[at]));
}
fn read_bounds(at: u32) -> Bounds {
  return Bounds(vec3f(scratch_float(at), scratch_float(at + 1u), scratch_float(at + 2u)),
    vec3f(scratch_float(at + 4u), scratch_float(at + 5u), scratch_float(at + 6u)));
}
fn write_bounds(at: u32, bounds: Bounds) {
  for (var axis = 0u; axis < 3u; axis++) {
    atomicStore(&scratch[at + axis], bitcast<u32>(bounds.low[axis]));
    atomicStore(&scratch[at + 4u + axis], bitcast<u32>(bounds.high[axis]));
  }
}
fn empty_bounds() -> Bounds {
  return Bounds(vec3f(3.402823466e38), vec3f(-3.402823466e38));
}
fn valid_bounds(bounds: Bounds) -> bool {
  // Bit classification does not depend on implementation NaN comparison rules.
  let low_bits = bitcast<vec3u>(bounds.low) & vec3u(0x7f800000u);
  let high_bits = bitcast<vec3u>(bounds.high) & vec3u(0x7f800000u);
  return all(low_bits != vec3u(0x7f800000u)) &&
    all(high_bits != vec3u(0x7f800000u)) && all(bounds.low <= bounds.high);
}
fn exponent_scaled(value: f32, exponent: i32) -> f32 {
  let parts = frexp(value);
  // Dividing by a near-max f32 may lower to a flushed subnormal reciprocal.
  // Exponent alignment keeps the arithmetic operands in the normal range.
  return ldexp(parts.fract, max(-126, parts.exp - exponent));
}
fn fault() {
  atomicOr(&scratch[S_control], 1u);
}
fn node_bounds(node: u32) -> Bounds {
  let at = H_NODES + node * 16u;
  return Bounds(min(vec3f(bitcast<f32>(hierarchy[at]), bitcast<f32>(hierarchy[at + 1u]), bitcast<f32>(hierarchy[at + 2u])),
      vec3f(bitcast<f32>(hierarchy[at + 8u]), bitcast<f32>(hierarchy[at + 9u]), bitcast<f32>(hierarchy[at + 10u]))),
    max(vec3f(bitcast<f32>(hierarchy[at + 4u]), bitcast<f32>(hierarchy[at + 5u]), bitcast<f32>(hierarchy[at + 6u])),
      vec3f(bitcast<f32>(hierarchy[at + 12u]), bitcast<f32>(hierarchy[at + 13u]), bitcast<f32>(hierarchy[at + 14u]))));
}
fn set_node_bounds(node: u32, left: Bounds, right: Bounds) {
  let at = H_NODES + node * 16u;
  for (var axis = 0u; axis < 3u; axis++) {
    hierarchy[at + axis] = bitcast<u32>(left.low[axis]);
    hierarchy[at + 4u + axis] = bitcast<u32>(left.high[axis]);
    hierarchy[at + 8u + axis] = bitcast<u32>(right.low[axis]);
    hierarchy[at + 12u + axis] = bitcast<u32>(right.high[axis]);
  }
}

@compute @workgroup_size(${W})
fn initialize(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let nodes = select(0u, settings.count * 2u - 1u, settings.count > 0u);
  if (index < nodes && atomicLoad(&scratch[S_input + 1u]) != 1u) {
    hierarchy[H_LINKS + index * 2u] = INVALID;
    hierarchy[H_LINKS + index * 2u + 1u] = INVALID;
  }
  if (index < 16u) {
    atomicStore(&scratch[S_control + index], 0u);
    if (atomicLoad(&scratch[S_input + 1u]) != 1u) { hierarchy[index] = 0u; }
  }
  if (index <= MAX_DEPTH) {
    atomicStore(&scratch[S_levelCounts + index], 0u);
    atomicStore(&scratch[S_levelCursors + index], 0u);
  }
}

@compute @workgroup_size(${W})
fn reduce_bounds(@builtin(local_invocation_index) lane: u32,
    @builtin(workgroup_id) group: vec3u) {
  var bounds = empty_bounds();
  let count = select(settings.count, BLOCKS, settings.mode != 0u);
  var index = group.x * ${W}u + lane;
  loop {
    if (index >= count) { break; }
    let source = select(S_primitiveBounds, S_boundsReduction, settings.mode != 0u);
    let item = read_bounds(source + index * 8u);
    if (settings.mode == 0u && !valid_bounds(item)) { fault(); }
    bounds.low = min(bounds.low, item.low);
    bounds.high = max(bounds.high, item.high);
    index += ${W}u;
    if (settings.mode == 0u) { break; }
  }
  low_values[lane] = bounds.low;
  high_values[lane] = bounds.high;
  workgroupBarrier();
  for (var width = ${W / 2}u; width > 0u; width >>= 1u) {
    if (lane < width) {
      low_values[lane] = min(low_values[lane], low_values[lane + width]);
      high_values[lane] = max(high_values[lane], high_values[lane + width]);
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let destination = select(S_boundsReduction + group.x * 8u, S_sceneBounds, settings.mode != 0u);
    write_bounds(destination, Bounds(low_values[0], high_values[0]));
  }
}

fn expand_bits(input: u32) -> u32 {
  var value = input;
  value = (value * 0x00010001u) & 0xff0000ffu;
  value = (value * 0x00000101u) & 0x0f00f00fu;
  value = (value * 0x00000011u) & 0xc30c30c3u;
  value = (value * 0x00000005u) & 0x49249249u;
  return value;
}
@compute @workgroup_size(${W})
fn morton(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= settings.count) { return; }
  let bounds = read_bounds(S_primitiveBounds + index * 8u);
  if (!valid_bounds(bounds)) {
    atomicStore(&scratch[S_keysA + index * 2u], 0u);
    atomicStore(&scratch[S_keysA + index * 2u + 1u], index);
    return;
  }
  let scene = read_bounds(S_sceneBounds);
  var point = vec3f(0.5);
  for (var axis = 0u; axis < 3u; axis++) {
    let scale = max(abs(scene.low[axis]), abs(scene.high[axis]));
    if (scale == 0.0) { continue; }
    // Normalize before subtraction; scaling the difference by 0.5 can be
    // reassociated by an implementation and overflow at opposite extremes.
    let exponent = frexp(scale).exp;
    let low = exponent_scaled(scene.low[axis], exponent);
    let high = exponent_scaled(scene.high[axis], exponent);
    let center = exponent_scaled(bounds.low[axis], exponent) * 0.5 + exponent_scaled(bounds.high[axis], exponent) * 0.5;
    let extent = high - low;
    if (extent > 0.0) {
      point[axis] = (center - low) / extent;
    }
  }
  let quantized = vec3u(clamp(point * 1024.0, vec3f(0.0), vec3f(1023.0)));
  let code = (expand_bits(quantized.x) << 2u) | (expand_bits(quantized.y) << 1u) | expand_bits(quantized.z);
  atomicStore(&scratch[S_keysA + index * 2u], code);
  atomicStore(&scratch[S_keysA + index * 2u + 1u], index);
}
@compute @workgroup_size(${W})
fn update_leaves(@builtin(global_invocation_id) id: vec3u) {
  if (hierarchy[0] != settings.count || hierarchy[2] != 0u) {
    fault();
    return;
  }
  if (id.x >= settings.count) { return; }
  let leaf = settings.count - 1u + id.x;
  let primitive = hierarchy[H_NODES + leaf * 16u + 11u];
  if (primitive >= settings.count) { fault(); return; }
  let bounds = read_bounds(S_primitiveBounds + primitive * 8u);
  if (!valid_bounds(bounds)) { fault(); }
  set_node_bounds(leaf, bounds, bounds);
  atomicStore(&scratch[S_primitiveCounts + leaf], 1u);
}
fn delta(left_input: i32, right_input: i32) -> i32 {
  let left = min(left_input, right_input);
  let right = max(left_input, right_input);
  if (left < 0 || right >= i32(settings.count)) { return -1; }
  let a = atomicLoad(&scratch[S_keysA + u32(left) * 2u]);
  let b = atomicLoad(&scratch[S_keysA + u32(right) * 2u]);
  if (a != b) { return i32(countLeadingZeros(a ^ b)); }
  return 32 + i32(countLeadingZeros(u32(left) ^ u32(right)));
}
@compute @workgroup_size(${W})
fn topology(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let count = settings.count;
  if (index >= count) { return; }
  let leaf = count - 1u + index;
  let primitive = atomicLoad(&scratch[S_keysA + index * 2u + 1u]);
  let bounds = read_bounds(S_primitiveBounds + primitive * 8u);
  set_node_bounds(leaf, bounds, bounds);
  hierarchy[H_NODES + leaf * 16u + 3u] = primitive;
  hierarchy[H_NODES + leaf * 16u + 7u] = 1u;
  hierarchy[H_NODES + leaf * 16u + 11u] = primitive;
  hierarchy[H_NODES + leaf * 16u + 15u] = 1u;
  atomicStore(&scratch[S_primitiveCounts + leaf], 1u);
  if (index >= count - 1u) { return; }
  let current = i32(index);
  let direction = select(-1, 1, delta(current, current + 1) >= delta(current, current - 1));
  let minimum = delta(current, current - direction);
  var maximum = 2;
  loop {
    if (delta(current, current + maximum * direction) <= minimum) { break; }
    maximum *= 2;
  }
  var length = 0;
  for (var step = maximum / 2; step > 0; step /= 2) {
    if (delta(current, current + (length + step) * direction) > minimum) { length += step; }
  }
  let other = current + length * direction;
  var left = min(current, other);
  var right = max(current, other);
  let first = left;
  let last = right;
  let common_prefix = delta(left, right);
  loop {
    if (right <= left + 1) { break; }
    let split = (left + right) / 2;
    if (delta(left, split) > common_prefix) { left = split; } else { right = split; }
  }
  let split = u32(left);
  let child0 = select(split, count - 1u + split, left == first);
  let child1 = select(split + 1u, count + split, left + 1 == last);
  hierarchy[H_NODES + index * 16u + 3u] = child0;
  hierarchy[H_NODES + index * 16u + 7u] = 0u;
  hierarchy[H_NODES + index * 16u + 11u] = child1;
  hierarchy[H_NODES + index * 16u + 15u] = 0u;
  hierarchy[H_LINKS + child0 * 2u] = index;
  hierarchy[H_LINKS + child1 * 2u] = index;
}

@compute @workgroup_size(${W})
fn depth_initialize(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= settings.count * 2u - 1u || settings.count == 0u) { return; }
  let parent = hierarchy[H_LINKS + node * 2u];
  atomicStore(&scratch[S_parentsA + node * 2u], parent);
  atomicStore(&scratch[S_parentsA + node * 2u + 1u], select(1u, 0u, parent == INVALID));
}
@compute @workgroup_size(${W})
fn depth_jump(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  let nodes = settings.count * 2u - 1u;
  if (node >= nodes || settings.count == 0u) { return; }
  let source = select(S_parentsA, S_parentsB, settings.source != 0u);
  let destination = select(S_parentsB, S_parentsA, settings.source != 0u);
  var ancestor = atomicLoad(&scratch[source + node * 2u]);
  var depth = atomicLoad(&scratch[source + node * 2u + 1u]);
  if (ancestor != INVALID) {
    if (ancestor >= nodes || ancestor == node) { fault(); return; }
    depth += atomicLoad(&scratch[source + ancestor * 2u + 1u]);
    ancestor = atomicLoad(&scratch[source + ancestor * 2u]);
  }
  atomicStore(&scratch[destination + node * 2u], ancestor);
  atomicStore(&scratch[destination + node * 2u + 1u], depth);
}
@compute @workgroup_size(${W})
fn classify_depth(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= settings.count * 2u - 1u || settings.count == 0u) { return; }
  let source = select(S_parentsA, S_parentsB, settings.source != 0u);
  let ancestor = atomicLoad(&scratch[source + node * 2u]);
  let depth = atomicLoad(&scratch[source + node * 2u + 1u]);
  if (ancestor != INVALID || depth > MAX_DEPTH) {
    atomicOr(&scratch[S_control + 1u], 1u);
    return;
  }
  atomicStore(&scratch[S_depths + node], depth);
  atomicAdd(&scratch[S_levelCounts + depth], 1u);
}
// Rescue only: preorder internal numbering of a complete balanced range tree.
// Every invocation derives its interval independently, with logarithmic work.
// Re-running Morton topology would reproduce the original excessive depth.
@compute @workgroup_size(${W})
fn balanced_topology(@builtin(global_invocation_id) id: vec3u) {
  if (atomicLoad(&scratch[S_control + 1u]) == 0u || settings.count == 0u) { return; }
  let target_node = id.x;
  if (target_node >= settings.count * 2u - 1u) { return; }
  if (target_node == 0u) { hierarchy[H_LINKS] = INVALID; }
  if (target_node >= settings.count - 1u) { return; }
  var begin = 0u;
  var count = settings.count;
  var current = 0u;
  loop {
    if (current == target_node) { break; }
    let left_count = count / 2u;
    let right_root = current + left_count;
    if (target_node < right_root) {
      current++;
      count = left_count;
    } else {
      current = right_root;
      begin += left_count;
      count -= left_count;
    }
  }
  let left_count = count / 2u;
  let right_count = count - left_count;
  let left = select(current + 1u, settings.count - 1u + begin, left_count == 1u);
  let right = select(current + left_count, settings.count - 1u + begin + left_count, right_count == 1u);
  let at = H_NODES + current * 16u;
  hierarchy[at + 3u] = left;
  hierarchy[at + 11u] = right;
  hierarchy[at + 7u] = 0u;
  hierarchy[at + 15u] = 0u;
  hierarchy[H_LINKS + left * 2u] = current;
  hierarchy[H_LINKS + right * 2u] = current;
}
@compute @workgroup_size(${W})
fn reset_levels(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) { atomicStore(&scratch[S_control + 1u], 0u); }
  if (id.x <= MAX_DEPTH) {
    atomicStore(&scratch[S_levelCounts + id.x], 0u);
    atomicStore(&scratch[S_levelCursors + id.x], 0u);
  }
}
@compute @workgroup_size(1)
fn level_offsets() {
  var total = 0u;
  for (var depth = 0u; depth <= MAX_DEPTH; depth++) {
    atomicStore(&scratch[S_levelOffsets + depth], total);
    let count = atomicLoad(&scratch[S_levelCounts + depth]);
    total += count;
    atomicStore(&scratch[S_indirect + depth * 4u], (count + ${W - 1}u) / ${W}u);
    atomicStore(&scratch[S_indirect + depth * 4u + 1u], 1u);
    atomicStore(&scratch[S_indirect + depth * 4u + 2u], 1u);
    let treelet = S_indirect + (MAX_DEPTH + 1u + depth) * 4u;
    // One group per root, split across two dimensions when a level exceeds X.
    atomicStore(&scratch[treelet], min(count, settings.mode));
    atomicStore(&scratch[treelet + 1u], max(1u, (count + settings.mode - 1u) / settings.mode));
    atomicStore(&scratch[treelet + 2u], 1u);
  }
  if (total != select(0u, settings.count * 2u - 1u, settings.count > 0u)) { fault(); }
}
@compute @workgroup_size(${W})
fn scatter_levels(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (node >= settings.count * 2u - 1u || settings.count == 0u || atomicLoad(&scratch[S_control]) != 0u) { return; }
  let depth = atomicLoad(&scratch[S_depths + node]);
  let offset = atomicLoad(&scratch[S_levelOffsets + depth]);
  let index = atomicAdd(&scratch[S_levelCursors + depth], 1u);
  atomicStore(&scratch[S_levelNodes + offset + index], node);
}
@compute @workgroup_size(${W})
fn refit(@builtin(global_invocation_id) id: vec3u) {
  let depth = settings.phase;
  if (id.x >= atomicLoad(&scratch[S_levelCounts + depth]) || atomicLoad(&scratch[S_control]) != 0u) { return; }
  let node = atomicLoad(&scratch[S_levelNodes + atomicLoad(&scratch[S_levelOffsets + depth]) + id.x]);
  if (node >= settings.count - 1u) { return; }
  let at = H_NODES + node * 16u;
  let left = hierarchy[at + 3u];
  let right = hierarchy[at + 11u];
  set_node_bounds(node, node_bounds(left), node_bounds(right));
  atomicStore(&scratch[S_primitiveCounts + node],
    atomicLoad(&scratch[S_primitiveCounts + left]) + atomicLoad(&scratch[S_primitiveCounts + right]));
}
@compute @workgroup_size(${W})
fn rebuild_links(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (settings.count == 0u || node >= settings.count - 1u) { return; }
  let at = H_NODES + node * 16u;
  hierarchy[H_LINKS + hierarchy[at + 3u] * 2u] = node;
  hierarchy[H_LINKS + hierarchy[at + 11u] * 2u] = node;
}
@compute @workgroup_size(${W})
fn escape_links(@builtin(global_invocation_id) id: vec3u) {
  let node = id.x;
  if (settings.count == 0u || node >= settings.count * 2u - 1u) { return; }
  var current = node;
  var escape = INVALID;
  for (var step = 0u; step <= MAX_DEPTH; step++) {
    let parent = hierarchy[H_LINKS + current * 2u];
    if (parent == INVALID) { break; }
    let at = H_NODES + parent * 16u;
    if (hierarchy[at + 3u] == current) {
      escape = hierarchy[at + 11u];
      break;
    }
    current = parent;
  }
  hierarchy[H_LINKS + node * 2u + 1u] = escape;
}
// GPU update classification uses the copied candidate only. Compact source
// order is deterministic; membership/count changes require a fresh topology.
@compute @workgroup_size(${W})
fn update_policy(@builtin(global_invocation_id) id: vec3u) {
  let count = atomicLoad(&scratch[S_input]);
  if (id.x == 0u && (hierarchy[0] != count || hierarchy[2] != 0u ||
      hierarchy[5] >= 32u || hierarchy[7] == 3u)) {
    atomicOr(&scratch[S_input + 2u], 2u);
  }
  if (id.x >= count || hierarchy[0] != count) { return; }
  let leaf = count - 1u + id.x;
  let primitive = hierarchy[H_NODES + leaf * 16u + 11u];
  if (primitive >= count || hierarchy[${h.references!.offset / 4}u + primitive] !=
      atomicLoad(&scratch[S_primitiveBounds + primitive * 8u + 3u])) {
    atomicOr(&scratch[S_input + 2u], 2u);
    return;
  }
  for (var axis = 0u; axis < 3u; axis++) {
    if (hierarchy[H_NODES + leaf * 16u + axis] != atomicLoad(&scratch[S_primitiveBounds + primitive * 8u + axis]) ||
        hierarchy[H_NODES + leaf * 16u + 4u + axis] != atomicLoad(&scratch[S_primitiveBounds + primitive * 8u + 4u + axis])) {
      atomicOr(&scratch[S_input + 2u], 1u);
    }
  }
}
@compute @workgroup_size(1)
fn update_decide() {
  let flags = atomicLoad(&scratch[S_input + 2u]);
  let action = select(select(0u, 1u, flags != 0u), 3u, (flags & 2u) != 0u);
  atomicStore(&scratch[S_input + 1u], action);
  hierarchy[8] = action;
}
var<workgroup> quality_costs: array<f32, ${W}>;
fn normalized_area(bounds: Bounds) -> f32 {
  let scene = read_bounds(S_sceneBounds);
  let scale = max(max(max(abs(scene.low.x), abs(scene.high.x)),
    max(abs(scene.low.y), abs(scene.high.y))), max(abs(scene.low.z), abs(scene.high.z)));
  if (scale == 0.0) { return 0.0; }
  let exponent = frexp(scale).exp;
  var extent = vec3f(0.0);
  for (var axis = 0u; axis < 3u; axis++) {
    extent[axis] = max(0.0, exponent_scaled(bounds.high[axis], exponent) - exponent_scaled(bounds.low[axis], exponent));
  }
  return 2.0 * (extent.x * extent.y + extent.x * extent.z + extent.y * extent.z);
}
@compute @workgroup_size(${W})
fn quality_reduce(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * ${W}u + lane;
  let nodes = select(0u, settings.count * 2u - 1u, settings.count != 0u);
  var cost = 0.0;
  // One contribution per binary node; common normalization avoids overflow.
  if (index < nodes) { cost = normalized_area(node_bounds(index)); }
  quality_costs[lane] = cost;
  workgroupBarrier();
  for (var width = ${W / 2}u; width > 0u; width >>= 1u) {
    if (lane < width) { quality_costs[lane] += quality_costs[lane + width]; }
    workgroupBarrier();
  }
  if (lane == 0u) { atomicStore(&scratch[S_quality + group.x], bitcast<u32>(quality_costs[0])); }
}
@compute @workgroup_size(1)
fn quality_decide() {
  var cost = 0.0;
  let nodes = select(0u, settings.count * 2u - 1u, settings.count != 0u);
  for (var block = 0u; block < (nodes + ${W - 1}u) / ${W}u; block++) {
    cost += scratch_float(S_quality + block);
  }
  let root_area = select(1.0, normalized_area(node_bounds(0u)), settings.count != 0u);
  cost /= max(root_area, 1e-30);
  let baseline = bitcast<f32>(hierarchy[4]);
  let action = atomicLoad(&scratch[S_input + 1u]);
  if (settings.phase == 0u && action == 1u && baseline > 0.0 && cost > baseline * 1.2) {
    atomicStore(&scratch[S_input + 1u], 2u);
  }
  if (settings.phase == 1u) {
    if (action == 3u || baseline <= 0.0) { hierarchy[4] = bitcast<u32>(cost); }
    hierarchy[6] = bitcast<u32>(cost);
    // GPU persistent rebuild request, consumed by the next immutable update.
    hierarchy[7] = select(0u, 3u, baseline > 0.0 && cost > baseline * 2.0);
  }
}
@compute @workgroup_size(${W})
fn publish_references(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < settings.count) {
    hierarchy[${h.references!.offset / 4}u + id.x] = atomicLoad(&scratch[S_primitiveBounds + id.x * 8u + 3u]);
  }
}
@compute @workgroup_size(1)
fn finalize() {
  hierarchy[0] = settings.count;
  hierarchy[1] = select(INVALID, 0u, settings.count > 0u);
  hierarchy[2] = atomicLoad(&scratch[S_control]);
  hierarchy[3] = atomicLoad(&scratch[S_control + 1u]);
  hierarchy[5] = select(hierarchy[5] + 1u, 0u, atomicLoad(&scratch[S_input + 1u]) == 3u);
  hierarchy[8] = atomicLoad(&scratch[S_input + 1u]);
}
`;
}

/** Seven-frontier-node treelet, complete subset dynamic-programming SAH.
 * Adapted from RadeonRays dx/kernels/restructure_bvh.hlsl::Restructure.
 * A dispatch handles one immutable depth, so its roots never overlap. No
 * cross-workgroup atomic arrival publication is used. Rebuilt levels follow.
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
export function scgiBvhTreeletWgsl(plan: ScgiBvhPlan): string {
  const h = plan.hierarchy.ranges;
  const s = plan.scratch.ranges;
  return /* wgsl */ `
struct Settings { count: u32, depth: u32, source: u32, mode: u32, }
@group(0) @binding(0) var<storage, read_write> hierarchy: array<u32>;
@group(0) @binding(1) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(2) var<uniform> settings: Settings;
const NODES: u32 = ${h.nodes!.offset / 4}u;
const LINKS: u32 = ${h.links!.offset / 4}u;
const COUNTS: u32 = ${s.primitiveCounts!.offset / 4}u;
var<workgroup> frontier: array<u32, 7>;
var<workgroup> internals: array<u32, 6>;
var<workgroup> subset_low: array<vec3f, 128>;
var<workgroup> subset_high: array<vec3f, 128>;
var<workgroup> costs: array<f32, 128>;
var<workgroup> partitions: array<u32, 128>;
var<workgroup> frontier_low: array<vec3f, 7>;
var<workgroup> frontier_high: array<vec3f, 7>;
var<workgroup> enabled: u32;
fn bounds_low(node: u32) -> vec3f {
  let at = NODES + node * 16u;
  return min(vec3f(bitcast<f32>(hierarchy[at]), bitcast<f32>(hierarchy[at + 1u]), bitcast<f32>(hierarchy[at + 2u])),
    vec3f(bitcast<f32>(hierarchy[at + 8u]), bitcast<f32>(hierarchy[at + 9u]), bitcast<f32>(hierarchy[at + 10u])));
}
fn bounds_high(node: u32) -> vec3f {
  let at = NODES + node * 16u;
  return max(vec3f(bitcast<f32>(hierarchy[at + 4u]), bitcast<f32>(hierarchy[at + 5u]), bitcast<f32>(hierarchy[at + 6u])),
    vec3f(bitcast<f32>(hierarchy[at + 12u]), bitcast<f32>(hierarchy[at + 13u]), bitcast<f32>(hierarchy[at + 14u])));
}
fn area(low: vec3f, high: vec3f) -> f32 {
  let scene = ${s.sceneBounds!.offset / 4}u;
  let scene_low = vec3f(bitcast<f32>(scratch[scene]), bitcast<f32>(scratch[scene + 1u]), bitcast<f32>(scratch[scene + 2u]));
  let scene_high = vec3f(bitcast<f32>(scratch[scene + 4u]), bitcast<f32>(scratch[scene + 5u]), bitcast<f32>(scratch[scene + 6u]));
  let absolute = max(abs(scene_high), abs(scene_low));
  let scale = max(max(absolute.x, absolute.y), absolute.z);
  // A single positive normalization factor preserves SAH partition ordering
  // while keeping finite input coordinates from overflowing area products.
  if (scale <= 0.0) { return 0.0; }
  let exponent = frexp(scale).exp;
  let low_parts = frexp(low);
  let high_parts = frexp(high);
  let extent = max(ldexp(high_parts.fract, max(vec3i(-126), high_parts.exp - vec3i(exponent))) -
    ldexp(low_parts.fract, max(vec3i(-126), low_parts.exp - vec3i(exponent))), vec3f(0.0));
  return 2.0 * (extent.x * extent.y + extent.x * extent.z + extent.y * extent.z);
}
@compute @workgroup_size(64)
fn restructure(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u,
    @builtin(num_workgroups) dimensions: vec3u) {
  let node_count = select(0u, settings.count * 2u - 1u, settings.count > 0u);
  let index = group.x + group.y * dimensions.x;
  let level_count = scratch[${s.levelCounts!.offset / 4}u + settings.depth];
  // The list retains original depths until every restructuring dispatch ends.
  // Roots of a given original depth remain disjoint after descendant rewrites.
  var root = node_count;
  if (index < level_count) {
    root = scratch[${s.levelNodes!.offset / 4}u + scratch[${s.levelOffsets!.offset / 4}u + settings.depth] + index];
  }
  if (lane == 0u) {
    enabled = 0u;
    if (scratch[${s.input!.offset / 4 + 1}u] >= 2u && root < node_count && root < settings.count - 1u &&
        scratch[${s.depths!.offset / 4}u + root] == settings.depth && scratch[COUNTS + root] >= 7u &&
        scratch[${s.control!.offset / 4}u] == 0u) {
      enabled = 1u;
      internals[0] = root;
      frontier[0] = hierarchy[NODES + root * 16u + 3u];
      frontier[1] = hierarchy[NODES + root * 16u + 11u];
      for (var size = 2u; size < 7u; size++) {
        var selected = 0xffffffffu;
        var largest = -1.0;
        for (var index = 0u; index < size; index++) {
          let node = frontier[index];
          if (node < settings.count - 1u) {
            let surface_area = area(bounds_low(node), bounds_high(node));
            if (surface_area > largest) { selected = index; largest = surface_area; }
          }
        }
        if (selected == 0xffffffffu) { enabled = 0u; break; }
        let node = frontier[selected];
        internals[size - 1u] = node;
        frontier[selected] = hierarchy[NODES + node * 16u + 3u];
        frontier[size] = hierarchy[NODES + node * 16u + 11u];
      }
    }
  }
  workgroupBarrier();
  // workgroupUniformLoad makes the root eligibility branch provably uniform.
  let root_enabled = workgroupUniformLoad(&enabled);
  if (root_enabled == 0u) { return; }
  if (lane < 7u) {
    frontier_low[lane] = bounds_low(frontier[lane]);
    frontier_high[lane] = bounds_high(frontier[lane]);
  }
  workgroupBarrier();
  for (var part = 0u; part < 2u; part++) {
    let mask = lane + part * 64u;
    var low = vec3f(3.402823466e38);
    var high = vec3f(-3.402823466e38);
    for (var index = 0u; index < 7u; index++) {
      if ((mask & (1u << index)) != 0u) {
        low = min(low, frontier_low[index]);
        high = max(high, frontier_high[index]);
      }
    }
    subset_low[mask] = low;
    subset_high[mask] = high;
    costs[mask] = select(0.0, 1.2 * area(low, high), mask != 0u);
    partitions[mask] = 0u;
  }
  workgroupBarrier();
  for (var bits = 2u; bits <= 7u; bits++) {
    for (var part = 0u; part < 2u; part++) {
      let mask = lane + part * 64u;
      if (countOneBits(mask) == bits) {
        let anchor = mask & (0u - mask);
        var best = 3.402823466e38;
        var best_partition = 0u;
        var subset = (mask - 1u) & mask;
        loop {
          if (subset == 0u) { break; }
          if ((subset & anchor) != 0u) {
            let candidate = costs[subset] + costs[mask ^ subset];
            if (candidate < best || (candidate == best && subset < best_partition)) {
              best = candidate;
              best_partition = subset;
            }
          }
          subset = (subset - 1u) & mask;
        }
        costs[mask] = best + 1.2 * area(subset_low[mask], subset_high[mask]);
        partitions[mask] = best_partition;
      }
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    var masks: array<u32, 7>;
    var targets: array<u32, 7>;
    masks[0] = 127u;
    targets[0] = root;
    var stack = 1u;
    var next_internal = 1u;
    loop {
      if (stack == 0u) { break; }
      stack--;
      let mask = masks[stack];
      let node = targets[stack];
      let left_mask = partitions[mask];
      let right_mask = mask ^ left_mask;
      let at = NODES + node * 16u;
      var child_nodes: array<u32, 2>;
      var child_masks = array<u32, 2>(left_mask, right_mask);
      for (var side = 0u; side < 2u; side++) {
        let child_mask = child_masks[side];
        if (countOneBits(child_mask) == 1u) {
          child_nodes[side] = frontier[countTrailingZeros(child_mask)];
        } else {
          let child = internals[next_internal];
          next_internal++;
          child_nodes[side] = child;
          masks[stack] = child_mask;
          targets[stack] = child;
          stack++;
        }
        let offset = at + side * 8u;
        hierarchy[offset + 3u] = child_nodes[side];
        hierarchy[offset + 7u] = 0u;
        for (var axis = 0u; axis < 3u; axis++) {
          hierarchy[offset + axis] = bitcast<u32>(subset_low[child_mask][axis]);
          hierarchy[offset + 4u + axis] = bitcast<u32>(subset_high[child_mask][axis]);
        }
      }
      // Node primitive counts depend only on frontier subsets, not rebuild
      // visitation order. Frontier roots are never overwritten by this group.
      var primitives = 0u;
      for (var index = 0u; index < 7u; index++) {
        if ((mask & (1u << index)) != 0u) { primitives += scratch[COUNTS + frontier[index]]; }
      }
      scratch[COUNTS + node] = primitives;
    }
  }
}
`;
}

/** Stable 4-bit radix profile: digit-major global histograms, hierarchical
 * exclusive scan and stable local binary partitions. Source reference:
 * RadeonRays dx/algorithm/{radix_sort.cpp,kernels/scatter.hlsl}. The portable
 * workgroup scan and optional subgroup reduction share the same output order. */
export function scgiBvhRadixWgsl(plan: ScgiBvhPlan, subgroup: boolean): string {
  const s = plan.scratch.ranges;
  const source = s.keysA!.offset / 4;
  const target = s.keysB!.offset / 4;
  const hist = s.histogram0!.offset / 4;
  const prefix = s.prefix0!.offset / 4;
  const subgroupReduction = subgroup ? "let total = subgroupAdd(selected);" : "";
  // Subgroup total is used only to avoid shared histogram atomics. Scatter
  // still uses a portable stable partition, independent of subgroup lane size.
  const histogram = subgroup
    ? /* wgsl */ `
    for (var bin = 0u; bin < 16u; bin++) {
      let selected = select(0u, 1u, index < settings.count && digit == bin);
      ${subgroupReduction}
      if (subgroup_lane == 0u) { atomicAdd(&bins[bin], total); }
    }
  `
    : /* wgsl */ `
    if (index < settings.count) { atomicAdd(&bins[digit], 1u); }
  `;
  return /* wgsl */ `
${subgroup ? "enable subgroups;" : ""}
struct RadixSettings { count: u32, phase: u32, source: u32, mode: u32, }
@group(0) @binding(0) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(1) var<uniform> settings: RadixSettings;
var<workgroup> bins: array<atomic<u32>, 16>;
var<workgroup> keys: array<u32, ${W}>;
var<workgroup> values: array<u32, ${W}>;
var<workgroup> next_keys: array<u32, ${W}>;
var<workgroup> next_values: array<u32, ${W}>;
var<workgroup> scan: array<u32, ${W}>;
var<workgroup> first: array<atomic<u32>, 16>;
@compute @workgroup_size(${W})
fn histogram(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u
  ${subgroup ? ", @builtin(subgroup_invocation_id) subgroup_lane: u32" : ""}) {
  if (lane < 16u) { atomicStore(&bins[lane], 0u); }
  workgroupBarrier();
  let index = group.x * ${W}u + lane;
  let input = select(${source}u, ${target}u, settings.source != 0u);
  var digit = 0u;
  if (index < settings.count) { digit = (scratch[input + index * 2u] >> settings.phase) & 15u; }
  ${histogram}
  workgroupBarrier();
  if (lane < 16u) { scratch[${hist}u + lane * ${plan.blocks}u + group.x] = atomicLoad(&bins[lane]); }
}
@compute @workgroup_size(${W})
fn scatter(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * ${W}u + lane;
  let input = select(${source}u, ${target}u, settings.source != 0u);
  let output = select(${target}u, ${source}u, settings.source != 0u);
  keys[lane] = 0xffffffffu;
  values[lane] = 0xffffffffu;
  if (index < settings.count) {
    keys[lane] = scratch[input + index * 2u];
    values[lane] = scratch[input + index * 2u + 1u];
  }
  workgroupBarrier();
  for (var bit = 0u; bit < 4u; bit++) {
    let flag = 1u - ((keys[lane] >> (settings.phase + bit)) & 1u);
    scan[lane] = flag;
    workgroupBarrier();
    for (var width = 1u; width < ${W}u; width <<= 1u) {
      var add = 0u;
      if (lane >= width) { add = scan[lane - width]; }
      workgroupBarrier();
      scan[lane] += add;
      workgroupBarrier();
    }
    let before = scan[lane] - flag;
    let zeros = scan[${W - 1}u];
    let destination = select(zeros + lane - before, before, flag != 0u);
    next_keys[destination] = keys[lane];
    next_values[destination] = values[lane];
    workgroupBarrier();
    keys[lane] = next_keys[lane];
    values[lane] = next_values[lane];
    workgroupBarrier();
  }
  if (lane < 16u) { atomicStore(&first[lane], ${W}u); }
  workgroupBarrier();
  let digit = (keys[lane] >> settings.phase) & 15u;
  atomicMin(&first[digit], lane);
  workgroupBarrier();
  let primitive = values[lane];
  if (primitive != 0xffffffffu) {
    let destination = scratch[${prefix}u + digit * ${plan.blocks}u + group.x] + lane - atomicLoad(&first[digit]);
    scratch[output + destination * 2u] = keys[lane];
    scratch[output + destination * 2u + 1u] = primitive;
  }
}
`;
}

export function scgiBvhScanWgsl(plan: ScgiBvhPlan, level: number): string {
  const ranges = plan.scratch.ranges;
  const count = plan.scanCounts[level]!;
  const input = ranges[`histogram${level}`]!.offset / 4;
  const output = ranges[`prefix${level}`]!.offset / 4;
  const next = ranges[`histogram${level + 1}`]?.offset;
  const parent = ranges[`prefix${level + 1}`]?.offset;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> scratch: array<u32>;
var<workgroup> scan: array<u32, ${W}>;
@compute @workgroup_size(${W})
fn scan_up(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * ${W}u + lane;
  var value = 0u;
  if (index < ${count}u) { value = scratch[${input}u + index]; }
  scan[lane] = value;
  workgroupBarrier();
  for (var width = 1u; width < ${W}u; width <<= 1u) {
    var add = 0u;
    if (lane >= width) { add = scan[lane - width]; }
    workgroupBarrier();
    scan[lane] += add;
    workgroupBarrier();
  }
  if (index < ${count}u) { scratch[${output}u + index] = scan[lane] - value; }
  ${next === undefined ? "" : `if (lane == ${W - 1}u) { scratch[${next / 4}u + group.x] = scan[lane]; }`}
}
@compute @workgroup_size(${W})
fn scan_down(@builtin(global_invocation_id) id: vec3u) {
  ${parent === undefined ? "" : `if (id.x < ${count}u) { scratch[${output}u + id.x] += scratch[${parent / 4}u + id.x / ${W}u]; }`}
}
`;
}
