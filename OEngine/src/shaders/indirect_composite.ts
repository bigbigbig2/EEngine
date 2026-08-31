/**
 * indirect_composite：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";

export const INDIRECT_COMPOSITE_FORMAT = "rgba16float" as const;

export const INDIRECT_COMPOSITE_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_SURFACE_ABI_WGSL}

const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const MIN_DIELECTRICS_F0: f32 = 0.04;

@group(0) @binding(0) var n: texture_2d<u32>;
@group(0) @binding(1) var count: texture_2d<u32>;
@group(0) @binding(2) var radix: texture_2d<f32>;
@group(0) @binding(3) var channel_count: texture_2d<f32>;
@group(0) @binding(4) var gr_bucket: texture_2d<f32>;
@group(0) @binding(5) var surface_metadata: texture_2d<u32>;

@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var segment_height: sampler;
@group(1) @binding(2) var dependencies: texture_2d<f32>;
@group(1) @binding(3) var num_ints: texture_2d<f32>;
@group(1) @binding(4) var bindings: texture_2d<f32>;

fn saturate_f32(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn saturate_vec3(value: vec3f) -> vec3f {
  return clamp(value, vec3f(0.0), vec3f(1.0));
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32, inverse: mat4x4f) -> vec3f {
  let projected = inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
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

fn decode_g_buffer_metalness(pbr: vec4f) -> f32 {
  return pbr.x;
}

fn decode_g_buffer_roughness(pbr: vec4f) -> f32 {
  return pbr.y;
}

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
  let indirect_diffuse = diffuse * energy * (irradiance * RECIPROCAL_PI);
  return mat2x3f(indirect_specular, indirect_diffuse);
}

fn pow2(value: f32) -> f32 {
  return value * value;
}

fn cancel_thread_js(a: f32, b: f32, x: f32, y: f32, value: f32) -> f32 {
  let high = a * x + b * y;
  let low = a * x - b * y;
  return smoothstep(low, high, value);
}

fn get_heap(value: f32) -> f32 {
  return sqrt(max(0.0, value));
}

fn integer(roughness: f32) -> vec2f {
  let roughness_squared = pow2(roughness);
  let aperture = mix(0.01, 0.14, roughness_squared);
  let cone = fma(log(aperture) * pow2(roughness_squared), 0.5, 1.0);
  return vec2f(cone, get_heap(1.0 - pow2(cone)));
}

fn compute_specular_occlusion_bn(
  spec_direction: vec3f,
  bent_normal: vec3f,
  occlusion: f32,
  roughness: f32
) -> f32 {
  let cone_sin = get_heap(1.0 - occlusion);
  let cone_cos = get_heap(occlusion);
  let aperture = integer(roughness);
  return cancel_thread_js(
    cone_sin,
    cone_cos,
    aperture.x,
    aperture.y,
    dot(bent_normal, spec_direction)
  );
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

fn indirect_contribution(pixel: vec2u, uv: vec2f) -> vec4f {
  let depth = textureLoad(gr_bucket, vec2i(pixel), 0).r;
  let pbr = textureLoad(channel_count, vec2i(pixel), 0);
  let albedo_ao = textureLoad(radix, vec2i(pixel), 0);
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
  let shading_normal = decode_g_buffer_normal(textureLoad(n, vec2i(pixel), 0).xy);
  let bent_normal = decode_g_buffer_normal(textureLoad(count, vec2i(pixel), 0).xy);
  let irradiance = textureLoad(num_ints, vec2i(pixel), 0).rgb;
  let radiance = textureLoad(bindings, vec2i(pixel), 0).rgb;
  let indirect = compute_indirect_specular(
    radiance,
    irradiance,
    shading_normal,
    view_direction,
    diffuse,
    specular_f0,
    1.0,
    roughness
  );
  let reflection_direction = reflect(-view_direction, shading_normal);
  let spec_direction = normalize(mix(reflection_direction, shading_normal, alpha));
  let specular_occlusion = compute_specular_occlusion_bn(
    spec_direction,
    bent_normal,
    occlusion,
    roughness
  );
  return vec4f(indirect[0] * specular_occlusion + indirect[1], 1.0);
}

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let metadata = textureLoad(surface_metadata, vec2i(pixel), 0).r;
  if oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_UNLIT) {
    // Direct Lighting already placed the frozen Unlit baseColor in HDR.
    // The additive indirect pass must contribute nothing and must not emit it again.
    return vec4f(0.0);
  }
  return indirect_contribution(pixel, uv);
}

@fragment
fn fs_main_legacy(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  return indirect_contribution(vec2u(coord.xy), uv);
}
`;
