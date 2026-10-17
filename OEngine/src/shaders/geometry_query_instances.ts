import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { SCGI_ABI_WGSL } from "../render/gi/ScgiAbi.js";
import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";

/** All published slots, including offscreen instances, are considered. Holes
 * remain masked leaves so no CPU-visible compaction count is required. */
export function geometryQueryInstancesWgsl(plan: ScgiBvhPlan): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${SCGI_ABI_WGSL}
struct Settings {
  count: u32,
  product_slot: u32,
  product_generation: u32,
  asset_reference: u32,
  root: u32,
  shard: u32,
  as_generation: u32,
  reserved: u32,
}
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> identities: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> output: array<ScgiInstance>;
@group(0) @binding(4) var<storage, read_write> scratch: array<u32>;
const BOUNDS: u32 = ${plan.scratch.ranges.primitiveBounds!.offset / 4}u;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.count) { return; }
  let instance = source[id.x];
  let lineage = identities[id.x];
  var result: ScgiInstance;
  var low = vec3f(0.0);
  var high = vec3f(0.0);
  var valid = oengine_instance_active(instance) && oengine_instance_virtual_geometry(instance) &&
    instance.product_table_slot == settings.product_slot &&
    oengine_instance_geometry_generation(instance) == settings.product_generation &&
    instance.geometry_record_index == settings.asset_reference &&
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
        result.slotSetLifetimeRoot = array<u32, 4>(id.x, lineage.x, lineage.y, settings.root);
        result.shardGenerationMaskFlags = array<u32, 4>(settings.shard, settings.as_generation,
          0xffffffffu, instance.flags);
      }
    }
  }
  // Relevant singular geometry is explicit untrusted coverage, never a miss.
  if (!valid && oengine_instance_active(instance) &&
      instance.geometry_record_index == settings.asset_reference && instance.product_table_slot == settings.product_slot) {
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
  let at = BOUNDS + id.x * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    scratch[at + axis] = bitcast<u32>(low[axis]);
    scratch[at + 4u + axis] = bitcast<u32>(high[axis]);
  }
  scratch[at + 3u] = id.x;
  scratch[at + 7u] = result.shardGenerationMaskFlags[2];
}
`;
}
