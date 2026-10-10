import { GPU_INSTANCE_RECORD_WGSL, GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";

/** Epoch-only two-stage bounds reduction. 64 lanes, sequential records per group;
 * no atomics/subgroups. Workgroup barriers order only this group's scratch. */
export const VSM_DEPTH_BOUNDS_WGSL = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
struct BoundsConstants {
  light_view: mat4x4f,
  domain: vec4u, // instance begin/count, group count, projection epoch
}
@group(0) @binding(0) var<uniform> constants: BoundsConstants;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read_write> scratch: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> depth_range: array<vec4f>;
var<workgroup> partial: array<vec4f, 64>;

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
    if (slot >= arrayLength(&instances)) {
      bounds.z = 1.0;
    } else {
      let instance = instances[slot];
      if (oengine_instance_active(instance) && (instance.flags & ${GPU_INSTANCE_FLAGS.CastsShadow}u) != 0u &&
          (instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) == 0u) {
        let transform = constants.light_view * oengine_instance_current_object_to_world(instance);
        let minimum = instance.bounds_min.xyz;
        let maximum = instance.bounds_max.xyz;
        let center = (minimum + maximum) * 0.5;
        let half_extent = (maximum - minimum) * 0.5;
        let light_center = (transform * vec4f(center, 1.0)).z;
        // Exact support of an affine-transformed AABB along the light axis,
        // including shear, negative determinant and nonuniform scale.
        let radius = dot(abs(vec3f(transform[0].z, transform[1].z, transform[2].z)), half_extent);
        if (!all(maximum >= minimum) || !all(abs(minimum) < vec3f(1e19)) ||
            !all(abs(maximum) < vec3f(1e19)) || !(abs(light_center) + abs(radius) < 1e19)) {
          bounds.z = 1.0;
        } else {
          bounds = vec4f(light_center - radius, light_center + radius, 0.0, 1.0);
        }
      }
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
    // Keep all valid caster depths strictly inside [0,1] despite f32 rounding.
    let padding = max(0.01, max(abs(minimum), abs(maximum)) * 1e-5);
    minimum -= padding;
    maximum += padding;
    depth_range[0] = vec4f(minimum, maximum, 1.0 / max(maximum - minimum, 1e-5), select(0.0, 1.0, total.z == 0.0));
  }
}
`;
