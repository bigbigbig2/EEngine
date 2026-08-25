/**
 * ray_query：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { MESHLET_READ_WGSL } from "./meshlet_read.js";

export const RAY_QUERY_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
${MESHLET_READ_WGSL}

const RQ_BVH_NULL_NODE: u32 = 0xFFFFFFFFu;
const RQ_GEOMETRY_STRIDE_WORDS: u32 = 16u;
const RQ_GEOMETRY_MESHLETS_ADDRESS_WORD: u32 = 11u;

struct RqBvhNode {
  bounds_min: vec3f,
  bounds_max: vec3f,
  child_1: u32,
  child_2: u32,
};

struct RqRay {
  origin: vec3f,
  direction: vec3f,
  tmax: f32,
};

struct RqHit {
  barycentrics: vec2f,
  triangle: u32,
  geometry: u32,
  instance: u32,
  t: f32,
};

fn rq_load_node(words: ptr<storage, array<u32>, read>, word_offset: u32) -> RqBvhNode {
  var node: RqBvhNode;
  node.bounds_min = vec3f(
    bitcast<f32>((*words)[word_offset]),
    bitcast<f32>((*words)[word_offset + 1u]),
    bitcast<f32>((*words)[word_offset + 2u])
  );
  node.bounds_max = vec3f(
    bitcast<f32>((*words)[word_offset + 3u]),
    bitcast<f32>((*words)[word_offset + 4u]),
    bitcast<f32>((*words)[word_offset + 5u])
  );
  node.child_1 = (*words)[word_offset + 6u];
  node.child_2 = (*words)[word_offset + 7u];
  return node;
}

fn rq_load_tlas_node(index: u32) -> RqBvhNode {
  return rq_load_node(&tlas_data, 1u + index * 8u);
}

fn rq_load_blas_node(index: u32) -> RqBvhNode {
  return rq_load_node(&blas_nodes, index * 8u);
}

fn rq_geometry_meshlets_address(geometry_index: u32) -> u32 {
  return geometries[
    geometry_index * RQ_GEOMETRY_STRIDE_WORDS +
    RQ_GEOMETRY_MESHLETS_ADDRESS_WORD
  ];
}

fn rq_aabb_intersects_ray(
  node: RqBvhNode,
  origin: vec3f,
  direction_rcp: vec3f,
  ray_tmax: f32
) -> bool {
  let t0 = (node.bounds_min - origin) * direction_rcp;
  let t1 = (node.bounds_max - origin) * direction_rcp;
  let near = min(t0, t1);
  let far = max(t0, t1);
  let far_min = min(min(ray_tmax, far.x), min(far.y, far.z));
  let near_max = max(max(0.0, near.x), max(near.y, near.z));
  return far_min >= near_max;
}

fn rq_mat4_inverse(m: mat4x4<f32>) -> mat4x4<f32> {
  let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
  let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
  let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
  let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
  let b00 = a00 * a11 - a01 * a10;
  let b01 = a00 * a12 - a02 * a10;
  let b02 = a00 * a13 - a03 * a10;
  let b03 = a01 * a12 - a02 * a11;
  let b04 = a01 * a13 - a03 * a11;
  let b05 = a02 * a13 - a03 * a12;
  let b06 = a20 * a31 - a21 * a30;
  let b07 = a20 * a32 - a22 * a30;
  let b08 = a20 * a33 - a23 * a30;
  let b09 = a21 * a32 - a22 * a31;
  let b10 = a21 * a33 - a23 * a31;
  let b11 = a22 * a33 - a23 * a32;
  let det = 1.0 / (
    b00 * b11 - b01 * b10 + b02 * b09 +
    b03 * b08 - b04 * b07 + b05 * b06
  );
  return mat4x4<f32>(
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det
  );
}

fn rq_project_point(point: vec3f, transform: mat4x4<f32>) -> vec3f {
  let projected = transform * vec4f(point, 1.0);
  return projected.xyz / projected.w;
}

fn rq_rotate_direction(direction: vec3f, transform: mat4x4<f32>) -> vec3f {
  return normalize(
    transform[0].xyz * direction.x +
    transform[1].xyz * direction.y +
    transform[2].xyz * direction.z
  );
}

fn rq_transform_ray(ray: RqRay, transform: mat4x4<f32>) -> RqRay {
  let new_origin = rq_project_point(ray.origin, transform);
  let new_direction = rq_rotate_direction(ray.direction, transform);
  let new_end = rq_project_point(
    ray.origin + ray.direction * ray.tmax,
    transform
  );
  var out: RqRay;
  out.origin = new_origin;
  out.direction = new_direction;
  out.tmax = distance(new_end, new_origin);
  return out;
}

fn rq_geometry_triangle(
  geometry_index: u32,
  encoded_triangle: u32
) -> MeshletTri {
  let decoded = vec2u(encoded_triangle >> 8u, encoded_triangle & 0xFFu);
  let meshlet_id = rq_geometry_meshlets_address(geometry_index) + decoded.x;
  return read_meshlet_triangle_vertices(meshlet_id, decoded.y);
}

fn rq_triangle_intersection(
  result: ptr<function, vec3f>,
  ray: RqRay,
  a: vec3f,
  b: vec3f,
  c: vec3f
) -> bool {
  let ab = b - a;
  let ac = c - a;
  let p = cross(ray.direction, ac);
  let determinant = dot(ab, p);
  if (abs(determinant) < 1e-6) { return false; }
  let inverse = 1.0 / determinant;
  let t = ray.origin - a;
  let u = dot(t, p) * inverse;
  if (u < 0.0 || u > 1.0) { return false; }
  let q = cross(t, ab);
  let v = dot(ray.direction, q) * inverse;
  if (v < 0.0 || u + v > 1.0) { return false; }
  let distance_to_triangle = dot(ac, q) * inverse;
  if (distance_to_triangle <= 1e-6) { return false; }
  *result = vec3f(u, v, distance_to_triangle);
  return distance_to_triangle < ray.tmax;
}

fn ray_query_blas_nearest(
  ray: RqRay,
  geometry_index: u32,
  stack: ptr<function, array<u32, 32>>,
  stack_top: u32
) -> RqHit {
  let blas_address = blas_addresses[geometry_index];
  var pointer = stack_top + 1u;
  let direction_rcp = 1.0 / ray.direction;
  var best_hit: RqHit;
  best_hit.t = -1.0;
  var local_ray = ray;
  var node_index = 0u;
  for (; pointer > stack_top && pointer <= 32u;) {
    let node = rq_load_blas_node(blas_address + node_index);
    if (!rq_aabb_intersects_ray(node, local_ray.origin, direction_rcp, local_ray.tmax)) {
      pointer--;
      node_index = (*stack)[pointer];
      continue;
    }
    if (node.child_1 != RQ_BVH_NULL_NODE) {
      node_index = node.child_1;
      (*stack)[pointer] = node.child_2;
      pointer++;
    } else {
      pointer--;
      node_index = (*stack)[pointer];
      let triangle = rq_geometry_triangle(geometry_index, node.child_2);
      var triangle_hit: vec3f;
      if (!rq_triangle_intersection(
        &triangle_hit,
        local_ray,
        triangle.pa,
        triangle.pb,
        triangle.pc
      )) {
        continue;
      }
      local_ray.tmax = triangle_hit.z;
      best_hit.t = triangle_hit.z;
      best_hit.barycentrics = triangle_hit.xy;
      best_hit.triangle = node.child_2;
    }
  }
  return best_hit;
}

fn ray_query_nearest(ray: RqRay) -> RqHit {
  var stack = array<u32, 32>();
  var node_index = tlas_data[0];
  var pointer = 1u;
  let direction_rcp = 1.0 / ray.direction;
  var best_hit: RqHit;
  best_hit.t = -1.0;
  var global_ray = ray;
  for (; pointer > 0u && pointer <= 32u;) {
    let bvh_node = rq_load_tlas_node(node_index);
    if (!rq_aabb_intersects_ray(
      bvh_node,
      global_ray.origin,
      direction_rcp,
      global_ray.tmax
    )) {
      pointer--;
      node_index = stack[pointer];
      continue;
    }
    if (bvh_node.child_1 != RQ_BVH_NULL_NODE) {
      node_index = bvh_node.child_1;
      stack[pointer] = bvh_node.child_2;
      pointer++;
    } else {
      pointer--;
      node_index = stack[pointer];
      let mesh_id = bvh_node.child_2;
      let mesh = scene_read_mesh(&scene_database, mesh_id);
      let scene_node = scene_read_node(&scene_database, mesh.node);
      let geometry_id = mesh.geometry;
      let local_ray = rq_transform_ray(
        global_ray,
        rq_mat4_inverse(scene_node.global)
      );
      let hit = ray_query_blas_nearest(
        local_ray,
        geometry_id,
        &stack,
        pointer
      );
      if (hit.t < 0.0) { continue; }
      let local_position = local_ray.origin + local_ray.direction * hit.t;
      let global_position4 = scene_node.global * vec4f(local_position, 1.0);
      let global_position = global_position4.xyz / global_position4.w;
      let hit_distance = distance(global_ray.origin, global_position);
      if (hit_distance >= global_ray.tmax) { continue; }
      global_ray.tmax = hit_distance;
      best_hit = hit;
      best_hit.t = hit_distance;
      best_hit.instance = mesh_id;
      best_hit.geometry = geometry_id;
    }
  }
  return best_hit;
}

fn ray_query_blas_occluded(
  ray: RqRay,
  geometry_index: u32,
  stack: ptr<function, array<u32, 32>>,
  stack_top: u32
) -> bool {
  let blas_address = blas_addresses[geometry_index];
  var pointer = stack_top + 1u;
  var node_index = 0u;
  for (; pointer > stack_top && pointer <= 32u;) {
    let node = rq_load_blas_node(blas_address + node_index);
    if (!rq_aabb_intersects_ray(node, ray.origin, 1.0 / ray.direction, ray.tmax)) {
      pointer--;
      node_index = (*stack)[pointer];
      continue;
    }
    if (node.child_1 != RQ_BVH_NULL_NODE) {
      node_index = node.child_1;
      (*stack)[pointer] = node.child_2;
      pointer++;
    } else {
      pointer--;
      node_index = (*stack)[pointer];
      let triangle = rq_geometry_triangle(geometry_index, node.child_2);
      var triangle_hit: vec3f;
      if (rq_triangle_intersection(
        &triangle_hit,
        ray,
        triangle.pa,
        triangle.pb,
        triangle.pc
      )) {
        return true;
      }
    }
  }
  return false;
}

fn ray_query_occluded(ray: RqRay) -> bool {
  var stack = array<u32, 32>();
  var node_index = tlas_data[0];
  var pointer = 1u;
  for (; (pointer & 31u) != 0u;) {
    let bvh_node = rq_load_tlas_node(node_index);
    if (!rq_aabb_intersects_ray(
      bvh_node,
      ray.origin,
      1.0 / ray.direction,
      ray.tmax
    )) {
      pointer--;
      node_index = stack[pointer];
      continue;
    }
    if (bvh_node.child_1 != RQ_BVH_NULL_NODE) {
      node_index = bvh_node.child_1;
      stack[pointer] = bvh_node.child_2;
      pointer++;
    } else {
      pointer--;
      node_index = stack[pointer];
      let mesh = scene_read_mesh(&scene_database, bvh_node.child_2);
      let scene_node = scene_read_node(&scene_database, mesh.node);
      let local_ray = rq_transform_ray(
        ray,
        rq_mat4_inverse(scene_node.global)
      );
      if (ray_query_blas_occluded(
        local_ray,
        mesh.geometry,
        &stack,
        pointer
      )) {
        return true;
      }
    }
  }
  return false;
}

struct RqPointHit {
  position: vec3f,
  normal: vec3f,
  primitive: u32,
};

fn rq_aabb_distance_sqr_to_point(node: RqBvhNode, position: vec3f) -> f32 {
  let below = node.bounds_min - position;
  let above = position - node.bounds_max;
  let distance_to_box = max(vec3f(0.0), max(below, above));
  return dot(distance_to_box, distance_to_box);
}

fn rq_triangle_face_normal(a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  return normalize(cross(b - a, c - a));
}

fn rq_triangle_closest_barycentric(
  position: vec3f,
  a: vec3f,
  b: vec3f,
  c: vec3f
) -> vec2f {
  let ab = b - a;
  let ac = c - a;
  let ap = position - a;
  let d1 = dot(ab, ap);
  let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) { return vec2f(1.0, 0.0); }

  let bp = position - b;
  let d3 = dot(ab, bp);
  let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) { return vec2f(0.0, 1.0); }

  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    let denominator = d1 - d3;
    if (denominator != 0.0) {
      let v = d1 / denominator;
      return vec2f(1.0 - v, v);
    }
    return vec2f(1.0, 0.0);
  }

  let cp = position - c;
  let d5 = dot(ab, cp);
  let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) { return vec2f(0.0, 0.0); }

  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    let denominator = d2 - d6;
    if (denominator != 0.0) {
      let w = d2 / denominator;
      return vec2f(1.0 - w, 0.0);
    }
    return vec2f(1.0, 0.0);
  }

  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
    let denominator = (d4 - d3) + (d5 - d6);
    if (denominator != 0.0) {
      let w = (d4 - d3) / denominator;
      return vec2f(0.0, 1.0 - w);
    }
    return vec2f(0.0, 0.0);
  }

  let inverse = 1.0 / (va + vb + vc);
  return vec2f(va * inverse, vb * inverse);
}

fn point_query_blas_nearest(
  position: vec3f,
  max_distance: f32,
  geometry_index: u32,
  stack: ptr<function, array<u32, 32>>,
  stack_top: u32
) -> RqPointHit {
  let blas_address = blas_addresses[geometry_index];
  var pointer = stack_top + 1u;
  var node_index = 0u;
  var nearest_distance_sqr = max_distance * max_distance;
  var out: RqPointHit;
  out.primitive = 0xFFFFFFFFu;

  for (; pointer > stack_top && pointer <= 32u;) {
    let node = rq_load_blas_node(blas_address + node_index);
    if (node.child_1 != RQ_BVH_NULL_NODE) {
      let child_1 = rq_load_blas_node(blas_address + node.child_1);
      let child_2 = rq_load_blas_node(blas_address + node.child_2);
      let distance_1 = rq_aabb_distance_sqr_to_point(child_1, position);
      let distance_2 = rq_aabb_distance_sqr_to_point(child_2, position);
      var sorted_children = vec2u(node.child_1, node.child_2);
      var sorted_distances = vec2f(distance_1, distance_2);
      if (distance_2 < distance_1) {
        sorted_children = sorted_children.yx;
        sorted_distances = sorted_distances.yx;
      }
      if (sorted_distances.y < nearest_distance_sqr) {
        node_index = sorted_children.x;
        (*stack)[pointer] = sorted_children.y;
        pointer++;
      } else if (sorted_distances.x < nearest_distance_sqr) {
        node_index = sorted_children.x;
      } else {
        pointer--;
        node_index = (*stack)[pointer];
      }
    } else {
      pointer--;
      node_index = (*stack)[pointer];
      let triangle = rq_geometry_triangle(geometry_index, node.child_2);
      let barycentric = rq_triangle_closest_barycentric(
        position,
        triangle.pa,
        triangle.pb,
        triangle.pc
      );
      let u = barycentric.x;
      let v = barycentric.y;
      let w = 1.0 - u - v;
      let contact = triangle.pa * u + triangle.pb * v + triangle.pc * w;
      let distance_to_triangle = distance(position, contact);
      let distance_sqr = distance_to_triangle * distance_to_triangle;
      if (distance_sqr >= nearest_distance_sqr) { continue; }
      nearest_distance_sqr = distance_sqr;
      out.position = contact;
      out.normal = rq_triangle_face_normal(
        triangle.pa,
        triangle.pb,
        triangle.pc
      );
      out.primitive = node.child_2;
    }
  }
  return out;
}

fn scene_point_query_nearest(
  position: vec3f,
  max_distance: f32
) -> RqPointHit {
  var stack = array<u32, 32>();
  var node_index = tlas_data[0];
  var pointer = 1u;
  var nearest_distance_sqr = max_distance * max_distance;
  var out: RqPointHit;
  out.primitive = 0xFFFFFFFFu;

  for (; pointer > 0u && pointer <= 32u;) {
    let node = rq_load_tlas_node(node_index);
    if (node.child_1 != RQ_BVH_NULL_NODE) {
      let child_1 = rq_load_tlas_node(node.child_1);
      let child_2 = rq_load_tlas_node(node.child_2);
      let distance_1 = rq_aabb_distance_sqr_to_point(child_1, position);
      let distance_2 = rq_aabb_distance_sqr_to_point(child_2, position);
      var sorted_children = vec2u(node.child_1, node.child_2);
      var sorted_distances = vec2f(distance_1, distance_2);
      if (distance_2 < distance_1) {
        sorted_children = sorted_children.yx;
        sorted_distances = sorted_distances.yx;
      }
      if (sorted_distances.y < nearest_distance_sqr) {
        node_index = sorted_children.x;
        stack[pointer] = sorted_children.y;
        pointer++;
      } else if (sorted_distances.x < nearest_distance_sqr) {
        node_index = sorted_children.x;
      } else {
        pointer--;
        node_index = stack[pointer];
      }
    } else {
      pointer--;
      node_index = stack[pointer];
      let mesh_id = node.child_2;
      let mesh = scene_read_mesh(&scene_database, mesh_id);
      let scene_node = scene_read_node(&scene_database, mesh.node);
      let geometry_position = rq_project_point(
        position,
        rq_mat4_inverse(scene_node.global)
      );
      let geometry_hit = point_query_blas_nearest(
        geometry_position,
        3.402823466e+38,
        mesh.geometry,
        &stack,
        pointer
      );
      if (geometry_hit.primitive == 0xFFFFFFFFu) { continue; }
      let world_hit = rq_project_point(geometry_hit.position, scene_node.global);
      let distance_to_mesh = distance(world_hit, position);
      let distance_sqr = distance_to_mesh * distance_to_mesh;
      if (distance_sqr >= nearest_distance_sqr) { continue; }
      nearest_distance_sqr = distance_sqr;
      out.primitive = mesh_id;
      out.normal = rq_rotate_direction(geometry_hit.normal, scene_node.global);
      out.position = world_hit;
    }
  }
  return out;
}

fn rq_sphere_fibonacci_point(index: f32, count: f32) -> vec3f {
  const golden_ratio: f32 = sqrt(5.0) * 0.5 + 0.5;
  let longitude_source = index * (golden_ratio - 1.0);
  let longitude_fraction = longitude_source - fract(longitude_source);
  let angle = 2.0 * 3.141592653589793 * longitude_fraction;
  let z = 1.0 - (2.0 * index + 1.0) / count;
  let radius = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
  return vec3f(cos(angle) * radius, sin(angle) * radius, z);
}

fn scene_point_query_is_inside_geometry(
  position: vec3f,
  max_distance: f32
) -> bool {
  const point_count: i32 = 64;
  var ray: RqRay;
  ray.origin = position;
  ray.tmax = max_distance;
  var backface_count = 0;
  for (var i = 0; i < point_count; i++) {
    ray.direction = rq_sphere_fibonacci_point(f32(i), f32(point_count));
    let hit = ray_query_nearest(ray);
    if (hit.t < 0.0) { continue; }
    let triangle = rq_geometry_triangle(hit.geometry, hit.triangle);
    let normal = rq_triangle_face_normal(
      triangle.pa,
      triangle.pb,
      triangle.pc
    );
    if (dot(normal, ray.direction) > 0.0) { backface_count++; }
  }
  return backface_count >= point_count / 2;
}

fn scene_point_query_volume_sign(
  position: vec3f,
  max_distance: f32
) -> f32 {
  const point_count: i32 = 64;
  const backface_threshold: f32 = 0.6;
  const threshold_count: i32 = i32(
    floor(f32(point_count) * backface_threshold)
  );
  var ray: RqRay;
  ray.origin = position;
  ray.tmax = max_distance;
  var direction_balance = 0;
  for (var i = 0; i < point_count; i++) {
    ray.direction = rq_sphere_fibonacci_point(f32(i), f32(point_count));
    let hit = ray_query_nearest(ray);
    if (hit.t < 0.0) { continue; }
    let triangle = rq_geometry_triangle(hit.geometry, hit.triangle);
    let local_normal = rq_triangle_face_normal(
      triangle.pa,
      triangle.pb,
      triangle.pc
    );
    let mesh = scene_read_mesh(&scene_database, hit.instance);
    let scene_node = scene_read_node(&scene_database, mesh.node);
    let world_normal = rq_rotate_direction(local_normal, scene_node.global);
    if (dot(world_normal, ray.direction) > 0.0) { direction_balance++; }
  }
  return select(1.0, -1.0, direction_balance > threshold_count);
}
`;
