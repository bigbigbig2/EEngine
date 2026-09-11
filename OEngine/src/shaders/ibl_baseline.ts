import {
  GPU_COMPUTE_MATERIAL_ABI_WGSL,
  GPU_SHADING_SURFACE_LITE_WGSL
} from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_HDR_FORMAT } from "../gpu/GpuHdrAbi.js";
import { LPV_CAMERA_TYPE } from "./lpv_indirect_diffuse.js";
import {
  FULLSCREEN_TRIANGLE_WGSL,
  OCTAHEDRAL_SAMPLE_WGSL
} from "./environment_ibl.js";

export const IBL_BASELINE_FORMAT = GPU_HDR_FORMAT;

export const IBL_BASELINE_SHARED_WGSL = /* wgsl */ `
${LPV_CAMERA_TYPE.wgsl_declaration}
${GPU_SHADING_SURFACE_LITE_WGSL}
${GPU_COMPUTE_MATERIAL_ABI_WGSL}
${OCTAHEDRAL_SAMPLE_WGSL}
${FULLSCREEN_TRIANGLE_WGSL}

const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const MIN_DIELECTRICS_F0: f32 = 0.04;

@group(0) @binding(0) var surface_normal: texture_2d<u32>;
@group(0) @binding(1) var surface_bent_normal: texture_2d<u32>;
@group(0) @binding(2) var surface_albedo_ao: texture_2d<f32>;
@group(0) @binding(3) var surface_material: texture_2d<u32>;
@group(0) @binding(4) var surface_depth: texture_depth_2d;
@group(0) @binding(5) var surface_metadata: texture_2d<u32>;

@group(1) @binding(0) var<uniform> camera: CommandEncoder;
@group(1) @binding(1) var linear_sampler: sampler;
@group(1) @binding(2) var split_sum_lut: texture_2d<f32>;
@group(1) @binding(3) var prefiltered_radiance: texture_2d<f32>;
@group(1) @binding(4) var diffuse_irradiance: texture_2d<f32>;
@group(1) @binding(5) var screen_ambient_visibility: texture_2d<f32>;

fn saturate_f32(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn saturate_vec3(value: vec3f) -> vec3f {
  return clamp(value, vec3f(0.0), vec3f(1.0));
}

fn uv_to_ndc(uv: vec2f) -> vec2f {
  return fma(uv, vec2f(2.0, -2.0), vec2f(-1.0, 1.0));
}

fn project_position_from_depth(uv: vec2f, depth: f32) -> vec3f {
  let projected = camera.view_projection_matrix_inverse *
    vec4f(uv_to_ndc(uv), depth, 1.0);
  return projected.xyz / projected.w;
}

fn metalness_to_specular_color(metalness: f32, albedo: vec3f) -> vec3f {
  return mix(vec3f(MIN_DIELECTRICS_F0), albedo, metalness);
}

fn split_sum_energy(
  no_v: f32,
  roughness: f32,
  specular_f0: vec3f
) -> mat2x3f {
  let lut = textureSampleLevel(
    split_sum_lut,
    linear_sampler,
    vec2f(no_v, roughness),
    0.0
  ).rg;
  let single = specular_f0 * lut.x + vec3f(lut.y);
  let sum = lut.x + lut.y;
  let remaining = 1.0 - sum;
  let multi = single * (specular_f0 * (remaining / max(sum, 1e-4)));
  let directional_albedo = single + multi;
  return mat2x3f(directional_albedo, saturate_vec3(vec3f(1.0) - directional_albedo));
}

fn roughness_aperture(roughness: f32) -> vec2f {
  let roughness_squared = roughness * roughness;
  let aperture = mix(0.01, 0.14, roughness_squared);
  let cone = fma(log(aperture) * roughness_squared * roughness_squared, 0.5, 1.0);
  return vec2f(cone, sqrt(max(0.0, 1.0 - cone * cone)));
}

fn specular_occlusion_bent_normal(
  spec_direction: vec3f,
  bent_normal: vec3f,
  occlusion: f32,
  roughness: f32
) -> f32 {
  let cone_sin = sqrt(max(0.0, 1.0 - occlusion));
  let cone_cos = sqrt(max(0.0, occlusion));
  let aperture = roughness_aperture(roughness);
  let high = cone_sin * aperture.x + cone_cos * aperture.y;
  let low = cone_sin * aperture.x - cone_cos * aperture.y;
  return smoothstep(low, high, dot(bent_normal, spec_direction));
}

struct IblContribution {
  total: vec3f,
  baseline_specular: vec3f,
};

fn evaluate_indirect_baseline(
  pixel: vec2i,
  uv: vec2f,
  ambient: f32,
  receiver_irradiance: vec3f
) -> IblContribution {
  let metadata = textureLoad(surface_metadata, pixel, 0);
  if oengine_surface_has_flag(
    oengine_surface_lite_metadata(metadata),
    OENGINE_SURFACE_FLAG_UNLIT
  ) {
    return IblContribution(vec3f(0.0), vec3f(0.0));
  }
  let albedo_ao = textureLoad(surface_albedo_ao, pixel, 0);
  let albedo = albedo_ao.rgb;
  let material_ao = albedo_ao.a;
  let packed_material = textureLoad(surface_material, pixel, 0);
  let metalness = oengine_surface_lite_metallic(packed_material);
  let roughness = max(oengine_surface_lite_roughness(packed_material), 0.02);
  let shading_normal = decode_surface_normal(textureLoad(surface_normal, pixel, 0).xy);
  let bent_normal = decode_bent_normal(textureLoad(surface_bent_normal, pixel, 0).xy);
  let depth = textureLoad(surface_depth, pixel, 0);
  let position = project_position_from_depth(uv, depth);
  let view_direction = normalize(camera.transform[3].xyz - position);
  let no_v = saturate_f32(dot(shading_normal, view_direction));
  let specular_f0 = metalness_to_specular_color(metalness, albedo);
  let energy = split_sum_energy(no_v, roughness, specular_f0);
  let reflected = reflect(-view_direction, shading_normal);
  let spec_direction = normalize(mix(reflected, shading_normal, roughness * roughness));
  let radiance = sample_prefiltered_environment(
    prefiltered_radiance,
    spec_direction,
    roughness
  );
  let specular_occlusion = specular_occlusion_bent_normal(
    spec_direction,
    bent_normal,
    material_ao * ambient,
    roughness
  );
  let baseline_specular = radiance * energy[0] * specular_occlusion;
  let diffuse = albedo * (1.0 - metalness);
  let indirect_diffuse = diffuse * energy[1] * receiver_irradiance *
    RECIPROCAL_PI * ambient;
  return IblContribution(baseline_specular + indirect_diffuse, baseline_specular);
}

fn ibl_receiver_irradiance(pixel: vec2i) -> vec3f {
  let bent_normal = decode_bent_normal(textureLoad(surface_bent_normal, pixel, 0).xy);
  let material_ao = textureLoad(surface_albedo_ao, pixel, 0).a;
  return sample_prefiltered_environment(diffuse_irradiance, bent_normal, 0.0) *
    material_ao;
}
`;

