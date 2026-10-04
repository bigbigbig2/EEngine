import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { createProductionSparseDirectLightingWgsl } from "../../shaders/lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "../../shaders/environment_ibl.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "../../shaders/atmosphere/runtime.js";
import { surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl } from "../../gpu/GpuSurfaceDemandAbi.js";
import { SURFACE_GEOMETRY_RECORD_WGSL, surfaceGeometryReadWgsl } from "../../gpu/GpuSurfaceGeometryRecordAbi.js";
import { SURFACE_FIELD_REFERENCE_VALUES_WGSL } from "../../shaders/surface_reference_values.js";
import { SURFACE_PACKET_CONTRACT_WGSL } from "../../gpu/GpuSurfaceSignalPacketAbi.js";
import type { SurfaceDemandProducts } from "./SurfaceDemandPass.js";

export interface SurfaceLightingInput {
  readonly resourceBinding:SurfaceResourceBinding;
  readonly demand:SurfaceDemandProducts;
  readonly geometry:ResourceId;
  readonly fields:ResourceId;
  readonly appearanceMetadata:ResourceId;
  readonly constantFieldsOffset:number;
  readonly width:number;
  readonly height:number;
  readonly frame:number;
  readonly camera:ResourceId;
  readonly physicalSun:{readonly parameters:ResourceId;readonly transmittance:ResourceId}|null;
  readonly lightRecords:ResourceId;
  readonly clusters:{readonly parameters:ResourceId;readonly lookup:ResourceId;readonly data:ResourceId;readonly activeLightList:ResourceId};
  readonly shadow:{readonly virtualPageTable:ResourceId;readonly physicalAtlasDepth:ResourceId;readonly lightProjection:ResourceId;readonly contentVersion:ResourceId}|null;
  readonly scalarAo:ResourceId|null;
  readonly environment:{readonly diffuse:ResourceId;readonly specular:ResourceId;readonly dfg:ResourceId};
  readonly diagnosticsEnabled:boolean;
}

// Keep the complete production BRDF. Only split its already computed coat
// contribution into a separate physical signal; attenuation remains exactly
// inside the original per-light formula, applied once.
const DIRECT_MATH=createProductionSparseDirectLightingWgsl(true,"vsm")
  .replace(/\bview\.frame_index\b/g,"shading_view.frame_index")
  .replace(/\bview\.width\b/g,"shading_view.width")
  .replace(/\bview\.height\b/g,"shading_view.height")
  .replace("struct ReflectedLight {\n  diffuse: vec3f,\n  specular: vec3f,\n}","struct ReflectedLight {\n  diffuse: vec3f,\n  specular: vec3f,\n  coat: vec3f,\n  transport: vec3f,\n}")
  .replace("(*reflected).specular += radiance * specular * base_attenuation + coat_radiance;",
    "(*reflected).specular += radiance * specular * base_attenuation;\n  (*reflected).coat += coat_radiance;");

