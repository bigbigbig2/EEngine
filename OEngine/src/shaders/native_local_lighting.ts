import { LIGHT_DATABASE_READ_CHUNK, DIRECTIONAL_LIGHT_DESCRIPTOR } from "../gpu/LightDatabase.js";
import { LOCAL_LIGHT_TYPES_WGSL } from "../gpu/GpuLocalLightWorkAbi.js";
import { LIGHTING_BRDF_MATH_WGSL, LIGHTING_BRDF_TYPES_WGSL } from "./lighting_brdf.js";
import { VSM_SAMPLING_WGSL } from "./vsm_sampling.js";
import type { NativeSurfaceDirectLighting } from "./native_surface.js";

/** New local-light consumer. Reads only finalized products; never owns work generation. */
export const NATIVE_LOCAL_LIGHTING: NativeSurfaceDirectLighting = {
  declarations: /* wgsl */ `
${LOCAL_LIGHT_TYPES_WGSL}
@group(1) @binding(1) var<uniform> local_parameters: LocalLightParameters;
@group(1) @binding(2) var<storage, read> local_lookup: array<LocalLightLookup>;
@group(1) @binding(3) var<storage, read> local_data: LocalLightData;
`,
  source: /* wgsl */ `
const PI: f32 = 3.1415926535897932384626433832795;
const RECIPROCAL_PI: f32 = 0.318309886183790671537767526745028724;
const EPSILON: f32 = 1e-6;
fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}
${LIGHT_DATABASE_READ_CHUNK.compile().text}
${LIGHTING_BRDF_TYPES_WGSL}
${LIGHTING_BRDF_MATH_WGSL}
${VSM_SAMPLING_WGSL}
fn native_local_accumulate(tuple: u32, geometry: SurfaceGeometry, material: StandardMaterial, reflected: ptr<function, ReflectedLight>) {
  let slot = tuple & 0xffffffu;
  var incident: GpuPrimitiveTypeTable;
  if tuple >> 24u == 0u {
    incident = get_point_light_info_by_index(&node, slot, geometry.position);
  } else {
    incident = get_spot_light_info_by_index(&node, slot, geometry.position);
  }
  if any(incident.color != vec3f(0.0)) {
    re_direct_physical(incident, geometry, material, reflected);
  }
}
fn shade_standard_material_direct(material: StandardMaterial, geometry: SurfaceGeometry, pixel: vec2f, view_depth: f32) -> vec3f {
  var reflected: ReflectedLight;
  var directional_mask = directional_lights_iteration_mask(&node);
  while directional_mask != 0u {
    let slot = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << slot);
    let source = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(&node, slot);
    var incident = get_directional_light_info(source);
    if (source.flags & 1u) != 0u {
      incident.color *= select(0.0, vsm_sample_directional(geometry.position, geometry.shading_normal, incident), dot(incident.direction, geometry.shading_normal) >= 0.0);
    }
    re_direct_physical(incident, geometry, material, &reflected);
  }
  // Poison stale output for the HDR numeric gate; rgba16float may clamp the sentinel.
  if local_data.abi != 1u || local_data.epoch != local_parameters.context.x || local_data.frame != local_parameters.context.y || local_data.frame != shading_view.frame_index || local_parameters.grid.x != shading_view.width || local_parameters.grid.y != shading_view.height || local_data.publication != local_parameters.context.z || local_data.admitted != local_parameters.context.w || (local_data.flags & 8u) != 0u {
    return vec3f(3.402823e38);
  }
  if local_data.mode == 1u {
    for (var i = 0u; i < local_data.admitted; i++) {
      native_local_accumulate(local_data.ids[local_data.all_offset + i], geometry, material, &reflected);
    }
  } else if local_data.mode == 2u {
    let range = local_lookup[local_light_cluster(vec2u(pixel), view_depth, local_parameters)];
    for (var i = 0u; i < range.count; i++) {
      native_local_accumulate(local_data.ids[local_data.indices_offset + range.offset + i], geometry, material, &reflected);
    }
    for (var i = 0u; i < local_data.global_count; i++) {
      native_local_accumulate(local_data.ids[local_data.global_offset + i], geometry, material, &reflected);
    }
  }
  return reflected.diffuse + reflected.specular + material.emissive;
}
`
};
