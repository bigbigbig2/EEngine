/**
 * MotionBlurPass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  MOTION_BLUR_FORMAT,
  MOTION_BLUR_NEIGHBOR_MAX_WGSL,
  MOTION_BLUR_RESOLVE_WGSL,
  MOTION_BLUR_TILE_FORMAT,
  MOTION_BLUR_TILE_MAX_WGSL
} from "../../shaders/motion_blur.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export type MotionBlurInputs = {
  color: ResourceId;
  velocity: ResourceId;
  depth: ResourceId;
};

export type MotionBlurJob = {
  width: number;
  height: number;
  strength: number;
};

export class MotionBlurPass {
  private readonly tilePipeline: CachedRenderPipelineDescriptor;
  private readonly neighborPipeline: CachedRenderPipelineDescriptor;
  private readonly resolvePipeline: CachedRenderPipelineDescriptor;

  constructor(graphics: GraphicsContext) {
    if (graphics.device === null) {
      throw new Error("MotionBlurPass: GraphicsContext has no device");
    }
    const singleTextureGroup = createSingleTextureGroupLayout();
    this.tilePipeline = createPipelineDescriptor(
      "Renderer/Motion blur tile Mk",
      MOTION_BLUR_TILE_MAX_WGSL,
      MOTION_BLUR_TILE_FORMAT,
      singleTextureGroup
    );
    this.neighborPipeline = createPipelineDescriptor(
      "Renderer/Motion blur neighbor Ek",
      MOTION_BLUR_NEIGHBOR_MAX_WGSL,
      MOTION_BLUR_TILE_FORMAT,
      singleTextureGroup
    );
    this.resolvePipeline = createPipelineDescriptor(
      "Renderer/Motion blur resolve kk",
      MOTION_BLUR_RESOLVE_WGSL,
      MOTION_BLUR_FORMAT,
      createResolveGroupLayout()
    );
  }

  init(): void {}

  addToGraph(graph: FrameGraph, job: MotionBlurJob, inputs: MotionBlurInputs): ResourceId {
    this.init();
    const tileWidth = Math.ceil(job.width / 16);
    const tileHeight = Math.ceil(job.height / 16);
    let tileMax = -1;
    const tileBuilder = graph.add("Motion blur tile max Mk", {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.drawSingle(command, this.tilePipeline, "Motion blur tile max Mk", resolveTextureView(resources.get(tileMax)), resolveTextureView(resources.get(inputs.velocity)));
    });
    tileMax = tileBuilder.create("Motion blur tile max", descriptor(tileWidth, tileHeight, MOTION_BLUR_TILE_FORMAT));
    tileBuilder.read(inputs.velocity);

    let neighborMax = -1;
    const neighborBuilder = graph.add("Motion blur neighbor max Ek", {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.drawSingle(command, this.neighborPipeline, "Motion blur neighbor max Ek", resolveTextureView(resources.get(neighborMax)), resolveTextureView(resources.get(tileMax)));
    });
    neighborMax = neighborBuilder.create("Motion blur neighbor max", descriptor(tileWidth, tileHeight, MOTION_BLUR_TILE_FORMAT));
    neighborBuilder.read(tileMax);

    let output = -1;
    const resolveBuilder = graph.add("Motion blur resolve kk", job, (data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.executeResolve(command, data.strength, {
        output: resolveTextureView(resources.get(output)),
        color: resolveTextureView(resources.get(inputs.color)),
        velocity: resolveTextureView(resources.get(inputs.velocity)),
        neighborMax: resolveTextureView(resources.get(neighborMax)),
        depth: resolveTextureView(resources.get(inputs.depth))
      });
    });
    output = resolveBuilder.create("Motion blur color", descriptor(job.width, job.height, MOTION_BLUR_FORMAT));
    resolveBuilder.read(inputs.color);
    resolveBuilder.read(inputs.velocity);
    resolveBuilder.read(neighborMax);
    resolveBuilder.read(inputs.depth);
    return output;
  }

  private drawSingle(command: ShadeGPUCommandContext, pipeline: CachedRenderPipelineDescriptor, label: string, output: GPUTextureView, input: GPUTextureView): void {
    draw(command, pipeline, [[input]], output, label);
  }

  private executeResolve(command: ShadeGPUCommandContext, strength: number, resources: { output: GPUTextureView; color: GPUTextureView; velocity: GPUTextureView; neighborMax: GPUTextureView; depth: GPUTextureView }): void {
    const strengthBuffer = command.allocateTransientBufferAndLoad(
      new Float32Array([strength]).buffer,
      GPUBufferUsage.UNIFORM
    );
    draw(
      command,
      this.resolvePipeline,
      [[
        resources.color,
        resources.velocity,
        resources.neighborMax,
        resources.depth,
        { buffer: strengthBuffer }
      ]],
      resources.output,
      "Motion blur resolve kk"
    );
  }

  destroy(): void {}
}

function descriptor(width: number, height: number, format: GPUTextureFormat) {
  return { kind: "transient_texture" as const, width, height, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT };
}

function createSingleTextureGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Motion blur single texture group0",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }]
  };
}

function createResolveGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Motion blur resolve group0",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  };
}

function createPipelineDescriptor(
  label: string,
  code: string,
  format: GPUTextureFormat,
  group0: GPUBindGroupLayoutDescriptor
): CachedRenderPipelineDescriptor {
  const module = { label, code };
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [group0]
    },
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function draw(
  command: ShadeGPUCommandContext,
  pipeline: CachedRenderPipelineDescriptor,
  bindings: GPUBindingResource[][],
  output: GPUTextureView,
  label: string
): void {
  const pass = command.constructRenderPass({
    label,
    pipeline,
    bindings,
    colorAttachments: [{ view: output, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }]
  });
  pass.draw(3, 1, 0, 0);
  pass.end();
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
  throw new Error("MotionBlurPass: cached Mk/Ek/kk require ShadeGPUCommandContext");
}
