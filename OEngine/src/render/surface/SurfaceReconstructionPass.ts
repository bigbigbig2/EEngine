import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "../../shaders/working_color.js";
import { surfaceCellReadWgsl, surfaceCellFieldReadWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";

import { SURFACE_PACKET_CONTRACT_WGSL } from "../../gpu/GpuSurfaceSignalPacketAbi.js";

export const SURFACE_RECONSTRUCT_COUNTER_WORDS = 8;
export const SURFACE_RECONSTRUCT_COUNTER_BYTES = SURFACE_RECONSTRUCT_COUNTER_WORDS * 4;
export const SURFACE_RECONSTRUCT_TILE_SIZE = 8;
export const SURFACE_RECONSTRUCT_BATCH_TILES = 4096;
export const SURFACE_RECONSTRUCT_BATCH_TARGET = SURFACE_RECONSTRUCT_TILE_SIZE *
  SURFACE_RECONSTRUCT_TILE_SIZE * SURFACE_RECONSTRUCT_BATCH_TILES;

export interface SurfaceReconstructionProducts {
  readonly radiance: ResourceId;
  readonly reactiveMask: ResourceId;
  readonly counters: ResourceId;
}

export function planSurfaceReconstructionBatches(width: number, height: number,
  batchTiles = SURFACE_RECONSTRUCT_BATCH_TILES): Readonly<{ tilesX: number; tilesY: number; tileCount: number; batchTiles: number; batchCount: number }> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Surface reconstruct extent must be positive integers");
  }
  if (!Number.isSafeInteger(batchTiles) || batchTiles < 1) throw new RangeError("Surface reconstruct batchTiles is invalid");
  const tilesX = Math.ceil(width / SURFACE_RECONSTRUCT_TILE_SIZE);
  const tilesY = Math.ceil(height / SURFACE_RECONSTRUCT_TILE_SIZE);
  const tileCount = tilesX * tilesY;
  return Object.freeze({ tilesX, tilesY, tileCount, batchTiles, batchCount: Math.max(1, Math.ceil(tileCount / batchTiles)) });
}

const BATCH_PLAN_WGSL = /* wgsl */ `
struct BatchSettings { tiles_x:u32, tile_count:u32, batch_tiles:u32, batch_count:u32 };
@group(0) @binding(0) var<uniform> settings:BatchSettings;
@group(0) @binding(1) var<storage,read_write> indirect:array<atomic<u32>>;
@compute @workgroup_size(64)
fn plan(@builtin(global_invocation_id) id:vec3u) {
  let batch=id.x;
  if (batch>=settings.batch_count) { return; }
  let first=batch*settings.batch_tiles;
  var count=0u;
  if (first<settings.tile_count) { count=min(settings.batch_tiles,settings.tile_count-first); }
  let at=batch*4u;
  atomicStore(&indirect[at],count);
  atomicStore(&indirect[at+1u],select(0u,1u,count!=0u));
  atomicStore(&indirect[at+2u],select(0u,1u,count!=0u));
  atomicStore(&indirect[at+3u],count);
}
`;

