/**
 * VelocityDebugPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  VELOCITY_DEBUG_FORMAT,
  VELOCITY_DEBUG_WGSL
} from "../../shaders/velocity_debug.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export class VelocityDebugPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("VelocityDebugPass: GraphicsContext has no device");
    }
    const module = { label: "Renderer/Velocity debug vL", code: VELOCITY_DEBUG_WGSL };
    this.pipeline = {
      label: "Renderer/Velocity debug vL",
      layout: {
        label: "Renderer/Velocity debug vL layout",
        bindGroupLayouts: [{
          label: "Renderer/Velocity debug vL group0",
          entries: [0, 1].map((binding) => ({
            binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "unfilterable-float" as const, viewDimension: "2d" as const }
          }))
        }]
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: VELOCITY_DEBUG_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  addToGraph(
    graph: FrameGraph,
    velocity: ResourceId,
    albedoAo: ResourceId,
    width: number,
    height: number
  ): ResourceId {
    let output = -1;
    const builder = graph.add("Velocity debug vL", {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      const pass = command.constructRenderPass({
        label: "Velocity debug vL",
        pipeline: this.pipeline,
        bindings: [[
          resolveTextureView(resources.get(velocity)),
          resolveTextureView(resources.get(albedoAo))
        ]],
        colorAttachments: [{
          view: resolveTextureView(resources.get(output)),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.draw(3, 1, 0, 0);
      pass.end();
    });
    builder.read(velocity);
    builder.read(albedoAo);
    output = builder.create("Velocity debug color", {
      kind: "transient_texture",
      label: "Velocity debug vL rgba8unorm",
      width,
      height,
      format: VELOCITY_DEBUG_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    return output;
  }

  destroy(): void {}
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
  throw new Error("VelocityDebugPass: cached vL requires ShadeGPUCommandContext");
}
