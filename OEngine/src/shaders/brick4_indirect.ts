/**
 * brick4_indirect：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { GPU_VIEW_TYPE } from "../render/ViewContext.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const BRICK4_INDIRECT_FORMAT = "rgba16float" as const;

export const BRICK4_COMMON_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}

struct Brick4Bounds {
  min: vec3f,
  max: vec3f,
};

struct Brick4LightMapStorage {
  bounds: Brick4Bounds,
  data: array<u32>,
};

struct Brick4Node {
  bounds: Brick4Bounds,
  address: u32,
};

struct Brick4ProbeMeta {
  indices: array<vec4u, 2>,
  weights: array<vec4f, 2>,
};

struct Brick4ProbePair {
  global_indices: vec2u,
  local_indices: vec2u,
  blend: f32,
};

fn saturate_f32(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn saturate_vec3(value: vec3f) -> vec3f {
  return clamp(value, vec3f(0.0), vec3f(1.0));
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

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn decode_g_buffer_roughness(pbr: vec4f) -> f32 {
  return pbr.y;
}

fn decode_g_buffer_metalness(pbr: vec4f) -> f32 {
  return pbr.x;
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn rgbe9995_decode(value: u32) -> vec3f {
  let r = f32(value & 0x1ffu);
  let g = f32((value >> 9u) & 0x1ffu);
  let b = f32((value >> 18u) & 0x1ffu);
  let exponent = f32((value >> 27u) & 0x1fu);
  return vec3f(r, g, b) * exp2(exponent - 24.0);
}

fn brick4_unpack_signed_coefficients(
  packed: vec2u,
  base: f32,
  order: u32,
  l2_scale: f32,
  signed_square: bool,
  l2: bool
) -> array<f32, 9> {
  let denominator = f32((1u << (order - 1u)) - 1u);
  let l1 = select(1.0, 2.0 / 3.0, l2);
  let scale_l1 = base * sqrt(3.0) * l1;
  let scale_l2 = base * sqrt(5.0) * select(1.0, 0.25, l2);
  let scale_l2_cross = base * l2_scale * select(1.0, 0.25, l2);

  var first = vec4f(
    f32(packed.x & 0xffu),
    f32((packed.x >> 8u) & 0xffu),
    f32((packed.x >> 16u) & 0xffu),
    f32(packed.x >> 24u)
  ) / denominator - vec4f(1.0);
  var second = vec4f(
    f32(packed.y & 0xffu),
    f32((packed.y >> 8u) & 0xffu),
    f32((packed.y >> 16u) & 0xffu),
    f32(packed.y >> 24u)
  ) / denominator - vec4f(1.0);
  if (signed_square) {
    first = sign(first) * first * first;
    second = sign(second) * second * second;
  }
  first *= vec4f(scale_l1, scale_l1, scale_l1, scale_l2_cross);
  second *= vec4f(scale_l2_cross, scale_l2, scale_l2_cross, scale_l2_cross);

  var result: array<f32, 9>;
  result[0] = base;
  result[1] = first.x;
  result[2] = first.y;
  result[3] = first.z;
  result[4] = first.w;
  result[5] = second.x;
  result[6] = second.y;
  result[7] = second.z;
  result[8] = second.w;
  return result;
}

fn brick4_load_probe(address: u32) -> array<vec3f, 9> {
  let base = rgbe9995_decode(radiip.data[address]);
  let red = brick4_unpack_signed_coefficients(
    vec2u(radiip.data[address + 1u], radiip.data[address + 2u]),
    base.x,
    8u,
    1.9365,
    true,
    false
  );
  let green = brick4_unpack_signed_coefficients(
    vec2u(radiip.data[address + 3u], radiip.data[address + 4u]),
    base.y,
    8u,
    1.9365,
    true,
    false
  );
  let blue = brick4_unpack_signed_coefficients(
    vec2u(radiip.data[address + 5u], radiip.data[address + 6u]),
    base.z,
    8u,
    1.9365,
    true,
    false
  );
  var result: array<vec3f, 9>;
  for (var coefficient = 0u; coefficient < 9u; coefficient++) {
    result[coefficient] = vec3f(
      red[coefficient],
      green[coefficient],
      blue[coefficient]
    );
  }
  return result;
}

fn brick4_node_by_position(position_ws: vec3f) -> Brick4Node {
  var bounds = radiip.bounds;
  var node_pointer = 0x80000000u;
  for (var depth = 0u; depth < 16u; depth++) {
    if ((node_pointer >> 31u) == 0u) {
      break;
    }
    let node_address = node_pointer & 0x7fffffffu;
    let bounds_size = bounds.max - bounds.min;
    let uvw = saturate_vec3((position_ws - bounds.min) / bounds_size);
    let child_coord_f = floor(uvw * 3.0);
    let child_coord = min(vec3u(child_coord_f), vec3u(2u));
    let child_index = child_coord.x + child_coord.y * 3u + child_coord.z * 9u;
    let address_offset = node_address + 64u;
    let occupancy_low = radiip.data[address_offset];
    let occupancy_high = radiip.data[address_offset + 1u];
    var resident = 0u;
    if (child_index < 32u) {
      resident = occupancy_low & (1u << child_index);
    } else {
      resident = occupancy_high & (1u << (child_index - 32u));
    }
    if (resident == 0u) {
      break;
    }
    node_pointer = radiip.data[address_offset + 2u + child_index];
    let next_min = bounds.min + (child_coord_f / 3.0) * bounds_size;
    let next_max = bounds.min + ((child_coord_f + vec3f(1.0)) / 3.0) * bounds_size;
    bounds.min = next_min;
    bounds.max = next_max;
  }
  return Brick4Node(bounds, node_pointer & 0x7fffffffu);
}

fn brick4_probe_compute_weight_by_normal(
  probe_position: vec3f,
  surface_position: vec3f,
  surface_normal: vec3f
) -> f32 {
  let direction = normalize(probe_position - surface_position);
  let facing = smoothstep(-0.05, 0.05, dot(surface_normal, direction));
  return facing * facing + 1e-4;
}

fn brick4_probe_coord_to_index(coord: vec3u) -> u32 {
  return coord.x + coord.y * 4u + coord.z * 16u;
}

fn brick4_probe_index_to_coord(index: u32) -> vec3u {
  return vec3u(index & 3u, (index >> 2u) & 3u, index >> 4u);
}

fn brick4_node_sample_probes_meta(
  bounds: Brick4Bounds,
  position_ws: vec3f,
  normal_ws: vec3f
) -> Brick4ProbeMeta {
  let size = bounds.max - bounds.min;
  let brick_uvw = saturate_vec3((position_ws - bounds.min) / size);
  let brick_probe_coord = clamp(brick_uvw * 3.0, vec3f(0.0), vec3f(3.0));
  let fraction = fract(brick_probe_coord);
  let base_coord = vec3u(floor(brick_probe_coord));
  var result: Brick4ProbeMeta;
  var weight_sum = 0.0;
  for (var z = 0u; z <= 1u; z++) {
    let wz = select(fraction.z, 1.0 - fraction.z, z == 0u);
    for (var y = 0u; y <= 1u; y++) {
      let wy = select(fraction.y, 1.0 - fraction.y, y == 0u);
      for (var x = 0u; x <= 1u; x++) {
        let wx = select(fraction.x, 1.0 - fraction.x, x == 0u);
        let coord = min(base_coord + vec3u(x, y, z), vec3u(3u));
        let slot = y * 2u + x;
        let local_index = brick4_probe_coord_to_index(coord);
        result.indices[z][slot] = local_index;
        let probe_uvw = vec3f(coord) / 3.0;
        let probe_position = bounds.min + probe_uvw * size;
        var weight = brick4_probe_compute_weight_by_normal(
          probe_position,
          position_ws,
          normal_ws
        );
        weight *= wx * wy * wz;
        result.weights[z][slot] = weight;
        weight_sum += weight;
      }
    }
  }
  result.weights[0] /= weight_sum;
  result.weights[1] /= weight_sum;
  return result;
}

fn sample_discrete_wrs_mat2x4(
  weights: array<vec4f, 2>,
  random_value: ptr<function, f32>
) -> i32 {
  var selected = 0;
  var total = weights[0].x;
  for (var index = 1; index < 8; index++) {
    let value = weights[index >> 2][index & 3];
    total += value;
    let probability = value / total;
    if (*random_value < probability) {
      selected = index;
      *random_value /= probability;
    } else {
      *random_value = (*random_value - probability) / (1.0 - probability);
    }
  }
  return selected;
}

fn brick4_probe_meta_pick2(
  meta: Brick4ProbeMeta,
  node_address: u32,
  noise: vec2f
) -> Brick4ProbePair {
  var random_value = noise.x;
  var weights = meta.weights;
  let sample0 = sample_discrete_wrs_mat2x4(weights, &random_value);
  let weight0 = meta.weights[sample0 >> 2][sample0 & 3];
  weights[sample0 >> 2][sample0 & 3] = 0.0;
  random_value = noise.y;
  let sample1 = sample_discrete_wrs_mat2x4(weights, &random_value);
  var weight1 = weights[sample1 >> 2][sample1 & 3];
  let local0 = meta.indices[sample0 >> 2][sample0 & 3];
  let local1 = meta.indices[sample1 >> 2][sample1 & 3];
  let global0 = radiip.data[node_address + local0];
  let global1 = radiip.data[node_address + local1];
  weight1 /= max(1e-6, weight0 + weight1);
  return Brick4ProbePair(vec2u(global0, global1), vec2u(local0, local1), weight1);
}

fn sh3_color_mix2(
  a: array<vec3f, 9>,
  b: array<vec3f, 9>,
  blend: f32
) -> array<vec3f, 9> {
  var result: array<vec3f, 9>;
  for (var coefficient = 0u; coefficient < 9u; coefficient++) {
    result[coefficient] = mix(a[coefficient], b[coefficient], blend);
  }
  return result;
}

fn sh3_color_estimate_for_cone(
  sh: array<vec3f, 9>,
  cone_cos_theta: f32,
  direction: vec3f
) -> vec3f {
  let x = direction.x;
  let y = direction.y;
  let z = direction.z;
  let c = cone_cos_theta;
  let c2 = c * c;
  let c4 = c2 * c2;
  let l0 = 0.8862269254527579 * (1.0 - c2);
  let l1 = 1.0233267079464885 * (1.0 - c2 * c);
  let l2 = 0.247707956 * (1.0 + 2.0 * c2 - 3.0 * c4);
  var result = sh[0] * l0;
  result += sh[1] * l1 * y;
  result += sh[2] * l1 * z;
  result += sh[3] * l1 * x;
  result += sh[4] * l2 * 3.4641016151377544 * x * y;
  result += sh[5] * l2 * 3.4641016151377544 * y * z;
  result += sh[6] * l2 * (3.0 * z * z - 1.0);
  result += sh[7] * l2 * 3.4641016151377544 * x * z;
  result += sh[8] * l2 * 1.7320508075688772 * (x * x - y * y);
  return max(vec3f(0.0), result);
}

fn sh3_color_get_radiance_with_ggx(
  sh: array<vec3f, 9>,
  direction: vec3f,
  alpha: f32
) -> vec3f {
  let band1 = 1.66711256633276 / (1.65715038133932 + alpha);
  let band2 = 1.56127990596116 / (0.96989757593282 + alpha) - 0.599972342361123;
  let x = direction.x;
  let y = direction.y;
  let z = direction.z;
  var result = sh[0] * 0.28209479177387814;
  result += sh[1] * band1 * (0.4886025119029199 * y);
  result += sh[2] * band1 * (0.4886025119029199 * z);
  result += sh[3] * band1 * (0.4886025119029199 * x);
  result += sh[4] * band2 * (1.0925484305920792 * x * y);
  result += sh[5] * band2 * (1.0925484305920792 * y * z);
  result += sh[6] * band2 * (0.31539156525252005 * (3.0 * z * z - 1.0));
  result += sh[7] * band2 * (1.0925484305920792 * x * z);
  result += sh[8] * band2 * (0.5462742152960396 * (x * x - y * y));
  return max(vec3f(0.0), result);
}

fn stbn_sample_vec2(pixel_frame: vec3u) -> vec2f {
  return textureLoad(replacement, pixel_frame % vec3u(128u, 128u, 64u), 0).rg;
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
`;

export const BRICK4_DIFFUSE_WGSL = /* wgsl */ `
${BRICK4_COMMON_WGSL}

@group(0) @binding(0) var gr_bucket: texture_2d<f32>;
@group(0) @binding(1) var count: texture_2d<u32>;
@group(0) @binding(2) var light_dir: texture_2d<f32>;
@group(0) @binding(3) var replacement: texture_3d<f32>;
@group(0) @binding(4) var<uniform> view: PipelineCacheKey;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
@group(1) @binding(0) var<storage, read> radiip: Brick4LightMapStorage;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let position = project_position_from_depth(
    uv,
    depth,
    camera.view_projection_matrix_inverse
  );
  let normal = decode_g_buffer_normal(textureLoad(count, vec2i(pixel), 0).xy);
  let node = brick4_node_by_position(position);
  let meta = brick4_node_sample_probes_meta(node.bounds, position, normal);
  let noise = stbn_sample_vec2(vec3u(pixel, view.frame_index));
  let pair = brick4_probe_meta_pick2(meta, node.address, noise);
  let sample = sh3_color_mix2(
    brick4_load_probe(pair.global_indices.x),
    brick4_load_probe(pair.global_indices.y),
    pair.blend
  );
  let occlusion = textureLoad(light_dir, vec2i(pixel), 0).a;
  let irradiance = sh3_color_estimate_for_cone(
    sample,
    sqrt(1.0 - occlusion),
    normal
  );
  return vec4f(irradiance, 1.0);
}
`;

