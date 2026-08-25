/**
 * ssr_resolve_lpv：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";
import { SSR_RESOLVE_WGSL } from "./ssr_resolve.js";

const LPV_BINDINGS_AND_HELPERS = /* wgsl */ `
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

struct LpvCoordinate {
  position: vec3f,
  barycentric: vec4f,
  cell: u32,
};

@group(1) @binding(0) var<storage, read> c: LpvBvh;
@group(1) @binding(1) var<uniform> lpv_metadata: LightProbeVolumeMetadata;
@group(1) @binding(2) var<storage, read> attr: array<LpvTetra>;
@group(1) @binding(3) var<storage, read> end: array<LightProbeData>;
@group(2) @binding(0) var datas: texture_2d<u32>;
@group(2) @binding(1) var cos_zenith_angle: texture_2d<f32>;

fn f32_array_as_vec3(value: array<f32, 3>) -> vec3f {
  return vec3f(value[0], value[1], value[2]);
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
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

fn tetra_barycentric(a: vec3f, b: vec3f, c_value: vec3f, d: vec3f, point: vec3f) -> vec4f {
  let point_a = point - a;
  let point_b = point - b;
  let ba = b - a;
  let ca = c_value - a;
  let da = d - a;
  let cb = c_value - b;
  let db = d - b;
  let inverse = 1.0 / scalar_triple(ba, ca, da);
  let w0 = scalar_triple(point_b, db, cb) * inverse;
  let w1 = scalar_triple(point_a, ca, da) * inverse;
  let w2 = scalar_triple(point_a, da, ba) * inverse;
  return vec4f(w0, w1, w2, 1.0 - w0 - w1 - w2);
}

fn lpv_mesh_get_barycentric_coordinates(cell: u32, point: vec3f) -> vec4f {
  let vertices = lpv_mesh_get_vertices(cell);
  return tetra_barycentric(
    read_probe_position(vertices.x), read_probe_position(vertices.y),
    read_probe_position(vertices.z), read_probe_position(vertices.w), point
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

fn texture_filter_triangles(direction: vec3f, probe: u32) -> vec2f {
  let resolution = lpv_metadata.probe_resolution;
  let padded = resolution + 2u;
  let atlas_size = textureDimensions(cos_zenith_angle);
  let patches = atlas_size / padded;
  let patch_origin = index_to_grid2d(probe, patches.x) * padded + vec2u(1u);
  let texel = uv_to_texel_coordinate(uv_octahedral_unit_encode(direction), vec2u(resolution));
  let atlas_uv = texel_coordinate_to_uv(vec2f(patch_origin) + texel, atlas_size);
  return textureSampleLevel(cos_zenith_angle, segment_height, atlas_uv, 0.0).rg;
}

fn probe_visibility(point: vec3f, probe: u32) -> f32 {
  let probe_data = end[probe];
  let to_point = point - read_probe_position(probe);
  let distance_to_point = length(to_point);
  let moments = texture_filter_triangles(to_point / distance_to_point, probe);
  let variance = max(1e-6, abs(moments.y - moments.x * moments.x));
  let delta = distance_to_point / probe_data.distance_max - moments.x;
  if (delta <= 0.0) { return 1.0; }
  return variance / (variance + delta * delta);
}

fn lpv_mask_weights_by_visibility(
  point: vec3f,
  normal: vec3f,
  view_direction: vec3f,
  cell: u32,
  barycentric: vec4f
) -> vec4f {
  let vertices = lpv_mesh_get_vertices(cell);
  var weights: vec4f;
  var total = 0.0;
  for (var corner = 0u; corner < 4u; corner++) {
    let probe = vertices[corner];
    let probe_data = end[probe];
    let direction = normalize(read_probe_position(probe) - point);
    let facing = max(0.0001, (dot(direction, normal) + 1.0) * 0.5);
    var weight = facing * facing + 0.2;
    let bias_distance = max(probe_data.distance_max * 0.05, 1e-7);
    weight *= probe_visibility(point + mix(normal, view_direction, 0.2) * bias_distance, probe);
    weight = max(1e-6, weight);
    if (weight < 0.2) { weight *= weight * weight * 25.0; }
    weight *= barycentric[corner];
    weights[corner] = weight;
    total += weight;
  }
  if (total > 0.0) { weights /= total; }
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
    result[coefficient] = a[coefficient] * weights.x + b[coefficient] * weights.y +
      c_value[coefficient] * weights.z + d[coefficient] * weights.w;
  }
  return result;
}

fn sh2_irradiance(direction: vec3f, sh: array<vec3f, 4>) -> vec3f {
  var result = sh[0] * 0.8862269254527579;
  result += sh[1] * (1.0233267079464885 * direction.y);
  result += sh[2] * (1.0233267079464885 * direction.z);
  result += sh[3] * (1.0233267079464885 * direction.x);
  return max(vec3f(0.0), result);
}

fn sh2_radiance_ggx(sh: array<vec3f, 4>, direction: vec3f, alpha: f32) -> vec3f {
  let scale = 1.66711256633276 / (1.65715038133932 + alpha);
  var result = sh[0] * 0.28209479177387814;
  result += sh[1] * scale * (0.4886025119029199 * direction.y);
  result += sh[2] * scale * (0.4886025119029199 * direction.z);
  result += sh[3] * scale * (0.4886025119029199 * direction.x);
  return max(vec3f(0.0), result);
}

fn rgbe9995_decode(packed: u32) -> vec3f {
  let fields = vec4f(
    (vec4u(packed) >> vec4u(0u, 9u, 18u, 27u)) &
      vec4u(0x1ffu, 0x1ffu, 0x1ffu, 0x1fu)
  );
  return fields.rgb * exp2(fields.a - 15.0 - 9.0);
}

fn fit_per_sample_point(probe: u32, direction: vec3f) -> vec3f {
  let resolution = lpv_metadata.probe_resolution;
  let padded = resolution + 2u;
  let patch_count = textureDimensions(datas) / padded;
  let patch_origin = index_to_grid2d(probe, patch_count.x) * padded + vec2u(1u);
  let texel = uv_to_texel_coordinate(uv_octahedral_unit_encode(direction), vec2u(resolution));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = texture_octahedral_wrap_texel_coordinates(base, i32(resolution));
  let c10 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1,0), i32(resolution));
  let c01 = texture_octahedral_wrap_texel_coordinates(base + vec2i(0,1), i32(resolution));
  let c11 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1,1), i32(resolution));
  let weights = get_bilinear_weights(fraction);
  return rgbe9995_decode(textureLoad(datas, patch_origin + c00, 0).r) * weights.x +
    rgbe9995_decode(textureLoad(datas, patch_origin + c10, 0).r) * weights.y +
    rgbe9995_decode(textureLoad(datas, patch_origin + c01, 0).r) * weights.z +
    rgbe9995_decode(textureLoad(datas, patch_origin + c11, 0).r) * weights.w;
}

fn ffx_lens_get_spot(origin: vec3f, direction: vec3f, center: vec3f, radius: f32) -> vec2f {
  let offset = origin - center;
  let a = dot(direction, direction);
  let b = 2.0 * dot(offset, direction);
  let c_value = dot(offset, offset) - radius * radius;
  let discriminant = fma(b, b, -4.0 * a * c_value);
  if (discriminant < 0.0) { return vec2f(-1.0); }
  let root = sqrt(discriminant);
  return vec2f(-b - root, -b + root) / (2.0 * a);
}

fn emscripten_get_bent_noh(origin: vec3f, direction: vec3f, probe_position: vec3f, distance_max: f32, probe: u32) -> vec3f {
  const epsilon = 1e-5;
  var point = origin + direction;
  for (var iteration = 0; iteration < 3; iteration++) {
    let delta = point - probe_position;
    let distance = length(delta);
    let sample_direction = delta / max(distance, 0.001);
    let moments = texture_filter_triangles(sample_direction, probe);
    let deviation = sqrt(max(epsilon, abs(moments.y - moments.x * moments.x)));
    let normalized_radius = max(moments.x - deviation * 0.6, epsilon);
    let radius = normalized_radius * distance_max;
    let intersection = ffx_lens_get_spot(origin, direction, probe_position, radius).y;
    if (intersection < epsilon) { break; }
    point = origin + direction * intersection;
  }
  return normalize(point - probe_position);
}

fn lpv_radiance_sample_reflection(probe: u32, origin: vec3f, direction: vec3f) -> vec4f {
  let probe_data = end[probe];
  let bent = emscripten_get_bent_noh(origin, direction, read_probe_position(probe), probe_data.distance_max, probe);
  var weight = saturate((dot(direction, bent) + 1.0) * 0.5);
  weight = max(1e-7, weight * weight);
  return vec4f(fit_per_sample_point(probe, bent), weight);
}

fn lpv_mesh_interpolate_radiance_via_atlas(direction: vec3f, coordinate: LpvCoordinate) -> vec3f {
  let vertices = lpv_mesh_get_vertices(coordinate.cell);
  let a = lpv_radiance_sample_reflection(vertices.x, coordinate.position, direction);
  let b = lpv_radiance_sample_reflection(vertices.y, coordinate.position, direction);
  let c_value = lpv_radiance_sample_reflection(vertices.z, coordinate.position, direction);
  let d = lpv_radiance_sample_reflection(vertices.w, coordinate.position, direction);
  var weights = vec4f(a.w, b.w, c_value.w, d.w) * coordinate.barycentric;
  weights /= dot(weights, vec4f(1.0));
  return a.rgb * weights.x + b.rgb * weights.y + c_value.rgb * weights.z + d.rgb * weights.w;
}

fn roughness_to_mip_ratio(roughness: f32) -> f32 {
  let ratio = saturate(roughness / 0.7);
  return mix(ratio, sqrt(ratio), 0.4);
}

fn lpv_sample_light(coordinate: LpvCoordinate, normal: vec3f, view_direction: vec3f, roughness: f32) -> vec3f {
  let sh = interpolate_probe_sh(coordinate.barycentric, coordinate.cell);
  let alpha = roughness * roughness;
  let reflection = normalize(mix(reflect(-view_direction, normal), normal, alpha));
  let sh_radiance = sh2_radiance_ggx(sh, reflection, alpha);
  let atlas_radiance = lpv_mesh_interpolate_radiance_via_atlas(reflection, coordinate);
  return mix(atlas_radiance, sh_radiance, roughness_to_mip_ratio(roughness));
}

fn lpv_sample_radiance(position: vec3f, normal: vec3f, view_direction: vec3f, roughness: f32) -> vec3f {
  var barycentric: vec4f;
  let cell = lpv_mesh_lookup_nearest_cell(position, &barycentric);
  if (cell == INVALID_TET) { return vec3f(0.0); }
  let weights = lpv_mask_weights_by_visibility(position, normal, view_direction, cell, barycentric);
  return max(vec3f(0.0), lpv_sample_light(LpvCoordinate(position, weights, cell), normal, view_direction, roughness));
}

fn build_skeleton_visualization(position: vec3f, normal: vec3f, view_direction: vec3f) -> vec3f {
  var barycentric: vec4f;
  let cell = lpv_mesh_lookup_nearest_cell(position, &barycentric);
  if (cell == INVALID_TET) { return vec3f(0.0); }
  let weights = lpv_mask_weights_by_visibility(position, normal, view_direction, cell, barycentric);
  return sh2_irradiance(normal, interpolate_probe_sh(weights, cell));
}
`;

