import { GpuBindGroupCache } from "../../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// SDK 1.1.4 ffx_fsr3upscaler_shading_change_pyramid.h. The SPD 2x2
// reductions are sequenced as mip dispatches on the same encoder. Float32
// intermediate values and each RG16 store match the source callbacks.
export const FSR3_SHADING_PYRAMID_SOURCE_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var dilated_motion: texture_2d<f32>;
@group(0) @binding(1) var current_luma: texture_2d<f32>;
@group(0) @binding(2) var previous_luma: texture_2d<f32>;
@group(0) @binding(3) var input_exposure: texture_2d<f32>;
@group(0) @binding(4) var<uniform> constants: Fsr3Constants;
@group(0) @binding(5) var scratch_mip0: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var spd_mip0: texture_storage_2d<rg16float, write>;

fn exposure() -> f32 {
  let value = textureLoad(input_exposure, vec2i(0), 0).x;
  if (value == 0.0) { return 1.0; }
  return value;
}
fn clamp_load(pixel: vec2i, offset: vec2i, size: vec2i) -> vec2i {
  return clamp(pixel + offset, vec2i(0), size - vec2i(1));
}
fn compare_swap(values: ptr<function, array<f32, 5>>, i: i32, j: i32) {
  let low = min((*values)[i], (*values)[j]);
  (*values)[j] = max((*values)[i], (*values)[j]);
  (*values)[i] = low;
}
fn sort_set(values: ptr<function, array<f32, 5>>) {
  compare_swap(values, 0, 3); compare_swap(values, 1, 4);
  compare_swap(values, 0, 2); compare_swap(values, 1, 3);
  compare_swap(values, 0, 1); compare_swap(values, 2, 4);
  compare_swap(values, 1, 2); compare_swap(values, 3, 4);
  compare_swap(values, 2, 3);
}
fn min_divided_by_max(a: f32, b: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return 0.0;
}
fn difference(current_in: array<f32, 5>, previous_in: array<f32, 5>) -> f32 {
  var current = current_in;
  var previous = previous_in;
  sort_set(&current);
  sort_set(&previous);
  var minimum_difference = 65503.0;
  var a = 0;
  var b = 0;
  if (min(current[4], previous[4]) > 1.175494351e-38) {
    for (var i = 0; i < 5 && minimum_difference < 65504.0; i++) {
      var diff = current[a] - previous[b];
      if (abs(diff) > 0.000061) {
        diff = sign(diff) * (1.0 - min_divided_by_max(current[a], previous[b]));
        if (abs(diff) < abs(minimum_difference)) { minimum_difference = diff; }
        if (current[a] < previous[b]) { a += 1; }
        if (current[a] >= previous[b]) { b += 1; }
      } else {
        minimum_difference = 65504.0;
      }
    }
  }
  return minimum_difference * select(0.0, 1.0, minimum_difference < 65503.0);
}
fn source_value(pixel_in: vec2i) -> vec4f {
  let pixel = clamp_load(pixel_in, vec2i(0), constants.render_size);
  let motion = textureLoad(dilated_motion, pixel, 0).xy;
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.render_size);
  let offsets = array<vec2i, 5>(
    vec2i(0, 0), vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  var current: array<f32, 5>;
  let current_base = vec2i(floor((uv + constants.jitter_offset /
    vec2f(constants.render_size)) * vec2f(constants.render_size)));
  for (var i = 0; i < 5; i++) {
    let sample = clamp_load(current_base, offsets[i], constants.render_size);
    current[i] = max(textureLoad(current_luma, sample, 0).x * exposure(), 0.000061);
  }
  let previous_uv = uv + constants.previous_jitter_offset /
    vec2f(constants.previous_render_size) + motion;
  var diff = 0.0;
  if (all(previous_uv >= vec2f(0.0)) && all(previous_uv <= vec2f(1.0))) {
    var previous: array<f32, 5>;
    let previous_base = vec2i(floor(previous_uv * vec2f(constants.previous_render_size)));
    for (var i = 0; i < 5; i++) {
      let sample = clamp_load(previous_base, offsets[i], constants.previous_render_size);
      previous[i] = max(textureLoad(previous_luma, sample, 0).x *
        constants.delta_pre_exposure * exposure(), 0.000061);
    }
    diff = difference(current, previous);
  }
  return vec4f(diff, select(0.0, sign(diff), diff != 0.0), 1.0, 0.0);
}

