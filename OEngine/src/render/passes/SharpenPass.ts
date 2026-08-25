/**
 * SharpenPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  SHARPEN_FORMAT,
  SHARPEN_VERTEX_WGSL,
  SHARPEN_WGSL
} from "../../shaders/sharpen.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export class SharpenPass {
  private readonly pipelineDescriptor: CachedRenderPipelineDescriptor;

  constructor(private readonly graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("SharpenPass: GraphicsContext has no device");
    }
    const group0: GPUBindGroupLayoutDescriptor = {
      label: "Renderer/Sharpen XE group0",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" }
        }
      ]
    };
    const vertexModule = {
      label: "",
      code: SHARPEN_VERTEX_WGSL
    };
    const fragmentModule = {
      label: "",
      code: SHARPEN_WGSL
    };
    this.pipelineDescriptor = {
      label: "Renderer/Sharpen XE",
      layout: {
        label: "Renderer/Sharpen XE layout",
        bindGroupLayouts: [group0]
      },
      vertex: { module: vertexModule, entryPoint: "main" },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
        targets: [{ format: SHARPEN_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  addToGraph(graph: FrameGraph, input: ResourceId, width: number, height: number, sharpness = 0.8): ResourceId {
    let output = -1;
    const builder = graph.add("Sharpen XE", { sharpness }, (data, resources, context) => {
      const command = context.encoder;
      if (!isShadeCommandContext(command)) {
        throw new Error("SharpenPass: cached XE requires ShadeGPUCommandContext");
      }
      this.execute(
        command,
        data.sharpness,
        resolveTextureView(resources.get(input)),
        resolveTextureView(resources.get(output))
      );
    });
    output = builder.create("Sharpened color", { kind: "transient_texture", width, height, format: SHARPEN_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    builder.read(input);
    return output;
  }

  private execute(command: ShadeGPUCommandContext, sharpness: number, input: GPUTextureView, output: GPUTextureView): void {
    const settings = command.allocateTransientBufferAndLoad(
      new Float32Array([sharpness]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructRenderPass({
      pipeline: this.pipelineDescriptor,
      bindings: [[input, { buffer: settings }]],
      colorAttachments: [{
        view: output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  destroy(): void {}
}

function isShadeCommandContext(
  value: unknown
): value is ShadeGPUCommandContext {
  return Boolean(
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructRenderPass" in value
  );
}
