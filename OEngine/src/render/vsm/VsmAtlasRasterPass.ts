import { VSM_DEFAULT_SETTINGS } from "./VsmSettings.js";
import {
  VSM_DIMENSIONS_WORD,
  VSM_CONTROL_WORD,
  VSM_PROJECTION_CONSTANT_BYTES as VSM_ABI_BYTES
} from "../../gpu/GpuVsmProjectionAbi.js";
import { PreparedComputePipeline, PreparedRenderPipeline } from "../../gpu/PreparedPipeline.js";
import { VSM_PAGE_COMMIT_WGSL } from "../../shaders/vsm_page_commit.js";
import { packVsmProjection, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTES } from "./VsmProjection.js";
import { VsmGeometryRaster } from "./VsmGeometryRaster.js";
import { nativeWinnerGeometry } from "../MeshletBucketRaster.js";
import type { PreparedFrameVertices } from "../FrameGeometryVertices.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../shaders/vsm_atlas_raster.js";
import type { VsmDirectionalFrameConstants } from "./VsmReceiverDemandPass.js";
import type { VsmResources } from "./VsmResources.js";
import { VSM_CONTENT_VERSION_WGSL } from "../../shaders/vsm_content_version.js";
import { VsmSamplingPublicationPass } from "./VsmSamplingPublicationPass.js";

export interface VsmAtlasRasterInputs {
  readonly meshletWork: ResourceId;
  readonly meshletBounds: ResourceId;
  readonly workCapacity: number;
  readonly resources: VsmResources;
  readonly frame: VsmDirectionalFrameConstants;
  readonly depthRange: ResourceId;
  readonly generation: number;
  readonly publication: Readonly<{
    runtime: GpuRenderWorldRuntime;
    assets: GpuAssetBindings;
    vertices: PreparedFrameVertices;
    meshletWork: GPUBuffer;
  }>;
  readonly camera: ResourceId;
  readonly cameraPosition: readonly [number, number, number];
  readonly viewMatrix: ArrayLike<number>;
  readonly clipFromWorld: ArrayLike<number>;
  readonly frameInstances: ResourceId;
  /** Foundation metadata/header only; VSM never consumes main prepared clips. */
  readonly frameGeometry?: ResourceId;
  readonly pageTable: ResourceId;
  readonly allocation: ResourceId;
  readonly metaTable: ResourceId;
  readonly contentVersion: ResourceId;
  readonly samplingConstants: ResourceId;
  readonly samplingTarget?: { readonly resource: ResourceId; readonly offset: number; readonly size: number };
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
const CONSTANT_BYTES = VSM_ABI_BYTES;

function packConstants(input: VsmAtlasRasterInputs): ArrayBuffer {
  const data = packVsmProjection(input.frame);
  const uints = new Uint32Array(data);
  const c = input.resources.capabilities;
  uints.set([c.virtualPagesPerAxis, c.pageSize, c.border, c.atlasDimension], VSM_DIMENSIONS_WORD);
  uints.set([input.generation >>> 0, 0, 0, c.residentSlots >>> 0], VSM_CONTROL_WORD);
  return data;
}

/** Dirty-slot clear -> shared Geometry/triangle-page raster -> complete publication. */
export class VsmAtlasRasterPass {
  async preparePipelines(): Promise<void> {
    await Promise.all([
      this.clearPipeline.prepare(),
      this.commitPipeline.prepare(),
      this.contentPipeline.prepare(),
      this.samplingPublication.preparePipelines()
    ]);
  }

