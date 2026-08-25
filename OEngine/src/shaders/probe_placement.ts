/**
 * probe_placement：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { RAY_QUERY_WGSL } from "./ray_query.js";

export const PROBE_PLACEMENT_QUERY_RESOURCES_WGSL = /* wgsl */ `
@group(1) @binding(0) var<storage, read> scene_database: array<u32>;
@group(1) @binding(1) var<storage, read> tlas_data: array<u32>;
@group(1) @binding(2) var<storage, read> blas_addresses: array<u32>;
@group(1) @binding(3) var<storage, read> blas_nodes: array<u32>;
@group(1) @binding(4) var<storage, read> geometries: array<u32>;
@group(1) @binding(5) var<storage, read> meshlet_headers: array<u32>;
@group(1) @binding(6) var<storage, read> meshlet_data: array<u32>;
`;

export const PROBE_PLACEMENT_WGSL = /* wgsl */ `
struct ProbePlacementBounds {
  min: vec3f,
  max: vec3f,
};

struct ProbePlacementSettings {
  bounds: ProbePlacementBounds,
  resolution: vec3u,
};

struct ProbePlacementOutput {
  count: atomic<u32>,
  data: array<f32>,
};

@group(0) @binding(0) var<uniform> settings: ProbePlacementSettings;
@group(0) @binding(1) var<storage, read_write> out: ProbePlacementOutput;
${PROBE_PLACEMENT_QUERY_RESOURCES_WGSL}
${RAY_QUERY_WGSL}

fn scene_find_least_occluded_direction(
  position: vec3f,
  max_distance: f32
) -> vec4f {
  var ray: RqRay;
  ray.origin = position;
  ray.tmax = max_distance;

  var longest_distance = 0.0;
  var least_occluded_direction: vec3f;
  const direction_count = 13;

  for (var direction_index = 0; direction_index < direction_count; direction_index++) {
    let direction = rq_sphere_fibonacci_point(
      f32(direction_index),
      f32(direction_count)
    );
    ray.direction = direction;
    let hit = ray_query_nearest(ray);
    if (hit.t > longest_distance) {
      longest_distance = distance(
        ray.origin + ray.direction * hit.t,
        position
      );
      least_occluded_direction = direction;
    }
  }

  return vec4f(least_occluded_direction, longest_distance);
}

fn refine_probe_placement(
  probe_origin: vec3f,
  hit: RqPointHit,
  cell_bounds: ProbePlacementBounds
) -> vec3f {
  let to_hit = hit.position - probe_origin;
  let distance_to_hit = length(to_hit);

  let cell_center = (cell_bounds.max + cell_bounds.min) * 0.5;
  let cell_span = cell_bounds.max - cell_bounds.min;
  let maximum_probe_distance = length(
    cell_span * 0.35355339059327373
  );
  let correction = normalize(to_hit) * (
    distance_to_hit - maximum_probe_distance
  );

  var result = probe_origin;
  if (distance_to_hit > maximum_probe_distance) {
    result = probe_origin + correction;
  } else {
    var ray: RqRay;
    ray.origin = probe_origin;
    ray.direction = hit.normal;
    ray.tmax = maximum_probe_distance;

    let forward_hit = ray_query_nearest(ray);
    var candidate: vec3f;
    if (forward_hit.t < 0.0) {
      candidate = probe_origin + correction;
    } else {
      let forward_position = ray.origin + ray.direction * forward_hit.t;
      let forward_distance = distance(forward_position, probe_origin);
      let available_distance = forward_distance - distance_to_hit;
      var half_available_distance = available_distance * 0.5;
      if (half_available_distance > maximum_probe_distance) {
        half_available_distance = maximum_probe_distance;
      }
      candidate = probe_origin + ray.direction * available_distance * 0.5;
    }

    let candidate_hit = scene_point_query_nearest(
      candidate,
      maximum_probe_distance
    );
    let candidate_distance = distance(candidate_hit.position, candidate);
    if (candidate_distance < distance_to_hit) {
    } else {
      result = candidate;
    }
  }

  return clamp(result, cell_bounds.min, cell_bounds.max);
}

fn attempt_refine_probe_placement(
  output: ptr<function, vec3f>,
  probe_origin: vec3f,
  hit: RqPointHit,
  cell_size: vec3f
) -> bool {
  var probe_position = probe_origin;
  let to_hit = hit.position - probe_origin;
  let cell_bounds = ProbePlacementBounds(
    probe_origin - cell_size * 0.3,
    probe_origin + cell_size * 0.3
  );

  probe_position = refine_probe_placement(
    probe_position,
    hit,
    cell_bounds
  );

  let cell_bounding_sphere_radius = length(cell_size);
  let corrected_hit = scene_point_query_nearest(
    probe_position,
    cell_bounding_sphere_radius
  );
  let new_to_hit = corrected_hit.position - probe_position;

  if (dot(corrected_hit.normal, new_to_hit) > 0.0) {
    return false;
  }

  let new_distance = length(new_to_hit);
  let old_distance = length(to_hit);
  if (
    old_distance < cell_bounding_sphere_radius * 0.2 &&
    new_distance < old_distance
  ) {
    return false;
  }
  if (new_distance < cell_bounding_sphere_radius * 0.05) {
    return false;
  }

  let offset = probe_position - probe_origin;
  var penetration_ray: RqRay;
  penetration_ray.origin = probe_origin;
  penetration_ray.direction = normalize(offset);
  penetration_ray.tmax = length(offset);
  if (ray_query_occluded(penetration_ray)) {
    return false;
  }

  if (
    scene_point_query_is_inside_geometry(
      probe_position,
      length(cell_bounding_sphere_radius)
    )
  ) {
    return false;
  }

  *output = probe_position;
  return true;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  if (any(global_id >= settings.resolution)) {
    return;
  }

  let bounds = settings.bounds;
  let bounds_span = bounds.max - bounds.min;
  let max_coord_i = settings.resolution - 1u;
  let cell_size = bounds_span / vec3f(max_coord_i);
  let cell_bounding_sphere_radius = length(cell_size);
  let probe_origin = vec3f(global_id) * cell_size + bounds.min;
  let hit = scene_point_query_nearest(
    probe_origin,
    cell_bounding_sphere_radius
  );

  if (hit.primitive == 0xFFFFFFFFu) {
    return;
  }

  let to_hit = hit.position - probe_origin;
  if (any(abs(to_hit) > cell_size)) {
    return;
  }

  var probe_position = probe_origin;
  if (any(abs(to_hit) < cell_size * 0.5)) {
    let refinement_succeeded = attempt_refine_probe_placement(
      &probe_position,
      probe_origin,
      hit,
      cell_size
    );
    if (!refinement_succeeded) {
      return;
    }
  }

  if (
    scene_point_query_is_inside_geometry(
      probe_position,
      cell_bounding_sphere_radius * 4.0
    )
  ) {
    return;
  }

  let probe_index = atomicAdd(&out.count, 1u);
  out.data[probe_index * 3u] = probe_position.x;
  out.data[probe_index * 3u + 1u] = probe_position.y;
  out.data[probe_index * 3u + 2u] = probe_position.z;
}
`;
