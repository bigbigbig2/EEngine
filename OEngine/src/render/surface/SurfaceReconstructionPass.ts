import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "../../shaders/working_color.js";
import { surfaceCellWorkspaceWgsl, SURFACE_CELL_TILE_PLAN_BYTES } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_FIELD_REFERENCE_VALUES_WGSL, SURFACE_SIGNAL_REFERENCE_VALUES_WGSL } from "../../shaders/surface_reference_values.js";

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

const BACKGROUND_WGSL = /* wgsl */ `
struct BackgroundSettings { width:u32, height:u32, pad:vec2u }
@group(0) @binding(0) var<uniform> settings:BackgroundSettings;
@group(0) @binding(1) var<storage,read> coverage:array<u32>;
@group(0) @binding(2) var facts:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(5) var<storage,read_write> diagnostics:array<atomic<u32>>;
@compute @workgroup_size(8,8)
fn write_surface_background(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=settings.width || id.y>=settings.height { return; }
  let tiles_x=(settings.width+7u)/8u;
  let tile=(id.y/8u)*tiles_x+id.x/8u;
  let lane=(id.y%8u)*8u+id.x%8u;
  let mask=coverage[4u+tile*8u+1u+lane/32u];
  if (mask&(1u<<(lane&31u)))!=0u { return; }
  let source=textureLoad(facts,vec2i(id.xy),0);
  textureStore(output,vec2i(id.xy),vec4f(0.0));
  textureStore(reactive,vec2i(id.xy),vec4f(max(source.x,0.35),source.yzw));
  if settings.pad.x!=0u { atomicAdd(&diagnostics[1u],1u);atomicAdd(&diagnostics[5u],1u); }
}
`;

