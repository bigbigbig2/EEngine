import type { OrthographicCamera } from "../../camera/OrthographicCamera.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { GpuPackedMaterialBindings } from "../../gpu/GpuPackedMaterialBindings.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GeometryProductGpuBindingsV1 } from "../../gpu/VirtualGeometryResidency.js";
import type { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPU_RASTER_WORK_SCHEMA, GPU_WORK_QUEUE_HEADER_SCHEMA } from "../../gpu/GpuWorkGenerationAbi.js";
import { GEOMETRY_PAGE_DEMAND_DEFAULT_FLAGS_V1, GEOMETRY_PAGE_DEMAND_FLAG_SHADOW } from "../../gpu/GeometryPageDemandAbiV1.js";
import { PACKED_CAMERA_TYPE } from "../../shaders/packed_camera.js";
import {
  PACKED_CSM_COUNTER_WGSL,
  PACKED_CSM_PRODUCT_COUNTER_WGSL,
  PACKED_CSM_PRODUCT_SHADOW_WGSL,
  PACKED_CSM_SHADOW_WGSL
} from "../../shaders/packed_csm_shadow.js";
import { SHADOW_DEPTH_CLEAR_WGSL } from "../../shaders/shadow_depth_clear.js";
import {
  HierarchicalWorkGenerator,
  type PreparedHierarchyWork
} from "../HierarchicalWorkGenerator.js";
import {
  VirtualGeometryMeshletWorkCandidate,
  type PreparedMeshletWorkCandidate
} from "../MeshletWorkCandidate.js";
import {
  SHADOW_CASCADE_COUNT,
  SHADOW_DEPTH_BIAS,
  SHADOW_DEPTH_SLOPE_SCALE
} from "../../gpu/ShadowContract.js";

const PACKED_CSM_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-04 Packed CSM SecondaryRasterWork group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
    ...Array.from({ length: 7 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 10,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" as GPUTextureSampleType, viewDimension: "2d-array" as GPUTextureViewDimension }
    }))
  ]
};

const PACKED_CSM_PRODUCT_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-04 Packed CSM Product MeshletWork group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ...Array.from({ length: 4 }, (_, index) => ({
      binding: index + 4,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ...Array.from({ length: 9 }, (_, index) => ({
      binding: index + 9,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {
        sampleType: "unfilterable-float" as GPUTextureSampleType,
        viewDimension: "2d-array" as GPUTextureViewDimension
      }
    }))
  ]
};

function packedCsmPipeline(textureBindingSetId: number): CachedRenderPipelineDescriptor {
return {
  label: `FX-04 Packed CSM set ${textureBindingSetId} depth/alpha indirect consumer`,
  layout: { label: "FX-04 Packed CSM layout", bindGroupLayouts: [PACKED_CSM_GROUP] },
  vertex: {
    module: { label: "FX-04 Packed CSM", code: PACKED_CSM_SHADOW_WGSL },
    entryPoint: "packed_csm_vertex"
  },
  fragment: {
    module: { label: "FX-04 Packed CSM", code: PACKED_CSM_SHADOW_WGSL },
    entryPoint: "packed_csm_fragment",
    constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: textureBindingSetId },
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater",
    depthBias: SHADOW_DEPTH_BIAS,
    depthBiasSlopeScale: SHADOW_DEPTH_SLOPE_SCALE,
    depthBiasClamp: 0
  }
};
}

function packedCsmProductPipeline(textureBindingSetId: number): CachedRenderPipelineDescriptor {
  return {
    label: `FX-04 Packed CSM Product set ${textureBindingSetId} MeshletWork depth consumer`,
    layout: { label: "FX-04 Packed CSM Product layout", bindGroupLayouts: [PACKED_CSM_PRODUCT_GROUP] },
    vertex: {
      module: { label: "FX-04 Packed CSM Product", code: PACKED_CSM_PRODUCT_SHADOW_WGSL },
      entryPoint: "packed_csm_product_vertex"
    },
    fragment: {
      module: { label: "FX-04 Packed CSM Product", code: PACKED_CSM_PRODUCT_SHADOW_WGSL },
      entryPoint: "packed_csm_product_fragment",
      constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: textureBindingSetId },
      targets: []
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "greater",
      depthBias: SHADOW_DEPTH_BIAS,
      depthBiasSlopeScale: SHADOW_DEPTH_SLOPE_SCALE,
      depthBiasClamp: 0
    }
  };
}

