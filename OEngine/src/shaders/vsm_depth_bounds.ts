import {
  GPU_INSTANCE_RECORD_WGSL,
  GPU_INSTANCE_RECORD_STRIDE,
  GPU_INSTANCE_FLAGS
} from "../gpu/GpuInstanceAbi.js";

export const VSM_CASTER_SNAPSHOT_BYTES = GPU_INSTANCE_RECORD_STRIDE + 16;
export const VSM_CASTER_DAMAGE_RECORD_BYTES = 48;
export const VSM_CASTER_DAMAGE_HEADER_BYTES = 16;
/** Per asset-reference influence record: min xyz, revision, max xyz, flags. */
export const VSM_RESIDENCY_INFLUENCE_WORDS = 8;

// One damage per changed instance. Full identities live in the snapshot,
// independently of motion history and main-view visibility.
export const VSM_CASTER_DAMAGE_WGSL = /* wgsl */ `
struct CasterDamage {
  old_xy: vec4f,
  new_xy: vec4f,
  caster_enabled: vec4u,
}
struct CasterDamages {
  count: atomic<u32>,
  invalid: atomic<u32>,
  all_dirty: atomic<u32>,
  dirty_slots: atomic<u32>,
  records: array<CasterDamage>,
}
`;

/** Change-frame only. Complete caster bounds, snapshot comparison and damage,
 * then separate reduction publication; no cross-workgroup barrier. */
export const VSM_DEPTH_BOUNDS_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${VSM_CASTER_DAMAGE_WGSL}
struct BoundsConstants {
  light_view: mat4x4f,
  domain: vec4u, // instance begin/count, group count, reset snapshot/depth
  control: vec4u, // invalidate MASK, Product header count
}
struct CasterSnapshot {
  instance: OEngineInstanceRecord,
  source: vec4u,
}
struct LightBounds {
  xy: vec4f,
  z: vec2f,
  valid: u32,
  caster_enabled: u32,
}
@group(0) @binding(0) var<uniform> constants: BoundsConstants;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read_write> scratch: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> depth_range: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> snapshots: array<CasterSnapshot>;
@group(0) @binding(5) var<storage, read> sources: array<u32>;
@group(0) @binding(6) var<storage, read_write> damages: CasterDamages;
@group(0) @binding(7) var<storage, read> influences: array<u32>;
var<workgroup> partial: array<vec4f, 64>;

