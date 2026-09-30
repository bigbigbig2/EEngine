import { createProductionSparseDirectLightingWgsl } from "./lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { SPECULAR_AMBIENT_OCCLUSION_WGSL } from "./specular_ambient_occlusion.js";
export function lightingWgsl(
  shadowSamplingEnabled: boolean,
  environmentIblEnabled: boolean,
  scalarAoEnabled = false,
  directionalShadowMode: "legacy" | "vsm" = "legacy"
): string {
  return /* wgsl */ `
${environmentIblEnabled ? `struct PhysicalEnvironmentSun {
  direction_world: vec3f,
  world_to_unit: f32,
  irradiance: vec3f,
  generation: f32,
  sky_luminance_scale: f32,
}` : ""}
${createProductionSparseDirectLightingWgsl(shadowSamplingEnabled, directionalShadowMode)}
${environmentIblEnabled ? `${OCTAHEDRAL_SAMPLE_WGSL}
// Filament R03 DFV_Multiscatter: x = integrated Schlick Fc, y = total
// visibility. F90 can differ from one for KHR_materials_specular.
fn filament_specular_dfg(dfg:vec2f,f0:vec3f,f90:f32)->vec3f {
  return vec3f(f90*dfg.x)+f0*(dfg.y-dfg.x);
}
fn filament_energy_compensation(dfg:vec2f,f0:vec3f)->vec3f {
  return vec3f(1.0)+f0*(1.0/max(dfg.y,1e-4)-1.0);
}
fn filament_clearcoat_to_surface_f0(f0:vec3f)->vec3f {
  let root=sqrt(clamp(f0,vec3f(0.0),vec3f(0.9999)));
  let ior=(vec3f(1.0)+root)/(vec3f(1.0)-root);
  let ratio=(ior-vec3f(1.5))/(ior+vec3f(1.5));
  return ratio*ratio;
}
${SPECULAR_AMBIENT_OCCLUSION_WGSL}` : ""}
${scalarAoEnabled ? `
fn xe_scalar_visibility(pixel: vec2u) -> f32 {
  let index = pixel.y * shading_view.width + pixel.x;
  let packed = xe_visibility_words[index >> 2u];
  return f32((packed >> ((index & 3u) * 8u)) & 255u) / 255.0;
}` : ""}
fn sparse_direct(surface:OEngineSparseSurface,pixel:vec2u)->vec3f{
  if (oengine_surface_has_flag(surface.flags, OENGINE_SURFACE_FLAG_UNLIT)) {
    return surface.emissive;
  }
  var material: StandardMaterial;
  material.diffuse = surface.base_color * (1.0 - surface.metallic);
  material.occlusion = surface.material_ao;
  let indirect_visibility = ${scalarAoEnabled
    ? "min(surface.material_ao, xe_scalar_visibility(pixel))"
    : "surface.material_ao"};
  material.roughness = max(surface.roughness, 0.045);
  let eta = max(surface.ior, 1.0);
  let dielectric_f0 = pow((eta - 1.0) / (eta + 1.0), 2.0);
  material.specularF0 = mix(vec3f(dielectric_f0) * surface.specular_color *
    surface.specular_weight, surface.base_color, surface.metallic);
  material.specularF90 = mix(surface.specular_weight, 1.0, surface.metallic);
  material.emissive = vec3f(0.0);
  material.opacity = surface.alpha;
  material.coatFactor = surface.coat_factor;
  material.coatRoughness = max(surface.coat_roughness, 0.045);
  material.coatNormal = surface.coat_normal;
  material.energyCompensation = vec3f(1.0);
  ${environmentIblEnabled ? `if material.coatFactor > 0.0 {
    material.specularF0 = mix(material.specularF0,
      filament_clearcoat_to_surface_f0(material.specularF0),material.coatFactor);
    material.roughness = mix(material.roughness,
      max(material.roughness,material.coatRoughness),material.coatFactor);
  }` : ""}
  let geometry = SurfaceGeometry(
    surface.shading_normal,
    surface.geometric_normal,
    surface.position_ws,
    normalize(shading_view.camera_position.xyz - surface.position_ws)
  );
  ${environmentIblEnabled ? `let no_v = clamp(dot(surface.shading_normal, geometry.view_direction),0.0,1.0);
  let dfg = textureSampleLevel(split_sum,environment_sampler,
    vec2f(no_v,material.roughness),0.0).rg;
  material.energyCompensation = filament_energy_compensation(dfg,material.specularF0);` : ""}
  random_initialize(
    vec3u(pixel, shading_view.frame_index),
    vec3u(0xEE6B2807u, 7u, 0xD0974829u)
  );
  let direct = shade_standard_material_direct(
    material,
    geometry,
    vec2f(pixel) + vec2f(0.5),
    surface.view_depth
  );
  ${environmentIblEnabled ? `let environment_position = atmosphere_world_to_planet(surface.position_ws,
    physical_environment_sun.world_to_unit);
  let environment_radius = length(environment_position);
  let environment_altitude = clamp((environment_radius - 6360.0) / 60.0, 0.0, 1.0);
  let environment_mu_s = clamp(dot(normalize(environment_position),
    normalize(physical_environment_sun.direction_world)), -1.0, 1.0);
  let sun_transmittance = textureSampleLevel(physical_environment_transmittance, physical_sky_sampler,
    atmosphere_transmittance_uv(environment_radius, environment_mu_s), 0.0).rgb;
  var sun_incident: GpuPrimitiveTypeTable;
  sun_incident.direction = normalize(physical_environment_sun.direction_world);
  sun_incident.color = physical_environment_sun.irradiance * sun_transmittance;
  sun_incident.radius = 0.004675;
  sun_incident.distance = 1.496e11;
  var sun_reflected = ReflectedLight(vec3f(0.0), vec3f(0.0));
  re_direct_physical(sun_incident, geometry, material, &sun_reflected);
  let physical_sun = sun_reflected.diffuse + sun_reflected.specular;
  let sky_irradiance = textureSampleLevel(physical_sky_irradiance, physical_sky_sampler,
    vec2f(environment_mu_s * 0.5 + 0.5, environment_altitude), 0.0).rgb *
    (vec3f(114974.91644, 71305.954816, 65310.548555) * 0.000013207021769386792) *
    physical_environment_sun.sky_luminance_scale;
  var physical_sky = sky_irradiance * material.diffuse * indirect_visibility * ${1 / Math.PI};
  ${environmentIblEnabled ? `
  let specular_direction = normalize(mix(
    reflect(-geometry.view_direction, surface.shading_normal),
    surface.shading_normal,
    material.roughness * material.roughness
  ));
  let radiance = sample_prefiltered_environment(
    environment_specular,
    specular_direction,
    material.roughness
  );
  let directional_albedo = filament_specular_dfg(
    dfg,
    material.specularF0,
    material.specularF90
  );
  let energy = max(vec3f(0.0),vec3f(1.0)-directional_albedo);
  let specular_ao = oengine_specular_ao_cones(
    specular_direction,
    surface.shading_normal,
    indirect_visibility,
    material.roughness
  );
  var environment_specular_contribution = radiance * directional_albedo *
    material.energyCompensation * specular_ao;
  var environment_diffuse_contribution = physical_sky * energy;
  if surface.coat_factor > 0.0 {
    // Filament evaluateClearCoatIBL: attenuate both base terms and add the
    // filtered secondary lobe using the fixed 1.5-IOR coat Fresnel.
    let coat_no_v = clamp(dot(surface.coat_normal, geometry.view_direction), 0.0, 1.0);
    let coat_fresnel = (0.04 + 0.96 * pow(1.0 - coat_no_v, 5.0)) * surface.coat_factor;
    let attenuation = 1.0 - coat_fresnel;
    environment_specular_contribution *= attenuation;
    environment_diffuse_contribution *= attenuation;
    let coat_direction = reflect(-geometry.view_direction, surface.coat_normal);
    let coat_radiance = sample_prefiltered_environment(
      environment_specular, coat_direction, surface.coat_roughness);
    let coat_ao = oengine_specular_ao_cones(coat_direction, surface.coat_normal,
      indirect_visibility, surface.coat_roughness);
    environment_specular_contribution += coat_radiance * coat_ao * coat_fresnel;
  }
  return direct + physical_sun + environment_specular_contribution +
    environment_diffuse_contribution + surface.emissive;` : `
  if surface.coat_factor > 0.0 {
    let coat_no_v = clamp(dot(surface.coat_normal, geometry.view_direction), 0.0, 1.0);
    let coat_fresnel = (0.04 + 0.96 * pow(1.0 - coat_no_v, 5.0)) * surface.coat_factor;
    physical_sky *= 1.0 - coat_fresnel;
  }
  return direct + physical_sun + physical_sky + surface.emissive;`}` : "return direct + surface.emissive;"}
}
`;
}
