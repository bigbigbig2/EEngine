import { SCGI_ABI } from "../render/gi/ScgiAbi.js";
import type { ScgiAllocationPlan } from "../render/gi/ScgiCapacity.js";
import { SCGI_CACHE_WORKGROUP_SIZE as W } from "../render/gi/ScgiCacheLayout.js";

/** Local cache implementation. No Unity code is included. Arena offsets are
 * specialized only by physical capacity/layout, never lighting quality modes. */
export function scgiCacheWgsl(plan: ScgiAllocationPlan): string {
  const world = plan.world.ranges;
  const scratch = plan.scratch.ranges;
  const s = (name: string) => `${scratch[name]!.offset / 4}u`;
  const w = (name: string) => `${world[name]!.offset / 4}u`;
  const p = plan.profile;
  const totalRequests = p.requests + p.bounceRequests;
  if (totalRequests * 2 >= 0xffffffff) {
    throw new RangeError("SCGI cache claim priority exceeds u32");
  }
  const priorityScatter = [0, 1, 2, 3]
    .map(
      (i) => `if atomicLoad(&scratch[${s(`cachePriority${i}Flags0`)} + index]) != 0u {
    atomicStore(&scratch[PRIORITIES + ${i}u * K + atomicLoad(&scratch[${s(`cachePriority${i}Prefix0`)} + index])], slot);
  }`,
    )
    .join("\n  ");
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> world: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> previous: array<u32>;
@group(0) @binding(3) var<storage, read_write> indirect: array<atomic<u32>>;
const EMPTY: u32 = 0xffffffffu;
const K: u32 = ${p.patches}u;
const R: i32 = ${p.resolution};
const C: u32 = ${p.cascades}u;
const CELLS: u32 = ${plan.cells}u;
const Q: u32 = ${p.requests}u;
const B: u32 = ${p.bounceRequests}u;
const T: u32 = ${totalRequests}u;
const MAP: u32 = ${w("map")};
const PATCH: u32 = ${w("patches")};
const CACHE: u32 = ${w("cacheState")};
const FREE: u32 = ${w("freeSlots")};
const BOUNCE: u32 = ${w("bounceRequests")};
const SETTINGS: u32 = ${s("cacheSettings")};
const CONTROL: u32 = ${s("cacheControl")};
const CLAIM: u32 = ${s("cacheClaims")};
const REQUEST_CELL: u32 = ${s("cacheRequestCells")};
const REQUEST: u32 = ${s("requests")};
const ACTIVE: u32 = ${s("cacheActive")};
const PRIORITIES: u32 = ${s("cachePriorityLists")};
const MOVES: u32 = ${s("cacheMoves")};
const A1: u32 = ${s("a1")};
const UPDATES: u32 = ${s("updateList")};
const ARGS: u32 = ${plan.batch.ranges.cacheIndirect!.offset / 4}u;
const DIRTY: u32 = ${s("cacheDirtyRegions")};
fn setting(i: u32) -> u32 {
  return atomicLoad(&scratch[SETTINGS + i]);
}
fn sf(i: u32) -> f32 {
  return bitcast<f32>(setting(i));
}
fn counter(i: u32) -> u32 {
  return atomicLoad(&scratch[CONTROL + i]);
}
fn put(i: u32, v: u32) {
  atomicStore(&scratch[CONTROL + i], v);
}
fn patch_address(i: u32) -> u32 {
  return PATCH + i * ${SCGI_ABI.patch.stride / 4}u;
}
fn cache_state(slot: u32) -> u32 {
  return CACHE + slot * 4u;
}
fn wf(at: u32) -> f32 {
  return bitcast<f32>(atomicLoad(&world[at]));
}
fn position(at: u32) -> vec3f {
  return vec3f(wf(at), wf(at + 1u), wf(at + 2u));
}
fn signed_mod(x: i32) -> u32 {
  return u32(((x % R) + R) % R);
}
fn origin(c: u32) -> vec3i {
  let at = 16u + c * 4u;
  return vec3i(bitcast<i32>(setting(at)), bitcast<i32>(setting(at + 1u)), bitcast<i32>(setting(at + 2u)));
}
fn scale(c: u32) -> f32 {
  return sf(4u) * f32(1u << c);
}
fn direction_bin(normal: vec3f) -> u32 {
  let denominator = abs(normal.x) + abs(normal.y) + abs(normal.z);
  if denominator < 0.000001 {
    return EMPTY;
  }
  let n = normal / denominator;
  var uv = n.xy;
  if n.z < 0.0 {
    uv = (vec2f(1.0) - abs(uv.yx)) * select(vec2f(-1.0), vec2f(1.0), uv >= vec2f(0.0));
  }
  let bin = min(vec2u((uv * 0.5 + 0.5) * 4.0), vec2u(3u));
  return bin.y * 4u + bin.x;
}
fn cell_for(pos: vec3f, normal: vec3f) -> vec3u {
  let direction = direction_bin(normal);
  if direction == EMPTY {
    return vec3u(EMPTY);
  }
  for (var c = 0u; c < C; c++) {
    let coordinate = floor(pos / scale(c));
    // Reject before conversion: WGSL float-to-int saturation cannot establish coverage.
    let relative = coordinate - vec3f(origin(c));
    if all(relative >= vec3f(0.0)) && all(relative < vec3f(f32(R))) {
      let xyz = origin(c) + vec3i(relative);
      let spatial = (signed_mod(xyz.x) * u32(R) + signed_mod(xyz.y)) * u32(R) + signed_mod(xyz.z);
      return vec3u((c * u32(R * R * R) + spatial) * 16u + direction, c, direction);
    }
  }
  return vec3u(EMPTY);
}
fn stored_cell(pos: vec3f, c: u32, direction: u32) -> u32 {
  if c >= C || direction >= 16u {
    return EMPTY;
  }
  let relative = floor(pos / scale(c)) - vec3f(origin(c));
  if any(relative < vec3f(0.0)) || any(relative >= vec3f(f32(R))) {
    return EMPTY;
  }
  let xyz = origin(c) + vec3i(relative);
  return (c * u32(R * R * R) + (signed_mod(xyz.x) * u32(R) + signed_mod(xyz.y)) * u32(R) + signed_mod(xyz.z)) * 16u + direction;
}
fn req_word(id: u32, lane: u32) -> u32 {
  if id < counter(0u) {
    return atomicLoad(&scratch[REQUEST + id * 28u + lane]);
  }
  return previous[BOUNCE + (id - counter(0u)) * 28u + lane];
}
fn req_pos(id: u32) -> vec3f {
  return bitcast<vec3f>(vec3u(req_word(id, 0u), req_word(id, 1u), req_word(id, 2u)));
}
fn req_normal(id: u32) -> vec3f {
  return bitcast<vec3f>(vec3u(req_word(id, 4u), req_word(id, 5u), req_word(id, 6u)));
}
fn req_rank(id: u32) -> u32 {
  return select(1u, 0u, id < counter(0u) && req_word(id, 21u) == 0u);
}
fn req_key(id: u32) -> u32 {
  let rotation = setting(0u) % T;
  return req_rank(id) * T + (id + T - rotation) % T;
}
fn finite3(v: vec3f) -> bool {
  return all(abs(v) <= vec3f(3.402823466e38));
}
fn compatible(id: u32, at: u32, c: u32) -> bool {
  let n = req_normal(id);
  let old = position(at + 4u);
  let distance = req_pos(id) - position(at);
  if dot(n, old) < sf(5u) || abs(dot(distance, old)) > scale(c) * sf(6u) || abs(dot(distance, n)) > scale(c) * sf(6u) {
    return false;
  }
  for (var lane = 0u; lane < 12u; lane++) {
    if req_word(id, 8u + lane) != atomicLoad(&world[at + 8u + lane]) {
      return false;
    }
  }
  for (var lane = 0u; lane < 4u; lane++) {
    if req_word(id, 24u + lane) != atomicLoad(&world[at + 72u + lane]) { return false; }
  }
  return true;
}
fn remove(slot: u32, cell: u32) {
  atomicStore(&world[MAP + cell * 2u], EMPTY);
  atomicStore(&world[MAP + cell * 2u + 1u], 0u);
  atomicStore(&world[cache_state(slot) + 3u], 0u);
}
@compute @workgroup_size(${W})
fn clear_claims(@builtin(global_invocation_id) tid: vec3u) {
  if tid.x < CELLS {
    atomicStore(&scratch[CLAIM + tid.x], EMPTY);
  }
}
@compute @workgroup_size(1)
fn begin() {
  // The compact active list is a logical ring; physical pool occupancy is
  // explicit cacheState, so partial defrag never implies contiguous slots.
  atomicStore(&world[16u], setting(0u) % K);
  if setting(11u) != 0u && previous[15u] != 0u {
    put(9u, previous[15u]);
  }
  let count = counter(0u);
  if count > Q {
    put(7u, max(counter(7u), count - Q));
    put(0u, Q);
  }
  var bounce = 0u;
  if setting(11u) != 0u && setting(2u) != 0u {
    bounce = min(previous[20u], B);
  }
  put(1u, counter(0u) + bounce);
  atomicStore(&world[20u], 0u);
  atomicStore(&world[21u], 0u);
  atomicStore(&world[23u], 0u);
  atomicStore(&indirect[ARGS + 4u], (counter(1u) + ${W - 1}u) / ${W}u);
  atomicStore(&indirect[ARGS + 5u], 1u);
  atomicStore(&indirect[ARGS + 6u], 1u);
}
@compute @workgroup_size(${W})
fn maintain(@builtin(global_invocation_id) tid: vec3u) {
  let slot = tid.x;
  if slot >= K {
    return;
  }
  let at = patch_address(slot);
  if atomicLoad(&world[cache_state(slot) + 3u]) == 0u {
    return;
  }
  let cell = atomicLoad(&world[at + 20u]);
  let c = atomicLoad(&world[at + 21u]);
  let direction = atomicLoad(&world[at + 22u]);
  if cell >= CELLS || c >= C {
    atomicAdd(&scratch[CONTROL + 9u], 1u);
    return;
  }
  let epoch = atomicLoad(&world[43u + c * 4u]);
  let expired = epoch != setting(1u) || wf(27u + c * 4u) != scale(c) || stored_cell(position(at), c, direction) != cell;
  var discardPatch = expired;
  let frame = setting(0u);
  let claim = atomicLoad(&scratch[CLAIM + cell]);
  if claim != EMPTY && !expired {
    let id = (claim % T + frame % T) % T;
    if id < counter(1u) && compatible(id, at, c) {
      atomicStore(&world[at + 28u], frame);
      if req_rank(id) == 0u {
        atomicStore(&world[at + 68u], 0u);
        atomicStore(&world[cache_state(slot)], frame);
      }
    }
  }
  let lastAccess = atomicLoad(&world[at + 28u]);
  let rank = atomicLoad(&world[at + 68u]);
  let demotion = atomicLoad(&world[cache_state(slot)]);
  let ageStart = max(lastAccess, demotion);
  if frame > ageStart && frame - ageStart > setting(3u) {
    if setting(2u) != 0u && rank == 0u && !expired {
      atomicStore(&world[at + 68u], 1u);
      atomicStore(&world[cache_state(slot)], frame);
    }
    else {
      discardPatch = true;
    }
  }
  if discardPatch {
    remove(slot, cell);
    return;
  }
  var dirty = setting(10u) != 0u;
  let pos = position(at);
  for (var i = 0u; i < setting(9u); i++) {
    let region = DIRTY + i * 8u;
    let lo = bitcast<vec3f>(vec3u(atomicLoad(&scratch[region]), atomicLoad(&scratch[region + 1u]), atomicLoad(&scratch[region + 2u])));
    let hi = bitcast<vec3f>(vec3u(atomicLoad(&scratch[region + 4u]), atomicLoad(&scratch[region + 5u]), atomicLoad(&scratch[region + 6u])));
    dirty = dirty || (all(pos >= lo) && all(pos <= hi));
  }
  if dirty {
    atomicStore(&world[cache_state(slot) + 1u], 1u);
  }
}
@compute @workgroup_size(${W})
fn claim_requests(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= counter(1u) {
    return;
  }
  let pos = req_pos(id);
  let normal = req_normal(id);
  let length2 = dot(normal, normal);
  var cell = vec3u(EMPTY);
  if finite3(pos) && finite3(normal) && length2 > 0.99 && length2 < 1.01 {
    cell = cell_for(pos, normal);
  }
  atomicStore(&scratch[REQUEST_CELL + id], cell.x);
  if cell.x == EMPTY {
    atomicAdd(&scratch[CONTROL + 10u], 1u);
    return;
  }
  let oldSlot = atomicLoad(&world[MAP + cell.x * 2u]);
  if oldSlot < K {
    let at = patch_address(oldSlot);
    let c = atomicLoad(&world[at + 21u]);
    let direction = atomicLoad(&world[at + 22u]);
    if c < C && atomicLoad(&world[43u + c * 4u]) == setting(1u) &&
      wf(27u + c * 4u) == scale(c) && stored_cell(position(at), c, direction) == cell.x &&
      !compatible(id, at, c) {
      atomicStore(&scratch[REQUEST_CELL + id], EMPTY);
      atomicAdd(&scratch[CONTROL + 6u], 1u);
      return;
    }
  }
  atomicMin(&scratch[CLAIM + cell.x], req_key(id));
}
@compute @workgroup_size(${W})
fn resolve_requests(@builtin(global_invocation_id) tid: vec3u) {
  let index = tid.x;
  if index >= T {
    return;
  }
  let id = (index + setting(0u) % T) % T;
  atomicStore(&scratch[${s("cacheWinnerFlags0")} + index], 0u);
  atomicStore(&scratch[${s("cacheVisibleWinnerFlags0")} + index], 0u);
  if id >= counter(1u) {
    return;
  }
  let cell = atomicLoad(&scratch[REQUEST_CELL + id]);
  if cell == EMPTY || atomicLoad(&scratch[CLAIM + cell]) != req_key(id) {
    return;
  }
  let slot = atomicLoad(&world[MAP + cell * 2u]);
  if slot == EMPTY {
    atomicStore(&scratch[${s("cacheWinnerFlags0")} + index], 1u);
    atomicStore(&scratch[${s("cacheVisibleWinnerFlags0")} + index], select(0u, 1u, req_rank(id) == 0u));
    return;
  }
  if slot >= K {
    atomicAdd(&scratch[CONTROL + 9u], 1u);
    return;
  }
  let at = patch_address(slot);
  let c = atomicLoad(&world[at + 21u]);
  if !compatible(id, at, c) {
    atomicAdd(&scratch[CONTROL + 6u], 1u);
    return;
  }
  atomicStore(&world[at + 28u], setting(0u));
  if req_rank(id) == 0u {
    atomicStore(&world[at + 68u], 0u);
    atomicStore(&world[cache_state(slot)], setting(0u));
  }
}
@compute @workgroup_size(${W})
fn classify_free(@builtin(global_invocation_id) tid: vec3u) {
  if tid.x >= K {
    return;
  }
  let live = atomicLoad(&world[cache_state(tid.x) + 3u]) != 0u;
  atomicStore(&scratch[${s("cacheFreeFlags0")} + tid.x], select(1u, 0u, live));
}
@compute @workgroup_size(${W})
fn scatter_free(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= K {
    return;
  }
  if atomicLoad(&scratch[${s("cacheFreeFlags0")} + id]) != 0u {
    atomicStore(&world[FREE + atomicLoad(&scratch[${s("cacheFreePrefix0")} + id])], id);
  }
}
@compute @workgroup_size(${W})
fn allocate(@builtin(global_invocation_id) tid: vec3u) {
  let index = tid.x;
  if index >= T || atomicLoad(&scratch[${s("cacheWinnerFlags0")} + index]) == 0u {
    return;
  }
  let id = (index + setting(0u) % T) % T;
  let visiblePrefix = atomicLoad(&scratch[${s("cacheVisibleWinnerPrefix0")} + index]);
  let prefix = atomicLoad(&scratch[${s("cacheWinnerPrefix0")} + index]);
  let ticket = select(counter(12u) + prefix - visiblePrefix, visiblePrefix, req_rank(id) == 0u);
  if ticket >= counter(3u) {
    atomicAdd(&scratch[CONTROL + 5u], 1u);
    return;
  }
  let slot = atomicLoad(&world[FREE + ticket]);
  let at = patch_address(slot);
  let generation = atomicLoad(&world[at + 23u]);
  if generation >= 0xfffffffeu {
    atomicAdd(&scratch[CONTROL + 9u], 1u);
    return;
  }
  for (var lane = 0u; lane < 76u; lane++) {
    atomicStore(&world[at + lane], 0u);
  }
  for (var lane = 0u; lane < 12u; lane++) {
    atomicStore(&scratch[A1 + slot * 12u + lane], 0u);
  }
  for (var lane = 0u; lane < 7u; lane++) {
    atomicStore(&world[at + lane], req_word(id, lane));
  }
  for (var lane = 0u; lane < 12u; lane++) {
    atomicStore(&world[at + 8u + lane], req_word(id, 8u + lane));
  }
  for (var lane = 0u; lane < 4u; lane++) {
    atomicStore(&world[at + 72u + lane], req_word(id, 24u + lane));
  }
  atomicStore(&scratch[${s("seedSources")} + slot], req_word(id, 22u) + 1u);
  let address = cell_for(req_pos(id), req_normal(id));
  atomicStore(&world[at + 20u], address.x);
  atomicStore(&world[at + 21u], address.y);
  atomicStore(&world[at + 22u], address.z);
  atomicStore(&world[at + 23u], generation + 1u);
  atomicStore(&world[at + 28u], setting(0u));
  atomicStore(&world[at + 30u], setting(0u));
  atomicStore(&world[cache_state(slot)], setting(0u));
  atomicStore(&world[at + 68u], req_rank(id));
  atomicStore(&world[cache_state(slot) + 1u], 1u);
  atomicStore(&world[cache_state(slot) + 3u], 1u);
  atomicStore(&world[MAP + address.x * 2u], slot);
  atomicStore(&world[MAP + address.x * 2u + 1u], generation + 1u);
  atomicAdd(&scratch[CONTROL + 11u], 1u);
}
@compute @workgroup_size(${W})
fn classify_live(@builtin(global_invocation_id) tid: vec3u) {
  if tid.x >= K {
    return;
  }
  atomicStore(&scratch[${s("cacheLiveFlags0")} + tid.x], select(0u, 1u, atomicLoad(&world[cache_state(tid.x) + 3u]) != 0u));
}
@compute @workgroup_size(${W})
fn scatter_live(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= K {
    return;
  }
  if atomicLoad(&scratch[${s("cacheLiveFlags0")} + id]) != 0u {
    let ringIndex = (atomicLoad(&world[16u]) + atomicLoad(&scratch[${s("cacheLivePrefix0")} + id])) % K;
    atomicStore(&scratch[ACTIVE + ringIndex], id);
  }
}
// Defrag targets only currently free slots. No source is a destinationSlot, so partial
// budgets need no chain completion. Snapshot includes A0/A2/statistics and A1.
@compute @workgroup_size(${W})
fn plan_moves(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= counter(2u) {
    return;
  }
  let source = atomicLoad(&scratch[ACTIVE + (atomicLoad(&world[16u]) + id) % K]);
  if source >= counter(2u) {
    let ticket = atomicAdd(&scratch[CONTROL + 8u], 1u);
    if ticket < setting(7u) {
      atomicStore(&scratch[MOVES + ticket * 96u], source);
    }
  }
}
@compute @workgroup_size(${W})
fn snapshot_moves(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= min(counter(8u), setting(7u)) {
    return;
  }
  let source = atomicLoad(&scratch[MOVES + id * 96u]);
  let destinationSlot = atomicLoad(&world[FREE + id]);
  // The rebuilt free list contains all holes in ascending order. Slots below
  // live count are exactly as numerous as live sources above that boundary.
  let record = MOVES + id * 96u;
  atomicStore(&scratch[record + 1u], destinationSlot);
  atomicStore(&scratch[record + 3u], atomicLoad(&scratch[${s("seedSources")} + source]));
  atomicStore(&scratch[record + 2u], atomicLoad(&world[patch_address(destinationSlot) + 23u]));
  for (var lane = 0u; lane < 4u; lane++) {
    atomicStore(&scratch[record + 92u + lane], atomicLoad(&world[cache_state(source) + lane]));
  }
  for (var lane = 0u; lane < 76u; lane++) {
    atomicStore(&scratch[record + 4u + lane], atomicLoad(&world[patch_address(source) + lane]));
  }
  for (var lane = 0u; lane < 12u; lane++) {
    atomicStore(&scratch[record + 80u + lane], atomicLoad(&scratch[A1 + source * 12u + lane]));
  }
}
@compute @workgroup_size(${W})
fn apply_moves(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= min(counter(8u), setting(7u)) {
    return;
  }
  let record = MOVES + id * 96u;
  let source = atomicLoad(&scratch[record]);
  let destinationSlot = atomicLoad(&scratch[record + 1u]);
  let generation = atomicLoad(&scratch[record + 2u]);
  if generation >= 0xfffffffeu {
    atomicAdd(&scratch[CONTROL + 9u], 1u);
    return;
  }
  let at = patch_address(destinationSlot);
  for (var lane = 0u; lane < 76u; lane++) {
    atomicStore(&world[at + lane], atomicLoad(&scratch[record + 4u + lane]));
  }
  for (var lane = 0u; lane < 12u; lane++) {
    atomicStore(&scratch[A1 + destinationSlot * 12u + lane], atomicLoad(&scratch[record + 80u + lane]));
  }
  for (var lane = 0u; lane < 4u; lane++) {
    atomicStore(&world[cache_state(destinationSlot) + lane], atomicLoad(&scratch[record + 92u + lane]));
  }
  atomicStore(&world[at + 23u], generation + 1u);
  atomicStore(&scratch[${s("seedSources")} + destinationSlot], atomicLoad(&scratch[record + 3u]));
  atomicStore(&scratch[${s("seedSources")} + source], 0u);
  let cell = atomicLoad(&world[at + 20u]);
  atomicStore(&world[MAP + cell * 2u], destinationSlot);
  atomicStore(&world[MAP + cell * 2u + 1u], generation + 1u);
  atomicStore(&world[cache_state(source) + 3u], 0u);
}
@compute @workgroup_size(${W})
fn finalize_requests(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= counter(1u) {
    return;
  }
  let cell = atomicLoad(&scratch[REQUEST_CELL + id]);
  if cell == EMPTY {
    return;
  }
  let slot = atomicLoad(&world[MAP + cell * 2u]);
  var valid = slot < K;
  if valid {
    let at = patch_address(slot);
    valid = atomicLoad(&world[cache_state(slot) + 3u]) != 0u &&
    atomicLoad(&world[MAP + cell * 2u + 1u]) == atomicLoad(&world[at + 23u]) &&
    compatible(id, at, atomicLoad(&world[at + 21u]));
  }
  if !valid {
    atomicStore(&scratch[REQUEST_CELL + id], EMPTY);
  }
}
@compute @workgroup_size(${W})
fn classify_priority(@builtin(global_invocation_id) tid: vec3u) {
  let index = tid.x;
  if index >= K {
    return;
  }
  let slot = index;
  let at = patch_address(slot);
  var category = EMPTY;
  if atomicLoad(&world[cache_state(slot) + 3u]) != 0u {
    let rank = atomicLoad(&world[at + 68u]);
    let birth = atomicLoad(&world[at + 30u]);
    let update = atomicLoad(&world[at + 29u]);
    let dirty = atomicLoad(&world[cache_state(slot) + 1u]);
    let variance = max(wf(at + 36u), max(wf(at + 37u), wf(at + 38u)));
    if rank == 1u {
      category = 3u;
    }
    else if birth == setting(0u) {
      category = 0u;
    }
    else if dirty != 0u || setting(0u) - min(setting(0u), update) >= setting(12u) || variance > sf(13u) {
      category = 1u;
    }
    else {
      category = 2u;
    }
  }
  atomicStore(&scratch[${s("cachePriority0Flags0")} + index], select(0u, 1u, category == 0u));
  atomicStore(&scratch[${s("cachePriority1Flags0")} + index], select(0u, 1u, category == 1u));
  atomicStore(&scratch[${s("cachePriority2Flags0")} + index], select(0u, 1u, category == 2u));
  atomicStore(&scratch[${s("cachePriority3Flags0")} + index], select(0u, 1u, category == 3u));
}
@compute @workgroup_size(${W})
fn scatter_priority(@builtin(global_invocation_id) tid: vec3u) {
  let index = tid.x;
  if index >= K {
    return;
  }
  let slot = index;
  ${priorityScatter}
}
@compute @workgroup_size(1)
fn quotas() {
  var remaining = select(${p.updates}u, 0u, counter(9u) != 0u);
  var allocated = array<u32, 4>(0u, 0u, 0u, 0u);
  // Rotating first category makes even U=1 fair. Empty classes donate budget.
  for (var round = 0u; round < 2u; round++) {
    for (var i = 0u; i < 4u; i++) {
      let category = (setting(0u) + i) % 4u;
      let available = counter(16u + category) - allocated[category];
      var grant = min(remaining, available);
      if round == 0u {
        grant = min(grant, max(1u, ${p.updates}u / 4u));
      }
      allocated[category] += grant;
      remaining -= grant;
    }
  }
  var offset = 0u;
  for (var i = 0u; i < 4u; i++) {
    put(20u + i, allocated[i]);
    put(24u + i, offset);
    offset += allocated[i];
  }
  put(28u, offset);
  atomicStore(&indirect[ARGS + 8u], (offset + ${W - 1}u) / ${W}u);
  atomicStore(&indirect[ARGS + 9u], 1u);
  atomicStore(&indirect[ARGS + 10u], 1u);
}
@compute @workgroup_size(${W})
fn select_updates(@builtin(global_invocation_id) tid: vec3u) {
  let id = tid.x;
  if id >= counter(28u) {
    return;
  }
  for (var category = 0u; category < 4u; category++) {
    let start = counter(24u + category);
    let count = counter(20u + category);
    if id >= start && id - start < count {
      let total = counter(16u + category);
      let cursor = atomicLoad(&world[60u + category]) % max(1u, total);
      let slot = atomicLoad(&scratch[PRIORITIES + category * K + (cursor + id - start) % total]);
      atomicStore(&scratch[UPDATES + id], slot);
      // Selection is not a completed radiance update. Estimator alone owns age/count.
      atomicStore(&world[cache_state(slot) + 2u], setting(0u));
    }
  }
}
@compute @workgroup_size(1)
fn finish() {
  for (var c = 0u; c < C; c++) {
    for (var axis = 0u; axis < 3u; axis++) {
      atomicStore(&world[40u + c * 4u + axis], setting(16u + c * 4u + axis));
    }
    atomicStore(&world[43u + c * 4u], setting(1u));
    let o = vec3f(origin(c)) * scale(c);
    atomicStore(&world[24u + c * 4u], bitcast<u32>(o.x));
    atomicStore(&world[25u + c * 4u], bitcast<u32>(o.y));
    atomicStore(&world[26u + c * 4u], bitcast<u32>(o.z));
    atomicStore(&world[27u + c * 4u], bitcast<u32>(scale(c)));
  }
  let start = atomicLoad(&world[16u]) % K;
  atomicStore(&world[16u], start);
  atomicStore(&world[17u], (start + counter(2u)) % K);
  atomicStore(&world[18u], counter(2u));
  atomicStore(&world[19u], setting(0u));
  // GPU consumers reject the cache on a numeric/lifetime fault. Faults never
  // become an empty valid cache or a successful lighting cohort.
  atomicStore(&world[15u], counter(9u));
  for (var c = 0u; c < 4u; c++) {
    let total = max(1u, counter(16u + c));
    atomicStore(&world[60u + c], (atomicLoad(&world[60u + c]) % total + counter(20u + c)) % total);
  }
}
`;
}

export function scgiCacheScanWgsl(
  input: number,
  output: number,
  count: number,
  sums: number | null,
  parent: number | null,
  totalControl: number | null,
): string {
  const writeSum =
    sums === null
      ? ""
      : `
  if lane == ${W - 1}u {
    scratch[${sums}u + group.x] = values[lane];
  }`;
  const writeTotal =
    totalControl === null
      ? ""
      : `
  if tid.x == ${count - 1}u {
    scratch[${totalControl}u] = values[lane];
  }`;
  const addParent =
    parent === null
      ? ""
      : `
  if tid.x < ${count}u {
    scratch[${output}u + tid.x] += scratch[${parent}u + tid.x / ${W}u];
  }`;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> scratch: array<u32>;
var<workgroup> values: array<u32, ${W}>;
@compute @workgroup_size(${W})
fn scan(
  @builtin(global_invocation_id) tid: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3u,
) {
  var value = 0u;
  if tid.x < ${count}u {
    value = scratch[${input}u + tid.x];
  }
  values[lane] = value;
  workgroupBarrier();
  for (var distance = 1u; distance < ${W}u; distance *= 2u) {
    var left = 0u;
    if lane >= distance {
      left = values[lane - distance];
    }
    workgroupBarrier();
    values[lane] += left;
    workgroupBarrier();
  }
  if tid.x < ${count}u {
    scratch[${output}u + tid.x] = values[lane] - value;
  }
  ${writeSum}
  ${writeTotal}
}
@compute @workgroup_size(${W})
fn add(@builtin(global_invocation_id) tid: vec3u) {
  ${addParent}
}
`;
}

