import { SSSR_COMMON_WGSL } from "./sssr_common.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "./native_environment_sample.js";

// AMD MIT: ffx_sssr_intersect.h::SampleGGXVNDF (Heitz 2018).
export const SSSR_VNDF_WGSL = /* wgsl */ `
fn sssr_sample_ggx_vndf(view: vec3f, alpha: f32, random: vec2f) -> vec3f {
  let vh = normalize(vec3f(alpha * view.xy, view.z));
  let lensq = dot(vh.xy, vh.xy);
  var t1 = vec3f(1.0, 0.0, 0.0);
  if (lensq > 0.0) {
    t1 = vec3f(-vh.y, vh.x, 0.0) * inverseSqrt(lensq);
  }
  let t2 = cross(vh, t1);
  let radius = sqrt(random.x);
  let phi = 6.283185307179586 * random.y;
  let a = radius * cos(phi);
  var b = radius * sin(phi);
  let blend = 0.5 * (1.0 + vh.z);
  b = (1.0 - blend) * sqrt(max(0.0, 1.0 - a * a)) + blend * b;
  let nh = a * t1 + b * t2 + sqrt(max(0.0, 1.0 - a * a - b * b)) * vh;
  return normalize(vec3f(alpha * nh.xy, max(0.0, nh.z)));
}
fn sssr_reflection(view: vec3f, normal: vec3f, alpha: f32, random: vec2f) -> vec3f {
  var tangent: vec3f;
  if (abs(normal.z) > 0.0) {
    let k = sqrt(normal.y * normal.y + normal.z * normal.z);
    tangent = vec3f(0.0, -normal.z / k, normal.y / k);
  } else {
    let k = sqrt(normal.x * normal.x + normal.y * normal.y);
    tangent = vec3f(normal.y / k, -normal.x / k, 0.0);
  }
  let bitangent = cross(normal, tangent);
  let local_view = vec3f(dot(tangent, -view), dot(bitangent, -view), dot(normal, -view));
  let micro_normal = sssr_sample_ggx_vndf(local_view, alpha, random);
  let reflected = reflect(-local_view, micro_normal);
  return tangent * reflected.x + bitangent * reflected.y + normal * reflected.z;
}
`;

