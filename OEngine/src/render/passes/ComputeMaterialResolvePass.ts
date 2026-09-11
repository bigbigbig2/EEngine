import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  GPU_COMPUTE_MATERIAL_ABI_VERSION,
  GPU_COMPUTE_MATERIAL_FORMATS
} from "../../gpu/GpuComputeMaterialAbi.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  materialTileDispatchIndirectByteOffset
} from "../../gpu/GpuMaterialTileWorkAbi.js";
import { gpuShadingSurfaceNormalPipelineConstants } from "../../gpu/GpuComputeMaterialAbi.js";
import {
  PACKED_MATERIAL_COMPUTE_NO_VELOCITY_WGSL,
  PACKED_MATERIAL_COMPUTE_WITH_VELOCITY_WGSL
} from "../../shaders/packed_material_compute.js";
import {
  computeMaterialEvaluationFrame,
  materialTileClassificationFrame,
  textureDomain,
  type ComputeMaterialEvaluationFrame,
  type MaterialTileClassificationFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import {
  prepareVelocityMatrices,
  type VelocityCameraMatrices
} from "../VelocityMatrices.js";

const INPUT_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ComputeMaterial/input",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", minBindingSize: 64 }
    },
    {
      binding: 3,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      binding: index + 4,
      visibility: GPUShaderStage.COMPUTE,
      sampler: { type: "filtering" as GPUSamplerBindingType }
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      binding: index + 7,
      visibility: GPUShaderStage.COMPUTE,
      sampler: { type: "non-filtering" as GPUSamplerBindingType }
    })),
    {
      binding: 10,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      binding: index + 11,
      visibility: GPUShaderStage.COMPUTE,
      texture: {
        sampleType: "float" as GPUTextureSampleType,
        viewDimension: "2d-array" as GPUTextureViewDimension
      }
    }))
  ]
};

/** Bindings 5 and 8 from the legacy lookup layout are intentionally absent. */
const LOOKUP_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ComputeMaterial/canonical geometry",
  entries: [0, 1, 2, 3, 4, 6, 7].map((binding) => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

function outputGroup(velocity: boolean): GPUBindGroupLayoutDescriptor {
  return {
    label: velocity
      ? "ADR-0009 ComputeMaterial/output+velocity"
      : "ADR-0009 ComputeMaterial/output",
    entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: GPU_COMPUTE_MATERIAL_FORMATS.normal }
    },
    {
      binding: 3,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: GPU_COMPUTE_MATERIAL_FORMATS.albedoAo }
    },
    {
      binding: 4,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: GPU_COMPUTE_MATERIAL_FORMATS.material }
    },
    ...(velocity ? [{
      binding: 5,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: {
        access: "write-only" as GPUStorageTextureAccess,
        format: GPU_COMPUTE_MATERIAL_FORMATS.velocity
      }
    }] : []),
    {
      binding: 6,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 }
    }
    ]
  };
}

const OUTPUT_GROUP_NO_VELOCITY = outputGroup(false);
const OUTPUT_GROUP_WITH_VELOCITY = outputGroup(true);

function pipeline(
  entryPoint: string,
  velocity: boolean
): CachedComputePipelineDescriptor {
  const output = velocity ? OUTPUT_GROUP_WITH_VELOCITY : OUTPUT_GROUP_NO_VELOCITY;
  return {
    label: `ADR-0009 ComputeMaterial/${entryPoint}${velocity ? "/velocity" : ""}`,
    layout: {
      label: `ADR-0009 ComputeMaterial/layout${velocity ? "/velocity" : ""}`,
      bindGroupLayouts: [INPUT_GROUP, LOOKUP_GROUP, output]
    },
    compute: {
      module: {
        label: `ADR-0009 visibility-driven material evaluation${
          velocity ? "/velocity" : ""
        }`,
        code: velocity
          ? PACKED_MATERIAL_COMPUTE_WITH_VELOCITY_WGSL
          : PACKED_MATERIAL_COMPUTE_NO_VELOCITY_WGSL
      },
      entryPoint,
      constants: gpuShadingSurfaceNormalPipelineConstants()
    }
  };
}

const CLEAR_NO_VELOCITY = pipeline("clear_compute_material_outputs", false);
const EVALUATE_NO_VELOCITY = pipeline("evaluate_compute_material_tiles", false);
const CLEAR_WITH_VELOCITY = pipeline("clear_compute_material_outputs", true);
const EVALUATE_WITH_VELOCITY = pipeline("evaluate_compute_material_tiles", true);

