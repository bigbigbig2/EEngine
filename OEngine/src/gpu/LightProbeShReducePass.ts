/**
 * LightProbeShReducePass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  PROBE_SH_REDUCE_SETTINGS_BYTES,
  PROBE_SH_REDUCE_WGSL,
  PROBE_SH_REDUCE_WORKGROUP_SIZE
} from "../shaders/probe_sh_reduce.js";

export type LightProbeShReduceSettings = {
  probe_index_offset: number;
  probe_update_count: number;
  probe_resolution: number;
  probe_count: number;
  probes_per_row: number;
};

export class LightProbeShReducePass {
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const layouts: GPUBindGroupLayoutDescriptor[] = [
      {
        label: "LightProbeAtlas/KF-group0-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" }
          }
        ]
      },
      {
        label: "LightProbeAtlas/KF-group1-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" }
          }
        ]
      }
    ];
    this.pipeline = {
      label: "LightProbeAtlas/KF",
      layout: {
        label: "LightProbeAtlas/KF-pipeline-layout",
        bindGroupLayouts: layouts
      },
      compute: { module: { label: "LightProbeAtlas/KF-module", code: PROBE_SH_REDUCE_WGSL }, entryPoint: "main" }
    };
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeShReduceSettings,
    coefficients: GPUBuffer,
    outputWidth: number,
    outputHeight: number
  ): void {
    if (settings.probe_update_count <= 0) return;
    if (!isPowerOfTwo(settings.probe_resolution)) {
      throw new Error(
        "probe resolution must be a power of two. Currently non PoT resolution is unsupported"
      );
    }

    const mipCount = Math.floor(Math.log2(settings.probe_resolution));
    for (let mipLevel = 1; mipLevel <= mipCount; mipLevel++) {
      this.encodeLevel(
        command,
        settings,
        mipLevel,
        coefficients,
        Math.max(
          1,
          Math.ceil((outputWidth >> mipLevel) / PROBE_SH_REDUCE_WORKGROUP_SIZE)
        ),
        Math.max(
          1,
          Math.ceil((outputHeight >> mipLevel) / PROBE_SH_REDUCE_WORKGROUP_SIZE)
        )
      );
    }
  }

  private encodeLevel(
    command: ShadeGPUCommandContext,
    settings: LightProbeShReduceSettings,
    mipLevel: number,
    coefficients: GPUBuffer,
    groupCountX: number,
    groupCountY: number
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings, mipLevel);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const pass = command.constructComputePass({
      label: `LightProbeAtlas/KF-mip${mipLevel}`,
      pipeline: this.pipeline,
      bindings: [[{ buffer: settingsBuffer }], [{ buffer: coefficients }]]
    });
    pass.dispatchWorkgroups(groupCountX, groupCountY, 1);
    pass.end();
  }

  private createSettingsBuffer(
    settings: LightProbeShReduceSettings,
    mipLevel: number
  ): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_index_offset,
      settings.probe_update_count,
      settings.probe_resolution,
      mipLevel,
      settings.probes_per_row,
      settings.probe_count
    ]);
    const buffer = this.device.createBuffer({
      label: `LightProbeAtlas/KF-mip${mipLevel}-settings`,
      size: PROBE_SH_REDUCE_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(values);
    buffer.unmap();
    return buffer;
  }
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}
