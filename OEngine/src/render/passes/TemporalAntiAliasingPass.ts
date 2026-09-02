import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import { TAA_FORMAT, TAA_VERTEX_WGSL, TAA_WGSL } from "../../shaders/taa.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export interface TemporalAntiAliasingInputs {
  readonly output: ResourceId;
  readonly currentColor: ResourceId;
  readonly historyColor: ResourceId;
  readonly velocity: ResourceId;
  readonly disocclusionConfidence: ResourceId;
  readonly classification: ResourceId;
  readonly depth: ResourceId;
}

export interface TemporalAntiAliasingJob {
  readonly jitter: readonly [number, number];
  readonly historyValidity: number;
  readonly internalResolution: readonly [number, number];
  readonly outputResolution: readonly [number, number];
  readonly samplers: GPUSamplerCache;
  readonly historyStrength: number;
  readonly varianceGamma: number;
  readonly minimumHistoryWeight: number;
  readonly maximumHistoryWeight: number;
  readonly historyLockStep: number;
  readonly reactiveThreshold: number;
  readonly disocclusionThreshold: number;
  readonly motionFadePixels: number;
}

export class TemporalAntiAliasingPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  lastRan = false;
  lastHistoryValidity = 0;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("TemporalAntiAliasingPass: GraphicsContext has no device");
    }
    this.pipeline = {
      label: "FX-06B Final TAA/TAAU resolve",
      layout: {
        label: "FX-06B Final TAA/TAAU resolve/layout",
        bindGroupLayouts: [createTaaGroupLayout()]
      },
      vertex: {
        module: { label: "FX-06 fullscreen triangle", code: TAA_VERTEX_WGSL },
        entryPoint: "main"
      },
      fragment: {
        module: { label: "FX-06B Final TAA/TAAU resolve", code: TAA_WGSL },
        entryPoint: "main",
        targets: [{ format: TAA_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  addToGraph(
    graph: FrameGraph,
    job: TemporalAntiAliasingJob,
    inputs: TemporalAntiAliasingInputs
  ): ResourceId {
    let output = -1;
    const builder = graph.add(
      "FX-06B Final TAA/TAAU resolve",
      job,
      (data, resources, context) => {
        this.execute(
          requireShadeCommandContext(context.encoder),
          data,
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          {
            output: resolveTextureView(resources.get(output)),
            currentColor: resolveTextureView(resources.get(inputs.currentColor)),
            historyColor: resolveTextureView(resources.get(inputs.historyColor)),
            velocity: resolveTextureView(resources.get(inputs.velocity)),
            disocclusionConfidence: resolveTextureView(
              resources.get(inputs.disocclusionConfidence)
            ),
            classification: resolveTextureView(resources.get(inputs.classification))
            ,depth: resolveTextureView(resources.get(inputs.depth))
          }
        );
      }
    );
    for (const input of [
      inputs.currentColor,
      inputs.historyColor,
      inputs.velocity,
      inputs.disocclusionConfidence,
      inputs.classification
      ,inputs.depth
    ]) builder.read(input);
    output = builder.write(inputs.output);
    return output;
  }

  resetFrameEvidence(): void {
    this.lastRan = false;
  }

  private execute(
    command: ShadeGPUCommandContext,
    job: TemporalAntiAliasingJob,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      currentColor: GPUTextureView;
      historyColor: GPUTextureView;
      velocity: GPUTextureView;
      disocclusionConfidence: GPUTextureView;
      classification: GPUTextureView;
      depth: GPUTextureView;
    }
  ): void {
    const settingsBuffer = command.allocateTransientBufferAndLoad(
      new Float32Array([
        job.historyValidity,
        Math.max(0, Math.min(1, job.historyStrength)),
        job.internalResolution[0],
        job.internalResolution[1],
        job.outputResolution[0],
        job.outputResolution[1],
        Math.max(0, Math.min(4, job.varianceGamma)),
        Math.max(0, Math.min(1, job.minimumHistoryWeight)),
        Math.max(0, Math.min(1, job.maximumHistoryWeight)),
        Math.max(0, Math.min(1, job.historyLockStep)),
        Math.max(0, Math.min(1, job.reactiveThreshold)),
        Math.max(0, Math.min(1, job.disocclusionThreshold)),
        Math.max(1, Math.min(1024, job.motionFadePixels)),
        0,
        0,
        0
      ]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "FX-06B Final TAA/TAAU resolve",
      pipeline: this.pipeline,
      bindings: [[
        sampler,
        resources.velocity,
        resources.historyColor,
        resources.currentColor,
        resources.disocclusionConfidence,
        resources.classification,
        resources.depth,
        { buffer: settingsBuffer }
      ]],
      colorAttachments: [{
        view: resources.output,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.lastRan = true;
    this.lastHistoryValidity = job.historyValidity;
  }

  destroy(): void {}
}

function createTaaGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "FX-06B Final TAA/TAAU resolve/group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
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
  ) return value as ShadeGPUCommandContext;
  throw new Error("TemporalAntiAliasingPass requires ShadeGPUCommandContext");
}
