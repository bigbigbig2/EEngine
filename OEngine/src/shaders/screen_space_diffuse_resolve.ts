import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import {
  GPU_COMPUTE_MATERIAL_ABI_WGSL,
  GPU_SHADING_SURFACE_LITE_WGSL,
  GPU_SHADING_SURFACE_NORMAL_WGSL
} from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_HDR_FORMAT } from "../gpu/GpuHdrAbi.js";

export const SCREEN_SPACE_DIFFUSE_RESOLVE_FORMAT = GPU_HDR_FORMAT;

/**
 * Adds only the screen-space diffuse delta to the frozen pre-SSGI radiance:
 * - direct/emissive/unlit are untouched;
 * - long-range diffuse and baseline specular are replaced by AO-aware values;
 * - incident SSGI is receiver-modulated exactly once.
 */
export const SCREEN_SPACE_DIFFUSE_RESOLVE_WGSL = /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_LITE_WGSL}
${GPU_SHADING_SURFACE_NORMAL_WGSL}
${GPU_COMPUTE_MATERIAL_ABI_WGSL}

const RECIPROCAL_PI: f32 = 0.3183098861837907;
const MIN_DIELECTRICS_F0: f32 = 0.04;
@group(0) @binding(0) var normal_source: texture_2d<u32>;
@group(0) @binding(1) var bent_normal_source: texture_2d<u32>;
@group(0) @binding(2) var albedo_ao_source: texture_2d<f32>;
@group(0) @binding(3) var material_source: texture_2d<u32>;
@group(0) @binding(4) var depth_source: texture_depth_2d;
@group(0) @binding(5) var metadata_source: texture_2d<u32>;
@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var linear_sampler: sampler;
@group(1) @binding(2) var split_sum_lut: texture_2d<f32>;
@group(1) @binding(3) var long_range_diffuse: texture_2d<f32>;
@group(1) @binding(4) var baseline_specular: texture_2d<f32>;
@group(1) @binding(5) var screen_visibility: texture_2d<f32>;
@group(1) @binding(6) var incident_gi: texture_2d<f32>;

fn oct_decode(e: vec2f) -> vec3f {
  let p = e * 2.0 - 1.0; var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0); n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
fn uv_to_ndc(uv: vec2f) -> vec2f { return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0)); }
fn position_from_depth(uv: vec2f, depth: f32) -> vec3f {
  let p = camera.view_projection_matrix_inverse * vec4f(uv_to_ndc(uv), depth, 1.0);
  return p.xyz / max(abs(p.w), 1e-6);
}
fn roughness_aperture(roughness: f32) -> vec2f {
  let r2 = roughness * roughness; let aperture = mix(0.01, 0.14, r2);
  let cone = fma(log(aperture) * r2 * r2, 0.5, 1.0);
  return vec2f(cone, sqrt(max(0.0, 1.0 - cone * cone)));
}
fn specular_occlusion(direction: vec3f, bent: vec3f, visibility: f32, roughness: f32) -> f32 {
  let cone_sin = sqrt(max(0.0, 1.0 - visibility));
  let cone_cos = sqrt(max(0.0, visibility)); let aperture = roughness_aperture(roughness);
  return smoothstep(cone_sin * aperture.x - cone_cos * aperture.y,
    cone_sin * aperture.x + cone_cos * aperture.y, dot(bent, direction));
}
fn energy_remaining(no_v: f32, roughness: f32, f0: vec3f) -> vec3f {
  let lut = textureSampleLevel(split_sum_lut, linear_sampler, vec2f(no_v, roughness), 0.0).rg;
  let single = f0 * lut.x + vec3f(lut.y); let sum = lut.x + lut.y;
  let multi = single * (f0 * ((1.0 - sum) / max(sum, 1e-4)));
  return clamp(vec3f(1.0) - single - multi, vec3f(0.0), vec3f(1.0));
}

const POSITIONS = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let p = POSITIONS[index]; var o: VertexOutput; o.position = vec4f(p, 0.0, 1.0);
  o.uv = fma(p, vec2f(0.5, -0.5), vec2f(0.5)); return o;
}
fn resolve_delta(coord: vec4f, uv: vec2f, resolve_specular: bool) -> vec4f {
  let pixel = vec2i(coord.xy);
  let metadata = textureLoad(metadata_source, pixel, 0).r;
  if (oengine_surface_has_flag(metadata, OENGINE_SURFACE_FLAG_UNLIT)) { return vec4f(0.0); }
  let albedo_ao = textureLoad(albedo_ao_source, pixel, 0);
  let packed_material = textureLoad(material_source, pixel, 0);
  let metallic = oengine_surface_lite_metallic(packed_material);
  let roughness = max(oengine_surface_lite_roughness(packed_material), 0.02);
  let normal = oct_decode(vec2f(textureLoad(normal_source, pixel, 0).xy) / OENGINE_SURFACE_NORMAL_MAX_VALUE);
  let bent = oct_decode(vec2f(textureLoad(bent_normal_source, pixel, 0).xy) / 65535.0);
  let position = position_from_depth(uv, textureLoad(depth_source, pixel, 0));
  let view_direction = normalize(camera.transform[3].xyz - position);
  let reflected = reflect(-view_direction, normal);
  let spec_direction = normalize(mix(reflected, normal, roughness * roughness));
  let visibility = textureLoad(screen_visibility, pixel, 0).r;
  let material_ao = albedo_ao.a;
  let baseline_diffuse = textureLoad(long_range_diffuse, pixel, 0).rgb;
  let baseline_spec = textureLoad(baseline_specular, pixel, 0).rgb;
  let f0 = mix(vec3f(MIN_DIELECTRICS_F0), albedo_ao.rgb, metallic);
  let remaining = energy_remaining(max(dot(normal, view_direction), 0.0), roughness, f0);
  let receiver = albedo_ao.rgb * (1.0 - metallic) * remaining * material_ao * RECIPROCAL_PI;
  let near_diffuse = textureLoad(incident_gi, pixel, 0).rgb * receiver;
  let resolved_diffuse = baseline_diffuse * visibility;
  let baseline_material_occlusion = specular_occlusion(
    spec_direction, normal, material_ao, roughness
  );
  let resolved_screen_occlusion = specular_occlusion(
    spec_direction, bent, material_ao * visibility, roughness
  );
  let resolved_spec = baseline_spec *
    clamp(resolved_screen_occlusion / max(baseline_material_occlusion, 1e-3), 0.0, 1.0);
  let specular_delta = select(vec3f(0.0), resolved_spec - baseline_spec, resolve_specular);
  return vec4f(
    resolved_diffuse + near_diffuse - baseline_diffuse + specular_delta,
    0.0
  );
}
@fragment fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  return resolve_delta(coord, uv, true);
}
@fragment fn fs_main_ssr(@builtin(position) coord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  return resolve_delta(coord, uv, false);
}
`;