const CLEAR_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-04 Packed CSM viewport clear",
  layout: { label: "FX-04 Packed CSM clear layout", bindGroupLayouts: [] },
  vertex: {
    module: { label: "FX-04 Packed CSM clear", code: SHADOW_DEPTH_CLEAR_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "FX-04 Packed CSM clear", code: SHADOW_DEPTH_CLEAR_WGSL },
    entryPoint: "fs_main",
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "always"
  }
};

const COUNTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-04 Packed CSM sampled evidence group0",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {
        type: "read-only-storage",
        minBindingSize: GPU_WORK_QUEUE_HEADER_SCHEMA.stride + GPU_RASTER_WORK_SCHEMA.stride
      }
    },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 256 } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
  ]
};

const PRODUCT_COUNTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-04 Packed CSM Product sampled evidence group0",
  entries: COUNTER_GROUP.entries
};

export interface PackedCsmShadowJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly materials: GpuPackedMaterialBindings;
  readonly camera: OrthographicCamera;
  readonly cameraBuffer: GPUBuffer;
  readonly cascadeIndex: number;
  readonly viewport: readonly [number, number, number, number];
  readonly depthView: GPUTextureView;
  readonly sseThreshold: number;
  readonly counterBuffer: GPUBuffer | null;
  readonly virtualGeometry?: GeometryProductGpuBindingsV1 | null;
  readonly streamingRuntime?: GeometryPageStreamingRuntimeV1 | null;
  readonly demandFrameIndex?: number;
}

interface CacheEntry {
  readonly prepared: PreparedHierarchyWork;
  readonly assetEpoch: number;
  readonly sceneEpoch: number;
  readonly sseThreshold: number;
}

interface ProductCacheEntry {
  readonly prepared: PreparedHierarchyWork;
  readonly meshletWork: PreparedMeshletWorkCandidate;
  readonly sceneEpoch: number;
  readonly productGeneration: number;
  readonly sseThreshold: number;
}

/** Packed directional shadow producer/consumer. It never reads back a draw list. */
export class PackedCsmShadowPass {
  lastCascadeDraws = 0;
  lastAtlasPixelsUpdated = 0;
  lastIndirectBytes = 0;
  private readonly generator: HierarchicalWorkGenerator;
  private readonly prepared = new Map<GpuRenderWorldRuntime, Map<OrthographicCamera, CacheEntry>>();
  private readonly productPrepared = new Map<GpuRenderWorldRuntime, Map<OrthographicCamera, ProductCacheEntry>>();
  private readonly productMeshletWork: VirtualGeometryMeshletWorkCandidate;
  private readonly counterLayout: GPUBindGroupLayout;
  private readonly counterPipeline: GPUComputePipeline;
  private readonly productCounterLayout: GPUBindGroupLayout;
  private readonly productCounterPipeline: GPUComputePipeline;
  private readonly productRasterPipelines = new Map<number, GPURenderPipeline>();

