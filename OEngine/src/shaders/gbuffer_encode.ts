/**
 * gbuffer_encode：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const GBUFFER_ENCODE_WGSL = /* wgsl */ `
fn store_uint4(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn uv_octahedral_unit_encode(value: vec3f) -> vec2f {
  let denominator = abs(value.x) + abs(value.y) + abs(value.z);
  var encoded = value.xy / denominator;
  if (value.z < 0.0) {
    encoded = (1.0 - abs(encoded.yx)) * store_uint4(encoded.xy);
  }
  return 0.5 + 0.5 * encoded.xy;
}

fn encode_g_buffer_normal(normal: vec3f) -> vec2u {
  return vec2u(uv_octahedral_unit_encode(normal) * 65535.0);
}

fn uv_octahedral_unit_decode(value: vec2f) -> vec3f {
  let signed_value = fma(value, vec2f(2.0), vec2f(-1.0));
  var normal = vec3f(
    signed_value,
    1.0 - abs(signed_value.x) - abs(signed_value.y)
  );
  let correction = max(-normal.z, 0.0);
  normal.x += select(correction, -correction, normal.x > 0.0);
  normal.y += select(correction, -correction, normal.y > 0.0);
  return normalize(normal);
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn rgbe9995_encode(rgb: vec3f) -> u32 {
  let max_range = bitcast<f32>(0x477F8000u);
  let min_range = bitcast<f32>(0x37800000u);
  let clamped = clamp(rgb, vec3f(0.0), vec3f(max_range));
  let maximum = max(min_range, max(clamped.x, max(clamped.y, clamped.z)));
  let exponent = bitcast<f32>((bitcast<u32>(maximum) + 0x07804000u) & 0x7F800000u);
  let mantissas = bitcast<vec3u>(clamped + exponent);
  let packed_exponent = (bitcast<u32>(exponent) << 4u) + 0x10000000u;
  return packed_exponent |
    (mantissas.b << 18u) |
    (mantissas.g << 9u) |
    (mantissas.r & 0x1ffu);
}

fn rgbe9995_decode(value: u32) -> vec3f {
  let components = vec4f(
    (vec4u(value) >> vec4u(0u, 9u, 18u, 27u)) &
      vec4u(0x1ffu, 0x1ffu, 0x1ffu, 0x1fu)
  );
  return components.rgb * exp2(components.a - 15.0 - 9.0);
}

fn decode_g_buffer_metalness(pbr: vec4f) -> f32 {
  return pbr.x;
}

fn decode_g_buffer_roughness(pbr: vec4f) -> f32 {
  return pbr.y;
}
`;
