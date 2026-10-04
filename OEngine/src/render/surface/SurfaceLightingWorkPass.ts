import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_WORK_INDIRECT_OFFSET, SURFACE_WORK_OVERFLOW, SURFACE_INPUT_WITNESS_WORDS } from "../../gpu/GpuSurfaceWorkAbi.js";
import { SPARSE_LIGHTING_COUNTER_BYTES, SPARSE_LIGHTING_COUNTER_WORDS } from "../../gpu/GpuSparseLightingAbi.js";
import { createProductionSparseDirectLightingWgsl } from "../../shaders/lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "../../shaders/environment_ibl.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "../../shaders/atmosphere/runtime.js";
import {
  SURFACE_SIGNAL_STORE_COMPUTE_WGSL,
  SURFACE_SIGNAL_STORE_ENTRY_BYTES,
  SURFACE_SIGNAL_STORE_ENTRY_WORDS,
  SURFACE_SIGNAL_STORE_FLAGS_WORD,
  SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD,
  SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD,
  SURFACE_SIGNAL_STORE_STATE_WORD,
  SURFACE_SIGNAL_STORE_STATE,
  SURFACE_SIGNAL_STORE_FLAG,
  SURFACE_SIGNAL_STORE_REQUEST_WORDS,
  SURFACE_SIGNAL_STORE_WAYS
} from "../../gpu/GpuSurfaceSignalStoreAbi.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";
import { surfaceCellReadWgsl, surfaceCellFieldReadWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_PACKET_CONTRACT_WGSL, SURFACE_PACKET_FLAG_SPILL } from "../../gpu/GpuSurfaceSignalPacketAbi.js";

export interface SurfaceLightingProducts {
  readonly signalPublished?: ResourceId;
  readonly packets: ResourceId;
  /** Spill-only full precision values indexed by packet_flags high bits. */
  readonly fullPackets: ResourceId;
  readonly packetFlags: ResourceId;
  readonly counters: ResourceId;
}

export interface SurfaceLightingInput {
  readonly resourceBinding: SurfaceResourceBinding;
  readonly geometryKeys: ResourceId;
  /** Compact material identity/version words; part of every signal key. */
  readonly fieldIdentity: ResourceId;
  readonly revisions: Readonly<{environment:number;light:number;shadow:number;ao?:number}>;
  readonly diagnosticFrame: Readonly<{value:number}>;
  readonly geometry: ResourceId;
  readonly fields: ResourceId;
  readonly cellWorkspace: ResourceId;
  readonly sampleMap: ResourceId;
  readonly cellBatchTiles: number;
  readonly firstTile: number;
  readonly appearanceMetadata: ResourceId;
  readonly constantFieldsOffset: number;
  readonly counts: ResourceId;
  readonly work: ResourceId;
  readonly sampleOffset: number;
  /** GeometryRecord base in vec4 words inside the shared record buffer. */
  readonly geometryOffset: number;
  readonly width: number;
  readonly height: number;
  readonly recordCount: number;
  readonly frame: number;
  readonly camera: ResourceId;
  readonly physicalSun: { readonly parameters: ResourceId; readonly transmittance: ResourceId } | null;
  readonly lightRecords: ResourceId;
  readonly clusters: {
    readonly parameters: ResourceId;
    readonly lookup: ResourceId;
    readonly data: ResourceId;
    readonly activeLightList: ResourceId;
  };
  readonly shadow: {
    readonly virtualPageTable: ResourceId;
    readonly physicalAtlasDepth: ResourceId;
    readonly lightProjection: ResourceId;
    readonly contentVersion: ResourceId;
  } | null;
  readonly scalarAo: ResourceId | null;
  readonly environment: {
    readonly diffuse: ResourceId;
    readonly specular: ResourceId;
    readonly dfg: ResourceId;
  };
  /** Detailed-only producer counters. The packet writes themselves remain
   * production work; diagnostic atomics are compiled behind this flag. */
  readonly diagnosticsEnabled: boolean;
}

/* Reuse the production clustered-light BRDF and VSM branches. The helper
 * deliberately omits its legacy fullscreen entry point and declarations;
 * this pass supplies the smaller packet-oriented binding surface below. */
const DIRECT_MATH = createProductionSparseDirectLightingWgsl(true, "vsm")
  .replace(/\bview\.frame_index\b/g, "shading_view.frame_index")
  .replace(/\bview\.width\b/g, "shading_view.width")
  .replace(/\bview\.height\b/g, "shading_view.height");