export const RECONSTRUCT_WGSL = /* wgsl */ `
${LINEAR_REC709_TO_REC2020_WGSL}
${SURFACE_PACKET_CONTRACT_WGSL}
struct Settings {
  width:u32, height:u32, record_count:u32, batch_index:u32,
  tiles_x:u32, batch_tiles:u32, batch_count:u32, diagnostics_enabled:u32,
  constant_fields_offset:u32, first_tile:u32, ao_enabled:u32, _reserved2:u32
};
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> packets:array<vec2u>;
@group(0) @binding(2) var<storage,read> full_packets:array<vec4f>;
@group(0) @binding(3) var<storage,read> packet_flags:array<u32>;
@group(0) @binding(4) var source_facts:texture_2d<f32>;
@group(0) @binding(5) var sample_map:texture_2d<u32>;
@group(0) @binding(6) var<storage,read> pre_exposure:array<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(9) var<storage,read_write> diagnostics:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read> cell_plan_words:array<u32>;
@group(0) @binding(11) var<storage,read> material_fields:array<vec2u>;
@group(0) @binding(12) var<storage,read> appearance_metadata:array<u32>;
@group(0) @binding(13) var<storage,read> scalar_ao:array<u32>;
${surfaceCellReadWgsl("settings.batch_tiles")}
${surfaceCellFieldReadWgsl("settings.batch_tiles", "settings.first_tile", "settings.tiles_x", "settings.constant_fields_offset", "material_fields")}

fn diagnostic_add(index:u32,value:u32) {
  if (settings.diagnostics_enabled!=0u) { atomicAdd(&diagnostics[index],value); }
}
fn packet_value(record:u32,kind:u32)->vec4f {
  let slot=record*6u+kind;
  let flags=packet_flags[slot];
  if ((flags&SURFACE_PACKET_SPILL)!=0u) { return full_packets[flags>>8u]; }
  let packed=packets[slot];
  return vec4f(unpack2x16float(packed.x),unpack2x16float(packed.y));
}
fn compose_irradiance(pixel:vec2u,irradiance:vec3f)->vec3f {
  let base_color=max(surface_field_at(pixel,0u).xyz,vec3f(0.0));
  let metallic=clamp(surface_field_at(pixel,2u).x,0.0,1.0);
  let occlusion=clamp(surface_field_at(pixel,4u).x,0.0,1.0);
  var ao=1.0;
  if settings.ao_enabled!=0u {
    let index=pixel.y*settings.width+pixel.x;
    ao=f32((scalar_ao[index>>2u]>>((index&3u)*8u))&255u)*(1.0/255.0);
  }
  return base_color*(1.0-metallic)*occlusion*ao*irradiance*0.3183098861837907;
}

@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id:vec3u) {
  let tile_index = settings.first_tile + id.x / 8u;
  let local_x = id.x & 7u;
  let local_y = id.y;
  let tile_x = tile_index % settings.tiles_x;
  let tile_y = tile_index / settings.tiles_x;
  let pixel = vec2u(tile_x * 8u + local_x, tile_y * 8u + local_y);
  if (pixel.x>=settings.width||pixel.y>=settings.height) { return; }
  let pixel_i=vec2i(pixel);
  let address=surface_plan_fact(pixel);
  let valid=address.x!=0xffffffffu && address.z!=0xffffffffu;
  let facts=textureLoad(source_facts,pixel_i,0);
  var value=max(surface_field_at(pixel,5u).xyz,vec3f(0.0));
  for(var kind=0u;kind<6u;kind++) {
    let record=surface_plan_record(pixel,15u+kind,settings.tiles_x,settings.first_tile);
    if record!=0xffffffffu && (packet_flags[record*6u+kind]&SURFACE_PACKET_VALID)!=0u {
      let packet=packet_value(record,kind).xyz;
      if kind==1u { value+=compose_irradiance(pixel,packet); }
      else { value+=packet; }
    }
  }
  if (valid) { diagnostic_add(0u,1u); diagnostic_add(7u,1u); }
  else { diagnostic_add(1u,1u); }
  let exposure=max(pre_exposure[0],1e-4);
  textureStore(output,pixel_i,vec4f(oengine_linear_rec709_to_rec2020(value)*exposure,select(0.0,1.0,valid)));
  let reactive_value=max(facts.x,select(0.0,0.35,!valid));
  textureStore(reactive,pixel_i,vec4f(reactive_value,facts.yzw));
  diagnostic_add(5u,1u);
}
`;

