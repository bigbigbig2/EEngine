import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GPU_VISIBILITY_KEY_EMPTY } from "../../gpu/GpuVisibilityKeyAbi.js";
import { resolveTextureView } from "../RenderTargetViews.js";

/** Phase 1 output: visualize the GPU-authored VisibilityKey without a material resolve. */
export class VisibilityPresentPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly bindingLayout: GPUBindGroupLayout;

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    this.bindingLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ] });
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var visibility: texture_2d<u32>;
      @group(0) @binding(1) var<uniform> outputSize: vec2u;
      struct VertexOut { @builtin(position) position: vec4f, };
      @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
        var out: VertexOut;
        out.position = vec4f(f32((index << 1u) & 2u) * 2.0 - 1.0,
                             f32(index & 2u) * 2.0 - 1.0, 0.0, 1.0);
        return out;
      }
      @fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
        let sourceSize = textureDimensions(visibility);
        let texel = min(vec2u(position.xy) * sourceSize / outputSize, sourceSize - vec2u(1u));
        let key = textureLoad(visibility, vec2i(texel), 0).x;
        if (key == ${GPU_VISIBILITY_KEY_EMPTY}u) { return vec4f(0.025, 0.035, 0.05, 1.0); }
        let hash = key * 1664525u + 1013904223u;
        return vec4f(0.2 + 0.8 * f32(hash & 255u) / 255.0,
                     0.2 + 0.8 * f32((hash >> 8u) & 255u) / 255.0,
                     0.2 + 0.8 * f32((hash >> 16u) & 255u) / 255.0, 1.0);
      }
    ` });
    this.pipeline = device.createRenderPipeline({
      label: "Visibility/Phase1 present",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindingLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
  }

  addToGraph(
    graph: FrameGraph,
    visibilityKey: ResourceId,
    swapchain: ResourceId,
    outputWidth: number,
    outputHeight: number
  ): void {
    const builder = graph.add("Visibility/Phase1 present", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const size = command.allocateTransientBufferAndLoad(
        new Uint32Array([outputWidth, outputHeight, 0, 0]).buffer,
        GPUBufferUsage.UNIFORM
      );
      const bindGroup = this.device.createBindGroup({
        layout: this.bindingLayout,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(visibilityKey)) },
          { binding: 1, resource: { buffer: size } }
        ]
      });
      const pass = command.gpu_encoder.beginRenderPass({ colorAttachments: [{
        view: resolveTextureView(resources.get(swapchain)),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }] });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    });
    builder.read(visibilityKey);
    builder.write(swapchain);
  }
}
