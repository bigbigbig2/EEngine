import type { FrameGraph, FrameGraphContext, PassResources } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_GEOMETRY_RECORD_STRIDE, SURFACE_WORK_HEADER_WGSL, SURFACE_WORK_INDIRECT_OFFSET } from "../../gpu/GpuSurfaceWorkAbi.js";
import { winnerPrimitiveArenaConsumerWgsl } from "../../shaders/winner_primitive_work.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../gpu/GpuMeshletRasterWorkAbi.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import { surfaceGeometrySourceReaderWgsl } from "../../shaders/surface_geometry_reader.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../../gpu/GpuFrameGeometryAttributesAbi.js";

export interface SurfaceGeometryProducts {
  readonly records: ResourceId;
  readonly count: ResourceId;
  readonly missCounters: ResourceId;
}

export interface SurfaceGeometryInput {
  readonly visibility: ResourceId;
  readonly work: ResourceId;
  readonly arena: ResourceId;
  readonly meshletWork: ResourceId;
  readonly sourceHeap: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly frameInstances: ResourceId;
  readonly frameAttributes: ResourceId;
  readonly camera: ResourceId;
  readonly width: number;
  readonly height: number;
  readonly frameAt: number;
  readonly directoryAt: number;
  readonly sourceGeometry: number;
  readonly sourceMeshlet: number;
  readonly sourceMeshletVertices: number;
  readonly sourceMeshletTriangles: number;
  readonly sourceVertexData: number;
  readonly geometryOffset: number;
  readonly sampleOffset: number;
  readonly recordCount: number;
  readonly geometryCapacity: number;
  readonly counts: ResourceId;
  /** Material publication hit mask. Geometry cache lookup is only a fast path for hits. */
  readonly materialHitMask: ResourceId;
}

const GEOMETRY_CACHE_CAPACITY = 1 << 15;
const GEOMETRY_CACHE_KEY_STRIDE = 13;
const GEOMETRY_CACHE_VALUE_STRIDE = 10;
const GEOMETRY_MISS_INDIRECT_OFFSET = 8;

