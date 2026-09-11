import type { GpuAssetBindings } from "../gpu/GpuAssetStore.js";
import type { CachedRenderPipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";
import type { GpuSceneBindings } from "../gpu/GpuScene.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { GPU_MESHLET_BUCKET_COUNT } from "../gpu/GpuMeshletRasterWorkAbi.js";
import type { GpuRenderWorldRuntime } from "../gpu/GpuRenderWorld.js";
import {
  MESHLET_BUCKET_SETTINGS_SIZE,
  MESHLET_BUCKET_SETTINGS_STRIDE,
  MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL,
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

function bucketPipeline(
  doubleSided: boolean,
  mask: boolean,
  primitiveIndex: boolean,
  textureBindingSetId: number
): CachedRenderPipelineDescriptor {
  const specialization = primitiveIndex ? "primitive-index" : "portable-varying";
  const code = primitiveIndex
    ? MESHLET_BUCKET_VISIBILITY_PRIMITIVE_INDEX_WGSL
    : MESHLET_BUCKET_VISIBILITY_WGSL;
  return {
    label: `ADR-0008 Meshlet bucket ${specialization} set ${textureBindingSetId} ${doubleSided ? "double-sided" : "back-face"} ${mask ? "MASK" : "OPAQUE"}`,
    layout: {
      label: "ADR-0008 Meshlet bucket Hardware Visibility layout",
      bindGroupLayouts: [MESHLET_BUCKET_RASTER_GROUP]
    },
    vertex: {
      module: { label: `ADR-0008 Meshlet bucket visibility/${specialization}`, code },
      entryPoint: "raster_meshlet_bucket"
    },
    fragment: {
      module: { label: `ADR-0008 Meshlet bucket visibility/${specialization}`, code },
      entryPoint: mask ? "write_meshlet_mask" : "write_meshlet_opaque",
      constants: { OENGINE_ACTIVE_TEXTURE_BINDING_SET: textureBindingSetId },
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

function bucketPipelines(primitiveIndex: boolean, textureBindingSetId: number): readonly CachedRenderPipelineDescriptor[] {
  return Object.freeze([
    bucketPipeline(false, false, primitiveIndex, textureBindingSetId),
    bucketPipeline(true, false, primitiveIndex, textureBindingSetId),
    bucketPipeline(false, true, primitiveIndex, textureBindingSetId),
    bucketPipeline(true, true, primitiveIndex, textureBindingSetId)
  ]);
}

export interface MeshletBucketRasterInputs {
  readonly prepared: PreparedMeshletWorkCandidate;
  readonly camera: GPUBuffer;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly runtime: GpuRenderWorldRuntime;
  readonly visibilityKey: GPUTextureView;
  readonly depth: GPUTextureView;
}

/** Standard indirect GPU consumer for VisibilityKey V2. */
export class MeshletBucketRaster {
  readonly primitiveIndexSupported: boolean;
  private readonly rasterPipelines = new Map<string, readonly GPURenderPipeline[]>();

  constructor(private readonly graphics: GraphicsContext) {
    this.primitiveIndexSupported = graphics.device.features.has("primitive-index");
  }

  encodeRaster(
    encoder: GPUCommandEncoder,
    inputs: MeshletBucketRasterInputs,
    primitiveIndexPath: "auto" | "portable" = "auto"
  ): void {
    const primitiveIndex = primitiveIndexPath === "auto" && this.primitiveIndexSupported;
    const bindingSets = inputs.runtime.materialResources.bindingSets;
    if (bindingSets.length === 0) throw new Error("Meshlet visibility requires one active TextureBindingSet");
    const groups = new Map(bindingSets.map((set) => [set.id, this.createRasterGroup(inputs, set.textureBanks)]));
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
      const sets = mask ? bindingSets : bindingSets.slice(0, 1);
      for (const bindingSet of sets) {
        const key = `${primitiveIndex ? 1 : 0}:${bindingSet.id}`;
        let pipelines = this.rasterPipelines.get(key);
        if (pipelines === undefined) {
          pipelines = bucketPipelines(primitiveIndex, bindingSet.id).map(
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
        { buffer: inputs.prepared.bucketStates },
        { buffer: inputs.prepared.bucketSettings, size: MESHLET_BUCKET_SETTINGS_SIZE },
        { buffer: inputs.runtime.materialResources.materialRecords },
        ...textureBanks
      ]
    });
  }

}
