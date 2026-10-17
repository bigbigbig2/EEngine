import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { SCGI_ABI_WGSL } from "../render/gi/ScgiAbi.js";
import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";

/** Shared affine truth. Bounds are computed once, independent of AS shards. */
export function geometryQueryTransformsWgsl(): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${SCGI_ABI_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> identities: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> output: array<ScgiInstance>;
@group(0) @binding(3) var<storage, read_write> bounds: array<vec4f>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&source)) { return; }
  let instance = source[id.x];
  let lineage = identities[id.x];
  var result: ScgiInstance;
  var low = vec3f(0.0);
  var high = vec3f(0.0);
  var valid = oengine_instance_active(instance) && oengine_instance_virtual_geometry(instance) &&
    lineage.x != 0u && lineage.y == instance.instance_set_generation && lineage.w != 0u;
  if (valid) {
    let model = oengine_instance_current_object_to_world(instance);
    // Invert the normalized linear part. Never normalize an object-space ray
    // direction: affine inversion must preserve its original parametric t.
    let magnitude = max(max(max(abs(model[0].x), abs(model[0].y)), abs(model[0].z)),
      max(max(max(abs(model[1].x), abs(model[1].y)), abs(model[1].z)),
        max(max(abs(model[2].x), abs(model[2].y)), abs(model[2].z))));
    if (magnitude == 0.0) { valid = false; }
    else {
      let a = model[0].xyz / magnitude;
      let b = model[1].xyz / magnitude;
      let c = model[2].xyz / magnitude;
      let r0 = cross(b, c);
      let r1 = cross(c, a);
      let r2 = cross(a, b);
      let determinant = dot(a, r0);
      if (determinant == 0.0) { valid = false; }
      else {
        let inverse = transpose(mat3x3f(r0, r1, r2)) * ((1.0 / determinant) / magnitude);
        let translation = -(inverse * model[3].xyz);
        let affine = array<vec4f, 3>(instance.current_affine_0, instance.current_affine_1, instance.current_affine_2);
        let inverse_affine = array<vec4f, 3>(vec4f(inverse[0], translation.x),
          vec4f(inverse[1], translation.y), vec4f(inverse[2], translation.z));
        for (var column = 0u; column < 3u; column++) {
          for (var row = 0u; row < 4u; row++) {
            result.objectToWorld[column * 4u + row] = affine[column][row];
            result.worldToObject[column * 4u + row] = inverse_affine[column][row];
          }
        }
        low = vec3f(3.402823466e38);
        high = vec3f(-3.402823466e38);
        for (var corner = 0u; corner < 8u; corner++) {
          let position = vec3f(select(instance.bounds_min.x, instance.bounds_max.x, (corner & 1u) != 0u),
            select(instance.bounds_min.y, instance.bounds_max.y, (corner & 2u) != 0u),
            select(instance.bounds_min.z, instance.bounds_max.z, (corner & 4u) != 0u));
          let world = (model * vec4f(position, 1.0)).xyz;
          low = min(low, world);
          high = max(high, world);
        }
        result.slotSetLifetimeRoot = array<u32, 4>(id.x, lineage.x, lineage.y, 0u);
        result.shardGenerationMaskFlags = array<u32, 4>(0u, 0u,
          0xffffffffu, instance.flags);
      }
    }
  }

  if (!valid && oengine_instance_active(instance) && oengine_instance_virtual_geometry(instance)) {
    result.shardGenerationMaskFlags[3] = 0x80000000u;
  }
  // An inverse or transformed corner can overflow even when every source
  // component is finite. Such geometry cannot establish trusted visibility.
  var finite = all((bitcast<vec3u>(low) & vec3u(0x7f800000u)) != vec3u(0x7f800000u)) &&
    all((bitcast<vec3u>(high) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
  for (var word = 0u; word < 12u; word++) {
    finite = finite && (bitcast<u32>(result.worldToObject[word]) & 0x7f800000u) != 0x7f800000u;
  }
  if (!finite) {
    result.shardGenerationMaskFlags[3] = 0x80000000u;
  }
  if ((result.shardGenerationMaskFlags[3] & 0x80000000u) != 0u) {
    // The traversal checks this flag at the leaf. A zero/ordinary AABB could
    // be culled before that check and turn untrusted coverage into a miss.
    low = vec3f(-3.402823466e38);
    high = vec3f(3.402823466e38);
    result.shardGenerationMaskFlags[2] = 0xffffffffu;
  }

  output[id.x] = result;
  bounds[id.x * 2u] = vec4f(low, 0.0);
  bounds[id.x * 2u + 1u] = vec4f(high, 0.0);
}
`;
}

/** Deterministic GPU block compaction. A source-slot window bounds TLAS
 * allocation and traversal scheduling; affine records remain shared globally.
 * Three dispatches publish count, offsets and complete compact primitive facts. */
export function geometryQueryInstancesWgsl(plan: ScgiBvhPlan): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${SCGI_ABI_WGSL}
struct Settings {
  count: u32, product_slot: u32, product_generation: u32, asset_reference: u32,
  first: u32, blocks: u32, reserved: vec2u,
  domain_low: vec4f, domain_high: vec4f,
}
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> instances: array<ScgiInstance>;
@group(0) @binding(3) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> scratch: array<u32>;
const BOUNDS: u32 = ${plan.scratch.ranges.primitiveBounds!.offset / 4}u;
const COUNTS: u32 = ${plan.scratch.ranges.selectionCounts!.offset / 4}u;
const OFFSETS: u32 = ${plan.scratch.ranges.selectionOffsets!.offset / 4}u;
const INPUT: u32 = ${plan.scratch.ranges.input!.offset / 4}u;
var<workgroup> prefix: array<u32, 128>;
fn selected(index: u32) -> bool {
  if (index >= settings.count) { return false; }
  let slot = settings.first + index;
  let item = source[slot];
  let low = bounds[slot * 2u].xyz;
  let high = bounds[slot * 2u + 1u].xyz;
  let in_domain = settings.domain_low.w == 0.0 ||
    (all(high >= settings.domain_low.xyz) && all(low <= settings.domain_high.xyz));
  return in_domain && oengine_instance_active(item) && oengine_instance_virtual_geometry(item) &&
    item.product_table_slot == settings.product_slot &&
    oengine_instance_geometry_generation(item) == settings.product_generation &&
    item.geometry_record_index == settings.asset_reference;
}
@compute @workgroup_size(128)
fn classify(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  prefix[lane] = u32(selected(group.x * 128u + lane));
  workgroupBarrier();
  for (var width = 64u; width > 0u; width >>= 1u) {
    if (lane < width) { prefix[lane] += prefix[lane + width]; }
    workgroupBarrier();
  }
  if (lane == 0u) { scratch[COUNTS + group.x] = prefix[0]; }
}
@compute @workgroup_size(1)
fn offsets() {
  // At most ceil(admitted TLAS capacity/128) block counts, never objects.
  var total = 0u;
  for (var block = 0u; block < settings.blocks; block++) {
    scratch[OFFSETS + block] = total;
    total += scratch[COUNTS + block];
  }
  scratch[INPUT] = total;
}
@compute @workgroup_size(128)
fn scatter(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let index = group.x * 128u + lane;
  let keep = u32(selected(index));
  prefix[lane] = keep;
  workgroupBarrier();
  for (var width = 1u; width < 128u; width <<= 1u) {
    var add = 0u;
    if (lane >= width) { add = prefix[lane - width]; }
    workgroupBarrier();
    prefix[lane] += add;
    workgroupBarrier();
  }
  if (keep == 0u) { return; }
  let slot = settings.first + index;
  let at = BOUNDS + (scratch[OFFSETS + group.x] + prefix[lane] - 1u) * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    scratch[at + axis] = bitcast<u32>(bounds[slot * 2u][axis]);
    scratch[at + 4u + axis] = bitcast<u32>(bounds[slot * 2u + 1u][axis]);
  }
  scratch[at + 3u] = slot;
  scratch[at + 7u] = instances[slot].shardGenerationMaskFlags[2];
}
`;
}
