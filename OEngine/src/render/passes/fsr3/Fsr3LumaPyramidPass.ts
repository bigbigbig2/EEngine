import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// WebGPU lowering of SDK SPD for the luma pyramid. The SDK performs the 2x2
// reductions in one dispatch with a global counter. WebGPU has no cross-
// workgroup barrier, so each mip is a separate dispatch on the frame encoder.
// The source callbacks, reduction order, mip-5 fp16 store/load boundary,
// farthest-depth mip-1 output and final frame-info update are preserved.
const SOURCE_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var current_luma: texture_2d<f32>;
@group(0) @binding(1) var farthest_depth: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: Fsr3Constants;
@group(0) @binding(3) var mip0: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var farthest_mip1: texture_storage_2d<r16float, write>;

fn source_value(pixel: vec2i) -> vec4f {
  let clamped = clamp(pixel, vec2i(0), constants.render_size - vec2i(1));
  let luma = textureLoad(current_luma, clamped, 0).x;
  let log_luma = max(0.000061, log(luma));
  let farthest = textureLoad(farthest_depth, clamped, 0).x;
  return vec4f(log_luma, luma, farthest, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dst = vec2i(id.xy);
  if (any(dst >= vec2i(textureDimensions(mip0)))) { return; }
  let src = dst * 2;
  let value = (source_value(src) + source_value(src + vec2i(0, 1)) +
    source_value(src + vec2i(1, 0)) + source_value(src + vec2i(1, 1))) * 0.25;
  textureStore(mip0, dst, value);
  textureStore(farthest_mip1, dst, vec4f(value.z, 0.0, 0.0, 0.0));
}
`;

const REDUCE_F32_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float, write>;
fn load_clamped(pixel: vec2i) -> vec4f {
  return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source)) - vec2i(1)), 0);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dst = vec2i(id.xy);
  if (any(dst >= vec2i(textureDimensions(destination)))) { return; }
  let src = dst * 2;
  let value = (load_clamped(src) + load_clamped(src + vec2i(0, 1)) +
    load_clamped(src + vec2i(1, 0)) + load_clamped(src + vec2i(1, 1))) * 0.25;
  textureStore(destination, dst, value);
}
`;

const QUANTIZE_MIP5_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rg16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= vec2i(textureDimensions(destination)))) { return; }
  let value = textureLoad(source, pixel, 0);
  textureStore(destination, pixel, vec4f(value.xy, 0.0, 0.0));
}
`;

const FRAME_INFO_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var final_mip: texture_2d<f32>;
@group(0) @binding(1) var previous_frame_info: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: Fsr3Constants;
@group(0) @binding(3) var current_frame_info: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(1, 1, 1)
fn main() {
  let value = textureLoad(final_mip, vec2i(0), 0);
  var previous = textureLoad(previous_frame_info, vec2i(0), 0);
  var log_luma = value.x;
  if (previous.y < 10000.0) {
    log_luma = max(0.0, previous.y + (log_luma - previous.y) *
      (1.0 - exp(-constants.delta_time)));
  }
  let lavg = exp(log_luma);
  let iso100 = log2((lavg * 100.0) / 12.5);
  let lmax = (78.0 / (0.65 * 100.0)) * pow(2.0, iso100);
  previous.x = 1.0 / lmax;
  previous.y = log_luma;
  previous.z = value.y;
  textureStore(current_frame_info, vec2i(0), previous);
}
`;

interface PipelinePair {
  readonly layout: GPUBindGroupLayout;
  readonly pipeline: GPUComputePipeline;
}

export interface Fsr3LumaPyramidOutput {
  readonly farthestDepthMip1: ResourceId;
  readonly frameInfo: ResourceId;
}

export class Fsr3LumaPyramidPass {
  private readonly source: PipelinePair;
  private readonly reduceF32: PipelinePair;
  private readonly quantize: PipelinePair;
  private readonly frameInfo: PipelinePair;

