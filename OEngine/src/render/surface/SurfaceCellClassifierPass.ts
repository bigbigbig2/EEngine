import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceCellClassifyStageWgsl } from "../../shaders/surface_cell_classify.js";
import { surfaceCellProductionFactsWgsl } from "../../shaders/surface_cell_production_facts.js";
import { SURFACE_CELL_LIGHTING_RISK_WGSL } from "../../shaders/surface_cell_lighting_risk.js";
import { SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL } from "../../shaders/surface_cell_static_product_bounds.js";
import { SURFACE_CELL_PLAN_WGSL, SURFACE_CELL_PLANE_COUNT,
  SURFACE_CELL_TILE_PLAN_BYTES, surfaceCellWorkspaceLayout, surfaceCellWorkspaceWgsl } from "../../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_WORK_COUNTER_BYTES, SURFACE_WORK_HEADER_STRIDE, SURFACE_WORK_INDIRECT_OFFSET,
  writeSurfaceWorkHeader, type SurfaceWorkLayout } from "../../gpu/GpuSurfaceWorkAbi.js";
import type { GpuAppearancePublication } from "../../gpu/GpuAppearancePublication.js";
import type { SurfaceResourceBinding } from "./SurfaceFrameResources.js";
import { SurfaceFrameResources } from "./SurfaceFrameResources.js";
import { planSurfaceCellGeometryCapacity } from "../../gpu/GpuSurfaceCellGeometryAbi.js";
import { createSurfaceCellPipelineLayout } from "./SurfaceCellPipelineLayout.js";
import { SURFACE_CELL_CLASSIFY_STAGES, SURFACE_CELL_CERTIFICATE_FAMILIES } from "../../shaders/surface_cell_group_validation.js";
import type { SurfaceGeometryPass } from "./SurfaceGeometryPass.js";
import type { SurfaceCellGeometrySetupProducts } from "./SurfaceCellGeometrySetup.js";
import type { GpuSurfaceFieldStore } from "../../gpu/GpuSurfaceFieldStore.js";
import { SurfaceFieldLookupPass } from "./SurfaceFieldLookupPass.js";
import type { GpuSurfaceSignalStore } from "../../gpu/GpuSurfaceSignalStore.js";
import { SurfaceSignalLookupPass, type SurfaceSignalLookupInput } from "./SurfaceSignalLookupPass.js";

/**
 * The production cell classifier owns the complete coverage -> cell plan
 * boundary. It emits compact SurfaceSampleRecord representatives directly;
 * there is no old winner-equality classifier or pixel-task expansion stage.
 * FieldStore and SignalStore consume these representatives as the bounded
 * per-frame demand stream; they do not recreate dense pixel products.
 */
export interface SurfaceCellClassifierInput {
  readonly resourceBinding: SurfaceResourceBinding;
  readonly geometryPass: SurfaceGeometryPass;
  readonly visibility: ResourceId;
  readonly meshletWork: ResourceId;
  readonly sourceHeap: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly frameInstances: ResourceId;
  readonly camera: ResourceId;
  readonly textureVariation: ResourceId;
  readonly appearanceMetadata: ResourceId;
  readonly fieldVersions: ResourceId;
  readonly viewRevision: Readonly<{ value: number }>;
  readonly signalRevisions: SurfaceSignalLookupInput["revisions"];
  readonly sun: ResourceId | null;
  readonly shadowVersion: ResourceId | null;
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  readonly frameAt: number;
  readonly directoryAt: number;
  readonly sourceGeometry: number;
  readonly sourceMeshlet: number;
  readonly sourceMeshletVertices: number;
  readonly sourceMeshletTriangles: number;
  readonly sourceVertexData: number;
  readonly publication: GpuAppearancePublication;
  readonly product: Readonly<{ heap: ResourceId; banks: readonly ResourceId[] }> | null;
  readonly lightRecords: ResourceId;
  readonly clusters: Readonly<{ parameters: ResourceId; lookup: ResourceId; data: ResourceId }>;
  readonly shadowEnabled: boolean;
  readonly physicalSunEnabled: boolean;
  readonly workLayout: SurfaceWorkLayout;
  readonly diagnosticsEnabled: boolean;
  /** Consume and reconstruct each bounded batch before its scratch is reused. */
  readonly consumeBatch?: (products: SurfaceCellClassifierProducts, firstTile: number, tileCount: number, batchTiles: number) => readonly ResourceId[];
}

