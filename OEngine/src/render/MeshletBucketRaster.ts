import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { CachedRenderPipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { GPU_MESHLET_BUCKET_COUNT } from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import {
  MESHLET_BUCKET_SETTINGS_SIZE,
  MESHLET_BUCKET_SETTINGS_STRIDE,
  MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL,
  MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL,
  MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL,
  MESHLET_BUCKET_VISIBILITY_WGSL,
  VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL,
  VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_SHADING_BIN_WGSL
} from "../shaders/meshlet_bucket_visibility.js";
import {
  gpuShadingBinVisibilityRenderPassAttachments,
  gpuVisibilityKeyRenderPassAttachments
} from
  "../gpu/GpuShadingBinVisibilityContract.js";
import { PACKED_CAMERA_TYPE } from "../shaders/packed_camera.js";
import type { PreparedMeshletWorkCandidate } from "./MeshletWorkCandidate.js";
import type { GpuShadingExecutionMode } from "../gpu/GpuShadingExecutionMode.js";

const MESHLET_BUCKET_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0008 Meshlet bucket Hardware Visibility group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
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
    ...Array.from({ length: 9 }, (_, index) => ({
      binding: index + 11,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {
        sampleType: "unfilterable-float" as GPUTextureSampleType,
        viewDimension: "2d-array" as GPUTextureViewDimension
      }
    }))
  ]
};

const VIRTUAL_GEOMETRY_RASTER_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "S1 Product Meshlet bucket Visibility group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", minBindingSize: PACKED_CAMERA_TYPE.size } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
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

