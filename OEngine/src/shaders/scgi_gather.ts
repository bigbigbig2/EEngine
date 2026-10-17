import {
  LIGHT_DATABASE_READ_WGSL,
  POINT_LIGHT_DESCRIPTOR as POINT,
  SPOT_LIGHT_DESCRIPTOR as SPOT,
  DIRECTIONAL_LIGHT_DESCRIPTOR as DIRECTIONAL,
} from "../gpu/LightDatabase.js";
import { SCGI_ABI_WGSL, SCGI_IRRADIANCE_WGSL } from "../render/gi/ScgiAbi.js";
import { SCGI_GATHER_MATH_WGSL, type planScgiGather } from "../render/gi/ScgiGatherLayout.js";
import { atmosphereRuntimeWgsl } from "./atmosphere/runtime.js";

/** Screen-probe scheduling follows FidelityFX Brixelizer GI's spawn, reproject,
 * fill, SH projection and interpolation decomposition (MIT, c6efa6bf). Transport
 * and the paired signed estimator below are EEngine's triangle-query adaptation;
 * no SDF, wave-size assumption, packed RGB9E5 or previous final HDR is imported. */
export function scgiGatherWgsl(plan: ReturnType<typeof planScgiGather>, lightsWord: number): string {
  return /* wgsl */ `
${LIGHT_DATABASE_READ_WGSL}
${SCGI_ABI_WGSL}
${SCGI_IRRADIANCE_WGSL}
${SCGI_GATHER_MATH_WGSL}
${atmosphereRuntimeWgsl()}
struct GatherAnchor {
  positionValid: vec4f,
  normal: vec3f,
  sourcePixel: u32,
  previousPositionValid: vec4f,
  motionDepth: vec4f,
  identity: array<u32, 16>,
}
struct GatherSettings {
  extent: vec4u, // full width/height, half width/height
  segment: vec4u, // first half pixel, count, batch first, batch count
  control: vec4u, // frame, previous valid, phase, directional slot
  profile: vec4u, // local maximum, directional slots, physical, spare
  camera: vec4f,
  view_projection: mat4x4f,
  previous_view: mat4x4f,
  parameters: vec4f, // near distance, normal cosine, plane scale, history alpha
  history: vec4u, // previous field segment first/count
  previous_inverse_view_projection: mat4x4f,
}
@group(0) @binding(0) var<uniform> settings: GatherSettings;
@group(0) @binding(1) var<storage, read> anchors: array<GatherAnchor>;
@group(0) @binding(2) var<storage, read> field: array<u32>;
@group(0) @binding(3) var<storage, read_write> probes: array<u32>;
@group(0) @binding(4) var<storage, read> previous_probes: array<u32>;
@group(0) @binding(5) var<storage, read_write> residual: array<u32>;
@group(0) @binding(6) var<storage, read_write> batch: array<u32>;
@group(0) @binding(7) var<storage, read> hits: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> directions: array<vec4f>;
@group(0) @binding(9) var<storage, read> database: array<u32>;
@group(0) @binding(10) var<storage, read> estimate: array<u32>;
@group(0) @binding(11) var<storage, read_write> source_state: array<vec4f>;
@group(0) @binding(12) var source: texture_2d<f32>;
@group(0) @binding(13) var source_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(14) var<uniform> physical: PhysicalEnvironmentParameters;
@group(0) @binding(15) var transmittance: texture_2d<f32>;
@group(0) @binding(16) var atmosphere_sampler: sampler;
@group(0) @binding(17) var<storage, read> query_lineage: array<vec4u>;
@group(0) @binding(18) var<storage, read> previous_residual: array<u32>;
@group(0) @binding(19) var<storage, read> previous_field: array<u32>;
@group(0) @binding(20) var<storage, read_write> next_residual: array<u32>;
@group(0) @binding(21) var<storage, read_write> work: array<atomic<u32>>;
const REQUEST_BITS: u32 = ${plan.work.bits}u;
const REQUESTS: u32 = ${plan.work.requests}u;
const IDS: u32 = ${plan.work.ids}u;
const PREPARATION: u32 = ${plan.work.preparation}u;
const MAPPING: u32 = ${plan.work.mapping}u;
const SHADOW: u32 = ${plan.work.shadow}u;
const SOURCE_CAPACITY: u32 = ${plan.work.capacity}u;
const RESULT: u32 = ${plan.batch * 12}u;
const LIGHTS: u32 = ${lightsWord}u;
const DIRECTIONS: u32 = ${plan.directions}u;
const HALF_TILE: u32 = ${plan.tile / 2}u;
const PROBE_COLUMNS: u32 = ${plan.columns}u;
const PROBE_ROWS: u32 = ${plan.rows}u;
fn pf(at: u32) -> f32 { return bitcast<f32>(probes[at]); }
fn pv(at: u32) -> vec3f { return vec3f(pf(at), pf(at + 1u), pf(at + 2u)); }
fn oldv(at: u32) -> vec3f {
  return bitcast<vec3f>(vec3u(previous_probes[at], previous_probes[at + 1u], previous_probes[at + 2u]));
}
fn putv(at: u32, value: vec3f) {
  for (var c = 0u; c < 3u; c++) { probes[at + c] = bitcast<u32>(value[c]); }
}
fn gather_hash(value: u32) -> u32 {
  var x = value;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}
fn gather_random(value: u32) -> f32 { return f32(gather_hash(value) >> 8u) / 16777216.0; }
fn finite3(value: vec3f) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}
fn basis(n: vec3f) -> mat3x3f {
  let axis = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(n.z) > 0.9);
  let tangent = normalize(cross(axis, n));
  return mat3x3f(tangent, cross(n, tangent), n);
}
fn sample_direction(probe: u32, sample: u32) -> vec3f {
  // Hemioctahedral square -> diamond -> hemisphere. Its solid-angle Jacobian
  // is 2/|raw|^3; PDF is |raw|^3/2, explicitly paired in project().
  let u = (f32(sample) + gather_random(probe ^ settings.control.x)) / f32(DIRECTIONS);
  let v = fract(f32(sample) * 0.6180339887498949 + gather_random(probe ^ gather_hash(settings.control.x)));
  let xy = vec2f(u + v - 1.0, u - v);
  let raw = vec3f(xy, max(0.0, 1.0 - abs(xy.x) - abs(xy.y)));
  return basis(pv(probe * 40u + 16u)) * normalize(raw);
}
fn direction_pdf(probe: u32, direction: vec3f) -> f32 {
  let local = transpose(basis(pv(probe * 40u + 16u))) * direction;
  let l1 = abs(local.x) + abs(local.y) + abs(local.z);
  return 0.5 / (l1 * l1 * l1);
}
fn write_ray(lane: u32, origin: vec3f, direction: vec3f, distance: f32) {
  let at = lane * 12u;
  for (var c = 0u; c < 3u; c++) {
    batch[at + c] = bitcast<u32>(origin[c]);
    batch[at + 4u + c] = bitcast<u32>(direction[c]);
  }
  batch[at + 3u] = 0u;
  batch[at + 7u] = bitcast<u32>(distance);
  batch[at + 8u] = lane;
  batch[at + 9u] = 0xffffffffu;
  batch[at + 10u] = 0u;
  batch[at + 11u] = settings.control.x;
  let result = RESULT + lane * 8u;
  for (var i = 0u; i < 8u; i++) { batch[result + i] = 0u; }
  batch[result] = bitcast<u32>(distance);
  batch[result + 3u] = 1u;
  batch[result + 4u] = 0xffffffffu;
  batch[result + 5u] = 0xffffffffu;
}
fn world_coefficients(index: u32) -> array<vec3f, 4> {
  var result: array<vec3f, 4>;
  let at = index * 28u;
  if ((field[at + 11u] & 3u) != 3u) { return result; }
  var packed: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { packed[i] = field[at + i]; }
  let decoded = scgi_unpack_irradiance(packed, scgi_field_scale(field[at + 11u]));
  for (var i = 0u; i < 4u; i++) { result[i] = vec3f(decoded[i * 3u], decoded[i * 3u + 1u], decoded[i * 3u + 2u]); }
  return result;
}
fn evaluate(c: array<vec3f, 4>, n: vec3f) -> vec3f {
  return c[0] * GATHER_Y0 + GATHER_Y1 * (n.x * c[1] + n.y * c[2] + n.z * c[3]);
}
fn compatible(anchor: GatherAnchor, at: u32, previous: bool) -> bool {
  if (previous_probes[at + 39u] == 0u) { return false; }
  // Spatial interpolation permits a different meshlet/primitive. Instance
  // lineage, geometry, material and dynamic revisions remain exact.
  for (var i = 0u; i < 12u; i++) {
    if (i == 8u) { continue; }
    if (previous_probes[at + 20u + i] != anchor.identity[i]) { return false; }
  }
  let normal = oldv(at + 16u);
  let position = select(anchor.positionValid.xyz, anchor.previousPositionValid.xyz, previous);
  let delta = position - oldv(at + 12u);
  let tolerance = max(0.003, anchor.motionDepth.w * settings.parameters.z);
  return dot(normal, anchor.normal) >= settings.parameters.y &&
    abs(dot(delta, normal)) <= tolerance && abs(dot(delta, anchor.normal)) <= tolerance &&
    length(delta) <= max(tolerance, settings.parameters.x);
}
fn previous_probe(anchor: GatherAnchor) -> u32 {
  if (settings.control.y == 0u || anchor.previousPositionValid.w == 0.0) { return 0xffffffffu; }
  let pixel = vec2f(f32(anchor.sourcePixel % settings.extent.x), f32(anchor.sourcePixel / settings.extent.x));
  let previous_pixel = (pixel + vec2f(0.5)) - anchor.motionDepth.xy * vec2f(settings.extent.xy);
  let tile = vec2i(floor(previous_pixel / f32(${plan.tile}u)));
  var best = 0xffffffffu;
  var distance = 1e30;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let candidate = tile + vec2i(x, y);
      if (any(candidate < vec2i(0)) || any(candidate >= vec2i(i32(PROBE_COLUMNS), i32(PROBE_ROWS)))) { continue; }
      let index = u32(candidate.y) * PROBE_COLUMNS + u32(candidate.x);
      let at = index * 40u;
      let depth = -(settings.previous_view * vec4f(oldv(at + 12u), 1.0)).z;
      if (!compatible(anchor, at, true) || abs(depth - anchor.motionDepth.z) > max(0.003, anchor.motionDepth.z * 0.02)) { continue; }
      let d = length(anchor.previousPositionValid.xyz - oldv(at + 12u));
      if (d < distance) { distance = d; best = index; }
    }
  }
  return best;
}
fn pack_residual(at: u32, c: array<vec3f, 4>, confidence: f32) {
  var maximum = 0.0;
  for (var term = 0u; term < 4u; term++) {
    maximum = max(maximum, max(max(abs(c[term].x), abs(c[term].y)), abs(c[term].z)));
  }
  let scale = exp2(clamp(ceil(log2(max(maximum / 60000.0, 1e-30))), -120.0, 120.0));
  for (var pair = 0u; pair < 6u; pair++) {
    let first = pair * 2u;
    next_residual[at + pair] = pack2x16float(vec2f(c[first / 3u][first % 3u], c[(first + 1u) / 3u][(first + 1u) % 3u]) / scale);
  }
  next_residual[at + 6u] = bitcast<u32>(scale);
  next_residual[at + 7u] = bitcast<u32>(clamp(confidence, 0.0, 1.0));
}
fn oct_decode(packed: u32) -> vec3f {
  let xy = unpack2x16snorm(packed);
  var n = vec3f(xy, 1.0 - abs(xy.x) - abs(xy.y));
  if (n.z < 0.0) { n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z); }
  return normalize(n);
}
@compute @workgroup_size(64)
fn reproject(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.segment.y || settings.control.y == 0u) { return; }
  let anchor = anchors[id.x];
  if (anchor.positionValid.w == 0.0 || anchor.previousPositionValid.w == 0.0) { return; }
  let pixel = vec2f(f32(anchor.sourcePixel % settings.extent.x), f32(anchor.sourcePixel / settings.extent.x));
  let point = (pixel + vec2f(0.5) - anchor.motionDepth.xy * vec2f(settings.extent.xy)) * 0.5;
  let previous_pixel = vec2i(floor(point));
  if (any(previous_pixel < vec2i(0)) || any(previous_pixel >= vec2i(settings.extent.zw))) { return; }
  let index = u32(previous_pixel.y) * settings.extent.z + u32(previous_pixel.x);
  if (index < settings.history.x || index - settings.history.x >= settings.history.y) { return; }
  let local = index - settings.history.x;
  let at = local * 28u;
  if ((previous_field[at + 11u] & 3u) != 3u) { return; }
  for (var i = 0u; i < 16u; i++) {
    if (previous_field[at + 12u + i] != anchor.identity[i]) { return; }
  }
  let depth = bitcast<f32>(previous_field[at + 8u]);
  let normal = oct_decode(previous_field[at + 9u]);
  if (abs(depth - anchor.motionDepth.z) > max(0.003, anchor.motionDepth.z * 0.02) ||
      dot(normal, anchor.normal) < settings.parameters.y) { return; }
  let source_pixel = previous_field[at + 10u];
  let source_xy = vec2f(f32(source_pixel % settings.extent.x), f32(source_pixel / settings.extent.x));
  let ndc = (source_xy + vec2f(0.5)) / vec2f(settings.extent.xy) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let far = settings.previous_inverse_view_projection * vec4f(ndc, 1.0, 1.0);
  let near = settings.previous_inverse_view_projection * vec4f(ndc, 0.5, 1.0);
  let ray_origin = near.xyz / near.w;
  let ray_direction = far.xyz / far.w - ray_origin;
  let origin_depth = -(settings.previous_view * vec4f(ray_origin, 1.0)).z;
  let depth_direction = -(settings.previous_view * vec4f(ray_direction, 0.0)).z;
  if (abs(depth_direction) < 1e-20) { return; }
  let position = ray_origin + ray_direction * ((depth - origin_depth) / depth_direction);
  let delta = anchor.previousPositionValid.xyz - position;
  let tolerance = max(0.003, depth * settings.parameters.z);
  if (abs(dot(delta, normal)) > tolerance || abs(dot(delta, anchor.normal)) > tolerance) { return; }
  let target_at = id.x * 8u;
  for (var i = 0u; i < 8u; i++) { residual[target_at + i] = previous_residual[local * 8u + i]; }
}
@compute @workgroup_size(64)
fn interpolate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.segment.y) { return; }
  let at = id.x * 8u;
  for (var i = 0u; i < 8u; i++) { next_residual[at + i] = 0u; }
  let anchor = anchors[id.x];
  if (anchor.positionValid.w == 0.0 || (field[id.x * 28u + 11u] & 3u) != 3u) { return; }
  let index = settings.segment.x + id.x;
  let point = (vec2f(f32(index % settings.extent.z), f32(index / settings.extent.z)) + vec2f(0.5)) / f32(HALF_TILE) - vec2f(0.5);
  let base = vec2i(floor(point));
  let fraction = fract(point);
  var c: array<vec3f, 4>;
  var total = 0.0;
  var confidence = 0.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let step = vec2i(i32(tap & 1u), i32(tap >> 1u));
    let tile = base + step;
    if (any(tile < vec2i(0)) || any(tile >= vec2i(i32(PROBE_COLUMNS), i32(PROBE_ROWS)))) { continue; }
    let probe = (u32(tile.y) * PROBE_COLUMNS + u32(tile.x)) * 40u;
    if (probes[probe + 39u] == 0u) { continue; }
    var same = true;
    for (var i = 0u; i < 12u; i++) {
      if (i != 8u && probes[probe + 20u + i] != anchor.identity[i]) { same = false; }
    }
    let normal = pv(probe + 16u);
    let delta = anchor.positionValid.xyz - pv(probe + 12u);
    let tolerance = max(0.003, anchor.motionDepth.w * settings.parameters.z);
    if (!same || dot(normal, anchor.normal) < settings.parameters.y ||
        abs(dot(delta, normal)) > tolerance || abs(dot(delta, anchor.normal)) > tolerance) { continue; }
    let axis = select(vec2f(1.0) - fraction, fraction, step != vec2i(0));
    let weight = axis.x * axis.y;
    for (var term = 0u; term < 4u; term++) { c[term] += pv(probe + term * 3u) * weight; }
    total += weight;
    confidence += pf(probe + 19u) * weight;
  }
  if (!(total > 0.0)) { return; }
  for (var term = 0u; term < 4u; term++) { c[term] /= total; }
  pack_residual(at, c, confidence / total);
}
@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${plan.probes}u) { return; }
  let at = id.x * 40u;
  if (probes[at + 39u] != 0u) { return; }
  let tile = vec2u(id.x % PROBE_COLUMNS, id.x / PROBE_COLUMNS) * HALF_TILE;
  let rotation = gather_hash(id.x ^ settings.control.x) % (HALF_TILE * HALF_TILE);
  for (var step = 0u; step < HALF_TILE * HALF_TILE; step++) {
    let lane = (step + rotation) % (HALF_TILE * HALF_TILE);
    let pixel = tile + vec2u(lane % HALF_TILE, lane / HALF_TILE);
    if (any(pixel >= settings.extent.zw)) { continue; }
    let index = pixel.y * settings.extent.z + pixel.x;
    if (index < settings.segment.x || index - settings.segment.x >= settings.segment.y) { continue; }
    let anchor = anchors[index - settings.segment.x];
    let f = (index - settings.segment.x) * 28u;
    let flags = field[f + 11u];
    if (anchor.positionValid.w == 0.0 || (flags & 3u) != 3u || ((flags >> 10u) & 65535u) == 0u) { continue; }
    let c = world_coefficients(index - settings.segment.x);
    for (var term = 0u; term < 4u; term++) { putv(at + term * 3u, c[term]); }
    putv(at + 12u, anchor.positionValid.xyz);
    probes[at + 15u] = bitcast<u32>(anchor.motionDepth.w);
    putv(at + 16u, anchor.normal);
    probes[at + 19u] = 0u;
    for (var i = 0u; i < 16u; i++) { probes[at + 20u + i] = anchor.identity[i]; }
    probes[at + 36u] = 0u;
    probes[at + 37u] = previous_probe(anchor);
    probes[at + 38u] = index;
    probes[at + 39u] = 1u;
    return;
  }
}
fn source_light(lane: u32) -> u32 {
  let count = min(estimate[0u], settings.profile.x);
  let sum = bitcast<f32>(estimate[1u]);
  if (count == 0u || estimate[2u] != 0u || !(sum > 0.0)) { return 0xffffffffu; }
  let selection_target = gather_random(bitcast<u32>(hits[lane * 6u + 4u].x) + gather_hash(settings.control.x)) * sum;
  var low = 0u;
  var high = count - 1u;
  loop {
    if (low >= high) { break; }
    let middle = low + (high - low) / 2u;
    if (bitcast<f32>(estimate[LIGHTS + middle * 4u + 3u]) <= selection_target) { low = middle + 1u; }
    else { high = middle; }
  }
  return LIGHTS + low * 4u;
}
fn source_incident(lane: u32) -> mat2x3f {
  let position = hits[lane * 6u + 3u].xyz;
  let phase = settings.control.z;
  if (phase == 0u) {
    let at = source_light(lane);
    let sum = bitcast<f32>(estimate[1u]);
    if (at == 0xffffffffu) { return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0)); }
    let pdf = bitcast<f32>(estimate[at + 2u]) / sum;
    let index = estimate[at + 1u];
    var light_position: vec3f;
    var color: vec3f;
    var radius: f32;
    var range: f32;
    if (estimate[at] == 0u) {
      let light = ${POINT.marshalling_method_read}(&database, index);
      light_position = light.position; color = light.color; radius = light.radius; range = light.distance;
    } else {
      let light = ${SPOT.marshalling_method_read}(&database, index);
      light_position = light.position; color = light.color; radius = light.radius; range = light.distance;
      let toward = normalize(position - light_position);
      color *= light_get_spot_attenuation(light.coneCos, light.penumbraCos, dot(light.direction, toward));
    }
    let delta = light_position - position;
    let distance = length(delta);
    if (!(distance > 1e-6)) { return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0)); }
    return mat2x3f(delta / distance, color * light_sphere_distance_attenuation(distance, radius, range) / pdf);
  }
  if (phase == 1u) {
    if (settings.profile.z == 0u) { return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0)); }
    return mat2x3f(normalize(physical.sun_direction_world), atmosphere_sun_irradiance(position, physical, transmittance, atmosphere_sampler));
  }
  let index = settings.control.w;
  let page = database[${DIRECTIONAL.page_lookup_address}u + index / ${DIRECTIONAL.elements_per_page}u];
  let slot = index % ${DIRECTIONAL.elements_per_page}u;
  if (page == 0xffffffffu || (database[page + 1u + slot / 32u] & (1u << (slot % 32u))) == 0u) {
    return mat2x3f(vec3f(0.0, 1.0, 0.0), vec3f(0.0));
  }
  let light = ${DIRECTIONAL.marshalling_method_read}(&database, index);
  return mat2x3f(-light.direction, light.color);
}
@compute @workgroup_size(64)
fn clear_source(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.extent.z * settings.extent.w) { return; }
  textureStore(source_output, vec2i(i32(id.x % settings.extent.z), i32(id.x / settings.extent.z)), vec4f(0.0));
}
@compute @workgroup_size(1)
fn source_count() {
  let total = atomicLoad(&work[0u]);
  let count = min(${plan.batch}u, total - min(total, settings.segment.z));
  atomicStore(&work[4u], (count + 63u) / 64u);
  atomicStore(&work[5u], 1u);
  atomicStore(&work[6u], 1u);
}
@compute @workgroup_size(64)
fn source_begin(@builtin(global_invocation_id) id: vec3u) {
  let ticket = settings.segment.z + id.x;
  if (id.x >= ${plan.batch}u || ticket >= min(atomicLoad(&work[0u]), SOURCE_CAPACITY)) { return; }
  let prep = PREPARATION + ticket * 12u;
  let value = bitcast<vec4f>(vec4u(atomicLoad(&work[prep + 4u]), atomicLoad(&work[prep + 5u]),
    atomicLoad(&work[prep + 6u]), atomicLoad(&work[prep + 7u])));
  source_state[id.x] = select(vec4f(0.0), value, value.w == 1.0 && finite3(value.xyz));
}
@compute @workgroup_size(64)
fn source_rays(@builtin(global_invocation_id) id: vec3u) {
  let ticket = settings.segment.z + id.x;
  if (id.x >= ${plan.batch}u || ticket >= min(atomicLoad(&work[0u]), SOURCE_CAPACITY) || source_state[id.x].w != 1.0) { return; }
  let incident = source_incident(id.x);
  let cosine = max(0.0, dot(incident[0], hits[id.x * 6u + 2u].xyz));
  let response = hits[id.x * 6u].xyz * incident[1] * cosine;
  if (all(response == vec3f(0.0))) { return; }
  let receives = (bitcast<u32>(hits[id.x * 6u + 3u].w) & 4u) != 0u;
  let visibility = hits[id.x * 6u + 2u].w;
  if (!receives || (settings.control.z == 1u && visibility >= 0.0)) {
    atomicAdd(&work[13u], u32(receives));
    source_state[id.x] += vec4f(response * select(1.0, visibility, receives), 0.0);
    return;
  }
  let geometry = hits[id.x * 6u + 5u];
  let origin = hits[id.x * 6u + 3u].xyz + geometry.xyz * geometry.w;
  var distance = bitcast<f32>(0x7f800000u | (settings.control.x & 0u));
  var direction = incident[0];
  if (settings.control.z == 0u) {
    let at = source_light(id.x);
    var endpoint: vec3f;
    if (estimate[at] == 0u) { endpoint = ${POINT.marshalling_method_read}(&database, estimate[at + 1u]).position; }
    else { endpoint = ${SPOT.marshalling_method_read}(&database, estimate[at + 1u]).position; }
    let delta = endpoint - origin;
    let length_to_light = length(delta);
    distance = max(0.0, length_to_light - geometry.w);
    if (length_to_light > 1e-6) { direction = delta / length_to_light; }
  }
  let lane = atomicAdd(&work[1u], 1u);
  atomicAdd(&work[12u], 1u);
  if (lane >= ${plan.batch}u) { atomicStore(&work[2u], 1u); return; }
  atomicStore(&work[SHADOW + lane], id.x);
  write_ray(lane, origin, direction, distance);
}
@compute @workgroup_size(1)
fn shadow_count() {
  let count = atomicLoad(&work[1u]);
  atomicStore(&work[8u], (count + 63u) / 64u);
  atomicStore(&work[9u], 1u);
  atomicStore(&work[10u], 1u);
}
@compute @workgroup_size(64)
fn source_shadow(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= atomicLoad(&work[1u])) { return; }
  let lane = atomicLoad(&work[SHADOW + id.x]);
  let status = batch[RESULT + id.x * 8u + 3u];
  if (status > 1u) { source_state[lane].w = 0.0; return; }
  if (status == 1u) {
    let incident = source_incident(lane);
    let cosine = max(0.0, dot(incident[0], hits[lane * 6u + 2u].xyz));
    source_state[lane] += vec4f(hits[lane * 6u].xyz * incident[1] * cosine, 0.0);
  }
}
@compute @workgroup_size(64)
fn source_finish(@builtin(global_invocation_id) id: vec3u) {
  let ticket = settings.segment.z + id.x;
  if (id.x >= ${plan.batch}u || ticket >= min(atomicLoad(&work[0u]), SOURCE_CAPACITY)) { return; }
  let index = atomicLoad(&work[IDS + ticket]);
  let value = source_state[id.x];
  let valid = value.w == 1.0 && finite3(value.xyz) && atomicLoad(&work[2u]) == 0u;
  textureStore(source_output, vec2i(i32(index % settings.extent.z), i32(index / settings.extent.z)), select(vec4f(0.0), value, valid));
}
@compute @workgroup_size(64)
fn probe_rays(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.segment.w) { return; }
  let probe = settings.segment.z + id.x / DIRECTIONS;
  let sample = id.x % DIRECTIONS;
  let at = probe * 40u;
  let direction = sample_direction(probe, sample);
  let error = max(0.00001, 32.0 * 1.1920928955078125e-7 * max(1.0, length(pv(at + 12u))));
  write_ray(id.x, pv(at + 12u) + pv(at + 16u) * error, direction,
    select(0.0, settings.parameters.x, probes[at + 39u] != 0u));
}
@compute @workgroup_size(64)
fn request(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.segment.w) { return; }
  let result = RESULT + id.x * 8u;
  if (batch[result + 3u] != 0u) { return; }
  let probe = settings.segment.z + id.x / DIRECTIONS;
  let p = probe * 40u;
  if (probes[p + 39u] == 0u) { return; }
  let position = hits[id.x * 6u + 3u].xyz;
  let clip = settings.view_projection * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return; }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return; }
  let pixel = min(vec2u(uv * vec2f(settings.extent.xy)) / 2u, settings.extent.zw - vec2u(1u));
  let index = pixel.y * settings.extent.z + pixel.x;
  if (index < settings.segment.x || index - settings.segment.x >= settings.segment.y) { return; }
  let anchor = anchors[index - settings.segment.x];
  let geometry = bitcast<vec4u>(hits[id.x * 6u + 4u]);
  let flat = hits[id.x * 6u + 5u];
  let error = max(flat.w * 4.0, 0.002);
  let instance_slot = batch[result + 4u];
  if (instance_slot >= arrayLength(&query_lineage)) { return; }
  let lineage = query_lineage[instance_slot];
  for (var i = 0u; i < 4u; i++) {
    if (anchor.identity[i] != lineage[i]) { return; }
  }
  // Accepted triangle visibility is mandatory. Exact identity and plane checks
  // reject a screen texel belonging to a wall behind/in front of the hit.
  if (anchor.positionValid.w == 0.0 || anchor.identity[6] != geometry.x ||
      anchor.identity[8] != geometry.y || anchor.identity[12] != geometry.z ||
      dot(anchor.normal, flat.xyz) < settings.parameters.y ||
      abs(dot(anchor.positionValid.xyz - position, flat.xyz)) > error ||
      abs(dot(anchor.positionValid.xyz - position, anchor.normal)) > error) { return; }
  let mapping = MAPPING + (probe * DIRECTIONS + id.x % DIRECTIONS) * 4u;
  atomicAdd(&work[11u], 1u);
  atomicStore(&work[mapping], index + 1u);
  atomicStore(&work[mapping + 1u], batch[result]);
  let mask = 1u << (index & 31u);
  let prior = atomicOr(&work[REQUEST_BITS + index / 32u], mask);
  if ((prior & mask) == 0u) {
    let ticket = atomicAdd(&work[0u], 1u);
    if (ticket >= SOURCE_CAPACITY) { atomicStore(&work[2u], 1u); return; }
    atomicStore(&work[IDS + ticket], index);
    atomicStore(&work[REQUESTS + index * 2u], ticket + 1u);
    atomicStore(&work[REQUESTS + index * 2u + 1u], anchor.sourcePixel + 1u);
  }
}
@compute @workgroup_size(64)
fn fill(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.segment.w || atomicLoad(&work[2u]) != 0u) { return; }
  let probe = settings.segment.z + id.x / DIRECTIONS;
  let p = probe * 40u;
  let mapping = MAPPING + (probe * DIRECTIONS + id.x % DIRECTIONS) * 4u;
  let source_id = atomicLoad(&work[mapping]);
  if (source_id == 0u) { return; }
  let index = source_id - 1u;
  let radiance = textureLoad(source, vec2i(i32(index % settings.extent.z), i32(index / settings.extent.z)), 0);
  if (radiance.w != 1.0) { return; }
  var c: array<vec3f, 4>;
  for (var term = 0u; term < 4u; term++) { c[term] = pv(p + term * 3u); }
  let direction = sample_direction(probe, id.x % DIRECTIONS);
  let prediction = gather_prediction(c, pv(p + 16u), direction);
  let distance = bitcast<f32>(atomicLoad(&work[mapping + 1u]));
  let fade = 1.0 - smoothstep(settings.parameters.x * 0.75, settings.parameters.x, distance);
  let delta = (radiance.xyz - prediction) * fade;
  if (!finite3(delta)) { return; }
  directions[id.x * 2u] = vec4f(delta, 1.0);
  directions[id.x * 2u + 1u] = vec4f(direction, direction_pdf(probe, direction));
}
@compute @workgroup_size(64)
fn project(@builtin(global_invocation_id) id: vec3u) {
  let count = settings.segment.w / DIRECTIONS;
  if (id.x >= count) { return; }
  let probe = settings.segment.z + id.x;
  let at = probe * 40u;
  if (probes[at + 39u] == 0u) { return; }
  var coefficients: array<vec3f, 4>;
  var second = 0.0;
  var accepted = 0.0;
  for (var sample = 0u; sample < DIRECTIONS; sample++) {
    let lane = (id.x * DIRECTIONS + sample) * 2u;
    let delta = directions[lane];
    let d = directions[lane + 1u].xyz;
    let pdf = directions[lane + 1u].w;
    let sh = vec4f(GATHER_Y0, GATHER_Y1 * d);
    // Fixed N, including all missing/unknown/unsupported directions as zero
    // correction. Coverage never renormalizes the estimator.
    for (var term = 0u; term < 4u; term++) {
      if (pdf > 0.0) { coefficients[term] += delta.xyz * sh[term] / (pdf * f32(DIRECTIONS)); }
    }
    second += dot(delta.xyz, delta.xyz) / f32(DIRECTIONS);
    accepted += delta.w;
  }
  for (var term = 0u; term < 4u; term++) {
    coefficients[term] *= select(2.0 * GATHER_PI / 3.0, GATHER_PI, term == 0u);
  }
  let old = probes[at + 37u];
  var count_history = 1.0;
  var variance = second;
  if (old != 0xffffffffu && settings.control.y != 0u) {
    let old_at = old * 40u;
    let old_variance = bitcast<f32>(previous_probes[old_at + 36u]);
    let old_count = bitcast<f32>(previous_probes[old_at + 37u]);
    count_history = min(32.0, old_count + 1.0);
    let alpha = max(settings.parameters.w, 1.0 / count_history);
    var change = 0.0;
    for (var term = 0u; term < 4u; term++) {
      change += dot(coefficients[term] - oldv(old_at + term * 3u), coefficients[term] - oldv(old_at + term * 3u));
    }
    // Signed luminance/SH changes reject stale energy without clipping negative
    // samples or imposing a positive-L0 normalization.
    if (change <= max(1e-8, (second + old_variance) * 16.0)) {
      for (var term = 0u; term < 4u; term++) { coefficients[term] = mix(oldv(old_at + term * 3u), coefficients[term], alpha); }
      variance = mix(old_variance, second + change, alpha);
    } else { count_history = 1.0; }
  }
  for (var term = 0u; term < 4u; term++) { putv(at + term * 3u, coefficients[term]); }
  probes[at + 36u] = bitcast<u32>(variance);
  probes[at + 37u] = bitcast<u32>(count_history);
  let energy = dot(coefficients[0], coefficients[0]);
  let stability = 1.0 / (1.0 + variance / max(1e-6, energy + variance / count_history));
  probes[at + 19u] = bitcast<u32>(min(1.0, count_history / 4.0) * stability * accepted / f32(DIRECTIONS));
}
`;
}
