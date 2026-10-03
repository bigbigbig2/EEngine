import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_WORK_INDIRECT_OFFSET, SURFACE_WORK_OVERFLOW } from "../../gpu/GpuSurfaceWorkAbi.js";
import { APPEARANCE_SURFACE_READ_WGSL } from "../../gpu/GpuAppearanceCacheAbi.js";
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
  SURFACE_SIGNAL_STORE_FLAG,
  SURFACE_SIGNAL_STORE_REQUEST_WORDS,
  SURFACE_SIGNAL_STORE_WAYS
} from "../../gpu/GpuSurfaceSignalStoreAbi.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";

export interface SurfaceLightingProducts {
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

const LIGHTING_WGSL = /* wgsl */ `
${DIRECT_MATH}
${OCTAHEDRAL_SAMPLE_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${APPEARANCE_SURFACE_READ_WGSL}
${ATMOSPHERE_RUNTIME_WGSL}

struct SurfaceView { width: u32, height: u32, frame_index: u32, _pad: u32 };
struct SurfaceSettings {
  width: u32, height: u32, record_count: u32, frame: u32,
  sample_offset: u32, light_enabled: u32, environment_enabled: u32, shadow_enabled: u32,
  cluster_enabled: u32, _environment_enabled_2: u32, ao_enabled: u32, geometry_offset: u32,
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
@group(0) @binding(12) var<storage, read> scalar_ao: array<u32>;
@group(0) @binding(13) var environment_diffuse: texture_2d<f32>;
@group(0) @binding(14) var environment_specular: texture_2d<f32>;
@group(0) @binding(15) var environment_dfg: texture_2d<f32>;
@group(0) @binding(16) var<uniform> physical_sun: PhysicalEnvironmentParameters;
@group(0) @binding(17) var solar_transmittance: texture_2d<f32>;
@group(0) @binding(18) var solar_sampler: sampler;
@group(0) @binding(19) var<storage,read> dirty_queue:array<vec2u>;

fn diagnostic_add(index: u32, value: u32) {
  if settings.diagnostics_enabled != 0u { atomicAdd(&counters[index], value); }
}
fn packet_store(record:u32, kind:u32, value:vec4f) {
  let slot = record * 6u + kind;
  let spill = any(abs(value) > vec4f(65504.0)) || any(value != value);
  packets[slot] = vec2u(pack2x16float(value.xy), pack2x16float(value.zw));
  if (spill) {
    let spill_index = atomicAdd(&counters[25u], 1u);
    if (spill_index < settings._reserved2) {
      full_packets[spill_index] = value;
      packet_flags[slot] = ${SURFACE_SIGNAL_STORE_FLAG.valid | SURFACE_SIGNAL_STORE_FLAG.spill}u | (spill_index << 8u);
    } else {
      atomicOr(&counters[9u], ${SURFACE_WORK_OVERFLOW.signal}u);
      packet_flags[slot] = ${SURFACE_SIGNAL_STORE_FLAG.valid}u;
    }
  } else {
    packet_flags[slot] = ${SURFACE_SIGNAL_STORE_FLAG.valid}u;
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
    case 10u: { return settings.ao_enabled; }
    case 7u: { return settings.shadow_enabled; }
    case 11u: { return settings.geometry_offset; }
    default: { return 0u; }
  }
}
fn ao_at(pixel_index: u32) -> f32 {
  if setting(10u) == 0u { return 1.0; }
  let packed = scalar_ao[pixel_index >> 2u];
  return f32((packed >> ((pixel_index & 3u) * 8u)) & 0xffu) * (1.0 / 255.0);
}

fn surface_material(record: u32) -> StandardMaterial {
  let albedo = max(surface_field(record, 0u).xyz, vec3f(0.0));
  let metallic = saturate(surface_field(record, 2u).x);
  let roughness = clamp(surface_field(record, 3u).x, 0.04, 1.0);
  let occlusion = saturate(surface_field(record, 4u).x);
  let emissive = max(surface_field(record, 5u).xyz, vec3f(0.0));
  let specular_weight = saturate(surface_field(record, 8u).x);
  let specular_color = max(surface_field(record, 9u).xyz, vec3f(1.0));
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

fn environment_diffuse_surface(material: StandardMaterial, normal: vec3f, ao: f32) -> vec3f {
  let diffuse_env = sample_octahedral_bilinear(environment_diffuse, vec2u(0u),
    textureDimensions(environment_diffuse).x, normal, 0u).rgb;
  return diffuse_env * material.diffuse * material.occlusion * ao * RECIPROCAL_PI;
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
  let position=geometry[base].xyz;let ao=ao_at(pixel_index);
  let geometric_normal = normalize(geometry[base + 1u].xyz);
  let shading_normal = normalize(geometry[base + 2u].xyz);
  let tangent = normalize(geometry[base + 5u].xyz);
  let view_dir = normalize(geometry[base + 6u].xyz);
  let material = surface_material(record);
  let normal_valid = surface_field(record, 13u).x > 0.5;
  var normal = shading_normal;
  if normal_valid {
    let normal_ts = normalize(surface_field(record, 6u).xyz * 2.0 - vec3f(1.0));
    let bitangent = normalize(cross(shading_normal, tangent) * geometry[base + 2u].w);
    normal = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + shading_normal * normal_ts.z);
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
  if has_diffuse_env {environment_diffuse = environment_diffuse_surface(material, normal, ao);diagnostic_add(3u, 1u);}
  if has_specular_env {environment_specular = environment_specular_surface(material, normal, view_dir);diagnostic_add(6u, 1u);}
  if has_coat_env {coat_ibl = coat_environment(material, normal, view_dir);}
  if has_diffuse {packet_store(record,0u,vec4f(direct_diffuse, 1.0));diagnostic_add(20u,1u);}
  if has_diffuse_env {packet_store(record,1u,vec4f(environment_diffuse + material.emissive, 1.0));diagnostic_add(21u,1u);}
  if has_specular {packet_store(record,2u,vec4f(direct_specular, 1.0));diagnostic_add(22u,1u);}
  if has_specular_env {packet_store(record,3u,vec4f(environment_specular, 1.0));diagnostic_add(23u,1u);}
  if has_coat {packet_store(record,4u,vec4f(coat_direct, 1.0));diagnostic_add(24u,1u);}
  if has_coat_env {packet_store(record,5u,vec4f(coat_ibl, 1.0));diagnostic_add(25u,1u);}
  diagnostic_add(10u, countOneBits(signal_mask) * 16u);
  if (sample_flags & 2u) != 0u { diagnostic_add(4u, 1u); }
}
`;

const LIGHTING_PLAN_WGSL = /* wgsl */ `
struct SurfaceSettings {
  width: u32, height: u32, record_count: u32, frame: u32,
  sample_offset: u32, light_enabled: u32, environment_enabled: u32, shadow_enabled: u32,
  cluster_enabled: u32, _environment_enabled_2: u32, ao_enabled: u32, geometry_offset: u32,
  diagnostics_enabled: u32, _reserved0: u32, _reserved1: u32, _reserved2: u32,
  environment_revision:u32, light_revision:u32, shadow_revision:u32, _revision_pad:u32,
};

@group(0) @binding(0) var<uniform> settings:SurfaceSettings;
@group(0) @binding(1) var<storage,read> geometry:array<vec4f>;
@group(0) @binding(2) var<storage,read> work:array<u32>;
@group(0) @binding(3) var<storage,read> surface_counts:array<u32>;
@group(0) @binding(4) var<storage,read> scalar_ao:array<u32>;
@group(0) @binding(5) var<storage,read> geometry_keys:array<u32>;
@group(0) @binding(6) var<storage,read_write> signal_store_entries:array<atomic<u32>>;
@group(0) @binding(7) var<storage,read_write> packets:array<vec2u>;
@group(0) @binding(8) var<storage,read_write> dirty_queue:array<vec2u>;
@group(0) @binding(9) var<storage,read_write> dirty_counts:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(11) var<storage,read> field_identity:array<u32>;
@group(0) @binding(12) var<storage,read_write> publish_mask:array<u32>;
@group(0) @binding(13) var<storage,read_write> full_packets:array<vec4f>;
@group(0) @binding(14) var<storage,read_write> packet_flags:array<u32>;
fn diagnostic_add(index:u32,value:u32){if settings.diagnostics_enabled!=0u{atomicAdd(&counters[index],value);}}
fn setting(index: u32) -> u32 {
  switch index {
    case 0u: { return settings.width; }
    case 1u: { return settings.height; }
    case 2u: { return settings.record_count; }
    case 3u: { return settings.frame; }
    case 4u: { return settings.sample_offset; }
    case 8u: { return settings.cluster_enabled; }
    case 9u: { return settings.environment_enabled; }
    case 10u: { return settings.ao_enabled; }
    case 7u: { return settings.shadow_enabled; }
    case 11u: { return settings.geometry_offset; }
    default: { return 0u; }
  }
}
fn ao_at(pixel_index: u32) -> f32 {
  if setting(10u) == 0u { return 1.0; }
  let packed = scalar_ao[pixel_index >> 2u];
  return f32((packed >> ((pixel_index & 3u) * 8u)) & 0xffu) * (1.0 / 255.0);
}
fn signal_key_word(record:u32,kind:u32,word:u32)->u32 {
  let geometry_base=record*13u;
  switch word {
    case 0u:{return geometry_keys[geometry_base+12u];}
    case 1u:{return geometry_keys[geometry_base+0u];}
    case 2u:{return geometry_keys[geometry_base+1u];}
    case 3u:{return geometry_keys[geometry_base+2u];}
    case 4u:{return geometry_keys[geometry_base+3u];}
    case 5u:{return kind;}
    case 6u:{return settings.environment_revision;}
    case 7u:{return settings.light_revision;}
    case 8u:{return settings.shadow_revision;}
    case 9u:{var h=2166136261u;let sample_at=settings.sample_offset/4u+record*8u;for(var i=0u;i<19u;i++){h=(h^field_identity[record*19u+i])*16777619u;}h=(h^settings.ao_revision)*16777619u;h=(h^work[sample_at+2u])*16777619u;return h;}
    default:{return 0u;}
  }
}
fn signal_store_probe(record:u32,kind:u32)->u32 {
  var hash=2166136261u;for(var word=0u;word<10u;word++){hash=(hash^signal_key_word(record,kind,word))*16777619u;}
  var set_count=1u; if arrayLength(&signal_store_entries)>=${SURFACE_SIGNAL_STORE_ENTRY_WORDS * SURFACE_SIGNAL_STORE_WAYS}u { set_count=arrayLength(&signal_store_entries)/${SURFACE_SIGNAL_STORE_ENTRY_WORDS * SURFACE_SIGNAL_STORE_WAYS}u; }
  let set_index=hash%set_count;
  for(var way=0u;way<4u;way++){
    let entry=set_index*4u+way;let at=entry*${SURFACE_SIGNAL_STORE_ENTRY_WORDS}u;var equal=true;
    for(var word=0u;word<10u;word++){if atomicLoad(&signal_store_entries[at+word])!=signal_key_word(record,kind,word){equal=false;break;}}
    if equal && (atomicLoad(&signal_store_entries[at+${SURFACE_SIGNAL_STORE_FLAGS_WORD}u])&${SURFACE_SIGNAL_STORE_FLAG.valid}u)!=0u{
      let previous=atomicCompareExchangeWeak(&signal_store_entries[at+${SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD}u],settings.frame,settings.frame);
      if !previous.exchanged && previous.old_value!=settings.frame {
        let packed=atomicLoad(&signal_store_entries[at+${SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD}u]);
        let age=min(packed&0xffffu,0xfffeu)+1u;let confidence=packed>>16u;
        let decayed=select(confidence,confidence-1024u,confidence>1024u);
        atomicStore(&signal_store_entries[at+${SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD}u],(decayed<<16u)|age);
      }
      return entry;
    }
  }
  return 0xffffffffu;
}
fn packet_load_store(record:u32,kind:u32,entry:u32){
  let at=entry*${SURFACE_SIGNAL_STORE_ENTRY_WORDS}u;let slot=record*6u+kind;
  let flags=atomicLoad(&signal_store_entries[at+${SURFACE_SIGNAL_STORE_FLAGS_WORD}u]);
  if (flags&${SURFACE_SIGNAL_STORE_FLAG.spill}u)!=0u {
    let bits=vec4u(atomicLoad(&signal_store_entries[at+10u]),atomicLoad(&signal_store_entries[at+11u]),atomicLoad(&signal_store_entries[at+12u]),atomicLoad(&signal_store_entries[at+13u]));
    let spill_index=atomicAdd(&counters[25u],1u);
    if(spill_index<settings._reserved2){full_packets[spill_index]=bitcast<vec4f>(bits);packet_flags[slot]=${SURFACE_SIGNAL_STORE_FLAG.valid | SURFACE_SIGNAL_STORE_FLAG.spill}u|(spill_index<<8u);}
    packets[slot]=vec2u(pack2x16float(bitcast<vec4f>(bits).xy),pack2x16float(bitcast<vec4f>(bits).zw));
  } else {
    packets[slot]=vec2u(atomicLoad(&signal_store_entries[at+10u]),atomicLoad(&signal_store_entries[at+11u]));
    packet_flags[slot]=${SURFACE_SIGNAL_STORE_FLAG.valid}u;
  }
}


fn classify_record(record:u32)->u32 {
  if record >= setting(2u) || record >= surface_counts[0u] { return 0u; }
  let sample_at = setting(4u) / 4u + record * 8u;
  let pixel_index = work[sample_at];
  let base = setting(11u) + work[sample_at+6u] * 12u;
  let enabled_mask = work[sample_at + 3u];
  var signal_mask=enabled_mask;
  let sample_flags = work[sample_at + 7u];
  let pixel = vec2i(i32(pixel_index % setting(0u)), i32(pixel_index / setting(0u)));
  if geometry[base + 1u].w < 0.5 {
    for(var clear_kind=0u;clear_kind<6u;clear_kind++){packets[record*6u+clear_kind]=vec2u(0u);packet_flags[record*6u+clear_kind]=0u;}
    publish_mask[record]=0u;
    diagnostic_add(20u,1u);diagnostic_add(21u,1u);diagnostic_add(22u,1u);diagnostic_add(23u,1u);diagnostic_add(24u,1u);diagnostic_add(25u,1u);
    diagnostic_add(13u, 1u);
    return 0u;
  }
  diagnostic_add(12u,1u);
  let ao=ao_at(pixel_index);
  // A representative slot is reused across frames. Clear all six packet
  // lanes before loading sparse hits so disabled or rejected lobes cannot
  // expose a previous record's value to reconstruct.
  for(var clear_kind=0u;clear_kind<6u;clear_kind++){packets[record*6u+clear_kind]=vec2u(0u);packet_flags[record*6u+clear_kind]=0u;}
  for(var kind=0u;kind<6u;kind++){let bit=1u<<kind;if (enabled_mask&bit)!=0u {let hit=signal_store_probe(record,kind);if(hit!=0xffffffffu){packet_load_store(record,kind,hit);signal_mask &= ~bit;diagnostic_add(11u,1u);}}}
  publish_mask[record]=signal_mask;
  return signal_mask;

}
var<workgroup> masks:array<u32,64>;
var<workgroup> offsets:array<u32,64>;
var<workgroup> group_base:u32;
@compute @workgroup_size(64) fn plan(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32){
  let mask=classify_record(id.x);masks[lane]=mask;
  workgroupBarrier();
  if lane==0u {
    var count=0u;for(var i=0u;i<64u;i++){offsets[i]=count;count+=select(0u,1u,masks[i]!=0u);}
    group_base=0u;if count!=0u {group_base=atomicAdd(&dirty_counts[0],count);}
  }
  workgroupBarrier();
  if mask!=0u {dirty_queue[group_base+offsets[lane]]=vec2u(id.x,mask);}
}
`;
const LIGHTING_FINALIZE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(1) fn finalize(){counts[4]=(counts[0]+63u)/64u;counts[5]=1u;counts[6]=1u;}
`;
const SIGNAL_PACK_WGSL = /* wgsl */ `
struct Settings { record_count:u32, environment_revision:u32, light_revision:u32, shadow_revision:u32, ao_revision:u32, sample_offset:u32, frame:u32 }
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> geometry_keys:array<u32>;
@group(0) @binding(2) var<storage,read> work:array<u32>;
@group(0) @binding(3) var<storage,read> packets:array<vec2u>;
@group(0) @binding(4) var<storage,read_write> requests:array<u32>;
@group(0) @binding(5) var<storage,read> field_identity:array<u32>;
@group(0) @binding(6) var<storage,read> publish_mask:array<u32>;
@group(0) @binding(7) var<storage,read> full_packets:array<vec4f>;
@group(0) @binding(8) var<storage,read> packet_flags:array<u32>;
fn key_word(record:u32,kind:u32,word:u32)->u32{switch word{case 0u:{return geometry_keys[record*13u+12u];}case 1u:{return geometry_keys[record*13u];}case 2u:{return geometry_keys[record*13u+1u];}case 3u:{return geometry_keys[record*13u+2u];}case 4u:{return geometry_keys[record*13u+3u];}case 5u:{return kind;}case 6u:{return settings.environment_revision;}case 7u:{return settings.light_revision;}case 8u:{return settings.shadow_revision;}case 9u:{var h=2166136261u;for(var i=0u;i<19u;i++){h=(h^field_identity[record*19u+i])*16777619u;}h=(h^settings.ao_revision)*16777619u;h=(h^work[settings.sample_offset/4u+record*8u+2u])*16777619u;return h;}default:{return 0u;}}}
@compute @workgroup_size(64) fn pack(@builtin(global_invocation_id) id:vec3u){let request=id.x;let record=request/6u;let kind=request%6u;if(record>=settings.record_count){return;}let target=request*${SURFACE_SIGNAL_STORE_REQUEST_WORDS}u;let bit=1u<<kind;let enabled=(work[settings.sample_offset/4u+record*8u+3u]&bit)!=0u;let publish=(publish_mask[record]&bit)!=0u;let valid_key=geometry_keys[record*13u+12u]!=0xffffffffu;if(!enabled||!publish||!valid_key){requests[target]=0xffffffffu;return;}for(var word=0u;word<10u;word++){requests[target+word]=key_word(record,kind,word);}let flags=packet_flags[record*6u+kind];if((flags&${SURFACE_SIGNAL_STORE_FLAG.spill}u)!=0u){let value=full_packets[flags>>8u];let bits=bitcast<vec4u>(value);for(var payload=0u;payload<4u;payload++){requests[target+10u+payload]=bits[payload];}}else{let packed=packets[record*6u+kind];requests[target+10u]=packed.x;requests[target+11u]=packed.y;requests[target+12u]=0u;requests[target+13u]=0u;}requests[target+14u]=flags;requests[target+15u]=settings.frame;requests[target+16u]=0xffff0000u;requests[target+17u]=0u;requests[target+18u]=0u;requests[target+19u]=0u;}
`;

export class SurfaceLightingWorkPass {
  private readonly planPipeline:GPUComputePipeline;
  private readonly finalizePipeline:GPUComputePipeline;
  private readonly layout: GPUBindGroupLayout;
  private readonly lightLayout: GPUBindGroupLayout;
  private readonly cameraLayout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly viewBuffer: GPUBuffer;
  private readonly solarSampler: GPUSampler;
  private readonly signalStorePackPipeline: GPUComputePipeline;
  private readonly signalStoreResetPipeline: GPUComputePipeline;
  private readonly signalStorePublishPipeline: GPUComputePipeline;
  private readonly signalStoreSettings: GPUBuffer;
  private readonly signalPackSettings: GPUBuffer;
  private signalStoreInitialized = false;

  constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources,
    private readonly signalStore: GpuSurfaceSignalStore | null = null) {
    this.planPipeline=device.createComputePipeline({label:"Surface/lighting classify",layout:"auto",compute:{module:device.createShaderModule({code:LIGHTING_PLAN_WGSL}),entryPoint:"plan"}});
    this.finalizePipeline=device.createComputePipeline({label:"Surface/lighting finalize",layout:"auto",compute:{module:device.createShaderModule({code:LIGHTING_FINALIZE_WGSL}),entryPoint:"finalize"}});
    this.solarSampler = device.createSampler({ label: "Surface solar transmittance", minFilter: "linear", magFilter: "linear" });
    this.settings = device.createBuffer({ label: "Surface lighting settings", size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBuffer = device.createBuffer({ label: "Surface lighting view", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.signalStoreSettings = device.createBuffer({ label: "Surface/SignalStore settings", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.signalPackSettings = device.createBuffer({ label: "Surface/SignalStore request pack settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.signalStorePackPipeline = device.createComputePipeline({ label: "Surface/SignalStore request pack", layout: "auto", compute: { module: device.createShaderModule({ code: SIGNAL_PACK_WGSL }), entryPoint: "pack" } });
    const signalStoreModule = device.createShaderModule({ label: "Surface/SignalStore lookup and publish", code: SURFACE_SIGNAL_STORE_COMPUTE_WGSL });
    this.signalStoreResetPipeline = device.createComputePipeline({ label: "Surface/SignalStore reset", layout: "auto", compute: { module: signalStoreModule, entryPoint: "surface_signal_store_reset" } });
    this.signalStorePublishPipeline = device.createComputePipeline({ label: "Surface/SignalStore publish", layout: "auto", compute: { module: signalStoreModule, entryPoint: "surface_signal_store_publish" } });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 80 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ...[13, 14, 15].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d" as GPUTextureViewDimension } })),
      { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      { binding: 17, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 18, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      {binding:19,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}}
    ] });
    this.lightLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.cameraLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 256 } }
    ] });
    this.shadowLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 208 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth", viewDimension: "2d" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/lighting signal packets",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.lightLayout, this.cameraLayout, this.shadowLayout] }),
      compute: { module: device.createShaderModule({ code: LIGHTING_WGSL }), entryPoint: "build" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceLightingInput): SurfaceLightingProducts {
    let packets!: ResourceId, fullPackets!: ResourceId, packetFlags!: ResourceId, publishMask!: ResourceId, counters!: ResourceId;
    let dispatchIndirect!: ResourceId;
    let dirtyCounts!:ResourceId;
    let dirtyQueue=this.scratch.importBuffer(graph,input.resourceBinding,"Surface/dirty lighting queue",input.recordCount*8,GPUBufferUsage.STORAGE);
    const signalStoreBuffer = this.signalStore === null
      ? this.scratch.importBuffer(graph,input.resourceBinding,"Surface/SignalStore disabled entries",256,GPUBufferUsage.STORAGE)
      : graph.import_resource("Surface/SignalStore entries",{kind:"imported",label:"Surface/SignalStore entries",domain:"internal-full"},input.resourceBinding("surface-signal-store",()=>this.signalStore!.buffers[0]!));
    let shadowConstantsId!: ResourceId, shadowPageTableId!: ResourceId, shadowAtlasId!: ResourceId;
    const node = graph.add("Surface/independent lighting packets", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = new Uint32Array([
        data.width, data.height, data.recordCount, data.frame, data.sampleOffset,
        1, 1, data.shadow === null ? 0 : 1,
        1, 1, data.scalarAo === null ? 0 : 1, data.geometryOffset,
        data.diagnosticsEnabled ? 1 : 0, data.physicalSun === null ? 0 : 1, 0,
        Math.max(1, Math.ceil(data.recordCount * 6 / 8)), data.revisions.environment, data.revisions.light, data.revisions.shadow, data.revisions.ao ?? 0]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      const initialCounters = new Uint32Array(SPARSE_LIGHTING_COUNTER_WORDS);
      initialCounters[11] = 1;
      command.writeBuffer(resources.get(counters) as GPUBuffer, 0,
        initialCounters.buffer, 0, SPARSE_LIGHTING_COUNTER_BYTES);
      const buffer = (id: ResourceId): GPUBuffer => resources.get(id) as GPUBuffer;
      const group0 = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: { buffer: buffer(data.geometry) } },
        { binding: 2, resource: { buffer: buffer(data.fields) } },
        { binding: 3, resource: { buffer: buffer(packets) } },
        { binding: 4, resource: { buffer: buffer(fullPackets) } },
        { binding: 5, resource: { buffer: buffer(packetFlags) } },
        { binding: 7, resource: { buffer: buffer(counters) } }, { binding: 10, resource: { buffer: buffer(dirtyCounts) } },
        { binding: 11, resource: { buffer: buffer(data.work) } }, { binding: 12, resource: { buffer: buffer(data.scalarAo ?? data.counts) } },
        { binding: 13, resource: resolveTextureView(resources.get(data.environment.diffuse)) },
        { binding: 14, resource: resolveTextureView(resources.get(data.environment.specular)) },
        { binding: 15, resource: resolveTextureView(resources.get(data.environment.dfg)) },
        { binding: 16, resource: { buffer: buffer(data.physicalSun?.parameters ?? data.camera) } },
        { binding: 17, resource: resolveTextureView(resources.get(data.physicalSun?.transmittance ?? data.environment.diffuse)) },
        { binding: 18, resource: this.solarSampler },
        {binding:19,resource:{buffer:buffer(dirtyQueue)}}
      ] });
      const group1 = this.device.createBindGroup({ layout: this.lightLayout, entries: [
        { binding: 0, resource: { buffer: buffer(data.lightRecords) } },
        { binding: 2, resource: { buffer: buffer(data.clusters.parameters) } },
        { binding: 3, resource: { buffer: buffer(data.clusters.lookup) } },
        { binding: 4, resource: { buffer: buffer(data.clusters.data) } },
        { binding: 7, resource: { buffer: buffer(data.clusters.activeLightList) } }
      ] });
      const view = new Uint32Array([data.width, data.height, data.diagnosticFrame.value, 0]);
      command.writeBuffer(this.viewBuffer, 0, view.buffer, 0, 16);
      const cameraBuffer = buffer(data.camera);
      const group2 = this.device.createBindGroup({ layout: this.cameraLayout, entries: [
        { binding: 0, resource: { buffer: this.viewBuffer } }, { binding: 1, resource: { buffer: cameraBuffer } }
      ] });
      const shadow = data.shadow;
      const shadowConstants = buffer(shadowConstantsId);
      const pageTable = buffer(shadowPageTableId);
      const atlas = resources.get(shadowAtlasId);
      const group3 = this.device.createBindGroup({ layout: this.shadowLayout, entries: [
        { binding: 0, resource: { buffer: shadowConstants } },
        { binding: 1, resource: { buffer: pageTable } },
        { binding: 2, resource: resolveTextureView(atlas) }
      ] });
      if (shadow === null) {
        command.writeBuffer(shadowConstants, 0, new Uint32Array(32).buffer, 0, 128);
        command.writeBuffer(pageTable, 0, new Uint32Array(8).buffer, 0, 32);
      }
      command.gpu_encoder.clearBuffer(resources.get(publishMask) as GPUBuffer, 0, data.recordCount * 4);
      command.gpu_encoder.copyBufferToBuffer(buffer(data.counts), SURFACE_WORK_INDIRECT_OFFSET, resources.get(dispatchIndirect) as GPUBuffer, 0, 16);
      command.writeBuffer(buffer(dirtyCounts),0,new Uint32Array(8).buffer,0,32);
      const planIds=[data.geometry,data.work,data.counts,data.scalarAo??data.counts,data.geometryKeys,signalStoreBuffer,
        packets,dirtyQueue,dirtyCounts,counters,data.fieldIdentity,publishMask,fullPackets,packetFlags];
      const planGroup=this.device.createBindGroup({layout:this.planPipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.settings}},...planIds.map((id,index)=>({binding:index+1,resource:{buffer:buffer(id)}}))]});
      const planner=command.beginComputePass({label:"Surface/lighting classify"});planner.setPipeline(this.planPipeline);planner.setBindGroup(0,planGroup);
      planner.dispatchWorkgroupsIndirect(buffer(dispatchIndirect),0);planner.end();
      const finalizeGroup=this.device.createBindGroup({layout:this.finalizePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:buffer(dirtyCounts)}}]});
      const finalize=command.beginComputePass({label:"Surface/lighting finalize"});finalize.setPipeline(this.finalizePipeline);finalize.setBindGroup(0,finalizeGroup);finalize.dispatchWorkgroups(1);finalize.end();
      command.gpu_encoder.copyBufferToBuffer(buffer(dirtyCounts),16,buffer(dispatchIndirect),0,16);
      const pass = command.beginComputePass({ label: "Surface/lighting packets" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group0); pass.setBindGroup(1, group1);
      pass.setBindGroup(2, group2); pass.setBindGroup(3, group3);
      pass.dispatchWorkgroupsIndirect(resources.get(dispatchIndirect) as GPUBuffer, 0); pass.end();
    });
    dirtyCounts=node.create("Surface/dirty lighting count",{kind:"transient_buffer",size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    dirtyQueue=node.write(dirtyQueue);
    node.read(input.geometryKeys); node.read(input.fieldIdentity); node.read(signalStoreBuffer); node.write(signalStoreBuffer);
    node.read(input.geometry); node.read(input.fields); node.read(input.counts); node.read(input.work);
    node.read(input.lightRecords); node.read(input.clusters.parameters); node.read(input.clusters.lookup);
    if (input.physicalSun !== null) { node.read(input.physicalSun.parameters); node.read(input.physicalSun.transmittance); }
    node.read(input.clusters.data); node.read(input.clusters.activeLightList);
    if (input.shadow !== null) { shadowConstantsId = input.shadow.lightProjection; shadowPageTableId = input.shadow.virtualPageTable; shadowAtlasId = input.shadow.physicalAtlasDepth; node.read(input.shadow.virtualPageTable); node.read(input.shadow.physicalAtlasDepth); node.read(input.shadow.lightProjection); }
    else {
      shadowConstantsId = node.create("Surface/VSM fallback constants", { kind: "transient_buffer", size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, domain: "internal-full" });
      shadowPageTableId = node.create("Surface/VSM fallback page table", { kind: "transient_buffer", size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, domain: "internal-full" });
      shadowAtlasId = node.create("Surface/VSM fallback atlas", { kind: "transient_texture", width: 1, height: 1, format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, domain: "internal-full" });
      node.write(shadowConstantsId); node.write(shadowPageTableId); node.write(shadowAtlasId);
    }
    if (input.scalarAo !== null) node.read(input.scalarAo);
    node.read(input.environment.diffuse); node.read(input.environment.specular); node.read(input.environment.dfg);
    const bytes = Math.max(8, input.recordCount * 6 * 8);
    const spillCapacity = Math.max(1, Math.ceil(input.recordCount * 6 / 8));
    const fullBytes = spillCapacity * 16;
    dispatchIndirect = node.create("Surface/lighting dispatch indirect", { kind: "transient_buffer", size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    node.write(dispatchIndirect);
    packets = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/compact signal packets", bytes, GPUBufferUsage.STORAGE);
    fullPackets = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/precision signal values", fullBytes, GPUBufferUsage.STORAGE);
    packetFlags = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/signal packet flags", Math.max(4, input.recordCount * 6 * 4), GPUBufferUsage.STORAGE);
    publishMask = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/signal publish mask", Math.max(4, input.recordCount * 4), GPUBufferUsage.STORAGE);
    counters = node.create("Surface/lighting counters", { kind: "transient_buffer", size: SPARSE_LIGHTING_COUNTER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    node.read(packets); packets = node.write(packets);
    node.read(fullPackets); fullPackets = node.write(fullPackets);
    node.read(packetFlags); packetFlags = node.write(packetFlags);
    node.read(publishMask); publishMask = node.write(publishMask);
    node.write(counters);
    if (this.signalStore !== null) {
      const storeEntries = this.signalStore.capacity.segmentBytes[0]! / SURFACE_SIGNAL_STORE_ENTRY_BYTES;
      const initialization = !this.signalStoreInitialized ? graph.add("Surface/SignalStore initialize", { signalStoreBuffer, storeEntries }, (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        command.writeBuffer(this.signalStoreSettings, 0, new Uint32Array([0, data.storeEntries, 1, 0]).buffer, 0, 16);
        const group = this.device.createBindGroup({ layout: this.signalStoreResetPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.signalStoreSettings } }, { binding: 2, resource: { buffer: resources.get(data.signalStoreBuffer) as GPUBuffer } }
        ] });
        const pass = command.beginComputePass({ label: "Surface/SignalStore initialize" }); pass.setPipeline(this.signalStoreResetPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(data.storeEntries / 64)); pass.end();
        command.onFinished.addOne(() => { this.signalStoreInitialized = true; }); command.onAborted?.addOne(() => { this.signalStoreInitialized = false; });
      }) : null;
      if (initialization !== null) { initialization.read(signalStoreBuffer); initialization.write(signalStoreBuffer); node.dependsOn(initialization); }
      const requestCount = Math.max(1, input.recordCount * 6);
      let requests!: ResourceId, storeCounters!: ResourceId;
      const publish = graph.add("Surface/SignalStore publish after lighting", { recordCount: input.recordCount, requestCount, storeEntries, sampleOffset: input.sampleOffset, frame: input.frame, revisions: input.revisions, signalStoreBuffer, packets, fullPackets, packetFlags, publishMask, geometryKeys: input.geometryKeys, fieldIdentity: input.fieldIdentity, work: input.work }, (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        command.writeBuffer(this.signalPackSettings, 0, new Uint32Array([data.recordCount, data.revisions.environment, data.revisions.light, data.revisions.shadow, data.revisions.ao ?? 0, data.sampleOffset, data.frame]).buffer, 0, 28);
        const packGroup = this.device.createBindGroup({ layout: this.signalStorePackPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.signalPackSettings } }, { binding: 1, resource: { buffer: resources.get(data.geometryKeys) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.work) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(data.packets) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(requests) as GPUBuffer } }, { binding: 5, resource: { buffer: resources.get(data.fieldIdentity) as GPUBuffer } },
          { binding: 6, resource: { buffer: resources.get(data.publishMask) as GPUBuffer } },
          { binding: 7, resource: { buffer: resources.get(data.fullPackets) as GPUBuffer } },
          { binding: 8, resource: { buffer: resources.get(data.packetFlags) as GPUBuffer } }
        ] });
        const packPass = command.beginComputePass({ label: "Surface/SignalStore request pack" }); packPass.setPipeline(this.signalStorePackPipeline); packPass.setBindGroup(0, packGroup); packPass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); packPass.end();
        command.writeBuffer(this.signalStoreSettings, 0, new Uint32Array([data.requestCount, data.storeEntries, this.signalStore!.stats().generation, 0]).buffer, 0, 16);
        command.gpu_encoder.clearBuffer(resources.get(storeCounters) as GPUBuffer, 0, 32);
        const publishGroup = this.device.createBindGroup({ layout: this.signalStorePublishPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.signalStoreSettings } }, { binding: 1, resource: { buffer: resources.get(requests) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.signalStoreBuffer) as GPUBuffer } }, { binding: 4, resource: { buffer: resources.get(storeCounters) as GPUBuffer } }
        ] });
        const publishPass = command.beginComputePass({ label: "Surface/SignalStore publish" }); publishPass.setPipeline(this.signalStorePublishPipeline); publishPass.setBindGroup(0, publishGroup); publishPass.dispatchWorkgroups(Math.ceil(data.requestCount / 64)); publishPass.end();
      });
      requests = publish.create("Surface/SignalStore requests", { kind: "transient_buffer", size: requestCount * SURFACE_SIGNAL_STORE_REQUEST_WORDS * 4, usage: GPUBufferUsage.STORAGE });
      storeCounters = publish.create("Surface/SignalStore counters", { kind: "transient_buffer", size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      publish.read(input.geometryKeys); publish.read(input.fieldIdentity); publish.read(input.work); publish.read(packets); publish.read(fullPackets); publish.read(packetFlags); publish.read(publishMask); publish.read(signalStoreBuffer); publish.write(requests); publish.write(storeCounters); publish.write(signalStoreBuffer); publish.dependsOn(node); publish.make_side_effect();
    }
    return { packets, fullPackets, packetFlags, counters };
  }

  destroy(): void { this.signalStoreInitialized = false; this.settings.destroy(); this.viewBuffer.destroy(); this.signalStoreSettings.destroy(); this.signalPackSettings.destroy(); }
}
