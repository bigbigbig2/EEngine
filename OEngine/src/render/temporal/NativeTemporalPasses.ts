import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import {
  NATIVE_TEMPORAL_CLASSIFY_WGSL,
  NATIVE_TEMPORAL_RESOLVE_WGSL,
  NATIVE_TEMPORAL_FILTER_WEIGHTS_BYTES,
} from "../../shaders/native_temporal.js";

interface TemporalPipeline {
  readonly layout: GPUBindGroupLayout;
  readonly pipeline: GPUComputePipeline;
}
interface NativeTemporalInput {
  readonly color: ResourceId;
  readonly motion: ResourceId;
  readonly depth: ResourceId;
  readonly reconstructedDepth: ResourceId;
  readonly facts: ResourceId;
  readonly reactive: ResourceId;
  readonly currentLuma: ResourceId;
  readonly previousColor: ResourceId;
  readonly currentColor: ResourceId;
  readonly previousAccumulation: ResourceId;
  readonly currentAccumulation: ResourceId;
  readonly previousLumaHistory: ResourceId;
  readonly currentLumaHistory: ResourceId;
  readonly farthestDepthMip1: ResourceId;
  readonly shadingResponse: ResourceId;
  readonly exposure: ResourceId;
  readonly constants: ResourceId;
  readonly width: number;
  readonly height: number;
}

/** Encode Native-AA products only. Physical histories and frame transaction
 * belong to the existing reconstruction runtime, never to these passes. */
export class NativeTemporalPasses {
  private readonly groups = new GpuBindGroupCache();
  private readonly classify: TemporalPipeline;
  private readonly resolve: TemporalPipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    const uniform = { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" as const } };
    const texture = (
      binding: number,
      sampleType: GPUTextureSampleType = "float",
    ): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType },
    });
    const output = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format },
    });
    const pipeline = (label: string, code: string, entries: GPUBindGroupLayoutEntry[]): TemporalPipeline => {
      const layout = device.createBindGroupLayout({ label, entries });
      return {
        layout,
        pipeline: device.createComputePipeline({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" },
        }),
      };
    };
    this.classify = pipeline("Native Temporal/Depth Classification", NATIVE_TEMPORAL_CLASSIFY_WGSL, [
      uniform,
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      texture(2, "unfilterable-float"),
      texture(3, "unfilterable-float"),
      texture(4),
      texture(5),
      output(6, "rgba8unorm"),
      texture(7),
      texture(8),
      { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      output(10, "r8unorm"),
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ]);
    this.resolve = pipeline("Native Temporal/Resolve", NATIVE_TEMPORAL_RESOLVE_WGSL, [
      uniform,
      texture(1),
      texture(2, "unfilterable-float"),
      texture(3),
      texture(4),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      output(6, "rgba16float"),
      texture(9, "unfilterable-float"),
      texture(10),
      texture(11),
      output(13, "rgba16float"),
      texture(14),
      { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ]);
    this.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  addToGraph(graph: FrameGraph, input: NativeTemporalInput): ResourceId {
    const classification = graph.add(
      "Native Temporal/Depth Classification",
      input,
      (data, resources, context) => {
        this.dispatch(
          context.encoder as ShadeGPUCommandContext,
          this.classify,
          "Native Temporal/Depth Classification",
          [
            { binding: 0, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
            { binding: 1, resource: { buffer: resources.get(data.reconstructedDepth) as GPUBuffer } },
            ...[data.motion, data.depth, data.reactive, data.facts].map((id, index) => ({
              binding: index + 2,
              resource: resolveTextureView(resources.get(id)),
            })),
            { binding: 6, resource: resolveTextureView(resources.get(masks)) },
            { binding: 7, resource: resolveTextureView(resources.get(data.shadingResponse)) },
            { binding: 8, resource: resolveTextureView(resources.get(data.previousAccumulation)) },
            { binding: 9, resource: this.sampler },
            { binding: 10, resource: resolveTextureView(resources.get(accumulation)) },
            { binding: 11, resource: { buffer: resources.get(weights) as GPUBuffer } },
          ],
          data.width,
          data.height,
        );
      },
    );
    const masks = classification.create("Native Temporal/classified masks", {
      kind: "transient_texture",
      domain: "internal-full",
      width: input.width,
      height: input.height,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const weights = classification.create("Native Temporal/current filter weights", {
      kind: "transient_buffer",
      size: NATIVE_TEMPORAL_FILTER_WEIGHTS_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM,
    });
    for (const id of [
      input.constants,
      input.reconstructedDepth,
      input.motion,
      input.depth,
      input.reactive,
      input.facts,
      input.shadingResponse,
      input.previousAccumulation,
    ]) {
      classification.read(id);
    }

    const accumulation = classification.write(input.currentAccumulation);

    const resolve = graph.add("Native Temporal/Resolve", input, (data, resources, context) => {
      this.dispatch(
        context.encoder as ShadeGPUCommandContext,
        this.resolve,
        "Native Temporal/Resolve",
        [
          { binding: 0, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          ...[data.color, data.motion, masks, data.previousColor].map((id, index) => ({
            binding: index + 1,
            resource: resolveTextureView(resources.get(id)),
          })),
          { binding: 5, resource: this.sampler },
          { binding: 6, resource: resolveTextureView(resources.get(color)) },
          { binding: 9, resource: resolveTextureView(resources.get(data.exposure)) },
          { binding: 10, resource: resolveTextureView(resources.get(data.currentLuma)) },
          { binding: 11, resource: resolveTextureView(resources.get(data.previousLumaHistory)) },
          { binding: 13, resource: resolveTextureView(resources.get(lumaHistory)) },
          { binding: 14, resource: resolveTextureView(resources.get(data.farthestDepthMip1)) },
          { binding: 15, resource: { buffer: resources.get(weights) as GPUBuffer } },
        ],
        data.width,
        data.height,
      );
    });
    for (const id of [
      input.constants,
      input.color,
      input.motion,
      masks,
      weights,
      input.previousColor,
      input.exposure,
      input.currentLuma,
      input.previousLumaHistory,
      input.farthestDepthMip1,
    ]) {
      resolve.read(id);
    }
    const color = resolve.write(input.currentColor);
    const lumaHistory = resolve.write(input.currentLumaHistory);
    return color;
  }

  private dispatch(
    command: ShadeGPUCommandContext,
    owner: TemporalPipeline,
    label: string,
    entries: GPUBindGroupEntry[],
    width: number,
    height: number,
  ): void {
    const group = this.groups.create(this.device, { layout: owner.layout, entries });
    const pass = command.beginComputePass({ label });
    pass.setPipeline(owner.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
  }

  destroy(): void {
    this.groups.clear();
  }
}
