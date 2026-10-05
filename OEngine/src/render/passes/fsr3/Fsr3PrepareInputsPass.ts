import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// FidelityFX SDK 1.1.4, c6efa6bf7f2027b3ec94f28578bb5965eabb9e55:
// ffx_fsr3upscaler_prepare_inputs.h and ffx_fsr3upscaler_common.h.
// Selected SDK permutation: inverted depth, low-resolution motion vectors,
// jittered motion vectors, full f32 arithmetic. The reconstructed-depth image
// atomic is lowered to an atomic<u32> buffer.
// Reverse depth uses atomicMax and a zero clear, exactly as the pinned GLSL callback.
export const FSR3_PREPARE_INPUTS_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var input_depth: texture_depth_2d;
@group(0) @binding(2) var input_motion: texture_2d<f32>;
@group(0) @binding(3) var<uniform> constants: Fsr3Constants;
@group(0) @binding(4) var dilated_motion: texture_storage_2d<rg16float, write>;
@group(0) @binding(5) var dilated_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var farthest_depth: texture_storage_2d<r16float, write>;
@group(0) @binding(7) var current_luma: texture_storage_2d<r16float, write>;
@group(0) @binding(8) var<storage, read_write> reconstructed_depth: array<atomic<u32>>;
@group(0) @binding(9) var input_validity: texture_2d<f32>;

fn on_screen(p: vec2i) -> bool {
  return all(p >= vec2i(0)) && all(p < constants.render_size);
}

fn view_depth_meters(depth: f32) -> f32 {
  return constants.device_to_view_depth.y /
    (depth - constants.device_to_view_depth.x) * constants.view_space_to_meters_factor;
}

struct DepthExtents {
  nearest: f32,
  nearest_coord: vec2i,
  farthest: f32,
};

fn find_depth_extents(pixel: vec2i) -> DepthExtents {
  // Preserve the source's sample order and farthest update inside the
  // nearest-depth branch. The selected SDK permutation is inverted depth.
  let offsets = array<vec2i, 9>(
    vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(0, -1),
    vec2i(-1, 0), vec2i(-1, 1), vec2i(1, 1),
    vec2i(-1, -1), vec2i(1, -1));
  var extents: DepthExtents;
  extents.nearest = textureLoad(input_depth, pixel, 0);
  extents.farthest = extents.nearest;
  extents.nearest_coord = pixel;
  for (var i = 1; i < 9; i++) {
    let sample_pos = pixel + offsets[i];
    if (on_screen(sample_pos)) {
      let sample_depth = textureLoad(input_depth, sample_pos, 0);
      if (sample_depth > extents.nearest) {
        extents.farthest = min(extents.farthest, sample_depth);
        extents.nearest = sample_depth;
        extents.nearest_coord = sample_pos;
      }
    }
  }
  return extents;
}

