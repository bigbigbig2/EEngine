/**
 * ScreenSpaceAmbientOcclusionPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  SSAO_ALBEDO_AO_FORMAT,
  SSAO_BENT_NORMAL_UPSAMPLE_WGSL,
  SSAO_BENT_NORMAL_FORMAT,
  SSAO_COMPOSITE_WGSL,
  SSAO_RAW_WGSL,
  SSAO_SPATIAL_WGSL,
  SSAO_TEMPORAL_WGSL,
  SSAO_VISIBILITY_FORMAT
} from "../../shaders/ssao.js";
import { HILBERT_NOISE_TEXTURE } from "../HilbertNoiseTexture.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

export { hilbertIndex } from "../HilbertNoiseTexture.js";

export type ScreenSpaceAmbientOcclusionInputs = {
  depth: ResourceId;
  normal: ResourceId;
  velocity: ResourceId;
  occlusionConfidence: ResourceId;
  albedoAo: ResourceId;
  camera: ResourceId;
};

export type ScreenSpaceAmbientOcclusionOutput = {
  rawVisibility: ResourceId;
  denoisedVisibility: ResourceId;
  visibility: ResourceId;
  occlusion: ResourceId;
  bentNormals: ResourceId;
};

export type ScreenSpaceAmbientOcclusionJob = {
  samplers: GPUSamplerCache;
  frameIndex: number;
  historyValid: boolean;
  historyInputIndex: 0 | 1;
  historyOutputIndex: 0 | 1;
  width: number;
  height: number;
};

export class ScreenSpaceAmbientOcclusionPass {
  private readonly rawPipeline: CachedRenderPipelineDescriptor;
  private readonly spatialPipeline: CachedRenderPipelineDescriptor;
  private readonly temporalPipeline: CachedRenderPipelineDescriptor;
  private readonly compositePipeline: CachedRenderPipelineDescriptor;
  private readonly bentNormalUpsamplePipeline: CachedRenderPipelineDescriptor;
  private rawSettingsBuffer: GPUBuffer | null = null;
  private spatialSettingsBuffer: GPUBuffer | null = null;
  private hilbertView: GPUTextureView | null = null;
  private readonly histories: [GPUTextureContext, GPUTextureContext] | null;
  private readonly device: GPUDevice;

  lastRan = false;
  lastRawPasses = 0;
  lastSpatialPasses = 0;
  lastTemporalPasses = 0;
  lastCompositePasses = 0;
  lastBentNormalUpsamplePasses = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    readonly temporalEnabled = true,
    readonly resolutionScale: 0.5 | 1 = 1
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error(
        "ScreenSpaceAmbientOcclusionPass: GraphicsContext has no device"
      );
    }
    this.device = device;
    this.rawPipeline = createSsaoRawPipelineDescriptor();
    this.spatialPipeline = createSsaoSpatialPipelineDescriptor();
    this.temporalPipeline = createSsaoTemporalPipelineDescriptor();
    this.compositePipeline = createSsaoCompositePipelineDescriptor();
    this.bentNormalUpsamplePipeline = createSsaoBentNormalUpsamplePipelineDescriptor();
    const descriptor: GPUTextureDescriptor = {
      label: "SSAO history",
      size: [1, 1, 1],
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    };
    this.histories = temporalEnabled
      ? [
          new GPUTextureContext(device, { ...descriptor, label: "SSAO history 0" }),
          new GPUTextureContext(device, { ...descriptor, label: "SSAO history 1" })
        ]
      : null;
  }

  init(): void {
    if (this.rawSettingsBuffer !== null) return;
    this.rawSettingsBuffer = this.device.createBuffer({
      label: "Renderer/SSAO raw settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.spatialSettingsBuffer = this.device.createBuffer({
      label: "Renderer/SSAO spatial settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    writeGpuBuffer(
      this.device.queue,
      "SSAO/spatial-settings",
      this.spatialSettingsBuffer,
      0,
      new Int32Array([1, 0, 0, 0])
    );
    this.hilbertView = this.graphics.textures
      .obtain(HILBERT_NOISE_TEXTURE)
      .obtainView();
  }

  addToGraph(
    graph: FrameGraph,
    job: ScreenSpaceAmbientOcclusionJob,
    inputs: ScreenSpaceAmbientOcclusionInputs,
    historyBindings?: { readonly input: unknown; readonly output: unknown }
  ): ScreenSpaceAmbientOcclusionOutput {
    this.init();
    this.resetFrameEvidence();
    const fullWidth = Math.max(1, job.width | 0);
    const fullHeight = Math.max(1, job.height | 0);
    const width = Math.max(1, Math.ceil(fullWidth * this.resolutionScale));
    const height = Math.max(1, Math.ceil(fullHeight * this.resolutionScale));
    this.resize(width, height);

    if (this.temporalEnabled && historyBindings === undefined) {
      throw new Error("SSAO temporal history bindings are required");
    }

    let rawVisibility = -1;
    let bentNormals = -1;
    const self = this;
    const rawBuilder = graph.add(
      "SSAO raw GTAO lD",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeRaw(command, data.frameIndex, {
          visibility: resolveTextureView(resources.get(rawVisibility)),
          bentNormals: resolveTextureView(resources.get(bentNormals)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          normal: resolveTextureView(resources.get(inputs.normal)),
          camera: resolveBuffer(resources.get(inputs.camera), "SSAO camera")
        });
        self.lastRawPasses = 1;
      }
    );
    rawVisibility = rawBuilder.create("SSAO raw visibility", {
      kind: "transient_texture",
      label: "SSAO raw visibility lD",
      width,
      height,
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    bentNormals = rawBuilder.create("SSAO bent normals", {
      kind: "transient_texture",
      label: "SSAO bent normals lD",
      width,
      height,
      format: SSAO_BENT_NORMAL_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    rawBuilder.read(inputs.depth);
    rawBuilder.read(inputs.normal);
    rawBuilder.read(inputs.camera);

    let spatialVisibility = -1;
    const spatialBuilder = graph.add(
      "SSAO spatial filter XC",
      {},
      (_data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeSpatial(command, {
          output: resolveTextureView(resources.get(spatialVisibility)),
          visibility: resolveTextureView(resources.get(rawVisibility)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          normal: resolveTextureView(resources.get(inputs.normal))
        });
        self.lastSpatialPasses = 1;
      }
    );
    spatialVisibility = spatialBuilder.create("SSAO filtered visibility", {
      kind: "transient_texture",
      label: "SSAO filtered visibility XC",
      width,
      height,
      format: SSAO_VISIBILITY_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    spatialBuilder.read(rawVisibility);
    spatialBuilder.read(inputs.depth);
    spatialBuilder.read(inputs.normal);

    let resolvedVisibility = spatialVisibility;
    if (this.temporalEnabled) {
      const historyInputResource = graph.import_resource(
        "ao_history",
        { kind: "imported", label: "ao_history" },
        historyBindings!.input
      );
      const historyOutputResource = graph.import_resource(
        "ao_output",
        { kind: "imported", label: "ao_output" },
        historyBindings!.output
      );
      const temporalBuilder = graph.add(
        "SSAO temporal resolve ZC",
        job,
        (data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          self.executeTemporal(
            command,
            data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            data.historyValid,
            {
              output: resolveTextureView(resources.get(resolvedVisibility)),
              current: resolveTextureView(resources.get(spatialVisibility)),
              history: resolveTextureView(resources.get(historyInputResource)),
              velocity: resolveTextureView(resources.get(inputs.velocity)),
              occlusionConfidence: resolveTextureView(
                resources.get(inputs.occlusionConfidence)
              )
            }
          );
          self.lastTemporalPasses = 1;
        }
      );
      temporalBuilder.read(spatialVisibility);
      temporalBuilder.read(historyInputResource);
      temporalBuilder.read(inputs.velocity);
      temporalBuilder.read(inputs.occlusionConfidence);
      resolvedVisibility = temporalBuilder.write(historyOutputResource);
    }

    let resolvedBentNormals = bentNormals;
    if (this.resolutionScale < 1) {
      const bentNormalUpsampleBuilder = graph.add(
        "SSAO bent-normal upsample",
        {},
        (_data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          self.executeBentNormalUpsample(command, {
            output: resolveTextureView(resources.get(resolvedBentNormals)),
            source: resolveTextureView(resources.get(bentNormals))
          });
          self.lastBentNormalUpsamplePasses = 1;
        }
      );
      bentNormalUpsampleBuilder.read(bentNormals);
      resolvedBentNormals = bentNormalUpsampleBuilder.create("SSAO full-resolution bent normals", {
        kind: "transient_texture",
        label: "SSAO full-resolution bent normals",
        width: fullWidth,
        height: fullHeight,
        format: SSAO_BENT_NORMAL_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      });
    }

    let occlusion = -1;
    const compositeBuilder = graph.add(
      "SSAO alpha-min composite mD",
      {},
      (_data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        self.executeComposite(
          command,
          job.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          {
          output: resolveTextureView(resources.get(occlusion)),
          visibility: resolveTextureView(resources.get(resolvedVisibility))
          }
        );
        self.lastCompositePasses = 1;
      }
    );
    compositeBuilder.read(resolvedVisibility);
    occlusion = compositeBuilder.write(inputs.albedoAo);

    return {
      rawVisibility,
      denoisedVisibility: spatialVisibility,
      visibility: resolvedVisibility,
      occlusion,
      bentNormals: resolvedBentNormals
    };
  }

  historyTexture(index: 0 | 1): GPUTexture {
    if (this.histories === null) {
      throw new Error("SSAO temporal history is disabled");
    }
    return this.histories[index].gpu_texture;
  }

  resize(width: number, height: number): void {
    const resolvedWidth = Math.max(1, width | 0);
    const resolvedHeight = Math.max(1, height | 0);
    this.histories?.[0].resize(resolvedWidth, resolvedHeight);
    this.histories?.[1].resize(resolvedWidth, resolvedHeight);
  }

  get historyTextureCount(): number {
    return this.histories?.length ?? 0;
  }

  get historyBytes(): number {
    return this.histories?.reduce((sum, history) => sum + history.gpu_memory_usage, 0) ?? 0;
  }

  resetFrameEvidence(): void {
    this.lastRan = false;
    this.lastRawPasses = 0;
    this.lastSpatialPasses = 0;
    this.lastTemporalPasses = 0;
    this.lastCompositePasses = 0;
    this.lastBentNormalUpsamplePasses = 0;
  }

  private executeRaw(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    resources: {
      visibility: GPUTextureView;
      bentNormals: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
      camera: GPUBuffer;
    }
  ): void {
    if (
      this.rawSettingsBuffer === null ||
      this.hilbertView === null
    ) {
      throw new Error("ScreenSpaceAmbientOcclusionPass not initialized");
    }
    writeGpuBuffer(
      this.device.queue,
      "SSAO/raw-settings",
      this.rawSettingsBuffer,
      0,
      new Uint32Array([frameIndex >>> 0, 0, 0, 0])
    );
    const pass = command.constructRenderPass({
      label: "SSAO raw GTAO lD",
      pipeline: this.rawPipeline,
      bindings: [[
        resources.depth,
        resources.normal,
        this.hilbertView,
        { buffer: resources.camera },
        { buffer: this.rawSettingsBuffer }
      ]],
      colorAttachments: [
        {
          view: resources.visibility,
          clearValue: { r: 1, g: 1, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        },
        {
          view: resources.bentNormals,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeSpatial(
    command: ShadeGPUCommandContext,
    resources: {
      output: GPUTextureView;
      visibility: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
    }
  ): void {
    if (this.spatialSettingsBuffer === null) {
      throw new Error("ScreenSpaceAmbientOcclusionPass not initialized");
    }
    const pass = command.constructRenderPass({
      label: "SSAO spatial filter XC",
      pipeline: this.spatialPipeline,
      bindings: [
        [resources.visibility, resources.depth, resources.normal],
        [{ buffer: this.spatialSettingsBuffer }]
      ],
      colorAttachments: [
        {
          view: resources.output,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeTemporal(
    command: ShadeGPUCommandContext,
    sampler: GPUSampler,
    historyValid: boolean,
    resources: {
      output: GPUTextureView;
      current: GPUTextureView;
      history: GPUTextureView;
      velocity: GPUTextureView;
      occlusionConfidence: GPUTextureView;
    }
  ): void {
    const settings = command.allocateTransientBufferAndLoad(
      new Uint32Array([historyValid ? 1 : 0, 0, 0, 0]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "SSAO temporal resolve ZC",
      pipeline: this.temporalPipeline,
      bindings: [[
        resources.current,
        resources.velocity,
        resources.occlusionConfidence,
        resources.history,
        sampler,
        { buffer: settings }
      ]],
      colorAttachments: [
        {
          view: resources.output,
          clearValue: { r: 1, g: 1, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private executeComposite(
    command: ShadeGPUCommandContext,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      visibility: GPUTextureView;
    }
  ): void {
    const pass = command.constructRenderPass({
      label: "SSAO alpha-min composite mD",
      pipeline: this.compositePipeline,
      bindings: [[resources.visibility, sampler]],
      colorAttachments: [
        {
          view: resources.output,
          loadOp: "load",
          storeOp: "store"
        }
      ]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
  }

  private executeBentNormalUpsample(
    command: ShadeGPUCommandContext,
    resources: { output: GPUTextureView; source: GPUTextureView }
  ): void {
    const pass = command.constructRenderPass({
      label: "SSAO bent-normal upsample",
      pipeline: this.bentNormalUpsamplePipeline,
      bindings: [[resources.source]],
      colorAttachments: [{
        view: resources.output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  destroy(): void {
    this.rawSettingsBuffer?.destroy();
    this.rawSettingsBuffer = null;
    this.spatialSettingsBuffer?.destroy();
    this.spatialSettingsBuffer = null;
    this.hilbertView = null;
    this.histories?.[0].destroy();
    this.histories?.[1].destroy();
  }
}

function createSsaoRawPipelineDescriptor(): CachedRenderPipelineDescriptor {
  const label = "Renderer/SSAO raw lD";
  return createSsaoPipelineDescriptor(
    label,
    SSAO_RAW_WGSL,
    [createSsaoRawGroupLayout()],
    [
      {
        format: SSAO_VISIBILITY_FORMAT,
        blend: {
          color: { operation: "add", srcFactor: "one", dstFactor: "zero" },
          alpha: { operation: "add", srcFactor: "one", dstFactor: "zero" }
        }
      },
      { format: SSAO_BENT_NORMAL_FORMAT }
    ]
  );
}

function createSsaoSpatialPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO spatial XC",
    SSAO_SPATIAL_WGSL,
    [createSsaoSpatialTextureLayout(), createSsaoSpatialSettingsLayout()],
    [{ format: SSAO_VISIBILITY_FORMAT }]
  );
}

function createSsaoTemporalPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO temporal ZC",
    SSAO_TEMPORAL_WGSL,
    [createSsaoTemporalGroupLayout()],
    [{ format: SSAO_VISIBILITY_FORMAT }]
  );
}

function createSsaoCompositePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO alpha-min mD",
    SSAO_COMPOSITE_WGSL,
    [createSsaoCompositeGroupLayout()],
    [{
      format: SSAO_ALBEDO_AO_FORMAT,
      blend: {
        color: { operation: "add", srcFactor: "zero", dstFactor: "one" },
        alpha: { operation: "min", srcFactor: "one", dstFactor: "one" }
      }
    }]
  );
}

function createSsaoBentNormalUpsamplePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsaoPipelineDescriptor(
    "Renderer/SSAO bent-normal upsample",
    SSAO_BENT_NORMAL_UPSAMPLE_WGSL,
    [{
      label: "Renderer/SSAO bent-normal upsample group0",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "uint", viewDimension: "2d" }
      }]
    }],
    [{ format: SSAO_BENT_NORMAL_FORMAT }]
  );
}

function createSsaoPipelineDescriptor(
  label: string,
  code: string,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
  targets: readonly (GPUColorTargetState | null)[],
  depth = false
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts },
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets },
    primitive: { topology: "triangle-list", cullMode: "none" },
    ...(depth
      ? {
          depthStencil: {
            format: "depth32float" as GPUTextureFormat,
            depthWriteEnabled: false,
            depthCompare: "not-equal" as GPUCompareFunction
          }
        }
      : {})
  };
}

function createSsaoRawGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO raw lD group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 4, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsaoSpatialTextureLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO spatial XC group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsaoSpatialSettingsLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/SSAO spatial XC group1",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }]
  };
}

function createSsaoTemporalGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSAO temporal ZC group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 5, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsaoCompositeGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/SSAO alpha-min mD group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      }
    ]
  };
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("ScreenSpaceAmbientOcclusionPass: cached gD requires ShadeGPUCommandContext");
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (
    resource &&
    typeof resource === "object" &&
    "size" in resource &&
    "usage" in resource
  ) {
    return resource as GPUBuffer;
  }
  throw new Error(`ScreenSpaceAmbientOcclusionPass: expected GPUBuffer for ${label}`);
}
