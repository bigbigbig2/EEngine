import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";

// SDK 1.1.4 ffx_fsr3upscaler_rcas.h + fsr1/ffx_fsr1.h FsrRcasF.
// The selected f32, denoised permutation preserves the five-tap ring,
// bit-level medium reciprocal, limiter, exposure and host sharpness mapping.
export const FSR3_RCAS_WGSL = /* wgsl */ `
struct RcasConstants { strength: f32, }
@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var input_exposure: texture_2d<f32>;
@group(0) @binding(2) var<uniform> constants: RcasConstants;
@group(0) @binding(3) var output_color: texture_storage_2d<rgba16float, write>;

fn approximate_reciprocal_medium(value: f32) -> f32 {
  let estimate = bitcast<f32>(0x7ef19fffu - bitcast<u32>(value));
  return estimate * (-estimate * value + 2.0);
}

fn exposure() -> f32 {
  let value = textureLoad(input_exposure, vec2i(0), 0).x;
  if (value == 0.0) { return 1.0; }
  return value;
}

fn load_color(pixel: vec2i, scale: f32) -> vec3f {
  return textureLoad(input_color, pixel, 0).rgb * scale;
}

fn luma2(rgb: vec3f) -> f32 {
  return rgb.b * 0.5 + (rgb.r * 0.5 + rgb.g);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2i(id.xy);
  if (any(id.xy >= textureDimensions(output_color))) { return; }
  let scale = exposure();
  let b = load_color(pixel + vec2i(0, -1), scale);
  let d = load_color(pixel + vec2i(-1, 0), scale);
  let e = load_color(pixel, scale);
  let f = load_color(pixel + vec2i(1, 0), scale);
  let h = load_color(pixel + vec2i(0, 1), scale);
  let bl = luma2(b);
  let dl = luma2(d);
  let el = luma2(e);
  let fl = luma2(f);
  let hl = luma2(h);
  var noise = 0.25 * bl + 0.25 * dl + 0.25 * fl + 0.25 * hl - el;
  let luma_max = max(max(max(bl, dl), max(el, fl)), hl);
  let luma_min = min(min(min(bl, dl), min(el, fl)), hl);
  noise = clamp(abs(noise) * approximate_reciprocal_medium(luma_max - luma_min), 0.0, 1.0);
  noise = -0.5 * noise + 1.0;
  let ring_min = min(min(min(b, d), f), h);
  let ring_max = max(max(max(b, d), f), h);
  let hit_min = ring_min / (4.0 * ring_max);
  let hit_max = (vec3f(1.0) - ring_max) / (4.0 * ring_min - vec3f(4.0));
  let ring_lobe = max(-hit_min, hit_max);
  var lobe = max(-0.1875, min(max(max(ring_lobe.r, ring_lobe.g), ring_lobe.b), 0.0)) * constants.strength;
  lobe *= noise;
  let reciprocal = approximate_reciprocal_medium(4.0 * lobe + 1.0);
  let result = (lobe * b + lobe * d + lobe * h + lobe * f + e) * reciprocal / scale;
  textureStore(output_color, pixel, vec4f(result, 1.0));
}
`;

/** FsrRcasCon(sharpnessRemapped = -2 * sharpness + 2). */
export function packFsr3RcasConstants(sharpness: number): ArrayBuffer {
  if (!Number.isFinite(sharpness) || sharpness < 0 || sharpness > 1) {
    throw new RangeError("FSR3 RCAS sharpness must be within [0, 1]");
  }
  return new Float32Array([Math.pow(2, -(2 - 2 * sharpness)), 0, 0, 0]).buffer;
}

export class Fsr3RcasPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: "FSR3 RCAS", code: FSR3_RCAS_WGSL });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }
    ] });
    this.pipeline = device.createComputePipeline({
      label: "FSR3 RCAS", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" }
    });
  }

  addToGraph(graph: FrameGraph, input: {
    color: ResourceId; exposure: ResourceId; constants: ResourceId;
    width: number; height: number;
  }): ResourceId {
    const builder = graph.add("FSR3/RCAS", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: resolveTextureView(resources.get(data.color)) },
        { binding: 1, resource: resolveTextureView(resources.get(data.exposure)) },
        { binding: 2, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
        { binding: 3, resource: resolveTextureView(resources.get(output)) }
      ] });
      const pass = command.beginComputePass({ label: "FSR3 RCAS" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    const output = builder.create("FSR3/sharpened output", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", domain: "output-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    builder.read(input.color);
    builder.read(input.exposure);
    builder.read(input.constants);
    return output;
  }
}
