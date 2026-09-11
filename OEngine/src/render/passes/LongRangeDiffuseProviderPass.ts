/** Receiver-local Brick4 > Probe Volume > IBL > black producer. */

import { GPU_COUNTER_BYTE_SIZE } from "../../debug/GpuFrameCounters.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile,
  gpuShadingSurfaceNormalPipelineConstants
} from "../../gpu/GpuComputeMaterialAbi.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  LONG_RANGE_DIFFUSE_PROVIDER_WGSL,
  LONG_RANGE_PROVIDER_FORMAT
} from "../../shaders/long_range_diffuse_provider.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

export interface LongRangeProviderInputs {
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly material: ResourceId;
  readonly metadata: ResourceId;
  readonly camera: ResourceId;
  readonly view: ResourceId;
  readonly counters: ResourceId;
  readonly stbn: ResourceId;
  readonly environmentDiffuse: ResourceId;
  readonly environmentSpecular: ResourceId;
  readonly brick4: ResourceId;
  readonly lpvMeshBvh: ResourceId;
  readonly lpvMetadata: ResourceId;
  readonly lpvTetrahedra: ResourceId;
  readonly lpvProbes: ResourceId;
  readonly lpvDepthAtlas: ResourceId;
}

export interface LongRangeProviderJob {
  readonly width: number;
  readonly height: number;
  readonly countersEnabled: boolean;
  readonly brickRegistered: boolean;
  readonly brickResident: boolean;
  readonly brickGeneration: number;
  readonly brickExpectedGeneration: number;
  readonly probeRegistered: boolean;
  readonly probeResident: boolean;
  readonly probeGeneration: number;
  readonly probeExpectedGeneration: number;
  readonly iblResident: boolean;
}

export interface LongRangeProviderOutput {
  readonly diffuseIrradiance: ResourceId;
  readonly specularRadiance: ResourceId;
  /** Same resource as diffuseIrradiance; alpha stores the authoritative id. */
  readonly providerSelection: ResourceId;
  readonly counters: ResourceId;
}

