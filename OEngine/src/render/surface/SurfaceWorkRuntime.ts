import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceWorkLayout, writeSurfaceWorkHeader, SURFACE_WORK_HEADER_WGSL,
  SURFACE_TILE_DESCRIPTOR_STRIDE, SURFACE_SAMPLE_RECORD_STRIDE, type SurfaceWorkBudget, type SurfaceWorkLayout } from "../../gpu/GpuSurfaceWorkAbi.js";
import { SurfaceGeometryPass, type SurfaceGeometryProducts } from "./SurfaceGeometryPass.js";
import { SurfaceMaterialCachePass, type SurfaceMaterialProducts } from "./SurfaceMaterialCachePass.js";

export interface SurfaceWorkFrame {
  readonly generation: number;
  readonly arenaHeaderOffset: number;
  readonly directoryOffset: number;
}

export interface SurfaceWorkProducts extends SurfaceGeometryProducts, SurfaceMaterialProducts {
  readonly work: ResourceId;
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
}

const CLASSIFY_WGSL = /* wgsl */ `
${SURFACE_WORK_HEADER_WGSL}
struct Settings { width: u32, height: u32, tiles_x: u32, tiles_y: u32, tile_offset: u32, sample_offset: u32, generation: u32, capacity: u32 }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read_write> work: array<u32>;
@compute @workgroup_size(64)
fn classify(@builtin(global_invocation_id) id: vec3u) {
  if id.x == 0u {
    work[0]=settings.generation; work[1]=settings.width; work[2]=settings.height;
    work[3]=settings.tiles_x*settings.tiles_y; work[4]=0u; work[5]=0u; work[6]=0u;
    work[12]=settings.tile_offset; work[13]=settings.sample_offset;
  }
  let tile=id.x;
  let tile_count=settings.tiles_x*settings.tiles_y;
  if tile>=tile_count || tile>=settings.capacity { return; }
  let tx=tile%settings.tiles_x; let ty=tile/settings.tiles_x;
  let x=min(tx*8u,settings.width-1u); let y=min(ty*8u,settings.height-1u);
  let key=textureLoad(visibility,vec2i(x,y),0).x;
  let tile_at=settings.tile_offset+tile*12u;
  work[tile_at+0u]=x | (min(8u,settings.width-x)<<16u);
  work[tile_at+1u]=y | (min(8u,settings.height-y)<<16u);
  work[tile_at+2u]=select(0u,1u,key!=0xffffffffu);
  work[tile_at+3u]=0u; work[tile_at+4u]=0u; work[tile_at+5u]=tile;
  work[tile_at+6u]=tile; work[tile_at+7u]=0u; work[tile_at+8u]=tile; work[tile_at+9u]=0u;
  work[tile_at+10u]=0u; work[tile_at+11u]=0u;
  let sample_at=settings.sample_offset+tile*8u;
  work[sample_at]=y*settings.width+x; work[sample_at+1u]=key; work[sample_at+2u]=key;
  work[sample_at+3u]=15u; work[sample_at+4u]=0xffffffffu; work[sample_at+5u]=tile;
  work[sample_at+6u]=tile; work[sample_at+7u]=select(0u,1u,key!=0xffffffffu);
}
`;

const CLEAR_WGSL = /* wgsl */ `
@group(0) @binding(0) var output: texture_storage_2d<rgba16float,write>;
@group(0) @binding(1) var reactive: texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn clear(@builtin(global_invocation_id) id: vec3u) { textureStore(output,vec2i(id.xy),vec4f(0.0)); textureStore(reactive,vec2i(id.xy),vec4f(0.0)); }
`;

export class SurfaceWorkRuntime {
  private readonly geometry: SurfaceGeometryPass;
  private readonly material: SurfaceMaterialCachePass;
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly classifyPipeline: GPUComputePipeline;
  private readonly clearLayout: GPUBindGroupLayout;
  private readonly clearPipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private prepared = false;
  private destroyed = false;
  private layout: SurfaceWorkLayout | null = null;

