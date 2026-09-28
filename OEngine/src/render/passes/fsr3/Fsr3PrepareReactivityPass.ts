import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// SDK 1.1.4 ffx_fsr3upscaler_prepare_reactivity.h. The reconstructed-depth
// SRV is the atomic buffer produced by Prepare Inputs; new locks are explicitly
// cleared before sparse high-resolution writes on the same frame encoder.
export const FSR3_PREPARE_REACTIVITY_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var<storage, read> reconstructed_depth: array<u32>;
@group(0) @binding(1) var dilated_motion: texture_2d<f32>;
@group(0) @binding(2) var dilated_depth: texture_2d<f32>;
@group(0) @binding(3) var reactive_mask: texture_2d<f32>;
@group(0) @binding(4) var transparency_mask: texture_2d<f32>;
@group(0) @binding(5) var previous_accumulation: texture_2d<f32>;
@group(0) @binding(6) var shading_change: texture_2d<f32>;
@group(0) @binding(7) var current_luma: texture_2d<f32>;
@group(0) @binding(8) var input_exposure: texture_2d<f32>;
@group(0) @binding(9) var linear_clamp: sampler;
@group(0) @binding(10) var<uniform> constants: Fsr3Constants;
@group(0) @binding(11) var dilated_reactive: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(12) var new_locks: texture_storage_2d<r8unorm, write>;
@group(0) @binding(13) var current_accumulation: texture_storage_2d<r8unorm, write>;

fn clamp_load(pixel: vec2i, offset: vec2i, size: vec2i) -> vec2i {
  return clamp(pixel + offset, vec2i(0), size - vec2i(1));
}
fn clamp_uv(uv: vec2f, active_size: vec2i, resource_size: vec2u) -> vec2f {
  return clamp(uv * vec2f(active_size), vec2f(0.5), vec2f(active_size) - vec2f(0.5)) /
    vec2f(resource_size);
}
fn inside(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}
fn view_depth(device_depth: f32) -> f32 {
  return constants.device_to_view_depth.y /
    (device_depth - constants.device_to_view_depth.x);
}
fn velocity_4k(motion: vec2f) -> f32 {
  return length(motion * vec2f(3840.0, 2160.0));
}
fn min_divided_by_max(a: f32, b: f32) -> f32 {
  let maximum = max(a, b);
  if (maximum != 0.0) { return min(a, b) / maximum; }
  return 0.0;
}
fn exposure() -> f32 {
  let value = textureLoad(input_exposure, vec2i(0), 0).x;
  if (value == 0.0) { return 1.0; }
  return value;
}

fn compute_disocclusion(uv: vec2f, motion: vec2f, current_view_depth: f32) -> f32 {
  let nearest_meters = min(current_view_depth * constants.view_space_to_meters_factor, 65504.0);
  let threshold = mix(0.25, 0.75, clamp(nearest_meters / 100.0, 0.0, 1.0));
  var reprojection_motion = motion;
  if (velocity_4k(motion) <= threshold) { reprojection_motion = vec2f(0.0); }
  let sample = (uv + reprojection_motion) * vec2f(constants.render_size) - vec2f(0.5);
  let base = vec2i(floor(sample));
  let fraction = fract(sample);
  let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  let weights = array<f32, 4>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  var disocclusion = 0.0;
  var weight_sum = 0.0;
  var potential = true;
  for (var i = 0; i < 4 && potential; i++) {
    let sample_pos = clamp_load(base, offsets[i], constants.render_size);
    let weight = weights[i];
    if (weight > 0.0006100000) {
      let index = u32(sample_pos.y * constants.render_size.x + sample_pos.x);
      let previous_view_depth = view_depth(bitcast<f32>(reconstructed_depth[index]));
      let depth_difference = current_view_depth - previous_view_depth;
      potential = potential && depth_difference > 1.175494351e-38;
      if (potential) {
        let half_viewport_width = length(vec2f(constants.render_size) * 0.5);
        let depth_threshold = max(current_view_depth, previous_view_depth);
        let required_separation = 1.37e-05 * half_viewport_width * depth_threshold;
        disocclusion += clamp(required_separation / depth_difference, 0.0, 1.0) * weight;
        weight_sum += weight;
      }
    }
  }
  if (potential && weight_sum > 0.0) {
    return clamp(1.0 - disocclusion / weight_sum, 0.0, 1.0);
  }
  return 0.0;
}