const GEOMETRY_WGSL = /* wgsl */ `
${SURFACE_WORK_HEADER_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
${winnerPrimitiveArenaConsumerWgsl("arena", true)}
${surfaceGeometrySourceReaderWgsl(false, "source_heap")}
struct Settings {
  width: u32, height: u32, tiles_x: u32, frame_at: u32,
  directory_at: u32, sample_offset: u32, geometry_offset: u32,
  capacity: u32, record_count: u32, cache_capacity: u32, cache_mask: u32,
  source: vec4u, source_payload: vec4u
}
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> work: array<u32>;
@group(0) @binding(3) var<storage, read> arena: array<u32>;
@group(0) @binding(4) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(5) var<storage, read> source_heap: array<u32>;
@group(0) @binding(6) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(7) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(8) var<storage, read> frame_attributes: array<vec4f>;
@group(0) @binding(9) var<uniform> camera: CommandEncoder;
@group(0) @binding(10) var<storage, read_write> records: array<vec4f>;
@group(0) @binding(11) var<storage, read_write> record_count: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read> surface_counts: array<u32>;
@group(0) @binding(13) var<storage, read> material_hit_mask: array<u32>;
@group(0) @binding(14) var<storage, read_write> geometry_cache_keys: array<u32>;
@group(0) @binding(15) var<storage, read_write> geometry_cache_values: array<vec4f>;
@group(0) @binding(16) var<storage, read_write> geometry_miss_queue: array<u32>;
@group(0) @binding(17) var<storage, read_write> geometry_miss_counters: array<atomic<u32>>;

fn attribute_at(ids: vec3u, weights: vec3f, field: u32) -> vec4f {
  if surface_direct_source { return surface_source_attribute(ids, weights, field); }
  let stride = ${GPU_FRAME_ATTRIBUTE_VECTORS}u;
  return frame_attributes[ids.x * stride + field] * weights.x +
    frame_attributes[ids.y * stride + field] * weights.y +
    frame_attributes[ids.z * stride + field] * weights.z;
}
fn normalize_or(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 && all(value == value) { return value * inverseSqrt(length2); }
  return fallback;
}
fn hash_word(value: u32, seed: u32) -> u32 {
  var x = seed ^ value; x *= 16777619u; x ^= x >> 13u; x *= 2246822519u; return x;
}

fn geometry_cache_hash(geometry_slot: u32, meshlet_identity: u32, instance_slot: u32,
  primitive: u32, geometry_generation: u32, dynamic_revision: u32,
  profile_lod: u32, product_slot: u32, instance_set_generation: u32,
  representative_pixel: u32, clip_signature: u32) -> u32 {
  var x = 2166136261u;
  x = hash_word(geometry_slot, x); x = hash_word(meshlet_identity, x);
  x = hash_word(instance_slot, x); x = hash_word(primitive, x);
  x = hash_word(geometry_generation, x); x = hash_word(dynamic_revision, x);
  x = hash_word(profile_lod, x); x = hash_word(product_slot, x);
  x = hash_word(instance_set_generation, x);
  x = hash_word(representative_pixel, x);
  return hash_word(clip_signature, x);
}

fn frame_instance_clip_signature(instance: OEngineFrameInstanceRecord) -> u32 {
  var signature = 2166136261u;
  for (var column = 0u; column < 4u; column++) {
    for (var row = 0u; row < 4u; row++) {
      signature = hash_word(bitcast<u32>(instance.object_to_clip[column][row]), signature);
    }
  }
  return signature;
}

fn cache_key_base(cell: u32) -> u32 { return cell * ${GEOMETRY_CACHE_KEY_STRIDE}u; }
fn cache_value_base(cell: u32) -> u32 { return cell * ${GEOMETRY_CACHE_VALUE_STRIDE}u; }

@compute @workgroup_size(64)
fn resolve_geometry(@builtin(global_invocation_id) id: vec3u) {
  let miss_mode = settings.source_payload.w != 0u;
  let dispatch_index = id.x;
  if miss_mode {
    if dispatch_index >= atomicLoad(&geometry_miss_counters[0]) { return; }
    atomicAdd(&record_count[1], 1u);
  } else {
    let actual_count = min(settings.record_count, surface_counts[0u]);
    if dispatch_index >= actual_count || dispatch_index >= settings.capacity { return; }
    if dispatch_index == 0u { atomicStore(&record_count[0], actual_count); }
  }
  let record = select(dispatch_index, geometry_miss_queue[dispatch_index], miss_mode);
  if record >= settings.capacity { return; }
  let sample_at = settings.sample_offset / 4u + record * 8u;
  let pixel = work[sample_at];
  let x = pixel % settings.width;
  let y = pixel / settings.width;
  let key = textureLoad(visibility, vec2i(i32(x), i32(y)), 0).x;
  let base = settings.geometry_offset / 16u + record * 12u;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if decoded.valid == 0u {
    atomicAdd(&record_count[5], 1u);
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    return;
  }
  let meshlet = meshlet_work.elements[decoded.meshlet_work_slot];
  let instance = frame_instances[meshlet.instance_slot];
  let geometry_generation = oengine_instance_geometry_generation(instance.source);
  let dynamic_revision = instance.source.dynamic_revision;
  let product_slot = oengine_instance_product_table_slot(instance.source);
  let instance_set_generation = instance.source.instance_set_generation;
  let profile_lod = meshlet.packed_profile_lod;
  let primitive = decoded.local_primitive;
  let clip_signature = frame_instance_clip_signature(instance);
  let cache_hash = geometry_cache_hash(meshlet.geometry_slot, meshlet.meshlet_slot,
    meshlet.instance_slot, primitive, geometry_generation, dynamic_revision,
    profile_lod, product_slot, instance_set_generation, pixel, clip_signature);
  let cache_cell = cache_hash & settings.cache_mask;
  let cache_key = cache_key_base(cache_cell);
  let cache_match = material_hit_mask[record] != 0u &&
    geometry_cache_keys[cache_key + 0u] == cache_hash &&
    geometry_cache_keys[cache_key + 1u] == meshlet.geometry_slot &&
    geometry_cache_keys[cache_key + 2u] == meshlet.meshlet_slot &&
    geometry_cache_keys[cache_key + 3u] == meshlet.instance_slot &&
    geometry_cache_keys[cache_key + 4u] == primitive &&
    geometry_cache_keys[cache_key + 5u] == geometry_generation &&
    geometry_cache_keys[cache_key + 6u] == dynamic_revision &&
    geometry_cache_keys[cache_key + 7u] == profile_lod &&
    geometry_cache_keys[cache_key + 8u] == product_slot &&
    geometry_cache_keys[cache_key + 9u] == instance_set_generation &&
    geometry_cache_keys[cache_key + 10u] == meshlet.material_slot_or_range &&
    geometry_cache_keys[cache_key + 11u] == pixel &&
    geometry_cache_keys[cache_key + 12u] == clip_signature;
  if cache_match {
    if !miss_mode { atomicAdd(&record_count[3], 1u); atomicAdd(&record_count[4], 1u); }
    if miss_mode { return; }
    let cached = cache_value_base(cache_cell);
    let local_position = geometry_cache_values[cached + 0u].xyz;
    let local_edge1 = geometry_cache_values[cached + 1u].xyz;
    let local_edge2 = geometry_cache_values[cached + 2u].xyz;
    let transform = oengine_instance_current_object_to_world(instance.source);
    let geometric = normalize_or(cross((transform * vec4f(local_edge1, 0.0)).xyz,
      (transform * vec4f(local_edge2, 0.0)).xyz), vec3f(0.0, 0.0, 1.0));
    let local_shading = normalize_or(geometry_cache_values[cached + 3u].xyz, geometric);
    let local_tangent = geometry_cache_values[cached + 4u];
    var normal = oengine_frame_instance_normal(instance.normal_x, instance.normal_y,
      instance.normal_z.xyz, local_shading, geometric);
    let tangent_raw = (transform * vec4f(local_tangent.xyz, 0.0)).xyz;
    var tangent = normalize_or(tangent_raw - normal * dot(normal, tangent_raw),
      normalize_or(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.99), normal), vec3f(1.0, 0.0, 0.0)));
    let position = (transform * vec4f(local_position, 1.0)).xyz;
    let view_dir = normalize_or(camera.transform[3].xyz - position, normal);
    if (instance.source.flags & 16u) != 0u && dot(normal, view_dir) < 0.0 { normal = -normal; tangent = -tangent; }
    let bitangent = cross(normal, tangent) * sign(local_tangent.w) * sign(instance.normal_x.w);
    let color = geometry_cache_values[cached + 8u];
    let metadata = geometry_cache_values[cached + 7u];
    let view_depth = -(camera.view_matrix * vec4f(position, 1.0)).z;
    records[base + 0u] = vec4f(position, select(-view_depth, view_depth, ((instance.source.flags >> 8u) & 15u) >= 4u));
    records[base + 1u] = vec4f(geometric, 1.0);
    records[base + 2u] = vec4f(normal, bitangent.z);
    records[base + 3u] = geometry_cache_values[cached + 5u];
    records[base + 4u] = geometry_cache_values[cached + 6u];
    records[base + 5u] = vec4f(tangent, local_tangent.w * sign(instance.normal_x.w));
    records[base + 6u] = vec4f(view_dir, bitangent.z);
    records[base + 7u] = geometry_cache_values[cached + 9u];
    records[base + 8u] = vec4f(bitcast<f32>(key), bitcast<f32>(meshlet.material_slot_or_range), bitcast<f32>(decoded.meshlet_work_slot), bitcast<f32>(primitive));
    records[base + 9u] = vec4f(bitcast<f32>(key), bitcast<f32>(decoded.meshlet_work_slot), bitcast<f32>(meshlet.instance_slot), bitcast<f32>(meshlet.geometry_slot));
    records[base + 10u] = metadata;
    records[base + 11u] = color;
    return;
  }
  if !miss_mode {
    let miss_slot = atomicAdd(&geometry_miss_counters[0], 1u);
    if miss_slot < settings.capacity {
      geometry_miss_queue[miss_slot] = record;
    } else {
      atomicOr(&geometry_miss_counters[1], 1u);
    }
    return;
  }
  let directory = settings.directory_at + 4u + decoded.meshlet_work_slot * 4u;
  var interpolation: WinnerInterpolation;
  var ids = vec3u(0u, 1u, 2u);
  surface_direct_source = false;
  if arena[directory + 2u] != 0u {
    interpolation = winner_arena_interpolate_key(key, vec2f(f32(x), f32(y)) + vec2f(0.5),
      vec2f(f32(settings.width), f32(settings.height)), settings.frame_at, settings.directory_at);
    let packed = arena[arena[settings.frame_at + 7u] + arena[directory + 1u] + decoded.local_primitive];
    ids = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u) + vec3u(arena[directory]);
  } else {
    interpolation = winner_interpolate(surface_source_coefficients(meshlet, decoded.local_primitive),
      vec2f(f32(x), f32(y)) + vec2f(0.5), vec2f(f32(settings.width), f32(settings.height)));
    ids = vec3u(0u, 1u, 2u);
  }
  if (interpolation.flags & 1u) == 0u {
    atomicAdd(&record_count[5], 1u);
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    return;
  }
  let transform = oengine_instance_current_object_to_world(instance.source);
  let a = attribute_at(ids, vec3f(1.0, 0.0, 0.0), 5u).xyz;
  let b = attribute_at(ids, vec3f(0.0, 1.0, 0.0), 5u).xyz;
  let c = attribute_at(ids, vec3f(0.0, 0.0, 1.0), 5u).xyz;
  let local_position = attribute_at(ids, interpolation.weights, 5u).xyz;
  let local_edge1 = b - a;
  let local_edge2 = c - a;
  let local_geometric = normalize_or(cross(local_edge1, local_edge2), vec3f(0.0, 0.0, 1.0));
  let local_shading = normalize_or(attribute_at(ids, interpolation.weights, 0u).xyz, local_geometric);
  let local_tangent = attribute_at(ids, interpolation.weights, 1u);
  let geometric = normalize_or((transform * vec4f(local_geometric, 0.0)).xyz, vec3f(0.0, 0.0, 1.0));
  var normal = oengine_frame_instance_normal(instance.normal_x, instance.normal_y,
    instance.normal_z.xyz, local_shading, geometric);
  let tangent_raw = (transform * vec4f(local_tangent.xyz, 0.0)).xyz;
  var tangent = normalize_or(tangent_raw - normal * dot(normal, tangent_raw),
    normalize_or(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.99), normal), vec3f(1.0, 0.0, 0.0)));
  let position = (transform * vec4f(local_position, 1.0)).xyz;
  let view_dir = normalize_or(camera.transform[3].xyz - position, normal);
  if (instance.source.flags & 16u) != 0u && dot(normal, view_dir) < 0.0 { normal = -normal; tangent = -tangent; }
  let bitangent = cross(normal, tangent) * sign(local_tangent.w) * sign(instance.normal_x.w);
  let uv0 = attribute_at(ids, interpolation.weights, 2u).xy;
  let uv1 = attribute_at(ids, interpolation.weights, 2u).zw;
  let uv2 = attribute_at(ids, interpolation.weights, 4u).xy;
  let uv0dx = attribute_at(ids, interpolation.weights + interpolation.dx, 2u).xy - uv0;
  let uv0dy = attribute_at(ids, interpolation.weights + interpolation.dy, 2u).xy - uv0;
  let view_depth = -(camera.view_matrix * vec4f(position, 1.0)).z;
  var signature = hash_word(bitcast<u32>(position.x), 2166136261u);
  signature = hash_word(bitcast<u32>(position.y), signature);
  signature = hash_word(bitcast<u32>(position.z), signature);
  signature = hash_word(bitcast<u32>(normal.x), signature);
  signature = hash_word(bitcast<u32>(normal.y), signature);
  signature = hash_word(bitcast<u32>(normal.z), signature);
  signature = hash_word(meshlet.material_slot_or_range, signature);
  let color = attribute_at(ids, interpolation.weights, 3u);
  let cache_value = cache_value_base(cache_cell);
  geometry_cache_values[cache_value + 0u] = vec4f(local_position, 1.0);
  geometry_cache_values[cache_value + 1u] = vec4f(local_edge1, 0.0);
  geometry_cache_values[cache_value + 2u] = vec4f(local_edge2, 0.0);
  geometry_cache_values[cache_value + 3u] = vec4f(local_shading, 1.0);
  geometry_cache_values[cache_value + 4u] = local_tangent;
  geometry_cache_values[cache_value + 5u] = vec4f(uv0, uv1);
  geometry_cache_values[cache_value + 6u] = vec4f(uv2, attribute_at(ids, interpolation.weights, 3u).xy);
  geometry_cache_values[cache_value + 7u] = vec4f(bitcast<f32>(signature), bitcast<f32>(instance.source.flags), bitcast<f32>(interpolation.flags), 0.0);
  geometry_cache_values[cache_value + 8u] = vec4f(1.0, color.z, color.w, 0.0);
  geometry_cache_values[cache_value + 9u] = vec4f(uv0dx, uv0dy);
  geometry_cache_keys[cache_key + 0u] = cache_hash;
  geometry_cache_keys[cache_key + 1u] = meshlet.geometry_slot;
  geometry_cache_keys[cache_key + 2u] = meshlet.meshlet_slot;
  geometry_cache_keys[cache_key + 3u] = meshlet.instance_slot;
  geometry_cache_keys[cache_key + 4u] = primitive;
  geometry_cache_keys[cache_key + 5u] = geometry_generation;
  geometry_cache_keys[cache_key + 6u] = dynamic_revision;
  geometry_cache_keys[cache_key + 7u] = profile_lod;
  geometry_cache_keys[cache_key + 8u] = product_slot;
  geometry_cache_keys[cache_key + 9u] = instance_set_generation;
  geometry_cache_keys[cache_key + 10u] = meshlet.material_slot_or_range;
  geometry_cache_keys[cache_key + 11u] = pixel;
  geometry_cache_keys[cache_key + 12u] = clip_signature;
  records[base + 0u] = vec4f(position, select(-view_depth, view_depth, ((instance.source.flags >> 8u) & 15u) >= 4u));
  records[base + 1u] = vec4f(geometric, 1.0);
  records[base + 2u] = vec4f(normal, bitangent.z);
  records[base + 3u] = vec4f(uv0, uv1);
  records[base + 4u] = vec4f(uv2, attribute_at(ids, interpolation.weights, 3u).xy);
  records[base + 5u] = vec4f(tangent, local_tangent.w * sign(instance.normal_x.w));
  records[base + 6u] = vec4f(view_dir, bitangent.z);
  records[base + 7u] = vec4f(uv0dx, uv0dy);
  records[base + 8u] = vec4f(bitcast<f32>(key), bitcast<f32>(meshlet.material_slot_or_range), bitcast<f32>(decoded.meshlet_work_slot), bitcast<f32>(decoded.local_primitive));
  records[base + 9u] = vec4f(bitcast<f32>(key), bitcast<f32>(decoded.meshlet_work_slot), bitcast<f32>(meshlet.instance_slot), bitcast<f32>(meshlet.geometry_slot));
  records[base + 10u] = vec4f(bitcast<f32>(signature), bitcast<f32>(meshlet.material_slot_or_range), bitcast<f32>(instance.source.flags), bitcast<f32>(interpolation.flags));
  records[base + 11u] = vec4f(1.0, color.z, color.w, 0.0);
  atomicAdd(&record_count[4], 1u);
}
`;

