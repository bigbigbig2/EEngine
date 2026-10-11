// Frozen S3/reference at 9f305c4128b0355614ececbe2be890582d6e8f2d.
// Test only; preserve numeric and quality reference independently of production cutover.
import { GPU_INSTANCE_FLAGS } from "../../../../.test-dist/gpu/GpuInstanceAbi.js";
import { atmosphereRuntimeWgsl } from "../../../../.test-dist/shaders/atmosphere/runtime.js";
import { FINAL_PIXEL_SOLAR_SAMPLING_WGSL } from "../../../../.test-dist/gpu/FinalPixelAbi.js";
export function nativeSurfacePhysicalSunLayoutEntries(finalPixel = false) {
    return [
        { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
        ...(finalPixel
            ? []
            : [
                { binding: 13, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 14, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
            ]),
    ];
}
/** Prepare-time binding glue; the atmosphere owner retains the actual resources. */
export function nativeSurfacePhysicalSunEntries(provider) {
    return [
        { binding: 12, resource: { buffer: provider.parameters } },
        { binding: 13, resource: provider.transmittance },
        { binding: 14, resource: provider.sampler },
    ];
}
/**
 * Compose only into a lit physical-environment program, after the shared direct
 * BRDF/VSM math. Uses the existing Takram atmosphere provider unchanged: world
 * scale, altitude, finite solar disk/horizon, transmission and photometry.
 * Surface exposure/color conversion happens once after the sum of all lighting.
 * Default cost: no new allocations/dispatches/storage bindings, one uniform,
 * one texture and sampler, a filtered LUT sample and packed visibility load.
 * Fused cost: the shared frame directory carries a fixed 128KiB LUT publication;
 * four raw half-texel reads plus decode/interpolation replace hardware filtering.
 * No additional storage binding or sampler; VSM visibility is invocation-local.
 */
export function nativeSurfacePhysicalSunWgsl(shadowed, finalPixel = false) {
    // Retain the upstream provider's coordinate, horizon and photometry math;
    // replace only its single texture sample with exact half-buffer interpolation.
    const visibility = shadowed
        ? `  if ((instance_flags & ${GPU_INSTANCE_FLAGS.ReceivesShadow}u) != 0u) {
    incident.color *= ${finalPixel ? "sun_visibility" : "directional_shadow_visibility_at(pixel)"};
  }`
        : "";
    return /* wgsl */ `
${finalPixel ? FINAL_PIXEL_SOLAR_SAMPLING_WGSL : ""}
${atmosphereRuntimeWgsl(finalPixel)}
@group(1) @binding(12) var<uniform> native_physical_sun: PhysicalEnvironmentParameters;
${finalPixel
        ? ""
        : `@group(1) @binding(13) var native_solar_transmittance: texture_2d<f32>;
@group(1) @binding(14) var native_solar_sampler: sampler;`}

fn native_surface_physical_sun(material: StandardMaterial, geometry: SurfaceGeometry, instance_flags: u32, pixel: vec2u${finalPixel ? ", sun_visibility: f32" : ""}) -> vec3f {
  var incident: GpuPrimitiveTypeTable;
  incident.direction = normalize(native_physical_sun.sun_direction_world);
  incident.color = atmosphere_sun_irradiance(geometry.position, native_physical_sun${finalPixel ? "" : ", native_solar_transmittance, native_solar_sampler"});
${visibility}
  var reflected: ReflectedLight;
  re_direct_physical(incident, geometry, material, &reflected);
  return reflected.diffuse + reflected.specular;
}
`;
}