export interface ComputeMaterialResolveJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly width: number;
  readonly height: number;
  readonly currentCamera: VelocityCameraMatrices;
  readonly previousCamera: VelocityCameraMatrices;
}

export interface ComputeMaterialResolveOutputs {
  readonly evaluation: ComputeMaterialEvaluationFrame;
  readonly classification: MaterialTileClassificationFrame;
}

/** GPU-only full material evaluator; every valid pixel is claimed exactly once. */
export class ComputeMaterialResolvePass {
  private readonly previousViewProjectionBuffer: GPUBuffer;
  private readonly dispatchClassBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  private readonly previousViewProjection = new Float32Array(16);
  private readonly inverseCurrent = new Float32Array(16);
  private readonly unusedRotation = new Float32Array(16);
  lastIndirectDispatchCount = 0;

  constructor(private readonly graphics: GraphicsContext) {
    this.previousViewProjectionBuffer = graphics.device.createBuffer({
      label: "ADR-0009 ComputeMaterial/previous view projection",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.dispatchClassBuffer = graphics.device.createBuffer({
      label: "ADR-0009 ComputeMaterial/static dispatch classes",
      size: GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT * 2 * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const settings = new Uint32Array(GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT * 2 * 64);
    for (let velocity = 0; velocity < 2; velocity++) {
      for (let dispatchClass = 0;
        dispatchClass < GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
        dispatchClass++) {
        const base = (velocity * GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT + dispatchClass) * 64;
        settings[base] = dispatchClass;
        settings[base + 1] = velocity;
      }
    }
    graphics.device.queue.writeBuffer(this.dispatchClassBuffer, 0, settings);
    this.samplers = Object.freeze([
      createSampler(graphics.device, "repeat", "linear"),
      createSampler(graphics.device, "clamp-to-edge", "linear"),
      createSampler(graphics.device, "mirror-repeat", "linear"),
      createSampler(graphics.device, "repeat", "nearest"),
      createSampler(graphics.device, "clamp-to-edge", "nearest"),
      createSampler(graphics.device, "mirror-repeat", "nearest")
    ]);
  }

  addToGraph(
    graph: FrameGraph,
    job: ComputeMaterialResolveJob,
    inputs: Readonly<{
      visibility: VisibilityFrame;
      classification: MaterialTileClassificationFrame;
      view: ResourceId;
    }>,
    options: Readonly<{ velocity: boolean }>
  ): ComputeMaterialResolveOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    let normal = -1;
    let albedoAo = -1;
    let material = -1;
    let velocity = -1;
    let queues = -1;
    let pixelClaims = -1;
    const builder = graph.add(
      "Compute material evaluation/MaterialTileWork",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        prepareVelocityMatrices(
          this.unusedRotation,
          this.inverseCurrent,
          this.previousViewProjection,
          data.currentCamera,
          data.previousCamera,
          width,
          height
        );
        this.graphics.device.queue.writeBuffer(
          this.previousViewProjectionBuffer,
          0,
          this.previousViewProjection
        );
        const group0BySet = new Map(data.runtime.materialResources.bindingSets.map(
          (bindingSet) => [bindingSet.id, this.graphics.bind_groups.obtain({
            layout: INPUT_GROUP,
            entries: [
              texture(resources.get(inputs.visibility.visibilityKey)),
              { buffer: buffer(resources.get(inputs.view)) },
              { buffer: this.previousViewProjectionBuffer },
              bindingSet.textureBanks[0],
              ...this.samplers,
              { buffer: data.runtime.materialResources.materialRecords },
              ...bindingSet.textureBanks.slice(1)
            ]
          })] as const
        ));
        const fallbackGroup0 = group0BySet.values().next().value as GPUBindGroup | undefined;
        if (fallbackGroup0 === undefined) {
          throw new Error("ComputeMaterialResolvePass requires one active TextureBindingSet");
        }
        const group1 = this.graphics.bind_groups.obtain({
          layout: LOOKUP_GROUP,
          entries: [
            { buffer: data.scene.instances },
            { buffer: data.assets.geometryRecords },
            { buffer: data.assets.meshletRecords },
            { buffer: data.assets.meshletVertexIndices },
            { buffer: data.assets.meshletTriangleIndices },
            { buffer: data.assets.vertexStreamData },
            { buffer: buffer(resources.get(inputs.visibility.meshletWork.records)) }
          ]
        });
        const outputLayout = options.velocity
          ? OUTPUT_GROUP_WITH_VELOCITY
          : OUTPUT_GROUP_NO_VELOCITY;
        const group2 = this.graphics.bind_groups.obtain({
          layout: outputLayout,
          entries: [
            { buffer: buffer(resources.get(queues)) },
            { buffer: buffer(resources.get(pixelClaims)) },
            texture(resources.get(normal)),
            texture(resources.get(albedoAo)),
            texture(resources.get(material)),
            ...(options.velocity ? [texture(resources.get(velocity))] : []),
            { buffer: this.dispatchClassBuffer, size: 16 }
          ]
        });

        const clearPipeline = options.velocity ? CLEAR_WITH_VELOCITY : CLEAR_NO_VELOCITY;
        const evaluatePipeline = options.velocity
          ? EVALUATE_WITH_VELOCITY
          : EVALUATE_NO_VELOCITY;
        const clear = command.beginComputePass({ label: clearPipeline.label });
        clear.setPipeline(this.graphics.compute_pipelines.obtain(clearPipeline));
        clear.setBindGroup(0, fallbackGroup0);
        clear.setBindGroup(1, group1);
        clear.setBindGroup(2, group2, [0]);
        clear.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
        clear.end();

        const indirect = buffer(resources.get(inputs.classification.indirectArgs));
        const evaluate = command.beginComputePass({
          label: "ADR-0009 ComputeMaterial/bounded indirect classes"
        });
        evaluate.setPipeline(this.graphics.compute_pipelines.obtain(evaluatePipeline));
        evaluate.setBindGroup(1, group1);
        for (let dispatchClass = 0;
          dispatchClass < GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
          dispatchClass++) {
          const bindingSet = Math.floor(dispatchClass / 7);
          evaluate.setBindGroup(0, group0BySet.get(bindingSet) ?? fallbackGroup0);
          const settingsIndex =
            (options.velocity ? GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT : 0) +
            dispatchClass;
          evaluate.setBindGroup(2, group2, [settingsIndex * 256]);
          evaluate.dispatchWorkgroupsIndirect(
            indirect,
            materialTileDispatchIndirectByteOffset(dispatchClass)
          );
        }
        evaluate.end();
        this.lastIndirectDispatchCount = GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
      }
    );

    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    normal = builder.create("compute-material/normal", textureDescriptor(
      width, height, GPU_COMPUTE_MATERIAL_FORMATS.normal, usage
    ));
    albedoAo = builder.create("compute-material/albedo-ao", textureDescriptor(
      width, height, GPU_COMPUTE_MATERIAL_FORMATS.albedoAo, usage
    ));
    material = builder.create("surface-lite/material", textureDescriptor(
      width, height, GPU_COMPUTE_MATERIAL_FORMATS.material, usage
    ));
    if (options.velocity) {
      velocity = builder.create(
        "surface-lite/velocity",
        textureDescriptor(
          width,
          height,
          GPU_COMPUTE_MATERIAL_FORMATS.velocity,
          usage
        )
      );
    }
    queues = builder.write(inputs.classification.queues);
    pixelClaims = builder.write(inputs.classification.pixelClaims);
    builder.read(inputs.classification.indirectArgs);
    builder.read(inputs.visibility.visibilityKey);
    builder.read(inputs.visibility.meshletWork.records);
    builder.read(inputs.view);

    return Object.freeze({
      evaluation: computeMaterialEvaluationFrame({
        abiVersion: GPU_COMPUTE_MATERIAL_ABI_VERSION,
        normal,
        albedoAo,
        material,
        velocity: options.velocity ? velocity : null,
        fullMaterialEvaluationCountSource: "pixel-claims",
        domain: textureDomain("internal-full", width, height, 1)
      }),
      classification: materialTileClassificationFrame({
        ...inputs.classification,
        queues,
        pixelClaims
      })
    });
  }

  destroy(): void {
    this.previousViewProjectionBuffer.destroy();
    this.dispatchClassBuffer.destroy();
  }
}

function createSampler(
  device: GPUDevice,
  addressMode: GPUAddressMode,
  filter: GPUFilterMode
): GPUSampler {
  return device.createSampler({
    label: `ADR-0009 ComputeMaterial/${addressMode}-${filter}`,
    addressModeU: addressMode,
    addressModeV: addressMode,
    minFilter: filter,
    magFilter: filter,
    mipmapFilter: filter
  });
}

function textureDescriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return { kind: "transient_texture" as const, label: format, width, height, format, usage };
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("ComputeMaterialResolvePass expected GPUBuffer");
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("ComputeMaterialResolvePass requires ShadeGPUCommandContext");
}
