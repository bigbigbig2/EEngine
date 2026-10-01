import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_GEOMETRY_RECORD_STRIDE, SURFACE_WORK_HEADER_WGSL } from "../../gpu/GpuSurfaceWorkAbi.js";
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
  readonly geometryCapacity: number;
}

const GEOMETRY_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
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
  capacity: u32, record_count: u32, source: vec4u, source_payload: vec4u
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

@compute @workgroup_size(64)
fn resolve_geometry(@builtin(global_invocation_id) id: vec3u) {
  let record = id.x;
  if record >= settings.record_count || record >= settings.capacity { return; }
  if record == 0u { atomicStore(&record_count[0], settings.record_count); }
  let sample_at = settings.sample_offset / 4u + record * 8u;
  let pixel = work[sample_at];
  let x = pixel % settings.width;
  let y = pixel / settings.width;
  let key = textureLoad(visibility, vec2i(x, y), 0).x;
  let base = settings.geometry_offset / 16u + record * 12u;
  let decoded = oengine_visibility_key_decode(key);
  if decoded.valid == 0u || decoded.meshlet_work_slot >= meshlet_work.header.written_count {
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    return;
  }
  let meshlet = meshlet_work.elements[decoded.meshlet_work_slot];
  let directory = settings.directory_at + 4u + decoded.meshlet_work_slot * 4u;
  var interpolation: WinnerInterpolation;
  var ids = vec3u(0u, 1u, 2u);
  surface_direct_source = false;
  if arena[directory + 2u] != 0u {
    interpolation = winner_arena_interpolate_key(key, vec2f(x, y) + vec2f(0.5),
      vec2f(settings.width, settings.height), settings.frame_at, settings.directory_at);
    let packed = arena[arena[settings.frame_at + 7u] + arena[directory + 1u] + decoded.local_primitive];
    ids = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u) + vec3u(arena[directory]);
  } else {
    interpolation = winner_interpolate(surface_source_coefficients(meshlet, decoded.local_primitive),
      vec2f(x, y) + vec2f(0.5), vec2f(settings.width, settings.height));
    ids = vec3u(0u, 1u, 2u);
  }
  if (interpolation.flags & 1u) == 0u {
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    return;
  }
  let instance = frame_instances[meshlet.instance_slot];
  let transform = oengine_instance_current_object_to_world(instance.source);
  let a = attribute_at(ids, vec3f(1.0, 0.0, 0.0), 5u).xyz;
  let b = attribute_at(ids, vec3f(0.0, 1.0, 0.0), 5u).xyz;
  let c = attribute_at(ids, vec3f(0.0, 0.0, 1.0), 5u).xyz;
  let geometric = normalize_or(cross((transform * vec4f(b - a, 0.0)).xyz,
    (transform * vec4f(c - a, 0.0)).xyz), vec3f(0.0, 0.0, 1.0));
  var normal = oengine_frame_instance_normal(instance.normal_x, instance.normal_y,
    instance.normal_z.xyz, attribute_at(ids, interpolation.weights, 0u).xyz, geometric);
  let local_tangent = attribute_at(ids, interpolation.weights, 1u);
  let tangent_raw = (transform * vec4f(local_tangent.xyz, 0.0)).xyz;
  var tangent = normalize_or(tangent_raw - normal * dot(normal, tangent_raw),
    normalize_or(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.99), normal), vec3f(1.0, 0.0, 0.0)));
  let position = (transform * vec4f(attribute_at(ids, interpolation.weights, 5u).xyz, 1.0)).xyz;
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
  let color = attribute_at(ids, interpolation.weights, 3u);
  records[base + 11u] = vec4f(1.0, color.z, color.w, 0.0);
}
`;

export class SurfaceGeometryPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface Geometry settings", size: 80,
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
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 256 } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/GeometryRecord", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "Surface Geometry Record", code: GEOMETRY_WGSL }), entryPoint: "resolve_geometry" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceGeometryInput): SurfaceGeometryProducts {
    let records!: ResourceId;
    const node = graph.add("Surface/GeometryRecord", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const settings = new Uint32Array([
        data.width, data.height, Math.ceil(data.width / 8), data.frameAt,
        data.directoryAt, data.sampleOffset, data.geometryOffset, data.geometryCapacity,
        Math.min(data.geometryCapacity, Math.ceil(data.width / 8) * Math.ceil(data.height / 8)),
        0, 0, 0,
        data.sourceGeometry, data.sourceMeshlet, data.sourceMeshletVertices, data.sourceMeshletTriangles,
        data.sourceVertexData, 0, 0, 0, 0
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
        { binding: 11, resource: { buffer: resources.get(count) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/GeometryRecord" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.geometryCapacity / 64)); pass.end();
    });
    for (const resource of [input.visibility, input.work, input.arena, input.meshletWork,
      input.sourceHeap, input.vertexPayload, input.frameInstances, input.frameAttributes, input.camera]) node.read(resource);
    records = node.create("Surface/GeometryRecord buffer", { kind: "transient_buffer",
      size: input.geometryOffset + input.geometryCapacity * SURFACE_GEOMETRY_RECORD_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, domain: "internal-full" });
    node.write(records);
    const count = node.create("Surface/GeometryRecord count", { kind: "transient_buffer", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, domain: "internal-full" });
    node.write(count);
    return { records, count };
  }

  destroy(): void { this.settings.destroy(); }
}