  constructor(private readonly device: GPUDevice) {
    const texture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float" },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" },
    });
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format },
    });
    const make = (label: string, code: string, entries: GPUBindGroupLayoutEntry[]): PipelinePair => {
      const layout = device.createBindGroupLayout({ label, entries });
      const module = device.createShaderModule({ label, code });
      return {
        layout,
        pipeline: device.createComputePipeline({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module, entryPoint: "main" },
        }),
      };
    };
    this.source = make("FSR3 Luma SPD source", SOURCE_WGSL, [
      texture(0),
      texture(1),
      uniform(2),
      storage(3, "rgba32float"),
      storage(4, "r16float"),
    ]);
    this.reduceF32 = make("FSR3 Luma SPD f32 reduce", REDUCE_F32_WGSL, [
      texture(0),
      storage(1, "rgba32float"),
    ]);
    this.quantize = make("FSR3 Luma SPD mip5 quantize", QUANTIZE_MIP5_WGSL, [
      texture(0),
      storage(1, "rg16float"),
    ]);
    this.frameInfo = make("FSR3 Luma SPD frame info", FRAME_INFO_WGSL, [
      texture(0),
      texture(1),
      uniform(2),
      storage(3, "rgba32float"),
    ]);
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      currentLuma: ResourceId;
      farthestDepth: ResourceId;
      constants: ResourceId;
      previousFrameInfo: ResourceId;
      currentFrameInfo: ResourceId;
      width: number;
      height: number;
    },
  ): Fsr3LumaPyramidOutput {
    if (input.width < 2 || input.height < 2)
      throw new RangeError("FSR3 SPD requires at least 2x2 render size");
    const mipCount = Math.min(12, Math.ceil(Math.log2(Math.max(input.width, input.height))));
    let width = Math.ceil(input.width / 2);
    let height = Math.ceil(input.height / 2);
    const sourceWidth = width;
    const sourceHeight = height;
    const source = graph.add("FSR3/Luma SPD source", input, (data, resources, context) => {
      this.dispatch(
        this.source,
        context.encoder as ShadeGPUCommandContext,
        [
          resolveTextureView(resources.get(data.currentLuma)),
          resolveTextureView(resources.get(data.farthestDepth)),
          { buffer: resources.get(data.constants) as GPUBuffer },
          resolveTextureView(resources.get(firstMip)),
          resolveTextureView(resources.get(farthestDepthMip1)),
        ],
        sourceWidth,
        sourceHeight,
      );
    });
    const firstMip = this.createTexture(source, "FSR3/luma SPD mip0", width, height, "rgba32float");
    const farthestDepthMip1 = this.createTexture(
      source,
      "FSR3/farthest depth mip1",
      width,
      height,
      "r16float",
    );
    source.read(input.currentLuma);
    source.read(input.farthestDepth);
    source.read(input.constants);
    let previous = firstMip;
    for (let mip = 1; mip < mipCount; mip++) {
      width = Math.ceil(width / 2);
      height = Math.ceil(height / 2);
      const targetWidth = width;
      const targetHeight = height;
      const from = previous;
      const builder = graph.add(`FSR3/Luma SPD mip${mip}`, { from }, (data, resources, context) => {
        this.dispatch(
          this.reduceF32,
          context.encoder as ShadeGPUCommandContext,
          [resolveTextureView(resources.get(data.from)), resolveTextureView(resources.get(target))],
          targetWidth,
          targetHeight,
        );
      });
      const target = this.createTexture(builder, `FSR3/luma SPD mip${mip}`, width, height, "rgba32float");
      builder.read(from);
      previous = target;
      if (mip === 5 && mip !== mipCount - 1) {
        const quantizeSource = previous;
        const quantize = graph.add(
          "FSR3/Luma SPD mip5 fp16",
          { from: quantizeSource },
          (data, resources, context) => {
            this.dispatch(
              this.quantize,
              context.encoder as ShadeGPUCommandContext,
              [resolveTextureView(resources.get(data.from)), resolveTextureView(resources.get(halfMip))],
              targetWidth,
              targetHeight,
            );
          },
        );
        const halfMip = this.createTexture(quantize, "FSR3/luma SPD mip5 fp16", width, height, "rg16float");
        quantize.read(quantizeSource);
        previous = halfMip;
      }
    }
    const finalMip = previous;
    const finish = graph.add(
      "FSR3/Luma SPD frame info",
      { finalMip, ...input },
      (data, resources, context) => {
        this.dispatch(
          this.frameInfo,
          context.encoder as ShadeGPUCommandContext,
          [
            resolveTextureView(resources.get(data.finalMip)),
            resolveTextureView(resources.get(data.previousFrameInfo)),
            { buffer: resources.get(data.constants) as GPUBuffer },
            resolveTextureView(resources.get(data.currentFrameInfo)),
          ],
          1,
          1,
        );
      },
    );
    finish.read(finalMip);
    finish.read(input.previousFrameInfo);
    finish.read(input.constants);
    const frameInfo = finish.write(input.currentFrameInfo);
    return { farthestDepthMip1, frameInfo };
  }

  private createTexture(
    builder: ReturnType<FrameGraph["add"]>,
    label: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): ResourceId {
    return builder.create(label, {
      kind: "transient_texture",
      width,
      height,
      format,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private dispatch(
    pair: PipelinePair,
    command: ShadeGPUCommandContext,
    resources: GPUBindingResource[],
    width: number,
    height: number,
  ): void {
    const bind = this.device.createBindGroup({
      layout: pair.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    const pass = command.beginComputePass({ label: "FSR3 Luma SPD" });
    pass.setPipeline(pair.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
  }
}
