import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import { APPEARANCE_SURFACE_READ_WGSL } from "../../gpu/GpuAppearanceCacheAbi.js";
import { SPARSE_LIGHTING_COUNTER_BYTES, SPARSE_LIGHTING_COUNTER_WORDS } from "../../gpu/GpuSparseLightingAbi.js";
import { createProductionSparseDirectLightingWgsl } from "../../shaders/lighting_direct.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "../../shaders/environment_ibl.js";

export interface SurfaceLightingProducts {
  readonly diffusePackets: ResourceId;
  readonly specularPackets: ResourceId;
  readonly coatPackets: ResourceId;
  readonly iblPackets: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly counters: ResourceId;
}

export interface SurfaceLightingInput {
  readonly geometry: ResourceId;
  readonly fields: ResourceId;
  readonly counts: ResourceId;
  readonly work: ResourceId;
  readonly sampleOffset: number;
  readonly width: number;
  readonly height: number;
  readonly recordCount: number;
  readonly frame: number;
  readonly camera: ResourceId;
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
${APPEARANCE_SURFACE_READ_WGSL}

struct SurfaceView { width: u32, height: u32, frame_index: u32, _pad: u32 };
struct SurfaceSettings {
  width: u32, height: u32, record_count: u32, frame: u32,
  sample_offset: u32, light_enabled: u32, environment_enabled: u32, shadow_enabled: u32,
  cluster_enabled: u32, _environment_enabled_2: u32, ao_enabled: u32, _pad: u32,
};
@group(0) @binding(0) var<uniform> settings: SurfaceSettings;
@group(0) @binding(1) var<storage, read> geometry: array<vec4f>;
@group(0) @binding(2) var fields: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> diffuse: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> specular: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> coat: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> ibl: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(8) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var reactive: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(10) var<storage, read> surface_counts: array<u32>;
@group(0) @binding(11) var<storage, read> work: array<u32>;
@group(0) @binding(12) var<storage, read> scalar_ao: array<u32>;
@group(0) @binding(13) var environment_diffuse: texture_2d<f32>;
@group(0) @binding(14) var environment_specular: texture_2d<f32>;
@group(0) @binding(15) var environment_dfg: texture_2d<f32>;

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
    default: { return 0u; }
  }
}
fn ao_at(pixel_index: u32) -> f32 {
  if setting(10u) == 0u { return 1.0; }
  let packed = scalar_ao[pixel_index >> 2u];
  return f32((packed >> ((pixel_index & 3u) * 8u)) & 0xffu) * (1.0 / 255.0);
}

fn surface_material(pixel: vec2i) -> StandardMaterial {
  let albedo = max(surface_field(fields, pixel, 0u).xyz, vec3f(0.0));
  let metallic = saturate(surface_field(fields, pixel, 2u).x);
  let roughness = clamp(surface_field(fields, pixel, 3u).x, 0.04, 1.0);
  let occlusion = saturate(surface_field(fields, pixel, 4u).x);
  let emissive = max(surface_field(fields, pixel, 5u).xyz, vec3f(0.0));
  let specular_weight = saturate(surface_field(fields, pixel, 8u).x);
  let specular_color = max(surface_field(fields, pixel, 9u).xyz, vec3f(1.0));
  let coat_factor = saturate(surface_field(fields, pixel, 10u).x);
  let coat_roughness = clamp(surface_field(fields, pixel, 11u).x, 0.04, 1.0);
  let coat_raw = surface_field(fields, pixel, 12u).xyz;
  let coat_normal = select(vec3f(0.0, 0.0, 1.0), normalize(coat_raw), dot(coat_raw, coat_raw) > 1e-8);
  let f0 = mix(vec3f(0.04), albedo, metallic) * specular_weight * specular_color;
  return StandardMaterial(albedo * (1.0 - metallic), roughness, occlusion, f0, 1.0,
    vec3f(1.0), emissive, 1.0, coat_factor, coat_roughness, coat_normal);
}

