import { GpuBindGroupCache } from "../../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// Full branch translation of pinned ffx_fsr3upscaler_luma_instability.h.
// History is ping-ponged because WebGPU cannot sample and storage-write one
// texture in the same dispatch. All FSR3 dispatches still share the frame submit.
export const FSR3_LUMA_INSTABILITY_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var dilated_motion: texture_2d<f32>;
@group(0) @binding(1) var dilated_reactive: texture_2d<f32>;
@group(0) @binding(2) var current_luma: texture_2d<f32>;
@group(0) @binding(3) var previous_luma_history: texture_2d<f32>;
@group(0) @binding(4) var farthest_depth_mip1: texture_2d<f32>;
@group(0) @binding(5) var input_exposure: texture_2d<f32>;
@group(0) @binding(6) var linear_clamp: sampler;
@group(0) @binding(7) var<uniform> constants: Fsr3Constants;
@group(0) @binding(8) var output_luma_history: texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var output_instability: texture_storage_2d<r16float, write>;

fn clamp_uv(uv: vec2f, active_size: vec2i, resource_size: vec2u) -> vec2f {
  let location = clamp(uv * vec2f(active_size), vec2f(0.5), vec2f(active_size) - vec2f(0.5));
  return location / vec2f(resource_size);
}

fn min_divided_by_max(a: f32, b: f32, on_zero: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return on_zero;
}

fn exposure() -> f32 {
  let value = textureLoad(input_exposure, vec2i(0), 0).x;
  if (value == 0.0) { return 1.0; }
  return value;
}

struct InstabilityData {
  history: vec4f,
  factor: f32,
};

fn compute_instability(history_in: vec4f, current: f32) -> InstabilityData {
  var history = history_in;
  let diff0 = current - history[0];
  let similarity0 = min_divided_by_max(current, history[0], 1.0);
  var max_similarity = similarity0;
  var instability = 0.0;
  if (similarity0 < 1.0) {
    for (var i = 1; i <= 3; i++) {
      let diff1 = current - history[i];
      let similarity1 = min_divided_by_max(current, history[i], 0.0);
      if (sign(diff0) == sign(diff1)) {
        max_similarity = max(max_similarity, similarity1);
      }
    }
    if (max_similarity > similarity0) { instability = 1.0; }
  }
  history[3] = history[2];
  history[2] = history[1];
  history[1] = history[0];
  history[0] = current;
  history /= exposure();
  var factor = 0.0;
  if (history[3] != 0.0) { factor = instability; }
  return InstabilityData(history, factor);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= constants.render_size)) { return; }
  var data = InstabilityData(vec4f(0.0), 0.0);
  let motion = textureLoad(dilated_motion, pixel, 0).xy;
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.render_size);
  let current_jittered_uv = uv + constants.jitter_offset / vec2f(constants.render_size);
  let previous_jittered_uv = uv + constants.previous_jitter_offset / vec2f(constants.previous_render_size);
  let reprojected_uv = previous_jittered_uv + motion;
  if (all(reprojected_uv >= vec2f(0.0)) && all(reprojected_uv <= vec2f(1.0))) {
    let reactive_uv = clamp_uv(current_jittered_uv, constants.render_size,
      textureDimensions(dilated_reactive));
    let masks = textureSampleLevel(dilated_reactive, linear_clamp, reactive_uv, 0.0);
    let reactive = clamp(masks[0], 0.0, 1.0);
    let disocclusion = clamp(masks[1], 0.0, 1.0);
    let shading_change = clamp(masks[2], 0.0, 1.0);
    let accumulation = clamp(masks[3], 0.0, 1.0);
    if (accumulation > 0.9) {
      let current_uv = clamp_uv(current_jittered_uv, constants.render_size,
        textureDimensions(current_luma));
      let current = textureSampleLevel(current_luma, linear_clamp, current_uv, 0.0).x * exposure();
      let history_uv = clamp_uv(reprojected_uv, constants.previous_render_size,
        textureDimensions(previous_luma_history));
      let history = textureSampleLevel(previous_luma_history, linear_clamp, history_uv, 0.0) *
        constants.delta_pre_exposure * exposure();
      let farthest_uv = clamp_uv(current_jittered_uv, constants.render_size / 2,
        textureDimensions(farthest_depth_mip1));
      let farthest_depth = textureSampleLevel(farthest_depth_mip1, linear_clamp, farthest_uv, 0.0).x;
      // The pinned source passes farthest depth to this function but does not
      // use it in the factor; keep the sampled dependency for source tracing.
      data = compute_instability(history, current);
      let velocity_weight = 1.0 - clamp(length(motion * vec2f(3840.0, 2160.0)) / 20.0, 0.0, 1.0);
      data.factor *= velocity_weight * (1.0 - disocclusion) * (1.0 - reactive) * (1.0 - shading_change);
      _ = farthest_depth;
    }
  }
  textureStore(output_luma_history, pixel, data.history);
  textureStore(output_instability, pixel, vec4f(data.factor, 0.0, 0.0, 0.0));
}
`;

export interface Fsr3LumaInstabilityOutput {
  readonly currentHistory: ResourceId;
  readonly instability: ResourceId;
}

export class Fsr3LumaInstabilityPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const module = device.createShaderModule({
      label: "FSR3 Luma Instability",
      code: FSR3_LUMA_INSTABILITY_WGSL,
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2, 3, 4].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" as const },
        })),
        { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 8,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
        {
          binding: 9,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r16float" },
        },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "FSR3 Luma Instability",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" },
    });
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      dilatedMotion: ResourceId;
      dilatedReactive: ResourceId;
      currentLuma: ResourceId;
      previousHistory: ResourceId;
      currentHistory: ResourceId;
      farthestDepthMip1: ResourceId;
      exposure: ResourceId;
      constants: ResourceId;
      width: number;
      height: number;
    },
  ): Fsr3LumaInstabilityOutput {
    const builder = graph.add("FSR3/Luma Instability", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.bindGroups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.dilatedMotion)) },
          { binding: 1, resource: resolveTextureView(resources.get(data.dilatedReactive)) },
          { binding: 2, resource: resolveTextureView(resources.get(data.currentLuma)) },
          { binding: 3, resource: resolveTextureView(resources.get(data.previousHistory)) },
          { binding: 4, resource: resolveTextureView(resources.get(data.farthestDepthMip1)) },
          { binding: 5, resource: resolveTextureView(resources.get(data.exposure)) },
          { binding: 6, resource: this.sampler },
          { binding: 7, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 8, resource: resolveTextureView(resources.get(data.currentHistory)) },
          { binding: 9, resource: resolveTextureView(resources.get(output)) },
        ],
      });
      const pass = command.beginComputePass({ label: "FSR3 Luma Instability" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    const output = builder.create("FSR3/luma instability", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "r16float",
      domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    builder.read(input.dilatedMotion);
    builder.read(input.dilatedReactive);
    builder.read(input.currentLuma);
    builder.read(input.previousHistory);
    builder.read(input.farthestDepthMip1);
    builder.read(input.exposure);
    builder.read(input.constants);
    const currentHistory = builder.write(input.currentHistory);
    return { currentHistory, instability: output };
  }
}
