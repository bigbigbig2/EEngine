/**
 * brick4_indirect：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { GPU_VIEW_TYPE } from "../render/ViewContext.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import {
  GPU_SHADING_SURFACE_LITE_WGSL,
  GPU_SHADING_SURFACE_NORMAL_WGSL
} from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_COMPUTE_MATERIAL_ABI_WGSL } from "../gpu/GpuComputeMaterialAbi.js";

export const BRICK4_COMMON_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_VIEW_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_LITE_WGSL}
${GPU_SHADING_SURFACE_NORMAL_WGSL}
${GPU_COMPUTE_MATERIAL_ABI_WGSL}

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

fn decode_surface_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) / OENGINE_SURFACE_NORMAL_MAX_VALUE);
}

fn decode_bent_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
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

fn brick4_receiver_valid(position_ws: vec3f) -> bool {
  return all(position_ws >= radiip.bounds.min) && all(position_ws <= radiip.bounds.max);
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