export const IBL_BASELINE_NO_AO_WGSL = /* wgsl */ `
${IBL_BASELINE_SHARED_WGSL}

@fragment
fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, 1.0, ibl_receiver_irradiance(pixel)
  );
  return vec4f(contribution.total, 0.0);
}

struct IblBaselineOutputs {
  @location(0) total: vec4f,
  @location(1) baseline_specular: vec4f,
};

@fragment
fn fs_main_with_baseline(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> IblBaselineOutputs {
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, 1.0, ibl_receiver_irradiance(pixel)
  );
  return IblBaselineOutputs(
    vec4f(contribution.total, 0.0),
    vec4f(contribution.baseline_specular, 0.0)
  );
}
`;

export const IBL_BASELINE_WITH_AO_WGSL = /* wgsl */ `
${IBL_BASELINE_SHARED_WGSL}

@fragment
fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> @location(0) vec4f {
  let ambient = textureLoad(screen_ambient_visibility, vec2i(coord.xy), 0).r;
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, ambient, ibl_receiver_irradiance(pixel)
  );
  return vec4f(contribution.total, 0.0);
}

struct IblBaselineOutputs {
  @location(0) total: vec4f,
  @location(1) baseline_specular: vec4f,
};

@fragment
fn fs_main_with_baseline(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> IblBaselineOutputs {
  let ambient = textureLoad(screen_ambient_visibility, vec2i(coord.xy), 0).r;
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, ambient, ibl_receiver_irradiance(pixel)
  );
  return IblBaselineOutputs(
    vec4f(contribution.total, 0.0),
    vec4f(contribution.baseline_specular, 0.0)
  );
}
`;

export const LPV_BASELINE_NO_AO_WGSL = /* wgsl */ `
${IBL_BASELINE_SHARED_WGSL}

@fragment
fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, 1.0, textureLoad(diffuse_irradiance, pixel, 0).rgb
  );
  return vec4f(contribution.total, 0.0);
}

struct IblBaselineOutputs {
  @location(0) total: vec4f,
  @location(1) baseline_specular: vec4f,
};

@fragment
fn fs_main_with_baseline(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> IblBaselineOutputs {
  let pixel = vec2i(coord.xy);
  let contribution = evaluate_indirect_baseline(
    pixel, uv, 1.0, textureLoad(diffuse_irradiance, pixel, 0).rgb
  );
  return IblBaselineOutputs(
    vec4f(contribution.total, 0.0),
    vec4f(contribution.baseline_specular, 0.0)
  );
}
`;

export const LPV_BASELINE_WITH_AO_WGSL = /* wgsl */ `
${IBL_BASELINE_SHARED_WGSL}

@fragment
fn fs_main(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> @location(0) vec4f {
  let pixel = vec2i(coord.xy);
  let ambient = textureLoad(screen_ambient_visibility, pixel, 0).r;
  let contribution = evaluate_indirect_baseline(
    pixel, uv, ambient, textureLoad(diffuse_irradiance, pixel, 0).rgb
  );
  return vec4f(contribution.total, 0.0);
}

struct IblBaselineOutputs {
  @location(0) total: vec4f,
  @location(1) baseline_specular: vec4f,
};

@fragment
fn fs_main_with_baseline(@builtin(position) coord: vec4f, @location(0) uv: vec2f)
  -> IblBaselineOutputs {
  let pixel = vec2i(coord.xy);
  let ambient = textureLoad(screen_ambient_visibility, pixel, 0).r;
  let contribution = evaluate_indirect_baseline(
    pixel, uv, ambient, textureLoad(diffuse_irradiance, pixel, 0).rgb
  );
  return IblBaselineOutputs(
    vec4f(contribution.total, 0.0),
    vec4f(contribution.baseline_specular, 0.0)
  );
}
`;
