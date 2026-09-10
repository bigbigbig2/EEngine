import { GPU_COUNTER_BYTE_SIZE } from "../debug/GpuFrameCounters.js";
import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../gpu/GPUDescriptorCaches.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { GPU_MESHLET_BUCKET_COUNT } from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import {
  MESHLET_BUCKET_PARITY_WGSL,
  MESHLET_BUCKET_SETTINGS_SIZE,
  MESHLET_BUCKET_SETTINGS_STRIDE,
  MESHLET_BUCKET_VISIBILITY_WGSL
} from "../shaders/meshlet_bucket_visibility.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";

const MESHLET_BUCKET_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0008 Meshlet bucket Hardware Visibility group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: LPV_CAMERA_TYPE.size } },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 1,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    })),
    {
      binding: 9,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: MESHLET_BUCKET_SETTINGS_SIZE }
    },
    { binding: 10, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ...Array.from({ length: 5 }, (_, index) => ({
      binding: index + 11,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {
        sampleType: "unfilterable-float" as GPUTextureSampleType,
        viewDimension: "2d-array" as GPUTextureViewDimension
      }
    }))
  ]
};

function bucketPipeline(doubleSided: boolean, mask: boolean): CachedRenderPipelineDescriptor {
  return {
    label: `ADR-0008 Meshlet bucket ${doubleSided ? "double-sided" : "back-face"} ${mask ? "MASK" : "OPAQUE"}`,
    layout: {
      label: "ADR-0008 Meshlet bucket Hardware Visibility layout",
      bindGroupLayouts: [MESHLET_BUCKET_RASTER_GROUP]
    },
    vertex: {
      module: { label: "ADR-0008 Meshlet bucket visibility", code: MESHLET_BUCKET_VISIBILITY_WGSL },
      entryPoint: "raster_meshlet_bucket"
    },
    fragment: {
      module: { label: "ADR-0008 Meshlet bucket visibility", code: MESHLET_BUCKET_VISIBILITY_WGSL },
      entryPoint: mask ? "write_meshlet_mask" : "write_meshlet_opaque",
      targets: [{ format: "r32uint" }]
    },
    primitive: {
      topology: "triangle-list",
      cullMode: doubleSided ? "none" : "back",
      frontFace: "ccw"
    },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "greater"
    }
  };
}

const BUCKET_PIPELINES = Object.freeze([
  bucketPipeline(false, false),
  bucketPipeline(true, false),
  bucketPipeline(false, true),
  bucketPipeline(true, true)
]);

const PARITY_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0008 Meshlet bucket semantic parity group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
  ]
};

const PARITY_PIPELINE: CachedComputePipelineDescriptor = {
  label: "ADR-0008 Meshlet bucket semantic parity",
  layout: {
    label: "ADR-0008 Meshlet bucket semantic parity layout",
    bindGroupLayouts: [PARITY_GROUP]
  },
  compute: {
    module: { label: "ADR-0008 Meshlet bucket semantic parity", code: MESHLET_BUCKET_PARITY_WGSL },
    entryPoint: "compare_meshlet_bucket_visibility"
  }
};

export interface MeshletBucketRasterInputs {
  readonly prepared: PreparedMeshletWorkCandidate;
  readonly camera: GPUBuffer;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly runtime: GpuRenderWorldRuntime;
  readonly visibilityKey: GPUTextureView;
  readonly depth: GPUTextureView;
}

/** Step-3 standard indirect GPU consumer and semantic parity reducer. */
export class MeshletBucketRaster {
  private rasterPipelines: readonly GPURenderPipeline[] | null = null;
  private parityPipeline: GPUComputePipeline | null = null;
  private readonly rasterGroups = new WeakMap<
    PreparedMeshletWorkCandidate,
    Readonly<{ camera: GPUBuffer; group: GPUBindGroup }>
  >();

  constructor(private readonly graphics: GraphicsContext) {}

  encodeRaster(encoder: GPUCommandEncoder, inputs: MeshletBucketRasterInputs): void {
    const pipelines = this.rasterPipelines ??= BUCKET_PIPELINES.map(
      (descriptor) => this.graphics.render_pipelines.obtain(descriptor)
    );
    const cached = this.rasterGroups.get(inputs.prepared);
    const group = cached !== undefined && cached.camera === inputs.camera
      ? cached.group
      : this.createRasterGroup(inputs);
    if (cached === undefined || cached.camera !== inputs.camera) {
      this.rasterGroups.set(inputs.prepared, Object.freeze({ camera: inputs.camera, group }));
    }
    const pass = encoder.beginRenderPass({
      label: "ADR-0008 Meshlet bucket Hardware Visibility",
      colorAttachments: [{
        view: inputs.visibilityKey,
        clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }],
      depthStencilAttachment: {
        view: inputs.depth,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    for (let bucket = 0; bucket < inputs.prepared.bucketCount; bucket++) {
      const pipelineBucket = bucket % GPU_MESHLET_BUCKET_COUNT;
      const doubleSided = ((pipelineBucket >>> 3) & 1) !== 0;
      const mask = ((pipelineBucket >>> 4) & 1) !== 0;
      pass.setPipeline(pipelines[(mask ? 2 : 0) + (doubleSided ? 1 : 0)]!);
      pass.setBindGroup(0, group, [bucket * MESHLET_BUCKET_SETTINGS_STRIDE]);
      pass.drawIndirect(inputs.prepared.drawIndirect, bucket * 16);
    }
    pass.end();
  }

  private createRasterGroup(inputs: MeshletBucketRasterInputs): GPUBindGroup {
    return this.graphics.bind_groups.obtain({
      layout: MESHLET_BUCKET_RASTER_GROUP,
      entries: [
        { buffer: inputs.camera },
        { buffer: inputs.scene.instances },
        { buffer: inputs.assets.meshletRecords },
        { buffer: inputs.assets.meshletVertexIndices },
        { buffer: inputs.assets.meshletTriangleIndices },
        { buffer: inputs.assets.vertexStreamData },
        { buffer: inputs.assets.geometryRecords },
        { buffer: inputs.prepared.queue },
        { buffer: inputs.prepared.bucketStates },
        { buffer: inputs.prepared.bucketSettings, size: MESHLET_BUCKET_SETTINGS_SIZE },
        { buffer: inputs.runtime.materialResources.materialRecords },
        ...inputs.runtime.materialResources.textureBanks
      ]
    });
  }

  encodeParity(
    encoder: GPUCommandEncoder,
    input: {
      candidateIdentity: GPUTextureView;
      productionKey: GPUTextureView;
      exactWork: GPUBuffer;
      settings: GPUBuffer;
      counters: GPUBuffer;
      meshletWork: GPUBuffer;
      width: number;
      height: number;
    }
  ): void {
    const pass = encoder.beginComputePass({ label: "ADR-0008 Meshlet bucket semantic parity" });
    this.parityPipeline ??= this.graphics.compute_pipelines.obtain(PARITY_PIPELINE);
    pass.setPipeline(this.parityPipeline);
    pass.setBindGroup(0, this.graphics.bind_groups.obtain({
      layout: PARITY_GROUP,
      entries: [
        input.candidateIdentity,
        input.productionKey,
        { buffer: input.exactWork },
        { buffer: input.settings },
        { buffer: input.counters },
        { buffer: input.meshletWork }
      ]
    }));
    pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
    pass.end();
  }
}