function bucketPipeline(
  doubleSided: boolean,
  mask: boolean,
  primitiveIndex: boolean,
  textureBindingSetId: number,
  includeShadingBinId: boolean
): CachedRenderPipelineDescriptor {
  const specialization = primitiveIndex ? "primitive-index" : "portable-varying";
  const code = primitiveIndex
    ? (includeShadingBinId
      ? MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL
      : MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_SINGLE_WGSL)
    : (includeShadingBinId ? MESHLET_BUCKET_VISIBILITY_WGSL : MESHLET_BUCKET_VISIBILITY_SINGLE_WGSL);
  return {
    label: `ADR-0015 Meshlet bucket ${specialization} set ${textureBindingSetId} ${doubleSided ? "double-sided" : "back-face"} ${mask ? "MASK" : "OPAQUE"} ${includeShadingBinId ? "+ ShadingBinId" : "single VisibilityKey MRT"}`,
    layout: {
      label: "ADR-0013 Meshlet bucket Hardware Visibility layout",
      bindGroupLayouts: [MESHLET_BUCKET_RASTER_GROUP]
    },
    vertex: {
      module: { label: `ADR-0013 Meshlet bucket visibility/${specialization}`, code },
      entryPoint: "raster_meshlet_bucket"
    },
    fragment: {
      module: { label: `ADR-0013 Meshlet bucket visibility/${specialization}`, code },
      entryPoint: mask ? "write_meshlet_mask" : "write_meshlet_opaque",
      constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: textureBindingSetId },
      targets: includeShadingBinId
        ? [{ format: "r32uint" }, { format: "r8uint" }]
        : [{ format: "r32uint" }]
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

function bucketPipelines(
  primitiveIndex: boolean,
  textureBindingSetId: number,
  includeShadingBinId: boolean
): readonly CachedRenderPipelineDescriptor[] {
  return Object.freeze([
    bucketPipeline(false, false, primitiveIndex, textureBindingSetId, includeShadingBinId),
    bucketPipeline(true, false, primitiveIndex, textureBindingSetId, includeShadingBinId),
    bucketPipeline(false, true, primitiveIndex, textureBindingSetId, includeShadingBinId),
    bucketPipeline(true, true, primitiveIndex, textureBindingSetId, includeShadingBinId)
  ]);
}

export interface MeshletBucketRasterInputs {
  readonly prepared: PreparedMeshletWorkCandidate;
  readonly camera: GPUBuffer;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly runtime: GpuRenderWorldRuntime;
  readonly visibilityKey: GPUTextureView;
  readonly shadingBinId: GPUTextureView | null;
  readonly depth: GPUTextureView;
  readonly virtualGeometry?: import("../gpu/VirtualGeometryResidency.js").GeometryProductGpuBindingsV1 | null;
}

/** Standard indirect GPU consumer for VisibilityKey V2. */
export class MeshletBucketRaster {
  readonly primitiveIndexSupported: boolean;
  private readonly rasterPipelines = new Map<string, readonly GPURenderPipeline[]>();
  private readonly virtualRasterPipelines = new Map<string, GPURenderPipeline>();

  constructor(private readonly graphics: GraphicsContext) {
    this.primitiveIndexSupported = graphics.device.features.has("primitive-index");
  }

  encodeRaster(
    encoder: GPUCommandEncoder,
    inputs: MeshletBucketRasterInputs,
    executionMode: GpuShadingExecutionMode | "none" = "sparse-microtile",
    primitiveIndexPath: "auto" | "portable" = "auto"
  ): void {
    const includeShadingBinId = executionMode === "sparse-microtile";
    if (includeShadingBinId !== (inputs.shadingBinId !== null)) {
      throw new Error("Meshlet visibility MRT does not match the shading execution mode");
    }
    if (inputs.prepared.productMode) {
      this.encodeVirtualRaster(encoder, inputs);
      return;
    }
    const primitiveIndex = primitiveIndexPath === "auto" && this.primitiveIndexSupported;
    const bindingSets = inputs.runtime.materialResources.bindingSets;
    if (bindingSets.length === 0) throw new Error("Meshlet visibility requires one active TextureBindingSet");
    const groups = new Map(bindingSets.map((set) => [set.id, this.createRasterGroup(inputs, set.textureBanks)]));
    const pass = encoder.beginRenderPass({
      label: "ADR-0013 Meshlet bucket Hardware Visibility",
      colorAttachments: includeShadingBinId
        ? gpuShadingBinVisibilityRenderPassAttachments(inputs.visibilityKey, inputs.shadingBinId!)
        : gpuVisibilityKeyRenderPassAttachments(inputs.visibilityKey),
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
      const sets = mask ? bindingSets : bindingSets.slice(0, 1);
      for (const bindingSet of sets) {
        const key = `${primitiveIndex ? 1 : 0}:${bindingSet.id}:${includeShadingBinId ? 1 : 0}`;
        let pipelines = this.rasterPipelines.get(key);
        if (pipelines === undefined) {
          pipelines = bucketPipelines(primitiveIndex, bindingSet.id, includeShadingBinId).map(
            (descriptor) => this.graphics.render_pipelines.obtain(descriptor)
          );
          this.rasterPipelines.set(key, pipelines);
        }
        pass.setPipeline(pipelines[(mask ? 2 : 0) + (doubleSided ? 1 : 0)]!);
        pass.setBindGroup(0, groups.get(bindingSet.id)!, [bucket * MESHLET_BUCKET_SETTINGS_STRIDE]);
        pass.drawIndirect(inputs.prepared.drawIndirect, bucket * 16);
      }
    }
    pass.end();
  }

  private createRasterGroup(
    inputs: MeshletBucketRasterInputs,
    textureBanks: GpuRenderWorldRuntime["materialResources"]["bindingSets"][number]["textureBanks"]
  ): GPUBindGroup {
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
        { buffer: inputs.prepared.bucketStates! },
        { buffer: inputs.prepared.bucketSettings!, size: MESHLET_BUCKET_SETTINGS_SIZE },
        { buffer: inputs.runtime.materialResources.materialRecords },
        ...textureBanks
      ]
    });
  }

  private encodeVirtualRaster(
    encoder: GPUCommandEncoder,
    inputs: MeshletBucketRasterInputs
  ): void {
    if (inputs.virtualGeometry === null || inputs.virtualGeometry === undefined ||
        inputs.prepared.productBindings === undefined || inputs.prepared.productBanks === undefined) {
      throw new Error("S1 Product raster requires immutable Product bindings");
    }
    const pipelineMode = inputs.shadingBinId === null ? "direct" : "sparse";
    const bindingSets = inputs.runtime.materialResources.bindingSets;
    if (bindingSets.length === 0) throw new Error("Product Meshlet visibility requires one active TextureBindingSet");
    const pipelines = new Map<number, GPURenderPipeline>();
    const groups = new Map<number, GPUBindGroup>();
    for (const bindingSet of bindingSets) {
      let pipeline = this.virtualRasterPipelines.get(`${pipelineMode}:${bindingSet.id}`);
      if (pipeline === undefined) {
        pipeline = this.graphics.render_pipelines.obtain({
          label: "S1 Product Meshlet bucket Visibility",
          layout: {
            label: "S1 Product Meshlet bucket Visibility layout",
            bindGroupLayouts: [VIRTUAL_GEOMETRY_RASTER_GROUP]
          },
          vertex: {
            module: {
              label: "S1 Product Meshlet bucket Visibility",
              code: inputs.shadingBinId === null
                ? VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL
                : VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_SHADING_BIN_WGSL
            },
            entryPoint: "raster_virtual_meshlet"
          },
          fragment: {
            module: {
              label: "S1 Product Meshlet bucket Visibility",
              code: inputs.shadingBinId === null
                ? VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL
                : VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_SHADING_BIN_WGSL
            },
            entryPoint: "write_virtual_meshlet",
            constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: bindingSet.id },
            targets: inputs.shadingBinId === null
              ? [{ format: "r32uint" }]
              : [{ format: "r32uint" }, { format: "r8uint" }]
          },
          primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
          depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" }
      });
        this.virtualRasterPipelines.set(`${pipelineMode}:${bindingSet.id}`, pipeline);
      }
      pipelines.set(bindingSet.id, pipeline);
      groups.set(bindingSet.id, this.graphics.bind_groups.obtain({
        layout: VIRTUAL_GEOMETRY_RASTER_GROUP,
        entries: [
          { buffer: inputs.camera },
          { buffer: inputs.scene.instances },
          { buffer: inputs.prepared.queue },
          { buffer: inputs.virtualGeometry.metadata },
          ...inputs.prepared.productBanks.slice(0, 4).map((buffer) => ({ buffer })),
          { buffer: inputs.runtime.materialResources.materialRecords },
          ...bindingSet.textureBanks
        ]
      }));
    }
    const pass = encoder.beginRenderPass({
      label: "S1 Product Meshlet bucket Hardware Visibility",
      colorAttachments: inputs.shadingBinId === null
        ? gpuVisibilityKeyRenderPassAttachments(inputs.visibilityKey)
        : gpuShadingBinVisibilityRenderPassAttachments(inputs.visibilityKey, inputs.shadingBinId),
      depthStencilAttachment: {
        view: inputs.depth,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    for (const bindingSet of bindingSets) {
      pass.setPipeline(pipelines.get(bindingSet.id)!);
      pass.setBindGroup(0, groups.get(bindingSet.id)!);
      pass.drawIndirect(inputs.prepared.drawIndirect, 0);
    }
    pass.end();
  }

}
