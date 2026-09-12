/**
 * Three.js r186-derived stochastic SSR chain adapted to OEngine HZB,
 * FrameGraph, pre-exposure, submission-aware history and baseline replacement.
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  counterByteOffset,
  GPU_COUNTER_BYTE_SIZE
} from "../../debug/GpuFrameCounters.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile,
  gpuShadingSurfaceNormalPipelineConstants
} from "../../gpu/GpuComputeMaterialAbi.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import {
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  SSR_DENOISE_FORMAT,
  SSR_RECURRENT_DENOISE_WGSL,
  SSR_TEMPORAL_WGSL,
  SSR_UPSAMPLE_WGSL
} from "../../shaders/ssr_denoise.js";
import type { OpaqueColorPyramidFrame } from "../pipeline/FrameProducts.js";
import {
  SSR_RESOLVE_FORMAT,
  SSR_RESOLVE_WGSL
} from "../../shaders/ssr_resolve.js";
import { SSR_TRACE_FORMAT, SSR_TRACE_WGSL } from "../../shaders/ssr_trace.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

export type ScreenSpaceReflectionsInputs = {
  depth: ResourceId;
  hzb: ResourceId;
  opaqueColorPyramid: OpaqueColorPyramidFrame;
  pbr: ResourceId;
  normal: ResourceId;
  velocity: ResourceId;
  occlusionConfidence: ResourceId;
  surfaceValidity: ResourceId;
  albedoAo: ResourceId;
  blueNoise: ResourceId;
  currentCamera: ResourceId;
  counters?: ResourceId;
};

export type ScreenSpaceReflectionsOutput = {
  trace: ResourceId;
  denoised: ResourceId;
  denoised_1: ResourceId;
  temporal: ResourceId;
  reflections: ResourceId;
  historyConfidence: ResourceId;
  counters: ResourceId | null;
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
  maxSteps: number;
  baseThickness: number;
  distanceThicknessScale: number;
  maxRoughness: number;
  mirrorBias: number;
  temporalStrength: number;
  historyPreExposureScale: number;
};

export class ScreenSpaceReflectionsPass {
  private readonly tracePipeline: CachedRenderPipelineDescriptor;
  private readonly resolvePipeline: CachedRenderPipelineDescriptor;
  private readonly recurrentDenoisePipeline: CachedRenderPipelineDescriptor;
  private readonly temporalPipeline: CachedRenderPipelineDescriptor;
  private readonly upsamplePipeline: CachedRenderPipelineDescriptor;
  private traceSettings: GPUBuffer | null = null;
  private temporalSettings: GPUBuffer | null = null;
  private denoiseSettings: GPUBuffer | null = null;
  private readonly histories: GPUTextureContext[];
  private readonly device: GPUDevice;

  lastRan = false;
  lastTracePasses = 0;
  lastResolvePasses = 0;
  lastSpatialPasses = 0;
  lastTemporalPasses = 0;

  constructor(
    graphics: GraphicsContext,
    private readonly temporalEnabled = true,
    private readonly resolutionScale: 0.5 | 1 = 0.5,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    if (graphics.device === null) {
      throw new Error("ScreenSpaceReflectionsPass: GraphicsContext has no device");
    }
    const device = graphics.device;
    this.device = device;
    this.tracePipeline = createSsrTracePipelineDescriptor(surfaceProfile);
    this.resolvePipeline = createSsrResolvePipelineDescriptor(surfaceProfile);
    this.recurrentDenoisePipeline = createSsrRecurrentDenoisePipelineDescriptor(surfaceProfile);
    this.temporalPipeline = createSsrTemporalPipelineDescriptor(surfaceProfile);
    this.upsamplePipeline = createSsrUpsamplePipelineDescriptor(surfaceProfile);
    const descriptor: GPUTextureDescriptor = {
      label: "SSR history",
      size: [1, 1, 1],
      format: SSR_DENOISE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    };
    this.histories = temporalEnabled
      ? [0, 1].map((index) => new GPUTextureContext(
          device,
          { ...descriptor, label: `SSR history ${index}` },
          {
            accounting: graphics.resource_accounting,
            category: "history",
            owner: "ScreenSpaceReflectionsPass"
          }
        ))
      : [];
  }

  init(): void {
    if (this.traceSettings !== null) return;
    this.traceSettings = this.device.createBuffer({
      label: "Renderer/SSR trace settings",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.temporalSettings = this.device.createBuffer({
      label: "Renderer/SSR temporal settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.denoiseSettings = this.device.createBuffer({
      label: "Renderer/SSR recurrent denoise settings",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
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
    const traceWidth = Math.max(1, Math.ceil(width * this.resolutionScale));
    const traceHeight = Math.max(1, Math.ceil(height * this.resolutionScale));
    this.resize(traceWidth, traceHeight);
    if (this.temporalEnabled && !historyBindings) {
      throw new Error("SSR temporal history bindings are required");
    }
    const historyInputResource = this.temporalEnabled ? graph.import_resource(
      "ssr_history",
      {
        kind: "imported",
        label: "ssr_history",
        domain: this.resolutionScale === 0.5 ? "internal-half" : "internal-full"
      },
      historyBindings!.input
    ) : null;
    const historyOutputResource = this.temporalEnabled ? graph.import_resource(
      "ssr_output",
      {
        kind: "imported",
        label: "ssr_output",
        domain: this.resolutionScale === 0.5 ? "internal-half" : "internal-full"
      },
      historyBindings!.output
    ) : null;

    let trace = -1;
    const traceBuilder = graph.add(
      "SSR trace uk",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeTrace(
          command,
          data.frameIndex,
          data.maxDistance,
          data.edgeFade,
          data.maxSteps,
          data.baseThickness,
          data.distanceThicknessScale,
          data.maxRoughness,
          data.mirrorBias,
          {
          output: resolveTextureView(resources.get(trace)),
          depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
          hzb: resolveTextureView(resources.get(inputs.hzb)),
          pbr: resolveTextureView(resources.get(inputs.pbr)),
          normal: resolveTextureView(resources.get(inputs.normal)),
          blueNoise: resolveTextureView(resources.get(inputs.blueNoise)),
          currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera")
          }
        );
        this.lastRan = true;
        this.lastTracePasses = 1;
      }
    );
    trace = traceBuilder.create("SSR packed hit", {
      kind: "transient_texture",
      label: "SSR trace uk rg32uint",
      width: traceWidth,
      height: traceHeight,
      format: SSR_TRACE_FORMAT,
      domain: this.resolutionScale === 0.5 ? "internal-half" : "internal-full",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    for (const input of [inputs.depth, inputs.hzb, inputs.pbr, inputs.normal, inputs.blueNoise, inputs.currentCamera]) {
      traceBuilder.read(input);
    }

    let counters: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const evidenceBuilder = graph.add(
        "R5-Q00 SSR sampled trace evidence",
        { width: traceWidth, height: traceHeight },
        (data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          const pass = command.constructComputePass({
            label: "R5-Q00 SSR sampled trace evidence",
            pipeline: SSR_EVIDENCE_PIPELINE,
            bindings: [[
              resolveTextureView(resources.get(trace)),
              { buffer: requireBuffer(resources.get(inputs.counters!), "SSR counters") }
            ]]
          });
          pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8), 1);
          pass.end();
        }
      );
      evidenceBuilder.read(trace);
      evidenceBuilder.read(inputs.counters);
      counters = evidenceBuilder.write(inputs.counters);
      evidenceBuilder.make_side_effect();
    }

    let reflections = -1;
    const resolveBuilder = graph.add(
      "SSR stochastic hit shading",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.executeResolve(
          command,
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
            prefiltered: resolveTextureView(resources.get(inputs.opaqueColorPyramid.texture)),
            albedoAo: resolveTextureView(resources.get(inputs.albedoAo)),
            currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera"),
            blueNoise: resolveTextureView(resources.get(inputs.blueNoise))
          }
        );
        this.lastResolvePasses = 1;
      }
    );
    reflections = resolveBuilder.create(
      "SSR reflections",
      textureDescriptor(traceWidth, traceHeight, SSR_RESOLVE_FORMAT,
        this.resolutionScale === 0.5 ? "internal-half" : "internal-full")
    );
    for (const input of [trace, inputs.depth, inputs.pbr, inputs.normal, inputs.opaqueColorPyramid.texture, inputs.albedoAo, inputs.currentCamera, inputs.blueNoise]) {
      resolveBuilder.read(input);
    }

    let temporal = reflections;
    if (this.temporalEnabled) {
      const temporalBuilder = graph.add(
        "SSR temporal reproject",
        job,
        (data, resources, context) => {
          const command = requireShadeCommandContext(context.encoder);
          this.executeTemporal(
            command,
            data.historyValid,
            data.temporalStrength,
            {
              output: resolveTextureView(resources.get(temporal)),
              current: resolveTextureView(resources.get(reflections)),
              history: resolveTextureView(resources.get(historyInputResource!)),
              velocity: resolveTextureView(resources.get(inputs.velocity)),
              occlusionConfidence: resolveTextureView(resources.get(inputs.occlusionConfidence)),
              surfaceValidity: resolveTextureView(resources.get(inputs.surfaceValidity)),
              trace: resolveTextureView(resources.get(trace)),
              depth: resolveDepthAttachmentView(resources.get(inputs.depth)),
              normal: resolveTextureView(resources.get(inputs.normal)),
              historyPreExposureScale: data.historyPreExposureScale
            }
          );
          this.lastTemporalPasses = 1;
        }
      );
      for (const input of [reflections, historyInputResource!, inputs.velocity, inputs.occlusionConfidence, inputs.surfaceValidity, trace, inputs.depth, inputs.normal]) {
        temporalBuilder.read(input);
      }
      temporal = temporalBuilder.create(
        "SSR temporally reprojected specular",
        textureDescriptor(traceWidth, traceHeight, SSR_DENOISE_FORMAT,
          this.resolutionScale === 0.5 ? "internal-half" : "internal-full")
      );
    }

    const denoised1 = this.addRecurrentDenoise(
      graph,
      temporal,
      reflections,
      trace,
      inputs.depth,
      inputs.normal,
      inputs.pbr,
      inputs.currentCamera,
      traceWidth,
      traceHeight,
      job,
      historyOutputResource
    );

    const denoised = this.resolutionScale === 0.5
      ? this.addUpsample(graph, denoised1, inputs.depth, inputs.normal, width, height)
      : denoised1;

    return {
      trace,
      denoised,
      denoised_1: denoised1,
      temporal,
      reflections,
      historyConfidence: denoised,
      counters
    };
  }

  historyTexture(index: 0 | 1): GPUTexture {
    const history = this.histories[index];
    if (history === undefined) {
      throw new Error("SSR history requested while temporal reprojection is disabled");
    }
    return history.gpu_texture;
  }

  resize(width: number, height: number): void {
    for (const history of this.histories) history.resize(width, height);
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
    this.lastResolvePasses = 0;
    this.lastSpatialPasses = 0;
    this.lastTemporalPasses = 0;
  }

  private addRecurrentDenoise(
    graph: FrameGraph,
    temporal: ResourceId,
    raw: ResourceId,
    trace: ResourceId,
    depth: ResourceId,
    normal: ResourceId,
    pbr: ResourceId,
    camera: ResourceId,
    width: number,
    height: number,
    job: ScreenSpaceReflectionsJob,
    historyOutput: ResourceId | null
  ): ResourceId {
    const label = "SSR recurrent specular denoise";
    let output = -1;
    const builder = graph.add(label, job, (data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.executeRecurrentDenoise(
        command,
        data.frameIndex,
        data.temporalStrength,
        this.temporalEnabled,
        data.historyValid,
        {
          output: resolveTextureView(resources.get(output)),
          temporal: resolveTextureView(resources.get(temporal)),
          raw: resolveTextureView(resources.get(raw)),
          trace: resolveTextureView(resources.get(trace)),
          depth: resolveDepthAttachmentView(resources.get(depth)),
          normal: resolveTextureView(resources.get(normal)),
          pbr: resolveTextureView(resources.get(pbr)),
          camera: resolveBuffer(resources.get(camera), "current camera")
        }
      );
      this.lastSpatialPasses++;
    });
    output = historyOutput === null
      ? builder.create(label, textureDescriptor(width, height, SSR_DENOISE_FORMAT,
          this.resolutionScale === 0.5 ? "internal-half" : "internal-full"))
      : builder.write(historyOutput);
    builder.read(temporal);
    builder.read(raw);
    builder.read(trace);
    builder.read(depth);
    builder.read(normal);
    builder.read(pbr);
    builder.read(camera);
    return output;
  }

  private addUpsample(
    graph: FrameGraph,
    input: ResourceId,
    depth: ResourceId,
    normal: ResourceId,
    width: number,
    height: number
  ): ResourceId {
    let output = -1;
    const builder = graph.add(
      "SSR full-resolution joint bilateral upscale",
      {},
      (_data, resources, context) => {
        drawFullscreen(
          requireShadeCommandContext(context.encoder),
          "SSR full-resolution joint bilateral upscale",
          this.upsamplePipeline,
          [[
            resolveTextureView(resources.get(input)),
            resolveDepthAttachmentView(resources.get(depth)),
            resolveTextureView(resources.get(normal))
          ]],
          resolveTextureView(resources.get(output))
        );
      }
    );
    output = builder.create(
      "SSR full-resolution reflections",
      textureDescriptor(width, height, SSR_DENOISE_FORMAT, "internal-full")
    );
    builder.readDomain(input, "internal-full", "SSR joint bilateral upscale");
    builder.read(depth);
    builder.read(normal);
    builder.declareEncoderWork({ renderPasses: 1, draws: 1 });
    return output;
  }

  private executeTrace(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    maxDistance: number,
    edgeFade: number,
    maxSteps: number,
    baseThickness: number,
    distanceThicknessScale: number,
    maxRoughness: number,
    mirrorBias: number,
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
    const data = new ArrayBuffer(32);
    const view = new DataView(data);
    view.setFloat32(0, Math.max(0.01, maxDistance), true);
    view.setUint32(4, frameIndex >>> 0, true);
    view.setFloat32(8, Math.max(0, Math.min(0.5, edgeFade)), true);
    view.setUint32(12, Math.max(8, Math.min(255, Math.round(maxSteps))), true);
    view.setFloat32(16, Math.max(0.001, Math.min(2, baseThickness)), true);
    view.setFloat32(20, Math.max(0, Math.min(0.2, distanceThicknessScale)), true);
    view.setFloat32(24, Math.max(0, Math.min(1, maxRoughness)), true);
    view.setFloat32(28, Math.max(0, Math.min(1, mirrorBias)), true);
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
      resources.output
    );
  }

  private executeResolve(
    command: ShadeGPUCommandContext,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      trace: GPUTextureView;
      depth: GPUTextureView;
      pbr: GPUTextureView;
      normal: GPUTextureView;
      prefiltered: GPUTextureView;
      albedoAo: GPUTextureView;
      currentCamera: GPUBuffer;
      blueNoise: GPUTextureView;
    }
  ): void {
    if (!this.traceSettings) throw new Error("SSR trace settings unavailable during hit shading");
    const bindings: GPUBindingResource[][] = [[
      resources.trace,
      resources.depth,
      resources.pbr,
      resources.normal,
      resources.prefiltered,
      resources.albedoAo,
      sampler,
      { buffer: resources.currentCamera },
      resources.blueNoise,
      { buffer: this.traceSettings }
    ]];
    drawFullscreen(
      command,
      "SSR stochastic hit shading",
      this.resolvePipeline,
      bindings,
      resources.output
    );
  }

  private executeRecurrentDenoise(
    command: ShadeGPUCommandContext,
    frameIndex: number,
    strength: number,
    temporalEnabled: boolean,
    historyValid: boolean,
    resources: {
      output: GPUTextureView;
      temporal: GPUTextureView;
      raw: GPUTextureView;
      trace: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
      pbr: GPUTextureView;
      camera: GPUBuffer;
    }
  ): void {
    if (!this.denoiseSettings) throw new Error("SSR recurrent denoise settings are unavailable");
    const data = new ArrayBuffer(16);
    const view = new DataView(data);
    view.setUint32(0, frameIndex >>> 0, true);
    // Three r186 uses radius=5 with WORLD_RADIUS_SCALE=0.1. Fold that
    // compile-time scale into this OEngine uniform.
    view.setFloat32(4, 0.5, true);
    view.setFloat32(8, Math.max(0, Math.min(1, strength)), true);
    view.setUint32(12, (temporalEnabled ? 1 : 0) | (historyValid ? 2 : 0), true);
    writeGpuBuffer(this.device.queue, "SSR/recurrent-denoise-settings", this.denoiseSettings, 0, data);
    drawFullscreen(
      command,
      "SSR recurrent specular denoise",
      this.recurrentDenoisePipeline,
      [[
        resources.temporal,
        resources.raw,
        resources.depth,
        resources.normal,
        resources.pbr,
        { buffer: resources.camera },
        { buffer: this.denoiseSettings },
        resources.trace
      ]],
      resources.output
    );
  }

  private executeTemporal(
    command: ShadeGPUCommandContext,
    historyValid: boolean,
    temporalStrength: number,
    resources: {
      output: GPUTextureView;
      current: GPUTextureView;
      history: GPUTextureView;
      velocity: GPUTextureView;
      occlusionConfidence: GPUTextureView;
      surfaceValidity: GPUTextureView;
      trace: GPUTextureView;
      depth: GPUTextureView;
      normal: GPUTextureView;
      historyPreExposureScale: number;
    }
  ): void {
    if (!this.temporalSettings) throw new Error("SSR temporal settings are unavailable");
    writeGpuBuffer(
      this.device.queue,
      "SSR/temporal-settings",
      this.temporalSettings,
      0,
      (() => {
        const data = new ArrayBuffer(16);
        const view = new DataView(data);
        view.setUint32(0, historyValid && resources.historyPreExposureScale > 0 ? 1 : 0, true);
        view.setFloat32(4, Math.max(0, Math.min(1, temporalStrength)), true);
        view.setFloat32(8, 128, true);
        view.setFloat32(12, resources.historyPreExposureScale, true);
        return data;
      })()
    );
    drawFullscreen(
      command,
      "SSR temporal reproject",
      this.temporalPipeline,
      [[
        resources.current,
        resources.velocity,
        resources.occlusionConfidence,
        resources.history,
        { buffer: this.temporalSettings },
        resources.surfaceValidity,
        resources.trace,
        resources.depth,
        resources.normal
      ]],
      resources.output
    );
  }

  destroy(): void {
    this.traceSettings?.destroy();
    this.temporalSettings?.destroy();
    this.denoiseSettings?.destroy();
    for (const history of this.histories) history.destroy();
    this.traceSettings = null;
    this.temporalSettings = null;
    this.denoiseSettings = null;
  }
}

const SSR_TRACE_PIXEL_INDEX = counterByteOffset("ssrTracePixels") / 4;
const SSR_HIT_PIXEL_INDEX = counterByteOffset("ssrHitPixels") / 4;
const SSR_TRACE_STEP_INDEX = counterByteOffset("ssrTraceSteps") / 4;
const SSR_MAX_TRACE_STEP_INDEX = counterByteOffset("ssrMaxTraceSteps") / 4;
const SSR_HIGH_ROUGHNESS_TRACE_INDEX = counterByteOffset("ssrHighRoughnessTracePixels") / 4;
const SSR_DISTANCE_EXCEEDED_INDEX = counterByteOffset("ssrDistanceLimitExceededPixels") / 4;
const SSR_VALIDATION_REJECTED_INDEX = counterByteOffset("ssrValidationRejectedPixels") / 4;

export const SSR_EVIDENCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var trace_source: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(trace_source);
  if (any(id.xy >= dimensions)) { return; }
  let packed = textureLoad(trace_source, vec2i(id.xy), 0).y;
  let confidence = packed & 0xffu;
  let iterations = (packed >> 8u) & 0xffu;
  let outcome = (packed >> 16u) & 0xffu;
  if (outcome == 0u) { return; }
  atomicAdd(&counters[${SSR_TRACE_PIXEL_INDEX}u], 1u);
  atomicAdd(&counters[${SSR_TRACE_STEP_INDEX}u], iterations);
  atomicMax(&counters[${SSR_MAX_TRACE_STEP_INDEX}u], iterations);
  if (confidence > 0u && outcome == 3u) {
    atomicAdd(&counters[${SSR_HIT_PIXEL_INDEX}u], 1u);
  }
  if (outcome == 2u) {
    atomicAdd(&counters[${SSR_VALIDATION_REJECTED_INDEX}u], 1u);
  }
  if ((packed & (1u << 24u)) != 0u) {
    atomicAdd(&counters[${SSR_DISTANCE_EXCEEDED_INDEX}u], 1u);
  }
  if ((packed & (1u << 25u)) != 0u) {
    atomicAdd(&counters[${SSR_HIGH_ROUGHNESS_TRACE_INDEX}u], 1u);
  }
}
`;

const SSR_EVIDENCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "R5-Q00 SSR sampled trace evidence",
  layout: {
    label: "R5-Q00 SSR sampled trace evidence/layout",
    bindGroupLayouts: [{
      label: "R5-Q00 SSR sampled trace evidence/group0",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage", minBindingSize: GPU_COUNTER_BYTE_SIZE }
        }
      ]
    }]
  },
  compute: {
    module: { label: "R5-Q00 SSR sampled trace evidence", code: SSR_EVIDENCE_WGSL },
    entryPoint: "main"
  }
};

function textureDescriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
  domain?: "internal-full" | "internal-half"
) {
  return {
    kind: "transient_texture" as const,
    label: format,
    width,
    height,
    format,
    ...(domain === undefined ? {} : { domain }),
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
  };
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

function requireBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object" && "size" in resource && "usage" in resource) {
    return resource as GPUBuffer;
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

function createSsrTracePipelineDescriptor(
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR trace uk",
    SSR_TRACE_WGSL,
    SSR_TRACE_FORMAT,
    [createSsrTraceGroupLayout()],
    surfaceProfile
  );
}

function createSsrResolvePipelineDescriptor(
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  const label = "Renderer/SSR stochastic hit shading";
  return createSsrPipelineDescriptor(
    label,
    SSR_RESOLVE_WGSL,
    SSR_RESOLVE_FORMAT,
    [createSsrResolveGroupLayout()],
    surfaceProfile
  );
}

function createSsrRecurrentDenoisePipelineDescriptor(
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR recurrent specular denoise",
    SSR_RECURRENT_DENOISE_WGSL,
    SSR_DENOISE_FORMAT,
    [createSsrRecurrentDenoiseGroupLayout()],
    surfaceProfile
  );
}

function createSsrTemporalPipelineDescriptor(
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR temporal reproject",
    SSR_TEMPORAL_WGSL,
    SSR_DENOISE_FORMAT,
    [createSsrTemporalGroupLayout()],
    surfaceProfile
  );
}

function createSsrUpsamplePipelineDescriptor(
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  return createSsrPipelineDescriptor(
    "Renderer/SSR full-resolution joint bilateral upscale",
    SSR_UPSAMPLE_WGSL,
    SSR_DENOISE_FORMAT,
    [createSsrUpsampleGroupLayout()],
    surfaceProfile
  );
}

function createSsrPipelineDescriptor(
  label: string,
  code: string,
  format: GPUTextureFormat,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[],
  surfaceProfile: GpuShadingSurfaceLiteProfile,
  depth = false
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  const constants = code.includes("OENGINE_SURFACE_NORMAL_MAX_VALUE")
    ? gpuShadingSurfaceNormalPipelineConstants(surfaceProfile.normalEncoding)
    : undefined;
  return {
    label,
    layout: { label: `${label} layout`, bindGroupLayouts },
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      ...(constants === undefined ? {} : { constants }),
      targets: [{ format }]
    },
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
      { binding: 3, visibility: fragment, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 5, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 6, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsrResolveGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR reflection resolve group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 5, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 6, visibility: fragment, sampler: { type: "filtering" } },
      { binding: 7, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 8, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
      { binding: 9, visibility: fragment, buffer: { type: "uniform" } },
    ]
  };
}

function createSsrRecurrentDenoiseGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR recurrent specular denoise/group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 5, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 6, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 7, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsrTemporalGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR temporal reproject/group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } },
      { binding: 3, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 4, visibility: fragment, buffer: { type: "uniform" } },
      { binding: 5, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 6, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } },
      { binding: 7, visibility: fragment, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 8, visibility: fragment, texture: { sampleType: "uint", viewDimension: "2d" } }
    ]
  };
}

function createSsrUpsampleGroupLayout(): GPUBindGroupLayoutDescriptor {
  const fragment = GPUShaderStage.FRAGMENT;
  return {
    label: "Renderer/SSR full-resolution joint bilateral upscale/group0",
    entries: [
      { binding: 0, visibility: fragment, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: fragment, texture: { sampleType: "depth" } },
      { binding: 2, visibility: fragment, texture: { sampleType: "uint" } }
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
