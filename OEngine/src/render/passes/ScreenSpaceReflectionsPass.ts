/**
 * 屏幕空间反射阶段：沿深度层级追踪反射，并完成预过滤、去噪与合成。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext, textureMipLevelCount } from "../../gpu/GPUTextureContext.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  SSR_DENOISE_FORMAT,
  SSR_SPATIAL_WGSL,
  SSR_TEMPORAL_WGSL
} from "../../shaders/ssr_denoise.js";
import {
  SSR_PREFILTER_COPY_WGSL,
  SSR_PREFILTER_DEPTH_AWARE_WGSL,
  SSR_PREFILTER_DOWNSAMPLE_WGSL,
  SSR_PREFILTER_FORMAT
} from "../../shaders/ssr_prefilter.js";
import {
  SSR_RESOLVE_FORMAT,
  SSR_RESOLVE_WGSL
} from "../../shaders/ssr_resolve.js";
import { SSR_LPV_RESOLVE_WGSL } from "../../shaders/ssr_resolve_lpv.js";
import { SSR_TRACE_FORMAT, SSR_TRACE_WGSL } from "../../shaders/ssr_trace.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "./MaterialExpandPass.js";

export type ScreenSpaceReflectionsInputs = {
  depth: ResourceId;
  hzb: ResourceId;
  sceneColor: ResourceId;
  pbr: ResourceId;
  normal: ResourceId;
  velocity: ResourceId;
  occlusionConfidence: ResourceId;
  albedoAo: ResourceId;
  environment: ResourceId;
  blueNoise: ResourceId;
  currentCamera: ResourceId;
  previousCamera: ResourceId;
  lpv?: {
    atlasRadiance: ResourceId;
    atlasDepth: ResourceId;
    meshBvh: ResourceId;
    metadata: ResourceId;
    tetrahedra: ResourceId;
    probes: ResourceId;
  };
};

export type ScreenSpaceReflectionsOutput = {
  trace: ResourceId;
  denoised: ResourceId;
  denoised_1: ResourceId;
  reflections: ResourceId;
  historyConfidence: ResourceId;
};

export type ScreenSpaceReflectionsJob = {
  width: number;
  height: number;
  frameIndex: number;
  historyValid: boolean;
  historyInputIndex: 0 | 1;
  historyOutputIndex: 0 | 1;
  samplers: GPUSamplerCache;
  maxDistance: number;
  edgeFade: number;
};

export class ScreenSpaceReflectionsPass {
  private readonly tracePipeline: CachedRenderPipelineDescriptor;
  private readonly copyPipeline: CachedRenderPipelineDescriptor;
  private readonly depthAwarePipeline: CachedRenderPipelineDescriptor;
  private readonly downsamplePipeline: CachedRenderPipelineDescriptor;
  private readonly resolvePipeline: CachedRenderPipelineDescriptor;
  private readonly lpvResolvePipeline: CachedRenderPipelineDescriptor;
  private readonly spatialPipeline: CachedRenderPipelineDescriptor;
  private readonly temporalPipeline: CachedRenderPipelineDescriptor;
  private traceSettings: GPUBuffer | null = null;
  private resolveSettings: GPUBuffer | null = null;
  private temporalSettings: GPUBuffer | null = null;
  private readonly spatialSettings: GPUBuffer[] = [];
  private readonly histories: [GPUTextureContext, GPUTextureContext];
  private readonly device: GPUDevice;

  lastRan = false;
  lastTracePasses = 0;
  lastPrefilterPasses = 0;
  lastResolvePasses = 0;
  lastSpatialPasses = 0;
  lastTemporalPasses = 0;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("ScreenSpaceReflectionsPass: GraphicsContext has no device");
    }
    const device = graphics.device;
    this.device = device;
    this.tracePipeline = createSsrTracePipelineDescriptor();
    this.copyPipeline = createSsrCopyPipelineDescriptor();
    this.depthAwarePipeline = createSsrDepthAwarePipelineDescriptor();
    this.downsamplePipeline = createSsrDownsamplePipelineDescriptor();
    this.resolvePipeline = createSsrResolvePipelineDescriptor(false);
    this.lpvResolvePipeline = createSsrResolvePipelineDescriptor(true);
    this.spatialPipeline = createSsrSpatialPipelineDescriptor();
    this.temporalPipeline = createSsrTemporalPipelineDescriptor();
    const descriptor: GPUTextureDescriptor = {
      label: "SSR history",
      size: [1, 1, 1],
      format: SSR_DENOISE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    };
    this.histories = [
      new GPUTextureContext(device, { ...descriptor, label: "SSR history 0" }),
      new GPUTextureContext(device, { ...descriptor, label: "SSR history 1" })
    ];
  }

  init(): void {
    if (this.traceSettings !== null) return;
    this.traceSettings = this.device.createBuffer({
      label: "Renderer/SSR trace settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.resolveSettings = this.device.createBuffer({
      label: "Renderer/SSR resolve settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.temporalSettings = this.device.createBuffer({
      label: "Renderer/SSR temporal settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    for (const step of [1, 2, 4]) {
      const buffer = this.device.createBuffer({
        label: `Renderer/SSR spatial step ${step}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      writeGpuBuffer(
        this.device.queue,
        "SSR/spatial-settings",
        buffer,
        0,
        new Int32Array([step, 0, 0, 0])
      );
      this.spatialSettings.push(buffer);
    }
  }

  addToGraph(
    graph: FrameGraph,
    job: ScreenSpaceReflectionsJob,
    inputs: ScreenSpaceReflectionsInputs,
    historyBindings?: { readonly input: unknown; readonly output: unknown }
  ): ScreenSpaceReflectionsOutput {
    this.init();
    this.resetFrameEvidence();
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    this.resize(width, height);
    if (!historyBindings) {
      throw new Error("SSR temporal history bindings are required");
    }
    const historyInputResource = graph.import_resource(
      "ssr_history",
      { kind: "imported", label: "ssr_history" },
      historyBindings.input
    );
    const historyOutputResource = graph.import_resource(
      "ssr_output",
      { kind: "imported", label: "ssr_output" },
      historyBindings.output
    );

    let trace = -1;
    const traceBuilder = graph.add(
      "SSR trace uk",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeTrace(command, data.frameIndex, data.maxDistance, data.edgeFade, {
          output: resolveTextureView(resources.get(trace)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          hzb: resolveTextureView(resources.get(inputs.hzb)),
          pbr: resolveTextureView(resources.get(inputs.pbr)),
          normal: resolveTextureView(resources.get(inputs.normal)),
          blueNoise: resolveTextureView(resources.get(inputs.blueNoise)),
          currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera")
        });
        this.lastRan = true;
        this.lastTracePasses = 1;
      }
    );
    trace = traceBuilder.create("SSR packed hit", {
      kind: "transient_texture",
      label: "SSR trace uk rg32uint",
      width,
      height,
      format: SSR_TRACE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    for (const input of [inputs.depth, inputs.hzb, inputs.pbr, inputs.normal, inputs.blueNoise, inputs.currentCamera]) {
      traceBuilder.read(input);
    }

    let prefiltered = -1;
    const mipLevelCount = textureMipLevelCount(width, height);
    const prefilterBuilder = graph.add(
      "SSR scene-color prefilter sQ/dQ/oQ",
      { samplers: job.samplers, mipLevelCount },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executePrefilter(
          command,
          resolveTexture(resources.get(prefiltered), "prefiltered scene color"),
          data.mipLevelCount,
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          {
            sceneColor: resolveTextureView(resources.get(inputs.sceneColor)),
            depth: resolveDepthAttachmentView(resources.get(inputs.depth))
          }
        );
        this.lastPrefilterPasses = 1;
      }
    );
    prefiltered = prefilterBuilder.create("prefiltered color", {
      kind: "transient_texture",
      label: "SSR prefiltered color",
      width,
      height,
      format: SSR_PREFILTER_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount
    });
    prefilterBuilder.read(inputs.sceneColor);
    prefilterBuilder.read(inputs.depth);

    let reflections = -1;
    const resolveBuilder = graph.add(
      "SSR reflection resolve QD",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeResolve(
          command,
          data.frameIndex,
          data.samplers.obtain({
            magFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge"
          }),
          {
            output: resolveTextureView(resources.get(reflections)),
            trace: resolveTextureView(resources.get(trace)),
            depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
            pbr: resolveTextureView(resources.get(inputs.pbr)),
            normal: resolveTextureView(resources.get(inputs.normal)),
            prefiltered: resolveTextureView(resources.get(prefiltered)),
            albedoAo: resolveTextureView(resources.get(inputs.albedoAo)),
            environment: resolveTextureView(resources.get(inputs.environment)),
            currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera"),
            lpv: inputs.lpv
              ? {
                  atlasRadiance: resolveTextureView(resources.get(inputs.lpv.atlasRadiance)),
                  atlasDepth: resolveTextureView(resources.get(inputs.lpv.atlasDepth)),
                  meshBvh: resolveBuffer(resources.get(inputs.lpv.meshBvh), "LPV mesh BVH"),
                  metadata: resolveBuffer(resources.get(inputs.lpv.metadata), "LPV metadata"),
                  tetrahedra: resolveBuffer(resources.get(inputs.lpv.tetrahedra), "LPV tetrahedra"),
                  probes: resolveBuffer(resources.get(inputs.lpv.probes), "LPV probes")
                }
              : undefined
          }
        );
        this.lastResolvePasses = 1;
      }
    );
    reflections = resolveBuilder.create("SSR reflections", textureDescriptor(width, height, SSR_RESOLVE_FORMAT));
    for (const input of [trace, inputs.depth, inputs.pbr, inputs.normal, prefiltered, inputs.albedoAo, inputs.environment, inputs.currentCamera]) {
      resolveBuilder.read(input);
    }
    if (inputs.lpv) {
      for (const input of [
        inputs.lpv.atlasRadiance,
        inputs.lpv.atlasDepth,
        inputs.lpv.meshBvh,
        inputs.lpv.metadata,
        inputs.lpv.tetrahedra,
        inputs.lpv.probes
      ]) {
        resolveBuilder.read(input);
      }
    }

    const denoised1 = this.addSpatial(graph, reflections, inputs.depth, inputs.normal, width, height, 0, "SSR spatial OQ step 1");

    let temporal = -1;
    const temporalBuilder = graph.add(
      "SSR temporal jQ",
      { samplers: job.samplers, historyValid: job.historyValid },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeTemporal(
          command,
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          data.historyValid,
          {
            output: resolveTextureView(resources.get(temporal)),
            current: resolveTextureView(resources.get(denoised1)),
            history: resolveTextureView(resources.get(historyInputResource)),
            velocity: resolveTextureView(resources.get(inputs.velocity)),
            occlusionConfidence: resolveTextureView(resources.get(inputs.occlusionConfidence)),
            currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera"),
            previousCamera: resolveBuffer(resources.get(inputs.previousCamera), "previous camera")
          }
        );
        this.lastTemporalPasses = 1;
      }
    );
    for (const input of [denoised1, historyInputResource, inputs.velocity, inputs.occlusionConfidence, inputs.currentCamera, inputs.previousCamera]) {
      temporalBuilder.read(input);
    }
    temporal = temporalBuilder.write(historyOutputResource);

    const denoised2 = this.addSpatial(graph, temporal, inputs.depth, inputs.normal, width, height, 1, "SSR spatial OQ step 2");
    const denoised = this.addSpatial(graph, denoised2, inputs.depth, inputs.normal, width, height, 2, "SSR spatial OQ step 4");

    return {
      trace,
      denoised,
      denoised_1: denoised1,
      reflections,
      historyConfidence: inputs.occlusionConfidence
    };
  }

  historyTexture(index: 0 | 1): GPUTexture {
    return this.histories[index]!.gpu_texture;
  }

  resize(width: number, height: number): void {
    this.histories[0].resize(width, height);
    this.histories[1].resize(width, height);
  }

  get historyTextureCount(): number {
    return this.histories.length;
  }

  get historyBytes(): number {
    return this.histories.reduce((sum, history) => sum + history.gpu_memory_usage, 0);
  }

  resetFrameEvidence(): void {
    this.lastRan = false;
    this.lastTracePasses = 0;
    this.lastPrefilterPasses = 0;
    this.lastResolvePasses = 0;
    this.lastSpatialPasses = 0;
    this.lastTemporalPasses = 0;
  }

  private addSpatial(
    graph: FrameGraph,
    input: ResourceId,
    depth: ResourceId,
    normal: ResourceId,
    width: number,
    height: number,
    settingsIndex: number,
    label: string
  ): ResourceId {
    let output = -1;
    const builder = graph.add(label, {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.executeSpatial(command, settingsIndex, {
        output: resolveTextureView(resources.get(output)),
        input: resolveTextureView(resources.get(input)),
        depth: resolveTextureView(resources.get(depth)),
        normal: resolveTextureView(resources.get(normal))
      });
      this.lastSpatialPasses++;
    });
    output = builder.create(label, textureDescriptor(width, height, SSR_DENOISE_FORMAT));
    builder.read(input);
    builder.read(depth);
    builder.read(normal);
    return output;
  }

  private executeTrace(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    maxDistance: number,
    edgeFade: number,
    resources: {
      output: GPUTextureView;
      depth: GPUTextureView;
      hzb: GPUTextureView;
      pbr: GPUTextureView;
      normal: GPUTextureView;
      blueNoise: GPUTextureView;
      currentCamera: GPUBuffer;
    }
  ): void {
    if (!this.traceSettings) throw new Error("SSR trace is not initialized");
    const data = new ArrayBuffer(16);
    const view = new DataView(data);
    view.setFloat32(0, Math.max(0.01, maxDistance), true);
    view.setUint32(4, frameIndex >>> 0, true);
    view.setFloat32(8, Math.max(0, Math.min(0.5, edgeFade)), true);
    writeGpuBuffer(
      this.device.queue,
      "SSR/trace-settings",
      this.traceSettings,
      0,
      data
    );
    drawFullscreen(
      command,
      "SSR trace uk",
      this.tracePipeline,
      [[
        { buffer: this.traceSettings },
        { buffer: resources.currentCamera },
        resources.blueNoise,
        resources.depth,
        resources.hzb,
        resources.pbr,
        resources.normal
      ]],
      resources.output,
      resources.depth
    );
  }

  private executePrefilter(
    command: ShadeGPUCommandContext,
    output: GPUTexture,
    mipLevelCount: number,
    sampler: GPUSampler,
    resources: { sceneColor: GPUTextureView; depth: GPUTextureView }
  ): void {
    const mip0 = createNativeTextureView(output, {
      baseMipLevel: 0,
      mipLevelCount: 1
    });
    drawFullscreen(
      command,
      "SSR prefilter copy sQ",
      this.copyPipeline,
      [[resources.sceneColor]],
      mip0
    );
    if (mipLevelCount <= 1) return;
    let source = mip0;
    let destination = createNativeTextureView(output, {
      baseMipLevel: 1,
      mipLevelCount: 1
    });
    drawFullscreen(
      command,
      "SSR prefilter depth-aware dQ",
      this.depthAwarePipeline,
      [[source, resources.depth, sampler]],
      destination,
      undefined,
      "load"
    );
    const lastMip = Math.min(4, mipLevelCount - 1);
    for (let mip = 2; mip <= lastMip; mip++) {
      source = destination;
      destination = createNativeTextureView(output, {
        baseMipLevel: mip,
        mipLevelCount: 1
      });
      drawFullscreen(
        command,
        `SSR prefilter mip oQ ${mip}`,
        this.downsamplePipeline,
        [[source, sampler]],
        destination,
        undefined,
        "load"
      );
    }
  }

  private executeResolve(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      trace: GPUTextureView;
      depth: GPUTextureView;
      pbr: GPUTextureView;
      normal: GPUTextureView;
      prefiltered: GPUTextureView;
      albedoAo: GPUTextureView;
      environment: GPUTextureView;
      currentCamera: GPUBuffer;
      lpv?: {
        atlasRadiance: GPUTextureView;
        atlasDepth: GPUTextureView;
        meshBvh: GPUBuffer;
        metadata: GPUBuffer;
        tetrahedra: GPUBuffer;
        probes: GPUBuffer;
      };
    }
  ): void {
    const pipeline = resources.lpv ? this.lpvResolvePipeline : this.resolvePipeline;
    if (!this.resolveSettings) throw new Error("SSR resolve is not initialized");
    writeGpuBuffer(
      this.device.queue,
      "SSR/resolve-settings",
      this.resolveSettings,
      0,
      new Uint32Array([frameIndex >>> 0, 0, 0, 0])
    );
    const bindings: GPUBindingResource[][] = [[
      resources.trace,
      resources.depth,
      resources.pbr,
      resources.normal,
      resources.prefiltered,
      resources.albedoAo,
      resources.environment,
      sampler,
      { buffer: this.resolveSettings },
      { buffer: resources.currentCamera }
    ]];
    if (resources.lpv) {
      bindings.push(
        [
          { buffer: resources.lpv.meshBvh },
          { buffer: resources.lpv.metadata },
          { buffer: resources.lpv.tetrahedra },
          { buffer: resources.lpv.probes }
        ],
        [resources.lpv.atlasRadiance, resources.lpv.atlasDepth]
      );
    }
    drawFullscreen(
      command,
      resources.lpv ? "SSR reflection resolve VD" : "SSR reflection resolve QD",
      pipeline,
      bindings,
      resources.output,
      resources.depth,
      "clear"
    );
  }

  private executeSpatial(
    command: ShadeGPUCommandContext,
    settingsIndex: number,
    resources: { output: GPUTextureView; input: GPUTextureView; depth: GPUTextureView; normal: GPUTextureView }
  ): void {
    const settings = this.spatialSettings[settingsIndex];
    if (!settings) throw new Error("SSR spatial settings are unavailable");
    drawFullscreen(
      command,
      "SSR spatial OQ",
      this.spatialPipeline,
      [[resources.input, resources.depth, resources.normal, { buffer: settings }]],
      resources.output
    );
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
      currentCamera: GPUBuffer;
      previousCamera: GPUBuffer;
    }
  ): void {
    if (!this.temporalSettings) throw new Error("SSR temporal settings are unavailable");
    writeGpuBuffer(
      this.device.queue,
      "SSR/temporal-settings",
      this.temporalSettings,
      0,
      new Uint32Array([historyValid ? 1 : 0, 0, 0, 0])
    );
    drawFullscreen(
      command,
      "SSR temporal jQ",
      this.temporalPipeline,
      [[
        resources.current,
        resources.velocity,
        resources.occlusionConfidence,
        resources.history,
        sampler,
        { buffer: resources.currentCamera },
        { buffer: resources.previousCamera },
        { buffer: this.temporalSettings }
      ]],
      resources.output
    );
  }

  destroy(): void {
    this.traceSettings?.destroy();
    this.resolveSettings?.destroy();
    this.temporalSettings?.destroy();
    for (const buffer of this.spatialSettings) buffer.destroy();
    this.spatialSettings.length = 0;
    this.histories[0].destroy();
    this.histories[1].destroy();
    this.traceSettings = null;
    this.resolveSettings = null;
    this.temporalSettings = null;
  }
}

function textureDescriptor(width: number, height: number, format: GPUTextureFormat) {
  return {
    kind: "transient_texture" as const,
    label: format,
    width,
    height,
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
  };
}

function resolveTexture(resource: unknown, label: string): GPUTexture {
  if (resource && typeof resource === "object" && "createView" in resource) {
    return resource as GPUTexture;
  }
  throw new Error(`ScreenSpaceReflectionsPass: missing ${label} texture`);
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object") return buffer as GPUBuffer;
    }
  }
  throw new Error(`ScreenSpaceReflectionsPass: missing ${label} buffer`);
}

function drawFullscreen(
  command: ShadeGPUCommandContext,
  label: string,
  pipeline: CachedRenderPipelineDescriptor,
  bindings: GPUBindingResource[][],
  output: GPUTextureView,
  depth?: GPUTextureView,
  loadOp: GPULoadOp = "clear"
): void {
  const pass = command.constructRenderPass({
    label,
    pipeline,
    bindings,
    colorAttachments: [
      {
        view: output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp,
        storeOp: "store"
      }
    ],
    ...(depth
      ? { depthStencilAttachment: { view: depth, depthReadOnly: true } }
      : {})
  });
  pass.draw(3, 1, 0, 0);
  pass.end();
}

function createSsrTracePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR trace uk",
    SSR_TRACE_WGSL,
    SSR_TRACE_FORMAT,
    [createSsrTraceGroupLayout()],
    true
  );
}

function createSsrCopyPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR prefilter copy sQ",
    SSR_PREFILTER_COPY_WGSL,
    SSR_PREFILTER_FORMAT,
    [createSsrCopyGroupLayout()]
  );
}

function createSsrDepthAwarePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR prefilter depth-aware dQ",
    SSR_PREFILTER_DEPTH_AWARE_WGSL,
    SSR_PREFILTER_FORMAT,
    [createSsrDepthAwareGroupLayout()]
  );
}

function createSsrDownsamplePipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR prefilter mip oQ",
    SSR_PREFILTER_DOWNSAMPLE_WGSL,
    SSR_PREFILTER_FORMAT,
    [createSsrDownsampleGroupLayout()]
  );
}

function createSsrResolvePipelineDescriptor(
  lpv: boolean
): CachedRenderPipelineDescriptor {
  const label = lpv
    ? "Renderer/SSR reflection resolve VD"
    : "Renderer/SSR reflection resolve QD";
  return createSsrPipelineDescriptor(
    label,
    lpv ? SSR_LPV_RESOLVE_WGSL : SSR_RESOLVE_WGSL,
    SSR_RESOLVE_FORMAT,
    lpv
      ? [
          createSsrResolveGroupLayout(),
          createSsrLpvBufferGroupLayout(),
          createSsrLpvAtlasGroupLayout()
        ]
      : [createSsrResolveGroupLayout()],
    true
  );
}

function createSsrSpatialPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR spatial OQ",
    SSR_SPATIAL_WGSL,
    SSR_DENOISE_FORMAT,
    [createSsrSpatialGroupLayout()]
  );
}

function createSsrTemporalPipelineDescriptor(): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR temporal jQ",
    SSR_TEMPORAL_WGSL,
    SSR_DENOISE_FORMAT,
    [createSsrTemporalGroupLayout()]
  );
}

function createSsrPipelineDescriptor(
  label: string,
  code: string,
  format: GPUTextureFormat,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
  depth = false
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts },
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
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

function createSsrTraceGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR trace uk group0",
    entries: [
      { binding: 0, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 1, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 5, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 6, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsrCopyGroupLayout(): GPUBindGroupLayoutDescriptor {
  return textureGroupLayout(
    "Renderer/SSR prefilter copy sQ group0",
    [{ sampleType: "unfilterable-float", viewDimension: "2d" }]
  );
}

function createSsrDepthAwareGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR prefilter depth-aware dQ group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, sampler: { type: "filtering" } }
    ]
  };
}

function createSsrDownsampleGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR prefilter mip oQ group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, sampler: { type: "filtering" } }
    ]
  };
}

function createSsrResolveGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR reflection resolve group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 5, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 6, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 7, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 8, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 9, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsrLpvBufferGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR reflection resolve VD group1",
    entries: [
      { binding: 0, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 2, visibility: fragment, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: fragment, buffer: { type: "read-only-storage" } }
    ]
  };
}

function createSsrLpvAtlasGroupLayout(): GPUBindGroupLayoutDescriptor {
  return textureGroupLayout(
    "Renderer/SSR reflection resolve VD group2",
    [
      { sampleType: "uint", viewDimension: "2d" },
      { sampleType: "float", viewDimension: "2d" }
    ]
  );
}

function createSsrSpatialGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR spatial OQ group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function createSsrTemporalGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR temporal jQ group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 5, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 6, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 7, visibility: fragment, buffer: { type: "uniform" } }
    ]
  };
}

function textureGroupLayout(
  label: string,
  textures: readonly GPUTextureBindingLayout[]
): GPUBindGroupLayoutDescriptor {
  return {
    label,
    entries: textures.map((texture, binding) => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture
    }))
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
  throw new Error("ScreenSpaceReflectionsPass: cached lk requires ShadeGPUCommandContext");
}