export class SurfaceReconstructionPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly batchLayout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly batchPipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private readonly batchSettings: GPUBuffer;
  private prepared = false;
  private extent: readonly [number, number] = [0, 0];
  private batchPlan = planSurfaceReconstructionBatches(1, 1);

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface reconstruct settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.batchSettings = device.createBuffer({ label: "Surface reconstruct batch settings", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
      ,{ binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.batchLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.batchPipeline = device.createComputePipeline({ label: "Surface reconstruct batch indirect", layout: device.createPipelineLayout({ bindGroupLayouts: [this.batchLayout] }),
      compute: { module: device.createShaderModule({ code: BATCH_PLAN_WGSL }), entryPoint: "plan" } });
    this.pipeline = device.createComputePipeline({ label: "Surface cheap batch reconstruct", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: RECONSTRUCT_WGSL }), entryPoint: "reconstruct" } });
  }

  prepareFrame(width: number, height: number, batchTiles = SURFACE_RECONSTRUCT_BATCH_TILES): void {
    if (this.prepared) throw new Error("Surface reconstruction frame is already prepared");
    this.batchPlan = planSurfaceReconstructionBatches(width, height, batchTiles);
    this.extent = [width, height];
    this.prepared = true;
  }

  addToGraph(graph: FrameGraph, input: {
    packets: ResourceId;
    fullPackets: ResourceId;
    packetFlags: ResourceId;
    reactive: ResourceId;
    preExposure: ResourceId;
    sampleMap: ResourceId;
    cellWorkspace: ResourceId;
    cellBatchTiles: number;
    firstTile: number;
    appearanceMetadata: ResourceId;
    constantFieldsOffset: number;
    scalarAo: ResourceId | null;
    fields: ResourceId;
    width: number;
    height: number;
    recordCount: number;
    diagnosticsEnabled: boolean;
    batch?: Readonly<{ index: number; batchTiles: number }>;
    previous?: SurfaceReconstructionProducts;
    after?: readonly ResourceId[];
  }): SurfaceReconstructionProducts {
    if (!this.prepared || this.extent[0] !== input.width || this.extent[1] !== input.height) {
      throw new Error("Surface reconstruction frame is not prepared for this extent");
    }
    let radiance!: ResourceId, reactiveMask!: ResourceId, counters!: ResourceId, batchIndirect!: ResourceId;
    const batchPlan = input.batch === undefined ? this.batchPlan : planSurfaceReconstructionBatches(input.width, input.height, input.batch.batchTiles);
    const firstBatch = input.batch?.index ?? 0;
    const endBatch = input.batch === undefined ? batchPlan.batchCount : firstBatch + 1;
    if (!Number.isSafeInteger(firstBatch) || firstBatch < 0 || endBatch > batchPlan.batchCount) {
      throw new RangeError("Surface reconstruction batch is outside the output extent");
    }
    const node = graph.add("Surface/cheap batched reconstruct", { ...input, batchPlan }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const indirect = resources.get(batchIndirect) as GPUBuffer;
      const batchGroup = this.device.createBindGroup({ layout: this.batchLayout, entries: [
        { binding: 0, resource: { buffer: this.batchSettings } }, { binding: 1, resource: { buffer: indirect } }
      ] });
      command.writeBuffer(this.batchSettings, 0, new Uint32Array([data.batchPlan.tilesX, data.batchPlan.tileCount,
        data.batchPlan.batchTiles, data.batchPlan.batchCount]).buffer, 0, 16);
      const planner = command.beginComputePass({ label: "Surface/reconstruct batch counts" });
      planner.setPipeline(this.batchPipeline); planner.setBindGroup(0, batchGroup); planner.dispatchWorkgroups(Math.ceil(data.batchPlan.batchCount / 64)); planner.end();
      const countersBuffer = resources.get(counters) as GPUBuffer;
      if (data.diagnosticsEnabled && data.previous === undefined) command.writeBuffer(countersBuffer, 0,
        new Uint32Array(SURFACE_RECONSTRUCT_COUNTER_WORDS).buffer, 0, SURFACE_RECONSTRUCT_COUNTER_BYTES);
      for (let batch = firstBatch; batch < endBatch; batch++) {
        const settings = new ArrayBuffer(48); const view = new DataView(settings);
        view.setUint32(0, data.width, true); view.setUint32(4, data.height, true);
        view.setUint32(8, data.recordCount, true); view.setUint32(12, batch, true);
        view.setUint32(16, data.batchPlan.tilesX, true); view.setUint32(20, data.batchPlan.batchTiles, true);
        view.setUint32(24, data.batchPlan.batchCount, true); view.setUint32(28, data.diagnosticsEnabled ? 1 : 0, true);
        view.setUint32(32, data.constantFieldsOffset, true);
        view.setUint32(36, data.firstTile, true);
        view.setUint32(40, data.scalarAo===null ? 0 : 1, true);
        command.writeBuffer(this.settings, 0, settings, 0, settings.byteLength);
        const group = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.packets) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.fullPackets) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.packetFlags) as GPUBuffer } },
          { binding: 4, resource: resolveTextureView(resources.get(data.reactive)) },
          { binding: 5, resource: resolveTextureView(resources.get(data.sampleMap)) },
          { binding: 6, resource: { buffer: resources.get(data.preExposure) as GPUBuffer } },
          { binding: 7, resource: resolveTextureView(resources.get(radiance)) },
          { binding: 8, resource: resolveTextureView(resources.get(reactiveMask)) },
          { binding: 9, resource: { buffer: countersBuffer } },
          { binding: 10, resource: { buffer: resources.get(data.cellWorkspace) as GPUBuffer } },
          { binding: 11, resource: { buffer: resources.get(data.fields) as GPUBuffer } },
          { binding: 12, resource: { buffer: resources.get(data.appearanceMetadata) as GPUBuffer } },
          { binding: 13, resource: { buffer: resources.get(data.scalarAo ?? data.preExposure) as GPUBuffer } }
        ] });
        const pass = command.beginComputePass({ label: `Surface/reconstruct batch ${batch}` });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroupsIndirect(indirect, batch * 16); pass.end();
      }
    });
    node.read(input.packets); node.read(input.fullPackets); node.read(input.packetFlags); node.read(input.reactive); node.read(input.preExposure); node.read(input.sampleMap);
    node.read(input.cellWorkspace);
    node.read(input.fields);
    node.read(input.appearanceMetadata);
    if (input.scalarAo!==null) { node.read(input.scalarAo); }
    for (const resource of input.after ?? []) { node.read(resource); }
    batchIndirect = node.create("Surface/reconstruct batch indirect", { kind: "transient_buffer", size: batchPlan.batchCount * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    node.write(batchIndirect);
    if (input.previous !== undefined) {
      radiance = node.write(input.previous.radiance);
      reactiveMask = node.write(input.previous.reactiveMask);
      counters = node.write(input.previous.counters);
    } else {
    radiance = node.create("Surface/HDR reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, domain: "internal-full" });
    reactiveMask = node.create("Surface/reactive reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" });
    counters = node.create("Surface/reconstruct diagnostics", { kind: "transient_buffer", size: SURFACE_RECONSTRUCT_COUNTER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" });
    node.write(counters); node.write(radiance); node.write(reactiveMask);
    }
    return { radiance, reactiveMask, counters };
  }

  commit(): void {
    if (!this.prepared) throw new Error("Surface reconstruction commit without prepare");
    this.prepared = false;
  }

  abort(): void { this.prepared = false; }
  invalidate(): void { /* TemporalFacts and FSR3 own temporal validity now. */ }
  destroy(): void { this.settings.destroy(); this.batchSettings.destroy(); }
}