export const LIGHTING_WGSL = /* wgsl */ `
${DIRECT_MATH}
${OCTAHEDRAL_SAMPLE_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
@group(0) @binding(2) var<storage,read> fields:array<vec2u>;
${ATMOSPHERE_RUNTIME_WGSL}
${SURFACE_PACKET_CONTRACT_WGSL}

struct SurfaceView { width: u32, height: u32, frame_index: u32, _pad: u32 };
struct SurfaceSettings {
  width: u32, height: u32, record_count: u32, frame: u32,
  sample_offset: u32, light_enabled: u32, environment_enabled: u32, shadow_enabled: u32,
  cluster_enabled: u32, first_tile: u32, constant_fields_offset: u32, geometry_offset: u32,
  diagnostics_enabled: u32, _reserved0: u32, _reserved1: u32, _reserved2: u32,
  environment_revision:u32, light_revision:u32, shadow_revision:u32, ao_revision:u32,
};
@group(0) @binding(0) var<uniform> settings: SurfaceSettings;
@group(0) @binding(1) var<storage, read> geometry: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> packets: array<vec2u>;
@group(0) @binding(4) var<storage, read_write> full_packets: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> packet_flags: array<u32>;
@group(0) @binding(7) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read> surface_counts: array<u32>;
@group(0) @binding(11) var<storage, read> work: array<u32>;
@group(0) @binding(13) var environment_diffuse: texture_2d<f32>;
@group(0) @binding(14) var environment_specular: texture_2d<f32>;
@group(0) @binding(15) var environment_dfg: texture_2d<f32>;
@group(0) @binding(16) var<uniform> physical_sun: PhysicalEnvironmentParameters;
@group(0) @binding(17) var solar_transmittance: texture_2d<f32>;
@group(0) @binding(18) var solar_sampler: sampler;
@group(0) @binding(19) var<storage,read> dirty_queue:array<vec2u>;
@group(0) @binding(20) var<storage,read> cell_plan_words:array<u32>;
@group(0) @binding(21) var sample_map:texture_2d<u32>;
@group(0) @binding(22) var<storage,read> appearance_metadata:array<u32>;
${surfaceCellReadWgsl("settings._reserved1")}
${surfaceCellFieldReadWgsl("settings._reserved1", "settings.first_tile", "((settings.width+7u)/8u)", "settings.constant_fields_offset")}
fn surface_field(record:u32,field:u32)->vec4f {
  let sample_at=settings.sample_offset/4u+record*8u;
  let pixel=vec2u(work[sample_at]%settings.width,work[sample_at]/settings.width);
  return surface_field_at(pixel,field);
}

fn diagnostic_add(index: u32, value: u32) {
  if settings.diagnostics_enabled != 0u { atomicAdd(&counters[index], value); }
}
fn packet_store(record:u32, kind:u32, value:vec4f, semantic:u32) {
  let slot = record * 6u + kind;
  // Non-finite math is an invalid producer result, never a valid HDR packet.
  if any(value!=value) || any(abs(value)>vec4f(3.402823466e38)) {
    atomicOr(&counters[9u], ${SURFACE_WORK_OVERFLOW.signal}u);
    packet_flags[slot]=0u;
    return;
  }
  let spill = any(abs(value) > vec4f(65504.0));
  packets[slot] = vec2u(pack2x16float(value.xy), pack2x16float(value.zw));
  if (spill) {
    full_packets[slot] = value;
    packet_flags[slot] = semantic | SURFACE_PACKET_VALID | SURFACE_PACKET_SPILL | (slot << 8u);
  } else {
    packet_flags[slot] = semantic | SURFACE_PACKET_VALID;
  }
}

@group(1) @binding(0) var<storage, read> node: array<u32>;
@group(1) @binding(2) var<uniform> cluster_parameters: vec3f;
@group(1) @binding(3) var<storage, read> cluster_lookup: array<ClusterMetadata>;
@group(1) @binding(4) var<storage, read> cluster_data: ClusterData;
@group(1) @binding(7) var<storage, read> active_light_list: LightList;

@group(2) @binding(0) var<uniform> shading_view: SurfaceView;
@group(2) @binding(1) var<uniform> camera: CommandEncoder;

@group(3) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(3) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(3) @binding(2) var vsm_atlas_depth: texture_depth_2d;

fn setting(index: u32) -> u32 {
  switch index {
    case 0u: { return settings.width; }
    case 1u: { return settings.height; }
    case 2u: { return settings.record_count; }
    case 3u: { return settings.frame; }
    case 4u: { return settings.sample_offset; }
    case 8u: { return settings.cluster_enabled; }
    case 9u: { return settings.environment_enabled; }
    case 10u: { return 0u; }
    case 7u: { return settings.shadow_enabled; }
    case 11u: { return settings.geometry_offset; }
    default: { return 0u; }
  }
}

fn surface_material(record: u32) -> StandardMaterial {
  let albedo = max(surface_field(record, 0u).xyz, vec3f(0.0));
  let metallic = saturate(surface_field(record, 2u).x);
  let roughness = clamp(surface_field(record, 3u).x, 0.04, 1.0);
  let occlusion = saturate(surface_field(record, 4u).x);
  let emissive = max(surface_field(record, 5u).xyz, vec3f(0.0));
  let specular_weight = saturate(surface_field(record, 8u).x);
  let specular_color = max(surface_field(record, 9u).xyz, vec3f(0.0));
  let coat_factor = saturate(surface_field(record, 10u).x);
  let coat_roughness = clamp(surface_field(record, 11u).x, 0.04, 1.0);
  let coat_raw = surface_field(record, 12u).xyz;
  let coat_normal = select(vec3f(0.0, 0.0, 1.0), normalize(coat_raw), dot(coat_raw, coat_raw) > 1e-8);
  let f0 = mix(vec3f(0.04), albedo, metallic) * specular_weight * specular_color;
  return StandardMaterial(albedo * (1.0 - metallic), roughness, occlusion, f0, 1.0,
    vec3f(1.0), emissive, 1.0, coat_factor, coat_roughness, coat_normal);
}

fn direct_surface(material: StandardMaterial, geometry_in: SurfaceGeometry,
  pixel: vec2f, view_depth: f32) -> ReflectedLight {
  var reflected = ReflectedLight(vec3f(0.0), vec3f(0.0));
  if settings._reserved0 != 0u {
    var solar: GpuPrimitiveTypeTable;
    solar.direction=normalize(physical_sun.sun_direction_world);
    solar.color=atmosphere_sun_irradiance(geometry_in.position,physical_sun,solar_transmittance,solar_sampler);
    if settings.shadow_enabled != 0u {
      solar.color*=vsm_sample_directional(geometry_in.position,geometry_in.shading_normal,solar);
    }
    re_direct_physical(solar,geometry_in,material,&reflected);
  }
  var directional_mask = directional_lights_iteration_mask(&node);
  while (directional_mask != 0u) {
    let index = countTrailingZeros(directional_mask);
    directional_mask &= ~(1u << index);
    var incident = get_directional_light_info_by_index(&node, index);
    incident.color *= shadowmap_get_directional_light_visibility(&node, index,
      geometry_in.position, geometry_in.view_direction, geometry_in.shading_normal);
    re_direct_physical(incident, geometry_in, material, &reflected);
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
        re_direct_physical(incident, geometry_in, material, &reflected);
      } else if (light_type == CLUSTER_LIGHT_TYPE_SPOT) {
        var incident = get_spot_light_info_by_index(&node, index, geometry_in.position);
        incident.color *= shadowmap_get_spot_light_visibility(&node, index,
          geometry_in.position, geometry_in.shading_normal);
        re_direct_physical(incident, geometry_in, material, &reflected);
      }
    }
    return reflected;
  }
  for (var i = 0u; i < metadata.point_count; i++) {
    let index = cluster_data.data[metadata.offset + i];
    var incident = get_point_light_info_by_index(&node, index, geometry_in.position);
    incident.color *= shadowmap_get_point_light_visibility(&node, index,
      geometry_in.position, geometry_in.shading_normal);
    re_direct_physical(incident, geometry_in, material, &reflected);
  }
  for (var i = 0u; i < metadata.spot_count; i++) {
    let index = cluster_data.data[metadata.offset + metadata.point_count + i];
    var incident = get_spot_light_info_by_index(&node, index, geometry_in.position);
    incident.color *= shadowmap_get_spot_light_visibility(&node, index,
      geometry_in.position, geometry_in.shading_normal);
    re_direct_physical(incident, geometry_in, material, &reflected);
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
  if id.x>=surface_counts[0u] {return;}
  let item=dirty_queue[id.x];let record=item.x;let signal_mask=item.y;
  let sample_at=setting(4u)/4u+record*8u;
  let pixel_index=work[sample_at];let base=setting(11u)+work[sample_at+6u]*12u;
  let enabled_mask=work[sample_at+3u];let sample_flags=work[sample_at+7u];
  let pixel=vec2i(i32(pixel_index%setting(0u)),i32(pixel_index/setting(0u)));
  let position=geometry[base].xyz;
  let geometric_normal = normalize(geometry[base + 1u].xyz);
  let shading_normal = normalize(geometry[base + 2u].xyz);
  let tangent = normalize(geometry[base + 5u].xyz);
  let view_dir = normalize(geometry[base + 6u].xyz);
  var material = surface_material(record);
  let normal_valid = surface_field(record, 13u).x > 0.5;
  var normal = shading_normal;
  if normal_valid {
    // Appearance graph publishes signed tangent-space values already.
    let normal_ts = normalize(surface_field(record, 6u).xyz);
    let bitangent = normalize(cross(shading_normal, tangent) * geometry[base + 2u].w);
    normal = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + shading_normal * normal_ts.z);
  }
  let coat_ts=material.coatNormal;
  let coat_bitangent=normalize(cross(shading_normal,tangent)*geometry[base+2u].w);
  material.coatNormal=normalize(tangent*coat_ts.x+coat_bitangent*coat_ts.y+shading_normal*coat_ts.z);
  let surface_geometry = SurfaceGeometry(normal, geometric_normal, position, view_dir);
  if setting(10u) == 0u { diagnostic_add(7u, 1u); }
  let has_diffuse = (signal_mask & 1u) != 0u;
  let has_diffuse_env = (signal_mask & 2u) != 0u;
  let has_specular = (signal_mask & 4u) != 0u;
  let has_specular_env = (signal_mask & 8u) != 0u;
  let has_coat = (signal_mask & 16u) != 0u;
  let has_coat_env = (signal_mask & 32u) != 0u;
  let has_direct = has_diffuse || has_specular || has_coat;
  var direct = ReflectedLight(vec3f(0.0), vec3f(0.0));
  if has_direct {
    direct = direct_surface(material, surface_geometry, vec2f(pixel) + vec2f(0.5),
      abs(geometry[base + 0u].w));
    diagnostic_add(5u, 1u);
    if setting(7u) != 0u { diagnostic_add(18u, 1u); }
    else { diagnostic_add(8u, 1u); }
  }
  var direct_diffuse = vec3f(0.0);
  var direct_specular = vec3f(0.0);
  var coat_direct = vec3f(0.0);
  if has_diffuse {
    direct_diffuse = direct.diffuse * (1.0 - material.coatFactor * 0.25);
    diagnostic_add(0u, 1u);
  } else { diagnostic_add(14u, 1u); }
  if has_specular {
    direct_specular = max(direct.specular - select(vec3f(0.0), direct.specular * material.coatFactor, (enabled_mask&4u)!=0u), vec3f(0.0));
    diagnostic_add(1u, 1u);
  } else { diagnostic_add(15u, 1u); }
  if has_coat {
    coat_direct = direct.specular * material.coatFactor;
    diagnostic_add(2u, 1u);
  } else { diagnostic_add(16u, 1u); }
  var environment_diffuse = vec3f(0.0);
  var environment_specular = vec3f(0.0);
  var coat_ibl = vec3f(0.0);
  if has_diffuse_env {environment_diffuse = environment_diffuse_irradiance(normal);diagnostic_add(3u, 1u);}
  if has_specular_env {environment_specular = environment_specular_surface(material, normal, view_dir);diagnostic_add(6u, 1u);}
  if has_coat_env {coat_ibl = coat_environment(material, material.coatNormal, view_dir);}
  if has_diffuse {packet_store(record,0u,vec4f(direct_diffuse, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_DIFFUSE);diagnostic_add(20u,1u);}
  if has_diffuse_env {packet_store(record,1u,vec4f(environment_diffuse, 1.0),SURFACE_PACKET_IRRADIANCE|SURFACE_PACKET_DIFFUSE|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(21u,1u);}
  if has_specular {packet_store(record,2u,vec4f(direct_specular, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_SPECULAR);diagnostic_add(22u,1u);}
  if has_specular_env {packet_store(record,3u,vec4f(environment_specular, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_SPECULAR|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(23u,1u);}
  if has_coat {packet_store(record,4u,vec4f(coat_direct, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_COAT);diagnostic_add(24u,1u);}
  if has_coat_env {packet_store(record,5u,vec4f(coat_ibl, 1.0),SURFACE_PACKET_RADIANCE|SURFACE_PACKET_COAT|SURFACE_PACKET_ENVIRONMENT);diagnostic_add(25u,1u);}
  diagnostic_add(10u, countOneBits(signal_mask) * 16u);
  if (sample_flags & 2u) != 0u { diagnostic_add(4u, 1u); }
}
`;
