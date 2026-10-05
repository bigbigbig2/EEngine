import type { FrameGraph } from "../../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../../RenderTargetViews.js";
import { FSR3_UPSCALER_CONSTANTS_WGSL } from "./Fsr3UpscalerConstants.js";

// Translation of pinned ffx_fsr3upscaler_shading_change.h, including its
// three explicit pyramid samples and the SDK's jittered ClampUv mapping.
export const FSR3_SHADING_CHANGE_WGSL = /* wgsl */ `
${FSR3_UPSCALER_CONSTANTS_WGSL}
@group(0) @binding(0) var spd_mip0: texture_2d<f32>;
@group(0) @binding(1) var spd_mip1: texture_2d<f32>;
@group(0) @binding(2) var spd_mip2: texture_2d<f32>;
@group(0) @binding(3) var linear_clamp: sampler;
@group(0) @binding(4) var<uniform> constants: Fsr3Constants;
@group(0) @binding(5) var shading_change: texture_storage_2d<r8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let shading_size = constants.render_size / 2;
  let pixel = vec2i(id.xy);
  if (any(pixel >= shading_size)) { return; }
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(shading_size);
  let jittered_uv = uv + constants.jitter_offset / vec2f(constants.render_size);
  let spd_size = vec2f(textureDimensions(spd_mip0));
  let sample_location = jittered_uv * vec2f(shading_size);
  let mip_uv = clamp(sample_location, vec2f(0.5), vec2f(shading_size) - vec2f(0.5)) / spd_size;
  let samples = array<vec2f, 3>(
    textureSampleLevel(spd_mip0, linear_clamp, mip_uv, 0.0).xy,
    textureSampleLevel(spd_mip1, linear_clamp, mip_uv, 0.0).xy,
    textureSampleLevel(spd_mip2, linear_clamp, mip_uv, 0.0).xy);
  var change = 0.0;
  for (var mip = 0; mip < 3; mip++) {
    let value = abs(samples[mip].x * samples[mip].y);
    if (value > 0.0) { change = max(change, value); }
  }
  textureStore(shading_change, pixel, vec4f(clamp(change, 0.0, 1.0), 0.0, 0.0, 0.0));
}
`;

export class Fsr3ShadingChangePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice) {
    this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
    const module = device.createShaderModule({
      label: "FSR3 Shading Change",
      code: FSR3_SHADING_CHANGE_WGSL,
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r8unorm" },
        },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "FSR3 Shading Change",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" },
    });
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      spdMips: readonly ResourceId[];
      constants: ResourceId;
      width: number;
      height: number;
    },
  ): ResourceId {
    if (input.spdMips.length < 3) throw new RangeError("FSR3 Shading Change requires three SPD mips");
    const width = Math.floor(input.width / 2);
    const height = Math.floor(input.height / 2);
    const builder = graph.add("FSR3/Shading Change", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.spdMips[0]!)) },
          { binding: 1, resource: resolveTextureView(resources.get(data.spdMips[1]!)) },
          { binding: 2, resource: resolveTextureView(resources.get(data.spdMips[2]!)) },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: { buffer: resources.get(data.constants) as GPUBuffer } },
          { binding: 5, resource: resolveTextureView(resources.get(output)) },
        ],
      });
      const pass = command.beginComputePass({ label: "FSR3 Shading Change" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    const output = builder.create("FSR3/shading change", {
      kind: "transient_texture",
      width,
      height,
      format: "r8unorm",
      domain: "internal-half",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (const mip of input.spdMips.slice(0, 3)) builder.read(mip);
    builder.read(input.constants);
    return output;
  }
}
