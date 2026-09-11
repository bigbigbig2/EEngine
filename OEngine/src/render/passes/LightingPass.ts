/**
 * ADR-0009 compute direct lighting. MaterialTileWork is the authoritative GPU
 * producer/consumer path; no CPU material-class traversal participates.
 */

import { GPU_COUNTER_BYTE_SIZE } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT,
  materialTileDispatchIndirectByteOffset
} from "../../gpu/GpuMaterialTileWorkAbi.js";
import {
  GPU_SURFACE_ABI_V1_PROFILE,
  type GpuSurfaceAbiProfile,
  gpuSurfaceNormalPipelineConstants
} from "../../gpu/GpuSurfaceAbi.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  SHADOW_COMPARISON_SAMPLER_DESCRIPTOR
} from "../../gpu/GPUSamplerCache.js";
import { LIGHTING_DIRECT_COMPUTE_WGSL } from "../../shaders/lighting_direct_compute.js";
import { HDR_COLOR_FORMAT } from "../RenderTargets.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import {
  materialTileClassificationFrame,
  type MaterialTileClassificationFrame,
  type SurfaceFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";

export const LIGHTING_MIGRATION_GAP = [
  "compute MaterialTileWork owns production direct lighting",
  "Surface V1 remains a temporary input until visibility-driven material evaluation cutover"
] as const;

export const LIGHTING_STEPS = [
  "clear HDR storage output",
  "dispatch one bounded indirect ShadeLighting consumer per material class/set",
  "validate exactly-once pixel claims on GPU",
  "finalize queue/counter/frame-invalid evidence on GPU"
] as const;

export type LightingJob = {
  width: number;
  height: number;
  materials: GPUBuffer;
};

export type LightingInputs = {
  surface: SurfaceFrame;
  visibility: VisibilityFrame;
  classification: MaterialTileClassificationFrame;
  lightDatabase: ResourceId;
  environment: ResourceId;
  clusterParameters: ResourceId;
  clusterLookup: ResourceId;
  clusterData: ResourceId;
  activeLightList: ResourceId;
  shadowAtlas: ResourceId;
  camera: ResourceId;
  view: ResourceId;
  counters?: ResourceId;
};

export type LightingGraphOutputs = {
  hdr: ResourceId;
  counters: ResourceId | null;
  classification: MaterialTileClassificationFrame;
};

const SURFACE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ShadeLighting/surface",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } }
  ]
};

const LIGHTING_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ShadeLighting/clustered lights",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, sampler: { type: "comparison" } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
  ]
};

const VIEW_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ShadeLighting/view",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
  ]
};

const MATERIAL_TILE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ShadeLighting/MaterialTileWork",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    {
      binding: 5,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 }
    },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    {
      binding: 8,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: HDR_COLOR_FORMAT }
    }
  ]
};

const MODULE = {
  label: "ADR-0009 compute direct lighting",
  code: LIGHTING_DIRECT_COMPUTE_WGSL
} as const;

function computePipeline(
  entryPoint: string,
  surfaceProfile: GpuSurfaceAbiProfile
): CachedComputePipelineDescriptor {
  return {
    label: `ADR-0009 ShadeLighting/${entryPoint}`,
    layout: {
      label: "ADR-0009 ShadeLighting/layout",
      bindGroupLayouts: [
        SURFACE_GROUP,
        LIGHTING_GROUP,
        VIEW_GROUP,
        MATERIAL_TILE_GROUP
      ]
    },
    compute: {
      module: MODULE,
      entryPoint,
      constants: {
        ...gpuSurfaceNormalPipelineConstants(surfaceProfile.normalEncoding)
      }
    }
  };
}

/** MaterialTileWork-driven production direct-lighting owner. */
export class LightingPass {
  lastRan = false;
  lastIndirectDispatchCount = 0;
  private readonly clearPipeline: CachedComputePipelineDescriptor;
  private readonly validatePipeline: CachedComputePipelineDescriptor;
  private readonly finalizePipeline: CachedComputePipelineDescriptor;
  private readonly shadingPipeline: CachedComputePipelineDescriptor;
  private readonly dispatchClassBuffer: GPUBuffer;