fn motion_divergence(uv: vec2f, motion: vec2f, current_depth: f32) -> f32 {
  let reprojected = vec2i((uv + motion) * vec2f(constants.render_size));
  let other_depth = textureLoad(dilated_depth, reprojected, 0).x;
  let other_motion = textureLoad(dilated_motion, reprojected, 0).xy;
  let other_velocity = velocity_4k(other_motion);
  let velocity = velocity_4k(motion);
  let distance_factor = min_divided_by_max(
    view_depth(other_depth) * constants.view_space_to_meters_factor,
    view_depth(current_depth) * constants.view_space_to_meters_factor);
  return (1.0 - clamp(other_velocity / velocity, 0.0, 1.0)) *
    distance_factor * clamp(velocity / 10.0, 0.0, 1.0);
}

fn dilate_reactive(pixel: vec2i) -> f32 {
  var result = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let sample = clamp_load(pixel, vec2i(x, y), constants.render_size);
      result = max(result, textureLoad(reactive_mask, sample, 0).x * constants.reactiveness_scale);
    }
  }
  return result;
}

fn thin_feature_confidence(pixel: vec2i) -> f32 {
  let offsets = array<vec2i, 9>(
    vec2i(0, 0), vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
    vec2i(-1, 0), vec2i(1, 0), vec2i(-1, 1), vec2i(0, 1), vec2i(1, 1));
  var samples: array<f32, 9>;
  var luma_min = 3.402823466e+38;
  var luma_max = 1.175494351e-38;
  for (var i = 0; i < 9; i++) {
    let sample = clamp_load(pixel, offsets[i], constants.render_size);
    samples[i] = textureLoad(current_luma, sample, 0).x * exposure();
    luma_min = min(luma_min, samples[i]);
    luma_max = max(luma_max, samples[i]);
  }
  var dissimilar_min = 3.402823466e+38;
  var dissimilar_max = 0.0;
  var pattern = 1u;
  for (var i = 1; i < 9; i++) {
    let difference = abs(samples[i] - samples[0]) / (luma_max - luma_min);
    if (difference < 0.9) {
      pattern |= 1u << u32(i);
    } else {
      dissimilar_min = min(dissimilar_min, samples[i]);
      dissimilar_max = max(dissimilar_max, samples[i]);
    }
  }
  if (!(samples[0] > dissimilar_max || samples[0] < dissimilar_min)) { return 0.0; }
  let masks = array<u32, 4>(
    (1u << 1u) | (1u << 2u) | (1u << 4u) | 1u,
    (1u << 2u) | (1u << 3u) | (1u << 5u) | 1u,
    (1u << 4u) | (1u << 6u) | (1u << 7u) | 1u,
    (1u << 5u) | (1u << 7u) | (1u << 8u) | 1u);
  for (var i = 0; i < 4; i++) {
    if ((pattern & masks[i]) == masks[i]) { return 0.0; }
  }
  return 1.0 - luma_min / luma_max;
}