const GEOMETRY_MISS_FINALIZE_WGSL = /* wgsl */ `
struct Settings { capacity: u32, _pad: vec3u }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@compute @workgroup_size(1)
fn finalize() {
  let count = min(atomicLoad(&counters[0]), settings.capacity);
  atomicStore(&counters[2], (count + 63u) / 64u);
  atomicStore(&counters[3], select(0u, 1u, count != 0u));
  atomicStore(&counters[4], select(0u, 1u, count != 0u));
}
`;

export class SurfaceGeometryPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly finalizePipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly finalizeSettings: GPUBuffer;
  private readonly geometryCacheKeys: GPUBuffer;
  private readonly geometryCacheValues: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    const keyBytes = GEOMETRY_CACHE_CAPACITY * GEOMETRY_CACHE_KEY_STRIDE * 4;
    const valueBytes = GEOMETRY_CACHE_CAPACITY * GEOMETRY_CACHE_VALUE_STRIDE * 16;
    if (keyBytes > Number(device.limits.maxStorageBufferBindingSize) ||
      valueBytes > Number(device.limits.maxStorageBufferBindingSize) ||
      keyBytes > Number(device.limits.maxBufferSize) || valueBytes > Number(device.limits.maxBufferSize)) {
      throw new RangeError("Surface geometry cache exceeds the negotiated storage limits");
    }
    this.geometryCacheKeys = device.createBuffer({ label: "Surface geometry cache keys", size: keyBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.geometryCacheValues = device.createBuffer({ label: "Surface geometry cache values", size: valueBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.settings = device.createBuffer({ label: "Surface Geometry settings", size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.finalizeSettings = device.createBuffer({ label: "Surface Geometry miss finalize settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ label: "Surface Geometry bindings", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 80 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 14, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 17, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/GeometryRecord", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "Surface Geometry Record", code: GEOMETRY_WGSL }), entryPoint: "resolve_geometry" } });
    this.finalizeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.finalizePipeline = device.createComputePipeline({ label: "Surface/Geometry miss finalize",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.finalizeLayout] }),
      compute: { module: device.createShaderModule({ code: GEOMETRY_MISS_FINALIZE_WGSL }), entryPoint: "finalize" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceGeometryInput): SurfaceGeometryProducts {
    let records!: ResourceId, count!: ResourceId, missQueue!: ResourceId, missCounters!: ResourceId, dispatchIndirect!: ResourceId;
    const bindAndDispatch = (data: SurfaceGeometryInput & { mode: number }, resources: PassResources, context: FrameGraphContext): void => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = new Uint32Array([
        data.width, data.height, Math.ceil(data.width / 8), data.frameAt,
        data.directoryAt, data.sampleOffset, data.geometryOffset, data.geometryCapacity,
        Math.min(data.geometryCapacity, Math.ceil(data.width / 8) * Math.ceil(data.height / 8)),
        GEOMETRY_CACHE_CAPACITY, GEOMETRY_CACHE_CAPACITY - 1, 0,
        data.sourceGeometry, data.sourceMeshlet, data.sourceMeshletVertices, data.sourceMeshletTriangles,
        data.sourceVertexData, 0, 0, data.mode
      ]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } },
        { binding: 1, resource: resolveTextureView(resources.get(data.visibility)) },
        { binding: 2, resource: { buffer: resources.get(data.work) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(data.arena) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(data.meshletWork) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(data.sourceHeap) as GPUBuffer } },
        { binding: 6, resource: { buffer: resources.get(data.vertexPayload) as GPUBuffer } },
        { binding: 7, resource: { buffer: resources.get(data.frameInstances) as GPUBuffer } },
        { binding: 8, resource: { buffer: resources.get(data.frameAttributes) as GPUBuffer } },
        { binding: 9, resource: { buffer: resources.get(data.camera) as GPUBuffer } },
        { binding: 10, resource: { buffer: resources.get(records) as GPUBuffer } },
        { binding: 11, resource: { buffer: resources.get(count) as GPUBuffer } },
        { binding: 12, resource: { buffer: resources.get(data.counts) as GPUBuffer } },
        { binding: 13, resource: { buffer: resources.get(data.materialHitMask) as GPUBuffer } },
        { binding: 14, resource: { buffer: this.geometryCacheKeys } },
        { binding: 15, resource: { buffer: this.geometryCacheValues } },
        { binding: 16, resource: { buffer: resources.get(missQueue) as GPUBuffer } },
        { binding: 17, resource: { buffer: resources.get(missCounters) as GPUBuffer } }
      ] });
      if (data.mode === 0) {
        command.gpu_encoder.copyBufferToBuffer(resources.get(data.counts) as GPUBuffer, SURFACE_WORK_INDIRECT_OFFSET, resources.get(dispatchIndirect) as GPUBuffer, 0, 16);
      } else {
        command.gpu_encoder.copyBufferToBuffer(resources.get(missCounters) as GPUBuffer, GEOMETRY_MISS_INDIRECT_OFFSET, resources.get(dispatchIndirect) as GPUBuffer, 0, 16);
      }
      const pass = command.beginComputePass({ label: "Surface/GeometryRecord" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroupsIndirect(resources.get(dispatchIndirect) as GPUBuffer, 0);
      pass.end();
    };
    const classify = graph.add("Surface/GeometryRecord cache classify", { ...input, mode: 0 }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(resources.get(count) as GPUBuffer, 0, new Uint32Array(8).buffer, 0, 32);
      command.writeBuffer(resources.get(missCounters) as GPUBuffer, 0, new Uint32Array(8).buffer, 0, 32);
      bindAndDispatch(data, resources, context);
    });
    for (const resource of [input.visibility, input.work, input.arena, input.meshletWork,
      input.sourceHeap, input.vertexPayload, input.frameInstances, input.frameAttributes, input.camera]) classify.read(resource);
    classify.read(input.counts); classify.read(input.materialHitMask);
    records = classify.create("Surface/GeometryRecord buffer", { kind: "transient_buffer",
      size: input.geometryOffset + input.geometryCapacity * SURFACE_GEOMETRY_RECORD_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, domain: "internal-full" });
    classify.write(records);
    count = classify.create("Surface/GeometryRecord count", { kind: "transient_buffer", size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    classify.write(count);
    missQueue = classify.create("Surface/GeometryRecord miss queue", { kind: "transient_buffer",
      size: Math.max(4, input.recordCount * 4), usage: GPUBufferUsage.STORAGE, domain: "internal-full" });
    classify.write(missQueue);
    missCounters = classify.create("Surface/GeometryRecord miss indirect", { kind: "transient_buffer", size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    classify.write(missCounters);
    dispatchIndirect = classify.create("Surface/GeometryRecord dispatch indirect", { kind: "transient_buffer", size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    classify.write(dispatchIndirect);
    const finalize = graph.add("Surface/GeometryRecord miss finalize", { missCounters }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.finalizeSettings, 0, new Uint32Array([input.geometryCapacity, 0, 0, 0]).buffer, 0, 16);
      const group = this.device.createBindGroup({ layout: this.finalizeLayout, entries: [
        { binding: 0, resource: { buffer: this.finalizeSettings } },
        { binding: 1, resource: { buffer: resources.get(data.missCounters) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/GeometryRecord miss finalize" });
      pass.setPipeline(this.finalizePipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    });
    finalize.read(missCounters); missCounters = finalize.write(missCounters);
    const resolveMisses = graph.add("Surface/GeometryRecord miss resolve", { ...input, mode: 1, records, count, missQueue, missCounters, dispatchIndirect }, (data, resources, context) => {
      bindAndDispatch(data, resources, context);
    });
    resolveMisses.dependsOn(finalize);
    for (const resource of [input.visibility, input.work, input.arena, input.meshletWork,
      input.sourceHeap, input.vertexPayload, input.frameInstances, input.frameAttributes, input.camera,
      input.materialHitMask, records, count, missQueue, missCounters]) resolveMisses.read(resource);
    resolveMisses.read(dispatchIndirect); dispatchIndirect = resolveMisses.write(dispatchIndirect);
    records = resolveMisses.write(records);
    count = resolveMisses.write(count);
    return { records, count, missCounters };
  }

  destroy(): void { this.settings.destroy(); this.finalizeSettings.destroy(); this.geometryCacheKeys.destroy(); this.geometryCacheValues.destroy(); }
}
