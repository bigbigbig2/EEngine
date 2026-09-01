import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import { GPU_SURFACE_ABI_WGSL } from "../gpu/GpuSurfaceAbi.js";

export const SPECULAR_CORRECTION_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_SURFACE_ABI_WGSL}

const MIN_DIELECTRICS_F0: f32 = 0.04;

@group(0) @binding(0) var normal_source: texture_2d<u32>;
@group(0) @binding(1) var bent_normal_source: texture_2d<u32>;
@group(0) @binding(2) var albedo_ao_source: texture_2d<f32>;
@group(0) @binding(3) var pbr_source: texture_2d<f32>;
@group(0) @binding(4) var depth_source: texture_2d<f32>;
@group(0) @binding(5) var surface_metadata: texture_2d<u32>;

@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var linear_clamp: sampler;
@group(1) @binding(2) var split_sum_source: texture_2d<f32>;
@group(1) @binding(3) var baseline_specular_source: texture_2d<f32>;
@group(1) @binding(4) var resolved_specular_source: texture_2d<f32>;
@group(1) @binding(5) var ambient_visibility_source: texture_2d<f32>;

fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }

fn oct_decode(encoded: vec2u) -> vec3f {
  let projected = vec2f(encoded) * (2.0 / 65535.0) - vec2f(1.0);
  var direction = vec3f(projected, 1.0 - abs(projected.x) - abs(projected.y));
  let correction = max(-direction.z, 0.0);
  direction.x += select(correction, -correction, direction.x > 0.0);
  direction.y += select(correction, -correction, direction.y > 0.0);
  return normalize(direction);
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn world_position(uv: vec2f, depth: f32) -> vec3f {
  let projected = camera.view_projection_matrix_inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn directional_albedo(split_sum: vec2f, f0: vec3f) -> vec3f {
  let combined = f0 * split_sum.x + vec3f(split_sum.y);
  let sum = split_sum.x + split_sum.y;
  let ratio = (1.0 - sum) / max(sum, 1e-4);
  return combined + combined * (f0 * ratio);
}

fn cone_axis(roughness: f32) -> vec2f {
  let roughness2 = roughness * roughness;
  let aperture = mix(0.01, 0.14, roughness2);
  let cone = fma(log(aperture) * roughness2 * roughness2, 0.5, 1.0);
  return vec2f(cone, sqrt(max(0.0, 1.0 - cone * cone)));
}

fn specular_occlusion(
  spec_direction: vec3f,
  bent_normal: vec3f,
  occlusion: f32,
  roughness: f32
) -> f32 {
  let cone_sin = sqrt(max(0.0, 1.0 - occlusion));
  let cone_cos = sqrt(max(0.0, occlusion));
  let aperture = cone_axis(roughness);
  let high = cone_sin * aperture.x + cone_cos * aperture.y;
  let low = cone_sin * aperture.x - cone_cos * aperture.y;
  return smoothstep(low, high, dot(bent_normal, spec_direction));
}

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
);

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let ndc = FULLSCREEN_POSITIONS[index];
  var output: VertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}

fn correction(pixel: vec2i, uv: vec2f, ambient_visibility: f32) -> vec4f {
  let pbr = textureLoad(pbr_source, pixel, 0);
  let albedo_ao = textureLoad(albedo_ao_source, pixel, 0);
  let metalness = pbr.x;
  let roughness = max(pbr.y, 0.02);
  let normal = oct_decode(textureLoad(normal_source, pixel, 0).xy);
  let bent_normal = oct_decode(textureLoad(bent_normal_source, pixel, 0).xy);
  let position = world_position(uv, textureLoad(depth_source, pixel, 0).r);
  let view_direction = normalize(camera.transform[3].xyz - position);
  let no_v = saturate(dot(normal, view_direction));
  let split_sum = textureSampleLevel(split_sum_source, linear_clamp, vec2f(no_v, roughness), 0.0).rg;
  let f0 = mix(vec3f(MIN_DIELECTRICS_F0), albedo_ao.rgb, metalness);
  let weight = directional_albedo(split_sum, f0);
  let reflection = reflect(-view_direction, normal);
  let spec_direction = normalize(mix(reflection, normal, roughness * roughness));
  let occlusion = specular_occlusion(
    spec_direction,
    bent_normal,
    albedo_ao.a * ambient_visibility,
    roughness
  );
  let baseline = textureLoad(baseline_specular_source, pixel, 0).rgb;
  let resolved = textureLoad(resolved_specular_source, pixel, 0).rgb;
  return vec4f((resolved - baseline) * weight * occlusion, 0.0);
}

@fragment
fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  if (oengine_surface_has_flag(textureLoad(surface_metadata, pixel, 0).r, OENGINE_SURFACE_FLAG_UNLIT)) {
    return vec4f(0.0);
  }
  return correction(pixel, uv, textureLoad(ambient_visibility_source, pixel, 0).r);
}

@fragment
fn fs_main_no_ao(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  if (oengine_surface_has_flag(textureLoad(surface_metadata, pixel, 0).r, OENGINE_SURFACE_FLAG_UNLIT)) {
    return vec4f(0.0);
  }
  return correction(pixel, uv, 1.0);
}

@fragment
fn fs_main_legacy(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  return correction(pixel, uv, textureLoad(ambient_visibility_source, pixel, 0).r);
}

@fragment
fn fs_main_legacy_no_ao(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  return correction(vec2i(coord.xy), uv, 1.0);
}
`;