/** Global asset-reference index this instance's source stamp lives at. */
fn source_index(instance: OEngineInstanceRecord) -> u32 {
  if (!oengine_instance_virtual_geometry(instance)) { return 0xffffffffu; }
  let slot = instance.product_table_slot;
  if (slot >= constants.control.y || slot * 4u + 3u >= arrayLength(&sources)) { return 0xffffffffu; }
  let at = slot * 4u;
  let generation = sources[at];
  let begin = sources[at + 1u];
  let offset = sources[at + 2u];
  let count = sources[at + 3u];
  let asset = instance.geometry_record_index;
  if (generation != oengine_instance_geometry_generation(instance) || asset < begin || asset - begin >= count) {
    return 0xffffffffu;
  }
  let index = offset + asset - begin;
  if (index >= arrayLength(&sources)) { return 0xffffffffu; }
  return index;
}
fn source_stamp(instance: OEngineInstanceRecord) -> vec4u {
  let index = source_index(instance);
  if (index == 0xffffffffu) { return vec4u(0u); }
  return vec4u(sources[instance.product_table_slot * 4u], sources[index],
    instance.product_table_slot, instance.geometry_record_index);
}
fn light_bounds_of(instance: OEngineInstanceRecord, minimum: vec3f, maximum: vec3f) -> LightBounds {
  var bound = LightBounds(vec4f(0.0), vec2f(0.0), 1u, 0u);
  let transform = constants.light_view * oengine_instance_current_object_to_world(instance);
  let center = (minimum + maximum) * 0.5;
  let half_extent = (maximum - minimum) * 0.5;
  let light_center = (transform * vec4f(center, 1.0)).xyz;
  // Exact affine support, including shear and negative/nonuniform scale.
  let radius = abs(transform[0].xyz) * half_extent.x +
    abs(transform[1].xyz) * half_extent.y + abs(transform[2].xyz) * half_extent.z;
  if (!all(maximum >= minimum) || !all(abs(minimum) < vec3f(1e19)) ||
      !all(abs(maximum) < vec3f(1e19)) || !all(abs(light_center) + abs(radius) < vec3f(1e19))) {
    bound.valid = 0u;
    return bound;
  }
  bound.xy = vec4f(light_center.xy - radius.xy, light_center.xy + radius.xy);
  bound.z = vec2f(light_center.z - radius.z, light_center.z + radius.z);
  return bound;
}
fn light_bounds(instance: OEngineInstanceRecord) -> LightBounds {
  if (!oengine_instance_active(instance) || (instance.flags & ${GPU_INSTANCE_FLAGS.CastsShadow}u) == 0u ||
      (instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u) {
    return LightBounds(vec4f(0.0), vec2f(0.0), 1u, 0u);
  }
  var bound = light_bounds_of(instance, instance.bounds_min.xyz, instance.bounds_max.xyz);
  bound.caster_enabled = 1u;
  return bound;
}
/** Proven changed light-space XY for a residency change, or a zero/empty span
 * when the refine relation could not be proven and whole-instance damage must
 * stay in force. Word 7 stores the Product generation, so an influence can only
 * match the same Product generation and content revision as the source stamp. */
fn residency_influence_xy(instance: OEngineInstanceRecord, index: u32, stamp: vec4u) -> vec4f {
  if (index == 0xffffffffu) { return vec4f(0.0); }
  let base = index * ${VSM_RESIDENCY_INFLUENCE_WORDS}u;
  if (base + ${VSM_RESIDENCY_INFLUENCE_WORDS}u > arrayLength(&influences)) { return vec4f(0.0); }
  if (influences[base + 7u] != stamp.x || influences[base + 3u] != stamp.y) { return vec4f(0.0); }
  let minimum = vec3f(bitcast<f32>(influences[base]), bitcast<f32>(influences[base + 1u]),
    bitcast<f32>(influences[base + 2u]));
  let maximum = vec3f(bitcast<f32>(influences[base + 4u]), bitcast<f32>(influences[base + 5u]),
    bitcast<f32>(influences[base + 6u]));
  let bound = light_bounds_of(instance, minimum, maximum);
  if (bound.valid == 0u) { return vec4f(0.0); }
  return bound.xy;
}
fn caster_changed(a: OEngineInstanceRecord, b: OEngineInstanceRecord) -> bool {
  let mask = ${GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.AlphaTested | GPU_INSTANCE_FLAGS.DoubleSided | GPU_INSTANCE_FLAGS.Transparent | GPU_INSTANCE_FLAGS.VirtualGeometry}u;
  let masked = ((a.flags | b.flags) & ${GPU_INSTANCE_FLAGS.AlphaTested}u) != 0u;
  return (a.flags & mask) != (b.flags & mask) || a.geometry_record_index != b.geometry_record_index ||
    oengine_instance_geometry_generation(a) != oengine_instance_geometry_generation(b) ||
    a.product_table_slot != b.product_table_slot || a.instance_set_generation != b.instance_set_generation ||
    a.dynamic_revision != b.dynamic_revision || any(a.bounds_min.xyz != b.bounds_min.xyz) ||
    any(a.bounds_max.xyz != b.bounds_max.xyz) || any(a.current_affine_0 != b.current_affine_0) ||
    any(a.current_affine_1 != b.current_affine_1) || any(a.current_affine_2 != b.current_affine_2) ||
    (masked && (a.material_handle != b.material_handle || constants.control.x != 0u));
}
fn combine(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(min(a.x, b.x), max(a.y, b.y), a.z + b.z, a.w + b.w);
}
fn reduce(lane: u32) {
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      partial[lane] = combine(partial[lane], partial[lane + stride]);
    }
    workgroupBarrier();
  }
}
@compute @workgroup_size(64)
fn instance_bounds(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  var bounds = vec4f(1e20, -1e20, 0.0, 0.0);
  if (id.x < constants.domain.y) {
    let slot = constants.domain.x + id.x;
    if (slot >= arrayLength(&instances) || id.x >= arrayLength(&snapshots)) {
      bounds.z = 1.0;
      atomicOr(&damages.invalid, 1u);
    } else {
      let instance = instances[slot];
      let current = light_bounds(instance);
      if (current.valid == 0u) {
          bounds.z = 1.0;
        atomicOr(&damages.invalid, 1u);
      } else if (current.caster_enabled != 0u) {
        bounds = vec4f(current.z, 0.0, 1.0);
      }
      let stamp = source_stamp(instance);
      if (constants.domain.w == 0u) {
        let prior = snapshots[id.x];
        let old = light_bounds(prior.instance);
        if (old.valid == 0u) { atomicOr(&damages.invalid, 1u); }
        let changed = caster_changed(prior.instance, instance);
        let stampChanged = any(prior.source != stamp);
        if ((current.caster_enabled | old.caster_enabled) != 0u && (changed || stampChanged)) {
          var damage_old = old.xy;
          var damage_new = current.xy;
          if (!changed && stampChanged) {
            // Pure residency or content-version change: the rendered geometry
            // changes only where the newly available group and its coarse parents
            // live, not across the whole instance bounds. Without a proven
            // relation the conservative whole-instance damage stays in force.
            let tight = residency_influence_xy(instance, source_index(instance), stamp);
            if (tight.z > tight.x && tight.w > tight.y) {
              damage_old = tight;
              damage_new = tight;
            }
          }
          let ticket = atomicAdd(&damages.count, 1u);
          if (ticket < arrayLength(&damages.records)) {
            damages.records[ticket] = CasterDamage(damage_old, damage_new, vec4u(old.caster_enabled, current.caster_enabled, 0u, 0u));
          } else { atomicOr(&damages.invalid, 2u); }
        }
      }
      snapshots[id.x] = CasterSnapshot(instance, stamp);
    }
  }
  partial[lane] = bounds;
  reduce(lane);
  if (lane == 0u) {
    scratch[group.x] = partial[0];
  }
}
@compute @workgroup_size(64)
fn publish_depth(@builtin(local_invocation_index) lane: u32) {
  var bounds = vec4f(1e20, -1e20, 0.0, 0.0);
  for (var index = lane; index < constants.domain.z; index += 64u) {
    bounds = combine(bounds, scratch[index]);
  }
  partial[lane] = bounds;
  reduce(lane);
  if (lane == 0u) {
    let total = partial[0];
    var minimum = select(-0.5, total.x, total.w > 0.0);
    var maximum = select(0.5, total.y, total.w > 0.0);
    let padding = max(0.01, max(abs(minimum), abs(maximum)) * 1e-5);
    minimum -= padding;
    maximum += padding;
    let prior = depth_range[0];
    let reset = constants.domain.w != 0u;
    let invalid = total.z != 0.0 || atomicLoad(&damages.invalid) != 0u;
    // Enclosed content changes keep cached reverse depth byte-for-byte. An
    // expansion revokes ALL ready content before any new depth consumer.
    if (reset || invalid || prior.w == 0.0 || minimum < prior.x || maximum > prior.y) {
      if (!reset && prior.w != 0.0) {
        minimum = min(minimum, prior.x);
        maximum = max(maximum, prior.y);
      }
      depth_range[0] = vec4f(minimum, maximum, 1.0 / max(maximum - minimum, 1e-5), select(1.0, 0.0, invalid));
      atomicStore(&damages.all_dirty, 1u);
    }
  }
}
`;
