import { counterByteOffset, GPU_COUNTER_BYTE_SIZE } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { SHADOW_COMPARISON_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import { GPU_RASTER_WORK_SCHEMA, GPU_WORK_QUEUE_HEADER_SCHEMA } from "../../gpu/GpuWorkGenerationAbi.js";
import { HDR_COLOR_FORMAT } from "../RenderTargets.js";
import {
  HierarchicalWorkGenerator,
  type GeneratedHierarchyWork,
  type PreparedHierarchyWork
} from "../HierarchicalWorkGenerator.js";
import {
  PACKED_TRANSPARENT_COMPOSITE_WGSL,
  PACKED_TRANSPARENT_EVIDENCE_WGSL,
  PACKED_TRANSPARENT_FIXED_VERTEX_COUNT,
  PACKED_TRANSPARENT_FORWARD_WGSL,
  PACKED_TRANSPARENT_MOMENT_FORMAT,
  PACKED_TRANSPARENT_MOMENT_WGSL,
  PACKED_TRANSPARENT_OPTICAL_FORMAT,
  PACKED_TRANSPARENT_REACTIVE_FORMAT,
  PACKED_TRANSPARENT_RESOLVED_FORMAT
} from "../../shaders/packed_transparent_oit.js";
import { resolveDepthAttachmentView, resolveTextureView } from "./MaterialExpandPass.js";

const COMMON_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 Packed MBOIT Geometry/Material group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    { binding: 9, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage" } },
    { binding: 10, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d-array" } },
    ...Array.from({ length: 6 }, (_, index) => ({
      binding: index + 11,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" as GPUSamplerBindingType }
    }))
  ]
};

const FORWARD_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 Packed MBOIT moments/IBL group1",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
  ]
};

const LIGHTING_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 Packed MBOIT FX-02 lighting group2",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
  ]
};

const VIEW_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 Packed MBOIT view group3",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const COMPOSITE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 Packed MBOIT composite group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
  ]
};

const EVIDENCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-05 sampled transparency evidence group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage", minBindingSize:
        GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_RASTER_WORK_SCHEMA.stride } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } }
  ]
};

const ADDITIVE_BLEND: GPUBlendState = {
  color: { operation: "add", srcFactor: "one", dstFactor: "one" },
  alpha: { operation: "add", srcFactor: "one", dstFactor: "one" }
};
const DEPTH_STATE: GPUDepthStencilState = {
  format: "depth32float",
  depthCompare: "greater",
  depthWriteEnabled: false
};

const MOMENT_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-05 Packed MBOIT moments",
  layout: { label: "FX-05 Packed MBOIT moments layout", bindGroupLayouts: [COMMON_GROUP] },
  vertex: { module: { label: "FX-05 Packed MBOIT moments", code: PACKED_TRANSPARENT_MOMENT_WGSL },
    entryPoint: "packed_transparent_vertex" },
  fragment: { module: { label: "FX-05 Packed MBOIT moments", code: PACKED_TRANSPARENT_MOMENT_WGSL },
    entryPoint: "packed_transparent_moment", targets: [
      { format: PACKED_TRANSPARENT_OPTICAL_FORMAT, blend: ADDITIVE_BLEND },
      { format: PACKED_TRANSPARENT_MOMENT_FORMAT, blend: ADDITIVE_BLEND }
    ] },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: DEPTH_STATE
};

const FORWARD_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-05 Packed MBOIT forward",
  layout: { label: "FX-05 Packed MBOIT forward layout",
    bindGroupLayouts: [COMMON_GROUP, FORWARD_GROUP, LIGHTING_GROUP, VIEW_GROUP] },
  vertex: { module: { label: "FX-05 Packed MBOIT forward", code: PACKED_TRANSPARENT_FORWARD_WGSL },
    entryPoint: "packed_transparent_vertex" },
  fragment: { module: { label: "FX-05 Packed MBOIT forward", code: PACKED_TRANSPARENT_FORWARD_WGSL },
    entryPoint: "packed_transparent_forward", targets: [
      { format: PACKED_TRANSPARENT_RESOLVED_FORMAT, blend: ADDITIVE_BLEND },
      { format: PACKED_TRANSPARENT_REACTIVE_FORMAT, blend: ADDITIVE_BLEND }
    ] },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: DEPTH_STATE
};

