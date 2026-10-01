import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceWorkLayout, writeSurfaceWorkHeader, SURFACE_WORK_HEADER_WGSL,
  SURFACE_TILE_DESCRIPTOR_STRIDE, SURFACE_SAMPLE_RECORD_STRIDE, type SurfaceWorkBudget, type SurfaceWorkLayout } from "../../gpu/GpuSurfaceWorkAbi.js";
import { SurfaceGeometryPass, type SurfaceGeometryProducts } from "./SurfaceGeometryPass.js";
import { SurfaceMaterialCachePass, type SurfaceMaterialProducts } from "./SurfaceMaterialCachePass.js";
import { SurfaceLightingWorkPass } from "./SurfaceLightingWorkPass.js";
import { SurfaceReconstructionPass } from "./SurfaceReconstructionPass.js";

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

export class SurfaceWorkRuntime {
  private readonly geometry: SurfaceGeometryPass;
  private readonly material: SurfaceMaterialCachePass;
  private readonly lighting: SurfaceLightingWorkPass;
  private readonly reconstruction: SurfaceReconstructionPass;
  private readonly classifyLayout: GPUBindGroupLayout;
  private readonly classifyPipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private prepared = false;
  private destroyed = false;
  private layout: SurfaceWorkLayout | null = null;

  constructor(private readonly device: GPUDevice, private readonly budget: SurfaceWorkBudget = {
    maxTiles: 262144, maxSamples: 262144, maxExceptions: 65536, maxGeometryRecords: 262144, maxBytes: 128 * 1024 * 1024
  }) {
    this.geometry = new SurfaceGeometryPass(device);
    this.material = new SurfaceMaterialCachePass(device);
    this.lighting = new SurfaceLightingWorkPass(device);
    this.reconstruction = new SurfaceReconstructionPass(device);
    this.settings = device.createBuffer({ label: "SurfaceWork/classify settings", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.classifyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.classifyPipeline = device.createComputePipeline({ label: "SurfaceWork/classify", layout: device.createPipelineLayout({ bindGroupLayouts: [this.classifyLayout] }),
      compute: { module: device.createShaderModule({ code: CLASSIFY_WGSL }), entryPoint: "classify" } });
  }

  prepareFrame(width: number, height: number): void {
    if (this.destroyed || this.prepared) throw new Error("SurfaceWork frame is already prepared");
    this.layout = surfaceWorkLayout(width, height, this.budget, this.device.limits); this.prepared = true;
  }

  addToGraph(graph: FrameGraph, input: { visibility: ResourceId; arena: ResourceId; meshletWork: ResourceId;
    sourceHeap: ResourceId; vertexPayload: ResourceId; frameInstances: ResourceId; frameAttributes: ResourceId;
    camera: ResourceId; fieldVersions: ResourceId; residencyVersions: ResourceId; factsMask: ResourceId; preExposure: ResourceId; width: number; height: number;
    frame: SurfaceWorkFrame & { sourceGeometry: number; sourceMeshlet: number; sourceMeshletVertices: number;
      sourceMeshletTriangles: number; sourceVertexData: number } }): SurfaceWorkProducts {
    if (!this.layout) this.layout = surfaceWorkLayout(input.width, input.height, this.budget, this.device.limits);
    const layout = this.layout;
    let work!: ResourceId;
    const classify = graph.add("SurfaceWork/classify implicit-uniform-mixed", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const header = new Uint32Array(16); writeSurfaceWorkHeader(header, layout, data.width, data.height, data.frame.generation);
      header[4] = 0; header[5] = 0; header[6] = 0;
      const settings = new Uint32Array([data.width, data.height,
        Math.ceil(data.width / 8), Math.ceil(data.height / 8), layout.tileOffset / 4,
        layout.sampleOffset / 4, data.frame.generation >>> 0, layout.tileCapacity]);
      command.writeBuffer(this.settings, 0, settings.buffer, 0, settings.byteLength);
      command.writeBuffer(resources.get(work) as GPUBuffer, 0, header.buffer, 0, header.byteLength);
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
    const recordCount = Math.ceil(input.width / 8) * Math.ceil(input.height / 8);
    const material = this.material.addLookupToGraph(graph, { visibility: input.visibility, work,
      meshletWork: input.meshletWork, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions,
      width: input.width, height: input.height, recordCount, sampleOffset: layout.sampleOffset, frame: input.frame.generation });
    const geometry = this.geometry.addToGraph(graph, { visibility: input.visibility, work, arena: input.arena,
      meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload,
      frameInstances: input.frameInstances, frameAttributes: input.frameAttributes, camera: input.camera,
      width: input.width,
      height: input.height, frameAt: input.frame.arenaHeaderOffset / 4, directoryAt: input.frame.directoryOffset / 4,
      sourceGeometry: input.frame.sourceGeometry, sourceMeshlet: input.frame.sourceMeshlet,
      sourceMeshletVertices: input.frame.sourceMeshletVertices, sourceMeshletTriangles: input.frame.sourceMeshletTriangles,
      sourceVertexData: input.frame.sourceVertexData,
      sampleOffset: layout.sampleOffset, geometryOffset: layout.geometryOffset, geometryCapacity: layout.geometryCapacity });
    this.material.addEvaluateToGraph(graph, { ...material, geometry: geometry.records, width: input.width, height: input.height,
      recordCount, fieldVersions: input.fieldVersions, residencyVersions: input.residencyVersions, frame: input.frame.generation });
    const lighting = this.lighting.addToGraph(graph, { geometry: geometry.records, fields: material.fields,
      width: input.width, height: input.height, recordCount, frame: input.frame.generation });
    const reconstruction = this.reconstruction.addToGraph(graph, { diffuse: lighting.diffusePackets, specular: lighting.specularPackets,
      coat: lighting.coatPackets, ibl: lighting.iblPackets, geometry: geometry.records, reactive: input.factsMask,
      preExposure: input.preExposure, width: input.width, height: input.height, recordCount });
    return { work, records: geometry.records, count: geometry.count, ...material, ...lighting, ...reconstruction };
  }

  commit(_gpuDone: Promise<void>): void { if (!this.prepared) throw new Error("SurfaceWork commit without prepare"); this.prepared = false; }
  abort(): void { this.prepared = false; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.geometry.destroy(); this.material.destroy(); this.lighting.destroy(); this.reconstruction.destroy(); this.settings.destroy(); }
}
