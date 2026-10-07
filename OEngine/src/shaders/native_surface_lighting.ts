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
export function nativeSurfacePhysicalSunWgsl(shadowed: boolean): string {
  const visibility = shadowed
    ? "  incident.color *= vsm_sample_directional(geometry.position, geometry.shading_normal, incident);"
    : "";
  return /* wgsl */ `
${ATMOSPHERE_RUNTIME_WGSL}
@group(1) @binding(12) var<uniform> native_physical_sun: PhysicalEnvironmentParameters;
@group(1) @binding(13) var native_solar_transmittance: texture_2d<f32>;
@group(1) @binding(14) var native_solar_sampler: sampler;

fn native_surface_physical_sun(material: StandardMaterial, geometry: SurfaceGeometry) -> vec3f {
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
