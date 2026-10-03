import { SurfaceFrameResources, type SurfaceResourceBinding } from "./SurfaceFrameResources.js";
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
import { SurfaceCellGeometrySetup, type SurfaceCellGeometrySetupInput, type SurfaceCellGeometrySetupProducts } from "./SurfaceCellGeometrySetup.js";

export interface SurfaceGeometryProducts {
  readonly records: ResourceId;
  readonly count: ResourceId;
  readonly missCounters: ResourceId;
}

export interface SurfaceGeometryInput {
  readonly resourceBinding: SurfaceResourceBinding;
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
  readonly diagnosticsEnabled: boolean;
}

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
fn diagnostic_add(index:u32,value:u32){
  if settings.source_payload.y!=0u {atomicAdd(&record_count[index],value);}
}
fn hash_word(value: u32, seed: u32) -> u32 {
  var x = seed ^ value; x *= 16777619u; x ^= x >> 13u; x *= 2246822519u; return x;
}

override RESOLVE_MISSES:bool;
@compute @workgroup_size(64)
fn resolve_geometry(@builtin(global_invocation_id) id: vec3u) {
  let miss_mode = RESOLVE_MISSES;
  let dispatch_index = id.x;
  if miss_mode {
    if dispatch_index >= atomicLoad(&geometry_miss_counters[0]) { return; }
    diagnostic_add(1u,1u);
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
  let base = settings.geometry_offset / 16u + work[sample_at + 6u] * 12u;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if (key == 0u) { diagnostic_add(10u,1u); }
  if decoded.valid == 0u {
    diagnostic_add(5u,1u);
    let raw = oengine_visibility_key_decode(key);
    if (raw.valid == 0u) { diagnostic_add(6u,1u); }
    else if (meshlet_work.header.generation == 0u) { diagnostic_add(7u,1u); }
    else { diagnostic_add(8u,1u); }
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    diagnostic_add(22u,208u);
    return;
  }
  let meshlet = meshlet_work.elements[decoded.meshlet_work_slot];
  let instance = frame_instances[meshlet.instance_slot];
  if !miss_mode && (work[sample_at+7u]&4u)!=0u && records[base+1u].w>0.5 {
    records[base+8u]=vec4f(bitcast<f32>(key),bitcast<f32>(meshlet.material_slot_or_range),bitcast<f32>(decoded.meshlet_work_slot),bitcast<f32>(decoded.local_primitive));
    records[base+9u]=vec4f(bitcast<f32>(key),bitcast<f32>(meshlet.meshlet_slot),bitcast<f32>(meshlet.instance_slot),bitcast<f32>(meshlet.geometry_slot));
    records[base+10u].y=bitcast<f32>(meshlet.material_slot_or_range);
    diagnostic_add(22u,36u);
    diagnostic_add(3u,1u);diagnostic_add(4u,1u);return;
  }
  if !miss_mode {
    let miss_slot=atomicAdd(&geometry_miss_counters[0],1u);
    if miss_slot<settings.capacity{geometry_miss_queue[miss_slot]=record;}else{atomicOr(&geometry_miss_counters[1],1u);}
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
    diagnostic_add(5u,1u);
    diagnostic_add(9u,1u);
    if settings.source_payload.y != 0u {
      let directory_work = arena[settings.directory_at + 0u];
      let directory_generation = arena[settings.directory_at + 1u];
      let directory_vertices = arena[settings.directory_at + 2u];
      let directory_triangles = arena[settings.directory_at + 3u];
      if directory_generation == 0u {
        diagnostic_add(11u,1u);
      } else if decoded.meshlet_work_slot >= directory_work {
        diagnostic_add(11u,1u);
      } else {
        let meshlet_at = directory;
        let vertex_base = arena[meshlet_at + 0u];
        let triangle_base = arena[meshlet_at + 1u];
        let vertex_count = arena[meshlet_at + 2u];
        let triangle_count = arena[meshlet_at + 3u];
        if decoded.local_primitive >= triangle_count {
          diagnostic_add(15u,1u);
          atomicCompareExchangeWeak(&record_count[18], 0u, triangle_count);
          atomicCompareExchangeWeak(&record_count[19], 0u, decoded.local_primitive);
          atomicCompareExchangeWeak(&record_count[20], 0u, directory_triangles);
          atomicCompareExchangeWeak(&record_count[21], 0u, triangle_base);
        } else if triangle_base >= directory_triangles {
          diagnostic_add(16u,1u);
        } else if decoded.local_primitive >= directory_triangles - triangle_base {
          diagnostic_add(17u,1u);
        }
        if decoded.local_primitive >= triangle_count || triangle_base >= directory_triangles ||
          decoded.local_primitive >= directory_triangles - triangle_base {
          diagnostic_add(12u,1u);
        } else {
          let packed = arena[arena[settings.frame_at + 7u] + triangle_base + decoded.local_primitive];
          let corners = vec3u(packed & 255u, (packed >> 8u) & 255u, (packed >> 16u) & 255u);
          let vertices = min(directory_vertices, arena[settings.frame_at + 2u]);
          if any(corners >= vec3u(vertex_count)) || vertex_base >= vertices ||
            any(corners >= vec3u(vertices - vertex_base)) {
            diagnostic_add(13u,1u);
          } else {
            diagnostic_add(14u,1u);
          }
        }
      }
    }
    for (var i = 0u; i < 12u; i++) { records[base + i] = vec4f(0.0); }
    records[base + 8u] = vec4f(bitcast<f32>(key), 0.0, 0.0, 0.0);
    diagnostic_add(22u,208u);
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
  records[base + 0u] = vec4f(position, select(-view_depth, view_depth, ((instance.source.flags >> 8u) & 15u) >= 4u));
  records[base + 1u] = vec4f(geometric, 1.0);
  records[base + 2u] = vec4f(normal, bitangent.z);
  records[base + 3u] = vec4f(uv0, uv1);
  records[base + 4u] = vec4f(uv2, attribute_at(ids, interpolation.weights, 3u).xy);
  records[base + 5u] = vec4f(tangent, local_tangent.w * sign(instance.normal_x.w));
  records[base + 6u] = vec4f(view_dir, bitangent.z);
  records[base + 7u] = vec4f(uv0dx, uv0dy);
  records[base + 8u] = vec4f(bitcast<f32>(key), bitcast<f32>(meshlet.material_slot_or_range), bitcast<f32>(decoded.meshlet_work_slot), bitcast<f32>(decoded.local_primitive));
  records[base + 9u] = vec4f(bitcast<f32>(key), bitcast<f32>(meshlet.meshlet_slot), bitcast<f32>(meshlet.instance_slot), bitcast<f32>(meshlet.geometry_slot));
  records[base + 10u] = vec4f(bitcast<f32>(signature), bitcast<f32>(meshlet.material_slot_or_range), bitcast<f32>(instance.source.flags), bitcast<f32>(interpolation.flags));
  records[base + 11u] = vec4f(1.0, color.z, color.w, 0.0);
  diagnostic_add(22u,192u);
  diagnostic_add(4u,1u);
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
  private cellSetup: SurfaceCellGeometrySetup | null = null;
  addCellSetupsToGraph(graph: FrameGraph, input: SurfaceCellGeometrySetupInput): SurfaceCellGeometrySetupProducts {
    this.cellSetup ??= new SurfaceCellGeometrySetup(this.device);
    return this.cellSetup.addToGraph(graph,input);
  }
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly classifyPipeline: GPUComputePipeline;
  private readonly finalizeLayout: GPUBindGroupLayout;
  private readonly finalizePipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly finalizeSettings: GPUBuffer;

  constructor(private readonly device: GPUDevice, private readonly scratch: SurfaceFrameResources) {
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
      { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 17, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    const geometryModule=device.createShaderModule({label:"Surface Geometry Record",code:GEOMETRY_WGSL});
    const geometryLayout=device.createPipelineLayout({bindGroupLayouts:[this.layout]});
    this.classifyPipeline=device.createComputePipeline({label:"Surface/GeometryRecord classify",layout:geometryLayout,
      compute:{module:geometryModule,entryPoint:"resolve_geometry",constants:{RESOLVE_MISSES:0}}});
    this.pipeline=device.createComputePipeline({label:"Surface/GeometryRecord miss",layout:geometryLayout,
      compute:{module:geometryModule,entryPoint:"resolve_geometry",constants:{RESOLVE_MISSES:1}}});
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
        // Geometry is one record per accepted Surface sample.  The previous
        // tile-count limit silently dropped every sample after the first
        // 32,400 tiles at 1080p, leaving reconstruct with mostly empty output.
        Math.min(data.geometryCapacity, data.recordCount),
        0, 0, 0,
        data.sourceGeometry, data.sourceMeshlet, data.sourceMeshletVertices, data.sourceMeshletTriangles,
        data.sourceVertexData, data.diagnosticsEnabled ? 1 : 0, 0, data.mode
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
        { binding: 16, resource: { buffer: resources.get(missQueue) as GPUBuffer } },
        { binding: 17, resource: { buffer: resources.get(missCounters) as GPUBuffer } }
      ] });
      if (data.mode === 0) {
        command.gpu_encoder.copyBufferToBuffer(resources.get(data.counts) as GPUBuffer, SURFACE_WORK_INDIRECT_OFFSET, resources.get(dispatchIndirect) as GPUBuffer, 0, 16);
      } else {
        command.gpu_encoder.copyBufferToBuffer(resources.get(missCounters) as GPUBuffer, GEOMETRY_MISS_INDIRECT_OFFSET, resources.get(dispatchIndirect) as GPUBuffer, 0, 16);
      }
      const pass = command.beginComputePass({ label: data.mode === 0
        ? "Surface/GeometryRecord cache classify" : "Surface/GeometryRecord miss resolve" });
      pass.setPipeline(data.mode===0?this.classifyPipeline:this.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroupsIndirect(resources.get(dispatchIndirect) as GPUBuffer, 0);
      pass.end();
    };
    const classify = graph.add("Surface/GeometryRecord cache classify", { ...input, mode: 0 }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(resources.get(count) as GPUBuffer, 0, new Uint32Array(24).buffer, 0, 96);
      command.writeBuffer(resources.get(missCounters) as GPUBuffer, 0, new Uint32Array(8).buffer, 0, 32);
      bindAndDispatch(data, resources, context);
    });
    for (const resource of [input.visibility, input.work, input.arena, input.meshletWork,
      input.sourceHeap, input.vertexPayload, input.frameInstances, input.frameAttributes, input.camera]) classify.read(resource);
    classify.read(input.counts); classify.read(input.materialHitMask);
    records = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/GeometryRecord buffer",
      input.width * input.height * SURFACE_GEOMETRY_RECORD_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    records = classify.write(records);
    count = classify.create("Surface/GeometryRecord count", { kind: "transient_buffer", size: 96,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    classify.write(count);
    missQueue = this.scratch.importBuffer(graph, input.resourceBinding, "Surface/GeometryRecord miss queue",
      Math.max(4, input.recordCount * 4), GPUBufferUsage.STORAGE);
    missQueue = classify.write(missQueue);
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

  destroy(): void { this.cellSetup?.destroy(); this.cellSetup=null; this.settings.destroy(); this.finalizeSettings.destroy();  }
}
