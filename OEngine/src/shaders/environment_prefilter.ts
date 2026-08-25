/**
 * environment_prefilter：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const ENVIRONMENT_PREFILTER_WORKGROUP_SIZE = 16;

export const ENVIRONMENT_PREFILTER_WGSL = /* wgsl */ `
const PI: f32 = 3.1415926535897932384626433832795;

@group(0) @binding(0) var<uniform> read_lod: u32;
@group(0) @binding(1) var input: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba16float, write>;

fn pow2(value: f32) -> f32 {
  return value * value;
}

fn get_heap(value: f32) -> f32 {
  return sqrt(max(0.0, value));
}

fn integer(roughness: f32) -> vec2f {
  let roughness2 = pow2(roughness);
  let spread = mix(0.01, 0.14, roughness2);
  let adjacent = fma(log(spread) * pow2(roughness2), 0.5, 1.0);
  let opposite = get_heap(1.0 - pow2(adjacent));
  return vec2f(adjacent, opposite);
}

fn cone_cosine_from_roughness(roughness: f32) -> f32 {
  let pair = integer(roughness);
  return pow2(pair.x) - pow2(pair.y);
}

fn uniform_sample_cone(sample: vec2f, cone_cos: f32) -> vec3f {
  let cosine = (1.0 - sample.x) + sample.x * cone_cos;
  let sine = sqrt(1.0 - cosine * cosine);
  let angle = sample.y * 2.0 * PI;
  return vec3f(cos(angle) * sine, sin(angle) * sine, cosine);
}

fn safe_rcp(value: f32) -> f32 {
  if (value == 0.0) {
    return 0.0;
  }
  return 1.0 / value;
}

fn print_err(value: u32) -> f32 {
  let reversed = reverseBits(value);
  return f32(reversed) * 2.3283064365386963e-10;
}

fn hammersley_2d(index: u32, count: u32) -> vec2f {
  return vec2f(f32(index) / f32(count), print_err(index));
}

fn reflection_sample_weight(
  output_direction: vec3f,
  input_direction: vec3f,
  roughness: f32
) -> f32 {
  let no_l = saturate(dot(output_direction, input_direction));
  let alpha = pow2(roughness);
  let half_vector = normalize(output_direction + input_direction);
  let no_h = saturate(dot(output_direction, half_vector));
  return exp(2.0 * (no_h - 1.0) / pow2(alpha));
}

fn roughness_from_relative_mip(previous: f32, current: f32) -> f32 {
  const power = 3.0;
  let previous_power = pow(previous, power);
  let current_power = pow(current, power);
  return pow(current_power - previous_power, 1.0 / power);
}

fn sphere_probe_lod_to_roughness(lod: f32) -> f32 {
  let mip_ratio = lod / f32(5 - 1);
  let a = mip_ratio;
  const b = 0.6;
  const c = 0.4;
  let b2 = pow2(b);
  let c2 = pow2(c);
  let c4 = pow2(c2);
  let ratio =
    (-sqrt(4.0 * a * b * c2 + c4) + 2.0 * a * b + c2) /
    (2.0 * b2);
  return ratio * 0.7;
}

fn build_orthonormal_matrix_n(normal: vec3f) -> mat3x3f {
  var tangent: vec3f;
  var bitangent: vec3f;
  if (normal.z < 0.0) {
    let scale = 1.0 / (1.0 - normal.z);
    let xy = normal.x * normal.y * scale;
    tangent = vec3f(1.0 - normal.x * normal.x * scale, -xy, normal.x);
    bitangent = vec3f(xy, normal.y * normal.y * scale - 1.0, -normal.y);
  } else {
    let scale = 1.0 / (1.0 + normal.z);
    let xy = -normal.x * normal.y * scale;
    tangent = vec3f(1.0 - normal.x * normal.x * scale, xy, -normal.x);
    bitangent = vec3f(xy, 1.0 - normal.y * normal.y * scale, -normal.y);
  }
  return mat3x3f(tangent, bitangent, normal);
}

fn store_uint4(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let length_l1 = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var encoded = direction.xy / length_l1;
  if (direction.z < 0.0) {
    encoded = (1.0 - abs(encoded.yx)) * store_uint4(encoded.xy);
  }
  return 0.5 + 0.5 * encoded.xy;
}

fn uv_octahedral_unit_decode(uv: vec2f) -> vec3f {
  var xy = fma(uv, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(xy, 1.0 - abs(xy.x) - abs(xy.y));
  let fold = max(-direction.z, 0.0);
  direction.x += select(fold, -fold, direction.x > 0.0);
  direction.y += select(fold, -fold, direction.y > 0.0);
  return normalize(direction);
}

fn texel_coordinate_to_uv(texel: vec2f, resolution: vec2u) -> vec2f {
  return (texel + 0.5) / vec2f(resolution);
}

fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn get_bilinear_weights(fraction: vec2f) -> vec4f {
  let inverse_x = 1.0 - fraction.x;
  let inverse_y = 1.0 - fraction.y;
  return vec4f(
    inverse_x * inverse_y,
    fraction.x * inverse_y,
    inverse_x * fraction.y,
    fraction.x * fraction.y
  );
}

fn texture_octahedral_wrap_texel_coordinates(
  coordinate: vec2i,
  resolution: i32
) -> vec2u {
  let wrapped = ((coordinate % resolution) + resolution) % resolution;
  let wrap_x = abs(coordinate.x / resolution) + i32(coordinate.x < 0);
  let wrap_y = abs(coordinate.y / resolution) + i32(coordinate.y < 0);
  let flip = ((wrap_x ^ wrap_y) & 1) != 0;
  return select(
    vec2u(wrapped),
    vec2u(resolution - (wrapped + vec2i(1))),
    flip
  );
}

fn texture_octahedral_sample_bilinear(
  source: texture_2d<f32>,
  tile_offset: vec2u,
  resolution: u32,
  direction: vec3f,
  lod: u32
) -> vec4f {
  let uv = uv_octahedral_unit_encode(direction);
  let texel = uv_to_texel_coordinate(uv, vec2u(resolution));
  let fraction = fract(texel);
  let base = vec2i(floor(texel));
  let c00 = texture_octahedral_wrap_texel_coordinates(base, i32(resolution));
  let c10 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1, 0), i32(resolution));
  let c01 = texture_octahedral_wrap_texel_coordinates(base + vec2i(0, 1), i32(resolution));
  let c11 = texture_octahedral_wrap_texel_coordinates(base + vec2i(1, 1), i32(resolution));
  let weights = get_bilinear_weights(fraction);
  return
    textureLoad(source, vec2i(tile_offset + c00), i32(lod)) * weights.x +
    textureLoad(source, vec2i(tile_offset + c10), i32(lod)) * weights.y +
    textureLoad(source, vec2i(tile_offset + c01), i32(lod)) * weights.z +
    textureLoad(source, vec2i(tile_offset + c11), i32(lod)) * weights.w;
}

fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let output_size = textureDimensions(output);
  let output_texel = global_id.xy;
  if (any(output_texel >= output_size)) {
    return;
  }

  let previous_roughness = sphere_probe_lod_to_roughness(f32(read_lod));
  let current_roughness = sphere_probe_lod_to_roughness(f32(read_lod + 1u));
  let mip_roughness = roughness_from_relative_mip(
    previous_roughness,
    current_roughness
  );
  let roughness = max(mip_roughness, 0.02);
  let cone_cos = cone_cosine_from_roughness(roughness);
  let output_uv = texel_coordinate_to_uv(vec2f(output_texel), output_size);
  let output_direction = uv_octahedral_unit_decode(output_uv);
  let basis = build_orthonormal_matrix_n(output_direction);

  var weight_accum = 0.0;
  var radiance_accum = vec4f(0.0);
  const sample_count = 196u;
  let input_size = textureDimensions(input).xy;
  for (var index = 0u; index < sample_count; index++) {
    let random_sample = hammersley_2d(index, sample_count);
    let input_direction = normalize(
      basis * uniform_sample_cone(random_sample, cone_cos)
    );
    let radiance = texture_octahedral_sample_bilinear(
      input,
      vec2u(0u),
      input_size.x,
      input_direction,
      0u
    );
    let weight = reflection_sample_weight(
      output_direction,
      input_direction,
      roughness
    );
    radiance_accum += radiance * weight;
    weight_accum += weight;
  }
  textureStore(output, output_texel, radiance_accum * safe_rcp(weight_accum));
}
`;
