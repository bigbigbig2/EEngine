import type { OrthographicCamera } from "../../camera/OrthographicCamera.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { GeometryHierarchyView } from "../../geometry/GeometryHierarchy.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import { GPU_INSTANCE_FLAGS } from "../../gpu/GpuInstanceAbi.js";
import type { GpuMaterialVisibilityBindings } from "../../gpu/GpuMaterialVisibilityTable.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPU_RASTER_WORK_SCHEMA, GPU_WORK_QUEUE_HEADER_SCHEMA } from "../../gpu/GpuWorkGenerationAbi.js";
import { LPV_CAMERA_TYPE } from "../../shaders/lpv_indirect_diffuse.js";
import {
  PACKED_CSM_COUNTER_WGSL,
  PACKED_CSM_FIXED_VERTEX_COUNT,
  PACKED_CSM_SHADOW_WGSL
} from "../../shaders/packed_csm_shadow.js";
import { SHADOW_DEPTH_CLEAR_WGSL } from "../../shaders/shadow_raster.js";
import {
  HierarchicalWorkGenerator,
  type PreparedHierarchyWork
} from "../HierarchicalWorkGenerator.js";

const PACKED_CSM_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "FX-04 Packed CSM SecondaryRasterWork group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    { binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
    { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } }
  ]
};

const PACKED_CSM_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "FX-04 Packed CSM depth/alpha indirect consumer",
  layout: { label: "FX-04 Packed CSM layout", bindGroupLayouts: [PACKED_CSM_GROUP] },
  vertex: {
    module: { label: "FX-04 Packed CSM", code: PACKED_CSM_SHADOW_WGSL },
    entryPoint: "packed_csm_vertex"
  },
  fragment: {
    module: { label: "FX-04 Packed CSM", code: PACKED_CSM_SHADOW_WGSL },
    entryPoint: "packed_csm_fragment",
    targets: []
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "greater",
    depthBias: 2,
    depthBiasSlopeScale: 1.5,
    depthBiasClamp: 0
  }
};

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

export interface PackedCsmShadowJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly materials: GpuMaterialVisibilityBindings;
  readonly camera: OrthographicCamera;
  readonly cameraBuffer: GPUBuffer;
  readonly cascadeIndex: number;
  readonly viewport: readonly [number, number, number, number];
  readonly depthView: GPUTextureView;
  readonly sseThreshold: number;
  readonly counterBuffer: GPUBuffer | null;
}

interface CacheEntry {
  readonly prepared: PreparedHierarchyWork;
  readonly assetEpoch: number;
  readonly sceneEpoch: number;
  readonly sseThreshold: number;
}

/** Packed directional shadow producer/consumer. It never reads back a draw list. */
export class PackedCsmShadowPass {
  lastCascadeDraws = 0;
  lastAtlasPixelsUpdated = 0;
  lastIndirectBytes = 0;
  private readonly generator: HierarchicalWorkGenerator;
  private readonly prepared = new Map<PackedSceneRuntime, Map<OrthographicCamera, CacheEntry>>();
  private readonly counterLayout: GPUBindGroupLayout;
  private readonly counterPipeline: GPUComputePipeline;

  constructor(private readonly graphics: GraphicsContext) {
    this.generator = new HierarchicalWorkGenerator(graphics.device);
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
  }

  beginFrame(): void {
    this.lastCascadeDraws = 0;
    this.lastAtlasPixelsUpdated = 0;
    this.lastIndirectBytes = 0;
  }

  execute(command: ShadeGPUCommandContext, job: PackedCsmShadowJob): void {
    validateJob(job);
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
        { buffer: generated.visibleClusters },
        { buffer: generated.rasterWork },
        { buffer: job.materials.materialRecords },
        job.materials.alphaAtlas,
        job.materials.highResolutionAlphaAtlas
      ]
    });
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
    pass.setPipeline(this.graphics.render_pipelines.obtain(PACKED_CSM_PIPELINE));
    pass.setBindGroup(0, group);
    pass.drawIndirect(generated.drawIndirect, 0);
    pass.end();
    if (job.counterBuffer !== null) {
      this.encodeEvidence(command, generated.rasterWork, job);
    }
    this.lastCascadeDraws++;
    this.lastAtlasPixelsUpdated += job.viewport[2] * job.viewport[3];
    this.lastIndirectBytes += 16;
  }

  release(runtime: PackedSceneRuntime, command: ShadeGPUCommandContext): void {
    const entries = this.prepared.get(runtime);
    if (entries === undefined) return;
    this.prepared.delete(runtime);
    for (const entry of entries.values()) {
      command.destroyAfterGpuDone({ destroy: () => this.generator.release(entry.prepared) });
    }
  }

  destroy(): void {
    this.prepared.clear();
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
      previous.sceneEpoch === job.scene.epoch && previous.sseThreshold === job.sseThreshold) {
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
      sceneEpoch: job.scene.epoch,
      sseThreshold: job.sseThreshold
    });
    if (previous !== undefined) {
      command.destroyAfterGpuDone({ destroy: () => this.generator.release(previous.prepared) });
    }
    return prepared;
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
  if (!Number.isInteger(job.cascadeIndex) || job.cascadeIndex < 0 || job.cascadeIndex > 2) {
    throw new RangeError("Packed CSM cascade index must be 0..2");
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