  constructor(private readonly device: GPUDevice, private readonly budget: SurfaceWorkBudget = {
    maxTiles: 262144, maxSamples: 262144, maxExceptions: 65536, maxGeometryRecords: 262144, maxBytes: 128 * 1024 * 1024
  }) {
    this.geometry = new SurfaceGeometryPass(device);
    this.material = new SurfaceMaterialCachePass(device);
    this.settings = device.createBuffer({ label: "SurfaceWork/classify settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.classifyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.classifyPipeline = device.createComputePipeline({ label: "SurfaceWork/classify", layout: device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] }),
      compute: { module: device.createShaderModule({ code: CLASSIFY_WGSL }), entryPoint: "classify" } });
    this.clearLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } }
    ] });
    this.clearPipeline = device.createComputePipeline({ label: "SurfaceWork/clear outputs", layout: device.createPipelineLayout({ bindGroupLayouts: [this.clearLayout] }),
      compute: { module: device.createShaderModule({ code: CLEAR_WGSL }), entryPoint: "clear" } });
  }

  prepareFrame(width: number, height: number): void {
    if (this.destroyed || this.prepared) throw new Error("SurfaceWork frame is already prepared");
    this.layout = surfaceWorkLayout(width, height, this.budget, this.device.limits); this.prepared = true;
  }

  addToGraph(graph: FrameGraph, input: { visibility: ResourceId; arena: ResourceId; fieldVersions: ResourceId; width: number; height: number; frame: SurfaceWorkFrame }): SurfaceWorkProducts {
    if (!this.layout) this.layout = surfaceWorkLayout(input.width, input.height, this.budget, this.device.limits);
    const layout = this.layout;
    let work!: ResourceId;
    const classify = graph.add("SurfaceWork/classify implicit-uniform-mixed", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const header = new Uint32Array(16); writeSurfaceWorkHeader(header, layout, data.width, data.height, data.frame.generation);
      header[4] = 0; header[5] = 0; header[6] = 0;
      command.writeBuffer(this.settings, 0, new Uint32Array([data.width, data.height,
        Math.ceil(data.width / 8), Math.ceil(data.height / 8), layout.tileOffset / 4,
        layout.sampleOffset / 4, data.frame.generation >>> 0, layout.tileCapacity]).buffer);
      command.writeBuffer(resources.get(work) as GPUBuffer, 0, header.buffer);
      const group = this.device.createBindGroup({ layout: this.classifyLayout, entries: [
        { binding: 0, resource: { buffer: this.settings } }, { binding: 1, resource: resolveTextureView(resources.get(data.visibility)) },
        { binding: 2, resource: { buffer: resources.get(work) as GPUBuffer } }
      ] });
      const pass = command.beginComputePass({ label: "SurfaceWork/classify" }); pass.setPipeline(this.classifyPipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(layout.tileCapacity / 64)); pass.end();
    });
    classify.read(input.visibility);
    work = classify.create("SurfaceWork frame partitions", { kind: "transient_buffer", size: layout.geometryOffset,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, domain: "internal-full" }); classify.write(work);
    const geometry = this.geometry.addToGraph(graph, { visibility: input.visibility, work, arena: input.arena, width: input.width,
      height: input.height, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4,
      sampleOffset: layout.sampleOffset, geometryOffset: layout.geometryOffset, geometryCapacity: layout.geometryCapacity, bind: () => undefined });
    const recordCount = Math.ceil(input.width / 8) * Math.ceil(input.height / 8);
    const material = this.material.addToGraph(graph, { geometry: geometry.records, width: input.width, height: input.height,
      recordCount, fieldVersions: input.fieldVersions, frame: input.frame.generation });
    let radiance!: ResourceId;
    let reactiveMask!: ResourceId;
    const outputs = graph.add("SurfaceWork/cheap output initialization", { width: input.width, height: input.height }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const group = this.device.createBindGroup({ layout: this.clearLayout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(radiance)) }, { binding: 1, resource: resolveTextureView(resources.get(reactiveMask)) }
      ] });
      const pass = command.beginComputePass({ label: "SurfaceWork/outputs" }); pass.setPipeline(this.clearPipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8)); pass.end();
    });
    radiance = outputs.create("SurfaceWork/radiance", { kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    reactiveMask = outputs.create("SurfaceWork/reactive", { kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    outputs.write(radiance); outputs.write(reactiveMask);
    return { work, records: geometry.records, count: geometry.count, ...material, radiance, reactiveMask };
  }

  commit(_gpuDone: Promise<void>): void { if (!this.prepared) throw new Error("SurfaceWork commit without prepare"); this.prepared = false; }
  abort(): void { this.prepared = false; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.geometry.destroy(); this.material.destroy(); this.settings.destroy(); }
}