export const SSSR_INTERSECT_WGSL = /* wgsl */ `
${SSSR_COMMON_WGSL}
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
${SSSR_VNDF_WGSL}
@group(1) @binding(0) var<storage, read> rays: array<vec2u>;
@group(1) @binding(1) var<storage, read> counts: array<u32>;
@group(1) @binding(2) var blue_noise: texture_2d<f32>;
@group(1) @binding(3) var opaque_radiance: texture_2d<f32>;
@group(1) @binding(4) var environment: texture_2d<f32>;
@group(1) @binding(5) var raw: texture_storage_2d<rgba16float, write>;
@group(1) @binding(6) var ray_length: texture_storage_2d<r32float, write>;
@group(1) @binding(7) var<storage, read_write> debug_values: array<f32>;

struct SssrHit {
  position: vec3f,
  valid: u32,
}

// Same half-box progression as the source, with actual NPOT mip dimensions.
// Occupancy cutoff is the declared source option zero: no divergent wave ops.
fn sssr_march(origin: vec3f, direction: vec3f) -> SssrHit {
  var position = origin;
  if (!sssr_finite3(direction) || all(direction.xy == vec2f(0.0))) {
    return SssrHit(position, 0u);
  }
  let floor_offset = select(vec2f(1.0), vec2f(0.0), direction.xy < vec2f(0.0));
  let uv_offset = 0.005 / vec2f(frame.dimensions.xy) *
    select(vec2f(1.0), vec2f(-1.0), direction.xy < vec2f(0.0));
  var dimensions = vec2f(frame.dimensions.xy);
  let initial_plane = (floor(origin.xy * dimensions) + floor_offset) / dimensions + uv_offset;
  var initial_t = vec2f(3.402823466e38);
  if (direction.x != 0.0) {
    initial_t.x = (initial_plane.x - origin.x) / direction.x;
  }
  if (direction.y != 0.0) {
    initial_t.y = (initial_plane.y - origin.y) / direction.y;
  }
  var distance = min(initial_t.x, initial_t.y);
  position = origin + distance * direction;
  var mip = 0;
  for (var iteration = 0u; iteration < frame.capacity.z; iteration++) {
    if (!sssr_finite3(position) || !sssr_inside(position.xy) || position.z < 0.0 || position.z > 1.0) {
      return SssrHit(position, 0u);
    }
    dimensions = vec2f(textureDimensions(depth_hierarchy, mip));
    let cell = position.xy * dimensions;
    let surface_z = textureLoad(depth_hierarchy, vec2i(cell), mip).x;
    let xy_plane = (floor(cell) + floor_offset) / dimensions + uv_offset;
    var intersections = vec3f(3.402823466e38);
    if (direction.x != 0.0) {
      intersections.x = (xy_plane.x - origin.x) / direction.x;
    }
    if (direction.y != 0.0) {
      intersections.y = (xy_plane.y - origin.y) / direction.y;
    }
    if (direction.z < 0.0) {
      intersections.z = (surface_z - origin.z) / direction.z;
    }
    let nearest = min(min(intersections.x, intersections.y), intersections.z);
    let above_surface = surface_z < position.z;
    let skipped_tile = bitcast<u32>(nearest) != bitcast<u32>(intersections.z) && above_surface;
    if (above_surface) {
      distance = nearest;
    }
    position = origin + distance * direction;
    if (skipped_tile) {
      mip = min(mip + 1, i32(frame.dimensions.z));
    } else {
      if (mip == 0) {
        return SssrHit(position, 1u);
      }
      mip--;
    }
  }
  return SssrHit(position, 0u);
}

fn sssr_validate(hit: SssrHit, origin_uv: vec2f, world_direction: vec3f) -> f32 {
  if (hit.valid == 0u || !sssr_finite3(hit.position) || !sssr_inside(hit.position.xy) || hit.position.z < 0.0 || hit.position.z > 1.0) {
    return 0.0;
  }
  let delta = abs(hit.position.xy - origin_uv);
  if (all(delta < 2.0 / vec2f(frame.dimensions.xy))) {
    return 0.0;
  }
  let pixel = vec2u(hit.position.xy * vec2f(frame.dimensions.xy));
  let receiver = sssr_receiver(sssr_index(pixel));
  if ((u32(receiver.baseline.w) & 1u) == 0u || dot(sssr_normalize(receiver.base.xyz), world_direction) > 0.0) {
    return 0.0;
  }
  let z = sssr_depth(vec2i(pixel));
  if (z == 0.0) {
    return 0.0;
  }
  let surface = sssr_unproject(vec3f(hit.position.xy, z), frame.inv_projection);
  let ray_hit = sssr_unproject(hit.position, frame.inv_projection);
  let error_distance = length(surface - ray_hit);
  let fov = 0.05 * vec2f(f32(frame.dimensions.y) / f32(frame.dimensions.x), 1.0);
  let border = smoothstep(vec2f(0.0), fov, hit.position.xy) *
    (1.0 - smoothstep(vec2f(1.0) - fov, vec2f(1.0), hit.position.xy));
  let confidence = 1.0 - smoothstep(0.0, frame.settings.y, error_distance);
  return border.x * border.y * confidence * confidence;
}

fn sssr_store_ray(pixel: vec2u, radiance: vec3f, distance: f32, confidence: f32) {
  if (!sssr_valid_pixel(pixel)) {
    return;
  }
  textureStore(raw, vec2i(pixel), vec4f(sssr_to2020(radiance), 0.0));
  textureStore(ray_length, vec2i(pixel), vec4f(distance));
  if (frame.state.w == 1u && frame.capacity.w == frame.dimensions.w) {
    debug_values[sssr_index(pixel)] = confidence;
  }
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u,
        @builtin(local_invocation_index) lane: u32) {
  let group_index = group.y * groups.x + group.x;
  let ray_groups = counts[0] / 64u + select(0u, 1u, counts[0] % 64u != 0u);
  if (group_index >= ray_groups) {
    return;
  }
  let index = group_index * 64u + lane;
  if (index >= counts[0]) {
    return;
  }
  let ray = rays[index];
  let pixel = vec2u(ray.x % frame.dimensions.x, ray.x / frame.dimensions.x);
  let receiver = sssr_receiver(ray.x);
  let lobe = sssr_lobe(receiver);
  let uv = sssr_uv(vec2i(pixel));
  let origin = vec3f(uv, sssr_depth(vec2i(pixel)));
  let view_origin = sssr_unproject(origin, frame.inv_projection);
  let view_normal = sssr_normalize((frame.view * vec4f(lobe.xyz, 0.0)).xyz);
  let random = textureLoad(blue_noise, vec2i(pixel & vec2u(127u)), 0).xy;
  let reflected = sssr_reflection(normalize(view_origin), view_normal, lobe.w, random);
  let direction = sssr_project(view_origin + reflected, frame.projection) - origin;
  let world_direction = sssr_normalize((frame.inv_view * vec4f(reflected, 0.0)).xyz);
  let hit = sssr_march(origin, direction);
  var confidence = sssr_validate(hit, uv, world_direction);
  var distance = 0.0;
  var hit_radiance = vec3f(0.0);
  if (confidence > 0.0) {
    let world_origin = (frame.inv_view * vec4f(view_origin, 1.0)).xyz;
    let world_hit = sssr_unproject(hit.position, frame.inv_view_projection);
    distance = length(world_hit - world_origin);
    if (!(distance <= 3.402823466e38)) {
      confidence = 0.0;
      distance = 0.0;
    } else {
      hit_radiance = sssr_to709(textureLoad(opaque_radiance,
        vec2i(hit.position.xy * vec2f(frame.dimensions.xy)), 0).rgb);
    }
  }
  let environment_radiance = sample_native_environment_mip(environment, world_direction, 0u) * current_exposure[0];
  let radiance = mix(environment_radiance, hit_radiance, confidence);
  sssr_store_ray(pixel, radiance, distance, confidence);
  if ((ray.y & 1u) != 0u) {
    sssr_store_ray(pixel ^ vec2u(1u, 0u), radiance, distance, confidence);
  }
  if ((ray.y & 2u) != 0u) {
    sssr_store_ray(pixel ^ vec2u(0u, 1u), radiance, distance, confidence);
  }
  if ((ray.y & 4u) != 0u) {
    sssr_store_ray(pixel ^ vec2u(1u, 1u), radiance, distance, confidence);
  }
}
`;
