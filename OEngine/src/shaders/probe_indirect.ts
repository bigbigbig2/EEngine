/**
 * probe_indirect：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LIGHT_PROBE_RECORD_WGSL } from "../gpu/LightProbeRecord.js";

export const PROBE_INDIRECT_SETTINGS_BYTES = 20;
export const PROBE_INDIRECT_TARGET_FORMAT = "r32uint" as const;

export const PROBE_INDIRECT_WGSL = /* wgsl */ `
${LIGHT_PROBE_RECORD_WGSL}

const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const BVH_NULL_NODE: u32 = 0xffffffffu;
const INVALID_TET: u32 = 1073741823u;

struct ProbeIndirectSettings {
  probe_resolution: u32,
  output_resolution_width: u32,
  probe_index_offset: u32,
  probe_update_count: u32,
  probe_count: u32,
};

struct LpvCoordinate {
  position: vec3f,
  barycentric: vec4f,
  cell: u32,
};

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

@group(0) @binding(0) var<uniform> settings: ProbeIndirectSettings;
@group(0) @binding(1) var segment_height: sampler;
@group(0) @binding(2) var dependencies: texture_2d<f32>;

@group(1) @binding(0) var child_size: texture_2d<f32>;
@group(1) @binding(1) var bias: texture_2d<f32>;
@group(1) @binding(2) var group_size: texture_2d<f32>;
@group(1) @binding(3) var mesh: texture_2d<f32>;
@group(1) @binding(4) var datas: texture_2d<u32>;
@group(1) @binding(5) var cos_zenith_angle: texture_2d<f32>;

@group(2) @binding(0) var<storage, read> c: LpvBvh;
@group(2) @binding(1) var<uniform> lpv_metadata: LightProbeVolumeMetadata;
@group(2) @binding(2) var<storage, read> attr: array<LpvTetra>;
@group(2) @binding(3) var<storage, read> end: array<LightProbeData>;

fn sign_not_zero(value: vec2f) -> vec2f {
  return select(vec2f(-1.0), vec2f(1.0), value > vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let projected = direction.xy /
    (abs(direction.x) + abs(direction.y) + abs(direction.z));
  let folded = (1.0 - abs(projected.yx)) * sign_not_zero(projected);
  return select(projected, folded, direction.z < 0.0) * 0.5 + 0.5;
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn rgbe9995_encode(color: vec3f) -> u32 {
  let maximum = bitcast<f32>(0x477F8000u);
  let minimum = bitcast<f32>(0x37800000u);
  let clamped = clamp(color, vec3f(0.0), vec3f(maximum));
  let largest = max(minimum, max(clamped.x, max(clamped.y, clamped.z)));
  let exponent = bitcast<f32>(
    (bitcast<u32>(largest) + 0x07804000u) & 0x7F800000u
  );
  let mantissa = bitcast<vec3u>(clamped + exponent);
  let packed_exponent = (bitcast<u32>(exponent) << 4u) + 0x10000000u;
  return packed_exponent |
    (mantissa.z << 18u) |
    (mantissa.y << 9u) |
    (mantissa.x & 0x1ffu);
}

fn rgbe9995_decode(packed: u32) -> vec3f {
  let fields = vec4f(
    (vec4u(packed) >> vec4u(0u, 9u, 18u, 27u)) &
      vec4u(0x1ffu, 0x1ffu, 0x1ffu, 0x1fu)
  );
  return fields.rgb * exp2(fields.a - 15.0 - 9.0);
}

fn f32_array_as_vec3(value: array<f32, 3>) -> vec3f {
  return vec3f(value[0], value[1], value[2]);
}

fn grid2d_to_index(position: vec2u, width: u32) -> u32 {
  return position.y * width + position.x;
}

fn index_to_grid2d(index: u32, width: u32) -> vec2u {
  return vec2u(index % width, index / width);
}

fn texel_coordinate_to_uv(position: vec2f, resolution: vec2u) -> vec2f {
  return (position + 0.5) / vec2f(resolution);
}

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn get_bilinear_weights(fraction: vec2f) -> vec4f {
  let inv_x = 1.0 - fraction.x;
  let inv_y = 1.0 - fraction.y;
  return vec4f(
    inv_x * inv_y,
    fraction.x * inv_y,
    inv_x * fraction.y,
    fraction.x * fraction.y
  );
}

fn oct_wrap_coordinate(position: vec2i, resolution: i32) -> vec2u {
  let wrapped = ((position % resolution) + resolution) % resolution;
  let crossings_x = abs(position.x / resolution) + i32(position.x < 0);
  let crossings_y = abs(position.y / resolution) + i32(position.y < 0);
  let flip = ((crossings_x ^ crossings_y) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(resolution - (wrapped + vec2i(1))),
    flip
  );
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
  let uv_oct = uv_octahedral_unit_encode(direction);
  let texel = uv_to_texel_coordinate(uv_oct, vec2u(resolution));
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
    let probe_position = read_probe_position(probe);
    var weight = 1.0;
    let direction = normalize(probe_position - point);
    let normal_weight = max(0.0001, (dot(direction, shading_normal) + 1.0) * 0.5);
    weight *= normal_weight * normal_weight + 0.2;
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
  return max(vec3f(0.0), result);
}

fn sh2_radiance(direction: vec3f, sh: array<vec3f, 4>) -> vec3f {
  var result = sh[0] * 0.28209479177387814;
  result += sh[1] * (0.4886025119029199 * direction.y);
  result += sh[2] * (0.4886025119029199 * direction.z);
  result += sh[3] * (0.4886025119029199 * direction.x);
  return max(vec3f(0.0), result);
}

fn sh2_radiance_ggx(sh: array<vec3f, 4>, direction: vec3f, alpha: f32) -> vec3f {
  let band = 1.66711256633276 / (1.65715038133932 + alpha);
  var filtered = sh;
  filtered[1] *= band;
  filtered[2] *= band;
  filtered[3] *= band;
  return sh2_radiance(direction, filtered);
}

fn ray_sphere_intersection(
  origin: vec3f,
  direction: vec3f,
  center: vec3f,
  radius: f32
) -> vec2f {
  let offset = origin - center;
  let a = dot(direction, direction);
  let b = 2.0 * dot(offset, direction);
  let c_value = dot(offset, offset) - radius * radius;
  let discriminant = fma(b, b, -4.0 * a * c_value);
  if (discriminant < 0.0) {
    return vec2f(-1.0);
  }
  let root = sqrt(discriminant);
  return vec2f(-b - root, -b + root) / (2.0 * a);
}

fn bent_probe_direction(
  point: vec3f,
  direction: vec3f,
  probe_position: vec3f,
  probe_distance: f32,
  probe: u32
) -> vec3f {
  const epsilon = 1e-5;
  var sample_point = point + direction;
  for (var iteration = 0; iteration < 3; iteration++) {
    let to_sample = sample_point - probe_position;
    let sample_distance = length(to_sample);
    let sample_direction = to_sample / max(sample_distance, 0.001);
    let moments = sample_depth_moments(sample_direction, probe);
    let variance = max(epsilon, abs(moments.y - moments.x * moments.x));
    let sigma = sqrt(variance);
    let minimum_distance = max(moments.x - sigma * 0.6, epsilon);
    let radius = minimum_distance * probe_distance;
    let hit = ray_sphere_intersection(point, direction, probe_position, radius).y;
    if (hit < epsilon) {
      break;
    }
    sample_point = point + direction * hit;
  }
  return normalize(sample_point - probe_position);
}

fn sample_probe_radiance(probe: u32, point: vec3f, direction: vec3f) -> vec4f {
  let probe_data = end[probe];
  let bent = bent_probe_direction(
    point,
    direction,
    read_probe_position(probe),
    probe_data.distance_max,
    probe
  );
  var confidence = clamp((dot(direction, bent) + 1.0) * 0.5, 0.0, 1.0);
  confidence = max(1e-7, confidence * confidence);

  let resolution = lpv_metadata.probe_resolution;
  let padded = resolution + 2u;
  let atlas_size = textureDimensions(datas);
  let patches = atlas_size / padded;
  let patch_origin = index_to_grid2d(probe, patches.x) * padded + vec2u(1u);
  let texel = uv_to_texel_coordinate(uv_octahedral_unit_encode(bent), vec2u(resolution));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = rgbe9995_decode(textureLoad(datas, vec2i(patch_origin + oct_wrap_coordinate(base, i32(resolution))), 0).r);
  let c10 = rgbe9995_decode(textureLoad(datas, vec2i(patch_origin + oct_wrap_coordinate(base + vec2i(1, 0), i32(resolution))), 0).r);
  let c01 = rgbe9995_decode(textureLoad(datas, vec2i(patch_origin + oct_wrap_coordinate(base + vec2i(0, 1), i32(resolution))), 0).r);
  let c11 = rgbe9995_decode(textureLoad(datas, vec2i(patch_origin + oct_wrap_coordinate(base + vec2i(1, 1), i32(resolution))), 0).r);
  let radiance = c00 * get_bilinear_weights(fraction).x +
    c10 * get_bilinear_weights(fraction).y +
    c01 * get_bilinear_weights(fraction).z +
    c11 * get_bilinear_weights(fraction).w;
  return vec4f(radiance, confidence);
}

fn interpolate_atlas_radiance(direction: vec3f, coordinate: LpvCoordinate) -> vec3f {
  let vertices = lpv_mesh_get_vertices(coordinate.cell);
  let a = sample_probe_radiance(vertices.x, coordinate.position, direction);
  let b = sample_probe_radiance(vertices.y, coordinate.position, direction);
  let c_value = sample_probe_radiance(vertices.z, coordinate.position, direction);
  let d = sample_probe_radiance(vertices.w, coordinate.position, direction);
  var weights = vec4f(a.w, b.w, c_value.w, d.w) * coordinate.barycentric;
  weights /= dot(weights, vec4f(1.0));
  return a.rgb * weights.x + b.rgb * weights.y + c_value.rgb * weights.z + d.rgb * weights.w;
}

fn roughness_to_mip_ratio(roughness: f32) -> f32 {
  let ratio = clamp(roughness / 0.7, 0.0, 1.0);
  return mix(ratio, sqrt(ratio), 0.4);
}

fn lpv_sample_light(
  coordinate: LpvCoordinate,
  shading_normal: vec3f,
  view_direction: vec3f,
  roughness: f32
) -> mat2x3f {
  let sh = interpolate_probe_sh(coordinate.barycentric, coordinate.cell);
  let alpha = roughness * roughness;
  let irradiance = sh2_irradiance(shading_normal, sh);
  let reflected = reflect(-view_direction, shading_normal);
  let reflection_direction = normalize(mix(reflected, shading_normal, alpha));
  let sh_radiance = sh2_radiance_ggx(sh, reflection_direction, alpha);
  let atlas_radiance = interpolate_atlas_radiance(reflection_direction, coordinate);
  let radiance = mix(atlas_radiance, sh_radiance, roughness_to_mip_ratio(roughness));
  return mat2x3f(irradiance, radiance);
}

fn max_v3(value: vec3f) -> f32 {
  return max(value.x, max(value.y, value.z));
}

fn decode_split_sum(
  value: vec2f,
  specular_f0: vec3f,
  specular_f90: f32,
  single: ptr<function, vec3f>,
  multi: ptr<function, vec3f>
) {
  let combined = specular_f0 * value.x + specular_f90 * value.y;
  let sum = value.x + value.y;
  let remaining = 1.0 - sum;
  let ratio = remaining / max(sum, 1e-4);
  *single += combined;
  *multi += combined * (specular_f0 * ratio);
}

fn compute_indirect_specular(
  radiance: vec3f,
  irradiance: vec3f,
  shading_normal: vec3f,
  view_direction: vec3f,
  diffuse: vec3f,
  specular_f0: vec3f,
  specular_f90: f32,
  roughness: f32
) -> mat2x3f {
  var single = vec3f(0.0);
  var multi = vec3f(0.0);
  let no_v = clamp(dot(shading_normal, view_direction), 0.0, 1.0);
  let split_sum = textureSampleLevel(
    dependencies,
    segment_height,
    vec2f(no_v, roughness),
    0.0
  ).rg;
  decode_split_sum(split_sum, specular_f0, specular_f90, &single, &multi);
  let directional_albedo = single + multi;
  let indirect_specular = radiance * directional_albedo;
  let energy = clamp(vec3f(1.0) - directional_albedo, vec3f(0.0), vec3f(1.0));
  let indirect_diffuse = diffuse * energy * (irradiance * RECIPROCAL_PI);
  return mat2x3f(indirect_specular, indirect_diffuse);
}

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(0.04), albedo, metalness);
}

fn is_nan(value: f32) -> bool {
  return !(value < 0.0 || 0.0 < value || value == 0.0);
}

fn v3_is_nan(value: vec3f) -> vec3<bool> {
  return vec3<bool>(is_nan(value.x), is_nan(value.y), is_nan(value.z));
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
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) u32 {
  let pixel = vec2u(coord.xy);
  let probe_resolution = settings.probe_resolution;
  let probe_coord = pixel / probe_resolution;
  let probe_texel = pixel % probe_resolution;
  _ = probe_texel;
  let local_probe = grid2d_to_index(probe_coord, settings.output_resolution_width);
  if (local_probe >= settings.probe_update_count) {
    return 0u;
  }
  let probe_index = (settings.probe_index_offset + local_probe) % settings.probe_count;
  let probe = end[probe_index];
  let probe_position = f32_array_as_vec3(probe.position);
  let pbr = textureLoad(mesh, vec2i(pixel), 0);
  if (pbr.a == 1.0) {
    return 0u;
  }
  let position_local = textureLoad(child_size, vec2i(pixel), 0).rgb;
  let position_world = probe_position + position_local;
  let shading_normal = uv_octahedral_unit_decode(textureLoad(bias, vec2i(pixel), 0).xy);
  let view_direction = -normalize(position_local);
  var barycentric: vec4f;
  let cell = lpv_mesh_lookup_nearest_cell(position_world, &barycentric);
  let tetra = attr[cell];
  _ = tetra;
  let weights = lpv_mask_weights_by_visibility(
    position_world,
    shading_normal,
    view_direction,
    cell,
    barycentric
  );
  let coordinate = LpvCoordinate(position_world, weights, cell);
  let metalness = pbr.x;
  let roughness = max(pbr.y, 0.02);
  let lpv_data = lpv_sample_light(coordinate, shading_normal, view_direction, roughness);
  let albedo = textureLoad(group_size, vec2i(pixel), 0).rgb;
  let diffuse = albedo * (1.0 - metalness);
  var irradiance = lpv_data[0];
  let radiance = lpv_data[1];
  if (any(v3_is_nan(irradiance))) {
    irradiance = vec3f(0.0);
  }
  irradiance = max(irradiance, vec3f(0.0));
  let indirect = compute_indirect_specular(
    radiance,
    irradiance,
    shading_normal,
    view_direction,
    diffuse,
    metalness_to_specular_color(metalness, albedo),
    1.0,
    roughness
  );
  let total_indirect = (indirect[1] + indirect[0]) * 0.97;
  return rgbe9995_encode(total_indirect);
}
`;