fn update_accumulation(pixel: vec2i, uv: vec2f, motion: vec2f,
  disocclusion: f32, change: f32) -> f32 {
  let reprojected_uv = uv + motion;
  var accumulation = 0.0;
  if (inside(reprojected_uv)) {
    let sample_uv = clamp_uv(reprojected_uv, constants.previous_render_size,
      textureDimensions(previous_accumulation));
    accumulation = clamp(textureSampleLevel(previous_accumulation, linear_clamp, sample_uv, 0.0).x, 0.0, 1.0);
  }
  accumulation = mix(accumulation, 0.0, change);
  accumulation = mix(accumulation,
    min(constants.min_disocclusion_accumulation, accumulation), disocclusion);
  accumulation *= select(0.0, 1.0, round(accumulation * 100.0) > 1.0);
  let stored = clamp(accumulation + constants.accumulation_added_per_frame, 0.0, 1.0);
  textureStore(current_accumulation, pixel, vec4f(stored, 0.0, 0.0, 0.0));
  return accumulation;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(pixel >= constants.render_size)) { return; }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.render_size);
  let motion = textureLoad(dilated_motion, pixel, 0).xy;
  let depth = textureLoad(dilated_depth, pixel, 0).x;
  let disocclusion = compute_disocclusion(uv, motion, view_depth(depth));
  let shading_uv = clamp_uv(uv - constants.jitter_offset / vec2f(constants.render_size),
    constants.render_size / 2, textureDimensions(shading_change));
  let change = max(dilate_reactive(pixel),
    clamp(textureSampleLevel(shading_change, linear_clamp, shading_uv, 0.0).x *
      constants.shading_change_scale, 0.0, 1.0));
  let divergence = motion_divergence(uv, motion, depth);
  let transparency_uv = clamp_uv(uv, constants.render_size, textureDimensions(transparency_mask));
  let transparency = textureSampleLevel(transparency_mask, linear_clamp, transparency_uv, 0.0).x;
  let reactiveness = max(divergence, transparency);
  let accumulation = update_accumulation(pixel, uv, motion, disocclusion, change);
  textureStore(dilated_reactive, pixel,
    vec4f(reactiveness, disocclusion, change, accumulation));
  let lock_strength = thin_feature_confidence(pixel);
  if (lock_strength > 0.01) {
    let high_pixel = vec2i(floor((vec2f(pixel) + vec2f(0.5) - constants.jitter_offset) /
      vec2f(constants.render_size) * vec2f(constants.upscale_size)));
    if (all(high_pixel >= vec2i(0)) && all(high_pixel < constants.upscale_size)) {
      textureStore(new_locks, high_pixel, vec4f(lock_strength, 0.0, 0.0, 0.0));
    }
  }
}
`;

export interface Fsr3ReactivityOutput {
  readonly masks: ResourceId;
  readonly newLocks: ResourceId;
  readonly accumulation: ResourceId;
}

export class Fsr3PrepareReactivityPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    const module = device.createShaderModule({ label: "FSR3 Prepare Reactivity", code: FSR3_PREPARE_REACTIVITY_WGSL });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      // Dilated depth is R32Float. It is loaded without filtering and must use
      // the unfilterable-float view class on adapters without float filtering.
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ...[3, 4, 5, 6, 7].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" as const } })),
      { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r8unorm" } },
      { binding: 13, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r8unorm" } }
    ] });
    this.pipeline = device.createComputePipeline({ label: "FSR3 Prepare Reactivity",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" } });
  }

  addToGraph(graph: FrameGraph, input: {
    reconstructedDepth: ResourceId; dilatedMotion: ResourceId; dilatedDepth: ResourceId;
    reactiveMask: ResourceId; transparencyMask: ResourceId;
    previousAccumulation: ResourceId; currentAccumulation: ResourceId;
    shadingChange: ResourceId; currentLuma: ResourceId; exposure: ResourceId;
    constants: ResourceId; width: number; height: number; outputWidth: number; outputHeight: number;
  }): Fsr3ReactivityOutput {
    const builder = graph.add("FSR3/Prepare Reactivity", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const locks = resolveTextureView(resources.get(newLocks));
      const clear = command.gpu_encoder.beginRenderPass({ label: "FSR3 Clear New Locks",
        colorAttachments: [{ view: locks, loadOp: "clear", storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      clear.end();
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: { buffer: resources.get(data.reconstructedDepth) as GPUBuffer } },
        { binding: 1, resource: resolveTextureView(resources.get(data.dilatedMotion)) },
        { binding: 2, resource: resolveTextureView(resources.get(data.dilatedDepth)) },
        { binding: 3, resource: resolveTextureView(resources.get(data.reactiveMask)) },
        { binding: 4, resource: resolveTextureView(resources.get(data.transparencyMask)) },
        { binding: 5, resource: resolveTextureView(resources.get(data.previousAccumulation)) },
        { binding: 6, resource: resolveTextureView(resources.get(data.shadingChange)) },
        { binding: 7, resource: resolveTextureView(resources.get(data.currentLuma)) },
        { binding: 8, resource: resolveTextureView(resources.get(data.exposure)) },
        { binding: 9, resource: this.sampler },
        { binding: 10, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
        { binding: 11, resource: resolveTextureView(resources.get(masks)) },
        { binding: 12, resource: locks },
        { binding: 13, resource: resolveTextureView(resources.get(data.currentAccumulation)) }
      ] });
      const pass = command.beginComputePass({ label: "FSR3 Prepare Reactivity" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    const masks = builder.create("FSR3/dilated reactive masks", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba8unorm", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const newLocks = builder.create("FSR3/new locks", {
      kind: "transient_texture", width: input.outputWidth, height: input.outputHeight,
      format: "r8unorm", domain: "output-full",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    for (const resource of [input.reconstructedDepth, input.dilatedMotion, input.dilatedDepth,
      input.reactiveMask, input.transparencyMask, input.previousAccumulation,
      input.shadingChange, input.currentLuma, input.exposure, input.constants]) builder.read(resource);
    const accumulation = builder.write(input.currentAccumulation);
    return { masks, newLocks, accumulation };
  }
}
