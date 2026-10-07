import { NativeVisibilityPass } from "../surface/NativeVisibilityPass.js";
import { nativeWinnerGeometry } from "../MeshletBucketRaster.js";
import { nativeVisibilityView } from "../../shaders/native_visibility.js";
import type { PreparedFrameVertices } from "../FrameGeometryVertices.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../shaders/vsm_atlas_raster.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import type { VsmCasterRecordFrame } from "./VsmCasterRecordPass.js";
import { VSM_CONTENT_VERSION_WGSL } from "../../shaders/vsm_content_version.js";

const DIRTY_COMMIT_WGSL = /* wgsl */ `
struct Constants { generation: u32, reserved0: u32, reserved1: u32, reserved2: u32 };
struct Record { instance_record_index: u32, geometry_record_index: u32, meshlet_record_index: u32, material_handle: u32, page_slot: u32, virtual_page: u32, raster_flags: u32, packed_profile_lod: u32 };
struct Caster { attempted: u32, written: u32, overflow: u32, generation: u32, records: array<Record> };
struct Entry { slot_x: u32, slot_y: u32, mip: u32, flags: u32, generation: u32, fallback_mip: u32, reserved_0: u32, reserved_1: u32 };
struct Meta { virtual_page: u32, mip: u32, last_visited: u32, flags: u32, generation: u32, owner: u32, reserved_0: u32, reserved_1: u32 };
struct Table { entries: array<Entry>, }
struct Metas { entries: array<Meta>, }
struct Locks { values: array<atomic<u32>>, }
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> caster: Caster;
@group(0) @binding(2) var<storage, read_write> page_table: Table;
@group(0) @binding(3) var<storage, read_write> meta_table: Metas;
@group(0) @binding(4) var<storage, read_write> page_locks: Locks;
@group(0) @binding(5) var<storage, read_write> content_version:array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // A truncated caster list cannot prove that any dirty page is complete.
  if (caster.overflow != 0u) { return; }
  let count = min(caster.written, arrayLength(&caster.records));
  if (id.x >= count) { return; }
  let record = caster.records[id.x];
  if (record.virtual_page >= arrayLength(&page_table.entries) || record.virtual_page >= arrayLength(&page_locks.values)) { return; }
  let lock = atomicCompareExchangeWeak(&page_locks.values[record.virtual_page], 0u, 1u);
  if (!lock.exchanged) { return; }
  var entry = page_table.entries[record.virtual_page];
  if (entry.generation == constants.generation && (entry.flags & 1u) != 0u && (entry.flags & 8u) != 0u) {
    if ((entry.flags & 2u) != 0u) {
      // This lock owns publication of the completed page content. Multiple
      // caster records for one page advance its content version only once.
      entry.reserved_0 = max(1u, entry.reserved_0 + 1u);
      atomicStore(&content_version[1u],1u);
    }
    entry.flags = entry.flags & ~2u;
    page_table.entries[record.virtual_page] = entry;
    if (record.page_slot < arrayLength(&meta_table.entries)) {
      var slot_meta = meta_table.entries[record.page_slot];
      if (slot_meta.virtual_page == record.virtual_page && slot_meta.generation == constants.generation) {
        slot_meta.flags = slot_meta.flags & ~2u;
        slot_meta.reserved_0 = entry.reserved_0;
        meta_table.entries[record.page_slot] = slot_meta;
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
  readonly publication: Readonly<{
    runtime: GpuRenderWorldRuntime;
    assets: GpuAssetBindings;
    vertices: PreparedFrameVertices;
    meshletWork: GPUBuffer;
  }>;
  readonly camera: ResourceId;
  readonly frameInstances: ResourceId;
  readonly pageTable: ResourceId;
  readonly allocation: ResourceId;
  readonly metaTable: ResourceId;
  readonly pageLocks: ResourceId;
  readonly contentVersion: ResourceId;
  readonly instances: ResourceId;
  readonly meshlets: ResourceId;
  readonly meshletVertices: ResourceId;
  readonly meshletTriangles: ResourceId;
  readonly vertexData: ResourceId;
  readonly geometries: ResourceId;
  readonly materials: ResourceId;
  readonly productHeap?: ResourceId;
  readonly productBanks?: readonly ResourceId[];
}
const CONSTANT_BYTES = 256;

function packConstants(input: VsmAtlasRasterInputs): ArrayBuffer {
  const data = new ArrayBuffer(CONSTANT_BYTES);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  floats.set(input.frame.lightView, 0);
  for (let level = 0; level < 6; level++)
    floats.set(input.frame.clipOriginExtent[level] ?? [0, 0, 1, 1], 16 + level * 4);
  const c = input.resources.capabilities;
  uints.set([c.virtualPagesPerAxis, c.pageSize, c.border, c.atlasDimension], 40);
  uints.set([input.generation >>> 0, 0, c.casterRecordCapacity >>> 0, c.residentSlots >>> 0], 44);
  return data;
}

/** Dirty-slot clear -> finite compiled caster partitions -> content publication. */
export class VsmAtlasRasterPass {
  private readonly nativePasses = new Map<GPUBuffer, NativeVisibilityPass>();
  private readonly constants: GPUBuffer;
  private readonly commitConstants: GPUBuffer;
  private readonly clearLayout: GPUBindGroupLayoutDescriptor;
  private readonly commitLayout: GPUBindGroupLayoutDescriptor;
  private readonly clearPipeline: GPURenderPipeline;
  private readonly commitPipeline: GPUComputePipeline;
  private readonly contentPipeline: GPUComputePipeline;
  private readonly contentLayout: GPUBindGroupLayoutDescriptor;
  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    this.constants = device.createBuffer({
      label: "VSM/atlas constants",
      size: CONSTANT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.commitConstants = device.createBuffer({
      label: "VSM/content commit constants",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.clearLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }
      ]
    };
    const module = { label: "VSM/dirty-slot clear", code: VSM_ATLAS_PAGE_CLEAR_WGSL };
    this.clearPipeline = graphics.render_pipelines.obtain({
      label: "VSM/dirty-slot clear",
      layout: { bindGroupLayouts: [this.clearLayout] },
      vertex: { module, entryPoint: "clear_page" },
      fragment: { module, entryPoint: "clear_depth", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
    });
    this.commitLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...[2, 3, 4, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType }
        }))
      ]
    };
    this.commitPipeline = graphics.compute_pipelines.obtain({
      label: "VSM/dirty content commit",
      layout: { bindGroupLayouts: [this.commitLayout] },
      compute: { module: { code: DIRTY_COMMIT_WGSL }, entryPoint: "main" }
    });
    this.contentLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    };
    this.contentPipeline = graphics.compute_pipelines.obtain({
      label: "VSM/content version publication",
      layout: { bindGroupLayouts: [this.contentLayout] },
      compute: { module: { code: VSM_CONTENT_VERSION_WGSL }, entryPoint: "publish_vsm_content_version" }
    });
  }
  addToGraph(
    graph: FrameGraph,
    input: VsmAtlasRasterInputs
  ): {
    readonly atlasDepth: ResourceId;
    readonly pageTable: ResourceId;
    readonly metaTable: ResourceId;
    readonly contentVersion: ResourceId;
  } {
    if (!input.resources.atlasDepth || !input.resources.casterRecords)
      throw new Error("VSM raster resources are absent");
    const constants = graph.import_resource(
      "VSM/atlas constants",
      { kind: "imported", label: "VSM atlas constants" },
      this.constants
    );
    const atlas = graph.import_resource(
      "VSM/depth atlas",
      { kind: "imported", label: "VSM depth atlas" },
      input.resources.atlasDepth
    );
    const caster = input.caster.casterRecords,
      indirect = input.caster.rasterIndirect,
      pageTable = input.pageTable;
    const update = graph.add("VSM/update atlas constants", input, (data, _resolved, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(
        this.constants,
        0,
        packConstants(data),
        0,
        CONSTANT_BYTES
      );
    });
    const currentConstants = update.write(constants);
    const raster = graph.add("VSM/partitioned compiled caster raster", input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext,
        runtime = data.publication.runtime,
        scene = runtime.nativeMaterials!;
      const queue = resolved.get(caster) as GPUBuffer;
      const geometry = nativeWinnerGeometry(
        data.publication.assets,
        data.publication.vertices,
        queue,
        resolved.get(data.frameInstances) as GPUBuffer,
        runtime
      );
      const view = nativeVisibilityView(data.publication.vertices.arena, data.generation, {
        clipFromWorld: new Float32Array(16),
        viewMatrix: new Float32Array(16),
        cameraPosition: [0, 0, 0],
        source: geometry.source,
        sourcePayload: geometry.sourcePayload
      });
      new Uint32Array(view.buffer)[39] = data.generation;
      let native = this.nativePasses.get(queue);
      if (
        native !== undefined &&
        (native.input.publication !== scene.publication ||
          native.input.geometry.arena !== geometry.arena ||
          native.input.geometry.instances !== geometry.instances ||
          native.input.geometry.productHeap !== geometry.productHeap ||
          native.input.vsmAtlas?.pageTable !== resolved.get(pageTable))
      ) {
        void native.retire(this.graphics.device.queue.onSubmittedWorkDone());
        this.nativePasses.delete(queue);
        native = undefined;
      }
      if (native === undefined) {
        native = new NativeVisibilityPass(this.graphics.device, {
          graphics: this.graphics,
          geometry,
          publication: scene.publication,
          routes: scene.routes,
          capacity: data.caster.capacity,
          generation: data.generation,
          generationSource: data.publication.meshletWork,
          camera: resolved.get(data.camera) as GPUBuffer,
          view,
          vsmAtlas: { constants: this.constants, pageTable: resolved.get(pageTable) as GPUBuffer }
        });
        this.nativePasses.set(queue, native);
      } else {
        native.update(
          view,
          scene.routes.map((route) => route.frameInputs),
          data.generation
        );
      }
      native.prepareEncoding(command.gpu_encoder);
      const clearGroup = this.graphics.bind_groups.obtain({
        layout: this.clearLayout,
        entries: [{ buffer: this.constants }, { buffer: resolved.get(data.allocation) as GPUBuffer }]
      });
      const pass = command.beginRenderPass({
        label: "VSM/partitioned compiled caster raster",
        colorAttachments: [],
        depthStencilAttachment: {
          view: resolveTextureView(resolved.get(atlas)),
          depthLoadOp: "load",
          depthStoreOp: "store"
        }
      });
      pass.setPipeline(this.clearPipeline);
      pass.setBindGroup(0, clearGroup);
      pass.drawIndirect(resolved.get(indirect) as GPUBuffer, 32);
      native.draw(pass);
      pass.end();
    });
    for (const id of [
      currentConstants,
      input.allocation,
      caster,
      indirect,
      pageTable,
      input.instances,
      input.meshlets,
      input.meshletVertices,
      input.meshletTriangles,
      input.vertexData,
      input.geometries,
      input.materials,
      input.frameInstances,
      input.camera,
      ...(input.productHeap === undefined ? [] : [input.productHeap]),
      ...(input.productBanks ?? [])
    ])
      raster.read(id);
    const rasteredAtlas = raster.write(atlas);
    raster.make_side_effect();
    const commitConstants = graph.import_resource(
      "VSM/content commit constants",
      { kind: "imported", label: "VSM content commit constants" },
      this.commitConstants
    );
    const commit = graph.add("VSM/commit complete dirty pages", input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      command.writeBuffer(
        this.commitConstants,
        0,
        new Uint32Array([data.generation >>> 0, 0, 0, 0]).buffer,
        0,
        16
      );
      const group = this.graphics.bind_groups.obtain({
        layout: this.commitLayout,
        entries: [
          { buffer: this.commitConstants },
          { buffer: resolved.get(caster) as GPUBuffer },
          { buffer: resolved.get(pageTable) as GPUBuffer },
          { buffer: resolved.get(data.metaTable) as GPUBuffer },
          { buffer: resolved.get(data.pageLocks) as GPUBuffer },
          { buffer: resolved.get(data.contentVersion) as GPUBuffer }
        ]
      });
      const pass = command.beginComputePass({ label: "VSM/content commit" });
      pass.setPipeline(this.commitPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.caster.capacity / 64));
      pass.end();
    });
    commit.read(caster);
    commit.read(rasteredAtlas);
    commit.read(commitConstants);
    const publishedPageTable = commit.write(pageTable),
      publishedMetaTable = commit.write(input.metaTable);
    const dirtyContent = commit.write(input.contentVersion);
    commit.write(input.pageLocks);
    commit.make_side_effect();
    commit.dependsOn(raster);
    const publishContent = graph.add(
      "VSM/publish sampled content version",
      { contentVersion: dirtyContent },
      (data, resolved, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const group = this.graphics.bind_groups.obtain({
          layout: this.contentLayout,
          entries: [
            { buffer: this.commitConstants },
            { buffer: resolved.get(data.contentVersion) as GPUBuffer }
          ]
        });
        const pass = command.beginComputePass({ label: "VSM/publish sampled content version" });
        pass.setPipeline(this.contentPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      }
    );
    publishContent.read(dirtyContent);
    publishContent.read(publishedPageTable);
    publishContent.read(publishedMetaTable);
    publishContent.read(rasteredAtlas);
    publishContent.dependsOn(commit);
    const contentVersion = publishContent.write(dirtyContent);
    return {
      atlasDepth: rasteredAtlas,
      pageTable: publishedPageTable,
      metaTable: publishedMetaTable,
      contentVersion
    };
  }
  destroy(): void {
    this.nativePasses.forEach((pass) => pass.destroy());
    this.nativePasses.clear();
    this.constants.destroy();
    this.commitConstants.destroy();
  }
}