fn reconstruct_previous_depth(pixel: vec2i, depth: f32, motion: vec2f) {
  let nearest_meters = min(view_depth_meters(depth), 65504.0);
  let threshold = mix(0.25, 0.75, clamp(nearest_meters / 100.0, 0.0, 1.0));
  var reprojection_motion = motion;
  if (length(motion * vec2f(3840.0, 2160.0)) <= threshold) {
    reprojection_motion = vec2f(0.0);
  }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(constants.render_size);
  let sample = ((uv + reprojection_motion) * vec2f(constants.render_size)) - vec2f(0.5);
  let base = vec2i(floor(sample));
  let fraction = fract(sample);
  let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  let weights = array<f32, 4>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  for (var i = 0; i < 4; i++) {
    let store_pos = base + offsets[i];
    if (weights[i] > 0.0006100000 && on_screen(store_pos)) {
      let index = u32(store_pos.y * constants.render_size.x + store_pos.x);
      atomicMax(&reconstructed_depth[index], bitcast<u32>(depth));
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (!on_screen(pixel)) { return; }
  let extents = find_depth_extents(pixel);
  let motion_valid = textureLoad(input_validity, extents.nearest_coord, 0).y > 0.5;
  var motion = textureLoad(input_motion, extents.nearest_coord, 0).xy *
    constants.motion_vector_scale - constants.motion_vector_jitter_cancellation;
  if (!motion_valid) { motion = vec2f(0.0); }
  if (motion_valid) { reconstruct_previous_depth(pixel, extents.nearest, motion); }
  textureStore(dilated_motion, pixel, vec4f(motion, 0.0, 0.0));
  textureStore(dilated_depth, pixel, vec4f(extents.nearest, 0.0, 0.0, 0.0));
  textureStore(farthest_depth, pixel,
    vec4f(min(view_depth_meters(extents.farthest), 65504.0), 0.0, 0.0, 0.0));
  let rgb = max(vec3f(0.0), textureLoad(input_color, pixel, 0).rgb);
  textureStore(current_luma, pixel,
    vec4f(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 0.0));
}
`;

export interface Fsr3PreparedInputs {
  readonly dilatedMotion: ResourceId;
  readonly dilatedDepth: ResourceId;
  readonly farthestDepth: ResourceId;
  readonly currentLuma: ResourceId;
  readonly reconstructedDepth: ResourceId;
}

/** First SDK dispatch; the later FSR3 stages consume these GPU products. */
export class Fsr3PrepareInputsPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({
      label: "FSR3 Prepare Inputs",
      code: FSR3_PREPARE_INPUTS_WGSL,
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rg16float" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r32float" },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r16float" },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r16float" },
        },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "FSR3 Prepare Inputs",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" },
    });
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      color: ResourceId;
      depth: ResourceId;
      motion: ResourceId;
      validityMask: ResourceId;
      constants: ResourceId;
      currentLuma?: ResourceId;
      width: number;
      height: number;
    },
  ): Fsr3PreparedInputs {
    const depthBytes = input.width * input.height * Uint32Array.BYTES_PER_ELEMENT;
    if (
      !Number.isSafeInteger(depthBytes) ||
      depthBytes <= 0 ||
      depthBytes > this.device.limits.maxStorageBufferBindingSize ||
      depthBytes > this.device.limits.maxBufferSize
    ) {
      throw new RangeError("FSR3 reconstructed depth exceeds the negotiated WebGPU storage buffer limit");
    }
    const builder = graph.add("FSR3/Prepare Inputs", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const reconstructed = resources.get(output.reconstructedDepth) as GPUBuffer;
      command.gpu_encoder.clearBuffer(reconstructed);
      const bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.color)) },
          { binding: 1, resource: resolveTextureView(resources.get(data.depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(data.motion)) },
          { binding: 3, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 4, resource: resolveTextureView(resources.get(output.dilatedMotion)) },
          { binding: 5, resource: resolveTextureView(resources.get(output.dilatedDepth)) },
          { binding: 6, resource: resolveTextureView(resources.get(output.farthestDepth)) },
          { binding: 7, resource: resolveTextureView(resources.get(output.currentLuma)) },
          { binding: 8, resource: { buffer: reconstructed } },
          { binding: 9, resource: resolveTextureView(resources.get(data.validityMask)) },
        ],
      });
      const pass = command.beginComputePass({ label: "FSR3 Prepare Inputs" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    const texture = (label: string, format: GPUTextureFormat) =>
      builder.create(label, {
        kind: "transient_texture",
        width: input.width,
        height: input.height,
        format,
        domain: "internal-full",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    const output: Fsr3PreparedInputs = {
      dilatedMotion: texture("FSR3/dilated motion", "rg16float"),
      dilatedDepth: texture("FSR3/dilated depth", "r32float"),
      farthestDepth: texture("FSR3/farthest depth", "r16float"),
      currentLuma:
        input.currentLuma === undefined
          ? texture("FSR3/current luma", "r16float")
          : builder.write(input.currentLuma),
      reconstructedDepth: builder.create("FSR3/reconstructed previous depth", {
        kind: "transient_buffer",
        size: depthBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    };
    builder.read(input.color);
    builder.read(input.depth);
    builder.read(input.motion);
    builder.read(input.validityMask);
    builder.read(input.constants);
    return output;
  }
}