/** Request producers bind these arenas with the same atomic-word declarations.
 * Overflow is observable and never revokes existing cells. Demand producers
 * retry deferred demand from next frame's receivers/paths; no fake radiance is
 * published. Requests contain semantic identities and cells, never physical
 * patch addresses, so bounded defrag requires no stale queue pointer fixup. */
export function scgiCacheRequestWgsl(plan: ScgiAllocationPlan, receiverOnly = false): string {
  const requests = plan.scratch.ranges.requests!.offset / 4;
  const control = plan.scratch.ranges.cacheControl!.offset / 4;
  const bounce = plan.world.ranges.bounceRequests!.offset / 4;
  return /* wgsl */ `
fn scgi_append_receiver_request(record: array<u32, 28>) -> bool {
  var ticket = atomicLoad(&scratch[${control}u]);
  loop {
    if ticket >= ${plan.profile.requests}u {
      atomicAdd(&scratch[${control + 7}u], 1u);
      return false;
    }
    let reservation = atomicCompareExchangeWeak(&scratch[${control}u], ticket, ticket + 1u);
    if reservation.exchanged {
      break;
    }
    ticket = reservation.old_value;
  }
  for (var lane = 0u; lane < 28u; lane++) {
    atomicStore(&scratch[${requests}u + ticket * 28u + lane], record[lane]);
  }
  return true;
}
${
  receiverOnly
    ? ""
    : /* wgsl */ `
fn scgi_append_bounce_request(record: array<u32, 28>, sourcePatch: u32) -> bool {
  if sourcePatch >= ${plan.profile.patches}u {
    return false;
  }
  let source = ${plan.world.ranges.patches!.offset / 4}u + sourcePatch * 76u;
  let cache = ${plan.world.ranges.cacheState!.offset / 4}u + sourcePatch * 4u;
  // Only scheduled rank0 work discovers secondary demand. Rank1 never fans out.
  if atomicLoad(&world[cache + 3u]) == 0u || atomicLoad(&world[source + 68u]) != 0u ||
  atomicLoad(&world[cache + 2u]) != atomicLoad(&world[19u]) {
    return false;
  }
  var ticket = atomicLoad(&world[20u]);
  loop {
    if ticket >= ${plan.profile.bounceRequests}u {
      atomicAdd(&world[21u], 1u);
      return false;
    }
    let reservation = atomicCompareExchangeWeak(&world[20u], ticket, ticket + 1u);
    if reservation.exchanged {
      break;
    }
    ticket = reservation.old_value;
  }
  for (var lane = 0u; lane < 28u; lane++) {
    atomicStore(&world[${bounce}u + ticket * 28u + lane], record[lane]);
  }
  return true;
}
fn scgi_resolve_request_patch(requestIndex: u32) -> vec2u {
  if atomicLoad(&world[15u]) != 0u || requestIndex >= atomicLoad(&scratch[${control + 1}u]) {
    return vec2u(0xffffffffu);
  }
  let cell = atomicLoad(&scratch[${plan.scratch.ranges.cacheRequestCells!.offset / 4}u + requestIndex]);
  if cell >= ${plan.cells}u {
    return vec2u(0xffffffffu);
  }
  let at = ${plan.world.ranges.map!.offset / 4}u + cell * 2u;
  return vec2u(atomicLoad(&world[at]), atomicLoad(&world[at + 1u]));
}
`
}
`;
}