const COMPOSITE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-05 Packed MBOIT composite",
  layout: { label: "FX-05 Packed MBOIT composite layout", bindGroupLayouts: [COMPOSITE_GROUP] },
  vertex: { module: { label: "FX-05 Packed MBOIT composite", code: PACKED_TRANSPARENT_COMPOSITE_WGSL },
    entryPoint: "packed_transparent_composite_vertex" },
  fragment: { module: { label: "FX-05 Packed MBOIT composite", code: PACKED_TRANSPARENT_COMPOSITE_WGSL },
    entryPoint: "packed_transparent_composite", targets: [{
      format: HDR_COLOR_FORMAT,
      blend: {
        color: { operation: "add", srcFactor: "one", dstFactor: "src-alpha" },
        alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" }
      }
    }] },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export interface PackedTransparentOitJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly width: number;
  readonly height: number;
  readonly hierarchyView: GeometryHierarchyView;
  readonly sseThreshold: number;
}

export interface PackedTransparentOitInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly camera: ResourceId;
  readonly view: ResourceId;
  readonly environment: ResourceId;
  readonly diffuseIrradiance: ResourceId;
  readonly splitSum: ResourceId;
  readonly lightDatabase: ResourceId;
  readonly clusterParameters: ResourceId;
  readonly clusterLookup: ResourceId;
  readonly clusterData: ResourceId;
  readonly activeLightList: ResourceId;
  readonly shadowAtlas: ResourceId;
  readonly counters?: ResourceId;
}

export interface PackedTransparentOitOutputs {
  readonly hdr: ResourceId;
  /** All transparent coverage is reactive; v1 deliberately marks velocity invalid. */
  readonly reactive: ResourceId;
  readonly counters: ResourceId | null;
}

interface CacheEntry {
  readonly prepared: PreparedHierarchyWork;
  readonly assetEpoch: number;
  readonly sceneEpoch: number;
  readonly sseThreshold: number;
}

/** One bounded transparent queue, one moment draw, one forward draw, one composite draw. */
export class PackedTransparentOitPass {
  readonly rasterStateBinLimit = 1;
  readonly motionContract = "reactive-all-velocity-invalid-v1" as const;
  readonly transientBytesPerPixel = 29;
  lastMomentPasses = 0;
  lastForwardPasses = 0;
  lastCompositePasses = 0;
  lastDrawCount = 0;
  private readonly generator: HierarchicalWorkGenerator;
  private readonly prepared = new Map<PackedSceneRuntime, CacheEntry>();
  private readonly generated = new Map<PackedSceneRuntime, GeneratedHierarchyWork>();
  private readonly samplers: readonly GPUSampler[];
  private readonly evidenceLayout: GPUBindGroupLayout;
  private readonly evidencePipeline: GPUComputePipeline;

