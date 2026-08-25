/**
 * EnvironmentPrefilterPass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  ENVIRONMENT_PREFILTER_WGSL,
  ENVIRONMENT_PREFILTER_WORKGROUP_SIZE
} from "../shaders/environment_prefilter.js";
import type { GPUTextureContext } from "./GPUTextureContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";

export class EnvironmentPrefilterPass {
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "GPULightCollection/Vj-group0-layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d" }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba16float",
            viewDimension: "2d"
          }
        }
      ]
    };
    this.pipeline = {
      label: "GPULightCollection/Vj",
      layout: {
        label: "GPULightCollection/Vj-pipeline-layout",
        bindGroupLayouts: [layout]
      },
      compute: {
        module: {
          label: "GPULightCollection/Vj-module",
          code: ENVIRONMENT_PREFILTER_WGSL
        },
        entryPoint: "main"
      }
    };
  }

  encode(command: ShadeGPUCommandContext, environment: GPUTextureContext): void {
    const mipLevelCount = environment.descriptor.mipLevelCount ?? 1;
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
      const readLod = this.device.createBuffer({
        label: `GPULightCollection/Vj-mip${mipLevel}-read-lod`,
        size: 4,
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true
      });
      new Uint32Array(readLod.getMappedRange())[0] = mipLevel - 1;
      readLod.unmap();
      command.onFinished.addOne(() => readLod.destroy());

      const pass = command.constructComputePass({
        label: `GPULightCollection/Vj-mip${mipLevel}`,
        pipeline: this.pipeline,
        bindings: [[
          { buffer: readLod },
          environment.obtainView({
            baseMipLevel: mipLevel - 1,
            mipLevelCount: 1
          }),
          environment.obtainView({
            baseMipLevel: mipLevel,
            mipLevelCount: 1
          })
        ]]
      });
      pass.dispatchWorkgroups(
        Math.max(
          1,
          Math.ceil(
            (environment.width >> mipLevel) /
              ENVIRONMENT_PREFILTER_WORKGROUP_SIZE
          )
        ),
        Math.max(
          1,
          Math.ceil(
            (environment.height >> mipLevel) /
              ENVIRONMENT_PREFILTER_WORKGROUP_SIZE
          )
        ),
        1
      );
      pass.end();
    }
  }
}