export function surfaceReconstructWgsl(batchTiles:number):string {
 return /* wgsl */ `
${LINEAR_REC709_TO_REC2020_WGSL}
${surfaceCellWorkspaceWgsl(batchTiles)}
struct Settings {
 width:u32,height:u32,record_count:u32,batch_index:u32,
 tiles_x:u32,batch_tiles:u32,batch_count:u32,diagnostics_enabled:u32,
 constant_fields_offset:u32,first_tile:u32,ao_enabled:u32,pad:u32,
}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var<storage,read> signal_values:array<vec4f>;
@group(0) @binding(2) var<storage,read> signal_store:array<u32>;
@group(0) @binding(3) var<storage,read> field_store:array<u32>;
@group(0) @binding(4) var source_facts:texture_2d<f32>;
@group(0) @binding(6) var<storage,read> pre_exposure:array<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var reactive:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(9) var<storage,read_write> diagnostics:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> surface_workspace:SurfaceCellWorkspace;
@group(0) @binding(11) var<storage,read> field_values:array<vec4f>;
@group(0) @binding(12) var<storage,read> appearance_metadata:array<u32>;
@group(0) @binding(13) var<storage,read> scalar_ao:array<u32>;
${SURFACE_FIELD_REFERENCE_VALUES_WGSL}
${SURFACE_SIGNAL_REFERENCE_VALUES_WGSL}
fn reconstruct_plan_word(tile:u32,plane:u32,word:u32)->u32 {
 return surface_workspace.plans[tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+16u+plane*6u+word];
}
fn diagnostic_add(index:u32,value:u32) {
 if settings.diagnostics_enabled!=0u { atomicAdd(&diagnostics[index],value); }
}
fn compose_irradiance(leaf:u32,pixel:vec2u,irradiance:vec3f)->vec3f {
  let base_color=max(surface_field(leaf,0u).xyz,vec3f(0.0));
  let metallic=clamp(surface_field(leaf,2u).x,0.0,1.0);
  let occlusion=clamp(surface_field(leaf,4u).x,0.0,1.0);
  var ao=1.0;
  if settings.ao_enabled!=0u {
    let index=pixel.y*settings.width+pixel.x;
    ao=f32((scalar_ao[index>>2u]>>((index&3u)*8u))&255u)*(1.0/255.0);
  }
  return base_color*(1.0-metallic)*occlusion*ao*irradiance*0.3183098861837907;
}
fn compose_unlit(leaf:u32,pixel:vec2u)->vec3f {
  let tile=leaf/64u;
  let lane=(pixel.y%8u)*8u+pixel.x%8u;
  let base_coverage=reconstruct_plan_word(tile,0u,4u+lane/32u);
  if (base_coverage&(1u<<(lane&31u)))==0u { return vec3f(0.0); }
  for(var field=0u;field<4u;field++) {
    let lighting_field=array<u32,4>(2u,3u,6u,7u)[field];
    if (reconstruct_plan_word(tile,lighting_field,4u+lane/32u)&(1u<<(lane&31u)))!=0u { return vec3f(0.0); }
  }
  for(var kind=0u;kind<6u;kind++) {
    if (reconstruct_plan_word(tile,15u+kind,4u+lane/32u)&(1u<<(lane&31u)))!=0u { return vec3f(0.0); }
  }
  return max(surface_field(leaf,0u).xyz,vec3f(0.0));
}


@compute @workgroup_size(8,8)
fn reconstruct(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) lane:vec3u) {
 let tile=surface_workspace.plans[group.x*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
 let pixel=vec2u((tile%settings.tiles_x)*8u+lane.x,(tile/settings.tiles_x)*8u+lane.y);
 if pixel.x>=settings.width || pixel.y>=settings.height { return; }
 let local_lane=lane.y*8u+lane.x;
 let coverage=surface_workspace.plans[group.x*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+2u+local_lane/32u];
 if (coverage&(1u<<(local_lane&31u)))==0u { return; }
 let leaf=group.x*64u+local_lane;
 let fact=surface_workspace.facts[leaf];
 let valid=fact.x!=0xffffffffu && fact.z!=0xffffffffu;
 var value=vec3f(0.0);
 if valid {
  value=max(surface_field(leaf,5u).xyz,vec3f(0.0))+compose_unlit(leaf,pixel);
  for(var kind=0u;kind<6u;kind++) {
   let signal=surface_signal(leaf,kind).xyz;
   if kind==1u { value+=compose_irradiance(leaf,pixel,signal); }
   else { value+=signal; }
  }
  diagnostic_add(0u,1u);diagnostic_add(7u,1u);
 } else { diagnostic_add(1u,1u); }
 let facts=textureLoad(source_facts,vec2i(pixel),0);
 textureStore(output,vec2i(pixel),vec4f(oengine_linear_rec709_to_rec2020(value)*max(pre_exposure[0],1e-4),select(0.0,1.0,valid)));
 textureStore(reactive,vec2i(pixel),vec4f(max(facts.x,select(0.0,0.35,!valid)),facts.yzw));
 diagnostic_add(5u,1u);
}
`;
}