export const BRICK4_SPECULAR_WGSL = /* wgsl */ `
${BRICK4_COMMON_WGSL}

@group(0) @binding(0) var gr_bucket: texture_2d<f32>;
@group(0) @binding(1) var chunk_brick4: texture_2d<u32>;
@group(0) @binding(2) var edge: texture_2d<f32>;
@group(0) @binding(3) var replacement: texture_3d<f32>;
@group(0) @binding(4) var<uniform> view: PipelineCacheKey;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
@group(1) @binding(0) var<storage, read> radiip: Brick4LightMapStorage;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let position = project_position_from_depth(
    uv,
    depth,
    camera.view_projection_matrix_inverse
  );
  let view_direction = normalize(camera.transform[3].xyz - position);
  let packed_normals = textureLoad(chunk_brick4, vec2i(pixel), 0);
  let normal = decode_g_buffer_normal(packed_normals.xy);
  let roughness = decode_g_buffer_roughness(textureLoad(edge, vec2i(pixel), 0));
  let alpha = roughness * roughness;
  let reflection = reflect(-view_direction, normal);
  let spec_direction = normalize(mix(reflection, normal, alpha));
  let node = brick4_node_by_position(position);
  let meta = brick4_node_sample_probes_meta(node.bounds, position, normal);
  let pair = brick4_probe_meta_pick2(
    meta,
    node.address,
    stbn_sample_vec2(vec3u(pixel, view.frame_index))
  );
  let sample = sh3_color_mix2(
    brick4_load_probe(pair.global_indices.x),
    brick4_load_probe(pair.global_indices.y),
    pair.blend
  );
  return vec4f(sh3_color_get_radiance_with_ggx(sample, spec_direction, alpha), 1.0);
}
`;

