import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";

/** GPU old/new bounds union. One lane per source slot; exact identity and
 * world bounds, no CPU object scan. Output overflow upgrades to full dirty. */
export const SCGI_INVALIDATION_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
struct Settings {
  count: u32,
  capacity: u32,
  previous_valid: u32,
  material_epoch: u32,
  guard: f32,
  reserved: vec3f,
}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> lineage: array<vec4u>;
@group(0) @binding(2) var<storage, read> previous: array<u32>;
@group(0) @binding(3) var<storage, read_write> next: array<u32>;
@group(0) @binding(4) var<storage, read_write> dirty: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> settings: Settings;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if (slot >= settings.capacity) {
    return;
  }
  let at = slot*32u;
  var record: array<u32, 32>;
  var low = vec3f(3.402823466e38);
  var high = vec3f(-3.402823466e38);
  if (slot<settings.count && (source[slot].flags&1u) != 0u) {
    let item = source[slot];
    let transform = oengine_instance_current_object_to_world(item);
    for (var corner = 0u; corner<8u; corner++) {
      let p = select(item.bounds_min.xyz, item.bounds_max.xyz, vec3u(corner&1u, corner&2u, corner&4u) != vec3u(0u));
      let world = (transform*vec4f(p, 1.0)).xyz;
      low = min(low, world);
      high = max(high, world);
    }
    record[0] = 1u;
    record[1] = item.geometry_record_index;
    record[2] = item.material_handle;
    record[3] = item.flags;
    let identity = lineage[slot];
    for (var i = 0u; i<4u; i++) {
      record[4u+i] = identity[i];
    }
    record[8] = item.dynamic_revision;
    record[9] = item.product_table_slot;
    record[10] = bitcast<u32>(item.bounds_min.w);
    record[11] = settings.material_epoch;
    for (var i = 0u; i<3u; i++) {
      record[12u+i] = bitcast<u32>(low[i]);
      record[16u+i] = bitcast<u32>(high[i]);
    }
    // Rotating/moving inside an unchanged AABB must still invalidate.
    let a = bitcast<vec4u>(item.current_affine_0);
    let b = bitcast<vec4u>(item.current_affine_1);
    let c = bitcast<vec4u>(item.current_affine_2);
    for (var i = 0u; i<4u; i++) {
      record[20u+i] = a[i];
      record[24u+i] = b[i];
      record[28u+i] = c[i];
    }
  }
  var changed = settings.previous_valid == 0u;
  for (var i = 0u; i<32u; i++) {
    changed = changed || record[i] != previous[at+i];
    next[at+i] = record[i];
  }
  let old_active = settings.previous_valid != 0u && previous[at] != 0u;
  if (!changed || (record[0] == 0u && !old_active)) {
    return;
  }
  atomicStore(&dirty[2], 1u);
  if (old_active) {
    let old_low = bitcast<vec3f>(vec3u(previous[at+12u], previous[at+13u], previous[at+14u]));
    let old_high = bitcast<vec3f>(vec3u(previous[at+16u], previous[at+17u], previous[at+18u]));
    low = min(low, old_low);
    high = max(high, old_high);
  }
  low -= vec3f(settings.guard);
  high += vec3f(settings.guard);
  let ticket = atomicAdd(&dirty[0], 1u);
  let invalid_low = any((bitcast<vec3u>(low)&vec3u(0x7f800000u)) == vec3u(0x7f800000u));
  let invalid_high = any((bitcast<vec3u>(high)&vec3u(0x7f800000u)) == vec3u(0x7f800000u));
  if (ticket >= 32u || invalid_low || invalid_high) {
    atomicStore(&dirty[1], 1u);
    return;
  }
  for (var i = 0u; i<3u; i++) {
    atomicStore(&dirty[4u+ticket*8u+i], bitcast<u32>(low[i]));
    atomicStore(&dirty[8u+ticket*8u+i], bitcast<u32>(high[i]));
  }
}
`;
