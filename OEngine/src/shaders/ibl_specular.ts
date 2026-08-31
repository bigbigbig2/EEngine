/**
 * ibl_specular：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";

export const IBL_SPECULAR_FORMAT = "rgba16float" as const;

export const IBL_SPECULAR_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}

@group(0) @binding(0) var count: texture_2d<u32>;
@group(0) @binding(1) var chunk_brick4: texture_2d<u32>;
@group(0) @binding(2) var sec_radix_passes: texture_2d<f32>;
@group(0) @binding(3) var edge: texture_2d<f32>;
@group(0) @binding(4) var gr_bucket: texture_2d<f32>;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;

fn store_uint4(value: vec2f) -> vec2f {
  return select(vec2f(1.0), vec2f(-1.0), value < vec2f(0.0));
}

fn uv_octahedral_unit_encode(direction: vec3f) -> vec2f {
  let denominator = abs(direction.x) + abs(direction.y) + abs(direction.z);
  var projected = direction.xy / denominator;
  if (direction.z < 0.0) {
    projected = (1.0 - abs(projected.yx)) * store_uint4(projected);
  }
  return 0.5 + 0.5 * projected;
}

fn uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  let projected = fma(encoded, vec2f(2.0), vec2f(-1.0));
  var direction = vec3f(
    projected,
    1.0 - abs(projected.x) - abs(projected.y)
  );
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x >= 0.0);
  direction.y += select(correction, -correction, direction.y >= 0.0);
  return normalize(direction);
}

fn decode_g_buffer_normal(encoded: vec2u) -> vec3f {
  return uv_octahedral_unit_decode(vec2f(encoded) * (1.0 / 65535.0));
}

fn decode_g_buffer_roughness(pbr: vec4f) -> f32 {
  return pbr.y;
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
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

fn texture_octahedral_wrap_texel_coordinates(position: vec2i, resolution: i32) -> vec2u {
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

fn texture_octahedral_sample_bilinear(
  source: texture_2d<f32>,
  origin: vec2u,
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
  return textureLoad(source, vec2i(origin + c00), lod) * weights.x +
    textureLoad(source, vec2i(origin + c10), lod) * weights.y +
    textureLoad(source, vec2i(origin + c01), lod) * weights.z +
    textureLoad(source, vec2i(origin + c11), lod) * weights.w;
}

fn sphere_probe_roughness_to_lod(roughness: f32) -> f32 {
  return clamp(roughness, 0.0, 1.0) * f32(textureNumLevels(sec_radix_passes) - 1u);
}

fn named_child(source: texture_2d<f32>, direction: vec3f, roughness: f32) -> vec3f {
  let lod = sphere_probe_roughness_to_lod(roughness);
  let lower = u32(floor(lod));
  let blend = fract(lod);
  let lower_radiance = texture_octahedral_sample_bilinear(
    source,
    vec2u(0u),
    textureDimensions(source, lower).x,
    direction,
    lower
  ).rgb;
  let upper = min(lower + 1u, textureNumLevels(source) - 1u);
  let upper_radiance = texture_octahedral_sample_bilinear(
    source,
    vec2u(0u),
    textureDimensions(source, upper).x,
    direction,
    upper
  ).rgb;
  return mix(lower_radiance, upper_radiance, blend);
}

fn get_ibl_radiance(
  view_direction: vec3f,
  shading_normal: vec3f,
  roughness: f32
) -> vec3f {
  let reflected = reflect(-view_direction, shading_normal);
  let direction = normalize(mix(reflected, shading_normal, roughness * roughness));
  return named_child(sec_radix_passes, direction, roughness);
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
  let pbr = textureLoad(edge, vec2i(pixel), 0);
  let roughness = decode_g_buffer_roughness(pbr);
  let bent_normal = decode_g_buffer_normal(textureLoad(count, vec2i(pixel), 0).rg);
  _ = bent_normal;
  let shading_normal = decode_g_buffer_normal(
    textureLoad(chunk_brick4, vec2i(pixel), 0).rg
  );
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let position = project_position_from_depth(
    uv,
    depth,
    camera.view_projection_matrix_inverse
  );
  let view_direction = normalize(camera.transform[3].xyz - position);
  return vec4f(
    get_ibl_radiance(view_direction, shading_normal, roughness),
    0.0
  );
}
`;
