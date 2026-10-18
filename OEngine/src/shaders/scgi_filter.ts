import { SCGI_ABI_WGSL, SCGI_IRRADIANCE_WGSL } from "../render/gi/ScgiAbi.js";
import type { ScgiAllocationPlan } from "../render/gi/ScgiCapacity.js";

/** Independent local filtering implementation. Unity UCL sources are behavioral
 * references only. Pass boundaries make A0 and A1 immutable to their consumers.
 * 64 threads, scalar packed f32; only scale/error reduction uses u32 atomics. */
export function scgiFilterWgsl(plan: ScgiAllocationPlan): string {
  const w = (name: string) => plan.world.ranges[name]!.offset / 4;
  const s = (name: string) => plan.scratch.ranges[name]!.offset / 4;
  return /* wgsl */ `
${SCGI_ABI_WGSL}
${SCGI_IRRADIANCE_WGSL}
struct Settings {
  frame: u32,
  spatial: u32,
  post: u32,
  filter_epoch: u32,
  taps: u32,
  lookup_taps: u32,
  maximum_count: u32,
  maximum_age: u32,
  short_hysteresis: f32,
  long_hysteresis: f32,
  post_hysteresis: f32,
  drift_scale: f32,
  radius: f32,
  lookup_radius: f32,
  normal_cosine: f32,
  plane_scale: f32,
  invalid_decay: f32,
  revision_decay: f32,
  guard: f32,
  previous_valid: u32,
  geometry_epoch: u32,
  reset_post: u32,
  segment_first: u32,
  segment_count: u32,
}
@group(0) @binding(0) var<storage, read_write> world: array<u32>;
@group(0) @binding(1) var<storage, read_write> scratch: array<u32>;
@group(0) @binding(2) var<uniform> settings: Settings;
@group(0) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> anchors: array<ScgiAnchor>;
@group(0) @binding(5) var<storage, read_write> field: array<ScgiHalfField>;
const K: u32 = ${plan.profile.patches}u;
const PATCH: u32 = ${w("patches")}u;
const CACHE: u32 = ${w("cacheState")}u;
const MAP: u32 = ${w("map")}u;
const A1: u32 = ${s("a1")}u;
const VALID: u32 = ${s("filterValidity")}u;
const RAW: u32 = ${s("raw")}u;
const UPDATE: u32 = ${s("updateList")}u;
const COUNT: u32 = ${s("cacheControl") + 28}u;
fn wf(at: u32) -> f32 {
  return bitcast<f32>(world[at]);
}
fn vec(at: u32) -> vec3f {
  return vec3f(wf(at), wf(at + 1u), wf(at + 2u));
}
fn put(at: u32, value: f32) {
  world[at] = bitcast<u32>(value);
}
fn finite(value: f32) -> bool {
  return (bitcast<u32>(value) & 0x7f800000u) != 0x7f800000u;
}
fn live(slot: u32) -> bool {
  return slot < K && world[CACHE + slot * 4u + 3u] != 0u;
}
fn current(at: u32) -> bool {
  return world[at + 64u] == world[4u] && world[at + 65u] == world[5u] && world[at + 66u] == world[6u] && world[at + 67u] == world[7u];
}
fn valid(at: u32) -> bool {
  return world[at + 24u] > 0u || wf(at + 39u) > 0.0;
}
fn coefficients(at: u32, offset: u32) -> array<f32, 12> {
  var value: array<f32, 12>;
  for (var i = 0u; i<12u; i++) {
    value[i] = wf(at+offset+i);
  }
  return value;
}
fn legal(value: array<f32, 12>) -> bool {
  for (var c = 0u; c<3u; c++) {
    if (!finite(value[c]) || value[c]<0.0) {
      return false;
    }
    for (var term = 1u; term<4u; term++) {
      let v = value[term*3u+c];
      // Division avoids overflow at HDR; a nonzero directional term with zero
      // L0 cannot be produced by a nonnegative radiance measure.
      if (!finite(v) || (value[c] == 0.0 && v != 0.0)) {
        return false;
      }
      if (value[c]>0.0 && abs(v/value[c])>1.1547015) {
        return false;
      }
    }
  }
  return true;
}
fn interpolate(a: f32, b: f32, weight: f32) -> f32 {
  // Weighted terms avoid the b-a overflow of mix near the f32 limit.
  return a*(1.0-weight)+b*weight;
}
fn adaptive(short: f32, relative_variance: f32, long: f32, steady: f32) -> f32 {
  // Relative floor has the same units as L0; black/zero variance is defined.
  let magnitude = max(max(abs(short), abs(long)), 1.17549435e-38);
  let drift = abs(short/magnitude-long/magnitude);
  let deviation = sqrt(max(relative_variance, 0.0))*(abs(short)/magnitude);
  let t = clamp(drift/max(deviation, 0.0001)*settings.drift_scale, 0.0, 1.0);
  let response = t*t*(3.0-2.0*t);
  return interpolate(steady, settings.short_hysteresis, response);
}
fn hash(value: u32) -> u32 {
  var x = value;
  x = (x^(x>>16u))*0x7feb352du;
  x = (x^(x>>15u))*0x846ca68bu;
  return x^(x>>16u);
}
fn random(seed: u32) -> f32 {
  return f32(hash(seed)>>8u)/16777216.0;
}
fn tangent(n: vec3f) -> mat2x3f {
  let a = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(n.z)>0.9);
  let t = normalize(cross(a, n));
  return mat2x3f(t, cross(n, t));
}
fn stencil(tap: u32, count: u32) -> vec2f {
  // Cover every quadrant even at low tap counts. A fixed low-discrepancy disk
  // avoids permanently missing a neighbor with one unlucky random stencil.
  let radius = sqrt((f32(tap)+0.5)/f32(max(count, 1u)));
  let angle = f32(tap)*2.399963229728653;
  return vec2f(cos(angle), sin(angle))*radius;
}
fn bin_coordinate(normal: vec3f) -> vec2f {
  let n = normal/(abs(normal.x)+abs(normal.y)+abs(normal.z));
  var uv = n.xy;
  if (n.z<0.0) {
    uv = (vec2f(1.0)-abs(uv.yx))*select(vec2f(-1.0), vec2f(1.0), uv >= vec2f(0.0));
  }
  return clamp((uv*0.5+0.5)*4.0, vec2f(0.0), vec2f(3.99999));
}
fn related(at: u32, other: u32) -> bool {
  // Spatial taps can cross triangle/material boundaries of a continuous
  // instance, but never silently borrow a parallel surface from another one.
  for (var i = 0u; i<8u; i++) {
    if (world[at+8u+i] != world[other+8u+i]) {
      return false;
    }
  }
  return true;
}
fn compatible(at: u32, p: vec3f, n: vec3f, distance: f32) -> bool {
  let delta = vec(at)-p;
  let normal = vec(at+4u);
  let plane = max(wf(at+7u), distance*settings.plane_scale);
  // A chord on a smooth curved surface lies in the mean tangent plane.
  // Testing each endpoint plane independently punches holes on curved meshes.
  return dot(n, normal) >= settings.normal_cosine && abs(dot(delta, (n+normal)*0.5)) <= plane && length(delta) <= distance;
}
fn find_from(position: vec3f, guide: vec3f, normal: vec3f, reference: u32, rank0: bool, first: u32, anchor_index: u32) -> u32 {
  for (var c = first; c<${plan.profile.cascades}u; c++) {
    let scale = wf(27u+c*4u);
    if (!(scale>0.0)) {
      continue;
    }
    let origin = bitcast<vec3i>(vec3u(world[40u+c*4u], world[41u+c*4u], world[42u+c*4u]));
    let center_coord = floor(position/scale);
    // Reconstructed points on a grid plane can round into either cell. Probe
    // both sides only at that boundary; keep the original plane/identity tests.
    // This is addressing tolerance, not a wider surface acceptance threshold.
    for (var side = 0u; side < 3u; side++) {
      var coord = center_coord;
      if (side != 0u) {
        let sign = select(-1.0, 1.0, side == 1u);
        coord = floor(position/scale + normal * (sign * 0.0001));
        if (all(coord == center_coord)) {
          continue;
        }
      }
      let rel = coord-vec3f(origin);
      if (any(rel<vec3f(0.0)) || any(rel >= vec3f(${plan.profile.resolution}.0))) {
        continue;
      }
      let r = ${plan.profile.resolution};
      let xyz = ((vec3i(coord)%vec3i(r))+vec3i(r))%vec3i(r);
      let primary_bin = vec2i(bin_coordinate(normal));
      // A curved receiver may have no patch in its exact orientation bin.
      // Search adjacent bins, accepting only the actual normal/plane tests.
      for (var orientation_tap = 0u; orientation_tap < 9u; orientation_tap++) {
        let step = (orientation_tap+4u)%9u;
        var selected_bin = primary_bin+vec2i(i32(step%3u)-1, i32(step/3u)-1);
        // The octahedral square folds at its edges. Adjacent south-facing
        // normals can occupy opposite corners; clamping loses that support.
        if (selected_bin.x < 0 || selected_bin.x > 3) {
          selected_bin.x = select(-1-selected_bin.x, 7-selected_bin.x, selected_bin.x > 3);
          selected_bin.y = 3-selected_bin.y;
        }
        if (selected_bin.y < 0 || selected_bin.y > 3) {
          selected_bin.y = select(-1-selected_bin.y, 7-selected_bin.y, selected_bin.y > 3);
          selected_bin.x = 3-selected_bin.x;
        }
        let cell = (c*${plan.profile.resolution ** 3}u+u32((xyz.x*r+xyz.y)*r+xyz.z))*16u+u32(selected_bin.y*4+selected_bin.x);
        let slot = world[MAP+cell*2u];
        if (!live(slot)) {
          continue;
        }
        let at = PATCH+slot*76u;
        if (world[at+23u] != world[MAP+cell*2u+1u] || !valid(at) || wf(at+35u) <= 0.0 || (rank0 && world[at+68u] != 0u) || !compatible(at, guide, normal, scale*max(1.0, settings.radius))) {
          continue;
        }
        if (reference != 0xffffffffu && !related(reference, at)) {
          continue;
        }
        if (anchor_index != 0xffffffffu) {
          var matching = true;
          for (var i = 0u; i < 8u; i++) {
            matching = matching && world[at+8u+i] == anchors[anchor_index].identity[i];
          }
          if (!matching) {
            continue;
          }
        }
        return slot;
      }
    }
  }
  return 0xffffffffu;
}
fn find(position: vec3f, guide: vec3f, normal: vec3f, reference: u32, rank0: bool) -> u32 {
  return find_from(position, guide, normal, reference, rank0, 0u, 0xffffffffu);
}
// Fade a fine cascade into a compatible coarse one over its outer two cells.
// Missing coarse support keeps fine weight1; no missing-data darkening.
fn coarse_weight(position: vec3f, slot: u32) -> f32 {
  let cascade = world[PATCH+slot*76u+21u];
  if (cascade+1u >= ${plan.profile.cascades}u) {
    return 0.0;
  }
  let origin = bitcast<vec3i>(vec3u(world[40u+cascade*4u], world[41u+cascade*4u], world[42u+cascade*4u]));
  let local = position/wf(27u+cascade*4u)-vec3f(origin);
  let edge = min(local, vec3f(${plan.profile.resolution}.0)-local);
  let distance = min(edge.x, min(edge.y, edge.z));
  return 1.0-smoothstep(0.0, min(2.0, ${plan.profile.resolution / 2}.0), distance);
}
@compute @workgroup_size(64) fn qualify(@builtin(global_invocation_id) id: vec3u) {
  if (!live(id.x)) {
    return;
  }
  let at = PATCH+id.x*76u;
  scratch[VALID+id.x] = 0u;
  if (!valid(at)) {
    return;
  }
  if (!legal(coefficients(at, 40u))) {
    atomicOr(&control[1u], 1u);
    put(at+35u, 0.0);
    return;
  }
  if (!current(at)) {
    put(at+35u, wf(at+35u)*settings.revision_decay);
    world[CACHE+id.x*4u+1u] = 1u;
  }
  if (world[CACHE+id.x*4u+1u] != 0u) {
    put(at+35u, wf(at+35u)*settings.invalid_decay);
  }
  let age = settings.frame-min(settings.frame, world[at+29u]);
  if (age>settings.maximum_age) {
    put(at+35u, wf(at+35u)*settings.invalid_decay);
  }
  // A query topology revision lowers all confidence, including receivers
  // outside local old/new bounds, without clearing accumulated radiance.
  if (world[22u] != settings.geometry_epoch || scratch[${s("cacheSettings") + 14}u] != 0u) {
    put(at+35u, wf(at+35u)*settings.revision_decay);
    world[CACHE+id.x*4u+1u] = 1u;
  }
}
@compute @workgroup_size(64) fn integrate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= min(scratch[COUNT], ${plan.profile.updates}u)) {
    return;
  }
  let slot = scratch[UPDATE+id.x];
  if (!live(slot)) {
    atomicOr(&control[1u], 2u);
    return;
  }
  let at = PATCH+slot*76u;
  let raw = RAW+id.x*16u;
  if (scratch[raw+14u] != 1u || scratch[raw+15u] != 0u || world[15u] != 0u) {
    put(at+35u, wf(at+35u)*settings.invalid_decay);
    return;
  }
  var sample: array<f32, 12>;
  for (var i = 0u; i<12u; i++) {
    sample[i] = bitcast<f32>(scratch[raw+i]);
  }
  if (!legal(sample)) {
    atomicOr(&control[1u], 4u);
    put(at+35u, 0.0);
    return;
  }
  let previous_count = world[at+24u];
  // Preserve count across global revisions; fast weighting reacts without
  // turning a moving sun into a perpetual first sample. New/seed is count0.
  let count = min(previous_count, settings.maximum_count-1u)+1u;
  let reset = previous_count == 0u;
  let stale = !current(at) || world[CACHE+slot*4u+1u] != 0u;
  if (stale || reset) {
    scratch[VALID+slot] = 2u;
  }
  for (var c = 0u; c<3u; c++) {
    let old_mean = wf(at+32u+c);
    let old_var = wf(at+36u+c);
    let h = select(settings.short_hysteresis, 0.0, reset);
    let mean = interpolate(sample[c], old_mean, h);
    // Scale before squaring. Variance itself must fit f32; very high HDR is
    // represented by relative variance times a per-channel mean scale below.
    let magnitude = max(max(abs(sample[c]), abs(old_mean)), 1.17549435e-38);
    let delta = sample[c]/magnitude-old_mean/magnitude;
    let previous_scale = max(abs(old_mean), 1.17549435e-38);
    let scaled_var = old_var*(previous_scale/magnitude)*(previous_scale/magnitude);
    let variance = h*(scaled_var+(1.0-h)*delta*delta);
    let mean_scale = max(abs(mean), magnitude*1e-10);
    let relative_var = variance*(magnitude/mean_scale)*(magnitude/mean_scale);
    var weight = min(settings.long_hysteresis, 1.0-1.0/f32(count));
    weight = min(weight, adaptive(mean, relative_var, wf(at+40u+c), settings.long_hysteresis));
    if (stale) {
      weight = min(weight, settings.short_hysteresis);
    }
    if (reset) {
      weight = 0.0;
    }
    for (var term = 0u; term<4u; term++) {
      let i = term*3u+c;
      put(at+40u+i, interpolate(sample[i], wf(at+40u+i), weight));
    }
    put(at+32u+c, mean);
    put(at+36u+c, relative_var);
  }
  let missing = f32(world[at+71u]);
  let planned = max(1.0, f32(scratch[raw+12u]));
  let support = 1.0-clamp(missing/planned, 0.0, 1.0);
  put(at+35u, support*(1.0-1.0/f32(count+1u)));
  put(at+39u, 0.0);
  world[at+24u] = count;
  world[at+29u] = settings.frame;
  world[CACHE+slot*4u+1u] = 0u;
  for (var i = 0u; i<4u; i++) {
    world[at+64u+i] = world[4u+i];
  }
}
@compute @workgroup_size(64) fn spatial(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if (slot >= K) {
    return;
  }
  for (var i = 0u; i<12u; i++) {
    scratch[A1+slot*12u+i] = 0u;
  }
  if (!live(slot)) {
    return;
  }
  let at = PATCH+slot*76u;
  if (!valid(at) || wf(at+35u) <= 0.0) {
    return;
  }
  var result = coefficients(at, 40u);
  var weight = 1.0;
  let normal = vec(at+4u);
  let basis = tangent(normal);
  let cascade = min(world[at+21u], ${plan.profile.cascades - 1}u);
  let scale = wf(27u+cascade*4u);
  if (settings.spatial != 0u) {
    let center_blend = coarse_weight(vec(at), slot);
    if (center_blend>0.0) {
      let coarse = find_from(vec(at), vec(at), normal, at, false, cascade+1u, 0xffffffffu);
      if (coarse != 0xffffffffu) {
        for (var i = 0u; i<12u; i++) {
          result[i] = interpolate(result[i], wf(PATCH+coarse*76u+40u+i), center_blend);
        }
      }
    }
    for (var tap = 0u; tap<settings.taps; tap++) {
      let jitter = stencil(tap, settings.taps);
      let position = vec(at)+(basis[0]*jitter.x+basis[1]*jitter.y)*scale*settings.radius;
      let other = find(position, vec(at), normal, at, false);
      if (other == 0xffffffffu || other == slot) {
        continue;
      }
      let blend = coarse_weight(position, other);
      var coarse = 0xffffffffu;
      if (blend>0.0) {
        coarse = find_from(position, vec(at), normal, at, false, world[PATCH+other*76u+21u]+1u, 0xffffffffu);
      }
      for (var level = 0u; level<2u; level++) {
        let selected = select(other, coarse, level == 1u);
        if (selected == 0xffffffffu) {
          continue;
        }
        var cascade_weight = 1.0;
        if (coarse != 0xffffffffu) {
          cascade_weight = select(1.0-blend, blend, level == 1u);
        }
        let b = PATCH+selected*76u;
        let tap_weight = max(0.0, 1.0-length(jitter)*0.70710678)*wf(b+35u)*cascade_weight;
        let total = weight+tap_weight;
        for (var i = 0u; i<12u; i++) {
          result[i] = interpolate(result[i], wf(b+40u+i), tap_weight/total);
        }
        weight = total;
      }
    }
  }
  if (!legal(result)) {
    atomicOr(&control[1u], 8u);
    return;
  }
  for (var i = 0u; i<12u; i++) {
    scratch[A1+slot*12u+i] = bitcast<u32>(result[i]);
  }
  scratch[VALID+slot] = scratch[VALID+slot]|1u;
}
@compute @workgroup_size(64) fn post(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if (!live(slot)) {
    return;
  }
  let at = PATCH+slot*76u;
  if ((scratch[VALID+slot]&1u) == 0u) {
    world[at+69u] = 0u;
    return;
  }
  var result: array<f32, 12>;
  for (var i = 0u; i<12u; i++) {
    result[i] = bitcast<f32>(scratch[A1+slot*12u+i]);
  }
  let reset = settings.reset_post != 0u || world[59u] != settings.filter_epoch || world[at+69u] != 2u || !current(at) || world[CACHE+slot*4u+1u] != 0u || world[at+24u] <= 1u || (scratch[VALID+slot]&2u) != 0u;
  if (settings.post != 0u && !reset) {
    for (var c = 0u; c<3u; c++) {
      let weight = adaptive(wf(at+32u+c), wf(at+36u+c), wf(at+52u+c), settings.post_hysteresis);
      for (var term = 0u; term<4u; term++) {
        let i = term*3u+c;
        result[i] = interpolate(result[i], wf(at+52u+i), weight);
      }
    }
  }
  if (!legal(result)) {
    atomicOr(&control[1u], 16u);
    world[at+69u] = 0u;
    return;
  }
  for (var i = 0u; i<12u; i++) {
    put(at+52u+i, result[i]);
  }
  world[at+69u] = select(0u, 2u, settings.post != 0u);
  if (wf(at+35u)>0.0) {
    for (var c = 0u; c<3u; c++) {
      atomicMax(&control[0u], bitcast<u32>(result[c]));
    }
  }
}
@compute @workgroup_size(1) fn publish() {
  let maximum = bitcast<f32>(atomicLoad(&control[0u]));
  var exponent = 0;
  if (maximum>0.0) {
    exponent = i32(clamp(ceil(log2(maximum)-14.0), -126.0, 113.0));
  }
  let scale = exp2(f32(exponent));
  world[58u] = bitcast<u32>(scale);
  world[59u] = settings.filter_epoch;
  world[22u] = settings.geometry_epoch;
  if (atomicLoad(&control[1u]) != 0u) {
    world[15u] = world[15u]|0x100u;
  }
}
@compute @workgroup_size(64) fn lookup(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= settings.segment_count) {
    return;
  }
  var output: ScgiHalfField;
  // Struct zero initialization defines every background/odd/invalid lane.
  field[index] = output;
  if (world[15u] != 0u) {
    return;
  }
  let anchor = anchors[index];
  if (anchor.positionValid[3] != 1.0 || !(anchor.motionDepth[3]>0.0)) {
    return;
  }
  let position = vec3f(anchor.positionValid[0], anchor.positionValid[1], anchor.positionValid[2]);
  let normal = vec3f(anchor.normal[0], anchor.normal[1], anchor.normal[2]);
  let center = find_from(position, position, normal, 0xffffffffu, true, 0u, index);
  var at = 0xffffffffu;
  var cascade = ${plan.profile.cascades - 1}u;
  if (center != 0xffffffffu) {
    at = PATCH+center*76u;
    cascade = world[at+21u];
  } else {
    for (var c = 0u; c < ${plan.profile.cascades}u; c++) {
      let origin = bitcast<vec3i>(vec3u(world[40u+c*4u], world[41u+c*4u], world[42u+c*4u]));
      let local = position/wf(27u+c*4u)-vec3f(origin);
      if (all(local >= vec3f(0.0)) && all(local < vec3f(${plan.profile.resolution}.0))) {
        cascade = c;
        break;
      }
    }
  }
  // Same instance/Product, not same primitive: spatial interpolation must not
  // punch holes at ordinary triangle boundaries.
  let scale = wf(27u+cascade*4u);
  let basis = tangent(normal);
  var result: array<f32, 12>;
  var total = 0.0;
  var confidence = 0.0;
  for (var tap = 0u; tap <= settings.lookup_taps; tap++) {
    var slot = center;
    var tap_weight = 0.1;
    var sample_position = position;
    var sample_normal = normal;
    if (tap != 0u) {
      // Reconstruction must not resample its support every frame. Transport
      // samples still advance; this fixed screen stencil removes lookup noise.
      let jitter = stencil(tap-1u, settings.lookup_taps);
      let offset = (basis[0]*jitter.x+basis[1]*jitter.y)*scale*settings.lookup_radius;
      // Keep a common stencil across receivers so interpolation varies with
      // world support rather than independent per-pixel random tap choices.
      sample_position = position+offset;
      sample_normal = normal;
      slot = find_from(sample_position, position, sample_normal, at, true, 0u, index);
      tap_weight = max(0.0, 1.0-length(jitter)*0.70710678);
    }
    if (slot == 0xffffffffu || (scratch[VALID+slot]&1u) == 0u) {
      continue;
    }
    var matching = true;
    for (var i = 0u; i < 8u; i++) {
      matching = matching && world[PATCH+slot*76u+8u+i] == anchor.identity[i];
    }
    if (!matching) {
      continue;
    }
    let blend = coarse_weight(sample_position, slot);
    var coarse = 0xffffffffu;
    if (blend>0.0) {
      coarse = find_from(sample_position, position, sample_normal, PATCH+slot*76u, true, world[PATCH+slot*76u+21u]+1u, index);
    }
    for (var level = 0u; level<2u; level++) {
      let selected = select(slot, coarse, level == 1u);
      if (selected == 0xffffffffu || (scratch[VALID+selected]&1u) == 0u) {
        continue;
      }
      var cascade_weight = 1.0;
      if (coarse != 0xffffffffu) {
        cascade_weight = select(1.0-blend, blend, level == 1u);
      }
      let weight = tap_weight*cascade_weight;
      if (weight <= 0.0) {
        continue;
      }
      let b = PATCH+selected*76u;
      let next = total+weight;
      // Separate reduction avoids racing writes to shared patch last-access.
      atomicMax(&control[16u+selected], settings.frame);
      for (var i = 0u; i<12u; i++) {
        let value = select(bitcast<f32>(scratch[A1+selected*12u+i]), wf(b+52u+i), settings.post != 0u);
        result[i] = interpolate(result[i], value, weight/next);
      }
      confidence = interpolate(confidence, wf(b+35u), weight/next);
      total = next;
    }
  }
  if (total == 0.0 || !legal(result)) {
    return;
  }
  output.packedCoefficients = scgi_pack_irradiance(result, wf(58u));
  output.depth = anchor.motionDepth[3];
  let n = normal/(abs(normal.x)+abs(normal.y)+abs(normal.z));
  var uv = n.xy;
  if (n.z<0.0) {
    uv = (vec2f(1.0)-abs(uv.yx))*select(vec2f(-1.0), vec2f(1.0), uv >= vec2f(0.0));
  }
  output.octNormal = pack2x16snorm(uv);
  output.sourcePixel = anchor.sourcePixel;
  output.confidenceFlags = scgi_irradiance_flags(wf(58u), confidence);
  output.identity = anchor.identity;
  field[index] = output;
}
@compute @workgroup_size(64)
fn touch(@builtin(global_invocation_id) id: vec3u) {
  if (!live(id.x)) {
    return;
  }
  let frame = atomicLoad(&control[16u+id.x]);
  if (frame != 0u) {
    world[PATCH+id.x*76u+28u] = frame;
  }
}
`;
}