  private readonly samplingPublication: VsmSamplingPublicationPass;
  private nativePass: VsmGeometryRaster | null = null;
  private readonly constants: GPUBuffer;
  private readonly commitConstants: GPUBuffer;
  private readonly clearLayout: GPUBindGroupLayoutDescriptor;
  private readonly commitLayout: GPUBindGroupLayoutDescriptor;
  private readonly clearPipeline: PreparedRenderPipeline;
  private readonly commitPipeline: PreparedComputePipeline;
  private readonly contentPipeline: PreparedComputePipeline;
  private readonly contentLayout: GPUBindGroupLayoutDescriptor;
  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    this.samplingPublication = new VsmSamplingPublicationPass(device);
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
    const module = device.createShaderModule({
      label: "VSM/dirty-slot clear",
      code: VSM_ATLAS_PAGE_CLEAR_WGSL
    });
    this.clearPipeline = new PreparedRenderPipeline(device, {
      label: "VSM/dirty-slot clear",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout(this.clearLayout)]
      }),
      vertex: { module, entryPoint: "clear_page" },
      fragment: { module, entryPoint: "clear_depth", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" }
    });
    this.commitLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...[2, 3, 5, 7].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType }
        }))
      ]
    };
    this.commitPipeline = new PreparedComputePipeline(device, {
      label: "VSM/dirty content commit",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout(this.commitLayout)]
      }),
      compute: { module: device.createShaderModule({ code: VSM_PAGE_COMMIT_WGSL }), entryPoint: "main" }
    });
    this.contentLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    };
    this.contentPipeline = new PreparedComputePipeline(device, {
      label: "VSM/content version publication",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout(this.contentLayout)]
      }),
      compute: {
        module: device.createShaderModule({ code: VSM_CONTENT_VERSION_WGSL }),
        entryPoint: "publish_vsm_content_version"
      }
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
    readonly samplingDescriptors: ResourceId;
  } {
    if (!input.resources.atlasDepth || !input.resources.rasterStatus)
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
    const pageTable = input.pageTable;
    const mutation = graph.import_resource(
      "VSM/commit descriptor mutations",
      { kind: "imported" },
      input.resources.getBuffer("descriptorMutations")!
    );
    const status = graph.import_resource(
      "VSM/raster completion and work",
      { kind: "imported" },
      input.resources.rasterStatus!
    );
    const update = graph.add("VSM/update atlas constants", input, (data, _resolved, context) => {
      (context.encoder as ShadeGPUCommandContext).writeBuffer(
        this.constants,
        0,
        packConstants(data),
        0,
        CONSTANT_BYTES
      );
      (context.encoder as ShadeGPUCommandContext).copyBufferToBuffer(
        _resolved.get(data.depthRange) as GPUBuffer,
        0,
        this.constants,
        VSM_DEPTH_RANGE_BYTE_OFFSET,
        VSM_DEPTH_RANGE_BYTES
      );
    });
    update.read(input.depthRange);
    const currentConstants = update.write(constants);
    const raster = graph.add("VSM/partitioned compiled caster raster", input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext,
        runtime = data.publication.runtime,
        scene = runtime.nativeMaterials!;
      const queue = resolved.get(data.meshletWork) as GPUBuffer;
      const geometry = nativeWinnerGeometry(
        data.publication.assets,
        data.publication.vertices,
        queue,
        resolved.get(data.frameInstances) as GPUBuffer,
        runtime
      );
      const pageCapacity = Math.min(
        data.resources.capabilities.residentSlots,
        (data.frame.settings ?? VSM_DEFAULT_SETTINGS).dirtyPageBudget
      );
      let native = this.nativePass;
      const previous = native;
      if (
        native &&
        (native.input.geometry.meshletWork !== queue ||
          native.input.workCapacity !== data.workCapacity ||
          native.input.bounds !== resolved.get(data.meshletBounds) ||
          native.input.publication !== scene.publication ||
          native.input.geometry.arena !== geometry.arena ||
          native.input.geometry.instances !== geometry.instances ||
          native.input.geometry.vertexPayload !== geometry.vertexPayload ||
          native.input.geometry.productHeap !== geometry.productHeap ||
          native.input.geometry.productBanks?.some(
            (bank, index) => bank !== geometry.productBanks?.[index]
          ) ||
          native.input.geometry.source.some((offset, index) => offset !== geometry.source[index]) ||
          native.input.geometry.sourcePayload.some(
            (offset, index) => offset !== geometry.sourcePayload[index]
          ) ||
          native.input.allocation !== resolved.get(data.allocation) ||
          native.input.pageCapacity !== pageCapacity)
      ) {
        native = null;
      }
      if (!native) {
        native = new VsmGeometryRaster(
          this.graphics,
          {
            geometry,
            publication: scene.publication,
            constants: this.constants,
            allocation: resolved.get(data.allocation) as GPUBuffer,
            bounds: resolved.get(data.meshletBounds) as GPUBuffer,
            status: resolved.get(status) as GPUBuffer,
            workCapacity: data.workCapacity,
            pageCapacity,
            maxBytes: (data.resources.capabilities.atlasDimension === 8192 ? 64 : 32) * 1024 * 1024
          },
          previous ?? undefined
        );
        this.nativePass = native;
        if (previous) {
          command.destroyAfterGpuDone(previous);
        }
      }
      const clearGroup = this.graphics.bind_groups.obtain({
        layout: this.clearLayout,
        entries: [{ buffer: this.constants }, { buffer: resolved.get(data.allocation) as GPUBuffer }]
      });
      native.encode(
        command,
        resolved.get(data.camera) as GPUBuffer,
        () =>
          command.beginRenderPass({
            label: "VSM/page-confined triangle raster",
            colorAttachments: [],
            depthStencilAttachment: {
              view: resolveTextureView(resolved.get(atlas)),
              depthLoadOp: "load",
              depthStoreOp: "store"
            }
          }),
        (pass, indirect) => {
          pass.setPipeline(this.clearPipeline.requirePrepared());
          pass.setBindGroup(0, clearGroup);
          pass.drawIndirect(indirect, 48);
        }
      );
    });
    for (const id of [
      currentConstants,
      input.allocation,
      input.meshletWork,
      input.meshletBounds,
      pageTable,
      input.instances,
      input.meshlets,
      input.meshletVertices,
      input.meshletTriangles,
      input.vertexData,
      input.geometries,
      input.materials,
      input.frameInstances,
      ...(input.frameGeometry === undefined ? [] : [input.frameGeometry]),
      input.camera,
      ...(input.productHeap === undefined ? [] : [input.productHeap]),
      ...(input.productBanks ?? [])
    ])
      raster.read(id);
    const rasteredAtlas = raster.write(atlas);
    const rasterStatus = raster.write(status);
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
        new Uint32Array([
          data.generation,
          data.frame.projectionEpoch,
          data.frame.namespace,
          data.resources.capabilities.atlasPagesPerAxis
        ]).buffer,
        0,
        16
      );
      const group = this.graphics.bind_groups.obtain({
        layout: this.commitLayout,
        entries: [
          { buffer: this.commitConstants },
          { buffer: resolved.get(rasterStatus) as GPUBuffer },
          { buffer: resolved.get(pageTable) as GPUBuffer },
          { buffer: resolved.get(data.metaTable) as GPUBuffer },
          { buffer: resolved.get(data.contentVersion) as GPUBuffer },
          { buffer: resolved.get(data.allocation) as GPUBuffer },
          { buffer: resolved.get(committedMutations) as GPUBuffer }
        ]
      });
      const pass = command.beginComputePass({ label: "VSM/content commit" });
      pass.setPipeline(this.commitPipeline.requirePrepared());
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.resources.capabilities.residentSlots / 64));
      pass.end();
      // Publication amplification denominator inputs, read after the residency
      // pass wrote this frame's selection: word 0 is the dirty candidate count,
      // word 1 the bounded complete-page selection.
      const allocationBuffer = resolved.get(data.allocation) as GPUBuffer;
      this.graphics.profiler.copyGpuCounter(command, "vsmDirtyPagesDirty", allocationBuffer, 0);
      this.graphics.profiler.copyGpuCounter(command, "vsmDirtyPagesSelected", allocationBuffer, 4);
      if (data.resources.overflowCounters) {
        this.graphics.profiler.copyGpuCounter(
          command,
          "vsmDirtyPagesPending",
          data.resources.overflowCounters,
          28
        );
      }
    });
    const committedMutations = commit.write(mutation);
    commit.read(rasterStatus);
    commit.read(rasteredAtlas);
    commit.read(commitConstants);
    const publishedPageTable = commit.write(pageTable),
      publishedMetaTable = commit.write(input.metaTable);
    const dirtyContent = commit.write(input.contentVersion);
    commit.read(input.allocation);
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
        pass.setPipeline(this.contentPipeline.requirePrepared());
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
    const samplingDescriptors = this.samplingPublication.addToGraph(graph, {
      resources: input.resources,
      mutations: committedMutations,
      pages: input.resources.capabilities.virtualPagesPerAxis,
      levels: input.resources.capabilities.clipLevels,
      constants: input.samplingConstants,
      pageTable: publishedPageTable,
      contentVersion,
      target: input.samplingTarget
    });
    return {
      samplingDescriptors,
      atlasDepth: rasteredAtlas,
      pageTable: publishedPageTable,
      metaTable: publishedMetaTable,
      contentVersion
    };
  }
  destroy(): void {
    this.samplingPublication.destroy();
    this.nativePass?.destroy();
    this.nativePass = null;
    this.constants.destroy();
    this.commitConstants.destroy();
  }

  /** Borrowed Scene source/publication is retained only through its last GPU fence. */
  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    const publication = runtime.nativeMaterials?.publication;
    if (this.nativePass && this.nativePass.input.publication === publication) {
      const previous = this.nativePass;
      this.nativePass = null;
      command.destroyAfterGpuDone(previous);
    }
  }
}
