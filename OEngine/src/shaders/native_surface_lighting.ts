import { GPU_INSTANCE_FLAGS } from "../gpu/GpuInstanceAbi.js";
import { atmosphereRuntimeWgsl } from "./atmosphere/runtime.js";
import { FINAL_PIXEL_SOLAR_SAMPLING_WGSL } from "../gpu/FinalPixelAbi.js";

export interface NativeSurfacePhysicalSunProvider {
  /** PhysicalEnvironmentRuntime.parameters; the existing 64-byte uniform. */
  readonly parameters: GPUBuffer;
}

export function nativeSurfacePhysicalSunLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } }
  ];
}

/** Prepare-time binding glue; the atmosphere owner retains the actual resources. */
export function nativeSurfacePhysicalSunEntries(
  provider: NativeSurfacePhysicalSunProvider
): GPUBindGroupEntry[] {
  return [{ binding: 12, resource: { buffer: provider.parameters } }];
}

/**
 * Compose only into a lit physical-environment program, after the shared direct
 * BRDF/VSM math. Uses the existing Takram atmosphere provider unchanged: world
 * scale, altitude, finite solar disk/horizon, transmission and photometry.
 * Surface exposure/color conversion happens once after the sum of all lighting.
 * Cost: the shared frame directory carries a fixed 128KiB LUT publication;
 * four raw half-texel reads plus decode/interpolation replace hardware filtering.
 * No additional storage binding or sampler; VSM visibility is invocation-local.
 */
export function nativeSurfacePhysicalSunWgsl(shadowed: boolean): string {
  // Retain the upstream provider's coordinate, horizon and photometry math;
  // replace only its single texture sample with exact half-buffer interpolation.
  const visibility = shadowed
    ? `  if ((instance_flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u) {
    incident_color *= sun_visibility;
  }`
    : "";
  return /* wgsl */ `
${FINAL_PIXEL_SOLAR_SAMPLING_WGSL}
${atmosphereRuntimeWgsl(true)}
@group(1) @binding(12) var<uniform> native_physical_sun: PhysicalEnvironmentParameters;

fn native_surface_physical_sun(response: DirectPhysicalResponse, position: vec3f, instance_flags: u32, sun_visibility: f32) -> vec3f {
  ${
    shadowed
      ? `if ((instance_flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u && sun_visibility == 0.0) {
    // Exact zero irradiance has zero diffuse and specular contribution. The
    // complete point-PCF already ran; no tap or geometry work is omitted.
    return vec3f(0.0);
  }`
      : ""
  }
  var incident_color = atmosphere_sun_irradiance(position, native_physical_sun);
${visibility}
  var reflected: ReflectedLight;
  apply_direct_physical(incident_color, response, &reflected);
  return reflected.diffuse + reflected.specular;
}
`;
}
