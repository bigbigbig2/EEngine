import { GpuBindGroupCache } from "../../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// WebGPU lowering of SDK SPD for the luma pyramid. The SDK performs the 2x2
// reductions in one dispatch with a global counter. Each 8x8 tile reduces up
// to four levels locally; cross-tile reductions use another frame dispatch.
// The source callbacks, reduction order, mip-5 fp16 store/load boundary,
// farthest-depth mip-1 output and final frame-info update are preserved.
function reductionWgsl(source: boolean, levels: number): string {
  const outputSide = 8 >> (levels - 1);
  return /* wgsl */ `
${source ? SOURCE_INPUT_WGSL : REDUCE_INPUT_WGSL}
var<workgroup> tile: array<vec4f, 64>;
@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lane: vec3u) {
  let first_size = ${source ? "textureDimensions(farthest_mip1)" : "(textureDimensions(source) + vec2u(1u)) / 2u"};
  let first_pixel = group.xy * 8u + lane.xy;
  let src = vec2i(min(first_pixel, first_size - vec2u(1u))) * 2;
  let value = (source_value(src) + source_value(src + vec2i(0, 1)) +
    source_value(src + vec2i(1, 0)) + source_value(src + vec2i(1, 1))) * 0.25;
  ${source ? "if all(first_pixel < first_size) { textureStore(farthest_mip1, vec2i(first_pixel), vec4f(value.z, 0.0, 0.0, 0.0)); }" : ""}
  tile[lane.y * 8u + lane.x] = value;
  ${Array.from({ length: levels - 1 }, (_, index) => {
    const side = 4 >> index;
    return /* wgsl */ `
  workgroupBarrier();
  var reduced_${index}: vec4f;
  if all(lane.xy < vec2u(${side}u)) {
    // NPOT clamping applies at every level, not only to the original tile.
    let previous_size = (first_size + vec2u(${(1 << index) - 1}u)) / ${1 << index}u;
    let last = min(vec2u(${side * 2}u), previous_size - group.xy * ${side * 2}u) - vec2u(1u);
    let p0 = min(lane.xy * 2u, last);
    let p1 = min(lane.xy * 2u + vec2u(1u), last);
    reduced_${index} = (tile[p0.y * 8u + p0.x] + tile[p1.y * 8u + p0.x] +
      tile[p0.y * 8u + p1.x] + tile[p1.y * 8u + p1.x]) * 0.25;
  }
  // All reads must finish before compacting into the shared tile.
  workgroupBarrier();
  if all(lane.xy < vec2u(${side}u)) { tile[lane.y * 8u + lane.x] = reduced_${index}; }
`;
  }).join("\n")}
  let dst = group.xy * ${outputSide}u + lane.xy;
  if all(lane.xy < vec2u(${outputSide}u)) && all(dst < textureDimensions(destination)) {
    textureStore(destination, vec2i(dst), tile[lane.y * 8u + lane.x]);
  }
}
`;
}

const SOURCE_INPUT_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var current_luma: texture_2d<f32>;
@group(0) @binding(1) var farthest_depth: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: Fsr3Constants;
@group(0) @binding(3) var destination: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var farthest_mip1: texture_storage_2d<r16float, write>;

fn source_value(pixel: vec2i) -> vec4f {
  let clamped = clamp(pixel, vec2i(0), constants.render_size - vec2i(1));
  let luma = textureLoad(current_luma, clamped, 0).x;
  let log_luma = max(0.000061, log(luma));
  let farthest = textureLoad(farthest_depth, clamped, 0).x;
  return vec4f(log_luma, luma, farthest, 0.0);
}

`;

const REDUCE_INPUT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float, write>;
fn source_value(pixel: vec2i) -> vec4f {
  return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source)) - vec2i(1)), 0);
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
  readonly outputSide?: number;
}

export interface Fsr3LumaPyramidOutput {
  readonly farthestDepthMip1: ResourceId;
  readonly frameInfo: ResourceId;
}

export class Fsr3LumaPyramidPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly source: readonly PipelinePair[];
  private readonly reduceF32: readonly PipelinePair[];
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
    this.source = Array.from({ length: 4 }, (_, index) => ({
      ...make(`FSR3 Luma SPD source/${index + 1} levels`, reductionWgsl(true, index + 1), [
        texture(0),
        texture(1),
        uniform(2),
        storage(3, "rgba32float"),
        storage(4, "r16float"),
      ]),
      outputSide: 8 >> index,
    }));
    this.reduceF32 = Array.from({ length: 4 }, (_, index) => ({
      ...make(`FSR3 Luma SPD f32/${index + 1} levels`, reductionWgsl(false, index + 1), [
        texture(0),
        storage(1, "rgba32float"),
      ]),
      outputSide: 8 >> index,
    }));
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
    const sourceLevels = Math.min(mipCount, 4);
    for (let level = 1; level < sourceLevels; level++) {
      width = Math.ceil(width / 2);
      height = Math.ceil(height / 2);
    }
    const firstWidth = width;
    const firstHeight = height;
    const source = graph.add("FSR3/Luma SPD source", input, (data, resources, context) => {
      this.dispatch(
        this.source[sourceLevels - 1]!,
        context.encoder as ShadeGPUCommandContext,
        [
          resolveTextureView(resources.get(data.currentLuma)),
          resolveTextureView(resources.get(data.farthestDepth)),
          { buffer: resources.get(data.constants) as GPUBuffer },
          resolveTextureView(resources.get(firstMip)),
          resolveTextureView(resources.get(farthestDepthMip1)),
        ],
        firstWidth,
        firstHeight,
      );
    });
    const firstMip = this.createTexture(
      source,
      `FSR3/luma SPD mip${sourceLevels - 1}`,
      width,
      height,
      "rgba32float",
    );
    const farthestDepthMip1 = this.createTexture(
      source,
      "FSR3/farthest depth mip1",
      sourceWidth,
      sourceHeight,
      "r16float",
    );
    source.read(input.currentLuma);
    source.read(input.farthestDepth);
    source.read(input.constants);
    let previous = firstMip;
    for (let nextMip = sourceLevels; nextMip < mipCount; ) {
      // Stop at the SDK's real fp16 boundary before reducing higher levels.
      const levels = Math.min(4, mipCount - nextMip, nextMip <= 5 ? 6 - nextMip : 4);
      const mip = nextMip + levels - 1;
      nextMip += levels;
      for (let level = 0; level < levels; level++) {
        width = Math.ceil(width / 2);
        height = Math.ceil(height / 2);
      }
      const targetWidth = width;
      const targetHeight = height;
      const from = previous;
      const builder = graph.add(`FSR3/Luma SPD mip${mip}`, { from }, (data, resources, context) => {
        this.dispatch(
          this.reduceF32[levels - 1]!,
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
    const bind = this.bindGroups.create(this.device, {
      layout: pair.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    const pass = command.beginComputePass({ label: "FSR3 Luma SPD" });
    pass.setPipeline(pair.pipeline);
    pass.setBindGroup(0, bind);
    const side = pair.outputSide ?? 8;
    pass.dispatchWorkgroups(Math.ceil(width / side), Math.ceil(height / side));
    pass.end();
  }
}