const FRAGMENT = GPUShaderStage.FRAGMENT;
const GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/LongRangeProvider/surface-layout",
  entries: [
    { binding: 0, visibility: FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 1, visibility: FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 3, visibility: FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 5, visibility: FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/LongRangeProvider/frame-layout",
  entries: [
    { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: FRAGMENT, buffer: { type: "uniform" } },
    { binding: 2, visibility: FRAGMENT, buffer: { type: "uniform", minBindingSize: 48 } },
    { binding: 3, visibility: FRAGMENT, buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE } },
    { binding: 4, visibility: FRAGMENT, sampler: { type: "filtering" } },
    { binding: 5, visibility: FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
    { binding: 6, visibility: FRAGMENT, texture: { sampleType: "float" } },
    { binding: 7, visibility: FRAGMENT, texture: { sampleType: "float" } }
  ]
};

const GROUP2: GPUBindGroupLayoutDescriptor = {
  label: "Renderer/LongRangeProvider/provider-layout",
  entries: [
    { binding: 0, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: FRAGMENT, buffer: { type: "uniform" } },
    { binding: 3, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: FRAGMENT, texture: { sampleType: "float" } }
  ]
};

export class LongRangeDiffuseProviderPass {
  private readonly descriptor: CachedRenderPipelineDescriptor;
  private pipeline: GPURenderPipeline | null = null;
  private readonly settingsBuffer: GPUBuffer;
  lastRan = false;

  constructor(
    private readonly graphics: GraphicsContext,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    const label = "Renderer/receiver-local long-range GI provider";
    const module = { label, code: LONG_RANGE_DIFFUSE_PROVIDER_WGSL };
    this.descriptor = {
      label,
      layout: { label: `${label}/layout`, bindGroupLayouts: [GROUP0, GROUP1, GROUP2] },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        constants: {
          ...gpuShadingSurfaceNormalPipelineConstants(surfaceProfile.normalEncoding)
        },
        targets: [
          { format: LONG_RANGE_PROVIDER_FORMAT },
          { format: LONG_RANGE_PROVIDER_FORMAT }
        ]
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "not-equal"
      }
    };
    this.settingsBuffer = graphics.device.createBuffer({
      label: "Long-range GI provider state",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  addToGraph(
    graph: FrameGraph,
    job: LongRangeProviderJob,
    inputs: LongRangeProviderInputs
  ): LongRangeProviderOutput {
    this.pipeline ??= this.graphics.render_pipelines.obtain(this.descriptor);
    let diffuseIrradiance = -1;
    let specularRadiance = -1;
    let counters = inputs.counters;
    const builder = graph.add(
      "receiver-local long-range GI provider",
      job,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        if (!encoder || !this.pipeline) {
          throw new Error("LongRangeDiffuseProviderPass: missing encoder or pipeline");
        }
        writeGpuBuffer(
          this.graphics.device.queue,
          "LongRangeProvider/settings",
          this.settingsBuffer,
          0,
          new Uint32Array([
            Number(data.brickRegistered), Number(data.brickResident),
            data.brickGeneration >>> 0, data.brickExpectedGeneration >>> 0,
            Number(data.probeRegistered), Number(data.probeResident),
            data.probeGeneration >>> 0, data.probeExpectedGeneration >>> 0,
            Number(data.iblResident), Number(data.countersEnabled), 0, 0
          ])
        );
        const pass = encoder.beginRenderPass({
          label: "receiver-local long-range GI provider",
          colorAttachments: [
            clearAttachment(resources.get(diffuseIrradiance)),
            clearAttachment(resources.get(specularRadiance))
          ],
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(inputs.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(this.pipeline);
        this.graphics.setPipelineBindings(pass, this.descriptor, [
          [
            texture(resources.get(inputs.depth)),
            texture(resources.get(inputs.normal)),
            texture(resources.get(inputs.bentNormal)),
            texture(resources.get(inputs.albedoAo)),
            texture(resources.get(inputs.material)),
            texture(resources.get(inputs.metadata))
          ],
          [
            { buffer: buffer(resources.get(inputs.camera)) },
            { buffer: buffer(resources.get(inputs.view)) },
            { buffer: this.settingsBuffer },
            { buffer: buffer(resources.get(counters)) },
            this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            texture(resources.get(inputs.stbn)),
            texture(resources.get(inputs.environmentDiffuse)),
            texture(resources.get(inputs.environmentSpecular))
          ],
          [
            { buffer: buffer(resources.get(inputs.brick4)) },
            { buffer: buffer(resources.get(inputs.lpvMeshBvh)) },
            { buffer: buffer(resources.get(inputs.lpvMetadata)) },
            { buffer: buffer(resources.get(inputs.lpvTetrahedra)) },
            { buffer: buffer(resources.get(inputs.lpvProbes)) },
            texture(resources.get(inputs.lpvDepthAtlas))
          ]
        ]);
        pass.draw(3);
        pass.end();
        this.lastRan = true;
      }
    );
    const descriptor = {
      kind: "transient_texture" as const,
      label: "receiver-local long-range GI product",
      width: Math.max(1, job.width | 0),
      height: Math.max(1, job.height | 0),
      format: LONG_RANGE_PROVIDER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    };
    diffuseIrradiance = builder.create("selected long-range diffuse irradiance", descriptor);
    specularRadiance = builder.create("selected baseline specular radiance", descriptor);
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "counters") builder.read(resource);
    }
    counters = builder.write(inputs.counters);
    return {
      diffuseIrradiance,
      specularRadiance,
      providerSelection: diffuseIrradiance,
      counters
    };
  }

  resetFrameEvidence(): void { this.lastRan = false; }

  destroy(): void {
    this.settingsBuffer.destroy();
    this.pipeline = null;
  }
}

function clearAttachment(resource: unknown): GPURenderPassColorAttachment {
  return {
    view: texture(resource),
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
    loadOp: "clear",
    storeOp: "store"
  };
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("LongRangeDiffuseProviderPass: expected GPUBuffer");
}