export interface SurfaceCellClassifierProducts {
  readonly work: ResourceId;
  readonly counts: ResourceId;
  readonly sampleMap: ResourceId;
  readonly workspace: ResourceId;
  readonly fieldStore: ResourceId;
  readonly signalStore: ResourceId;
  readonly batchTileCapacity: number;
}

export const COMPACT_WGSL = /* wgsl */ `
struct CompactSettings {
  width:u32, height:u32, tiles_x:u32, first_tile:u32,
  tile_count:u32, sample_offset:u32, tile_offset:u32, sample_capacity:u32, generation:u32,
}
@group(0) @binding(0) var<uniform> compact_settings:CompactSettings;
@group(0) @binding(1) var<storage,read_write> compact_workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read_write> compact_work:array<u32>;
@group(0) @binding(3) var<storage,read_write> compact_counts:array<atomic<u32>>;
@group(0) @binding(4) var compact_sample_map:texture_storage_2d<r32uint,write>;
${SURFACE_CELL_PLAN_WGSL}
var<workgroup> compact_rep:array<u32,64>;
var<workgroup> compact_slot:array<u32,64>;
var<workgroup> compact_active:array<u32,64>;
var<workgroup> compact_count:atomic<u32>;
var<workgroup> compact_base:u32;

fn compact_plan(tile:u32,plane:u32)->SurfaceCellPlanePlan {
  let at=tile*${SURFACE_CELL_TILE_PLAN_BYTES / 4}u+16u+plane*6u;
  return SurfaceCellPlanePlan(compact_workspace.plans[at],compact_workspace.plans[at+1u],compact_workspace.plans[at+2u],compact_workspace.plans[at+3u],compact_workspace.plans[at+4u],compact_workspace.plans[at+5u]);
}
fn compact_map_entry(offset:u32,entry:u32)->u32 {
  let bit=entry*6u;let at=offset+(bit>>5u);let shift=bit&31u;
  var result=compact_workspace.maps[at]>>shift;
  if shift>26u {result|=compact_workspace.maps[at+1u]<<(32u-shift);}
  return result&63u;
}
fn compact_group(plan:SurfaceCellPlanePlan,lane:u32)->u32 {
  let mode=plan.mode_rate&255u;
  if mode==SURFACE_CELL_PLAN_MASKED {return compact_map_entry(plan.map_word_offset,lane);}
  if mode==SURFACE_CELL_PLAN_GRID {return surface_cell_grid_index(lane,(plan.mode_rate>>8u)&15u);}
  return lane;
}
fn compact_representative(plan:SurfaceCellPlanePlan,group:u32)->u32 {
  let coverage=vec2u(plan.coverage_lo,plan.coverage_hi);
  let mode=plan.mode_rate&255u;
  if mode==SURFACE_CELL_PLAN_MASKED {return compact_map_entry(plan.map_word_offset+12u,group);}
  if mode==SURFACE_CELL_PLAN_FINE {return select(0xffffffffu,group,surface_cell_mask_member(coverage,group));}
  if mode==SURFACE_CELL_PLAN_GRID {
    return compact_map_entry(plan.map_word_offset+12u,group);
  }
  return 0xffffffffu;
}
fn compact_rep_for(tile:u32,plane:u32,lane:u32)->u32 {
  let plan=compact_plan(tile,plane);let coverage=vec2u(plan.coverage_lo,plan.coverage_hi);
  if !surface_cell_mask_member(coverage,lane){return 0xffffffffu;}
  let group=compact_group(plan,lane);
  return compact_representative(plan,group);
}
fn compact_write_sample(slot:u32,pixel:u32,key:u32,tile:u32,signals:u32,fields:u32) {
  let at=compact_settings.sample_offset+slot*8u;
  compact_work[at]=pixel;compact_work[at+1u]=key;compact_work[at+2u]=key;
  compact_work[at+3u]=signals;compact_work[at+4u]=fields;compact_work[at+5u]=tile;
  compact_work[at+6u]=slot;compact_work[at+7u]=fields<<8u;
}
@compute @workgroup_size(64)
fn compact_cells(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let tile=group.x;if tile>=compact_settings.tile_count{return;}
  let absolute=compact_settings.first_tile+tile;
  let tx=absolute%compact_settings.tiles_x;let ty=absolute/compact_settings.tiles_x;
  let px=tx*8u+lane%8u;let py=ty*8u+lane/8u;let inside=px<compact_settings.width&&py<compact_settings.height;
  if inside{textureStore(compact_sample_map,vec2i(i32(px),i32(py)),vec4u(0xffffffffu));}
  compact_rep[lane]=0xffffffffu;compact_slot[lane]=0xffffffffu;compact_active[lane]=0u;
  if lane==0u{atomicStore(&compact_count,0u);}
  workgroupBarrier();
  // Demand is a union of actual representative lanes, never the numeric
  // minimum of unrelated field/signal representatives. Each lane owns one
  // possible record; all lanes inspect their plans concurrently.
  var fields=0u;
  var constants=0u;
  var present=0u;
  var signals=0u;
  for(var plane=0u;plane<${SURFACE_CELL_PLANE_COUNT}u;plane++) {
    let plan=compact_plan(tile,plane);
    if !surface_cell_mask_member(vec2u(plan.coverage_lo,plan.coverage_hi),lane) { continue; }
    if plane<15u { present|=1u<<plane; }
    if plane<15u && (plan.mode_rate&255u)==SURFACE_CELL_PLAN_PUBLICATION {
      constants |= 1u<<plane;
    } else if compact_rep_for(tile,plane,lane)==lane {
      if plane<15u { fields |= 1u<<plane; }
      else { signals |= 1u<<(plane-15u); }
    }
  }
  compact_active[lane]=select(0u,1u,inside && (fields!=0u || signals!=0u));
  workgroupBarrier();
  var local_slot=0u;
  for(var previous=0u;previous<lane;previous++) { local_slot+=compact_active[previous]; }
  if lane==63u { atomicStore(&compact_count,local_slot+compact_active[lane]); }
  workgroupBarrier();
  if lane==0u { compact_base=atomicAdd(&compact_counts[0],atomicLoad(&compact_count)); }
  workgroupBarrier();
  if compact_active[lane]!=0u {
    let slot=compact_base+local_slot;
    if slot<compact_settings.sample_capacity {
      compact_write_sample(slot,py*compact_settings.width+px,compact_workspace.facts[tile*64u+lane].x,absolute,signals,fields|constants|(~present&0x7fffu));
      textureStore(compact_sample_map,vec2i(i32(px),i32(py)),vec4u(slot));
    }
  }
  if lane==0u {
    let total=atomicLoad(&compact_count);
    let base=compact_base;
    let header=tile*${SURFACE_CELL_TILE_PLAN_BYTES / 4}u;
    let emitted=countOneBits(compact_workspace.plans[header+2u])+countOneBits(compact_workspace.plans[header+3u]);
    let tileAt=compact_settings.tile_offset+absolute*12u;compact_work[tileAt+0u]=(tx*8u)|((min(8u,compact_settings.width-tx*8u))<<16u);
    compact_work[tileAt+1u]=(ty*8u)|((min(8u,compact_settings.height-ty*8u))<<16u);
    compact_work[tileAt+2u]=select(0u,select(2u,1u,total==1u),total!=0u)|(min(emitted,255u)<<8u);
    compact_work[tileAt+3u]=1u;compact_work[tileAt+4u]=1u;compact_work[tileAt+5u]=1u;compact_work[tileAt+6u]=1u;
    compact_work[tileAt+7u]=absolute*16u;compact_work[tileAt+8u]=emitted;compact_work[tileAt+9u]=absolute;compact_work[tileAt+10u]=0u;compact_work[tileAt+11u]=0u;
    atomicAdd(&compact_counts[3],emitted);
    if total==0u{atomicAdd(&compact_counts[4],1u);}else if total==1u{atomicAdd(&compact_counts[5],1u);}else{atomicAdd(&compact_counts[6],1u);}
    if base+total>compact_settings.sample_capacity{atomicAdd(&compact_counts[14],base+total-compact_settings.sample_capacity);atomicOr(&compact_counts[2],2u);}
  }
}
`;

