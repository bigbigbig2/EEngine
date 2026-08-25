/**
 * visibility_cull_common：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const VISIBILITY_CULL_COMMON_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${SCENE_DATABASE_READ_WGSL}

struct VisibilityCullAabb {
  min: vec3f,
  max: vec3f,
};

struct VisibilityCullMeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
};

fn visibility_array_to_aabb3(source: array<f32, 6>) -> VisibilityCullAabb {
  return VisibilityCullAabb(
    vec3f(source[0], source[1], source[2]),
    vec3f(source[3], source[4], source[5])
  );
}

fn visibility_aabb3_project(
  aabb: VisibilityCullAabb,
  transform: mat4x4f
) -> VisibilityCullAabb {
  var result = VisibilityCullAabb(transform[3].xyz, transform[3].xyz);
  for (var column = 0; column < 3; column++) {
    for (var row = 0; row < 3; row++) {
      let coefficient = transform[column][row];
      let a = coefficient * aabb.min[column];
      let b = coefficient * aabb.max[column];
      result.min[row] += min(a, b);
      result.max[row] += max(a, b);
    }
  }
  return result;
}

fn visibility_aabb3_below_plane(
  aabb: VisibilityCullAabb,
  plane: vec4f
) -> bool {
  let far_corner = select(aabb.min, aabb.max, plane.xyz > vec3f(0.0));
  return dot(far_corner, plane.xyz) < -plane.w;
}

fn visibility_aabb3_intersects_frustum(
  aabb: VisibilityCullAabb,
  frustum: array<vec4f, 6>
) -> bool {
  for (var plane_index = 0; plane_index < 6; plane_index++) {
    if (visibility_aabb3_below_plane(aabb, frustum[plane_index])) {
      return false;
    }
  }
  return true;
}

fn visibility_aabb3_project_perspective(
  output: ptr<function, VisibilityCullAabb>,
  aabb: VisibilityCullAabb,
  transform: mat4x4f
) -> bool {
  let p000 = transform * vec4f(aabb.min, 1.0);
  if (p000.w < 0.0) { return false; }
  var minimum = p000.xyz / p000.w;
  var maximum = minimum;

  let p001 = transform * vec4f(aabb.min.xy, aabb.max.z, 1.0);
  if (p001.w < 0.0) { return false; }
  minimum = min(minimum, p001.xyz / p001.w);
  maximum = max(maximum, p001.xyz / p001.w);

  let p010 = transform * vec4f(aabb.min.x, aabb.max.y, aabb.min.z, 1.0);
  if (p010.w < 0.0) { return false; }
  minimum = min(minimum, p010.xyz / p010.w);
  maximum = max(maximum, p010.xyz / p010.w);

  let p011 = transform * vec4f(aabb.min.x, aabb.max.yz, 1.0);
  if (p011.w < 0.0) { return false; }
  minimum = min(minimum, p011.xyz / p011.w);
  maximum = max(maximum, p011.xyz / p011.w);

  let p100 = transform * vec4f(aabb.max.x, aabb.min.yz, 1.0);
  if (p100.w < 0.0) { return false; }
  minimum = min(minimum, p100.xyz / p100.w);
  maximum = max(maximum, p100.xyz / p100.w);

  let p101 = transform * vec4f(aabb.max.x, aabb.min.y, aabb.max.z, 1.0);
  if (p101.w < 0.0) { return false; }
  minimum = min(minimum, p101.xyz / p101.w);
  maximum = max(maximum, p101.xyz / p101.w);

  let p110 = transform * vec4f(aabb.max.xy, aabb.min.z, 1.0);
  if (p110.w < 0.0) { return false; }
  minimum = min(minimum, p110.xyz / p110.w);
  maximum = max(maximum, p110.xyz / p110.w);

  let p111 = transform * vec4f(aabb.max, 1.0);
  if (p111.w < 0.0) { return false; }
  minimum = min(minimum, p111.xyz / p111.w);
  maximum = max(maximum, p111.xyz / p111.w);

  (*output).min = minimum;
  (*output).max = maximum;
  return true;
}

fn visibility_ndc_to_uv(position: vec2f) -> vec2f {
  return fma(position, vec2f(0.5, -0.5), vec2f(0.5));
}

fn visibility_uv_to_texel_coordinate(
  uv: vec2f,
  resolution: vec2u
) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn visibility_min4(a: f32, b: f32, c: f32, d: f32) -> f32 {
  return min(min(a, b), min(c, d));
}

fn visibility_query_depth_from_screen_space_bb(
  bounds: VisibilityCullAabb,
  hzb: texture_2d<f32>
) -> f32 {
  let uv_min = saturate(visibility_ndc_to_uv(bounds.min.xy));
  let uv_max = saturate(visibility_ndc_to_uv(bounds.max.xy));
  let span = abs(uv_max - uv_min) * vec2f(textureDimensions(hzb));
  let maximum_span = max(span.x, span.y);
  let level_count = textureNumLevels(hzb);
  let level = min(
    u32(ceil(log2(max(maximum_span, 1.0)))),
    level_count - 1u
  );
  let level_size = textureDimensions(hzb) >> vec2u(level);
  let minimum_texel = vec2u(
    visibility_uv_to_texel_coordinate(uv_min, level_size)
  );
  let maximum_texel = vec2u(
    visibility_uv_to_texel_coordinate(uv_max, level_size)
  );
  let corner_10 = vec2u(maximum_texel.x, minimum_texel.y);
  let corner_01 = vec2u(minimum_texel.x, maximum_texel.y);
  let depth_00 = textureLoad(hzb, minimum_texel, level).x;
  let depth_10 = textureLoad(hzb, corner_10, level).x;
  let depth_01 = textureLoad(hzb, corner_01, level).x;
  let depth_11 = textureLoad(hzb, maximum_texel, level).x;
  let nearest_depth = visibility_min4(
    depth_00,
    depth_10,
    depth_01,
    depth_11
  );
  return bounds.max.z - nearest_depth;
}

fn visibility_aabb2_clip_overlaps_texel_centers(
  minimum: vec2f,
  maximum: vec2f,
  resolution: vec2u
) -> bool {
  let corner_10 = vec2f(minimum.x, maximum.y);
  let corner_01 = vec2f(maximum.x, minimum.y);
  let texel_10 = visibility_uv_to_texel_coordinate(
    visibility_ndc_to_uv(corner_10),
    resolution
  );
  let texel_01 = visibility_uv_to_texel_coordinate(
    visibility_ndc_to_uv(corner_01),
    resolution
  );
  let centered_10 = floor(texel_10) + vec2f(0.5);
  return all(centered_10 < texel_01);
}
`;