export function surfaceLightingWgsl(targets:number,programs:number):string {
 return /* wgsl */ `
${DIRECT_MATH}
${OCTAHEDRAL_SAMPLE_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${ATMOSPHERE_RUNTIME_WGSL}
${SURFACE_PACKET_CONTRACT_WGSL}
${SURFACE_GEOMETRY_RECORD_WGSL}
${surfaceGeometryReadWgsl("geometry")}
${surfaceCellWorkspaceWgsl(targets/64)}
${surfaceDemandArenaWgsl(targets,programs)}
struct SurfaceView {width:u32,height:u32,frame_index:u32,pad:u32}
struct SurfaceSettings {
 width:u32,height:u32,constant_fields_offset:u32,shadow_enabled:u32,
 _reserved0:u32,diagnostics_enabled:u32,pad0:u32,pad1:u32,
}
@group(0) @binding(0) var<uniform> settings:SurfaceSettings;
@group(0) @binding(1) var<storage,read> geometry:array<u32>;
@group(0) @binding(2) var<storage,read> field_values:array<vec4f>;
@group(0) @binding(3) var<storage,read> field_store:array<u32>;
@group(0) @binding(4) var<storage,read_write> lighting_demand:SurfaceDemandArena;
@group(0) @binding(5) var<storage,read_write> surface_workspace:SurfaceCellWorkspace;
@group(0) @binding(6) var<storage,read> appearance_metadata:array<u32>;
@group(0) @binding(7) var<storage,read_write> signal_values:array<vec4f>;
@group(0) @binding(13) var environment_diffuse:texture_2d<f32>;
@group(0) @binding(14) var environment_specular:texture_2d<f32>;
@group(0) @binding(15) var environment_dfg:texture_2d<f32>;
@group(0) @binding(16) var<uniform> physical_sun:PhysicalEnvironmentParameters;
@group(0) @binding(17) var solar_transmittance:texture_2d<f32>;
@group(0) @binding(18) var solar_sampler:sampler;
${SURFACE_FIELD_REFERENCE_VALUES_WGSL}
fn diagnostic_add(index:u32,value:u32) {
 if settings.diagnostics_enabled!=0u { atomicAdd(&lighting_demand.control[64u+index],value); }
}
fn packet_store(record:u32,kind:u32,value:vec4f,semantic:u32) {
 let destination = record * 6u + kind;
 signal_values[destination] = vec4f(value.xyz, bitcast<f32>(SURFACE_PACKET_VALID | semantic));
}
@group(1) @binding(0) var<storage,read> node:array<u32>;
@group(1) @binding(2) var<uniform> cluster_parameters:vec3f;
@group(1) @binding(3) var<storage,read> cluster_lookup:array<ClusterMetadata>;
@group(1) @binding(4) var<storage,read> cluster_data:ClusterData;
@group(1) @binding(7) var<storage,read> active_light_list:LightList;
@group(2) @binding(0) var<uniform> shading_view:SurfaceView;
@group(2) @binding(1) var<uniform> camera:CommandEncoder;
@group(3) @binding(0) var<uniform> vsm_constants:VsmSamplingConstants;
@group(3) @binding(1) var<storage,read> vsm_page_table:array<VsmPageEntry>;
@group(3) @binding(2) var vsm_atlas_depth:texture_depth_2d;
fn setting(index:u32)->u32 {
 switch index {
  case 0u:{return settings.width;} case 1u:{return settings.height;}
  case 7u:{return settings.shadow_enabled;} default:{return 0u;}
 }
}
var<private> direct_transport: bool;
var<private> direct_full: bool;

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
    if material.coatFactor > 0.0 || (signal_mask & 32u) != 0u {
      if surface_field(record, 14u).x > 0.5 {
        let raw = surface_field(record, 12u).xyz;
        material.coatNormal = select(vec3f(0.0, 0.0, 1.0), normalize(raw), dot(raw, raw) > 1e-8);
      }
    }
  }
  return material;
}

// The admitted numeric envelope bounds GGX D/V/F and incident radiance far
// below f32 overflow. Keep the original half-vector/normal degeneracy guard;
// no roughness/specular evaluation is needed for transport-only work.
fn re_surface_direct(incident: GpuPrimitiveTypeTable, geometry_in: SurfaceGeometry,
  material: StandardMaterial, reflected: ptr<function, ReflectedLight>) {
  if direct_full { re_direct_physical(incident, geometry_in, material, reflected); }
  if !direct_transport { return; }
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
  if settings._reserved0 != 0u {
    var solar: GpuPrimitiveTypeTable;
    solar.direction=normalize(physical_sun.sun_direction_world);
    solar.color=atmosphere_sun_irradiance(geometry_in.position,physical_sun,solar_transmittance,solar_sampler);
    if settings.shadow_enabled != 0u {
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

@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) id: vec3u) {
  if id.x>=atomicLoad(&lighting_demand.control[6u]) { return; }
  let record=lighting_demand.lighting_queue[id.x];
  let signal_mask=atomicLoad(&lighting_demand.lighting_masks[record]);
  let geometry_in=geometry_product_hot(record);
  let pixel_index=geometry_in.identity.x;
  let pixel=vec2i(i32(pixel_index%settings.width),i32(pixel_index/settings.width));
  let position=geometry_in.position.xyz;
  let geometric_normal=geometry_in.geometric.xyz;
  let shading_normal=geometry_in.normal.xyz;
  let tangent=geometry_in.tangent.xyz;
  let view_dir=geometry_in.view.xyz;
  let transport = surface_workspace.addresses[record * 144u + 136u] == 3u;
  var material = surface_material(record, signal_mask, transport);
  direct_transport = transport && (signal_mask & 1u) != 0u;
  direct_full = (signal_mask & 20u) != 0u || ((signal_mask & 1u) != 0u && !transport);
  let needs_base_normal = (signal_mask & 31u) != 0u;
  var normal_valid = false;
  if needs_base_normal { normal_valid = surface_field(record, 13u).x > 0.5; }
  var normal = shading_normal;
  if normal_valid {
    // Appearance graph publishes signed tangent-space values already.
    let normal_ts = normalize(surface_field(record, 6u).xyz);
    let bitangent = normalize(cross(shading_normal, tangent) * geometry_in.metrics.y);
    normal = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + shading_normal * normal_ts.z);
  }
  if material.coatFactor > 0.0 || (signal_mask & 32u) != 0u {
    let coat_ts = material.coatNormal;
    let coat_bitangent = normalize(cross(shading_normal, tangent) * geometry_in.metrics.y);
    material.coatNormal = normalize(tangent * coat_ts.x + coat_bitangent * coat_ts.y + shading_normal * coat_ts.z);
  }
  let surface_geometry = SurfaceGeometry(normal, geometric_normal, position, view_dir);
  if setting(10u) == 0u { diagnostic_add(7u, 1u); }
  let has_diffuse = (signal_mask & 1u) != 0u;
  let has_diffuse_env = (signal_mask & 2u) != 0u;
  let has_specular = (signal_mask & 4u) != 0u;
  let has_specular_env = (signal_mask & 8u) != 0u;
  let has_coat = (signal_mask & 16u) != 0u;
  let has_coat_env = (signal_mask & 32u) != 0u;
  let has_direct = has_diffuse || has_specular || has_coat;
  var direct = ReflectedLight(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  if has_direct {
    direct = direct_surface(material, surface_geometry, vec2f(pixel) + vec2f(0.5),
      abs(geometry_in.metrics.x));
    diagnostic_add(5u, 1u);
    if setting(7u) != 0u { diagnostic_add(18u, 1u); }
    else { diagnostic_add(8u, 1u); }
  }
  var direct_diffuse = vec3f(0.0);
  var direct_specular = vec3f(0.0);
  var coat_direct = vec3f(0.0);
  if has_diffuse {
    direct_diffuse = select(direct.diffuse, direct.transport, transport);
    diagnostic_add(0u, 1u);
  } else { diagnostic_add(14u, 1u); }
  if has_specular {
    direct_specular = direct.specular;
    diagnostic_add(1u, 1u);
  } else { diagnostic_add(15u, 1u); }
  if has_coat {
    coat_direct = direct.coat;
    diagnostic_add(2u, 1u);
  } else { diagnostic_add(16u, 1u); }
  var environment_diffuse = vec3f(0.0);
  var environment_specular = vec3f(0.0);
  var coat_ibl = vec3f(0.0);
  if has_diffuse_env {environment_diffuse = environment_diffuse_irradiance(normal);diagnostic_add(3u, 1u);}
  if has_specular_env {environment_specular = environment_specular_surface(material, normal, view_dir);diagnostic_add(6u, 1u);}
  if has_coat_env {coat_ibl = coat_environment(material, material.coatNormal, view_dir);}
  if has_diffuse {packet_store(record,0u,vec4f(direct_diffuse, 1.0),SURFACE_PACKET_DIFFUSE | select(SURFACE_PACKET_RADIANCE | SURFACE_PACKET_COLORED_RESIDUAL,
    SURFACE_PACKET_DIFFUSE_TRANSPORT, transport));diagnostic_add(20u,1u);}
  if has_diffuse_env {packet_store(record,1u,vec4f(environment_diffuse, 1.0),SURFACE_PACKET_IRRADIANCE|SURFACE_PACKET_DIFFUSE|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(21u,1u);}
  if has_specular {packet_store(record,2u,vec4f(direct_specular, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_SPECULAR);diagnostic_add(22u,1u);}
  if has_specular_env {packet_store(record,3u,vec4f(environment_specular, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_SPECULAR|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(23u,1u);}
  if has_coat {packet_store(record,4u,vec4f(coat_direct, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_COAT);diagnostic_add(24u,1u);}
  if has_coat_env {packet_store(record,5u,vec4f(coat_ibl, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_COAT|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(25u,1u);}
  diagnostic_add(10u, countOneBits(signal_mask) * 16u);

}
`;
}