export class SurfaceCellClassifierPass {
  private readonly fieldLookup: SurfaceFieldLookupPass;
  private readonly signalLookup: SurfaceSignalLookupPass;
  private readonly cellSettings: GPUBuffer;
  private readonly factSettings: GPUBuffer;
  private readonly compactSettings: GPUBuffer;
  private readonly scratch: SurfaceFrameResources;
  private readonly pipelines = new Map<string, Readonly<{ constants: GPUComputePipeline; facts: GPUComputePipeline;
    addresses: GPUComputePipeline; geometryCertificates: GPUComputePipeline; fieldCertificates: readonly GPUComputePipeline[];
    classify: readonly GPUComputePipeline[]; compact: GPUComputePipeline }>>();

  constructor(private readonly device: GPUDevice, scratch: SurfaceFrameResources,
    fieldStore: GpuSurfaceFieldStore | null = null, signalStore: GpuSurfaceSignalStore | null = null) {
    this.scratch = scratch;
    this.fieldLookup = new SurfaceFieldLookupPass(device, fieldStore);
    this.signalLookup = new SurfaceSignalLookupPass(device, signalStore);
    this.cellSettings = device.createBuffer({ label: "Surface/cell settings", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.factSettings = device.createBuffer({ label: "Surface/cell fact settings", size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compactSettings = device.createBuffer({ label: "Surface/cell compact settings", size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  addToGraph(graph: FrameGraph, input: SurfaceCellClassifierInput): SurfaceCellClassifierProducts {
    const tilesX = Math.ceil(input.width / 8), tilesY = Math.ceil(input.height / 8), tiles = tilesX * tilesY;
    const batchTileCapacity = Math.max(1, Math.floor(input.workLayout.sampleCapacity / 64));
    const workspaceLayout = surfaceCellWorkspaceLayout(batchTileCapacity);
    if (workspaceLayout.bytes > this.device.limits.maxStorageBufferBindingSize) {
      throw new RangeError("Surface cell workspace exceeds the negotiated storage binding limit; batch splitting is required");
    }
    const geometryCapacity = planSurfaceCellGeometryCapacity(
      input.workLayout.sampleCapacity,
      input.workLayout.sampleCapacity * 128,
      this.device.limits
    );
    const { dictionaryCapacity, setupCapacity } = geometryCapacity;
    const product = input.product !== null;
    const factLibrary = surfaceCellProductionFactsWgsl(input.publication.surfaceBoundPrograms, product,
      SURFACE_CELL_LIGHTING_RISK_WGSL, product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null, dictionaryCapacity, new Set(), true);
    const profile = `${product}:${dictionaryCapacity}:${input.publication.surfaceProgramCount}:` +
      `${input.publication.surfaceCacheGeneration}:${input.workLayout.sampleCapacity}:` +
      `${input.workLayout.tileCapacity}`;
    let pipelines = this.pipelines.get(profile);
    if (!pipelines) {
      const productionLayout = createSurfaceCellPipelineLayout(this.device, product);
      const fullModule = this.device.createShaderModule({ label: "Surface/cell publication and compaction", code:
        `${surfaceCellClassifyStageWgsl(factLibrary, batchTileCapacity, 0, 0, 3, "classify_cells_base", false)}\n${COMPACT_WGSL}` });
      const fieldModules = SURFACE_CELL_CERTIFICATE_FAMILIES.flatMap((fields, family) => [true, false].map(parameterBounds => {
        const fieldFacts = surfaceCellProductionFactsWgsl(input.publication.surfaceBoundPrograms, product,
          SURFACE_CELL_LIGHTING_RISK_WGSL, product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null, dictionaryCapacity, new Set(fields), false, parameterBounds);
        return {
          entryPoint: parameterBounds ? "publish_cell_parameter_certificates" : "publish_cell_field_certificates",
          module: this.device.createShaderModule({ label: `Surface/shared field certificates family ${family}`, code:
            surfaceCellClassifyStageWgsl(fieldFacts, batchTileCapacity, 0, 0, 0, "unused_field_classifier", false) })
        };
      }));
      const modules = SURFACE_CELL_CLASSIFY_STAGES.map(({ first: start, count }, index) => {
        const stageFacts = surfaceCellProductionFactsWgsl(input.publication.surfaceBoundPrograms, product,
          SURFACE_CELL_LIGHTING_RISK_WGSL, product ? SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL : null, dictionaryCapacity, new Set(), false);
        return this.device.createShaderModule({
        label: `Surface/cell production classifier stage ${index}`,
        code: surfaceCellClassifyStageWgsl(stageFacts, batchTileCapacity, index, start, count, `classify_cells_stage_${index}`, start < 15 ? "field-geometry" : "full")
      });
      });
      const module = fullModule;
      pipelines = Object.freeze({
        constants: this.device.createComputePipeline({ label: "Surface/cell material constants", layout: "auto", compute: { module, entryPoint: "publish_cell_material_constants" } }),
        facts: this.device.createComputePipeline({ label: "Surface/cell lighting facts", layout: productionLayout, compute: { module, entryPoint: "publish_cell_facts" } }),
        addresses: this.device.createComputePipeline({ label: "Surface/canonical field addresses", layout: productionLayout, compute: { module, entryPoint: "publish_cell_addresses" } }),
        geometryCertificates: this.device.createComputePipeline({ label: "Surface/shared geometry certificates", layout: productionLayout, compute: { module, entryPoint: "publish_cell_geometry_certificates" } }),
        fieldCertificates: Object.freeze(fieldModules.map(({ module, entryPoint }, index) => this.device.createComputePipeline({
          label: `Surface/${entryPoint} family ${Math.floor(index / 2)}`, layout: productionLayout, compute: { module, entryPoint }
        }))),
        classify: Object.freeze(modules.map((stageModule, index) => this.device.createComputePipeline({ label: `Surface/cell classify stage ${index}`, layout: productionLayout, compute: { module: stageModule, entryPoint: `classify_cells_stage_${index}` } }))),
        compact: this.device.createComputePipeline({ label: "Surface/cell compact representatives", layout: "auto", compute: { module, entryPoint: "compact_cells" } })
      });
      this.pipelines.set(profile, pipelines);
    }

    const batchCount = Math.ceil(tiles / batchTileCapacity);
    const batchWorkspaceLayout = surfaceCellWorkspaceLayout(batchTileCapacity);
    let work!: ResourceId, counts!: ResourceId, sampleMap!: ResourceId, workspace!: ResourceId;
    let fieldStore!: ResourceId, signalStore!: ResourceId;
    const reset = graph.add("Surface/cell workspace reset", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const header = new Uint32Array(SURFACE_WORK_HEADER_STRIDE / 4);
      writeSurfaceWorkHeader(header, input.workLayout, data.width, data.height, data.generation);
      command.writeBuffer(resources.get(work) as GPUBuffer, 0, header.buffer, 0, header.byteLength);
      command.gpu_encoder.clearBuffer(resources.get(work) as GPUBuffer, SURFACE_WORK_HEADER_STRIDE, input.workLayout.tileOffset + tiles * 48 - SURFACE_WORK_HEADER_STRIDE);
      command.gpu_encoder.clearBuffer(resources.get(counts) as GPUBuffer, 0, SURFACE_WORK_COUNTER_BYTES);
    });
    work = this.scratch.importBuffer(graph, input.resourceBinding, "SurfaceWork frame partitions", input.workLayout.geometryOffset,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    work = reset.write(work);
    counts = reset.create("Surface/cell counters", { kind: "transient_buffer", size: SURFACE_WORK_COUNTER_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" }); reset.write(counts);
    sampleMap = reset.create("Surface/cell sample map", { kind: "transient_texture", width: input.width, height: input.height,
      format: "r32uint", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, domain: "internal-full" }); reset.write(sampleMap);
    workspace = reset.create("Surface/cell plan workspace", { kind: "transient_buffer", size: batchWorkspaceLayout.bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, domain: "internal-full" }); reset.write(workspace);

    const makeGroup = (pipeline: GPUComputePipeline, entries: readonly GPUBindGroupEntry[]): GPUBindGroup =>
      this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const constants = graph.add("Surface/cell publish material constants", { input, workspace, work, counts }, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const metadata = input.publication.surfaceMetadataOffsets;
      // Match CellFactSettings vec4 blocks, before the first publication read.
      const settings = new Uint32Array([
        input.sourceGeometry, input.sourceMeshlet, input.sourceMeshletVertices, input.sourceMeshletTriangles,
        input.sourceVertexData, 0, 0, 0,
        metadata.constants, metadata.routes, metadata.bounds, metadata.directory,
        metadata.materialLookup, metadata.materialLookupCount, metadata.directoryCount, input.publication.surfaceCacheGeneration,
        dictionaryCapacity, setupCapacity, input.generation, 1,
        metadata.constantFields, (input.shadowEnabled ? 1 : 0) | (input.physicalSunEnabled ? 2 : 0), metadata.fieldIdentities, 0
      ]);
      command.writeBuffer(this.factSettings, 0, settings.buffer, 0, settings.byteLength);
      const pass = command.beginComputePass({ label: "Surface/cell publish material constants" }); pass.setPipeline(pipelines!.constants);
      pass.setBindGroup(1, this.device.createBindGroup({ layout: pipelines!.constants.getBindGroupLayout(1), entries: [
        { binding: 0, resource: { buffer: this.factSettings } }, { binding: 7, resource: { buffer: resources.get(input.appearanceMetadata) as GPUBuffer } }
      ] }));
      pass.dispatchWorkgroups(Math.ceil(metadata.directoryCount / 64)); pass.end();
    });
    constants.read(input.appearanceMetadata); constants.write(input.appearanceMetadata);

    const bindFactGroups = (pipeline: GPUComputePipeline, resources: { get(id: ResourceId): unknown }, setup: SurfaceCellGeometrySetupProducts): readonly GPUBindGroup[] => {
      const group0: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.cellSettings } }, { binding: 1, resource: resolveTextureView(resources.get(input.visibility)) }, { binding: 2, resource: { buffer: resources.get(workspace) as GPUBuffer } }
      ];
      const group1: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.factSettings } }, { binding: 1, resource: { buffer: resources.get(setup.arena) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } }, { binding: 4, resource: { buffer: resources.get(input.sourceHeap) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(input.vertexPayload) as GPUBuffer } }, { binding: 6, resource: { buffer: resources.get(input.frameInstances) as GPUBuffer } },
        { binding: 7, resource: { buffer: resources.get(input.appearanceMetadata) as GPUBuffer } }, { binding: 8, resource: { buffer: resources.get(input.textureVariation) as GPUBuffer } },
        { binding: 14, resource: { buffer: resources.get(input.camera) as GPUBuffer } }
      ];
      if (input.product !== null) { group1.push({ binding: 9, resource: { buffer: resources.get(input.product.heap) as GPUBuffer } }); input.product.banks.forEach((id, i) => group1.push({ binding: i + 10, resource: { buffer: resources.get(id) as GPUBuffer } })); }
      const group2: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: resources.get(input.lightRecords) as GPUBuffer } }, { binding: 1, resource: { buffer: resources.get(input.clusters.lookup) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(input.clusters.data) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(input.clusters.parameters) as GPUBuffer } }
      ];
      return [this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: group0 }),
        this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: group1 }),
        this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: group2 })];
    };
    let previous = constants;
    let consumed: readonly ResourceId[] = [];
    for (let batch = 0; batch < batchCount; batch++) {
      const firstTile = batch * batchTileCapacity;
      const tileCount = Math.min(batchTileCapacity, tiles - firstTile);
      const setup = input.geometryPass.addCellSetupsToGraph(graph, {
        visibility: input.visibility, meshletWork: input.meshletWork, sourceHeap: input.sourceHeap, vertexPayload: input.vertexPayload,
        frameInstances: input.frameInstances, product: input.product, width: input.width, height: input.height, tilesX,
        firstTile, tileCount, targetCapacity: input.workLayout.sampleCapacity, after: consumed,
        addressBudgetBytes: input.workLayout.sampleCapacity * 128,
        generation: input.generation, sourceGeometry: input.sourceGeometry, sourceMeshlet: input.sourceMeshlet,
        sourceMeshletVertices: input.sourceMeshletVertices, sourceMeshletTriangles: input.sourceMeshletTriangles, sourceVertexData: input.sourceVertexData
      });
      const batchReset = graph.add(`Surface/cell batch ${batch} workspace reset`, { firstTile, tileCount, setup }, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        command.gpu_encoder.clearBuffer(resources.get(workspace) as GPUBuffer, 0, batchWorkspaceLayout.bytes);
        command.gpu_encoder.clearBuffer(resources.get(counts) as GPUBuffer, 0, SURFACE_WORK_COUNTER_BYTES);
        command.writeBuffer(this.cellSettings, 0, new Uint32Array([input.width, input.height, tilesX, firstTile, tileCount, input.workLayout.sampleCapacity, input.generation, input.diagnosticsEnabled ? 1 : 0]).buffer, 0, 32);
        command.writeBuffer(this.compactSettings, 0, new Uint32Array([input.width, input.height, tilesX, firstTile, tileCount,
          input.workLayout.sampleOffset / 4, input.workLayout.tileOffset / 4, input.workLayout.sampleCapacity, input.generation]).buffer, 0, 36);
      });
      batchReset.read(setup.arena); batchReset.read(workspace); workspace = batchReset.write(workspace); counts = batchReset.write(counts); batchReset.dependsOn(previous);
      const facts = graph.add(`Surface/cell publish geometry and lighting facts batch ${batch}`, { setup, workspace }, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const pass = command.beginComputePass({ label: "Surface/cell publish geometry and lighting facts" }); pass.setPipeline(pipelines!.facts);
        bindFactGroups(pipelines!.facts, resources, setup).forEach((group, index) => pass.setBindGroup(index, group)); pass.dispatchWorkgroups(tileCount); pass.end();
      });
      facts.read(input.visibility); facts.read(setup.arena); facts.read(input.meshletWork); facts.read(input.sourceHeap); facts.read(input.vertexPayload); facts.read(input.frameInstances); facts.read(input.appearanceMetadata); facts.read(input.textureVariation); facts.read(input.camera); facts.read(input.lightRecords); facts.read(input.clusters.lookup); facts.read(input.clusters.data); facts.read(input.clusters.parameters); facts.read(workspace); workspace = facts.write(workspace); facts.dependsOn(batchReset);
      previous = facts;
      const addresses = graph.add(`Surface/canonical field addresses batch ${batch}`, { setup, workspace }, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const pass = command.beginComputePass({ label: "Surface/canonical field addresses" });
        pass.setPipeline(pipelines!.addresses);
        bindFactGroups(pipelines!.addresses, resources, setup).forEach((group, index) => pass.setBindGroup(index, group));
        pass.dispatchWorkgroups(tileCount);
        pass.end();
      });
      addresses.read(input.visibility); addresses.read(setup.arena); addresses.read(input.meshletWork);
      addresses.read(input.sourceHeap); addresses.read(input.vertexPayload); addresses.read(input.frameInstances);
      addresses.read(input.appearanceMetadata); addresses.read(input.textureVariation); addresses.read(input.camera);
      addresses.read(input.lightRecords); addresses.read(input.clusters.lookup); addresses.read(input.clusters.data); addresses.read(input.clusters.parameters);
      if (input.product !== null) { addresses.read(input.product.heap); for (const bank of input.product.banks) { addresses.read(bank); } }
      addresses.read(workspace); workspace = addresses.write(workspace); addresses.dependsOn(previous);
      const lookedUp = this.fieldLookup.addToGraph(graph, {
        workspace, metadata: input.appearanceMetadata, versions: input.fieldVersions,
        publication: input.publication, batchTiles: batchTileCapacity, tileCount,
        viewRevision: input.viewRevision, diagnostics: input.diagnosticsEnabled, bind: input.resourceBinding
      });
      workspace = lookedUp.workspace;
      fieldStore = lookedUp.store;
      previous = addresses;
      const certificateStages = [["geometry", pipelines.geometryCertificates],
        ...pipelines.fieldCertificates.map((pipeline, family) => [`field and texture family ${family}`, pipeline] as const)] as const;
      for (const [name,pipeline] of certificateStages) {
        const certificate = graph.add(`Surface/shared ${name} certificates batch ${batch}`, { setup, workspace }, (_data,resources,context) => {
          const command=context.encoder as ShadeGPUCommandContext;
          const pass=command.beginComputePass({label:`Surface/shared ${name} certificates`});
          pass.setPipeline(pipeline);
          bindFactGroups(pipeline,resources,setup).forEach((group,index) => pass.setBindGroup(index,group));
          pass.dispatchWorkgroups(tileCount);
          pass.end();
        });
        certificate.read(input.visibility); certificate.read(setup.arena); certificate.read(input.meshletWork);
        certificate.read(input.sourceHeap); certificate.read(input.vertexPayload); certificate.read(input.frameInstances);
        certificate.read(input.appearanceMetadata); certificate.read(input.textureVariation); certificate.read(input.camera);
        certificate.read(input.lightRecords); certificate.read(input.clusters.lookup); certificate.read(input.clusters.data); certificate.read(input.clusters.parameters);
        if (input.product!==null) { certificate.read(input.product.heap); for (const bank of input.product.banks) { certificate.read(bank); } }
        certificate.read(workspace); workspace=certificate.write(workspace); certificate.dependsOn(previous); previous=certificate;
      }
      for (const [stageIndex, pipeline] of pipelines!.classify.entries()) {
        const classify = graph.add(`Surface/cell classify continuity domains ${stageIndex} batch ${batch}`, { setup, workspace }, (_data, resources, context) => {
          const command = context.encoder as ShadeGPUCommandContext;
          const pass = command.beginComputePass({ label: `Surface/cell classify continuity domains ${stageIndex}` }); pass.setPipeline(pipeline);
          bindFactGroups(pipeline, resources, setup).forEach((group, index) => pass.setBindGroup(index, group)); pass.dispatchWorkgroups(tileCount); pass.end();
        });
        classify.read(input.visibility); classify.read(setup.arena); classify.read(input.meshletWork); classify.read(input.sourceHeap); classify.read(input.vertexPayload); classify.read(input.frameInstances); classify.read(input.appearanceMetadata); classify.read(input.textureVariation); classify.read(input.camera); classify.read(input.lightRecords); classify.read(input.clusters.lookup); classify.read(input.clusters.data); classify.read(input.clusters.parameters); classify.read(workspace); workspace = classify.write(workspace); classify.dependsOn(previous as any); previous = classify;
        if (stageIndex === 0) {
          const lookedUpSignals = this.signalLookup.addToGraph(graph, {
            workspace, metadata: input.appearanceMetadata, versions: input.fieldVersions,
            publication: input.publication, batchTiles: batchTileCapacity, tileCount,
            viewRevision: input.viewRevision, revisions: input.signalRevisions, sun: input.sun,
            shadowVersion: input.shadowVersion,
            shadowEnabled: input.shadowEnabled, diagnostics: input.diagnosticsEnabled, bind: input.resourceBinding
          });
          workspace = lookedUpSignals.workspace;
          signalStore = lookedUpSignals.store;
        }
      }
      const compact = graph.add(`Surface/cell compact representative work batch ${batch}`, { workspace, work, counts, sampleMap }, (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const pass = command.beginComputePass({ label: "Surface/cell compact representative work" }); pass.setPipeline(pipelines!.compact);
        pass.setBindGroup(0, makeGroup(pipelines!.compact, [
          { binding: 0, resource: { buffer: this.compactSettings } }, { binding: 1, resource: { buffer: resources.get(workspace) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(work) as GPUBuffer } }, { binding: 3, resource: { buffer: resources.get(counts) as GPUBuffer } },
          { binding: 4, resource: resolveTextureView(resources.get(sampleMap)) }
        ])); pass.dispatchWorkgroups(tileCount); pass.end();
      });
      compact.read(workspace); work = compact.write(work); counts = compact.write(counts); sampleMap = compact.write(sampleMap); compact.dependsOn(previous as any); previous = compact;
      if (input.consumeBatch !== undefined) {
        consumed = input.consumeBatch({ work, counts, sampleMap, workspace, fieldStore, signalStore, batchTileCapacity }, firstTile, tileCount, batchTileCapacity);
        const complete = graph.add(`Surface/cell batch ${batch} consumed`, {}, () => {});
        for (const resource of consumed) { complete.read(resource); }
        complete.make_side_effect();
        previous = complete;
      }
    }
    return { work, counts, sampleMap, workspace, fieldStore, signalStore, batchTileCapacity };
  }

  destroy(): void { this.fieldLookup.destroy(); this.signalLookup.destroy(); this.cellSettings.destroy(); this.factSettings.destroy(); this.compactSettings.destroy(); this.pipelines.clear(); }
}