var<workgroup> source_values: array<vec4f, 256>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) lane: vec3u) {
  let index = lane.y * 16u + lane.x;
  source_values[index] = source_value(vec2i(group.xy * 16u + lane.xy));
  workgroupBarrier();
  if ((lane.x & 1u) != 0u || (lane.y & 1u) != 0u) { return; }
  let dst = vec2i(group.xy * 8u + lane.xy / 2u);
  if (any(vec2u(dst) >= textureDimensions(spd_mip0))) { return; }
  // Same source coordinates and f32 addition order as SDK SpdReduce4.
  let value = (source_values[index] + source_values[index + 16u] +
    source_values[index + 1u] + source_values[index + 17u]) * 0.25;
  textureStore(scratch_mip0, dst, value);
  textureStore(spd_mip0, dst, vec4f(value.xy, 0.0, 0.0));
}
`;

export const FSR3_SHADING_PYRAMID_REDUCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var scratch: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var spd_mip: texture_storage_2d<rg16float, write>;
fn load_clamped(pixel: vec2i) -> vec4f {
  return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source)) - vec2i(1)), 0);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dst = vec2i(id.xy);
  if (any(id.xy >= textureDimensions(spd_mip))) { return; }
  let src = dst * 2;
  let value = (load_clamped(src) + load_clamped(src + vec2i(0, 1)) +
    load_clamped(src + vec2i(1, 0)) + load_clamped(src + vec2i(1, 1))) * 0.25;
  textureStore(scratch, dst, value);
  textureStore(spd_mip, dst, vec4f(value.xy, 0.0, 0.0));
}
`;

interface PipelinePair {
  readonly layout: GPUBindGroupLayout;
  readonly pipeline: GPUComputePipeline;
}

export class Fsr3ShadingChangePyramidPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly source: PipelinePair;
  private readonly reduce: PipelinePair;

  constructor(private readonly device: GPUDevice) {
    if (
      device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      device.limits.maxComputeWorkgroupSizeX < 16 ||
      device.limits.maxComputeWorkgroupSizeY < 16 ||
      device.limits.maxComputeWorkgroupStorageSize < 4096
    )
      throw new RangeError("FSR3 shading source requires its complete 16x16/4KiB profile");
    const texture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float" },
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
    this.source = make("FSR3 Shading SPD source", FSR3_SHADING_PYRAMID_SOURCE_WGSL, [
      texture(0),
      texture(1),
      texture(2),
      texture(3),
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      storage(5, "rgba32float"),
      storage(6, "rg16float"),
    ]);
    this.reduce = make("FSR3 Shading SPD reduce", FSR3_SHADING_PYRAMID_REDUCE_WGSL, [
      texture(0),
      storage(1, "rgba32float"),
      storage(2, "rg16float"),
    ]);
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      dilatedMotion: ResourceId;
      currentLuma: ResourceId;
      previousLuma: ResourceId;
      exposure: ResourceId;
      constants: ResourceId;
      width: number;
      height: number;
    },
  ): readonly ResourceId[] {
    if (input.width < 8 || input.height < 8)
      throw new RangeError("FSR3 Shading SPD requires at least 8x8 render size");
    const mipCount = Math.min(12, Math.ceil(Math.log2(Math.max(input.width, input.height))));
    let width = Math.ceil(input.width / 2);
    let height = Math.ceil(input.height / 2);
    const firstWidth = width;
    const firstHeight = height;
    const first = graph.add("FSR3/Shading SPD source", input, (data, resources, context) => {
      this.dispatch(
        this.source,
        context.encoder as ShadeGPUCommandContext,
        [
          resolveTextureView(resources.get(data.dilatedMotion)),
          resolveTextureView(resources.get(data.currentLuma)),
          resolveTextureView(resources.get(data.previousLuma)),
          resolveTextureView(resources.get(data.exposure)),
          { buffer: resources.get(data.constants) as GPUBuffer },
          resolveTextureView(resources.get(scratch0)),
          resolveTextureView(resources.get(mip0)),
        ],
        firstWidth,
        firstHeight,
      );
    });
    const scratch0 = this.createTexture(first, "FSR3/shading SPD scratch0", width, height, "rgba32float");
    const mip0 = this.createTexture(first, "FSR3/shading SPD mip0", width, height, "rg16float");
    for (const resource of [
      input.dilatedMotion,
      input.currentLuma,
      input.previousLuma,
      input.exposure,
      input.constants,
    ])
      first.read(resource);
    const mips: ResourceId[] = [mip0];
    let previous = scratch0;
    for (let index = 1; index < mipCount; index++) {
      width = Math.ceil(width / 2);
      height = Math.ceil(height / 2);
      const targetWidth = width;
      const targetHeight = height;
      const from = previous;
      const builder = graph.add(`FSR3/Shading SPD mip${index}`, { from }, (data, resources, context) => {
        this.dispatch(
          this.reduce,
          context.encoder as ShadeGPUCommandContext,
          [
            resolveTextureView(resources.get(data.from)),
            resolveTextureView(resources.get(scratch)),
            resolveTextureView(resources.get(mip)),
          ],
          targetWidth,
          targetHeight,
        );
      });
      const scratch = this.createTexture(
        builder,
        `FSR3/shading SPD scratch${index}`,
        width,
        height,
        "rgba32float",
      );
      const mip = this.createTexture(builder, `FSR3/shading SPD mip${index}`, width, height, "rg16float");
      builder.read(from);
      mips.push(mip);
      previous = index === 5 ? mip : scratch;
    }
    return mips;
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
    const pass = command.beginComputePass({ label: "FSR3 Shading SPD" });
    pass.setPipeline(pair.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
  }
}