fn direct_surface(material: StandardMaterial, geometry_in: SurfaceGeometry,
  pixel: vec2f, view_depth: f32) -> ReflectedLight {
  var reflected = ReflectedLight(vec3f(0.0), vec3f(0.0));
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

fn environment_surface(material: StandardMaterial, normal: vec3f, view_dir: vec3f,
  pixel: vec2i, ao: f32) -> vec3f {
  let diffuse_env = sample_octahedral_bilinear(environment_diffuse, vec2u(0u),
    textureDimensions(environment_diffuse).x, normal, 0u).rgb;
  let reflection = reflect(-view_dir, normal);
  let specular_env = sample_prefiltered_environment(environment_specular, reflection, material.roughness);
  let no_v = saturate(dot(normal, view_dir));
  let dfg_size = textureDimensions(environment_dfg);
  let dfg_xy = vec2i(clamp(vec2f(no_v, material.roughness) * vec2f(dfg_size),
    vec2f(0.0), vec2f(dfg_size) - vec2f(1.0)));
  let dfg = textureLoad(environment_dfg, dfg_xy, 0).xy;
  let diffuse = diffuse_env * material.diffuse * material.occlusion * ao;
  let specular = specular_env * (material.specularF0 * dfg.x + vec3f(dfg.y));
  return diffuse + specular + material.emissive;
}

fn coat_environment(material: StandardMaterial, normal: vec3f, view_dir: vec3f) -> vec3f {
  let reflection = reflect(-view_dir, normal);
  let specular_env = sample_prefiltered_environment(environment_specular, reflection, material.coatRoughness);
  return specular_env * material.coatFactor * 0.04;
}

@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) id: vec3u) {
  let record = id.x;
  if record >= setting(2u) || record >= surface_counts[0u] { return; }
  let base = record * 12u;
  let sample_at = setting(4u) / 4u + record * 8u;
  let pixel_index = work[sample_at];
  let signal_mask = work[sample_at + 3u];
  let sample_flags = work[sample_at + 7u];
  let pixel = vec2i(i32(pixel_index % setting(0u)), i32(pixel_index / setting(0u)));
  let position = geometry[base + 0u].xyz;
  if geometry[base + 1u].w < 0.5 {
    atomicAdd(&counters[13], 1u);
    textureStore(output, pixel, vec4f(0.0));
    textureStore(reactive, pixel, vec4f(1.0, 0.0, 1.0, 1.0));
    return;
  }
  let geometric_normal = normalize(geometry[base + 1u].xyz);
  let shading_normal = normalize(geometry[base + 2u].xyz);
  let tangent = normalize(geometry[base + 5u].xyz);
  let view_dir = normalize(geometry[base + 6u].xyz);
  let material = surface_material(pixel);
  let normal_valid = surface_field(fields, pixel, 13u).x > 0.5;
  var normal = shading_normal;
  if normal_valid {
    let normal_ts = normalize(surface_field(fields, pixel, 6u).xyz * 2.0 - vec3f(1.0));
    let bitangent = normalize(cross(shading_normal, tangent) * geometry[base + 2u].w);
    normal = normalize(tangent * normal_ts.x + bitangent * normal_ts.y + shading_normal * normal_ts.z);
  }
  let surface_geometry = SurfaceGeometry(normal, geometric_normal, position, view_dir);
  let ao = ao_at(pixel_index);
  if setting(10u) == 0u { atomicAdd(&counters[7], 1u); }
  atomicAdd(&counters[12], 1u);
  let has_direct = (signal_mask & 7u) != 0u;
  let has_diffuse = (signal_mask & 1u) != 0u;
  let has_specular = (signal_mask & 2u) != 0u;
  let has_coat = (signal_mask & 4u) != 0u;
  let has_ibl = (signal_mask & 8u) != 0u;
  var direct = ReflectedLight(vec3f(0.0), vec3f(0.0));
  if has_direct {
    direct = direct_surface(material, surface_geometry, vec2f(pixel) + vec2f(0.5),
      abs(geometry[base + 0u].w));
    atomicAdd(&counters[5], 1u);
    if setting(7u) != 0u { atomicAdd(&counters[18], 1u); }
    else { atomicAdd(&counters[8], 1u); }
  }
  var direct_diffuse = vec3f(0.0);
  var direct_specular = vec3f(0.0);
  var coat_direct = vec3f(0.0);
  if has_diffuse {
    direct_diffuse = direct.diffuse * (1.0 - material.coatFactor * 0.25);
    atomicAdd(&counters[0], 1u);
  } else { atomicAdd(&counters[14], 1u); }
  if has_specular {
    direct_specular = max(direct.specular - select(vec3f(0.0), direct.specular * material.coatFactor, has_coat), vec3f(0.0));
    atomicAdd(&counters[1], 1u);
  } else { atomicAdd(&counters[15], 1u); }
  if has_coat {
    coat_direct = direct.specular * material.coatFactor;
    atomicAdd(&counters[2], 1u);
  } else { atomicAdd(&counters[16], 1u); }
  var environment = vec3f(0.0);
  var coat_ibl = vec3f(0.0);
  if has_ibl {
    environment = environment_surface(material, normal, view_dir, pixel, ao);
    atomicAdd(&counters[3], 1u);
    atomicAdd(&counters[6], 1u);
  } else { atomicAdd(&counters[17], 1u); atomicAdd(&counters[19], 1u); }
  if has_coat && has_ibl { coat_ibl = coat_environment(material, normal, view_dir); }
  diffuse[record] = vec4f(direct_diffuse, 1.0);
  specular[record] = vec4f(direct_specular, 1.0);
  coat[record] = vec4f(coat_direct + coat_ibl, 1.0);
  ibl[record] = vec4f(environment, 1.0);
  atomicAdd(&counters[10], 4u * 16u);
  if (sample_flags & 2u) != 0u { atomicAdd(&counters[4], 1u); }
  textureStore(output, pixel, vec4f(direct_diffuse + direct_specular + coat_direct + coat_ibl + environment, 1.0));
  let reactive_value = select(0.0, 1.0, material.roughness < 0.12 || material.coatFactor > 0.5);
  textureStore(reactive, pixel, vec4f(reactive_value, 0.0, 0.0, 1.0));
}
`;

export class SurfaceLightingWorkPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly lightLayout: GPUBindGroupLayout;
  private readonly cameraLayout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly viewBuffer: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface lighting settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBuffer = device.createBuffer({ label: "Surface lighting view", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
      ...[3, 4, 5, 6, 7].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" as GPUBufferBindingType } })),
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ...[13, 14, 15].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d" as GPUTextureViewDimension } }))
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
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 128 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth", viewDimension: "2d" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/lighting signal packets",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.lightLayout, this.cameraLayout, this.shadowLayout] }),
      compute: { module: device.createShaderModule({ code: LIGHTING_WGSL }), entryPoint: "build" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceLightingInput): SurfaceLightingProducts {
    let diffusePackets!: ResourceId, specularPackets!: ResourceId, coatPackets!: ResourceId;
    let iblPackets!: ResourceId, counters!: ResourceId, radiance!: ResourceId, reactiveMask!: ResourceId;
    let shadowConstantsId!: ResourceId, shadowPageTableId!: ResourceId, shadowAtlasId!: ResourceId;
    const node = graph.add("Surface/independent lighting packets", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = new Uint32Array([
        data.width, data.height, data.recordCount, data.frame, data.sampleOffset,
        1, 1, data.shadow === null ? 0 : 1,
        1, 1, data.scalarAo === null ? 0 : 1, 0]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      const initialCounters = new Uint32Array(SPARSE_LIGHTING_COUNTER_WORDS);
      initialCounters[11] = 1;
      command.writeBuffer(resources.get(counters) as GPUBuffer, 0,
        initialCounters.buffer, 0, SPARSE_LIGHTING_COUNTER_BYTES);
      const buffer = (id: ResourceId): GPUBuffer => resources.get(id) as GPUBuffer;
      const group0 = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: { buffer: buffer(data.geometry) } },
        { binding: 2, resource: resolveTextureView(resources.get(data.fields)) },
        { binding: 3, resource: { buffer: buffer(diffusePackets) } }, { binding: 4, resource: { buffer: buffer(specularPackets) } },
        { binding: 5, resource: { buffer: buffer(coatPackets) } }, { binding: 6, resource: { buffer: buffer(iblPackets) } },
        { binding: 7, resource: { buffer: buffer(counters) } }, { binding: 8, resource: resolveTextureView(resources.get(radiance)) },
        { binding: 9, resource: resolveTextureView(resources.get(reactiveMask)) }, { binding: 10, resource: { buffer: buffer(data.counts) } },
        { binding: 11, resource: { buffer: buffer(data.work) } }, { binding: 12, resource: { buffer: buffer(data.scalarAo ?? data.counts) } },
        { binding: 13, resource: resolveTextureView(resources.get(data.environment.diffuse)) },
        { binding: 14, resource: resolveTextureView(resources.get(data.environment.specular)) },
        { binding: 15, resource: resolveTextureView(resources.get(data.environment.dfg)) }
      ] });
      const group1 = this.device.createBindGroup({ layout: this.lightLayout, entries: [
        { binding: 0, resource: { buffer: buffer(data.lightRecords) } },
        { binding: 2, resource: { buffer: buffer(data.clusters.parameters) } },
        { binding: 3, resource: { buffer: buffer(data.clusters.lookup) } },
        { binding: 4, resource: { buffer: buffer(data.clusters.data) } },
        { binding: 7, resource: { buffer: buffer(data.clusters.activeLightList) } }
      ] });
      const view = new Uint32Array([data.width, data.height, data.frame, 0]);
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
        command.writeBuffer(pageTable, 0, new Uint32Array(4).buffer, 0, 16);
      }
      const pass = command.beginComputePass({ label: "Surface/lighting packets" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group0); pass.setBindGroup(1, group1);
      pass.setBindGroup(2, group2); pass.setBindGroup(3, group3);
      pass.dispatchWorkgroupsIndirect(buffer(data.counts), SURFACE_WORK_INDIRECT_OFFSET); pass.end();
    });
    node.read(input.geometry); node.read(input.fields); node.read(input.counts); node.read(input.work);
    node.read(input.lightRecords); node.read(input.clusters.parameters); node.read(input.clusters.lookup);
    node.read(input.clusters.data); node.read(input.clusters.activeLightList);
    if (input.shadow !== null) { shadowConstantsId = input.shadow.lightProjection; shadowPageTableId = input.shadow.virtualPageTable; shadowAtlasId = input.shadow.physicalAtlasDepth; node.read(input.shadow.virtualPageTable); node.read(input.shadow.physicalAtlasDepth); node.read(input.shadow.lightProjection); }
    else {
      shadowConstantsId = node.create("Surface/VSM fallback constants", { kind: "transient_buffer", size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, domain: "internal-full" });
      shadowPageTableId = node.create("Surface/VSM fallback page table", { kind: "transient_buffer", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, domain: "internal-full" });
      shadowAtlasId = node.create("Surface/VSM fallback atlas", { kind: "transient_texture", width: 1, height: 1, format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, domain: "internal-full" });
      node.write(shadowConstantsId); node.write(shadowPageTableId); node.write(shadowAtlasId);
    }
    if (input.scalarAo !== null) node.read(input.scalarAo);
    node.read(input.environment.diffuse); node.read(input.environment.specular); node.read(input.environment.dfg);
    const bytes = Math.max(16, input.recordCount * 16);
    diffusePackets = node.create("Surface/diffuse packets", { kind: "transient_buffer", size: bytes, usage: GPUBufferUsage.STORAGE, domain: "internal-full" });
    specularPackets = node.create("Surface/specular packets", { kind: "transient_buffer", size: bytes, usage: GPUBufferUsage.STORAGE, domain: "internal-full" });
    coatPackets = node.create("Surface/coat packets", { kind: "transient_buffer", size: bytes, usage: GPUBufferUsage.STORAGE, domain: "internal-full" });
    iblPackets = node.create("Surface/IBL packets", { kind: "transient_buffer", size: bytes, usage: GPUBufferUsage.STORAGE, domain: "internal-full" });
    counters = node.create("Surface/lighting counters", { kind: "transient_buffer", size: SPARSE_LIGHTING_COUNTER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    for (const id of [diffusePackets, specularPackets, coatPackets, iblPackets, counters]) node.write(id);
    radiance = node.create("Surface/packet radiance", { kind: "transient_texture", width: input.width, height: input.height, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    reactiveMask = node.create("Surface/packet reactive", { kind: "transient_texture", width: input.width, height: input.height, format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    node.write(radiance); node.write(reactiveMask);
    return { diffusePackets, specularPackets, coatPackets, iblPackets, counters, radiance, reactiveMask };
  }

  destroy(): void { this.settings.destroy(); this.viewBuffer.destroy(); }
}
