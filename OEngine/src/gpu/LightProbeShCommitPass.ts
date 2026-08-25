/**
 * LightProbeShCommitPass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  PROBE_SH_COMMIT_SETTINGS_BYTES,
  PROBE_SH_COMMIT_WGSL,
  PROBE_SH_COMMIT_WORKGROUP_SIZE
} from "../shaders/probe_sh_commit.js";

export type LightProbeShCommitSettings = {
  probe_index_offset: number;
  probe_update_count: number;
  probe_resolution: number;
  probe_count: number;
};

export class LightProbeShCommitPass {
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/jF-group0-layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" }
        }
      ]
    };
    this.pipeline = {
      label: "LightProbeAtlas/jF",
      layout: {
        label: "LightProbeAtlas/jF-pipeline-layout",
        bindGroupLayouts: [layout]
      },
      compute: { module: { label: "LightProbeAtlas/jF-module", code: PROBE_SH_COMMIT_WGSL }, entryPoint: "main" }
    };
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeShCommitSettings,
    coefficients: GPUBuffer,
    probes: GPUBuffer
  ): void {
    if (settings.probe_update_count <= 0) return;
    const settingsBuffer = this.createSettingsBuffer(settings);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const pass = command.constructComputePass({
      label: "LightProbeAtlas/jF",
      pipeline: this.pipeline,
      bindings: [[
        { buffer: settingsBuffer },
        { buffer: coefficients },
        { buffer: probes }
      ]]
    });
    pass.dispatchWorkgroups(
      Math.ceil(settings.probe_update_count / PROBE_SH_COMMIT_WORKGROUP_SIZE),
      1,
      1
    );
    pass.end();
  }

  private createSettingsBuffer(settings: LightProbeShCommitSettings): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_index_offset,
      settings.probe_update_count,
      settings.probe_resolution,
      settings.probe_count
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/jF-settings",
      size: PROBE_SH_COMMIT_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(values);
    buffer.unmap();
    return buffer;
  }
}
