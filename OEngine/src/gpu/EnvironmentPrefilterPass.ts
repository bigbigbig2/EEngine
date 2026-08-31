import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { ENVIRONMENT_DIFFUSE_SAMPLE_COUNT, ENVIRONMENT_PREFILTER_WGSL, ENVIRONMENT_PREFILTER_WORKGROUP_SIZE, ENVIRONMENT_SPECULAR_SAMPLE_COUNT } from "../shaders/environment_prefilter.js";
import type { GPUTextureContext } from "./GPUTextureContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";

const GROUP: GPUBindGroupLayoutDescriptor = {
  label: "GPULightCollection/FX-03 environment filter group0",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d" } }
  ]
};

function pipeline(entryPoint: "prefilter_specular" | "convolve_diffuse"): CachedComputePipelineDescriptor {
  return {
    label: `GPULightCollection/FX-03 ${entryPoint}`,
    layout: { label: `GPULightCollection/FX-03 ${entryPoint} layout`, bindGroupLayouts: [GROUP] },
    compute: { module: { label: "GPULightCollection/FX-03 environment filter", code: ENVIRONMENT_PREFILTER_WGSL }, entryPoint }
  };
}

/** One-shot owner: encoded only when SceneLights.environment identity changes. */
export class EnvironmentPrefilterPass {
  private readonly device: GPUDevice;
  private readonly specularPipeline = pipeline("prefilter_specular");
  private readonly diffusePipeline = pipeline("convolve_diffuse");

  constructor(graphics: GraphicsContext) { this.device = graphics.device; }

  encode(command: ShadeGPUCommandContext, specular: GPUTextureContext, diffuse: GPUTextureContext): void {
    const mipCount = specular.mipLevelCount;
    for (let mip = 1; mip < mipCount; mip++) {
      this.encodeDispatch(command, this.specularPipeline, specular, specular, mip,
        mip / Math.max(mipCount - 1, 1), ENVIRONMENT_SPECULAR_SAMPLE_COUNT);
    }
    this.encodeDispatch(command, this.diffusePipeline, specular, diffuse, 0, 1,
      ENVIRONMENT_DIFFUSE_SAMPLE_COUNT);
  }

  private encodeDispatch(command: ShadeGPUCommandContext, descriptor: CachedComputePipelineDescriptor,
    source: GPUTextureContext, destination: GPUTextureContext, mip: number,
    roughness: number, sampleCount: number): void {
    const uniform = this.device.createBuffer({ label: `GPULightCollection/FX-03 filter parameters mip ${mip}`,
      size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const values = new DataView(uniform.getMappedRange());
    values.setFloat32(0, roughness, true);
    values.setUint32(4, sampleCount, true);
    values.setUint32(8, source.width, true);
    values.setUint32(12, 0, true);
    uniform.unmap();
    command.onFinished.addOne(() => uniform.destroy());
    const pass = command.constructComputePass({
      label: `GPULightCollection/FX-03 filter mip ${mip}`,
      pipeline: descriptor,
      bindings: [[{ buffer: uniform }, source.obtainView({ baseMipLevel: 0, mipLevelCount: 1 }),
        destination.obtainView({ baseMipLevel: mip, mipLevelCount: 1 })]]
    });
    pass.dispatchWorkgroups(
      Math.ceil(Math.max(1, destination.width >> mip) / ENVIRONMENT_PREFILTER_WORKGROUP_SIZE),
      Math.ceil(Math.max(1, destination.height >> mip) / ENVIRONMENT_PREFILTER_WORKGROUP_SIZE), 1);
    pass.end();
  }
}
