import {
  LIGHT_DATABASE_READ_WGSL,
  POINT_LIGHT_DESCRIPTOR as POINT,
  SPOT_LIGHT_DESCRIPTOR as SPOT,
  DIRECTIONAL_LIGHT_DESCRIPTOR as DIRECTIONAL
} from "../gpu/LightDatabase.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { SCGI_ESTIMATOR as ABI, type ScgiEstimatorProfile } from "../render/gi/ScgiEstimatorLayout.js";
import type { ScgiAllocationPlan, ScgiArenaPlan } from "../render/gi/ScgiCapacity.js";
import { scgiCacheRequestWgsl } from "./scgi_cache.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "./native_environment_sample.js";
import { atmosphereRuntimeWgsl } from "./atmosphere/runtime.js";
import { PRIMARY_SURFACE_IDENTITY_WGSL } from "./primary_surface_identity.js";

/** Local estimator derived from transport integrals, not a translation of
 * Unity's UCL sources. One lane owns one sample path; a deterministic patch reducer owns SH. Only light compaction,
 * diagnostics and bounded bounce requests contend. Every phase is separated
 * by an encoder dependency. Baseline f32, no subgroup or float-atomic need. */
export function scgiEstimatorWgsl(
  plan: ScgiAllocationPlan,
  arena: ScgiArenaPlan,
  profile: ScgiEstimatorProfile
): string {
  const w = (name: string) => plan.world.ranges[name]!.offset / 4;
  const s = (name: string) => plan.scratch.ranges[name]!.offset / 4;
  const e = (name: string) => arena.ranges[name]!.offset / 4;
  const enumerate = (descriptor: typeof POINT, kind: number, pagesLane: string) => /* wgsl */ `
  if (id.x < settings.${pagesLane}) {
    let page = database[${descriptor.page_lookup_address}u + id.x];
    if (page != 0xffffffffu) {
      var local_rank = 0u;
      let page_at = LIGHT_PAGES + (id.x + select(0u, settings.point_pages, 0u != ${kind}u)) * 2u;
      for (var slot = 0u; slot < ${descriptor.elements_per_page}u; slot++) {
        if ((database[page + 1u + slot / 32u] & (1u << (slot % 32u))) != 0u) {
          let index = id.x * ${descriptor.elements_per_page}u + slot;
          let light = ${descriptor.marshalling_method_read}(&database, index);
          let ticket = atomicLoad(&estimate[page_at + 1u]) + local_rank;
          local_rank++;
          if (ticket >= ${profile.maximumLights}u) {
            atomicOr(&estimate[2u], 1u);
          } else {
            let at = LIGHTS + ticket * 4u;
            atomicStore(&estimate[at], ${kind}u);
            atomicStore(&estimate[at + 1u], index);
            let weight = max(max(light.color.x, light.color.y), light.color.z);
            if (!finite3(light.color) || any(light.color < vec3f(0.0))) {
              atomicOr(&estimate[2u], 2u);
            }
            storef(at + 2u, weight);
          }
        }
      }
    }
  }`;
  return /* wgsl */ `
${LIGHT_DATABASE_READ_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${PRIMARY_SURFACE_IDENTITY_WGSL}
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
${atmosphereRuntimeWgsl()}
struct Settings {
  window: u32,
  sample: u32,
  directional: u32,
  stage: u32,
  n_hemi: u32,
  n_connect: u32,
  multi_bounce: u32,
  previous_valid: u32,
  point_pages: u32,
  spot_pages: u32,
  power_sampling: u32,
  physical: u32,
  environment_mode: u32,
  view_dependent: u32,
  view_epoch: u32,
  mapping_generation: u32,
  lighting_epoch: u32,
  material_epoch: u32,
  environment_epoch: u32,
  snapshot: u32,
  ray_distance: f32,
  environment_scale: f32,
  normal_cosine: f32,
  plane_scale: f32,
  sample_serial: u32,
  shadow_window: u32,
  directional_count: u32,
  reserved2: u32,
  reserved3: vec4u,
}
@group(0) @binding(0) var<storage, read_write> world: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> previous: array<u32>;
@group(0) @binding(3) var<storage, read_write> estimate: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> batch: array<u32>;
@group(0) @binding(5) var<storage, read> hits: array<vec4f>;
@group(0) @binding(6) var<storage, read> database: array<u32>;
@group(0) @binding(7) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(8) var<storage, read> lineage: array<vec4u>;
@group(0) @binding(9) var<storage, read> native: array<u32>;
@group(0) @binding(10) var<uniform> settings: Settings;
@group(0) @binding(11) var<uniform> physical: PhysicalEnvironmentParameters;
@group(0) @binding(12) var environment: texture_2d<f32>;
@group(0) @binding(13) var transmittance: texture_2d<f32>;
@group(0) @binding(14) var atmosphere_sampler: sampler;
const LIGHTS: u32 = ${e("lights")}u;
const LIGHT_PAGES: u32 = ${e("lightPages")}u;
const POOL: u32 = ${e("pool")}u;
const PATHS: u32 = ${e("paths")}u;
const SHADOW: u32 = ${e("shadow")}u;
const SHADOW_MAP: u32 = ${e("shadowMap")}u;
const COHORTS: u32 = ${e("cohorts")}u;
const PATCH: u32 = ${w("patches")}u;
const MAP: u32 = ${w("map")}u;
const CACHE: u32 = ${w("cacheState")}u;
const CONTROL: u32 = ${s("cacheControl")}u;
const UPDATES: u32 = ${s("updateList")}u;
const RAW: u32 = ${s("raw")}u;
const CAPACITY: u32 = ${profile.batchRays}u;
const RESULT: u32 = ${profile.batchRays * 12}u;
const PI: f32 = 3.141592653589793;
const Y0: f32 = 0.28209479177387814;
const Y1: f32 = 0.4886025119029199;
fn ef(at: u32) -> f32 { return bitcast<f32>(atomicLoad(&estimate[at])); }
fn ev(at: u32) -> vec3f { return vec3f(ef(at), ef(at + 1u), ef(at + 2u)); }
fn storef(at: u32, value: f32) { atomicStore(&estimate[at], bitcast<u32>(value)); }
fn storev(at: u32, value: vec3f) {
  storef(at, value.x); storef(at + 1u, value.y); storef(at + 2u, value.z);
}
fn wf(at: u32) -> f32 { return bitcast<f32>(atomicLoad(&world[at])); }
fn wv(at: u32) -> vec3f { return vec3f(wf(at), wf(at + 1u), wf(at + 2u)); }
fn pv(at: u32) -> vec3f { return bitcast<vec3f>(vec3u(previous[at], previous[at + 1u], previous[at + 2u])); }
fn finite3(value: vec3f) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}
fn mix_bits(value: u32) -> u32 {
  var x = value;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}
fn random(seed: u32, dimension: u32) -> f32 {
  return f32(mix_bits(seed ^ mix_bits(dimension + 0x9e3779b9u)) >> 8u) * (1.0 / 16777216.0);
}
fn cohort_seed(cohort: u32, offset: u32) -> u32 {
  let first = atomicLoad(&estimate[cohort + 16u]);
  let serial = first + offset;
  let epoch = atomicLoad(&estimate[cohort + 21u]) + u32(serial < first);
  return mix_bits(atomicLoad(&estimate[cohort + 15u]) ^ mix_bits(serial) ^ mix_bits(epoch));
}
fn basis(n: vec3f) -> mat3x3f {
  let axis = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(n.z) > 0.9);
  let tangent = normalize(cross(axis, n));
  return mat3x3f(tangent, cross(n, tangent), n);
}
fn cone(seed: u32, n: vec3f, cosine: f32) -> vec3f {
  let z = mix(cosine, 1.0, random(seed, 1u));
  let phi = 2.0 * PI * random(seed, 2u);
  let radius = sqrt(max(0.0, 1.0 - z * z));
  return basis(n) * vec3f(radius * cos(phi), radius * sin(phi), z);
}
fn offset_origin(position: vec3f, normal: vec3f, error: f32) -> vec3f {
  return position + normal * error;
}
fn patch_error(at: u32) -> f32 {
  return max(wf(at + 7u), 32.0 * 1.1920928955078125e-7 * max(length(wv(at)), 1.0));
}
fn write_ray(lane: u32, origin: vec3f, direction: vec3f, distance: f32, kind: u32) {
  let at = lane * 12u;
  batch[at] = bitcast<u32>(origin.x);
  batch[at + 1u] = bitcast<u32>(origin.y);
  batch[at + 2u] = bitcast<u32>(origin.z);
  batch[at + 3u] = 0u;
  batch[at + 4u] = bitcast<u32>(direction.x);
  batch[at + 5u] = bitcast<u32>(direction.y);
  batch[at + 6u] = bitcast<u32>(direction.z);
  batch[at + 7u] = bitcast<u32>(distance);
  batch[at + 8u] = lane;
  batch[at + 9u] = 0xffffffffu;
  batch[at + 10u] = kind;
  batch[at + 11u] = settings.snapshot;
  // Query initialization starts with physical miss and an unset endpoint.
  for (var word = 0u; word < 8u; word++) { batch[RESULT + lane * 8u + word] = 0u; }
  batch[RESULT + lane * 8u] = bitcast<u32>(distance);
  batch[RESULT + lane * 8u + 3u] = 1u;
  batch[RESULT + lane * 8u + 4u] = 0xffffffffu;
  batch[RESULT + lane * 8u + 5u] = 0xffffffffu;
}
fn selected(index: u32) -> bool {
  return index < min(atomicLoad(&scratch[CONTROL + 28u]), ${plan.profile.updates}u);
}
fn fail(index: u32, status: u32) {
  atomicOr(&estimate[COHORTS + index * 24u + 14u], 1u << min(status, 31u));
  atomicAdd(&estimate[8u + min(status, 5u)], 1u);
}
@compute @workgroup_size(1)
fn window_count() {
  let updates = min(atomicLoad(&scratch[CONTROL + 28u]), ${plan.profile.updates}u);
  var total = ${profile.lightSamples}u;
  if (settings.stage == 1u) { total = updates * settings.n_hemi; }
  if (settings.stage == 2u) { total = updates * settings.n_connect; }
  let count = min(CAPACITY, total - min(total, settings.window));
  atomicStore(&estimate[6u], select(count, 0u, settings.stage == 0u && atomicLoad(&estimate[0u]) == 0u));
  atomicStore(&estimate[7u], count);
  atomicStore(&estimate[18u], (count + 63u) / 64u);
  atomicStore(&estimate[19u], 1u);
  atomicStore(&estimate[20u], 1u);
}
fn sample_index(lane: u32) -> u32 {
  return (settings.window + lane) / select(settings.n_hemi, settings.n_connect, settings.stage == 2u);
}
fn sample_number(lane: u32) -> u32 {
  return (settings.window + lane) % select(settings.n_hemi, settings.n_connect, settings.stage == 2u);
}
fn sample_active(lane: u32) -> bool { return lane < atomicLoad(&estimate[7u]); }
fn add_radiance(path: u32, value: vec3f, index: u32) {
  let next = ev(path + 56u) + value;
  if (!finite3(value) || !finite3(next)) { fail(index, 5u); return; }
  storev(path + 56u, next);
}
fn add_sh(index: u32, radiance: vec3f, direction: vec3f, weight: f32) {
  if (!finite3(radiance) || !finite3(direction)) { fail(index, 5u); return; }
  let coefficients = vec4f(Y0, Y1 * direction);
  let at = COHORTS + index * 24u;
  for (var term = 0u; term < 4u; term++) {
    let value = ev(at + term * 3u) + radiance * (coefficients[term] * weight);
    if (!finite3(value)) { fail(index, 5u); return; }
    storev(at + term * 3u, value);
  }
}
fn identity_for(lane: u32) -> array<u32, 16> {
  let instance = batch[RESULT + lane * 8u + 4u];
  let item = source[instance];
  let geometry = bitcast<vec4u>(hits[lane * 6u + 4u]);
  let revision = native[native[0u] + item.material_handle * 8u + 5u];
  return primary_surface_identity(lineage[instance], item, geometry.x, geometry.y, geometry.z, revision);
}
fn save_hit(path: u32, lane: u32) {
  // 0..23 Native hit (includes geometric normal/error), 24..31 query result,
  // 32..47 exact semantic identity. Higher lanes are phase-owned metadata.
  for (var item = 0u; item < 6u; item++) {
    let value = bitcast<vec4u>(hits[lane * 6u + item]);
    for (var channel = 0u; channel < 4u; channel++) {
      atomicStore(&estimate[path + item * 4u + channel], value[channel]);
    }
  }
  for (var item = 0u; item < 8u; item++) {
    atomicStore(&estimate[path + 24u + item], batch[RESULT + lane * 8u + item]);
  }
  let identity = identity_for(lane);
  for (var item = 0u; item < 16u; item++) { atomicStore(&estimate[path + 32u + item], identity[item]); }
}
fn orientation(normal: vec3f) -> u32 {
  let n = normal / (abs(normal.x) + abs(normal.y) + abs(normal.z));
  var uv = n.xy;
  if (n.z < 0.0) {
    uv = (vec2f(1.0) - abs(uv.yx)) * select(vec2f(-1.0), vec2f(1.0), uv >= vec2f(0.0));
  }
  let bin = min(vec2u((uv * 0.5 + 0.5) * 4.0), vec2u(3u));
  return bin.y * 4u + bin.x;
}
fn previous_irradiance(path: u32, source_patch: u32) -> vec3f {
  atomicAdd(&estimate[16u], 1u);
  let position = ev(path + 12u);
  let normal = ev(path + 20u);
  let direction = orientation(normal);
  if (settings.previous_valid != 0u && previous[15u] == 0u && previous[1u] == atomicLoad(&world[1u]) &&
      previous[2u] == atomicLoad(&world[2u]) && previous[4u] == settings.lighting_epoch &&
      previous[5u] == settings.material_epoch && previous[6u] == settings.environment_epoch &&
      (settings.view_dependent == 0u || previous[7u] == settings.view_epoch)) {
    for (var c = 0u; c < ${plan.profile.cascades}u; c++) {
      let scale = bitcast<f32>(previous[27u + c * 4u]);
      if (!(scale > 0.0)) { continue; }
      let coordinate = floor(position / scale);
      let origin = bitcast<vec3i>(vec3u(previous[40u + c * 4u], previous[41u + c * 4u], previous[42u + c * 4u]));
      let relative = coordinate - vec3f(origin);
      if (any(relative < vec3f(0.0)) || any(relative >= vec3f(${plan.profile.resolution}.0))) { continue; }
      let r = ${plan.profile.resolution};
      let xyz = ((vec3i(coordinate) % vec3i(r)) + vec3i(r)) % vec3i(r);
      let spatial = u32((xyz.x * r + xyz.y) * r + xyz.z);
      let cell = (c * ${plan.profile.resolution ** 3}u + spatial) * 16u + direction;
      let slot = previous[MAP + cell * 2u];
      if (slot >= ${plan.profile.patches}u || previous[CACHE + slot * 4u + 3u] == 0u) { continue; }
      let patch_at = PATCH + slot * 76u;
      if (previous[patch_at + 23u] != previous[MAP + cell * 2u + 1u] || previous[patch_at + 24u] == 0u) { continue; }
      if (previous[patch_at + 64u] != settings.lighting_epoch ||
          previous[patch_at + 65u] != settings.material_epoch ||
          previous[patch_at + 66u] != settings.environment_epoch ||
          (settings.view_dependent != 0u && previous[patch_at + 67u] != settings.view_epoch)) { continue; }
      var compatible = true;
      for (var i = 0u; i < 16u; i++) {
        let at = select(patch_at + 8u + i, patch_at + 72u + i - 12u, i >= 12u);
        compatible = compatible && previous[at] == atomicLoad(&estimate[path + 32u + i]);
      }
      let delta = position - pv(patch_at);
      let n = pv(patch_at + 4u);
      if (!compatible || dot(n, normal) < settings.normal_cosine ||
          abs(dot(delta, n)) > scale * settings.plane_scale || abs(dot(delta, normal)) > scale * settings.plane_scale ||
          dot(delta, delta) > scale * scale) { continue; }
      atomicAdd(&estimate[17u], 1u);
      let sh = vec4f(Y0, Y1 * ev(path + 8u));
      var irradiance = vec3f(0.0);
      for (var term = 0u; term < 4u; term++) { irradiance += pv(patch_at + 40u + term * 3u) * sh[term]; }
      return max(irradiance, vec3f(0.0));
    }
  }
  atomicAdd(&estimate[COHORTS + atomicLoad(&estimate[path + 55u]) * 24u + 20u], 1u);
  var request: array<u32, 28>;
  for (var i = 0u; i < 3u; i++) {
    request[i] = bitcast<u32>(position[i]);
    request[4u + i] = bitcast<u32>(normal[i]);
  }
  request[3u] = bitcast<u32>(ef(path + 23u));
  for (var i = 0u; i < 12u; i++) { request[8u + i] = atomicLoad(&estimate[path + 32u + i]); }
  for (var i = 0u; i < 4u; i++) { request[24u + i] = atomicLoad(&estimate[path + 44u + i]); }
  request[21u] = 1u;
  scgi_append_bounce_request(request, source_patch);
  return vec3f(0.0);
}
${scgiCacheRequestWgsl(plan)}
@compute @workgroup_size(64)
fn light_page_counts(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.point_pages + settings.spot_pages) { return; }
  let is_spot = id.x >= settings.point_pages;
  let page_index = select(id.x, id.x - settings.point_pages, is_spot);
  let lookup = select(${POINT.page_lookup_address}u, ${SPOT.page_lookup_address}u, is_spot);
  let slots = select(${POINT.elements_per_page}u, ${SPOT.elements_per_page}u, is_spot);
  let page = database[lookup + page_index];
  var count = 0u;
  if (page != 0xffffffffu) {
    for (var word = 0u; word < (slots + 31u) / 32u; word++) {
      count += countOneBits(database[page + 1u + word]);
    }
  }
  atomicStore(&estimate[LIGHT_PAGES + id.x * 2u], count);
}
@compute @workgroup_size(1)
fn light_page_offsets() {
  var total = 0u;
  for (var page = 0u; page < settings.point_pages + settings.spot_pages; page++) {
    let at = LIGHT_PAGES + page * 2u;
    atomicStore(&estimate[at + 1u], min(total, ${profile.maximumLights}u));
    let count = atomicLoad(&estimate[at]);
    if (count > ${profile.maximumLights}u - min(total, ${profile.maximumLights}u)) {
      atomicOr(&estimate[2u], 1u);
    }
    total += min(count, ${profile.maximumLights}u - total);
  }
  atomicStore(&estimate[0u], total);
}
@compute @workgroup_size(64)
fn publish_lights(@builtin(global_invocation_id) id: vec3u) {
  if (atomicLoad(&estimate[2u]) != 0u) { return; }
  ${enumerate(POINT, 0, "point_pages")}
  ${enumerate(SPOT, 1, "spot_pages")}
}
@compute @workgroup_size(1)
fn light_distribution() {
  let count = min(atomicLoad(&estimate[0u]), ${profile.maximumLights}u);
  var maximum = 0.0;
  for (var i = 0u; i < count; i++) { maximum = max(maximum, ef(LIGHTS + i * 4u + 2u)); }
  var sum = 0.0;
  for (var i = 0u; i < count; i++) {
    let at = LIGHTS + i * 4u;
    var weight = 1.0;
    if (settings.power_sampling != 0u && maximum > 0.0) {
      // Uniform mixture guarantees full support, even after f32 underflow.
      weight = 0.05 + 0.95 * ef(at + 2u) / maximum;
    }
    storef(at + 2u, weight);
    let next_sum = sum + weight;
    // A rounded-away CDF interval would silently remove a light's support.
    // Reject the entire publication instead of accepting a biased subset.
    if (!(next_sum > sum) || next_sum > 3.402823466e38) { atomicOr(&estimate[2u], 4u); }
    sum = next_sum;
    storef(at + 3u, sum);
  }
  storef(1u, sum);
}
@compute @workgroup_size(64)
fn begin_cohorts(@builtin(global_invocation_id) id: vec3u) {
  if (!selected(id.x)) { return; }
  let slot = atomicLoad(&scratch[UPDATES + id.x]);
  let patch_at = PATCH + slot * 76u;
  let cohort = COHORTS + id.x * 24u;
  var seed = mix_bits(atomicLoad(&world[patch_at + 23u]));
  for (var i = 0u; i < 16u; i++) {
    let at = select(patch_at + 8u + i, patch_at + 72u + i - 12u, i >= 12u);
    seed = mix_bits(seed ^ atomicLoad(&world[at]));
  }
  atomicStore(&estimate[cohort + 15u], seed);
  let serial = atomicLoad(&world[patch_at + 25u]);
  atomicStore(&estimate[cohort + 16u], serial);
  atomicStore(&estimate[cohort + 21u], atomicLoad(&world[patch_at + 26u]));
  atomicStore(&estimate[cohort + 17u], atomicLoad(&world[patch_at + 23u]));
  atomicStore(&estimate[cohort + 18u], settings.snapshot);
  atomicStore(&estimate[cohort + 19u], settings.mapping_generation);
  if (slot >= ${plan.profile.patches}u || atomicLoad(&world[15u]) != 0u ||
      atomicLoad(&estimate[2u]) != 0u ||
      (atomicLoad(&world[patch_at + 26u]) == 0xffffffffu && serial > 0xffffffffu - settings.n_hemi - settings.n_connect)) {
    fail(id.x, 5u);
  }
}
@compute @workgroup_size(64)
fn pool_rays(@builtin(global_invocation_id) id: vec3u) {
  let index = settings.window + id.x;
  if (index >= ${profile.lightSamples}u || id.x >= CAPACITY) { return; }
  let count = min(atomicLoad(&estimate[0u]), ${profile.maximumLights}u);
  atomicStore(&estimate[POOL + index * 48u + 27u], 1u);
  if (count == 0u) { write_ray(id.x, vec3f(0.0), vec3f(0.0, 0.0, 1.0), 0.0, 0u); return; }
  // Pool proposals are transaction-attempt stable across pre-submit retries.
  let seed = mix_bits(index ^ mix_bits(settings.sample_serial) ^ mix_bits(settings.lighting_epoch));
  let selection_target = random(seed, 0u) * ef(1u);
  var low = 0u;
  var high = count - 1u;
  loop {
    if (low >= high) { break; }
    let middle = low + (high - low) / 2u;
    if (ef(LIGHTS + middle * 4u + 3u) <= selection_target) { low = middle + 1u; }
    else { high = middle; }
  }
  let light = LIGHTS + low * 4u;
  let kind = atomicLoad(&estimate[light]);
  let light_index = atomicLoad(&estimate[light + 1u]);
  var position: vec3f;
  var direction = vec3f(0.0, 0.0, 1.0);
  var cosine = -1.0;
  var source_range = 0.0;
  if (kind == 0u) {
    let record = ${POINT.marshalling_method_read}(&database, light_index);
    position = record.position;
    source_range = record.distance;
  } else {
    let record = ${SPOT.marshalling_method_read}(&database, light_index);
    position = record.position;
    direction = record.direction;
    cosine = record.coneCos;
    source_range = record.distance;
  }
  let ray_direction = cone(seed, direction, cosine);
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  atomicStore(&estimate[path + 48u], low);
  storef(path + 49u, (2.0 * PI * (1.0 - cosine)) * ef(1u) / ef(light + 2u));
  storev(path + 50u, ray_direction);
  // A range-limited source is identically zero outside its support. An
  // arbitrary finite transport cutoff is not such a proof.
  storef(path + 53u, source_range);
  let distance = select(settings.ray_distance, min(settings.ray_distance, source_range), source_range > 0.0);
  write_ray(id.x, position, ray_direction, distance, 0u);
  atomicAdd(&estimate[3u], 1u);
}
@compute @workgroup_size(64)
fn pool_hits(@builtin(global_invocation_id) id: vec3u) {
  let index = settings.window + id.x;
  if (index >= ${profile.lightSamples}u || id.x >= CAPACITY || atomicLoad(&estimate[0u]) == 0u) { return; }
  let status = batch[RESULT + id.x * 8u + 3u];
  let pool = POOL + index * 48u;
  atomicStore(&estimate[pool + 27u], status);
  if (status > 1u) { return; }
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  if (status == 1u) {
    if (bitcast<u32>(settings.ray_distance) != 0x7f800000u &&
        !(ef(path + 53u) > 0.0 && ef(path + 53u) <= settings.ray_distance)) {
      atomicStore(&estimate[pool + 27u], 2u);
    }
    return;
  }
  save_hit(path, id.x);
  // Fixed pool record: hit facts + query endpoint; exact lineage is retained
  // by the immutable scene, and copied here for semantic diagnostics.
  for (var i = 0u; i < 48u; i++) { atomicStore(&estimate[pool + i], atomicLoad(&estimate[path + i])); }
  // Unused alpha/emission lanes hold proposal metadata, not transport energy.
  atomicStore(&estimate[pool + 3u], atomicLoad(&estimate[path + 48u]));
  atomicStore(&estimate[pool + 7u], atomicLoad(&estimate[path + 49u]));
  for (var i = 0u; i < 3u; i++) { atomicStore(&estimate[pool + 4u + i], atomicLoad(&estimate[path + 50u + i])); }
}
@compute @workgroup_size(64)
fn hemisphere_rays(@builtin(global_invocation_id) id: vec3u) {
  let index = sample_index(id.x);
  if (!sample_active(id.x)) { return; }
  let patch_at = PATCH + atomicLoad(&scratch[UPDATES + index]) * 76u;
  let cohort = COHORTS + index * 24u;
  let seed = cohort_seed(cohort, sample_number(id.x));
  let direction = cone(seed, wv(patch_at + 4u), 0.0);
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  storev(path + 48u, direction);
  storev(path + 56u, vec3f(0.0));
  write_ray(id.x, offset_origin(wv(patch_at), wv(patch_at + 4u), patch_error(patch_at)), direction, settings.ray_distance, 0u);
  atomicAdd(&estimate[3u], 1u);
}
@compute @workgroup_size(64)
fn hemisphere_hits(@builtin(global_invocation_id) id: vec3u) {
  let index = sample_index(id.x);
  if (!sample_active(id.x)) { return; }
  let status = batch[RESULT + id.x * 8u + 3u];
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  atomicStore(&estimate[path + 53u], status);
  atomicStore(&estimate[path + 55u], index);
  atomicAdd(&estimate[COHORTS + index * 24u + 12u], 1u);
  if (status > 1u) { fail(index, status); return; }
  if (status == 1u) {
    // A finite transport segment does not certify the rest of the hemisphere
    // ray as empty world. Never turn a budget cutoff into environment light.
    if (bitcast<u32>(settings.ray_distance) != 0x7f800000u) { fail(index, 2u); return; }
    var radiance = vec3f(0.0);
    if (settings.environment_mode != 0u) {
      radiance = sample_native_environment_mip(environment, ev(path + 48u), 0u) * settings.environment_scale;
    }
    add_radiance(path, radiance, index);
    return;
  }
  save_hit(path, id.x);
  var radiance = ev(path + 4u);
  if (settings.multi_bounce != 0u) {
    let irradiance = previous_irradiance(path, atomicLoad(&scratch[UPDATES + index]));
    radiance += ev(path) * ef(path + 7u) * irradiance;
  }
  add_radiance(path, radiance, index);
}
fn directional_incident(path: u32, directional: u32) -> mat2x3f {
  if (directional == 0u) {
    if (settings.physical == 0u) { return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0)); }
    return mat2x3f(normalize(physical.sun_direction_world),
      atmosphere_sun_irradiance(ev(path + 12u), physical, transmittance, atmosphere_sampler));
  }
  let index = directional - 1u;
  let page_index = index / ${DIRECTIONAL.elements_per_page}u;
  let slot = index % ${DIRECTIONAL.elements_per_page}u;
  let page = database[${DIRECTIONAL.page_lookup_address}u + page_index];
  if (page == 0xffffffffu || (database[page + 1u + slot / 32u] & (1u << (slot % 32u))) == 0u) {
    return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0));
  }
  let light = ${DIRECTIONAL.marshalling_method_read}(&database, index);
  return mat2x3f(-light.direction, light.color);
}
// A finite shadow window flattens path x directional. Candidate order stays
// immutable; only query slots are compacted. Each candidate owns its RGB.
var<workgroup> shadow_prefix: array<u32, 64>;
var<workgroup> shadow_base: u32;
@compute @workgroup_size(1)
fn shadow_reset() {
  atomicStore(&estimate[6u], 0u);
  atomicStore(&estimate[24u], 0u);
}
@compute @workgroup_size(64)
fn shadow_rays(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32) {
  let directions = settings.physical + settings.directional_count;
  let total = atomicLoad(&estimate[7u]) * directions;
  let flat = settings.shadow_window + id.x;
  let candidate_valid = id.x < CAPACITY && flat < total;
  let path_lane = flat / max(directions, 1u);
  let directional = flat % max(directions, 1u) + select(1u, 0u, settings.physical != 0u);
  let path = PATHS + path_lane * ${ABI.pathStride / 4}u;
  var queued = false;
  var incident = mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0));
  if (candidate_valid) {
    storev(SHADOW + id.x * 4u, vec3f(0.0));
    if (atomicLoad(&estimate[path + 53u]) == 0u) {
      incident = directional_incident(path, directional);
      let cosine = max(0.0, dot(ev(path + 8u), incident[0]));
      let radiance = ev(path) * ef(path + 7u) * incident[1] * cosine;
      let index = sample_index(path_lane);
      if (!finite3(incident[0]) || !finite3(incident[1]) || !finite3(radiance)) {
        fail(index, 5u);
      } else if (cosine > 0.0 && any(radiance != vec3f(0.0))) {
        if ((atomicLoad(&estimate[path + 15u]) & 4u) == 0u) {
          storev(SHADOW + id.x * 4u, radiance);
        } else { queued = true; }
      }
    }
  }
  shadow_prefix[li] = u32(queued);
  workgroupBarrier();
  for (var step = 1u; step < 64u; step *= 2u) {
    var other = 0u;
    if (li >= step) { other = shadow_prefix[li - step]; }
    workgroupBarrier();
    shadow_prefix[li] += other;
    workgroupBarrier();
  }
  if (li == 0u) { shadow_base = atomicAdd(&estimate[6u], shadow_prefix[63u]); }
  workgroupBarrier();
  if (queued) {
    let ticket = shadow_base + shadow_prefix[li] - 1u;
    if (ticket >= CAPACITY) { atomicStore(&estimate[24u], 1u); return; }
    atomicStore(&estimate[SHADOW_MAP + ticket], id.x);
    write_ray(ticket, offset_origin(ev(path + 12u), ev(path + 20u), ef(path + 23u)),
      incident[0], settings.ray_distance, 1u);
    atomicAdd(&estimate[4u], 1u);
  }
}
@compute @workgroup_size(1)
fn shadow_count() {
  let count = atomicLoad(&estimate[6u]);
  if (count > CAPACITY) { atomicStore(&estimate[24u], 1u); }
  atomicStore(&estimate[18u], (min(count, CAPACITY) + 63u) / 64u);
  atomicStore(&estimate[19u], 1u);
  atomicStore(&estimate[20u], 1u);
}
@compute @workgroup_size(64)
fn shadow_hits(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= min(atomicLoad(&estimate[6u]), CAPACITY)) { return; }
  let candidate = atomicLoad(&estimate[SHADOW_MAP + id.x]);
  let directions = settings.physical + settings.directional_count;
  let flat = settings.shadow_window + candidate;
  let path_lane = flat / directions;
  let path = PATHS + path_lane * ${ABI.pathStride / 4}u;
  let index = sample_index(path_lane);
  let status = batch[RESULT + id.x * 8u + 3u];
  if (status > 1u) { fail(index, status); return; }
  if (status == 0u) { return; }
  if (bitcast<u32>(settings.ray_distance) != 0x7f800000u) { fail(index, 2u); return; }
  let directional = flat % directions + select(1u, 0u, settings.physical != 0u);
  let incident = directional_incident(path, directional);
  let radiance = ev(path) * ef(path + 7u) * incident[1] * max(0.0, dot(ev(path + 8u), incident[0]));
  storev(SHADOW + candidate * 4u, radiance);
}
@compute @workgroup_size(64)
fn shadow_reduce(@builtin(global_invocation_id) id: vec3u) {
  if (!sample_active(id.x)) { return; }
  let directions = settings.physical + settings.directional_count;
  let first = max(id.x * directions, settings.shadow_window);
  let end = min((id.x + 1u) * directions, settings.shadow_window + CAPACITY);
  if (first >= end) { return; }
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  let index = sample_index(id.x);
  if (atomicLoad(&estimate[24u]) != 0u) { fail(index, 5u); return; }
  for (var flat = first; flat < end; flat++) {
    add_radiance(path, ev(SHADOW + (flat - settings.shadow_window) * 4u), index);
  }
}
@compute @workgroup_size(64)
fn sample_reduce(@builtin(global_invocation_id) id: vec3u) {
  let samples = select(settings.n_hemi, settings.n_connect, settings.stage == 2u);
  let index = settings.window / samples + id.x;
  if (!selected(index)) { return; }
  let first = max(index * samples, settings.window);
  let end = min((index + 1u) * samples, settings.window + atomicLoad(&estimate[7u]));
  for (var flat = first; flat < end; flat++) {
    let path = PATHS + (flat - settings.window) * ${ABI.pathStride / 4}u;
    let weight = select(2.0 * PI / f32(samples), 1.0 / f32(samples), settings.stage == 2u);
    add_sh(index, ev(path + 56u), ev(path + 48u), weight);
  }
}
@compute @workgroup_size(64)
fn connection_rays(@builtin(global_invocation_id) id: vec3u) {
  let index = sample_index(id.x);
  if (!sample_active(id.x)) { return; }
  let patch_at = PATCH + atomicLoad(&scratch[UPDATES + index]) * 76u;
  let cohort = COHORTS + index * 24u;
  let seed = cohort_seed(cohort, settings.n_hemi + sample_number(id.x));
  let pool_index = min(u32(random(seed, 3u) * f32(${profile.lightSamples}u)), ${profile.lightSamples - 1}u);
  let pool = POOL + pool_index * 48u;
  let status = atomicLoad(&estimate[pool + 27u]);
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  atomicStore(&estimate[path + 54u], 0u);
  storev(path + 48u, vec3f(0.0, 0.0, 1.0));
  storev(path + 56u, vec3f(0.0));
  atomicStore(&estimate[path + 55u], pool_index);
  atomicAdd(&estimate[cohort + 13u], 1u);
  if (status > 1u) { fail(index, status); }
  let delta = ev(pool + 12u) - wv(patch_at);
  let distance = length(delta);
  let error = patch_error(patch_at) + ef(pool + 23u);
  var direction = vec3f(0.0, 0.0, 1.0);
  if (distance > error && status == 0u && dot(delta, wv(patch_at + 4u)) > 0.0) {
    let origin = offset_origin(wv(patch_at), wv(patch_at + 4u), patch_error(patch_at));
    direction = normalize(ev(pool + 12u) - origin);
    atomicStore(&estimate[path + 54u], 1u);
    storev(path + 48u, normalize(delta));
    storef(path + 51u, distance * distance);
    storef(path + 52u, length(ev(pool + 12u) - origin));
    write_ray(id.x, origin, direction, ef(path + 52u) + error, 0u);
    atomicAdd(&estimate[5u], 1u);
  } else {
    write_ray(id.x, wv(patch_at), direction, 0.0, 0u);
  }
}
@compute @workgroup_size(64)
fn connection_hits(@builtin(global_invocation_id) id: vec3u) {
  let index = sample_index(id.x);
  if (!sample_active(id.x)) { return; }
  let path = PATHS + id.x * ${ABI.pathStride / 4}u;
  if (atomicLoad(&estimate[path + 54u]) == 0u) { return; }
  let status = batch[RESULT + id.x * 8u + 3u];
  if (status > 1u) { fail(index, status); return; }
  if (status == 1u) { return; }
  let pool = POOL + atomicLoad(&estimate[path + 55u]) * 48u;
  let result = RESULT + id.x * 8u;
  if (batch[result + 4u] != atomicLoad(&estimate[pool + 28u]) ||
      batch[result + 5u] != atomicLoad(&estimate[pool + 29u]) ||
      batch[result + 6u] != atomicLoad(&estimate[pool + 30u])) {
    atomicAdd(&estimate[21u], 1u);
    return;
  }
  let patch_at = PATCH + atomicLoad(&scratch[UPDATES + index]) * 76u;
  let tolerance = patch_error(patch_at) + ef(pool + 23u) + hits[id.x * 6u + 5u].w;
  if (abs(bitcast<f32>(batch[result]) - ef(path + 52u)) > tolerance) { return; }
  let identity = identity_for(id.x);
  for (var i = 0u; i < 16u; i++) {
    if (identity[i] != atomicLoad(&estimate[pool + 32u + i])) { return; }
  }
  let light_at = LIGHTS + atomicLoad(&estimate[pool + 3u]) * 4u;
  let light_index = atomicLoad(&estimate[light_at + 1u]);
  let light_distance = ef(pool + 24u);
  var intensity: vec3f;
  var attenuation: f32;
  if (atomicLoad(&estimate[light_at]) == 0u) {
    let light = ${POINT.marshalling_method_read}(&database, light_index);
    intensity = light.color;
    attenuation = light_sphere_distance_attenuation(light_distance, light.radius, light.distance);
  } else {
    let light = ${SPOT.marshalling_method_read}(&database, light_index);
    intensity = light.color;
    attenuation = light_sphere_distance_attenuation(light_distance, light.radius, light.distance) *
      light_get_spot_attenuation(light.coneCos, light.penumbraCos, dot(light.direction, ev(pool + 4u)));
  }
  let toward_patch = -ev(path + 48u);
  if (dot(ev(pool + 20u), toward_patch) <= 0.0) { return; }
  let selection_target = hits[id.x * 6u];
  let normal = hits[id.x * 6u + 2u].xyz;
  let source_geometric_cosine = dot(ev(pool + 20u), -ev(pool + 4u));
  let source_shading_cosine = max(0.0, dot(ev(pool + 8u), -ev(pool + 4u)));
  if (source_geometric_cosine <= 0.0 || source_shading_cosine == 0.0) { return; }
  // E_l's source cosine cancels p_A analytically. Radius attenuation remains
  // authoritative; the d_l^2 term is NOT discarded for finite-radius lights.
  // With normal maps, E_l uses shading cosine while area density uses flat
  // geometry. The residual ratio is required; no artificial grazing clamp.
  let source_normal_ratio = source_shading_cosine / source_geometric_cosine;
  let scale = attenuation * light_distance * light_distance * source_normal_ratio *
    max(0.0, dot(normal, toward_patch)) * ef(pool + 7u) / ef(path + 51u);
  let radiance_over_pdf = selection_target.rgb * hits[id.x * 6u + 1u].w * intensity * scale;
  atomicAdd(&estimate[22u], 1u);
  add_radiance(path, radiance_over_pdf, index);
}
@compute @workgroup_size(64)
fn finish_cohorts(@builtin(global_invocation_id) id: vec3u) {
  if (!selected(id.x)) { return; }
  let cohort = COHORTS + id.x * 24u;
  let patch_at = PATCH + atomicLoad(&scratch[UPDATES + id.x]) * 76u;
  let raw = RAW + id.x * 16u;
  var fault = atomicLoad(&estimate[cohort + 14u]);
  if (atomicLoad(&estimate[cohort + 12u]) != settings.n_hemi ||
      atomicLoad(&estimate[cohort + 13u]) != settings.n_connect ||
      atomicLoad(&world[patch_at + 23u]) != atomicLoad(&estimate[cohort + 17u])) { fault |= 32u; }
  var coefficients: array<vec3f, 4>;
  for (var term = 0u; term < 4u; term++) {
    coefficients[term] = ev(cohort + term * 3u) * select(2.0 * PI / 3.0, PI, term == 0u);
    if (!finite3(coefficients[term])) { fault |= 32u; }
  }
  for (var term = 0u; term < 4u; term++) {
    for (var c = 0u; c < 3u; c++) {
      atomicStore(&scratch[raw + term * 3u + c], bitcast<u32>(select(0.0, coefficients[term][c], fault == 0u)));
    }
  }
  // One invocation publishes a whole raw cohort. SCGI-7 is the sole owner of
  // statistical count/A0/A2. Failed attempts still consume their serials.
  atomicStore(&scratch[raw + 12u], settings.n_hemi);
  atomicStore(&scratch[raw + 13u], settings.n_connect);
  atomicStore(&scratch[raw + 14u], u32(fault == 0u));
  atomicStore(&scratch[raw + 15u], fault);
  let old_serial = atomicLoad(&estimate[cohort + 16u]);
  let advance = settings.n_hemi + settings.n_connect;
  let next_serial = old_serial + advance;
  let epoch = atomicLoad(&estimate[cohort + 21u]);
  if (next_serial < old_serial && epoch == 0xffffffffu) {
    atomicStore(&world[15u], 1u);
  } else {
    atomicStore(&world[patch_at + 25u], next_serial);
    atomicStore(&world[patch_at + 26u], epoch + u32(next_serial < old_serial));
  }
  atomicStore(&world[patch_at + 70u], fault);
  atomicStore(&world[patch_at + 71u], atomicLoad(&estimate[cohort + 20u]));
}
@compute @workgroup_size(1)
fn finish_epochs() {
  atomicStore(&world[4u], settings.lighting_epoch);
  atomicStore(&world[5u], settings.material_epoch);
  atomicStore(&world[6u], settings.environment_epoch);
  atomicStore(&world[7u], select(0u, settings.view_epoch, settings.view_dependent != 0u));
}
`;
}