  constructor(private readonly graphics: GraphicsContext) {
    this.generator = new HierarchicalWorkGenerator(graphics.device);
    this.productMeshletWork = new VirtualGeometryMeshletWorkCandidate(graphics.device);
    this.counterLayout = graphics.device.createBindGroupLayout(COUNTER_GROUP);
    this.counterPipeline = graphics.device.createComputePipeline({
      label: "FX-04 Packed CSM sampled queue evidence",
      layout: graphics.device.createPipelineLayout({
        label: "FX-04 Packed CSM evidence layout",
        bindGroupLayouts: [this.counterLayout]
      }),
      compute: {
        module: graphics.device.createShaderModule({
          label: "FX-04 Packed CSM evidence",
          code: PACKED_CSM_COUNTER_WGSL
        }),
        entryPoint: "packed_csm_evidence"
      }
    });
    this.productCounterLayout = graphics.device.createBindGroupLayout(PRODUCT_COUNTER_GROUP);
    this.productCounterPipeline = graphics.device.createComputePipeline({
      label: "FX-04 Packed CSM Product sampled queue evidence",
      layout: graphics.device.createPipelineLayout({
        label: "FX-04 Packed CSM Product evidence layout",
        bindGroupLayouts: [this.productCounterLayout]
      }),
      compute: {
        module: graphics.device.createShaderModule({
          label: "FX-04 Packed CSM Product evidence",
          code: PACKED_CSM_PRODUCT_COUNTER_WGSL
        }),
        entryPoint: "packed_csm_product_evidence"
      }
    });
  }

  get preparedWorkSetCount(): number {
    let count = 0;
    for (const entries of this.prepared.values()) count += entries.size;
    for (const entries of this.productPrepared.values()) count += entries.size;
    return count;
  }

  get preparedWorkBytes(): number {
    let bytes = 0;
    for (const entries of this.prepared.values()) {
      for (const entry of entries.values()) {
        bytes += this.generator.evidence(entry.prepared).transientBytes;
      }
    }
    for (const entries of this.productPrepared.values()) {
      for (const entry of entries.values()) {
        bytes += this.generator.evidence(entry.prepared).transientBytes;
      }
    }
    return bytes;
  }

  beginFrame(): void {
    this.lastCascadeDraws = 0;
    this.lastAtlasPixelsUpdated = 0;
    this.lastIndirectBytes = 0;
  }