export class SurfaceReconstructionPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines = new Map<number,GPUComputePipeline>();
  private readonly backgroundPipeline: GPUComputePipeline;
  private readonly settings: GPUBuffer;
  private prepared = false;
  private extent: readonly [number, number] = [0, 0];
  private batchPlan = planSurfaceReconstructionBatches(1, 1);

  constructor(private readonly device: GPUDevice) {
    this.settings = device.createBuffer({ label: "Surface reconstruct settings", size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 48 } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ,{ binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] });
    this.backgroundPipeline = device.createComputePipeline({ label: "Surface/background write domain", layout: "auto",
      compute: { module: device.createShaderModule({ code: BACKGROUND_WGSL }), entryPoint: "write_surface_background" } });

  }

  prepareFrame(width: number, height: number, batchTiles = SURFACE_RECONSTRUCT_BATCH_TILES): void {
    if (this.prepared) throw new Error("Surface reconstruction frame is already prepared");
    this.batchPlan = planSurfaceReconstructionBatches(width, height, batchTiles);
    this.extent = [width, height];
    this.prepared = true;
  }

  addToGraph(graph: FrameGraph, input: {
    signalValues:ResourceId;
    signalStore:ResourceId;
    fieldStore:ResourceId;
    reactive: ResourceId;
    preExposure: ResourceId;
    cellWorkspace: ResourceId;
    coverage: ResourceId;
    activeIndirect: ResourceId;
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
    let pipeline=this.pipelines.get(input.cellBatchTiles);
    if (pipeline===undefined) {
      pipeline=this.device.createComputePipeline({label:"Surface/cheap batch reconstruct",layout:this.device.createPipelineLayout({bindGroupLayouts:[this.layout]}),
        compute:{module:this.device.createShaderModule({code:surfaceReconstructWgsl(input.cellBatchTiles)}),entryPoint:"reconstruct"}});
      this.pipelines.set(input.cellBatchTiles,pipeline);
    }
    let radiance!: ResourceId, reactiveMask!: ResourceId, counters!: ResourceId;
    const batchPlan = input.batch === undefined ? this.batchPlan : planSurfaceReconstructionBatches(input.width, input.height, input.batch.batchTiles);
    const firstBatch = input.batch?.index ?? 0;
    const endBatch = firstBatch + 1;
    if (!Number.isSafeInteger(firstBatch) || firstBatch < 0 || endBatch > batchPlan.batchCount) {
      throw new RangeError("Surface reconstruction batch is outside the output extent");
    }
    const node = graph.add("Surface/cheap batched reconstruct", { ...input, batchPlan }, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const indirect = resources.get(data.activeIndirect) as GPUBuffer;
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
        if (data.previous === undefined) {
          const backgroundSettings=command.allocateTransientBuffer(GPUBufferUsage.UNIFORM,16);
          command.writeBuffer(backgroundSettings,0,new Uint32Array([data.width,data.height,data.diagnosticsEnabled?1:0,0]).buffer,0,16);
          const backgroundGroup=this.device.createBindGroup({layout:this.backgroundPipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:backgroundSettings}},
            {binding:1,resource:{buffer:resources.get(data.coverage) as GPUBuffer}},
            {binding:2,resource:resolveTextureView(resources.get(data.reactive))},
            {binding:3,resource:resolveTextureView(resources.get(radiance))},
            {binding:4,resource:resolveTextureView(resources.get(reactiveMask))},
            {binding:5,resource:{buffer:countersBuffer}}
          ]});
          const background=command.beginComputePass({label:"Surface/background write domain"});
          background.setPipeline(this.backgroundPipeline);background.setBindGroup(0,backgroundGroup);
          background.dispatchWorkgroups(Math.ceil(data.width/8),Math.ceil(data.height/8));background.end();
        }
        const group = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.settings } },
          { binding: 1, resource: { buffer: resources.get(data.signalValues) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(data.signalStore) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(data.fieldStore) as GPUBuffer } },
          { binding: 4, resource: resolveTextureView(resources.get(data.reactive)) },
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
        pass.setPipeline(pipeline!); pass.setBindGroup(0, group); pass.dispatchWorkgroupsIndirect(indirect, 0); pass.end();
      }
    });
    node.read(input.signalValues); node.read(input.signalStore); node.read(input.fieldStore); node.read(input.reactive); node.read(input.preExposure);
    node.read(input.cellWorkspace);
    node.read(input.fields);
    node.read(input.appearanceMetadata);
    if (input.scalarAo!==null) { node.read(input.scalarAo); }
    for (const resource of input.after ?? []) { node.read(resource); }
    node.read(input.coverage);
    node.read(input.activeIndirect);
    if (input.previous !== undefined) {
      radiance = node.write(input.previous.radiance);
      reactiveMask = node.write(input.previous.reactiveMask);
      counters = node.write(input.previous.counters);
    } else {
    radiance = node.create("Surface/HDR reconstructed", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, domain: "internal-full" });
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
  destroy(): void { this.settings.destroy(); }
}