  constructor(private readonly graphics: GraphicsContext) {
    this.generator = new HierarchicalWorkGenerator(graphics.device);
    this.samplers = Object.freeze([
      sampler(graphics.device, "repeat", "linear"),
      sampler(graphics.device, "clamp-to-edge", "linear"),
      sampler(graphics.device, "mirror-repeat", "linear"),
      sampler(graphics.device, "repeat", "nearest"),
      sampler(graphics.device, "clamp-to-edge", "nearest"),
      sampler(graphics.device, "mirror-repeat", "nearest")
    ]);
    this.evidenceLayout = graphics.device.createBindGroupLayout(EVIDENCE_GROUP);
    this.evidencePipeline = graphics.device.createComputePipeline({
      label: "FX-05 sampled transparency evidence",
      layout: graphics.device.createPipelineLayout({ bindGroupLayouts: [this.evidenceLayout] }),
      compute: {
        module: graphics.device.createShaderModule({
          label: "FX-05 sampled transparency evidence",
          code: PACKED_TRANSPARENT_EVIDENCE_WGSL
        }),
        entryPoint: "packed_transparent_evidence"
      }
    });
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedTransparentOitJob,
    inputs: PackedTransparentOitInputs
  ): PackedTransparentOitOutputs {
    this.lastMomentPasses = 1;
    this.lastForwardPasses = 1;
    this.lastCompositePasses = 1;
    this.lastDrawCount = 3;
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const momentData = { optical: -1, moments: -1 };
    const moment = graph.add("FX-05 Packed TransparentRasterWork + MBOIT moments", job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const generated = this.generate(data, command);
        this.generated.set(data.runtime, generated);
        const pass = command.beginRenderPass({
          label: "FX-05 Packed MBOIT moment drawIndirect",
          colorAttachments: [
            attachment(resources.get(momentData.optical), true),
            attachment(resources.get(momentData.moments), true)
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(inputs.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(this.graphics.render_pipelines.obtain(MOMENT_PIPELINE));
        pass.setBindGroup(0, this.commonGroup(data, generated,
          requireBuffer(resources.get(inputs.camera), "camera")));
        pass.drawIndirect(generated.drawIndirect, 0);
        pass.end();
      });
    momentData.optical = moment.create("FX-05 optical depth",
      texture(width, height, PACKED_TRANSPARENT_OPTICAL_FORMAT));
    momentData.moments = moment.create("FX-05 four power moments",
      texture(width, height, PACKED_TRANSPARENT_MOMENT_FORMAT));
    moment.read(inputs.depth);
    moment.read(inputs.camera);
    moment.make_side_effect();

    const forwardData = { resolved: -1, reactive: -1 };
    const forward = graph.add("FX-05 Packed transparent forward", job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const generated = this.requireGenerated(data.runtime);
        const pass = command.beginRenderPass({
          label: "FX-05 Packed MBOIT forward drawIndirect",
          colorAttachments: [
            attachment(resources.get(forwardData.resolved), true),
            attachment(resources.get(forwardData.reactive), true)
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(inputs.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(this.graphics.render_pipelines.obtain(FORWARD_PIPELINE));
        pass.setBindGroup(0, this.commonGroup(data, generated,
          requireBuffer(resources.get(inputs.camera), "camera")));
        pass.setBindGroup(1, this.graphics.bind_groups.obtain({
          layout: FORWARD_GROUP,
          entries: [
            resolveTextureView(resources.get(momentData.moments)),
            resolveTextureView(resources.get(momentData.optical)),
            resolveTextureView(resources.get(inputs.environment)),
            resolveTextureView(resources.get(inputs.diffuseIrradiance)),
            resolveTextureView(resources.get(inputs.splitSum)),
            this.samplers[1]!
          ]
        }));
        pass.setBindGroup(2, this.graphics.bind_groups.obtain({
          layout: LIGHTING_GROUP,
          entries: [
            { buffer: requireBuffer(resources.get(inputs.lightDatabase), "light database") },
            resolveTextureView(resources.get(inputs.environment)),
            { buffer: requireBuffer(resources.get(inputs.clusterParameters), "cluster parameters") },
            { buffer: requireBuffer(resources.get(inputs.clusterLookup), "cluster lookup") },
            { buffer: requireBuffer(resources.get(inputs.clusterData), "cluster data") },
            resolveTextureView(resources.get(inputs.shadowAtlas)),
            this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR),
            { buffer: requireBuffer(resources.get(inputs.activeLightList), "active light list") }
          ]
        }));
        pass.setBindGroup(3, this.graphics.bind_groups.obtain({
          layout: VIEW_GROUP,
          entries: [
            { buffer: requireBuffer(resources.get(inputs.view), "view") }
          ]
        }));
        pass.drawIndirect(generated.drawIndirect, 0);
        pass.end();
      });
    forwardData.resolved = forward.create("FX-05 transparent resolved",
      texture(width, height, PACKED_TRANSPARENT_RESOLVED_FORMAT));
    forwardData.reactive = forward.create("FX-05 transparent reactive",
      texture(width, height, PACKED_TRANSPARENT_REACTIVE_FORMAT));
    for (const id of [inputs.depth, inputs.camera, inputs.view, inputs.environment,
      inputs.diffuseIrradiance, inputs.splitSum, inputs.lightDatabase,
      inputs.clusterParameters, inputs.clusterLookup, inputs.clusterData,
      inputs.activeLightList, inputs.shadowAtlas, momentData.optical, momentData.moments]) {
      forward.read(id);
    }

    let counterOutput: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const evidence = graph.add("FX-05 sampled transparent queue/numeric evidence", job,
        (data, resources, context) => {
          const command = requireCommand(context.encoder);
          const generated = this.requireGenerated(data.runtime);
          const group = this.graphics.device.createBindGroup({
            label: "FX-05 sampled transparent evidence",
            layout: this.evidenceLayout,
            entries: [
              { binding: 0, resource: { buffer: generated.rasterWork } },
              { binding: 1, resource: { buffer: data.assets.meshletRecords } },
              { binding: 2, resource: resolveTextureView(resources.get(momentData.optical)) },
              { binding: 3, resource: resolveTextureView(resources.get(momentData.moments)) },
              { binding: 4, resource: resolveTextureView(resources.get(forwardData.reactive)) },
              { binding: 5, resource: { buffer: requireBuffer(resources.get(inputs.counters!), "counters") } }
            ]
          });
          const pass = command.beginComputePass({ label: "FX-05 sampled transparent evidence" });
          pass.setPipeline(this.evidencePipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
        });
      evidence.read(momentData.optical);
      evidence.read(momentData.moments);
      evidence.read(forwardData.reactive);
      evidence.read(inputs.counters);
      counterOutput = evidence.write(inputs.counters);
      // The profiler readback is encoded outside FrameGraph, so keep this
      // sampled evidence pass alive explicitly even though no graph pass reads
      // the final counter version.
      evidence.make_side_effect();
    }

    const compositeData = { hdrOut: -1 };
    const composite = graph.add("FX-05 Packed MBOIT composite", {},
      (_data, resources, context) => {
        const command = requireCommand(context.encoder);
        const pass = command.beginRenderPass({
          label: "FX-05 Packed MBOIT composite",
          colorAttachments: [{
            view: resolveTextureView(resources.get(compositeData.hdrOut)),
            loadOp: "load",
            storeOp: "store"
          }]
        });
        pass.setPipeline(this.graphics.render_pipelines.obtain(COMPOSITE_PIPELINE));
        pass.setBindGroup(0, this.graphics.bind_groups.obtain({
          layout: COMPOSITE_GROUP,
          entries: [
            resolveTextureView(resources.get(momentData.optical)),
            resolveTextureView(resources.get(forwardData.resolved))
          ]
        }));
        pass.draw(3);
        pass.end();
      });
    composite.read(inputs.hdr);
    composite.read(momentData.optical);
    composite.read(forwardData.resolved);
    compositeData.hdrOut = composite.write(inputs.hdr);
    return Object.freeze({
      hdr: compositeData.hdrOut,
      reactive: forwardData.reactive,
      counters: counterOutput
    });
  }

  release(runtime: PackedSceneRuntime, command: ShadeGPUCommandContext): void {
    this.generated.delete(runtime);
    const entry = this.prepared.get(runtime);
    if (entry === undefined) return;
    this.prepared.delete(runtime);
    command.destroyAfterGpuDone({ destroy: () => this.generator.release(entry.prepared) });
  }

  destroy(): void {
    this.generated.clear();
    this.prepared.clear();
    this.generator.destroy();
  }

  private generate(job: PackedTransparentOitJob, command: ShadeGPUCommandContext): GeneratedHierarchyWork {
    let entry = this.prepared.get(job.runtime);
    if (entry === undefined || entry.assetEpoch !== job.assets.epoch ||
      entry.sceneEpoch !== job.scene.epoch || entry.sseThreshold !== job.sseThreshold) {
      const previous = entry;
      const prepared = this.generator.prepare({
        assets: job.assets,
        scene: job.scene,
        instanceBegin: job.runtime.instanceBegin,
        instanceCount: job.runtime.instanceCount,
        maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
        traversalWorkCapacity: job.runtime.hierarchyTraversalCapacity,
        visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
        rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
        counterBuffer: job.runtime.counterSink
      }, {
        sseThreshold: job.sseThreshold,
        countersEnabled: false,
        diagnosticsEnabled: false
      });
      entry = { prepared, assetEpoch: job.assets.epoch, sceneEpoch: job.scene.epoch,
        sseThreshold: job.sseThreshold };
      this.prepared.set(job.runtime, entry);
      if (previous !== undefined) {
        command.destroyAfterGpuDone({ destroy: () => this.generator.release(previous.prepared) });
      }
    }
    return this.generator.encode(command.gpu_encoder, entry.prepared, job.hierarchyView, {
      // The transparent pass mixes one- and double-sided materials in one bin;
      // fragment-facing rejection remains the authoritative sidedness test.
      coneEnabled: false,
      requiredInstanceFlags: GPU_INSTANCE_FLAGS.Transparent
    });
  }

  private commonGroup(
    job: PackedTransparentOitJob,
    generated: GeneratedHierarchyWork,
    camera: GPUBuffer
  ): GPUBindGroup {
    return this.graphics.bind_groups.obtain({
      layout: COMMON_GROUP,
      entries: [
        { buffer: camera },
        { buffer: job.scene.instances },
        { buffer: job.assets.meshletRecords },
        { buffer: job.assets.meshletVertexIndices },
        { buffer: job.assets.meshletTriangleIndices },
        { buffer: job.assets.vertexStreamData },
        { buffer: job.assets.geometryRecords },
        { buffer: generated.visibleClusters },
        { buffer: generated.rasterWork },
        { buffer: job.runtime.materialVisibility.materialRecords },
        job.runtime.materialVisibility.textureArray,
        ...this.samplers
      ]
    });
  }

  private requireGenerated(runtime: PackedSceneRuntime): GeneratedHierarchyWork {
    const value = this.generated.get(runtime);
    if (value === undefined) throw new Error("FX-05 transparent producer did not run before consumer");
    return value;
  }
}

export const PACKED_TRANSPARENT_COUNTER_OFFSETS = Object.freeze({
  work: counterByteOffset("transparentRasterWork"),
  triangles: counterByteOffset("transparentTriangles"),
  reactive: counterByteOffset("transparentReactivePixels"),
  finiteFailures: counterByteOffset("transparentMomentFiniteFailures"),
  overflow: counterByteOffset("transparentQueueOverflowMask")
});

function sampler(device: GPUDevice, addressMode: GPUAddressMode, filter: GPUFilterMode): GPUSampler {
  return device.createSampler({ addressModeU: addressMode, addressModeV: addressMode,
    minFilter: filter, magFilter: filter, mipmapFilter: filter });
}

function attachment(value: unknown, clear: boolean): GPURenderPassColorAttachment {
  return { view: resolveTextureView(value), clearValue: [0, 0, 0, 0],
    loadOp: clear ? "clear" : "load", storeOp: "store" };
}

function texture(width: number, height: number, format: GPUTextureFormat) {
  return { kind: "transient_texture" as const, label: `FX-05 ${format}`, width, height, format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING };
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: boolean }).isGPUCommandContext === true) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("FX-05 Packed MBOIT requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`FX-05 expected ${label} GPUBuffer`);
}