  execute(command: ShadeGPUCommandContext, job: PackedCsmShadowJob): void {
    validateJob(job);
    if (job.virtualGeometry !== undefined && job.virtualGeometry !== null) {
      this.executeProduct(command, job);
      return;
    }
    const prepared = this.prepare(job, command);
    const generated = this.generator.encode(
      command.gpu_encoder,
      prepared,
      createPackedShadowHierarchyView(job.camera, job.viewport[3]),
      {
        requiredInstanceFlags: GPU_INSTANCE_FLAGS.CastsShadow,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent
      }
    );
    const bindingSets = job.materials.bindingSets;
    if (bindingSets.length === 0) throw new Error("Packed CSM requires one active TextureBindingSet");
    this.clearViewport(command, job.depthView, job.viewport);
    const pass = command.beginRenderPass({
      label: `FX-04 Packed CSM Shadow cascade ${job.cascadeIndex} drawIndirect`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: job.depthView,
        depthLoadOp: "load",
        depthStoreOp: "store"
      }
    });
    pass.setViewport(...job.viewport, 0, 1);
    for (const bindingSet of bindingSets) {
      const group = this.graphics.bind_groups.obtain({
        layout: PACKED_CSM_GROUP,
        entries: [
          { buffer: job.cameraBuffer },
          { buffer: job.scene.instances },
          { buffer: job.assets.meshletRecords },
          { buffer: job.assets.meshletVertexIndices },
          { buffer: job.assets.meshletTriangleIndices },
          { buffer: job.assets.vertexStreamData },
          { buffer: job.assets.geometryRecords },
          { buffer: generated.rasterWork! },
          { buffer: job.materials.materialRecords },
          ...bindingSet.textureBanks
        ]
      });
      pass.setPipeline(this.graphics.render_pipelines.obtain(packedCsmPipeline(bindingSet.id)));
      pass.setBindGroup(0, group);
      pass.drawIndirect(generated.drawIndirect!, 0);
    }
    pass.end();
    if (job.counterBuffer !== null) {
      this.encodeEvidence(command, generated.rasterWork!, job);
    }
    this.lastCascadeDraws += bindingSets.length;
    this.lastAtlasPixelsUpdated += job.viewport[2] * job.viewport[3];
    this.lastIndirectBytes += 16;
  }

  release(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    const entries = this.prepared.get(runtime);
    if (entries !== undefined) {
      this.prepared.delete(runtime);
      for (const entry of entries.values()) {
        command.destroyAfterGpuDone({ destroy: () => this.generator.release(entry.prepared) });
      }
    }
    const productEntries = this.productPrepared.get(runtime);
    if (productEntries === undefined) return;
    this.productPrepared.delete(runtime);
    for (const entry of productEntries.values()) {
      command.destroyAfterGpuDone({
        destroy: () => {
          this.productMeshletWork.release(entry.meshletWork);
          this.generator.release(entry.prepared);
        }
      });
    }
  }

  destroy(): void {
    for (const entries of this.prepared.values()) {
      for (const entry of entries.values()) this.generator.release(entry.prepared);
    }
    this.prepared.clear();
    for (const entries of this.productPrepared.values()) {
      for (const entry of entries.values()) this.productMeshletWork.release(entry.meshletWork);
    }
    this.productPrepared.clear();
    this.productMeshletWork.destroy();
    this.generator.destroy();
  }

  private prepare(job: PackedCsmShadowJob, command: ShadeGPUCommandContext): PreparedHierarchyWork {
    let byCamera = this.prepared.get(job.runtime);
    if (byCamera === undefined) {
      byCamera = new Map();
      this.prepared.set(job.runtime, byCamera);
    }
    const previous = byCamera.get(job.camera);
    if (previous !== undefined && previous.assetEpoch === job.assets.epoch &&
      previous.sceneEpoch === job.scene.resourceEpoch && previous.sseThreshold === job.sseThreshold) {
      return previous.prepared;
    }
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
    byCamera.set(job.camera, {
      prepared,
      assetEpoch: job.assets.epoch,
      sceneEpoch: job.scene.resourceEpoch,
      sseThreshold: job.sseThreshold
    });
    if (previous !== undefined) {
      command.destroyAfterGpuDone({ destroy: () => this.generator.release(previous.prepared) });
    }
    return prepared;
  }

  private executeProduct(command: ShadeGPUCommandContext, job: PackedCsmShadowJob): void {
    const product = job.virtualGeometry!;
    const prepared = this.prepareProduct(job, product, command);
    this.generator.encode(
      command.gpu_encoder,
      prepared.prepared,
      createPackedShadowHierarchyView(job.camera, job.viewport[3]),
      {
        requiredInstanceFlags: GPU_INSTANCE_FLAGS.CastsShadow,
        excludedInstanceFlags: GPU_INSTANCE_FLAGS.Transparent,
        pageDemandFlags: GEOMETRY_PAGE_DEMAND_DEFAULT_FLAGS_V1 |
          GEOMETRY_PAGE_DEMAND_FLAG_SHADOW
      }
    );
    if (job.streamingRuntime !== undefined && job.streamingRuntime !== null &&
        prepared.prepared.generated.pageDemand !== null &&
        job.demandFrameIndex !== undefined && job.cascadeIndex === 0) {
      job.streamingRuntime.encodeShadowDemandReadback(
        command.gpu_encoder,
        prepared.prepared.generated.pageDemand,
        job.demandFrameIndex
      );
    }
    this.productMeshletWork.encode(command, prepared.meshletWork);
    this.clearViewport(command, job.depthView, job.viewport);
    const pass = command.beginRenderPass({
      label: `FX-04 Packed CSM Product cascade ${job.cascadeIndex} drawIndirect`,
      colorAttachments: [],
      depthStencilAttachment: { view: job.depthView, depthLoadOp: "load", depthStoreOp: "store" }
    });
    pass.setViewport(...job.viewport, 0, 1);
    const bindingSets = job.materials.bindingSets;
    if (bindingSets.length === 0) throw new Error("Packed CSM Product requires one active TextureBindingSet");
    for (const bindingSet of bindingSets) {
      let pipeline = this.productRasterPipelines.get(bindingSet.id);
      if (pipeline === undefined) {
        pipeline = this.graphics.render_pipelines.obtain(packedCsmProductPipeline(bindingSet.id));
        this.productRasterPipelines.set(bindingSet.id, pipeline);
      }
      const group = this.graphics.bind_groups.obtain({
        layout: PACKED_CSM_PRODUCT_GROUP,
        entries: [
          { buffer: job.cameraBuffer },
          { buffer: job.scene.instances },
          { buffer: prepared.meshletWork.queue },
          { buffer: product.metadata },
          ...prepared.meshletWork.productBanks!.slice(0, 4).map((buffer) => ({ buffer })),
          { buffer: job.materials.materialRecords },
          ...bindingSet.textureBanks
        ]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.drawIndirect(prepared.meshletWork.drawIndirect, 0);
    }
    pass.end();
    if (job.counterBuffer !== null) {
      this.encodeProductEvidence(command, prepared.meshletWork.queue, job);
    }
    this.lastCascadeDraws += bindingSets.length;
    this.lastAtlasPixelsUpdated += job.viewport[2] * job.viewport[3];
    this.lastIndirectBytes += 16;
  }

  private prepareProduct(
    job: PackedCsmShadowJob,
    product: GeometryProductGpuBindingsV1,
    command: ShadeGPUCommandContext
  ): ProductCacheEntry {
    let byCamera = this.productPrepared.get(job.runtime);
    if (byCamera === undefined) {
      byCamera = new Map();
      this.productPrepared.set(job.runtime, byCamera);
    }
    const previous = byCamera.get(job.camera);
    if (previous !== undefined && previous.sceneEpoch === job.scene.resourceEpoch &&
        previous.productGeneration === product.productGeneration &&
        previous.sseThreshold === job.sseThreshold) {
      return previous;
    }
    const counterBuffer = job.counterBuffer ?? job.runtime.counterSink;
    const prepared = this.generator.prepare({
      assets: job.assets,
      scene: job.scene,
      instanceBegin: job.runtime.instanceBegin,
      instanceCount: job.runtime.instanceCount,
      maxHierarchyDepth: job.runtime.hierarchyMaxDepth,
      traversalWorkCapacity: job.runtime.hierarchyTraversalCapacity,
      visibleClusterCapacity: job.runtime.hierarchyVisibleClusterCapacity,
      rasterWorkCapacity: job.runtime.hierarchyRasterWorkCapacity,
      counterBuffer,
      virtualGeometry: product
    }, {
      sseThreshold: job.sseThreshold,
      countersEnabled: job.counterBuffer !== null,
      diagnosticsEnabled: false,
      rasterExpansionEnabled: false
    });
    let meshletWork: PreparedMeshletWorkCandidate;
    try {
      meshletWork = this.productMeshletWork.prepare({
        virtualGeometry: product,
        visibleClusters: prepared.generated.visibleClusters,
        visibleClusterCapacity: prepared.generated.visibleClusterCapacity,
        capacity: job.runtime.hierarchyRasterWorkCapacity,
        counterBuffer,
        countersEnabled: job.counterBuffer !== null
      });
    } catch (error) {
      this.generator.release(prepared);
      throw error;
    }
    const next: ProductCacheEntry = Object.freeze({
      prepared,
      meshletWork,
      sceneEpoch: job.scene.resourceEpoch,
      productGeneration: product.productGeneration,
      sseThreshold: job.sseThreshold
    });
    byCamera.set(job.camera, next);
    if (previous !== undefined) {
      command.destroyAfterGpuDone({
        destroy: () => {
          this.productMeshletWork.release(previous.meshletWork);
          this.generator.release(previous.prepared);
        }
      });
    }
    return next;
  }

  private clearViewport(
    command: ShadeGPUCommandContext,
    depthView: GPUTextureView,
    viewport: readonly [number, number, number, number]
  ): void {
    const pass = command.beginRenderPass({
      label: "FX-04 Packed CSM Shadow reverse-Z viewport clear",
      colorAttachments: [],
      depthStencilAttachment: { view: depthView, depthLoadOp: "load", depthStoreOp: "store" }
    });
    pass.setViewport(...viewport, 0, 1);
    pass.setPipeline(this.graphics.render_pipelines.obtain(CLEAR_PIPELINE));
    pass.draw(3);
    pass.end();
  }

  private encodeEvidence(
    command: ShadeGPUCommandContext,
    rasterWork: GPUBuffer,
    job: PackedCsmShadowJob
  ): void {
    const values = new Uint32Array([
      job.cascadeIndex,
      job.viewport[2] * job.viewport[3],
      0,
      0
    ]);
    const params = command.allocateTransientBufferAndLoad(values.buffer);
    const group = this.graphics.device.createBindGroup({
      label: `FX-04 cascade ${job.cascadeIndex} sampled evidence`,
      layout: this.counterLayout,
      entries: [
        { binding: 0, resource: { buffer: rasterWork } },
        { binding: 1, resource: { buffer: job.counterBuffer! } },
        { binding: 2, resource: { buffer: params } }
      ]
    });
    const pass = command.beginComputePass({
      label: `FX-04 Packed CSM Shadow cascade ${job.cascadeIndex} counters`
    });
    pass.setPipeline(this.counterPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  private encodeProductEvidence(
    command: ShadeGPUCommandContext,
    meshletWork: GPUBuffer,
    job: PackedCsmShadowJob
  ): void {
    const values = new Uint32Array([
      job.cascadeIndex,
      job.viewport[2] * job.viewport[3],
      0,
      0
    ]);
    const params = command.allocateTransientBufferAndLoad(values.buffer);
    const group = this.graphics.device.createBindGroup({
      label: `FX-04 Product cascade ${job.cascadeIndex} sampled evidence`,
      layout: this.productCounterLayout,
      entries: [
        { binding: 0, resource: { buffer: meshletWork } },
        { binding: 1, resource: { buffer: job.counterBuffer! } },
        { binding: 2, resource: { buffer: params } }
      ]
    });
    const pass = command.beginComputePass({
      label: `FX-04 Packed CSM Product cascade ${job.cascadeIndex} counters`
    });
    pass.setPipeline(this.productCounterPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }
}

export function createPackedShadowHierarchyView(
  camera: OrthographicCamera,
  viewportHeight: number
): GeometryHierarchyView {
  const planes: [number, number, number, number][] = [];
  for (let index = 0; index < 6; index++) {
    const offset = index * 4;
    planes.push([
      camera.frustum[offset]!, camera.frustum[offset + 1]!,
      camera.frustum[offset + 2]!, camera.frustum[offset + 3]!
    ]);
  }
  const matrix = camera.transform.matrix;
  return {
    kind: "orthographic",
    cameraPosition: [matrix[12]!, matrix[13]!, matrix[14]!],
    viewportHeight,
    verticalWorldSize: Math.abs(camera.top - camera.bottom),
    frustumPlanes: planes
  };
}

function validateJob(job: PackedCsmShadowJob): void {
  if (!Number.isInteger(job.cascadeIndex) || job.cascadeIndex < 0 || job.cascadeIndex >= SHADOW_CASCADE_COUNT) {
    throw new RangeError(`Packed CSM cascade index must be 0..${SHADOW_CASCADE_COUNT - 1}`);
  }
  if (!Number.isFinite(job.sseThreshold) || job.sseThreshold < 0) {
    throw new RangeError("Packed CSM SSE threshold must be finite and non-negative");
  }
  for (const value of job.viewport) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Packed CSM viewport must contain finite non-negative values");
    }
  }
}

// Keep the sampled counter field ownership visible to static audits.
export const PACKED_CSM_COUNTER_OFFSETS = Object.freeze({
  cascade0: counterByteOffset("shadowCascade0RasterWork"),
  cascade1: counterByteOffset("shadowCascade1RasterWork"),
  cascade2: counterByteOffset("shadowCascade2RasterWork"),
  atlasPixels: counterByteOffset("shadowAtlasPixelsUpdated"),
  alphaWork: counterByteOffset("shadowAlphaRasterWork"),
  overflow: counterByteOffset("shadowQueueOverflowMask")
});
