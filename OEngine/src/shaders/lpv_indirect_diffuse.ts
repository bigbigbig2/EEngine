/**
 * lpv_indirect_diffuse：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { ArrayType, WGSL_mat4x4f, WGSL_vec4f } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";

export const LPV_CAMERA_TYPE = StructType.from(
  {
    transform: WGSL_mat4x4f,
    transform_inverse: WGSL_mat4x4f,
    view_matrix: WGSL_mat4x4f,
    view_matrix_inverse: WGSL_mat4x4f,
    projection_matrix: WGSL_mat4x4f,
    projection_matrix_inverse: WGSL_mat4x4f,
    view_projection_matrix: WGSL_mat4x4f,
    view_projection_matrix_inverse: WGSL_mat4x4f,
    frustum: ArrayType.from(WGSL_vec4f, 6),
    device_depth_to_view_space: WGSL_vec4f
  },
  "CommandEncoder"
).pack();

export const LPV_INDIRECT_DIFFUSE_FORMAT = "rgba16float" as const;

export const LPV_INDIRECT_DIFFUSE_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${LIGHT_PROBE_RECORD_WGSL}

const BVH_NULL_NODE: u32 = 0xffffffffu;
const INVALID_TET: u32 = 1073741823u;

struct LpvTetra {
  vertices: vec4u,
  neighbours: vec4u,
};

struct LpvBvhNode {
  bounds: array<f32, 6>,
  child_1: u32,
  child_2: u32,
};

struct LpvBvh {
  root: u32,
  nodes: array<LpvBvhNode>,
};

@group(0) @binding(0) var<uniform> camera: CommandEncoder;
@group(0) @binding(1) var gr_bucket: texture_2d<f32>;
@group(0) @binding(2) var count: texture_2d<u32>;
@group(0) @binding(3) var radix: texture_2d<f32>;

@group(1) @binding(0) var<storage, read> c: LpvBvh;
@group(1) @binding(1) var<uniform> lpv_metadata: LightProbeVolumeMetadata;
@group(1) @binding(2) var<storage, read> attr: array<LpvTetra>;
@group(1) @binding(3) var<storage, read> end: array<LightProbeData>;

@group(2) @binding(0) var segment_height: sampler;
@group(2) @binding(1) var datas: texture_2d<u32>;
@group(2) @binding(2) var cos_zenith_angle: texture_2d<f32>;

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  let projected = fma(vec2f(encoded) / 65535.0, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x >= 0.0);
  direction.y += select(correction, -correction, direction.y >= 0.0);
  return normalize(direction);
}

fn f32_array_as_vec3(value: array<f32, 3>) -> vec3f {
  return vec3f(value[0], value[1], value[2]);
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}

fn sign_not_zero(value: vec2f) -> vec2f {
  return select(vec2f(-1.0), vec2f(1.0), value > vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let projected = direction.xy /
    (abs(direction.x) + abs(direction.y) + abs(direction.z));
  let folded = (1.0 - abs(projected.yx)) * sign_not_zero(projected);
  return select(projected, folded, direction.z < 0.0) * 0.5 + 0.5;
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn lpv_mesh_get_vertices(cell: u32) -> vec4u {
  return attr[cell].vertices;
}

fn read_probe_position(probe: u32) -> vec3f {
  return f32_array_as_vec3(end[probe].position);
}

fn scalar_triple(a: vec3f, b: vec3f, c_value: vec3f) -> f32 {
  return dot(cross(a, b), c_value);
}

fn tetra_barycentric(
  a: vec3f,
  b: vec3f,
  c_value: vec3f,
  d: vec3f,
  point: vec3f
) -> vec4f {
  let point_a = point - a;
  let point_b = point - b;
  let ba = b - a;
  let ca = c_value - a;
  let da = d - a;
  let cb = c_value - b;
  let db = d - b;
  let denominator = 1.0 / scalar_triple(ba, ca, da);
  let w0 = scalar_triple(point_b, db, cb) * denominator;
  let w1 = scalar_triple(point_a, ca, da) * denominator;
  let w2 = scalar_triple(point_a, da, ba) * denominator;
  return vec4f(w0, w1, w2, 1.0 - w0 - w1 - w2);
}

fn lpv_mesh_get_barycentric_coordinates(cell: u32, point: vec3f) -> vec4f {
  let vertices = lpv_mesh_get_vertices(cell);
  return tetra_barycentric(
    read_probe_position(vertices.x),
    read_probe_position(vertices.y),
    read_probe_position(vertices.z),
    read_probe_position(vertices.w),
    point
  );
}

fn point_in_bounds(bounds: array<f32, 6>, point: vec3f) -> bool {
  return point.x >= bounds[0] && point.x <= bounds[3] &&
    point.y >= bounds[1] && point.y <= bounds[4] &&
    point.z >= bounds[2] && point.z <= bounds[5];
}

fn lpv_mesh_lookup_nearest_cell(point: vec3f, barycentric: ptr<function, vec4f>) -> u32 {
  var stack = array<u32, 32>();
  var node = c.root;
  var stack_pointer = 1u;
  for (; stack_pointer > 0u && stack_pointer <= 32u;) {
    let current = c.nodes[node];
    if (!point_in_bounds(current.bounds, point)) {
      stack_pointer--;
      node = stack[stack_pointer];
      continue;
    }
    if (current.child_1 != BVH_NULL_NODE) {
      node = current.child_1;
      stack[stack_pointer] = current.child_2;
      stack_pointer++;
    } else {
      stack_pointer--;
      node = stack[stack_pointer];
      let cell = current.child_2;
      let weights = lpv_mesh_get_barycentric_coordinates(cell, point);
      if (all(weights >= vec4f(0.0))) {
        *barycentric = weights;
        return cell;
      }
    }
  }
  return INVALID_TET;
}

fn sample_depth_moments(direction: vec3f, probe: u32) -> vec2f {
  let resolution = lpv_metadata.probe_resolution;
  let padded = resolution + 2u;
  let atlas_size = textureDimensions(cos_zenith_angle);
  let patches = atlas_size / padded;
  let patch_origin = index_to_grid2d(probe, patches.x) * padded + vec2u(1u);
  let oct_uv = uv_octahedral_unit_encode(direction);
  let texel = uv_to_texel_coordinate(oct_uv, vec2u(resolution));
  let atlas_uv = texel_coordinate_to_uv(vec2f(patch_origin) + texel, atlas_size);
  return textureSampleLevel(cos_zenith_angle, segment_height, atlas_uv, 0.0).rg;
}

fn probe_visibility(point: vec3f, probe: u32) -> f32 {
  let probe_data = end[probe];
  let to_point = point - read_probe_position(probe);
  let distance_to_point = length(to_point);
  let moments = sample_depth_moments(to_point / distance_to_point, probe);
  let mean = moments.x;
  let variance = max(1e-6, abs(moments.y - mean * mean));
  let normalized_distance = distance_to_point / probe_data.distance_max;
  let delta = normalized_distance - mean;
  if (delta <= 0.0) {
    return 1.0;
  }
  return variance / (variance + delta * delta);
}

fn lpv_mask_weights_by_visibility(
  point: vec3f,
  shading_normal: vec3f,
  view_direction: vec3f,
  cell: u32,
  barycentric: vec4f
) -> vec4f {
  let vertices = lpv_mesh_get_vertices(cell);
  var weights: vec4f;
  var sum = 0.0;
  for (var corner = 0u; corner < 4u; corner++) {
    let probe = vertices[corner];
    let probe_data = end[probe];
    let direction = normalize(read_probe_position(probe) - point);
    let normal_weight = max(0.0001, (dot(direction, shading_normal) + 1.0) * 0.5);
    var weight = normal_weight * normal_weight + 0.2;
    let bias_distance = max(probe_data.distance_max * 0.05, 1e-7);
    let bias_direction = mix(shading_normal, view_direction, 0.2) * bias_distance;
    weight *= probe_visibility(point + bias_direction, probe);
    weight = max(1e-6, weight);
    if (weight < 0.2) {
      weight *= weight * weight * 25.0;
    }
    weight *= barycentric[corner];
    weights[corner] = weight;
    sum += weight;
  }
  if (sum > 0.0) {
    weights /= sum;
  }
  return weights;
}

fn probe_sh(probe: u32) -> array<vec3f, 4> {
  let coefficients = end[probe].coefficients;
  var result: array<vec3f, 4>;
  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    for (var channel = 0u; channel < 3u; channel++) {
      result[coefficient][channel] = coefficients[coefficient * 3u + channel];
    }
  }
  return result;
}

fn interpolate_probe_sh(weights: vec4f, cell: u32) -> array<vec3f, 4> {
  let vertices = lpv_mesh_get_vertices(cell);
  let a = probe_sh(vertices.x);
  let b = probe_sh(vertices.y);
  let c_value = probe_sh(vertices.z);
  let d = probe_sh(vertices.w);
  var result: array<vec3f, 4>;
  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    result[coefficient] = a[coefficient] * weights.x +
      b[coefficient] * weights.y +
      c_value[coefficient] * weights.z +
      d[coefficient] * weights.w;
  }
  return result;
}

fn sh2_irradiance(direction: vec3f, sh: array<vec3f, 4>) -> vec3f {
  var result = sh[0] * 0.8862269254527579;
  result += sh[1] * (1.0233267079464885 * direction.y);
  result += sh[2] * (1.0233267079464885 * direction.z);
  result += sh[3] * (1.0233267079464885 * direction.x);
  return result;
}

fn build_skeleton_visualization(
  point: vec3f,
  shading_normal: vec3f,
  view_direction: vec3f
) -> vec3f {
  var barycentric: vec4f;
  let cell = lpv_mesh_lookup_nearest_cell(point, &barycentric);
  if (cell == INVALID_TET) {
    return vec3f(0.0);
  }
  let weights = lpv_mask_weights_by_visibility(
    point,
    shading_normal,
    view_direction,
    cell,
    barycentric
  );
  return sh2_irradiance(shading_normal, interpolate_probe_sh(weights, cell));
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct FullscreenVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenVertexOutput {
  let ndc = FULLSCREEN_POSITIONS[vertex_index];
  var output: FullscreenVertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let normal = decode_g_buffer_normal(textureLoad(count, vec2i(pixel), 0).rg);
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let position = project_position_from_depth(
    uv,
    depth,
    camera.view_projection_matrix_inverse
  );
  let camera_position = camera.transform[3].xyz;
  let view_direction = normalize(camera_position - position);
  let irradiance = build_skeleton_visualization(position, normal, view_direction);
  let occlusion = textureLoad(radix, vec2i(pixel), 0).a;
  return vec4f(max(vec3f(0.0), irradiance) * occlusion, 0.0);
}
`;
