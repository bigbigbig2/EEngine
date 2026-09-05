/**
 * ColorGradingPass：线性 HDR 色彩分级阶段。
 *
 * 单 pass 全屏三角：读取 Bloom 合成后的线性 HDR 颜色，应用 lift/gamma/gain、
 * contrast 与 saturation，输出仍为 rgba16float 线性 HDR，供后续 Sharpen/Tonemap 消费。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  COLOR_GRADING_FORMAT,
  COLOR_GRADING_WGSL
} from "../../shaders/color_grading.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export type ColorGradingJob = {
  /** ASC CDL lift（暗部加性偏移，线性域），默认 0。 */
  readonly lift: number;
  /** ASC CDL gamma（幂指数），默认 1。 */
  readonly gamma: number;
  /** ASC CDL gain（高光乘性增益），默认 1。 */
  readonly gain: number;
  /** 饱和度（1 = 恒等），默认 1。 */
  readonly saturation: number;
  /** 对比度（log2 域斜率，1 = 恒等），默认 1。 */
  readonly contrast: number;
};

export class ColorGradingPass {
  private readonly pipelineDescriptor: CachedRenderPipelineDescriptor;

  constructor(private readonly graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("ColorGradingPass: GraphicsContext has no device");
    }
    const group0: GPUBindGroupLayoutDescriptor = {
      label: "Renderer/Color Grading group0",
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
    const module = { label: "Color Grading", code: COLOR_GRADING_WGSL };
    this.pipelineDescriptor = {
      label: "Renderer/Color Grading",
      layout: {
        label: "Renderer/Color Grading layout",
        bindGroupLayouts: [group0]
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: COLOR_GRADING_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  addToGraph(
    graph: FrameGraph,
    input: ResourceId,
    width: number,
    height: number,
    job: ColorGradingJob
  ): ResourceId {
    let output = -1;
    const builder = graph.add("Color Grading", job, (data, resources, context) => {
      const command = context.encoder;
      if (!isShadeCommandContext(command)) {
        throw new Error("ColorGradingPass: requires ShadeGPUCommandContext");
      }
      this.execute(
        command,
        data,
        resolveTextureView(resources.get(input)),
        resolveTextureView(resources.get(output))
      );
    });
    output = builder.create("Color graded color", {
      kind: "transient_texture",
      width,
      height,
      format: COLOR_GRADING_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC
    });
    builder.read(input);
    return output;
  }

  private execute(
    command: ShadeGPUCommandContext,
    job: ColorGradingJob,
    input: GPUTextureView,
    output: GPUTextureView
  ): void {
    const uniform = new Float32Array(16);
    // WGSL uniform layout：lift=0/1/2(3 pad)，gamma=4/5/6(7 pad)，
    // gain=8/9/10，saturation=11，contrast=12，13/14/15 pad。
    // vec3f 的 16-byte 对齐只会把后续 vec3f 推到下一个 16-byte 边界；
    // 标量 saturation/contrast 紧跟在 gain 的 12-byte payload 后面。
    uniform[0] = uniform[1] = uniform[2] = job.lift;
    uniform[4] = uniform[5] = uniform[6] = job.gamma;
    uniform[8] = uniform[9] = uniform[10] = job.gain;
    uniform[11] = job.saturation;
    uniform[12] = job.contrast;
    const settings = command.allocateTransientBufferAndLoad(
      uniform.buffer,
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
