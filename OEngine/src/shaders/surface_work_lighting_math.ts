import { createProductionSparseDirectLightingWgsl } from "./lighting_direct.js";
export const SURFACE_DIRECT_MATH = createProductionSparseDirectLightingWgsl(true, "vsm")
  .replace(/\bview\.frame_index\b/g, "shading_view.frame_index")
  .replace(/\bview\.width\b/g, "shading_view.width")
  .replace(/\bview\.height\b/g, "shading_view.height")
  .replace(
    "struct ReflectedLight {\n  diffuse: vec3f,\n  specular: vec3f,\n}",
    "struct ReflectedLight {\n  diffuse: vec3f,\n  specular: vec3f,\n  coat: vec3f,\n  transport: vec3f,\n}"
  )
  .replace(
    "(*reflected).specular += radiance * specular * base_attenuation + coat_radiance;",
    "(*reflected).specular += radiance * specular * base_attenuation;\n  (*reflected).coat += coat_radiance;"
  )
  .replace(
    "(*reflected).diffuse += radiance * diffuse * RECIPROCAL_PI * base_attenuation;",
    "(*reflected).diffuse += radiance * diffuse * RECIPROCAL_PI * base_attenuation;\n" +
      "  if direct_transport { (*reflected).transport += radiance * RECIPROCAL_PI * base_attenuation; }"
  );

