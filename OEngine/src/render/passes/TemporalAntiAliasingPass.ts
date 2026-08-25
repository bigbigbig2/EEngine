/**
 * 时域抗锯齿阶段：结合运动矢量和历史颜色抑制锯齿与时域闪烁。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  type GPUSamplerCache
} from "../../gpu/GPUSamplerCache.js";
import {
  TAA_FORMAT,
  TAA_VERTEX_WGSL,
  TAA_WGSL
} from "../../shaders/taa.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export type TemporalAntiAliasingInputs = {
  output: ResourceId;
  currentColor: ResourceId;
  historyColor: ResourceId;
  velocity: ResourceId;
  occlusionConfidence: ResourceId;
  currentCamera: ResourceId;
  previousCamera: ResourceId;
};

export type TemporalAntiAliasingJob = {
  jitter: readonly [number, number];
  historyValidity: number;
  samplers: GPUSamplerCache;
};

export class TemporalAntiAliasingPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  lastRan = false;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("TemporalAntiAliasingPass: GraphicsContext has no device");
    }
    const vertexModule = {
      label: "",
      code: TAA_VERTEX_WGSL
    };
    const fragmentModule = {
      label: "",
      code: TAA_WGSL
    };
    this.pipeline = {
      label: "Renderer/TAA QQ",
      layout: {
        label: "Renderer/TAA QQ layout",
        bindGroupLayouts: [createTaaGroupLayout()]
      },
      vertex: { module: vertexModule, entryPoint: "main" },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
        targets: [{ format: TAA_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  init(): void {}

  addToGraph(
    graph: FrameGraph,
    job: TemporalAntiAliasingJob,
    inputs: TemporalAntiAliasingInputs
  ): ResourceId {
    this.init();
    let output = -1;
    const builder = graph.add(
      "Temporal anti-aliasing QQ",
      job,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.execute(
          command,
          data.jitter,
          data.historyValidity,
          data.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
          {
            output: resolveTextureView(resources.get(output)),
            currentColor: resolveTextureView(resources.get(inputs.currentColor)),
            historyColor: resolveTextureView(resources.get(inputs.historyColor)),
            velocity: resolveTextureView(resources.get(inputs.velocity)),
            occlusionConfidence: resolveTextureView(resources.get(inputs.occlusionConfidence)),
            currentCamera: resolveBuffer(resources.get(inputs.currentCamera), "current camera"),
            previousCamera: resolveBuffer(resources.get(inputs.previousCamera), "previous camera")
          }
        );
      }
    );
    for (const input of [
      inputs.currentColor,
      inputs.historyColor,
      inputs.velocity,
      inputs.occlusionConfidence,
      inputs.currentCamera,
      inputs.previousCamera
    ]) {
      builder.read(input);
    }
    output = builder.write(inputs.output);
    return output;
  }

  private execute(
    command: ShadeGPUCommandContext,
    jitter: readonly [number, number],
    historyValidity: number,
    sampler: GPUSampler,
    resources: {
      output: GPUTextureView;
      currentColor: GPUTextureView;
      historyColor: GPUTextureView;
      velocity: GPUTextureView;
      occlusionConfidence: GPUTextureView;
      currentCamera: GPUBuffer;
      previousCamera: GPUBuffer;
    }
  ): void {
    const settingsBuffer = command.allocateTransientBufferAndLoad(
      new Float32Array([
        jitter[0],
        jitter[1],
        historyValidity,
        0
      ]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      label: "Temporal anti-aliasing QQ",
      pipeline: this.pipeline,
      bindings: [[
        sampler,
        resources.velocity,
        resources.historyColor,
        resources.currentColor,
        resources.occlusionConfidence,
        { buffer: resources.currentCamera },
        { buffer: resources.previousCamera },
        { buffer: settingsBuffer }
      ]],
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
    this.lastRan = true;
  }

  destroy(): void {}
}

function createTaaGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/TAA QQ group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      },
      {
        binding: 7,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
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
  throw new Error("TemporalAntiAliasingPass: cached QQ requires ShadeGPUCommandContext");
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object") return buffer as GPUBuffer;
    }
  }
  throw new Error(`TemporalAntiAliasingPass: missing ${label} buffer`);
}