export const BRICK4_FUSED_WGSL = /* wgsl */ `
${BRICK4_COMMON_WGSL}

const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const MIN_DIELECTRICS_F0: f32 = 0.04;

@group(0) @binding(0) var gr_bucket: texture_2d<f32>;
@group(0) @binding(1) var n: texture_2d<u32>;
@group(0) @binding(2) var count: texture_2d<u32>;
@group(0) @binding(3) var radix: texture_2d<f32>;
@group(0) @binding(4) var channel_count: texture_2d<f32>;
@group(0) @binding(5) var replacement: texture_3d<f32>;
@group(0) @binding(6) var<uniform> view: PipelineCacheKey;
@group(0) @binding(7) var<uniform> camera: CommandEncoder;
@group(1) @binding(0) var<storage, read> radiip: Brick4LightMapStorage;
@group(1) @binding(1) var segment_height: sampler;
@group(1) @binding(2) var dependencies: texture_2d<f32>;

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(MIN_DIELECTRICS_F0), albedo, metalness);
}

fn decode_typed_buffer(
  split_sum: vec2f,
  specular_f0: vec3f,
  specular_f90: f32,
  single: ptr<function, vec3f>,
  multi: ptr<function, vec3f>
) {
  let combined = specular_f0 * split_sum.x + specular_f90 * split_sum.y;
  let sum = split_sum.x + split_sum.y;
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
  let no_v = saturate_f32(dot(shading_normal, view_direction));
  let split_sum = textureSampleLevel(
    dependencies,
    segment_height,
    vec2f(no_v, roughness),
    0.0
  ).rg;
  decode_typed_buffer(split_sum, specular_f0, specular_f90, &single, &multi);
  let directional_albedo = single + multi;
  let indirect_specular = radiance * directional_albedo;
  let energy = saturate_vec3(vec3f(1.0) - directional_albedo);
  let indirect_diffuse = diffuse * energy * irradiance * RECIPROCAL_PI;
  return mat2x3f(indirect_specular, indirect_diffuse);
}

fn compute_specular_occlusion_bn(
  spec_direction: vec3f,
  bent_normal: vec3f,
  occlusion: f32,
  roughness: f32
) -> f32 {
  let cone_sin = sqrt(max(0.0, 1.0 - occlusion));
  let cone_cos = sqrt(max(0.0, occlusion));
  let roughness_squared = roughness * roughness;
  let aperture = mix(0.01, 0.14, roughness_squared);
  let cone = fma(log(aperture) * roughness_squared * roughness_squared, 0.5, 1.0);
  let cone_other = sqrt(max(0.0, 1.0 - cone * cone));
  let high = cone_sin * cone + cone_cos * cone_other;
  let low = cone_sin * cone - cone_cos * cone_other;
  return smoothstep(low, high, dot(bent_normal, spec_direction));
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let pbr = textureLoad(channel_count, vec2i(pixel), 0);
  let albedo_ao = textureLoad(radix, vec2i(pixel), 0);
  let normal = decode_g_buffer_normal(textureLoad(n, vec2i(pixel), 0).xy);
  let bent_normal = decode_g_buffer_normal(textureLoad(count, vec2i(pixel), 0).xy);
  let albedo = albedo_ao.rgb;
  let occlusion = albedo_ao.a;
  let metalness = decode_g_buffer_metalness(pbr);
  let roughness = max(decode_g_buffer_roughness(pbr), 0.02);
  let alpha = roughness * roughness;
  let diffuse = albedo * (1.0 - metalness);
  let specular_f0 = metalness_to_specular_color(metalness, albedo);
  let position = project_position_from_depth(
    uv,
    depth,
    camera.view_projection_matrix_inverse
  );
  let view_direction = normalize(camera.transform[3].xyz - position);
  let reflection = reflect(-view_direction, normal);
  let spec_direction = normalize(mix(reflection, normal, alpha));
  let node = brick4_node_by_position(position);
  let meta = brick4_node_sample_probes_meta(node.bounds, position, normal);
  let pair = brick4_probe_meta_pick2(
    meta,
    node.address,
    stbn_sample_vec2(vec3u(pixel, view.frame_index))
  );
  let probe0 = brick4_load_probe(pair.global_indices.x);
  let probe1 = brick4_load_probe(pair.global_indices.y);
  let extent = node.bounds.max - node.bounds.min;
  let position0 = node.bounds.min + vec3f(brick4_probe_index_to_coord(pair.local_indices.x)) * (extent / 3.0);
  let position1 = node.bounds.min + vec3f(brick4_probe_index_to_coord(pair.local_indices.y)) * (extent / 3.0);
  let source0 = brick4_probe_compute_weight_by_normal(position0, position, normal);
  let source1 = brick4_probe_compute_weight_by_normal(position1, position, normal);
  let diffuse0 = brick4_probe_compute_weight_by_normal(position0, position, bent_normal);
  let diffuse1 = brick4_probe_compute_weight_by_normal(position1, position, bent_normal);
  let diffuse_a = (1.0 - pair.blend) * (diffuse0 / source0);
  let diffuse_b = pair.blend * (diffuse1 / source1);
  let diffuse_sample = sh3_color_mix2(
    probe0,
    probe1,
    diffuse_b / max(diffuse_a + diffuse_b, 1e-6)
  );
  let specular0 = brick4_probe_compute_weight_by_normal(position0, position, spec_direction);
  let specular1 = brick4_probe_compute_weight_by_normal(position1, position, spec_direction);
  let specular_a = (1.0 - pair.blend) * (specular0 / source0);
  let specular_b = pair.blend * (specular1 / source1);
  let specular_sample = sh3_color_mix2(
    probe0,
    probe1,
    specular_b / max(specular_a + specular_b, 1e-6)
  );
  let irradiance = sh3_color_estimate_for_cone(
    diffuse_sample,
    sqrt(1.0 - occlusion),
    bent_normal
  );
  let radiance = sh3_color_get_radiance_with_ggx(
    specular_sample,
    spec_direction,
    alpha
  );
  let indirect = compute_indirect_specular(
    radiance,
    irradiance,
    normal,
    view_direction,
    diffuse,
    specular_f0,
    1.0,
    roughness
  );
  let specular_occlusion = compute_specular_occlusion_bn(
    spec_direction,
    bent_normal,
    occlusion,
    roughness
  );
  return vec4f(indirect[0] * specular_occlusion + indirect[1], 1.0);
}
`;
