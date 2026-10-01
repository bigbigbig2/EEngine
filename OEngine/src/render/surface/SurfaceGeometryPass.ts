import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { SURFACE_GEOMETRY_RECORD_STRIDE, SURFACE_WORK_HEADER_WGSL } from "../../gpu/GpuSurfaceWorkAbi.js";
import { winnerPrimitiveArenaConsumerWgsl } from "../../shaders/winner_primitive_work.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../../gpu/GpuVisibilityKeyAbi.js";

export interface SurfaceGeometryProducts {
  readonly records: ResourceId;
  readonly count: ResourceId;
}

export interface SurfaceGeometryInput {
  readonly visibility: ResourceId;
  readonly work: ResourceId;
  readonly arena: ResourceId;
  readonly width: number;
  readonly height: number;
  readonly frameAt: number;
  readonly directoryAt: number;
  readonly geometryOffset: number;
  readonly sampleOffset: number;
  readonly geometryCapacity: number;
  readonly bind: (name: string) => unknown;
}

const GEOMETRY_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${SURFACE_WORK_HEADER_WGSL}
${winnerPrimitiveArenaConsumerWgsl("arena", true)}
struct Settings { width: u32, height: u32, tiles_x: u32, frame_at: u32, directory_at: u32, sample_offset: u32, geometry_offset: u32, capacity: u32 }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> work: array<u32>;
@group(0) @binding(3) var<storage, read> arena: array<u32>;
@group(0) @binding(4) var<storage, read_write> records: array<vec4f>;

@compute @workgroup_size(64)
fn resolve_geometry(@builtin(global_invocation_id) id: vec3u) {
  let tile = id.x;
  if tile >= work[3u] || tile >= settings.capacity { return; }
  let sample_at = settings.sample_offset + tile * 8u;
  let pixel = work[sample_at];
  let x = pixel % settings.width;
  let y = pixel / settings.width;
  let key = textureLoad(visibility, vec2i(x, y), 0).x;
  let interpolation = winner_arena_interpolate_key(key, vec2f(x, y), vec2f(settings.width, settings.height), settings.frame_at, settings.directory_at);
  let base = settings.geometry_offset / 16u + tile * 12u;
  records[base + 0u] = vec4f(interpolation.weights, 1.0);
  records[base + 1u] = vec4f(interpolation.dx, f32(interpolation.flags));
  records[base + 2u] = vec4f(interpolation.dy, f32(key));
  records[base + 3u] = vec4f(f32(x), f32(y), f32(key), 0.0);
  records[base + 4u] = vec4f(0.0, 0.0, 1.0, 0.0);
  records[base + 5u] = vec4f(0.0, 0.0, 1.0, 1.0);
  records[base + 6u] = vec4f(0.0);
  records[base + 7u] = vec4f(0.0);
  records[base + 8u] = vec4f(f32(key), 0.0, 0.0, 0.0);
  records[base + 9u] = vec4f(f32(key), 0.0, 0.0, 0.0);
  records[base + 10u] = vec4f(f32(interpolation.flags), 0.0, 0.0, 0.0);
  records[base + 11u] = vec4f(1.0, 0.0, 0.0, 0.0);
}
`;

export class SurfaceGeometryPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface Geometry settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ label: "Surface Geometry bindings", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "Surface/GeometryRecord", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "Surface Geometry Record", code: GEOMETRY_WGSL }), entryPoint: "resolve_geometry" } });
  }

  addToGraph(graph: FrameGraph, input: SurfaceGeometryInput): SurfaceGeometryProducts {
    let records!: ResourceId;
    const node = graph.add("Surface/GeometryRecord", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(this.settings, 0, new Uint32Array([data.width, data.height,
        Math.ceil(data.width / 8), data.frameAt, data.directoryAt, data.sampleOffset, data.geometryOffset, data.geometryCapacity]).buffer);
      const group = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: this.settings } },
        { binding: 1, resource: resolveTextureView(resources.get(data.visibility)) },
        { binding: 2, resource: { buffer: resources.get(data.work) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(data.arena) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(records) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "Surface/GeometryRecord" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.geometryCapacity / 64)); pass.end();
    });
    node.read(input.visibility); node.read(input.work); node.read(input.arena);
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