export const SURFACE_LIGHTING_FUNCTIONS_WGSL = /* wgsl */ `
fn surface_material(record: u32, signal_mask: u32, transport: bool) -> StandardMaterial {
  var material: StandardMaterial;
  material.roughness = 1.0;
  material.specularF90 = 1.0;
  material.energyCompensation = vec3f(1.0);
  material.coatRoughness = 1.0;
  material.coatNormal = vec3f(0.0, 0.0, 1.0);
  let full_direct = (signal_mask & 20u) != 0u || ((signal_mask & 1u) != 0u && !transport);
  let specular = full_direct || (signal_mask & 8u) != 0u;
  if specular {
    let albedo = max(surface_field(record, 0u).xyz, vec3f(0.0));
    let metallic = saturate(surface_field(record, 2u).x);
    let specular_weight = saturate(surface_field(record, 8u).x);
    let specular_color = max(surface_field(record, 9u).xyz, vec3f(0.0));
    material.diffuse = albedo * (1.0 - metallic);
    material.roughness = clamp(surface_field(record, 3u).x, 0.04, 1.0);
    let ior = max(surface_field(record, 7u).x, 1.0);
    let interface_reflectance = (ior - 1.0) / (ior + 1.0);
    let dielectric_f0 = interface_reflectance * interface_reflectance;
    material.specularF0 = mix(vec3f(dielectric_f0), albedo, metallic) * specular_weight * specular_color;
  }
  if full_direct || (signal_mask & 33u) != 0u {
    material.coatFactor = saturate(surface_field(record, 10u).x);
    if full_direct || (signal_mask & 32u) != 0u {
      material.coatRoughness = clamp(surface_field(record, 11u).x, 0.04, 1.0);
    }

  }
  return material;
}

// The admitted numeric envelope bounds GGX D/V/F and incident radiance far
// below f32 overflow. Keep the original half-vector/normal degeneracy guard;
// no roughness/specular evaluation is needed for transport-only work.
fn re_surface_direct(incident: GpuPrimitiveTypeTable, geometry_in: SurfaceGeometry,
  material: StandardMaterial, reflected: ptr<function, ReflectedLight>) {
  diagnostic_add(8u, 1u);
  if direct_full {
    diagnostic_add(32u,1u);
    if direct_transport { diagnostic_add(33u,1u); }
    re_direct_physical(incident, geometry_in, material, reflected);
    return;
  }
  if !direct_transport { return; }
  diagnostic_add(34u,1u);
  let h = normalize(incident.direction + geometry_in.view_direction);
  let no_l = saturate(dot(geometry_in.shading_normal, incident.direction));
  let no_v = saturate(dot(geometry_in.shading_normal, geometry_in.view_direction));
  let vo_h = saturate(dot(geometry_in.view_direction, h));
  let no_h = saturate(dot(geometry_in.shading_normal, h));
  let radiance = no_l * incident.color;
  if !finite_f32(no_v) || !finite_f32(vo_h) || !finite_f32(no_h) ||
    !all(vec3<bool>(finite_f32(radiance.x), finite_f32(radiance.y), finite_f32(radiance.z))) { return; }
  var attenuation = 1.0;
  if material.coatFactor > 0.0 {
    let coat_no_h = saturate(dot(material.coatNormal, h));
    let coat_no_l = saturate(dot(material.coatNormal, incident.direction));
    if !finite_f32(coat_no_h) || !finite_f32(coat_no_l) { return; }
    let fresnel = (0.04 + 0.96 * pow(1.0 - vo_h, 5.0)) * material.coatFactor;
    attenuation = 1.0 - fresnel;
  }
  (*reflected).transport += radiance * RECIPROCAL_PI * attenuation;
}

fn direct_surface(material: StandardMaterial, geometry_in: SurfaceGeometry,
  pixel: vec2f, view_depth: f32) -> ReflectedLight {
  var reflected = ReflectedLight(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  if (settings.reserved & 2u) != 0u {
    var solar: GpuPrimitiveTypeTable;
    solar.direction=normalize(physical_sun.sun_direction_world);
    solar.color=atmosphere_sun_irradiance(geometry_in.position,physical_sun,solar_transmittance,solar_sampler);
    if (settings.reserved & 1u) != 0u {
      solar.color*=vsm_sample_directional(geometry_in.position,geometry_in.shading_normal,solar);
    }
    re_surface_direct(solar,geometry_in,material,&reflected);
  }
  var directional_mask = directional_lights_iteration_mask(&node);
  while (directional_mask != 0u) {
    let index = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << index);
    var incident = get_directional_light_info_by_index(&node, index);
    incident.color *= shadowmap_get_directional_light_visibility(&node, index,
      geometry_in.position, geometry_in.view_direction, geometry_in.shading_normal);
    re_surface_direct(incident, geometry_in, material, &reflected);
  }
  let metadata = light_cluster_metadata_by_position(pixel, view_depth,
    vec2u(shading_view.width, shading_view.height));
  if ((metadata.flags & CLUSTER_METADATA_FLAG_FALLBACK) != 0u) {
    for (var i = 0u; i < cluster_data.active_written; i++) {
      let tuple = cluster_data.data[i];
      let index = cluster_light_tuple_id(tuple);
      let light_type = cluster_light_tuple_type(tuple);
      if (light_type == CLUSTER_LIGHT_TYPE_POINT) {
        var incident = get_point_light_info_by_index(&node, index, geometry_in.position);
        incident.color *= shadowmap_get_point_light_visibility(&node, index,
          geometry_in.position, geometry_in.shading_normal);
        re_surface_direct(incident, geometry_in, material, &reflected);
      } else if (light_type == CLUSTER_LIGHT_TYPE_SPOT) {
        var incident = get_spot_light_info_by_index(&node, index, geometry_in.position);
        incident.color *= shadowmap_get_spot_light_visibility(&node, index,
          geometry_in.position, geometry_in.shading_normal);
        re_surface_direct(incident, geometry_in, material, &reflected);
      }
    }
    return reflected;
  }
  for (var i = 0u; i < metadata.point_count; i++) {
    let index = cluster_data.data[metadata.offset + i];
    var incident = get_point_light_info_by_index(&node, index, geometry_in.position);
    incident.color *= shadowmap_get_point_light_visibility(&node, index,
      geometry_in.position, geometry_in.shading_normal);
    re_surface_direct(incident, geometry_in, material, &reflected);
  }
  for (var i = 0u; i < metadata.spot_count; i++) {
    let index = cluster_data.data[metadata.offset + metadata.point_count + i];
    var incident = get_spot_light_info_by_index(&node, index, geometry_in.position);
    incident.color *= shadowmap_get_spot_light_visibility(&node, index,
      geometry_in.position, geometry_in.shading_normal);
    re_surface_direct(incident, geometry_in, material, &reflected);
  }
  return reflected;
}

fn environment_diffuse_irradiance(normal: vec3f) -> vec3f {
  let diffuse_env = sample_octahedral_bilinear(environment_diffuse, vec2u(0u),
    textureDimensions(environment_diffuse).x, normal, 0u).rgb;
  return diffuse_env;
}

fn environment_specular_surface(material: StandardMaterial, normal: vec3f, view_dir: vec3f) -> vec3f {
  let reflection = reflect(-view_dir, normal);
  let specular_env = sample_prefiltered_environment(environment_specular, reflection, material.roughness);
  let no_v = saturate(dot(normal, view_dir));
  let dfg_size = textureDimensions(environment_dfg);
  let dfg_xy = vec2i(clamp(vec2f(no_v, material.roughness) * vec2f(dfg_size),
    vec2f(0.0), vec2f(dfg_size) - vec2f(1.0)));
  let dfg = textureLoad(environment_dfg, dfg_xy, 0).xy;
  return specular_env * (material.specularF0 * dfg.x + vec3f(dfg.y));
}

fn coat_environment(material: StandardMaterial, normal: vec3f, view_dir: vec3f) -> vec3f {
  let reflection = reflect(-view_dir, normal);
  let specular_env = sample_prefiltered_environment(environment_specular, reflection, material.coatRoughness);
  return specular_env * material.coatFactor * 0.04;
}

`;
