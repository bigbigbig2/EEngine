import { VSM_PAGE_COMMIT_WGSL } from "../../shaders/vsm_page_commit.js";
import { packVsmProjection, VSM_DEPTH_RANGE_BYTE_OFFSET, VSM_DEPTH_RANGE_BYTES } from "./VsmProjection.js";
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

export interface VsmAtlasRasterInputs {
  readonly caster: VsmCasterRecordFrame;
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
  const data = packVsmProjection(input.frame);
  const uints = new Uint32Array(data);
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
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.commitConstants = device.createBuffer({
      label: "VSM/content commit constants",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.clearLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    };
    const module = { label: "VSM/dirty-slot clear", code: VSM_ATLAS_PAGE_CLEAR_WGSL };
    this.clearPipeline = graphics.render_pipelines.obtain({
      label: "VSM/dirty-slot clear",
      layout: { bindGroupLayouts: [this.clearLayout] },
      vertex: { module, entryPoint: "clear_page" },
      fragment: { module, entryPoint: "clear_depth", targets: [] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
    this.commitLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...[2, 3, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" as GPUBufferBindingType },
        })),
      ],
    };
    this.commitPipeline = graphics.compute_pipelines.obtain({
      label: "VSM/dirty content commit",
      layout: { bindGroupLayouts: [this.commitLayout] },
      compute: { module: { code: VSM_PAGE_COMMIT_WGSL }, entryPoint: "main" },
    });
    this.contentLayout = {
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    };
    this.contentPipeline = graphics.compute_pipelines.obtain({
      label: "VSM/content version publication",
      layout: { bindGroupLayouts: [this.contentLayout] },
      compute: { module: { code: VSM_CONTENT_VERSION_WGSL }, entryPoint: "publish_vsm_content_version" },
    });
  }
  addToGraph(
    graph: FrameGraph,
    input: VsmAtlasRasterInputs,
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
      this.constants,
    );
    const atlas = graph.import_resource(
      "VSM/depth atlas",
      { kind: "imported", label: "VSM depth atlas" },
      input.resources.atlasDepth,
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
        CONSTANT_BYTES,
      );
      (context.encoder as ShadeGPUCommandContext).copyBufferToBuffer(
        _resolved.get(data.depthRange) as GPUBuffer,
        0,
        this.constants,
        VSM_DEPTH_RANGE_BYTE_OFFSET,
        VSM_DEPTH_RANGE_BYTES,
      );
    });
    update.read(input.depthRange);
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
        runtime,
      );
      const view = nativeVisibilityView(data.publication.vertices.arena, data.generation, {
        clipFromWorld: data.clipFromWorld,
        viewMatrix: data.viewMatrix,
        cameraPosition: data.cameraPosition,
        source: geometry.source,
        sourcePayload: geometry.sourcePayload,
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
          capacity: data.caster.capacity,
          generation: data.generation,
          generationSource: data.publication.meshletWork,
          camera: resolved.get(data.camera) as GPUBuffer,
          view,
          vsmAtlas: { constants: this.constants, pageTable: resolved.get(pageTable) as GPUBuffer },
        });
        this.nativePasses.set(queue, native);
      } else {
        native.update(view, data.generation);
      }
      native.prepareEncoding(command.gpu_encoder);
      const clearGroup = this.graphics.bind_groups.obtain({
        layout: this.clearLayout,
        entries: [{ buffer: this.constants }, { buffer: resolved.get(data.allocation) as GPUBuffer }],
      });
      const pass = command.beginRenderPass({
        label: "VSM/partitioned compiled caster raster",
        colorAttachments: [],
        depthStencilAttachment: {
          view: resolveTextureView(resolved.get(atlas)),
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
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
      ...(input.frameGeometry === undefined ? [] : [input.frameGeometry]),
      input.camera,
      ...(input.productHeap === undefined ? [] : [input.productHeap]),
      ...(input.productBanks ?? []),
    ])
      raster.read(id);
    const rasteredAtlas = raster.write(atlas);
    raster.make_side_effect();
    const commitConstants = graph.import_resource(
      "VSM/content commit constants",
      { kind: "imported", label: "VSM content commit constants" },
      this.commitConstants,
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
          data.resources.capabilities.atlasPagesPerAxis,
        ]).buffer,
        0,
        16,
      );
      const group = this.graphics.bind_groups.obtain({
        layout: this.commitLayout,
        entries: [
          { buffer: this.commitConstants },
          { buffer: resolved.get(caster) as GPUBuffer },
          { buffer: resolved.get(pageTable) as GPUBuffer },
          { buffer: resolved.get(data.metaTable) as GPUBuffer },
          { buffer: this.nativePasses.get(resolved.get(caster) as GPUBuffer)!.completionStatusBuffer },
          { buffer: resolved.get(data.contentVersion) as GPUBuffer },
          { buffer: resolved.get(data.allocation) as GPUBuffer },
        ],
      });
      const pass = command.beginComputePass({ label: "VSM/content commit" });
      pass.setPipeline(this.commitPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.resources.capabilities.residentSlots / 64));
      pass.end();
    });
    commit.read(caster);
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
            { buffer: resolved.get(data.contentVersion) as GPUBuffer },
          ],
        });
        const pass = command.beginComputePass({ label: "VSM/publish sampled content version" });
        pass.setPipeline(this.contentPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      },
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
      contentVersion,
    };
  }
  destroy(): void {
    this.nativePasses.forEach((pass) => pass.destroy());
    this.nativePasses.clear();
    this.constants.destroy();
    this.commitConstants.destroy();
  }
}
