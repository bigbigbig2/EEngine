import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";

export interface NativeSurfacePhysicalSunProvider {
  /** PhysicalEnvironmentRuntime.parameters; the existing 64-byte uniform. */
  readonly parameters: GPUBuffer;
  /** PhysicalEnvironmentRuntime.luts.views.transmittance; 256x64 rgba16float. */
  readonly transmittance: GPUTextureView;
  /** PhysicalEnvironmentRuntime.luts.sampler; linear filtering, clamp to edge. */
  readonly sampler: GPUSampler;
}

export function nativeSurfacePhysicalSunLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
    { binding: 13, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 14, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
  ];
}

/** Prepare-time binding glue; the atmosphere owner retains the actual resources. */
export function nativeSurfacePhysicalSunEntries(
  provider: NativeSurfacePhysicalSunProvider
): GPUBindGroupEntry[] {
  return [
    { binding: 12, resource: { buffer: provider.parameters } },
    { binding: 13, resource: provider.transmittance },
    { binding: 14, resource: provider.sampler }
  ];
}

/**
 * Compose only into a lit physical-environment program, after the shared direct
 * BRDF/VSM math. Uses the existing Takram atmosphere provider unchanged: world
 * scale, altitude, finite solar disk/horizon, transmission and photometry.
 * Surface exposure/color conversion happens once after the sum of all lighting.
 * Cost: zero new GPU allocations/dispatches/storage bindings; one uniform, one
 * sampled texture and one sampler. One filtered LUT sample (up to four texels),
 * sphere/horizon ALU plus one BRDF evaluation, and existing VSM taps if enabled.
 * Reuses the provider's 128 KiB LUT and 64B parameters; no full-frame intermediate.
 */
export function nativeSurfacePhysicalSunWgsl(shadowed: boolean, queryOnly = false): string {
  // Diagnostic-only anchor consumes exactly the fields used by production PCF,
  // UV and bias. It changes output and liveness, so it is a differential slice.
  const queryDiagnostic = queryOnly
    ? /* wgsl */ `
fn native_vsm_query_diagnostic(position: vec3f, normal: vec3f, incident: GpuPrimitiveTypeTable) -> f32 {
  if (vsm_constants.depth_range.w == 0.0) {
    return 1.0;
  }
  let light = (vsm_constants.light_view * vec4f(position, 1.0)).xyz;
  let query = vsm_query_directional(light.xy);
  if (query.status != VSM_QUERY_FINE && query.status != VSM_QUERY_COARSE) {
    return 1.0;
  }
  let cosine = max(dot(normal, incident.direction), 1e-3);
  let normal_bias = vsm_constants.filter_params.x * (1.0 - cosine);
  let slope_bias = vsm_constants.filter_params.z * (1.0 - cosine);
  let uv = vsm_page_local_uv(light.xy, query.level, query.entry.mip);
  let extent = vsm_constants.clip_origin_extent[query.level].z;
  let reference = (vsm_constants.depth_range.y - light.z) * vsm_constants.depth_range.z;
  let depth_per_texel = extent / f32(vsm_constants.dimensions.x * vsm_constants.dimensions.y) *
    exp2(f32(query.entry.mip)) * vsm_constants.depth_range.z;
  let bias = (vsm_constants.filter_params.y + slope_bias + normal_bias) * depth_per_texel;
  return 0.5 + 0.25 * fract(dot(uv, vec2f(0.13, 0.19)) + reference + bias +
    f32(query.entry.slot_x) * 0.23 + f32(query.entry.slot_y) * 0.29);
}
`
    : "";
  const visibility = shadowed
    ? `  if ((instance_flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u) {
    incident.color *= ${queryOnly ? "native_vsm_query_diagnostic" : "vsm_sample_directional"}(geometry.position, geometry.shading_normal, incident);
  }`
    : "";
  return /* wgsl */ `
${ATMOSPHERE_RUNTIME_WGSL}
${queryDiagnostic}
@group(1) @binding(12) var<uniform> native_physical_sun: PhysicalEnvironmentParameters;
@group(1) @binding(13) var native_solar_transmittance: texture_2d<f32>;
@group(1) @binding(14) var native_solar_sampler: sampler;

fn native_surface_physical_sun(material: StandardMaterial, geometry: SurfaceGeometry, instance_flags: u32) -> vec3f {
  var incident: GpuPrimitiveTypeTable;
  incident.direction = normalize(native_physical_sun.sun_direction_world);
  incident.color = atmosphere_sun_irradiance(geometry.position, native_physical_sun,
    native_solar_transmittance, native_solar_sampler);
${visibility}
  var reflected: ReflectedLight;
  re_direct_physical(incident, geometry, material, &reflected);
  return reflected.diffuse + reflected.specular;
}
`;
}