const BASE_BINDING_MARKER = "@group(0) @binding(9) var<uniform> camera: CommandEncoder;";
const BASE_FALLBACK = `  let environment = get_ibl_radiance(world_view, normal_world, roughness);
  let resolved = mix(environment, radiance, maximum_confidence);`;
const LPV_FALLBACK = `  let world_start = v3_matrix4_project(start_view, camera.view_matrix_inverse);
  if (coord.x < 0.0) {
    _ = textureLoad(sec_radix_passes, vec2i(0), 0);
  }
  if (hit.confidence > 0.05) {
    let world_hit = v3_matrix4_project(hit_view, camera.view_matrix_inverse);
    let world_ray = normalize(world_hit - world_start);
    let hit_irradiance = build_skeleton_visualization(world_hit, hit_normal_world, world_ray);
    radiance += textureLoad(light_dir, hit.position, 0).rgb * hit_irradiance * RECIPROCAL_PI;
  }
  let lpv_radiance = lpv_sample_radiance(world_start, normal_world, world_view, roughness);
  let resolved = mix(lpv_radiance, radiance, maximum_confidence);`;

export const SSR_LPV_RESOLVE_WGSL = buildLpvResolveShader();

function buildLpvResolveShader(): string {
  const withBindings = SSR_RESOLVE_WGSL.replace(
    BASE_BINDING_MARKER,
    `${BASE_BINDING_MARKER}\n${LPV_BINDINGS_AND_HELPERS}`
  );
  if (withBindings === SSR_RESOLVE_WGSL) {
    throw new Error("SSR LPV resolve: base binding marker not found");
  }
  const withFallback = withBindings.replace(BASE_FALLBACK, LPV_FALLBACK);
  if (withFallback === withBindings) {
    throw new Error("SSR LPV resolve: base fallback marker not found");
  }
  return withFallback;
}
