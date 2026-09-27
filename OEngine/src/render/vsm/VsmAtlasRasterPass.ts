import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VSM_ATLAS_PRODUCT_RASTER_WGSL, VSM_ATLAS_RASTER_WGSL, VSM_RASTER_BATCH_COUNT } from "../../shaders/vsm_atlas_raster.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmCasterRecordFrame } from "./VsmCasterRecordPass.js";

const DIRTY_COMMIT_WGSL = /* wgsl */ `
struct Constants { generation: u32, reserved0: u32, reserved1: u32, reserved2: u32 };
struct Record { instance_record_index: u32, geometry_record_index: u32, meshlet_record_index: u32, material_handle: u32, page_slot: u32, virtual_page: u32, raster_flags: u32, packed_profile_lod: u32 };
struct Caster { attempted: u32, written: u32, overflow: u32, generation: u32, records: array<Record> };
struct Entry { slot_x: u32, slot_y: u32, mip: u32, flags: u32, generation: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32 };
struct Meta { virtual_page: u32, mip: u32, last_visited: u32, flags: u32, generation: u32, owner: u32, reserved_0: u32, reserved_1: u32 };
struct Table { entries: array<Entry> }; struct Metas { entries: array<Meta> }; struct Locks { values: array<atomic<u32>> };
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> caster: Caster;
@group(0) @binding(2) var<storage, read_write> page_table: Table;
@group(0) @binding(3) var<storage, read_write> meta_table: Metas;
@group(0) @binding(4) var<storage, read_write> page_locks: Locks;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let count = min(caster.written, arrayLength(&caster.records));
  if (id.x >= count) { return; }
  let record = caster.records[id.x];
  if (record.virtual_page >= arrayLength(&page_table.entries) || record.virtual_page >= arrayLength(&page_locks.values)) { return; }
  let lock = atomicCompareExchangeWeak(&page_locks.values[record.virtual_page], 0u, 1u);
  if (!lock.exchanged) { return; }
  var entry = page_table.entries[record.virtual_page];
  if (entry.generation == constants.generation && (entry.flags & 1u) != 0u && (entry.flags & 8u) != 0u) {
    entry.flags = entry.flags & ~2u;
    page_table.entries[record.virtual_page] = entry;
    if (record.page_slot < arrayLength(&meta_table.entries)) {
      var meta = meta_table.entries[record.page_slot];
      if (meta.virtual_page == record.virtual_page && meta.generation == constants.generation) {
        meta.flags = meta.flags & ~2u;
        meta_table.entries[record.page_slot] = meta;
      }
    }
  }
  atomicStore(&page_locks.values[record.virtual_page], 0u);
}
`;

export interface VsmAtlasRasterInputs {
  readonly caster: VsmCasterRecordFrame;
  readonly resources: VsmResources;
  readonly frame: VsmDirectionalFrameConstants;
  readonly generation: number;
  readonly pageTable: ResourceId;
  readonly metaTable: ResourceId;
  readonly pageLocks: ResourceId;
  readonly instances: ResourceId;
  readonly meshlets: ResourceId;
  readonly meshletVertices: ResourceId;
  readonly meshletTriangles: ResourceId;
  readonly vertexData: ResourceId;
  readonly geometries: ResourceId;
  readonly materials: ResourceId;
  readonly textureBanks: readonly (readonly ResourceId[])[];
  readonly productHeap?: ResourceId;
  readonly productBanks?: readonly ResourceId[];
}

const CONSTANT_BYTES = 256;

function packConstants(input: VsmAtlasRasterInputs): ArrayBuffer {
  const data = new ArrayBuffer(CONSTANT_BYTES);
  const floats = new Float32Array(data); const uints = new Uint32Array(data);
  floats.set(input.frame.lightView, 0);
  for (let level = 0; level < 6; level++) floats.set(input.frame.clipOriginExtent[level] ?? [0, 0, 1, 1], 16 + level * 4);
  const c = input.resources.capabilities;
  uints.set([c.virtualPagesPerAxis, c.pageSize, c.border, c.atlasDimension], 40);
  uints.set([input.generation >>> 0, 0, c.casterRecordCapacity >>> 0, c.residentSlots >>> 0], 44);
  return data;
}

function productLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({ label: "VSM/Product Atlas raster layout", entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ...Array.from({ length: 9 }, (_, i) => ({ binding: 9 + i, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d-array" as GPUTextureViewDimension } })),
    { binding: 18, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
  ] });
}

/** One atlas render pass with fixed ordinary/Product opaque and alpha-mask draws. */
export class VsmAtlasRasterPass {
  private readonly constants: GPUBuffer;
  private readonly commitConstants: GPUBuffer;
  private readonly ordinaryLayout: GPUBindGroupLayout;
  private readonly productRasterLayout: GPUBindGroupLayout;
  private readonly commitLayout: GPUBindGroupLayout;
  private readonly commitPipeline: GPUComputePipeline;
  private readonly ordinaryPipelines = new Map<string, GPURenderPipeline>();
  private readonly productPipelines = new Map<string, GPURenderPipeline>();
  private readonly ordinaryModule: GPUShaderModule;
  private readonly productModule: GPUShaderModule;

  constructor(private readonly device: GPUDevice) {
    this.constants = device.createBuffer({ label: "VSM/atlas constants", size: CONSTANT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.commitConstants = device.createBuffer({ label: "VSM/raster commit constants", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.ordinaryLayout = device.createBindGroupLayout({ label: "VSM/ordinary Atlas raster layout", entries: [
      { binding: 0, visibility, buffer: { type: "uniform" } }, { binding: 1, visibility, buffer: { type: "read-only-storage" } }, { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 9, visibility, buffer: { type: "read-only-storage" } },
      ...Array.from({ length: 9 }, (_, i) => ({ binding: 10 + i, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d-array" as GPUTextureViewDimension } }))
    ] });
    this.productRasterLayout = productLayout(device);
    this.commitLayout = device.createBindGroupLayout({ label: "VSM/raster dirty commit layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ] });
    this.commitPipeline = device.createComputePipeline({ label: "VSM/raster dirty commit", layout: device.createPipelineLayout({ bindGroupLayouts: [this.commitLayout] }), compute: { module: device.createShaderModule({ label: "VSM/raster dirty commit WGSL", code: DIRTY_COMMIT_WGSL }), entryPoint: "main" } });
    this.ordinaryModule = device.createShaderModule({ label: "VSM/ordinary Atlas raster WGSL", code: VSM_ATLAS_RASTER_WGSL });
    this.productModule = device.createShaderModule({ label: "VSM/Product Atlas raster WGSL", code: VSM_ATLAS_PRODUCT_RASTER_WGSL });
  }

  addToGraph(graph: FrameGraph, input: VsmAtlasRasterInputs): void {
    if (!input.resources.atlasDepth || !input.resources.atlasDepthView) throw new Error("VSM atlas depth is unavailable");
    if (!input.resources.metaTable || !input.resources.pageLocks) throw new Error("VSM raster residency buffers are unavailable");
    const constants = graph.import_resource("VSM/atlas constants", { kind: "imported", label: "VSM atlas constants" }, this.constants);
    const atlas = graph.import_resource("VSM/physical depth atlas", { kind: "imported", label: "VSM physical depth atlas" }, input.resources.atlasDepth);
    const caster = graph.import_resource("VSM/atlas caster records", { kind: "imported", label: "VSM caster records" }, this.getBuffer(input.caster.casterRecords, input.resources.casterRecords));
    const indirect = graph.import_resource("VSM/atlas raster indirect", { kind: "imported", label: "VSM raster indirect" }, this.getBuffer(input.caster.rasterIndirect, input.resources.rasterIndirect));
    const pageTable = input.pageTable;
    const metaTable = input.metaTable;
    const pageLocks = input.pageLocks;
    const update = graph.add("VSM/update atlas constants", input, (data, _resources, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(this.constants, 0, packConstants(data), 0, CONSTANT_BYTES);
    });
    const currentConstants = update.write(constants);
    const raster = graph.add("VSM/fixed atlas raster", {}, (_data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const atlasView = resolveTextureView(resolved.get(atlas));
      const pass = command.beginRenderPass({ label: "VSM/fixed atlas raster", colorAttachments: [], depthStencilAttachment: { view: atlasView, depthLoadOp: "load", depthStoreOp: "store" } });
      for (let id = 0; id < input.textureBanks.length; id++) {
        const set = input.textureBanks[id];
        if (!set || set.length < 9) continue;
        for (let batch = 0; batch < VSM_RASTER_BATCH_COUNT; batch++) {
          pass.setPipeline(this.getOrdinaryPipeline(id, batch));
          pass.setBindGroup(0, this.makeOrdinaryBindGroup(input, resolved, currentConstants, caster, pageTable, set));
          pass.drawIndirect(resolved.get(indirect) as GPUBuffer, batch * 16);
        }
      }
      if (input.productHeap !== undefined && input.productBanks !== undefined && input.productBanks.length >= 4) {
        for (let id = 0; id < input.textureBanks.length; id++) {
          const set = input.textureBanks[id];
          if (!set || set.length < 9) continue;
          for (let batch = 0; batch < VSM_RASTER_BATCH_COUNT; batch++) {
            pass.setPipeline(this.getProductPipeline(id, batch));
            pass.setBindGroup(0, this.makeProductBindGroup(input, resolved, currentConstants, caster, pageTable, set));
            pass.drawIndirect(resolved.get(indirect) as GPUBuffer, batch * 16);
          }
        }
      }
      pass.end();
    });
    raster.read(currentConstants); raster.read(caster); raster.read(indirect); raster.read(pageTable); raster.write(atlas); raster.make_side_effect();
    const commitConstants = graph.import_resource("VSM/raster commit constants", { kind: "imported", label: "VSM raster commit constants" }, this.commitConstants);
    const commit = graph.add("VSM/commit rasterized dirty pages", input, (data, resolved, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(this.commitConstants, 0, new Uint32Array([data.generation >>> 0, 0, 0, 0]).buffer, 0, 16);
      const group = this.device.createBindGroup({ label: "VSM/raster dirty commit bindings", layout: this.commitLayout, entries: [
        { binding: 0, resource: { buffer: resolved.get(commitConstants) as GPUBuffer } }, { binding: 1, resource: { buffer: resolved.get(caster) as GPUBuffer } },
        { binding: 2, resource: { buffer: resolved.get(pageTable) as GPUBuffer } }, { binding: 3, resource: { buffer: resolved.get(metaTable) as GPUBuffer } }, { binding: 4, resource: { buffer: resolved.get(pageLocks) as GPUBuffer } }
      ] });
      const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({ label: "VSM/raster dirty commit" });
      pass.setPipeline(this.commitPipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(input.resources.capabilities.casterRecordCapacity / 64)); pass.end();
    });
    commit.read(caster); commit.read(atlas); commit.read(raster ? pageTable : pageTable); commit.write(pageTable); commit.write(metaTable); commit.write(pageLocks); commit.read(commitConstants); commit.make_side_effect(); commit.dependsOn(raster);
  }

  private getBuffer(id: ResourceId, fallback: GPUBuffer | null): GPUBuffer {
    if (fallback === null) throw new Error(`VSM resource ${id} is unavailable`);
    return fallback;
  }

  private getOrdinaryPipeline(setId: number, batch: number): GPURenderPipeline {
    const key = `${setId}:${batch}`; const cached = this.ordinaryPipelines.get(key); if (cached) return cached;
    const pipeline = this.device.createRenderPipeline({ label: `VSM/ordinary atlas batch ${key}`, layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.ordinaryLayout] }), vertex: { module: this.ordinaryModule, entryPoint: "vsm_atlas_vertex", constants: { OENGINE_VSM_BATCH: batch } }, fragment: { module: this.ordinaryModule, entryPoint: "vsm_atlas_fragment", constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: setId, OENGINE_VSM_BATCH: batch }, targets: [] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" } });
    this.ordinaryPipelines.set(key, pipeline); return pipeline;
  }
  private getProductPipeline(setId: number, batch: number): GPURenderPipeline {
    const key = `${setId}:${batch}`; const cached = this.productPipelines.get(key); if (cached) return cached;
    const pipeline = this.device.createRenderPipeline({ label: `VSM/Product atlas batch ${key}`, layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.productRasterLayout] }), vertex: { module: this.productModule, entryPoint: "vsm_atlas_product_vertex", constants: { OENGINE_VSM_BATCH: batch } }, fragment: { module: this.productModule, entryPoint: "vsm_atlas_product_fragment", constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: setId, OENGINE_VSM_BATCH: batch }, targets: [] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" } });
    this.productPipelines.set(key, pipeline); return pipeline;
  }
  private makeOrdinaryBindGroup(input: VsmAtlasRasterInputs, resolved: any, constants: ResourceId, caster: ResourceId, pageTable: ResourceId, textureSet: readonly ResourceId[]): GPUBindGroup {
    const b = (binding: number, id: ResourceId) => ({ binding, resource: { buffer: resolved.get(id) as GPUBuffer } });
    const t = (binding: number, id: ResourceId) => ({ binding, resource: resolveTextureView(resolved.get(id)) });
    return this.device.createBindGroup({ layout: this.ordinaryLayout, entries: [b(0, constants), b(1, caster), b(2, pageTable), b(3, input.instances), b(4, input.meshlets), b(5, input.meshletVertices), b(6, input.meshletTriangles), b(7, input.vertexData), b(8, input.geometries), b(9, input.materials), ...textureSet.slice(0, 9).map((id, index) => t(10 + index, id))] });
  }
  private makeProductBindGroup(input: VsmAtlasRasterInputs, resolved: any, constants: ResourceId, caster: ResourceId, pageTable: ResourceId, textureSet: readonly ResourceId[]): GPUBindGroup {
    const b = (binding: number, id: ResourceId) => ({ binding, resource: { buffer: resolved.get(id) as GPUBuffer } });
    const t = (binding: number, id: ResourceId) => ({ binding, resource: resolveTextureView(resolved.get(id)) });
    return this.device.createBindGroup({ layout: this.productRasterLayout, entries: [b(0, constants), b(1, caster), b(2, pageTable), b(3, input.instances), b(4, input.productHeap!), ...input.productBanks!.slice(0, 4).map((id, index) => b(5 + index, id)), ...textureSet.slice(0, 9).map((id, index) => t(9 + index, id)), b(18, input.materials)] });
  }
  destroy(): void { this.constants.destroy(); this.commitConstants.destroy(); }
}