  constructor(
    private readonly graphics: GraphicsContext,
    surfaceProfile: GpuSurfaceAbiProfile = GPU_SURFACE_ABI_V1_PROFILE
  ) {
    this.clearPipeline = computePipeline("clear_direct_lighting", surfaceProfile);
    this.validatePipeline = computePipeline(
      "validate_direct_lighting_pixels",
      surfaceProfile
    );
    this.finalizePipeline = computePipeline("finalize_direct_lighting", surfaceProfile);
    this.shadingPipeline = computePipeline(
      "shade_direct_material_tiles",
      surfaceProfile
    );
    this.dispatchClassBuffer = graphics.device.createBuffer({
      label: "ADR-0009 ShadeLighting/static dispatch classes",
      size: GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const dispatchClasses = new Uint32Array(
      GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT * 64
    );
    for (let dispatchClass = 0;
      dispatchClass < GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
      dispatchClass++) {
      dispatchClasses[dispatchClass * 64] = dispatchClass;
    }
    graphics.device.queue.writeBuffer(
      this.dispatchClassBuffer,
      0,
      dispatchClasses
    );
  }

  init(): void {}

  addToGraph(
    graph: FrameGraph,
    job: LightingJob,
    inputs: LightingInputs
  ): LightingGraphOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    let hdr = -1;
    let queues = -1;
    let control = -1;
    let pixelClaims = -1;
    let frameCounters = -1;
    let publishedCounters: ResourceId | null = null;
    const builder = graph.add(
      "Compute direct lighting/MaterialTileWork",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const groups = [
          this.graphics.bind_groups.obtain({
            layout: SURFACE_GROUP,
            entries: [
              texture(resources.get(inputs.surface.depth!)),
              texture(resources.get(inputs.surface.pbr)),
              texture(resources.get(inputs.surface.normal)),
              texture(resources.get(inputs.surface.albedoAo)),
              texture(resources.get(inputs.surface.emissive)),
              this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
              texture(resources.get(inputs.surface.metadata))
            ]
          }),
          this.graphics.bind_groups.obtain({
            layout: LIGHTING_GROUP,
            entries: [
              { buffer: buffer(resources.get(inputs.lightDatabase)) },
              texture(resources.get(inputs.environment)),
              { buffer: buffer(resources.get(inputs.clusterParameters)) },
              { buffer: buffer(resources.get(inputs.clusterLookup)) },
              { buffer: buffer(resources.get(inputs.clusterData)) },
              texture(resources.get(inputs.shadowAtlas)),
              this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR),
              { buffer: buffer(resources.get(inputs.activeLightList)) }
            ]
          }),
          this.graphics.bind_groups.obtain({
            layout: VIEW_GROUP,
            entries: [
              { buffer: buffer(resources.get(inputs.view)) },
              { buffer: buffer(resources.get(inputs.camera)) }
            ]
          }),
          this.graphics.bind_groups.obtain({
            layout: MATERIAL_TILE_GROUP,
            entries: [
              texture(resources.get(inputs.visibility.visibilityKey)),
              { buffer: buffer(resources.get(inputs.visibility.meshletWork.records)) },
              { buffer: data.materials },
              { buffer: buffer(resources.get(queues)) },
              { buffer: buffer(resources.get(control)) },
              { buffer: this.dispatchClassBuffer, size: 16 },
              { buffer: buffer(resources.get(pixelClaims)) },
              { buffer: buffer(resources.get(frameCounters)) },
              texture(resources.get(hdr))
            ]
          })
        ] as const;

        encodeDirect(command, this.graphics, this.clearPipeline, groups,
          Math.ceil(width / 8), Math.ceil(height / 8));
        const indirectBuffer = buffer(resources.get(inputs.classification.indirectArgs));
        const shading = command.beginComputePass({
          label: "ADR-0009 ShadeLighting/bounded indirect classes"
        });
        for (let group = 0; group < 3; group++) {
          shading.setBindGroup(group, groups[group]!);
        }
        shading.setPipeline(this.graphics.compute_pipelines.obtain(
          this.shadingPipeline
        ));
        for (let dispatchClass = 0;
          dispatchClass < GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
          dispatchClass++) {
          shading.setBindGroup(3, groups[3]!, [dispatchClass * 256]);
          shading.dispatchWorkgroupsIndirect(
            indirectBuffer,
            materialTileDispatchIndirectByteOffset(dispatchClass)
          );
        }
        shading.end();
        encodeDirect(command, this.graphics, this.validatePipeline, groups,
          Math.ceil(width / 8), Math.ceil(height / 8));
        encodeDirect(command, this.graphics, this.finalizePipeline, groups, 1, 1);
        this.lastRan = true;
        this.lastIndirectDispatchCount = GPU_MATERIAL_TILE_DISPATCH_CLASS_COUNT;
      }
    );

    hdr = builder.create("hdr_color / compute lighting", {
      kind: "transient_texture",
      label: "ADR-0009 HDR/compute direct lighting",
      width,
      height,
      format: HDR_COLOR_FORMAT,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    });
    queues = builder.write(inputs.classification.queues);
    control = builder.write(inputs.classification.control);
    pixelClaims = builder.write(inputs.classification.pixelClaims);
    if (inputs.counters === undefined) {
      frameCounters = builder.create("compute-lighting/counter-scratch", {
        kind: "transient_buffer",
        label: "ADR-0009 compute lighting/counter scratch",
        size: GPU_COUNTER_BYTE_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
    } else {
      builder.read(inputs.counters);
      publishedCounters = builder.write(inputs.counters);
      frameCounters = publishedCounters;
    }

    for (const resource of [
      inputs.surface.depth,
      inputs.surface.pbr,
      inputs.surface.normal,
      inputs.surface.albedoAo,
      inputs.surface.emissive,
      inputs.surface.metadata,
      inputs.visibility.visibilityKey,
      inputs.visibility.meshletWork.records,
      inputs.classification.indirectArgs,
      inputs.lightDatabase,
      inputs.environment,
      inputs.clusterParameters,
      inputs.clusterLookup,
      inputs.clusterData,
      inputs.activeLightList,
      inputs.shadowAtlas,
      inputs.camera,
      inputs.view
    ]) {
      if (resource !== null) builder.read(resource);
    }

    return Object.freeze({
      hdr,
      counters: publishedCounters,
      classification: materialTileClassificationFrame({
        ...inputs.classification,
        queues,
        control,
        pixelClaims,
        counters: publishedCounters
      })
    });
  }

  destroy(): void {
    this.dispatchClassBuffer.destroy();
  }
}

function encodeDirect(
  command: ShadeGPUCommandContext,
  graphics: GraphicsContext,
  descriptor: CachedComputePipelineDescriptor,
  groups: readonly GPUBindGroup[],
  workgroupsX: number,
  workgroupsY: number
): void {
  const pass = command.beginComputePass({ label: descriptor.label });
  pass.setPipeline(graphics.compute_pipelines.obtain(descriptor));
  for (let group = 0; group < groups.length; group++) {
    if (group === 3) {
      pass.setBindGroup(group, groups[group]!, [0]);
    } else {
      pass.setBindGroup(group, groups[group]!);
    }
  }
  pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
  pass.end();
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("LightingPass requires ShadeGPUCommandContext");
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("LightingPass expected GPUBuffer");
}
